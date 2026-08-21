# Notebook Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Codeg's `.ipynb` preview into an editable, executable notebook
workspace backed by isolated Jupyter kernels.

**Architecture:** A pure TypeScript notebook document layer makes lossless
cell/output mutations to the file tab's JSON. A Rust manager owns one Python
Jupyter bridge per open tab, publishes session-scoped events through the
existing event bridge, and exposes the same commands in Tauri and Axum. The
React notebook view consumes those APIs/events for editing, execution, and
kernel controls.

**Tech Stack:** TypeScript/React 19/Vitest, Rust/Tokio/Axum/Tauri 2,
Python 3/jupyter_client/ipykernel, Jupyter Kernel Protocol, Docker/GitHub
Actions.

**Spec:** `docs/superpowers/specs/2026-08-21-notebook-kernel-design.md`

## Global Constraints

- A notebook kernel session is tab-scoped and stopped on tab close or after 30
  minutes idle; no session is restored after process restart.
- Notebook code runs as the effective Codeg user. Do not add a second sandbox,
  resource quota, or privilege wrapper.
- Keep unknown notebook root, cell, metadata, attachment, and output fields
  intact across all UI mutations and saves.
- Use existing file-tab content/save/conflict handling; do not create a second
  notebook file writer.
- Render `text/html` only in an opaque-origin, no-script sandboxed iframe.
- Docker includes pinned `jupyter_client==8.6.3` and `ipykernel==6.29.5`;
  desktop discovers an already configured system Python and never installs it.
- Do not run local Rust, frontend, or Docker builds. Run only focused,
  lightweight checks locally; GitHub Actions validates compiled artifacts.
- Write every regression test before its production change. The dev-box rule
  forbids executing Rust/frontend test runners locally, so record the intended
  RED assertion in the commit and obtain GREEN evidence from the required CI
  run after the feature merges to `main`.
- After merge, push to `origin/main`, trigger the Docker workflow, wait for its
  successful image publish, then pull/recreate the local container and verify
  HTTP health.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/notebook.ts` | Parse and mutate notebook JSON while preserving unknown fields; convert raw Jupyter outputs into UI output models. |
| `src/lib/notebook.test.ts` | Contract tests for parsing, lossless mutations, HTML selection, and output replacement. |
| `src-tauri/python/notebook_bridge.py` | One kernel per bridge process: JSONL commands in, protocol events/responses out. |
| `src-tauri/src/notebook_kernel.rs` | Spawn/monitor bridge processes, serialize requests, enforce session ownership and idle cleanup, emit events. |
| `src-tauri/src/notebook_kernel.rs` | Rust manager plus its `#[cfg(test)]` fake-bridge tests for validation, sequence, and idle cleanup. |
| `src-tauri/src/app_state.rs` | Add `NotebookKernelManager` to shared server/desktop application state. |
| `src-tauri/src/commands/notebook_kernel.rs` | Tauri command wrappers calling manager core functions. |
| `src-tauri/src/web/handlers/notebook_kernel.rs` | Axum parameter validation and JSON handlers calling the same core functions. |
| `src-tauri/src/web/router.rs` | Register the notebook kernel API routes. |
| `src-tauri/src/lib.rs` | Export the manager and register Tauri commands. |
| `src/lib/api.ts`, `src/lib/tauri.ts` | Transport-neutral frontend client methods and shared DTOs. |
| `src/components/files/notebook-preview.tsx` | Editable rendered notebook UI, controls, streamed output reducer, and sandboxed HTML output. |
| `src/components/files/notebook-preview.test.tsx` | Component tests for cell mutations, controls, HTML sandboxing, and kernel events. |
| `src/components/files/file-workspace-panel.tsx` | Always choose notebook view rather than exposing the raw JSON editor. |
| `src/i18n/messages/*.json` | Notebook kernel labels, status, errors, and install guidance for all ten locales. |
| `Dockerfile`, `Dockerfile.ci` | Pin Jupyter runtime dependencies in both local and CI images. |

