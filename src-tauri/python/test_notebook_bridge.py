import unittest

from notebook_bridge import NotebookBridge


class FakeIopubChannel:
    def __init__(self, messages):
        self.messages = list(messages)

    def get_msg(self, timeout):
        del timeout
        return self.messages.pop(0)


class FakeKernelClient:
    def __init__(self, messages):
        self.iopub_channel = FakeIopubChannel(messages)
        self.executed = []
        self.input_values = []

    def execute(self, code, **kwargs):
        self.executed.append((code, kwargs))
        return "request-1"

    def input(self, value):
        self.input_values.append(value)


class NotebookBridgeTest(unittest.TestCase):
    def test_display_data_becomes_notebook_output(self):
        events = []
        client = FakeKernelClient(
            [
                {
                    "parent_header": {"msg_id": "request-1"},
                    "msg_type": "execute_input",
                    "content": {"execution_count": 79},
                },
                {
                    "parent_header": {"msg_id": "request-1"},
                    "msg_type": "display_data",
                    "content": {
                        "data": {"text/html": "<table><tr><td>PBCASH</td></tr></table>"},
                        "metadata": {"isolated": True},
                    },
                },
                {
                    "parent_header": {"msg_id": "request-1"},
                    "msg_type": "status",
                    "content": {"execution_state": "idle"},
                },
            ]
        )
        bridge = NotebookBridge(events.append)
        bridge.session_id = "tab-1"
        bridge.client = client
        bridge.kernel_manager = object()

        bridge.run_cells([{"index": 2, "code": "df"}])

        self.assertEqual(events[0], {"kind": "state", "sessionId": "tab-1", "state": "busy"})
        self.assertEqual(events[1], {"kind": "clearOutputs", "sessionId": "tab-1", "cellIndex": 2})
        self.assertEqual(events[2], {"kind": "executionCount", "sessionId": "tab-1", "cellIndex": 2, "count": 79})
        self.assertEqual(
            events[3],
            {
                "kind": "output",
                "sessionId": "tab-1",
                "cellIndex": 2,
                "output": {
                    "output_type": "display_data",
                    "data": {"text/html": "<table><tr><td>PBCASH</td></tr></table>"},
                    "metadata": {"isolated": True},
                },
            },
        )
        self.assertEqual(events[4], {"kind": "state", "sessionId": "tab-1", "state": "idle"})

    def test_clear_and_update_display_data_emit_distinct_events(self):
        events = []
        client = FakeKernelClient(
            [
                {
                    "parent_header": {"msg_id": "request-1"},
                    "msg_type": "clear_output",
                    "content": {"wait": False},
                },
                {
                    "parent_header": {"msg_id": "request-1"},
                    "msg_type": "update_display_data",
                    "content": {
                        "data": {"text/plain": "updated"},
                        "metadata": {},
                        "transient": {"display_id": "display-1"},
                    },
                },
                {
                    "parent_header": {"msg_id": "request-1"},
                    "msg_type": "status",
                    "content": {"execution_state": "idle"},
                },
            ]
        )
        bridge = NotebookBridge(events.append)
        bridge.session_id = "tab-1"
        bridge.client = client
        bridge.kernel_manager = object()

        bridge.run_cells([{"index": 0, "code": "update()"}])

        self.assertIn({"kind": "clearOutputs", "sessionId": "tab-1", "cellIndex": 0}, events)
        self.assertIn(
            {
                "kind": "updateDisplay",
                "sessionId": "tab-1",
                "displayId": "display-1",
                "output": {
                    "output_type": "display_data",
                    "data": {"text/plain": "updated"},
                    "metadata": {},
                    "transient": {"display_id": "display-1"},
                },
            },
            events,
        )

    def test_input_reply_reaches_active_kernel_client(self):
        client = FakeKernelClient([])
        bridge = NotebookBridge(lambda _: None)
        bridge.session_id = "tab-1"
        bridge.client = client
        bridge.kernel_manager = object()

        bridge.input("answer")

        self.assertEqual(client.input_values, ["answer"])


if __name__ == "__main__":
    unittest.main()
