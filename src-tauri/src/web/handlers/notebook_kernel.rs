use std::sync::Arc;

use axum::{extract::Extension, Json};

use crate::{
    app_error::AppCommandError,
    app_state::AppState,
    notebook_kernel::{
        NotebookKernelExecuteRequest, NotebookKernelInputRequest, NotebookKernelRunAllRequest,
        NotebookKernelSession, NotebookKernelSpec, NotebookKernelStartRequest,
    },
};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIdRequest {
    session_id: String,
}

fn map_error(error: crate::notebook_kernel::NotebookKernelError) -> AppCommandError {
    AppCommandError::task_execution_failed(error.to_string())
}

pub async fn notebook_kernel_list_specs(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<Vec<NotebookKernelSpec>>, AppCommandError> {
    state
        .notebook_kernel_manager
        .list_specs()
        .await
        .map(Json)
        .map_err(map_error)
}

pub async fn notebook_kernel_start(
    Extension(state): Extension<Arc<AppState>>,
    Json(request): Json<NotebookKernelStartRequest>,
) -> Result<Json<NotebookKernelSession>, AppCommandError> {
    state
        .notebook_kernel_manager
        .start(request)
        .await
        .map(Json)
        .map_err(map_error)
}

pub async fn notebook_kernel_execute(
    Extension(state): Extension<Arc<AppState>>,
    Json(request): Json<NotebookKernelExecuteRequest>,
) -> Result<Json<()>, AppCommandError> {
    state
        .notebook_kernel_manager
        .execute(request)
        .await
        .map(|_| Json(()))
        .map_err(map_error)
}

pub async fn notebook_kernel_run_all(
    Extension(state): Extension<Arc<AppState>>,
    Json(request): Json<NotebookKernelRunAllRequest>,
) -> Result<Json<()>, AppCommandError> {
    state
        .notebook_kernel_manager
        .run_all(request)
        .await
        .map(|_| Json(()))
        .map_err(map_error)
}

pub async fn notebook_kernel_interrupt(
    Extension(state): Extension<Arc<AppState>>,
    Json(request): Json<SessionIdRequest>,
) -> Result<Json<()>, AppCommandError> {
    state
        .notebook_kernel_manager
        .interrupt(&request.session_id)
        .await
        .map(|_| Json(()))
        .map_err(map_error)
}

pub async fn notebook_kernel_restart(
    Extension(state): Extension<Arc<AppState>>,
    Json(request): Json<SessionIdRequest>,
) -> Result<Json<()>, AppCommandError> {
    state
        .notebook_kernel_manager
        .restart(&request.session_id)
        .await
        .map(|_| Json(()))
        .map_err(map_error)
}

pub async fn notebook_kernel_shutdown(
    Extension(state): Extension<Arc<AppState>>,
    Json(request): Json<SessionIdRequest>,
) -> Result<Json<()>, AppCommandError> {
    state
        .notebook_kernel_manager
        .shutdown(&request.session_id)
        .await
        .map(|_| Json(()))
        .map_err(map_error)
}

pub async fn notebook_kernel_input(
    Extension(state): Extension<Arc<AppState>>,
    Json(request): Json<NotebookKernelInputRequest>,
) -> Result<Json<()>, AppCommandError> {
    state
        .notebook_kernel_manager
        .input(request)
        .await
        .map(|_| Json(()))
        .map_err(map_error)
}