## Interfaces

The frontend and Rust APIs use these DTOs (camelCase on the wire):

```ts
export type NotebookKernelState =
  | "idle"
  | "starting"
  | "busy"
  | "interrupting"
  | "dead"
  | "unavailable"

export interface NotebookKernelSpec {
  name: string
  displayName: string
  language: string | null
}

export interface NotebookKernelSession {
  sessionId: string
  notebookPath: string
  kernelName: string
  state: NotebookKernelState
}

export type NotebookKernelEvent =
  | { kind: "state"; sessionId: string; state: NotebookKernelState }
  | { kind: "clearOutputs"; sessionId: string; cellIndex: number }
  | { kind: "output"; sessionId: string; cellIndex: number; output: unknown }
  | { kind: "executionCount"; sessionId: string; cellIndex: number; count: number | null }
  | { kind: "inputRequest"; sessionId: string; prompt: string; password: boolean }
  | { kind: "error"; sessionId: string; message: string }
```

The event channel is `notebook-kernel://event`. Frontend request methods are:

```ts
notebookKernelListSpecs(): Promise<NotebookKernelSpec[]>
notebookKernelStart(params: { sessionId: string; notebookPath: string; cwd: string; kernelName?: string }): Promise<NotebookKernelSession>
notebookKernelExecute(params: { sessionId: string; cellIndex: number; code: string }): Promise<void>
notebookKernelRunAll(params: { sessionId: string; cells: Array<{ index: number; code: string }> }): Promise<void>
notebookKernelInterrupt(sessionId: string): Promise<void>
notebookKernelRestart(sessionId: string): Promise<void>
notebookKernelShutdown(sessionId: string): Promise<void>
notebookKernelInput(params: { sessionId: string; value: string }): Promise<void>
```

## Task 1: Lossless Notebook Model and HTML Output

**Files:**
- Modify: `src/lib/notebook.ts`
- Modify: `src/lib/notebook.test.ts`

**Consumes:** Raw `.ipynb` JSON from a file tab.

**Produces:** `mutateNotebook`, `setNotebookCellSource`, `insertNotebookCell`,
`deleteNotebookCell`, `replaceNotebookCellOutputs`, `appendNotebookCellOutput`,
and a `NotebookDocument` retaining raw root/cell data.

- [ ] **Step 1: Write the failing mutation tests**

```ts
it("preserves unknown notebook data while changing a code cell", () => {
  const source = JSON.stringify({
    metadata: { custom: { keep: true } },
    cells: [{ cell_type: "code", source: ["old\n"], metadata: { tag: "x" }, outputs: [{ output_type: "stream", text: "old" }], extra: 1 }],
  })
  const result = setNotebookCellSource(source, 0, "new\n")
  const root = JSON.parse(result)
  expect(root.metadata.custom.keep).toBe(true)
  expect(root.cells[0]).toMatchObject({ source: ["new\n"], metadata: { tag: "x" }, extra: 1 })
})

it("selects HTML output and replaces only the target cell outputs", () => {
  const source = JSON.stringify({ cells: [{ cell_type: "code", source: "x", outputs: [{ output_type: "stream", text: "old" }] }] })
  const result = replaceNotebookCellOutputs(source, 0, [{ output_type: "display_data", data: { "text/html": "<table><tr><td>x</td></tr></table>" } }])
  expect(parseNotebook(result).cells[0].outputs[0]).toMatchObject({ kind: "html", text: "<table><tr><td>x</td></tr></table>" })
})
```

- [ ] **Step 2: Record the expected RED result**

The new test imports missing mutation exports, so the frontend Vitest job would
fail before Step 3. Do not execute it locally: this dev box is restricted from
frontend compilation. The final GitHub Actions frontend job is the required
GREEN evidence.

- [ ] **Step 3: Implement the minimum lossless mutators**

