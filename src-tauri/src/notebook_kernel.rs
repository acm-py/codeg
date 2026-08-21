use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use thiserror::Error;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin},
    sync::{oneshot, Mutex, RwLock},
};

use crate::web::event_bridge::{emit_event, EventEmitter};

pub const NOTEBOOK_KERNEL_EVENT: &str = "notebook-kernel://event";
const IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const SWEEP_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Debug, Error)]
pub enum NotebookKernelError {
    #[error("invalid notebook kernel request: {0}")]
    Invalid(String),
    #[error("notebook kernel session is not running")]
    NotFound,
    #[error("notebook kernel is unavailable: {0}")]
    Unavailable(String),
    #[error("notebook kernel request failed: {0}")]
    Request(String),
    #[error("notebook kernel bridge failed: {0}")]
    Bridge(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookKernelSpec {
    pub name: String,
    pub display_name: String,
    pub language: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookKernelSession {
    pub session_id: String,
    pub notebook_path: String,
    pub kernel_name: String,
    pub state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookKernelStartRequest {
    pub session_id: String,
    pub notebook_path: String,
    pub cwd: String,
    pub kernel_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookCodeCell {
    pub index: usize,
    pub code: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookKernelExecuteRequest {
    pub session_id: String,
    pub cell_index: usize,
    pub code: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookKernelRunAllRequest {
    pub session_id: String,
    pub cells: Vec<NotebookCodeCell>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookKernelInputRequest {
    pub session_id: String,
    pub value: String,
}

struct ManagerInner {
    sessions: RwLock<HashMap<String, Arc<Session>>>,
    emitter: EventEmitter,
    data_dir: PathBuf,
    bridge_path: PathBuf,
    sweeper_started: AtomicBool,
}

#[derive(Clone)]
pub struct NotebookKernelManager {
    inner: Arc<ManagerInner>,
}

struct Session {
    id: String,
    inner: Arc<ManagerInner>,
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
    request_lock: Mutex<()>,
    next_request_id: AtomicU64,
    last_activity: Mutex<tokio::time::Instant>,
    info: Mutex<Option<NotebookKernelSession>>,
    busy: AtomicBool,
    alive: AtomicBool,
}

impl NotebookKernelManager {
    pub fn new(emitter: EventEmitter, data_dir: PathBuf) -> Self {
        let bridge_path =
            data_dir.join(format!(".codeg-notebook-bridge-{}.py", std::process::id()));
        Self {
            inner: Arc::new(ManagerInner {
                sessions: RwLock::new(HashMap::new()),
                emitter,
                data_dir,
                bridge_path,
                sweeper_started: AtomicBool::new(false),
            }),
        }
    }

    pub async fn list_specs(&self) -> Result<Vec<NotebookKernelSpec>, NotebookKernelError> {
        self.ensure_sweeper();
        self.ensure_bridge_file().await?;
        let session = Session::spawn(self.inner.clone(), "__notebook_specs".to_string()).await?;
        let result = session.request("listSpecs", json!({})).await;
        session.kill().await;
        let value = result?;
        serde_json::from_value(value).map_err(|error| {
            NotebookKernelError::Bridge(format!("invalid kernelspec response: {error}"))
        })
    }

    pub async fn start(
        &self,
        request: NotebookKernelStartRequest,
    ) -> Result<NotebookKernelSession, NotebookKernelError> {
        self.ensure_sweeper();
        validate_session_id(&request.session_id)?;
        validate_path(&request.notebook_path, "notebookPath")?;
        validate_path(&request.cwd, "cwd")?;
        let kernel_name = request
            .kernel_name
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "python3".to_string());
        if kernel_name.len() > 256 {
            return Err(NotebookKernelError::Invalid(
                "kernelName is too long".to_string(),
            ));
        }

        self.ensure_bridge_file().await?;
        if let Some(existing) = self.session_if_alive(&request.session_id).await {
            if let Some(session) = existing.info.lock().await.clone() {
                return Ok(session);
            }
        }
        let previous = {
            self.inner
                .sessions
                .write()
                .await
                .remove(&request.session_id)
        };
        if let Some(previous) = previous {
            previous.shutdown().await;
        }

        let session = Session::spawn(self.inner.clone(), request.session_id.clone()).await?;
        self.inner
            .sessions
            .write()
            .await
            .insert(request.session_id.clone(), session.clone());

        let result = session
            .request(
                "start",
                json!({
                    "sessionId": request.session_id,
                    "notebookPath": request.notebook_path,
                    "cwd": request.cwd,
                    "kernelName": kernel_name,
                }),
            )
            .await;
        match result {
            Ok(value) => {
                let info = serde_json::from_value(value).map_err(|error| {
                    NotebookKernelError::Bridge(format!("invalid kernel session response: {error}"))
                })?;
                *session.info.lock().await = Some(info.clone());
                Ok(info)
            }
            Err(error) => {
                self.remove_if_same(&request.session_id, &session).await;
                session.kill().await;
                Err(error)
            }
        }
    }

    pub async fn execute(
        &self,
        request: NotebookKernelExecuteRequest,
    ) -> Result<(), NotebookKernelError> {
        validate_session_id(&request.session_id)?;
        let session = self.session(&request.session_id).await?;
        session
            .request(
                "execute",
                json!({ "cellIndex": request.cell_index, "code": request.code }),
            )
            .await
            .map(|_| ())
    }

    pub async fn run_all(
        &self,
        request: NotebookKernelRunAllRequest,
    ) -> Result<(), NotebookKernelError> {
        validate_session_id(&request.session_id)?;
        let session = self.session(&request.session_id).await?;
        session
            .request("runAll", json!({ "cells": request.cells }))
            .await
            .map(|_| ())
    }

    pub async fn interrupt(&self, session_id: &str) -> Result<(), NotebookKernelError> {
        self.control(session_id, "interrupt").await
    }

    pub async fn restart(&self, session_id: &str) -> Result<(), NotebookKernelError> {
        self.control(session_id, "restart").await
    }

    pub async fn input(
        &self,
        request: NotebookKernelInputRequest,
    ) -> Result<(), NotebookKernelError> {
        validate_session_id(&request.session_id)?;
        self.session(&request.session_id)
            .await?
            .request("input", json!({ "value": request.value }))
            .await
            .map(|_| ())
    }

    pub async fn shutdown(&self, session_id: &str) -> Result<(), NotebookKernelError> {
        validate_session_id(session_id)?;
        let session = self
            .inner
            .sessions
            .write()
            .await
            .remove(session_id)
            .ok_or(NotebookKernelError::NotFound)?;
        session.shutdown().await;
        Ok(())
    }

    async fn control(&self, session_id: &str, method: &str) -> Result<(), NotebookKernelError> {
        validate_session_id(session_id)?;
        self.session(session_id)
            .await?
            .request(method, json!({}))
            .await
            .map(|_| ())
    }

    async fn session(&self, session_id: &str) -> Result<Arc<Session>, NotebookKernelError> {
        self.inner
            .sessions
            .read()
            .await
            .get(session_id)
            .cloned()
            .ok_or(NotebookKernelError::NotFound)
    }

    async fn session_if_alive(&self, session_id: &str) -> Option<Arc<Session>> {
        let session = self.inner.sessions.read().await.get(session_id).cloned()?;
        session.alive.load(Ordering::Acquire).then_some(session)
    }

    async fn remove_if_same(&self, session_id: &str, expected: &Arc<Session>) {
        let mut sessions = self.inner.sessions.write().await;
        if sessions
            .get(session_id)
            .is_some_and(|current| Arc::ptr_eq(current, expected))
        {
            sessions.remove(session_id);
        }
    }

    async fn ensure_bridge_file(&self) -> Result<(), NotebookKernelError> {
        tokio::fs::create_dir_all(&self.inner.data_dir)
            .await
            .map_err(|error| {
                NotebookKernelError::Unavailable(format!("cannot create data directory: {error}"))
            })?;
        if tokio::fs::try_exists(&self.inner.bridge_path)
            .await
            .unwrap_or(false)
        {
            return Ok(());
        }
        tokio::fs::write(
            &self.inner.bridge_path,
            include_str!("../python/notebook_bridge.py"),
        )
        .await
        .map_err(|error| {
            NotebookKernelError::Unavailable(format!("cannot prepare Jupyter bridge: {error}"))
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = tokio::fs::metadata(&self.inner.bridge_path)
                .await
                .map_err(|error| NotebookKernelError::Unavailable(error.to_string()))?
                .permissions();
            permissions.set_mode(0o600);
            tokio::fs::set_permissions(&self.inner.bridge_path, permissions)
                .await
                .map_err(|error| NotebookKernelError::Unavailable(error.to_string()))?;
        }
        Ok(())
    }

    fn ensure_sweeper(&self) {
        if self
            .inner
            .sweeper_started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let inner = self.inner.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(SWEEP_INTERVAL);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                let stale = {
                    let now = tokio::time::Instant::now();
                    let mut sessions = inner.sessions.write().await;
                    let ids: Vec<String> = sessions
                        .iter()
                        .filter_map(|(id, session)| {
                            let last = *session.last_activity.try_lock().ok()?;
                            (!session.busy.load(Ordering::Acquire)
                                && now.duration_since(last) >= IDLE_TIMEOUT)
                                .then(|| id.clone())
                        })
                        .collect();
                    ids.into_iter()
                        .filter_map(|id| sessions.remove(&id))
                        .collect::<Vec<_>>()
                };
                for session in stale {
                    session.shutdown().await;
                }
            }
        });
    }
}

impl Session {
    async fn spawn(inner: Arc<ManagerInner>, id: String) -> Result<Arc<Self>, NotebookKernelError> {
        let python = find_python().ok_or_else(|| {
            NotebookKernelError::Unavailable(
                "Python 3 was not found. Install Python with jupyter_client and ipykernel."
                    .to_string(),
            )
        })?;
        let mut command = tokio::process::Command::new(python);
        command
            .arg(&inner.bridge_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(|error| {
            NotebookKernelError::Unavailable(format!("cannot start Jupyter bridge: {error}"))
        })?;
        let stdin = child.stdin.take().ok_or_else(|| {
            NotebookKernelError::Unavailable("Jupyter bridge stdin unavailable".to_string())
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            NotebookKernelError::Unavailable("Jupyter bridge stdout unavailable".to_string())
        })?;
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::debug!(target: "notebook_kernel", "bridge: {}", line);
                }
            });
        }

        let session = Arc::new(Self {
            id: id.clone(),
            inner: inner.clone(),
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            pending: Mutex::new(HashMap::new()),
            request_lock: Mutex::new(()),
            next_request_id: AtomicU64::new(1),
            last_activity: Mutex::new(tokio::time::Instant::now()),
            info: Mutex::new(None),
            busy: AtomicBool::new(false),
            alive: AtomicBool::new(true),
        });
        let reader_clone = session.clone();
        tokio::spawn(async move {
            reader_clone.read_stdout(stdout).await;
        });
        Ok(session)
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, NotebookKernelError> {
        if !self.alive.load(Ordering::Acquire) {
            return Err(NotebookKernelError::NotFound);
        }
        let _operation = self.request_lock.lock().await;
        self.touch().await;
        let request_id = self
            .next_request_id
            .fetch_add(1, Ordering::Relaxed)
            .to_string();
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(request_id.clone(), sender);
        let line = serde_json::to_vec(&json!({
            "id": request_id,
            "method": method,
            "params": params,
        }))
        .map_err(|error| NotebookKernelError::Request(error.to_string()))?;
        let write_result = {
            let mut stdin = self.stdin.lock().await;
            stdin
                .write_all(&line)
                .await
                .and_then(|_| stdin.write_all(b"\n").await)
        };
        if let Err(error) = write_result {
            self.pending.lock().await.remove(&request_id);
            self.mark_dead(format!("bridge write failed: {error}"))
                .await;
            return Err(NotebookKernelError::Bridge(error.to_string()));
        }
        match receiver.await {
            Ok(Ok(value)) => {
                self.touch().await;
                Ok(value)
            }
            Ok(Err(error)) => Err(NotebookKernelError::Request(error)),
            Err(_) => Err(NotebookKernelError::Bridge(
                "bridge response channel closed".to_string(),
            )),
        }
    }

    async fn read_stdout(&self, stdout: tokio::process::ChildStdout) {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    let message: Value = match serde_json::from_str(&line) {
                        Ok(value) => value,
                        Err(error) => {
                            tracing::warn!(target: "notebook_kernel", "invalid bridge message: {error}");
                            self.mark_dead(format!("invalid bridge message: {error}"))
                                .await;
                            return;
                        }
                    };
                    if message.get("kind").and_then(Value::as_str) == Some("event") {
                        if let Some(event) = message.get("event") {
                            self.apply_event_state(event).await;
                            emit_event(&self.inner.emitter, NOTEBOOK_KERNEL_EVENT, event);
                        }
                        continue;
                    }
                    let Some(id) = message.get("id").and_then(Value::as_str) else {
                        continue;
                    };
                    let sender = self.pending.lock().await.remove(id);
                    let Some(sender) = sender else { continue };
                    if message.get("kind").and_then(Value::as_str) == Some("error") {
                        let error = message
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("Notebook bridge request failed")
                            .to_string();
                        let _ = sender.send(Err(error));
                    } else {
                        let _ =
                            sender.send(Ok(message.get("result").cloned().unwrap_or(Value::Null)));
                    }
                }
                Ok(None) | Err(_) => break,
            }
        }
        self.mark_dead("Jupyter bridge exited".to_string()).await;
    }

