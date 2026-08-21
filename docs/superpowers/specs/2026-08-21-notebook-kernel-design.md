# Notebook Kernel Design

## Goal

Make `.ipynb` files usable inside Codeg: render notebooks by default, edit and
change their cells, run code against a persistent Jupyter kernel, and save the
resulting document without discarding unknown notebook data.

## Scope

The notebook view supports editable code and Markdown cells, add/delete cell
operations, kernel selection, run cell, run all, interrupt, restart, shutdown,
and `input()` replies. It does not include debugging, a variable explorer,
cell reordering, notebook conversion, or collaborative kernel sharing.

Each open file tab owns a separate kernel session. Closing the tab stops that
session; an unused session is stopped after 30 minutes. Kernels are not
restored after an application or server restart.

## Execution Boundary

Notebook code runs as the effective Codeg process user. Docker deployments are
expected to map the intended host UID/GID into the container. Codeg does not
add a second sandbox, resource quota, or privilege escalation layer around
that trusted-user execution model.

## Architecture

Codeg adds a Rust `NotebookKernelManager` to own session identity, inactivity
cleanup, request validation, and event publication. It communicates over
newline-delimited JSON through a persistent Python bridge child process. The
bridge uses `jupyter_client` and the Jupyter Kernel Protocol, including ZeroMQ
channel handling, kernelspec discovery, kernel start/restart/interrupt, execute
requests, stdin replies, IOPub output, and idle completion.

Rust exposes matching Tauri commands and Axum handlers. The frontend uses the
existing transport abstraction for requests and the existing event bridge for
streaming state/output events. The terminal manager is not used: its PTY stream
does not preserve Jupyter request IDs, MIME bundles, or execution state.

Session ownership is represented by a client-generated tab-scoped ID combined
with the notebook's absolute path. Every kernel operation validates this ID;
work from one tab cannot update another tab's output. The backend serializes
execution for a session. It emits only events scoped to the session ID so
unrelated open tabs ignore them.

## Notebook Document Model

`src/lib/notebook.ts` becomes the source of truth for parsing and mutating
notebook JSON. It retains the original JSON object and mutates only `cells`,
`source`, `cell_type`, `execution_count`, and `outputs` needed by the UI.
Unknown root metadata, cell metadata, attachments, and output fields survive
an edit/save round trip.

The notebook view is always rendered. Code cell source is edited inline.
Markdown renders by default and changes to an inline editor when selected.
Adding a cell creates either an empty code cell or Markdown cell. Deleting a
cell removes only that cell. All mutations serialize back to the original
`.ipynb` content and call the existing file-tab update path, so the established
dirty state, save shortcut, optimistic ETag check, and external-change handling
remain authoritative.

Executing a code cell replaces that cell's old outputs, records the execution
count reported by the kernel, appends normalized output messages in arrival
order, and marks the tab dirty. Running all executes code cells in document
order and does not run Markdown/raw cells.

## Output Rendering

The frontend renders image MIME bundles as images and stream/error/plain text
as text. `text/html` uses an opaque-origin sandboxed iframe with the existing
strict Content Security Policy: scripts, top-level navigation, and same-origin
access remain disabled. This renders Pandas and other DataFrame HTML tables
instead of showing their markup in a `<pre>`.

The bridge preserves MIME bundles needed for notebook storage. The parser picks
the best supported frontend representation without losing the stored raw output.
`clear_output`, `update_display_data`, and `execute_input` are handled by the
session output collector so displayed results stay coherent.

## Environment

Docker images install pinned `jupyter_client` and `ipykernel` packages and
register the default Python kernel. The Python bridge ships with the
application image. Both `Dockerfile` and CI's `Dockerfile.ci` receive the same
runtime dependencies.

Desktop builds do not bundle a Python distribution. At runtime Codeg locates a
system Python capable of importing the bridge dependencies and lists its
installed kernelspecs, allowing Python, R, Julia, and other compatible kernels.
If no usable bridge/runtime exists, the notebook view reports the dependency
and installation command; it never performs an implicit package install.

## UI and Error Handling

The notebook header shows the selected kernel and its state. Its controls are:
kernel selection, run all, interrupt, restart, and shutdown. Code cells expose
run and delete icon buttons; the header exposes an add-cell menu for code or
Markdown. Running state disables duplicate execution for that notebook but
does not block other notebooks.

Bridge startup failure, absent kernelspecs, a dead kernel, malformed bridge
messages, and execution errors are returned as explicit user-visible notebook
states. An execution exception is written as an error output, not a transport
failure. A disconnected bridge fails outstanding requests and allows a later
operation to start a fresh bridge.

## Verification and Release

Tests cover format-preserving notebook mutation, HTML MIME detection, output
event application, per-session sequencing, lifecycle cleanup, bridge message
validation, and the notebook UI actions. CI runs the frontend tests, Rust
server checks/tests, and the multi-architecture Docker publication workflow.

After a successful release image publish, deployment pulls
`ghcr.io/acm-py/codeg:latest`, recreates the service without local builds, and
checks container state plus HTTP health. A deployed smoke test runs a Python
cell, verifies HTML DataFrame output, runs all, interrupts/restarts the kernel,
and saves the changed `.ipynb` file.