```ts
export function setNotebookCellSource(content: string, index: number, source: string): string {
  return mutateNotebook(content, (root) => {
    const cell = notebookCellAt(root, index)
    cell.source = source.split(/(?<=\n)/)
  })
}

export function replaceNotebookCellOutputs(content: string, index: number, outputs: unknown[]): string {
  return mutateNotebook(content, (root) => {
    const cell = notebookCellAt(root, index)
    cell.outputs = outputs
  })
}
```

Keep `mutateNotebook` strict about the root and `cells` shape; it must throw a
typed parse error rather than produce a partial document. Add code/Markdown
cell factories with `metadata: {}` and code-cell `execution_count: null`,
`outputs: []`.

- [ ] **Step 4: Run permitted static checks**

Run: `git diff --check && git diff -- src/lib/notebook.ts src/lib/notebook.test.ts`

Expected: no whitespace errors; the test names and assertions match the
exports implemented in Step 3.

- [ ] **Step 5: Commit the model work**

```bash
git add src/lib/notebook.ts src/lib/notebook.test.ts
git commit -m "feat(notebook): support lossless cell mutations"
```

## Task 2: Jupyter JSONL Bridge

**Files:**
- Create: `src-tauri/python/notebook_bridge.py`
- Create: `src-tauri/python/test_notebook_bridge.py`

**Consumes:** JSONL commands `listSpecs`, `start`, `execute`, `runAll`,
`interrupt`, `restart`, `input`, and `shutdown`.

**Produces:** JSONL replies/events matching `NotebookKernelEvent` and raw
Jupyter nbformat outputs.

- [ ] **Step 1: Write a bridge protocol test with a fake kernel client**

```py
def test_display_data_becomes_notebook_output(bridge):
    bridge.client.iopub_channel.get_msg.side_effect = [
        {"parent_header": {"msg_id": "request-1"}, "msg_type": "display_data", "content": {"data": {"text/html": "<table></table>"}, "metadata": {}}},
        {"parent_header": {"msg_id": "request-1"}, "msg_type": "status", "content": {"execution_state": "idle"}},
    ]
    bridge.handle({"id": "1", "method": "execute", "params": {"cellIndex": 0, "code": "df"}})
    assert bridge.events[0]["kind"] == "clearOutputs"
    assert bridge.events[1]["output"]["data"]["text/html"] == "<table></table>"
```

- [ ] **Step 2: Run it to verify RED**

Run: `python3 -m unittest src-tauri/python/test_notebook_bridge.py`

Expected: FAIL because the bridge module does not exist. This is a lightweight
Python test and does not invoke a Jupyter kernel.

- [ ] **Step 3: Implement the JSONL bridge**

The bridge writes one JSON object per line and flushes every line. Reserve
stdout for protocol data; write diagnostics to stderr. Map IOPub messages as:

```py
OUTPUT_TYPES = {
    "stream": lambda c: {"output_type": "stream", "name": c.get("name", "stdout"), "text": c.get("text", "")},
    "display_data": lambda c: {"output_type": "display_data", "data": c.get("data", {}), "metadata": c.get("metadata", {})},
    "execute_result": lambda c: {"output_type": "execute_result", "execution_count": c.get("execution_count"), "data": c.get("data", {}), "metadata": c.get("metadata", {})},
    "error": lambda c: {"output_type": "error", "ename": c.get("ename", "Error"), "evalue": c.get("evalue", ""), "traceback": c.get("traceback", [])},
}
```

Filter every IOPub and shell reply by the current execute request's `msg_id`.
On `status: idle`, emit `state: idle` then send the command response. Use
`KernelManager(kernel_name=...)` and pass the notebook directory as the kernel
working directory. `runAll` must call the same execute path sequentially.

- [ ] **Step 4: Run the bridge protocol tests to verify GREEN**

Run: `python3 -m unittest src-tauri/python/test_notebook_bridge.py`

Expected: PASS without requiring a real Jupyter installation.

- [ ] **Step 5: Commit the bridge**

