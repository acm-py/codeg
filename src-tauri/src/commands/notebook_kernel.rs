#[cfg(feature = "tauri-runtime")]
use tauri::State;

#[cfg(feature = "tauri-runtime")]
use crate::notebook_kernel::{
    NotebookKernelExecuteRequest, NotebookKernelInputRequest, NotebookKernelManager,
    NotebookKernelRunAllRequest, NotebookKernelSession, NotebookKernelSpec,
    NotebookKernelStartRequest,
};

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn notebook_kernel_list_specs(
    manager: State<'_, NotebookKernelManager>,
) -> Result<Vec<NotebookKernelSpec>, String> {
    manager
        .list_specs()
        .await
        .map_err(|error| error.to_string())
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn notebook_kernel_start(
    request: NotebookKernelStartRequest,
    manager: State<'_, NotebookKernelManager>,
) -> Result<NotebookKernelSession, String> {
    manager
        .start(request)
        .await
        .map_err(|error| error.to_string())
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn notebook_kernel_execute(
    request: NotebookKernelExecuteRequest,
    manager: State<'_, NotebookKernelManager>,
) -> Result<(), String> {
    manager
        .execute(request)
        .await
        .map_err(|error| error.to_string())
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn notebook_kernel_run_all(
    request: NotebookKernelRunAllRequest,
    manager: State<'_, NotebookKernelManager>,
) -> Result<(), String> {
    manager
        .run_all(request)
        .await
        .map_err(|error| error.to_string())
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn notebook_kernel_interrupt(
    session_id: String,
    manager: State<'_, NotebookKernelManager>,
) -> Result<(), String> {
    manager
        .interrupt(&session_id)
        .await
        .map_err(|error| error.to_string())
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn notebook_kernel_restart(
    session_id: String,
    manager: State<'_, NotebookKernelManager>,
) -> Result<(), String> {
    manager
        .restart(&session_id)
        .await
        .map_err(|error| error.to_string())
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn notebook_kernel_shutdown(
    session_id: String,
    manager: State<'_, NotebookKernelManager>,
) -> Result<(), String> {
    manager
        .shutdown(&session_id)
        .await
        .map_err(|error| error.to_string())
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn notebook_kernel_input(
    request: NotebookKernelInputRequest,
    manager: State<'_, NotebookKernelManager>,
) -> Result<(), String> {
    manager
        .input(request)
        .await
        .map_err(|error| error.to_string())
}
