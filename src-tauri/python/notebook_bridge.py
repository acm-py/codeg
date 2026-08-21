"""JSONL bridge between Codeg and one Jupyter kernel.

The bridge owns one kernel process. Rust owns bridge process lifetime and maps
its events to Codeg's desktop/web event transport. Keep stdout protocol-only:
kernel diagnostics belong on stderr so one noisy package cannot corrupt JSONL.
"""

import json
import queue
import sys
import threading


class BridgeError(Exception):
    """A request failed in a way the frontend should display."""


class NotebookBridge:
    def __init__(
        self,
        emit,
        kernel_manager_factory=None,
        kernelspec_manager_factory=None,
    ):
        self.emit = emit
        self.kernel_manager_factory = kernel_manager_factory
        self.kernelspec_manager_factory = kernelspec_manager_factory
        self.kernel_manager = None
        self.client = None
        self.session_id = None
        self.notebook_path = None
        self.kernel_name = None
        self._execution_lock = threading.Lock()
        self._running = False

    def list_specs(self):
        if self.kernelspec_manager_factory is None:
            try:
                from jupyter_client.kernelspec import KernelSpecManager
            except ImportError as error:
                raise BridgeError(
                    "Jupyter support is unavailable. Install jupyter_client and ipykernel for this Python interpreter."
                ) from error
            self.kernelspec_manager_factory = KernelSpecManager

        specs = self.kernelspec_manager_factory().get_all_specs()
        return [
            {
                "name": name,
                "displayName": spec.get("spec", {}).get("display_name", name),
                "language": spec.get("spec", {}).get("language"),
            }
            for name, spec in sorted(specs.items())
        ]

    def start(self, params):
        session_id = self._required_string(params, "sessionId")
        notebook_path = self._required_string(params, "notebookPath")
        cwd = self._required_string(params, "cwd")
        kernel_name = params.get("kernelName") or "python3"
        if not isinstance(kernel_name, str):
            raise BridgeError("Kernel name must be a string")

        self.shutdown(emit_state=False)
        if self.kernel_manager_factory is None:
            try:
                from jupyter_client import KernelManager
            except ImportError as error:
                raise BridgeError(
                    "Jupyter support is unavailable. Install jupyter_client and ipykernel for this Python interpreter."
                ) from error
            self.kernel_manager_factory = KernelManager

        self._emit_state("starting", session_id)
        try:
            self.kernel_manager = self.kernel_manager_factory(kernel_name=kernel_name)
            self.kernel_manager.start_kernel(cwd=cwd)
            self.client = self.kernel_manager.client()
            self.client.start_channels()
            self.client.wait_for_ready(timeout=30)
        except Exception as error:
            self.shutdown(emit_state=False)
            self._emit_state("unavailable", session_id)
            raise BridgeError(f"Could not start Jupyter kernel '{kernel_name}': {error}") from error

        self.session_id = session_id
        self.notebook_path = notebook_path
        self.kernel_name = kernel_name
        self._emit_state("idle")
        return {
            "sessionId": self.session_id,
            "notebookPath": self.notebook_path,
            "kernelName": self.kernel_name,
            "state": "idle",
        }

    def submit_cells(self, cells):
        self._require_kernel()
        normalized = self._normalize_cells(cells)
        with self._execution_lock:
            if self._running:
                raise BridgeError("This notebook kernel is already executing")
            self._running = True
        thread = threading.Thread(
            target=self._run_cells_worker,
            args=(normalized,),
            daemon=True,
            name="codeg-notebook-execute",
        )
        thread.start()

    def run_cells(self, cells):
        """Run cells synchronously. Kept public for the protocol unit tests."""
        self._require_kernel()
        self._emit_state("busy")
        try:
            for cell in self._normalize_cells(cells):
                self._run_cell(cell)
        finally:
            self._emit_state("idle")

    def interrupt(self):
        self._require_kernel()
        self._emit_state("interrupting")
        try:
            self.kernel_manager.interrupt_kernel()
        except Exception as error:
            self._emit_state("dead")
            raise BridgeError(f"Could not interrupt Jupyter kernel: {error}") from error

    def restart(self):
        self._require_kernel()
        self._emit_state("starting")
        try:
            self.client.stop_channels()
            self.kernel_manager.restart_kernel(now=True)
            self.client = self.kernel_manager.client()
            self.client.start_channels()
            self.client.wait_for_ready(timeout=30)
        except Exception as error:
            self._emit_state("dead")
            raise BridgeError(f"Could not restart Jupyter kernel: {error}") from error
        self._emit_state("idle")

    def input(self, value):
        self._require_kernel()
        if not isinstance(value, str):
            raise BridgeError("Notebook input must be a string")
        self.client.input(value)

    def shutdown(self, emit_state=True):
        manager = self.kernel_manager
        client = self.client
        self.kernel_manager = None
        self.client = None
        with self._execution_lock:
            self._running = False

        if client is not None:
            try:
                client.stop_channels()
            except Exception:
                pass
        if manager is not None:
            try:
                manager.shutdown_kernel(now=True)
            except Exception:
                pass
        if emit_state and self.session_id is not None:
            self._emit_state("dead")
        self.kernel_name = None
        self.notebook_path = None

    def _run_cells_worker(self, cells):
        try:
            self.run_cells(cells)
        except Exception as error:
            self.emit(
                {
                    "kind": "error",
                    "sessionId": self.session_id,
                    "message": str(error),
                }
            )
            self._emit_state("idle")
        finally:
            with self._execution_lock:
                self._running = False

    def _run_cell(self, cell):
        index = cell["index"]
        self.emit(
            {
                "kind": "clearOutputs",
                "sessionId": self.session_id,
                "cellIndex": index,
            }
        )
        message_id = self.client.execute(
            cell["code"], allow_stdin=True, stop_on_error=False, store_history=True
        )
        while True:
            self._drain_stdin(message_id)
            try:
                message = self.client.iopub_channel.get_msg(timeout=0.1)
            except queue.Empty:
                continue
            if message.get("parent_header", {}).get("msg_id") != message_id:
                continue
            message_type = message.get("msg_type")
            content = message.get("content", {})
            if message_type == "status" and content.get("execution_state") == "idle":
                return
            if message_type == "execute_input":
                self.emit(
                    {
                        "kind": "executionCount",
                        "sessionId": self.session_id,
                        "cellIndex": index,
                        "count": content.get("execution_count"),
                    }
                )
                continue
            if message_type == "clear_output":
                self.emit(
                    {
                        "kind": "clearOutputs",
                        "sessionId": self.session_id,
                        "cellIndex": index,
                    }
                )
                continue
            if message_type == "update_display_data":
                display_id = content.get("transient", {}).get("display_id")
                if isinstance(display_id, str):
                    self.emit(
                        {
                            "kind": "updateDisplay",
                            "sessionId": self.session_id,
                            "displayId": display_id,
                            "output": self._output("display_data", content),
                        }
                    )
                continue
            output = self._output(message_type, content)
            if output is not None:
                self.emit(
                    {
                        "kind": "output",
                        "sessionId": self.session_id,
                        "cellIndex": index,
                        "output": output,
                    }
                )

    def _drain_stdin(self, message_id):
        get_stdin_message = getattr(self.client, "get_stdin_msg", None)
        if get_stdin_message is None:
            return
        try:
            message = get_stdin_message(timeout=0)
        except queue.Empty:
            return
        if message.get("parent_header", {}).get("msg_id") != message_id:
            return
        if message.get("msg_type") != "input_request":
            return
        content = message.get("content", {})
        self.emit(
            {
                "kind": "inputRequest",
                "sessionId": self.session_id,
                "prompt": content.get("prompt", ""),
                "password": bool(content.get("password", False)),
            }
        )

    def _output(self, message_type, content):
        if message_type == "stream":
            return {
                "output_type": "stream",
                "name": content.get("name", "stdout"),
                "text": content.get("text", ""),
            }
        if message_type == "display_data":
            output = {
                "output_type": "display_data",
                "data": content.get("data", {}),
                "metadata": content.get("metadata", {}),
            }
            if "transient" in content:
                output["transient"] = content["transient"]
            return output
        if message_type == "execute_result":
            return {
                "output_type": "execute_result",
                "execution_count": content.get("execution_count"),
                "data": content.get("data", {}),
                "metadata": content.get("metadata", {}),
            }
        if message_type == "error":
            return {
                "output_type": "error",
                "ename": content.get("ename", "Error"),
                "evalue": content.get("evalue", ""),
                "traceback": content.get("traceback", []),
            }
        return None

    def _emit_state(self, state, session_id=None):
        self.emit(
            {
                "kind": "state",
                "sessionId": session_id or self.session_id,
                "state": state,
            }
        )

    def _require_kernel(self):
        if self.client is None or self.kernel_manager is None:
            raise BridgeError("Notebook kernel is not running")

    @staticmethod
    def _required_string(params, key):
        value = params.get(key)
        if not isinstance(value, str) or not value:
            raise BridgeError(f"{key} is required")
        return value

    @staticmethod
    def _normalize_cells(cells):
        if not isinstance(cells, list) or not cells:
            raise BridgeError("At least one code cell is required")
        normalized = []
        for cell in cells:
            if not isinstance(cell, dict):
                raise BridgeError("Notebook code cell is invalid")
            index = cell.get("index")
            code = cell.get("code")
            if not isinstance(index, int) or index < 0 or not isinstance(code, str):
                raise BridgeError("Notebook code cell is invalid")
            normalized.append({"index": index, "code": code})
        return normalized