```bash
git add src-tauri/python/notebook_bridge.py src-tauri/python/test_notebook_bridge.py
git commit -m "feat(notebook): add Jupyter protocol bridge"
```

## Task 3: Rust Kernel Manager and Shared APIs

**Files:**
- Create: `src-tauri/src/notebook_kernel.rs`
- Create: `src-tauri/src/commands/notebook_kernel.rs`
- Create: `src-tauri/src/web/handlers/notebook_kernel.rs`
- Modify: `src-tauri/src/app_state.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/web/handlers/mod.rs`
- Modify: `src-tauri/src/web/router.rs`
- Modify: `src/lib/api.ts`
- Modify: `src/lib/tauri.ts`
- Modify: `src/lib/types.ts`

**Consumes:** Task 2's embedded bridge script and JSONL protocol.

**Produces:** `NotebookKernelManager`, shared core methods, Tauri commands,
Axum routes, and frontend transport methods defined in **Interfaces**.

- [ ] **Step 1: Write Rust manager tests against a fake bridge executable**

```rust
#[tokio::test]
async fn execute_clears_target_outputs_then_emits_ordered_output() {
    let (manager, mut events) = manager_with_fake_bridge().await;
    manager.start(StartRequest::test("tab-a", "/work/a.ipynb")).await.unwrap();
    manager.execute(ExecuteRequest::test("tab-a", 2, "print(1)")).await.unwrap();
    assert_eq!(events.recv().await.unwrap().kind(), "clear_outputs");
    assert_eq!(events.recv().await.unwrap().kind(), "output");
}

#[tokio::test(start_paused = true)]
async fn idle_session_is_shutdown_after_thirty_minutes() {
    let manager = manager_with_fake_bridge().await.0;
    manager.start(StartRequest::test("tab-a", "/work/a.ipynb")).await.unwrap();
    tokio::time::advance(Duration::from_secs(30 * 60)).await;
    assert!(manager.session("tab-a").await.is_none());
}
```

- [ ] **Step 2: Record the expected RED result**

The module test refers to a missing `NotebookKernelManager`, so Cargo would
fail before Step 3. Do not execute Cargo locally; the merged `main` CI server
and desktop jobs are the required compile/test evidence.

- [ ] **Step 3: Implement manager and core APIs**

Embed the Python bridge with `include_str!("../python/notebook_bridge.py")`,
write it to a per-process private file under `CODEG_DATA_DIR`, spawn it with a
discovered `CODEG_JUPYTER_PYTHON`, `python3`, or `python` interpreter, and
delete it after the final bridge exits. Guard the sessions map with Tokio locks.
Only one execute request per `session_id` may be active.

Use Rust DTOs serialized with `#[serde(rename_all = "camelCase")]`. Emit
all bridge events through:

```rust
pub const NOTEBOOK_KERNEL_EVENT: &str = "notebook-kernel://event";
emit_event(&emitter, NOTEBOOK_KERNEL_EVENT, event);
```

Tauri wrappers obtain `State<NotebookKernelManager>`; Axum handlers obtain
`Extension<Arc<AppState>>`. Both call the same manager methods. Register POST
routes `/notebook_kernel_list_specs`, `/notebook_kernel_start`,
`/notebook_kernel_execute`, `/notebook_kernel_run_all`,
`/notebook_kernel_interrupt`, `/notebook_kernel_restart`,
`/notebook_kernel_shutdown`, and `/notebook_kernel_input`.

- [ ] **Step 4: Run permitted Rust formatting check**

Run: `cargo fmt --check`

Expected: PASS. Do not run local Cargo compilation or release builds.

- [ ] **Step 5: Commit manager and APIs**

```bash
git add src-tauri/src/notebook_kernel.rs src-tauri/src/commands/notebook_kernel.rs src-tauri/src/web/handlers/notebook_kernel.rs src-tauri/src/app_state.rs src-tauri/src/lib.rs src-tauri/src/commands/mod.rs src-tauri/src/web/handlers/mod.rs src-tauri/src/web/router.rs src/lib/api.ts src/lib/tauri.ts src/lib/types.ts
git commit -m "feat(notebook): manage Jupyter kernels"
```