    async fn mark_dead(&self, message: String) {
        if !self.alive.swap(false, Ordering::AcqRel) {
            return;
        }
        let pending = std::mem::take(&mut *self.pending.lock().await);
        for (_, sender) in pending {
            let _ = sender.send(Err(message.clone()));
        }
        emit_event(
            &self.inner.emitter,
            NOTEBOOK_KERNEL_EVENT,
            json!({ "kind": "error", "sessionId": self.id, "message": message }),
        );
        emit_event(
            &self.inner.emitter,
            NOTEBOOK_KERNEL_EVENT,
            json!({ "kind": "state", "sessionId": self.id, "state": "dead" }),
        );
    }

    async fn touch(&self) {
        *self.last_activity.lock().await = tokio::time::Instant::now();
    }

    async fn apply_event_state(&self, event: &Value) {
        self.touch().await;
        if event.get("kind").and_then(Value::as_str) != Some("state") {
            return;
        }
        let Some(state) = event.get("state").and_then(Value::as_str) else {
            return;
        };
        let busy = matches!(state, "busy" | "interrupting");
        self.busy.store(busy, Ordering::Release);
        let mut current_info = self.info.lock().await;
        if let Some(info) = current_info.as_mut() {
            info.state = state.to_string();
        }
    }

    async fn shutdown(&self) {
        if self.alive.load(Ordering::Acquire) {
            let _ = self.request("shutdown", json!({})).await;
        }
        self.alive.store(false, Ordering::Release);
        let pending = std::mem::take(&mut *self.pending.lock().await);
        for (_, sender) in pending {
            let _ = sender.send(Err("Notebook kernel shut down".to_string()));
        }
        let mut child = self.child.lock().await;
        let _ = child.kill().await;
        let _ = child.wait().await;
    }

    async fn kill(&self) {
        self.alive.store(false, Ordering::Release);
        let mut child = self.child.lock().await;
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
}

fn validate_session_id(value: &str) -> Result<(), NotebookKernelError> {
    if value.is_empty() || value.len() > 256 {
        return Err(NotebookKernelError::Invalid(
            "sessionId must be 1-256 characters".to_string(),
        ));
    }
    Ok(())
}

fn validate_path(value: &str, field: &str) -> Result<(), NotebookKernelError> {
    if value.is_empty() || value.len() > 4096 || Path::new(value).is_relative() {
        return Err(NotebookKernelError::Invalid(format!(
            "{field} must be an absolute path"
        )));
    }
    Ok(())
}

fn find_python() -> Option<String> {
    if let Ok(value) = std::env::var("CODEG_JUPYTER_PYTHON") {
        if !value.trim().is_empty() {
            return Some(value);
        }
    }
    ["python3", "python"].iter().find_map(|candidate| {
        which::which(candidate)
            .ok()
            .map(|path| path.to_string_lossy().into_owned())
    })
}