class JsonlProtocol:
    def __init__(self, stream):
        self.stream = stream
        self.lock = threading.Lock()

    def write(self, value):
        with self.lock:
            self.stream.write(json.dumps(value, ensure_ascii=True) + "\n")
            self.stream.flush()

    def event(self, event):
        self.write({"kind": "event", "event": event})

    def response(self, request_id, result=None):
        self.write({"id": request_id, "kind": "response", "result": result})

    def error(self, request_id, message):
        self.write({"id": request_id, "kind": "error", "message": message})


def handle_command(bridge, command):
    request_id = command.get("id")
    method = command.get("method")
    params = command.get("params", {})
    if not isinstance(request_id, str) or not request_id:
        raise BridgeError("Request id is required")
    if not isinstance(params, dict):
        raise BridgeError("Request parameters must be an object")
    if method == "listSpecs":
        return request_id, bridge.list_specs()
    if method == "start":
        return request_id, bridge.start(params)
    if method == "execute":
        bridge.submit_cells([{"index": params.get("cellIndex"), "code": params.get("code")}])
        return request_id, None
    if method == "runAll":
        bridge.submit_cells(params.get("cells"))
        return request_id, None
    if method == "interrupt":
        bridge.interrupt()
        return request_id, None
    if method == "restart":
        bridge.restart()
        return request_id, None
    if method == "input":
        bridge.input(params.get("value"))
        return request_id, None
    if method == "shutdown":
        bridge.shutdown()
        return request_id, None
    raise BridgeError(f"Unknown notebook bridge method: {method}")


def main():
    protocol = JsonlProtocol(sys.stdout)
    bridge = NotebookBridge(protocol.event)
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            command = json.loads(line)
            if not isinstance(command, dict):
                raise BridgeError("Request must be an object")
            request_id, result = handle_command(bridge, command)
            protocol.response(request_id, result)
        except BridgeError as error:
            request_id = command.get("id") if "command" in locals() and isinstance(command, dict) else None
            protocol.error(request_id, str(error))
        except Exception as error:
            request_id = command.get("id") if "command" in locals() and isinstance(command, dict) else None
            print(f"Codeg notebook bridge error: {error}", file=sys.stderr, flush=True)
            protocol.error(request_id, f"Notebook bridge failed: {error}")
    bridge.shutdown()


if __name__ == "__main__":
    main()