## Task 4: Editable Notebook Workspace

**Files:**
- Modify: `src/components/files/notebook-preview.tsx`
- Create: `src/components/files/notebook-preview.test.tsx`
- Modify: `src/components/files/file-workspace-header.tsx`
- Modify: `src/components/files/file-workspace-panel.tsx`

**Consumes:** Task 1 mutators and Task 3 frontend API/event DTOs.

**Produces:** Render-only notebook route with editable/add/delete cells,
kernel controls, session lifecycle, and event-driven output persistence.

- [ ] **Step 1: Write failing component tests**

```tsx
it("renders HTML output in a strict sandboxed iframe", () => {
  render(<NotebookPreview tab={notebookTabWithHtml("<table><tr><td>PBCASH</td></tr></table>")} />)
  const frame = screen.getByTitle("Notebook HTML output")
  expect(frame).toHaveAttribute("sandbox", "")
  expect(frame).toHaveAttribute("srcDoc", expect.stringContaining("<table>"))
})

it("updates file content after adding, editing, and deleting cells", async () => {
  render(<NotebookPreview tab={notebookTab()} />)
  await userEvent.click(screen.getByLabelText("Add code cell"))
  await userEvent.type(screen.getAllByRole("textbox")[0], "x = 1")
  await userEvent.click(screen.getByLabelText("Delete cell 1"))
  expect(updateFileTabContent).toHaveBeenCalledWith(tab.id, expect.stringContaining("x = 1"))
})
```

- [ ] **Step 2: Record the expected RED result**

The test queries controls and an iframe that do not exist before Step 3. Do not
run Vitest locally; the merged GitHub Actions frontend job supplies the GREEN
result.

- [ ] **Step 3: Implement the notebook interaction surface**

Use Lucide `Play`, `Plus`, `Trash2`, `Square`, `RotateCcw`, and `Power`
inside icon buttons with translated `aria-label`/tooltips. Use the existing
`DropdownMenu` for the add-cell and kernelspec menus. Keep controls compact;
do not add nested card surfaces.

Create a `useEffect` that subscribes to `NOTEBOOK_KERNEL_EVENT`; ignore events
whose `sessionId` differs from the tab ID. Apply `clearOutputs`, `output`, and
`executionCount` with Task 1 mutators via `updateFileTabContent`. Subscribe
before issuing an execute request. On unmount and tab close, call shutdown
unless the process has already reported `dead`.

Disable cell structural edits while the session is busy so indexes remain
stable. `runAll` gathers current code cells as `{ index, code }` in visual
order. Keep the header's generic source/preview button hidden for `.ipynb`.

- [ ] **Step 4: Run permitted static checks**

Run: `git diff --check && git diff -- src/components/files/notebook-preview.tsx src/components/files/notebook-preview.test.tsx`

Expected: no whitespace errors; each test control label and event payload is
implemented by Step 3.

- [ ] **Step 5: Commit the workspace UI**

```bash
git add src/components/files/notebook-preview.tsx src/components/files/notebook-preview.test.tsx src/components/files/file-workspace-header.tsx src/components/files/file-workspace-panel.tsx
git commit -m "feat(notebook): add editable kernel workspace"
```

## Task 5: Locales and Runtime Dependencies

**Files:**
- Modify: `src/i18n/messages/ar.json`
- Modify: `src/i18n/messages/de.json`
- Modify: `src/i18n/messages/en.json`
- Modify: `src/i18n/messages/es.json`
- Modify: `src/i18n/messages/fr.json`
- Modify: `src/i18n/messages/ja.json`
- Modify: `src/i18n/messages/ko.json`
- Modify: `src/i18n/messages/pt.json`
- Modify: `src/i18n/messages/zh-CN.json`
- Modify: `src/i18n/messages/zh-TW.json`
- Modify: `Dockerfile`
- Modify: `Dockerfile.ci`

**Consumes:** Task 4's translation keys and Task 2's Python imports.

**Produces:** Complete UI text and default Docker Python kernel.

- [ ] **Step 1: Write failing source-level locale and Docker contract tests**

```ts
it("keeps notebook kernel controls translated in every locale", () => {
  for (const locale of LOCALES) {
    expect(messages(locale).Folder.fileWorkspacePanel.notebookRunCell).toBeTruthy()
    expect(messages(locale).Folder.fileWorkspacePanel.notebookKernelUnavailable).toBeTruthy()
  }
})

it("installs the pinned Jupyter runtime in both Dockerfiles", () => {
  for (const file of ["Dockerfile", "Dockerfile.ci"]) {
    expect(readFileSync(file, "utf8")).toContain("jupyter_client==8.6.3")
    expect(readFileSync(file, "utf8")).toContain("ipykernel==6.29.5")
  }
})
```

- [ ] **Step 2: Record the expected RED result**

The source-level contracts name absent locale keys and package pins. Do not run
Vitest locally; the merged frontend CI job supplies the GREEN result.

- [ ] **Step 3: Add translations and pinned package installation**

Add short translations for kernel, select kernel, run cell, run all, stop,
restart, shutdown, add code cell, add Markdown cell, delete cell, running,
unavailable, and desktop installation guidance. Keep the key set identical
across all locale files.

In both image definitions add:

```dockerfile
RUN python3 -m pip install --no-cache-dir --break-system-packages \
    jupyter_client==8.6.3 ipykernel==6.29.5 \
 && python3 -m ipykernel install --sys-prefix --name python3 --display-name "Python 3"
```

- [ ] **Step 4: Run permitted static checks**

Run: `git diff --check && git diff -- Dockerfile Dockerfile.ci src/i18n/messages`

Expected: no whitespace errors and identical key names across all locale files.
Docker build remains CI-only.

- [ ] **Step 5: Commit locales and runtime support**

```bash
git add src/i18n/messages Dockerfile Dockerfile.ci
git commit -m "feat(notebook): ship default Jupyter runtime"
```

## Task 6: Focused Review, CI, Release, and Deployment

**Files:**
- Verify: all files from Tasks 1-5

**Consumes:** Completed implementation.

**Produces:** A pushed `main`, published `ghcr.io/acm-py/codeg:latest`, and a
recreated healthy local service.

- [ ] **Step 1: Review the complete diff and run lightweight checks**

```bash
git diff --check origin/main...HEAD
cargo fmt --check
```

Expected: zero whitespace and formatting errors. The GitHub Actions test
workflow is the only verification for frontend/Rust compilation and tests.

- [ ] **Step 2: Commit any final correction and merge the feature branch**

```bash
git status --short
git log --oneline origin/main..HEAD
git switch main
git merge --no-ff feature/notebook-kernel
git push origin main
```

Expected: `main` contains one explicit feature merge and is pushed only to the
fork remote.

- [ ] **Step 3: Trigger and wait for Docker publication**

```bash
gh workflow run docker.yml -R acm-py/codeg -f image_tag=latest
gh run list -R acm-py/codeg --workflow docker.yml --limit 1
gh run watch -R acm-py/codeg <run-id> --exit-status
```

Expected: frontend, both server architectures, and Docker image publishing all
succeed.

- [ ] **Step 4: Pull, recreate, and verify the service**

```bash
docker compose pull
docker compose up -d --force-recreate --no-build
docker compose ps
curl -sS -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1:3080/
```

Expected: `codeg` is `Up` and the health check is `HTTP 200`.

- [ ] **Step 5: Run deployed notebook smoke test without exposing credentials**

Use the authenticated browser session to open a Python notebook, run `1 + 1`,
render a DataFrame, restart the kernel, and save the document. Report only the
observed behavior, container image digest, and HTTP result.
