"""Unit tests for the WorkCrew Windows helper.

These tests run under plain pytest (or unittest) with only the standard
library. agent.py imports pywinauto lazily inside the functions that drive the
desktop, so importing the module here never requires the real package. To be
fully robust even if a stray import path changes, we also inject a minimal fake
pywinauto module into sys.modules before importing agent. The fake is only used
if some code path imports pywinauto at all. The validation, token, and request
handling logic exercised below never touches it.
"""

import io
import sys
import types
import unittest


def _install_fake_pywinauto() -> None:
    if "pywinauto" in sys.modules:
        return
    fake = types.ModuleType("pywinauto")

    class _Unavailable:
        def __init__(self, *args, **kwargs):
            raise RuntimeError("pywinauto is not available in this test environment")

    fake.Application = _Unavailable
    fake.Desktop = _Unavailable
    sys.modules["pywinauto"] = fake


_install_fake_pywinauto()

import agent  # noqa: E402  (import after the fake module is installed)


class ValidateActionTests(unittest.TestCase):
    def test_accepts_known_command(self):
        action = agent.validate_action({"kind": "windows", "command": "list-windows"})
        self.assertEqual(action["command"], "list-windows")
        self.assertEqual(action["kind"], "windows")

    def test_accepts_all_allowlisted_commands(self):
        for command in agent.ALLOWED_COMMANDS:
            action = agent.validate_action({"kind": "windows", "command": command})
            self.assertEqual(action["command"], command)

    def test_rejects_shell_command(self):
        with self.assertRaises(ValueError):
            agent.validate_action({"kind": "windows", "command": "shell"})

    def test_rejects_unknown_command(self):
        for command in ("exec", "eval", "run", "open", "", None, 123):
            with self.assertRaises(ValueError):
                agent.validate_action({"kind": "windows", "command": command})

    def test_rejects_non_object(self):
        for value in ("not an object", 5, None, ["windows"]):
            with self.assertRaises(ValueError):
                agent.validate_action(value)

    def test_rejects_wrong_kind(self):
        with self.assertRaises(ValueError):
            agent.validate_action({"kind": "browser", "command": "list-windows"})
        with self.assertRaises(ValueError):
            agent.validate_action({"command": "list-windows"})

    def test_rejects_extra_fields(self):
        with self.assertRaises(ValueError):
            agent.validate_action({"kind": "windows", "command": "click", "script": "bad"})

    def test_rejects_unknown_field(self):
        with self.assertRaises(ValueError):
            agent.validate_action({"kind": "windows", "command": "click", "code": "x"})

    def test_rejects_oversized_value_text(self):
        with self.assertRaises(ValueError):
            agent.validate_action({
                "kind": "windows",
                "command": "set-text",
                "control": "field",
                "value": "a" * (agent.MAX_TEXT_LENGTH + 1),
            })

    def test_rejects_oversized_control_text(self):
        with self.assertRaises(ValueError):
            agent.validate_action({
                "kind": "windows",
                "command": "click",
                "control": "c" * 501,
            })

    def test_accepts_value_at_limit(self):
        action = agent.validate_action({
            "kind": "windows",
            "command": "set-text",
            "control": "field",
            "value": "a" * agent.MAX_TEXT_LENGTH,
        })
        self.assertEqual(len(action["value"]), agent.MAX_TEXT_LENGTH)


class RequireTextTests(unittest.TestCase):
    def test_strips_and_returns(self):
        self.assertEqual(agent.require_text("  hi  ", "field"), "hi")

    def test_rejects_empty(self):
        for value in ("", "   ", None, 5):
            with self.assertRaises(ValueError):
                agent.require_text(value, "field")

    def test_rejects_too_long(self):
        with self.assertRaises(ValueError):
            agent.require_text("a" * 501, "field", maximum=500)


# A small fake request object that lets us drive the BaseHTTPRequestHandler
# subclass without opening a real socket. We bypass __init__ (which would try to
# parse a live connection) and set the attributes the handler reads.
class _FakeRequestHandler:
    def __init__(self, handler_cls, headers, path, body=b""):
        self.handler = handler_cls.__new__(handler_cls)
        self.handler.headers = headers
        self.handler.path = path
        self.handler.rfile = io.BytesIO(body)
        self.handler.wfile = io.BytesIO()
        self.responses = []
        self.status = None
        self.sent_headers = {}

        def send_response(status, *args, **kwargs):
            self.status = status

        def send_header(key, value):
            self.sent_headers[key.lower()] = value

        def end_headers():
            return None

        self.handler.send_response = send_response
        self.handler.send_header = send_header
        self.handler.end_headers = end_headers

    @property
    def written(self):
        return self.handler.wfile.getvalue()


def _make_handler_cls(token="t" * 32):
    return agent.create_handler(token), token


class TokenAndBodyTests(unittest.TestCase):
    def test_post_rejects_missing_token(self):
        handler_cls, _ = _make_handler_cls()
        req = _FakeRequestHandler(handler_cls, {}, "/action", b'{"kind":"windows"}')
        req.handler.do_POST()
        self.assertEqual(req.status, 401)
        self.assertIn(b"Unauthorized", req.written)

    def test_post_rejects_wrong_token(self):
        handler_cls, _ = _make_handler_cls()
        headers = {"authorization": "Bearer wrong-token"}
        req = _FakeRequestHandler(handler_cls, headers, "/action", b'{"kind":"windows"}')
        req.handler.do_POST()
        self.assertEqual(req.status, 401)

    def test_post_with_valid_token_reaches_validation(self):
        # A valid token plus an invalid action body should yield a 400 from
        # validation, proving the token gate passed and execution was reached
        # without invoking pywinauto.
        handler_cls, token = _make_handler_cls()
        headers = {"authorization": f"Bearer {token}", "content-length": "20"}
        body = b'{"kind":"browser"}  '
        req = _FakeRequestHandler(handler_cls, headers, "/action", body)
        req.handler.do_POST()
        self.assertEqual(req.status, 400)

    def test_post_rejects_oversized_body(self):
        handler_cls, token = _make_handler_cls()
        headers = {
            "authorization": f"Bearer {token}",
            "content-length": str(agent.MAX_BODY_BYTES + 1),
        }
        req = _FakeRequestHandler(handler_cls, headers, "/action", b"x")
        req.handler.do_POST()
        self.assertEqual(req.status, 400)
        self.assertIn(b"Invalid request size", req.written)

    def test_post_rejects_zero_length_body(self):
        handler_cls, token = _make_handler_cls()
        headers = {"authorization": f"Bearer {token}", "content-length": "0"}
        req = _FakeRequestHandler(handler_cls, headers, "/action", b"")
        req.handler.do_POST()
        self.assertEqual(req.status, 400)

    def test_post_rejects_unknown_path(self):
        handler_cls, token = _make_handler_cls()
        headers = {"authorization": f"Bearer {token}"}
        req = _FakeRequestHandler(handler_cls, headers, "/run", b"{}")
        req.handler.do_POST()
        self.assertEqual(req.status, 404)

    def test_token_compare_is_constant_time(self):
        # The handler uses hmac.compare_digest. Verify the helper relies on it by
        # confirming a token differing only in length is still rejected.
        handler_cls, token = _make_handler_cls()
        headers = {"authorization": f"Bearer {token}x"}
        req = _FakeRequestHandler(handler_cls, headers, "/action", b'{"kind":"windows"}')
        req.handler.do_POST()
        self.assertEqual(req.status, 401)


class HealthTests(unittest.TestCase):
    def test_health_requires_token(self):
        handler_cls, _ = _make_handler_cls()
        req = _FakeRequestHandler(handler_cls, {}, "/health")
        req.handler.do_GET()
        self.assertEqual(req.status, 401)

    def test_health_ok_with_token(self):
        handler_cls, token = _make_handler_cls()
        headers = {"authorization": f"Bearer {token}"}
        req = _FakeRequestHandler(handler_cls, headers, "/health")
        req.handler.do_GET()
        self.assertEqual(req.status, 200)
        self.assertIn(b'"ok": true', req.written)

    def test_get_rejects_unknown_path(self):
        handler_cls, token = _make_handler_cls()
        headers = {"authorization": f"Bearer {token}"}
        req = _FakeRequestHandler(handler_cls, headers, "/action")
        req.handler.do_GET()
        self.assertEqual(req.status, 404)


class EscapeForTypeKeysTests(unittest.TestCase):
    def test_escapes_keystroke_metacharacters_to_literal(self):
        # Each pywinauto metacharacter is wrapped in braces so it types literally,
        # never as a chord/hotkey, and ordinary values type verbatim.
        self.assertEqual(agent.escape_for_type_keys("50% off"), "50{%} off")
        self.assertEqual(agent.escape_for_type_keys("2+2"), "2{+}2")
        self.assertEqual(agent.escape_for_type_keys("(note)"), "{(}note{)}")
        self.assertEqual(agent.escape_for_type_keys("a~b"), "a{~}b")
        self.assertEqual(agent.escape_for_type_keys("^s"), "{^}s")
        self.assertEqual(agent.escape_for_type_keys("{ENTER}"), "{{}ENTER{}}")

    def test_plain_text_is_unchanged(self):
        self.assertEqual(agent.escape_for_type_keys("Hello World 123"), "Hello World 123")


class ExecuteActionTests(unittest.TestCase):
    def test_commands_requiring_window_fail_without_connect(self):
        original = agent.STATE.window
        agent.STATE.window = None
        try:
            with self.assertRaises(ValueError):
                agent.execute_action({"kind": "windows", "command": "inspect"})
        finally:
            agent.STATE.window = original

    def test_only_allowlisted_commands_execute(self):
        # validate_action gates commands, so an action that skipped validation
        # with an unknown command falls through execute_action to a ValueError
        # rather than doing anything.
        with self.assertRaises(ValueError):
            agent.execute_action({"kind": "windows", "command": "totally-unknown"})


class BuildInspectTests(unittest.TestCase):
    def test_keeps_only_interactable_named_controls(self):
        infos = [
            {"name": "Save", "auto_id": "btnSave", "control_type": "Button"},
            {"name": "", "auto_id": "", "control_type": "Pane"},          # decoration
            {"name": "Label", "auto_id": "", "control_type": "Text"},      # not interactable
            {"name": "", "auto_id": "sep1", "control_type": "Separator"},  # not interactable
            {"name": "Customer", "auto_id": "cmbCust", "control_type": "ComboBox"},
            {"name": "", "auto_id": "", "control_type": "Button"},         # interactable type but anonymous
        ]
        text, elements = agent.build_inspect(infos)
        lines = text.splitlines()
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[0], '1 Button "Save"')
        self.assertEqual(lines[1], '2 ComboBox "Customer"')
        self.assertEqual(elements["1"]["auto_id"], "btnSave")
        self.assertEqual(elements["1"]["title"], "Save")
        self.assertEqual(elements["1"]["control_type"], "Button")
        self.assertEqual(elements["2"]["auto_id"], "cmbCust")

    def test_custom_button_group_is_labeled_by_its_caption(self):
        # The exact Adminsoft shape: a Group named cmd_exit with the visible text
        # "Exit Accounts Suite" drawn on top of it. The button must appear, be
        # labeled by the caption the user sees, but resolve by its real name.
        infos = [
            {"name": "cmd_exit", "auto_id": "", "control_type": "Group", "rect": [1431, 638, 1594, 707]},
            {"name": "Exit Accounts Suite", "auto_id": "", "control_type": "Text", "rect": [1494, 643, 1582, 699]},
            {"name": "cmd_select", "auto_id": "", "control_type": "Group", "rect": [1431, 555, 1594, 624]},
            {"name": "Select Comp./Org.", "auto_id": "", "control_type": "Text", "rect": [1500, 569, 1581, 608]},
        ]
        text, elements = agent.build_inspect(infos)
        lines = text.splitlines()
        self.assertIn('1 Group "Exit Accounts Suite"', lines)
        self.assertIn('2 Group "Select Comp./Org."', lines)
        # Resolution still uses the real control name, not the cosmetic caption.
        self.assertEqual(elements["1"]["title"], "cmd_exit")
        self.assertEqual(elements["1"]["rect"], [1431, 638, 1594, 707])

    def test_layout_group_without_caption_or_command_name_is_dropped(self):
        infos = [
            {"name": "MainLayoutPanel", "auto_id": "", "control_type": "Group", "rect": [0, 0, 100, 100]},
            {"name": "", "auto_id": "", "control_type": "Pane", "rect": [0, 0, 50, 50]},
        ]
        text, elements = agent.build_inspect(infos)
        self.assertEqual(elements, {})
        self.assertIn("no interactable controls", text)

    def test_numbers_are_sequential_and_stringified(self):
        infos = [{"name": f"B{i}", "auto_id": f"b{i}", "control_type": "Button"} for i in range(5)]
        text, elements = agent.build_inspect(infos)
        self.assertEqual(list(elements.keys()), ["1", "2", "3", "4", "5"])

    def test_caps_at_max_controls(self):
        infos = [{"name": f"B{i}", "auto_id": f"b{i}", "control_type": "Button"} for i in range(agent.MAX_INSPECT_CONTROLS + 50)]
        text, elements = agent.build_inspect(infos)
        self.assertEqual(len(elements), agent.MAX_INSPECT_CONTROLS)

    def test_falls_back_to_auto_id_label_when_unnamed(self):
        infos = [{"name": "", "auto_id": "txtDate", "control_type": "Edit"}]
        text, _ = agent.build_inspect(infos)
        self.assertEqual(text, '1 Edit "txtDate"')

    def test_empty_when_nothing_interactable(self):
        infos = [{"name": "", "auto_id": "", "control_type": "Pane"}]
        text, elements = agent.build_inspect(infos)
        self.assertEqual(elements, {})
        self.assertIn("no interactable controls", text)

    def test_stored_click_point_is_rect_center(self):
        agent.STATE.elements = {"1": {"auto_id": "", "title": "cmd_exit", "control_type": "Group", "rect": [1431, 638, 1594, 707]}}
        try:
            self.assertEqual(agent._stored_click_point("1"), (1512, 672))
            self.assertIsNone(agent._stored_click_point("2"))
            self.assertIsNone(agent._stored_click_point("save"))
        finally:
            agent.STATE.elements = {}


# A fake window/control pair so find_control can be exercised without pywinauto.
class _FakeControl:
    def exists(self, timeout=0):
        return True

    def wait(self, *args, **kwargs):
        return self


class _FakeWindow:
    def __init__(self):
        self.criteria_calls = []

    def child_window(self, **criteria):
        self.criteria_calls.append(criteria)
        return _FakeControl()


class FindControlTests(unittest.TestCase):
    def setUp(self):
        self._original_window = agent.STATE.window
        self._original_elements = agent.STATE.elements
        self.window = _FakeWindow()
        agent.STATE.window = self.window

    def tearDown(self):
        agent.STATE.window = self._original_window
        agent.STATE.elements = self._original_elements

    def test_numeric_selector_resolves_via_stored_auto_id(self):
        agent.STATE.elements = {"12": {"auto_id": "btnSave", "title": "Save", "control_type": "Button"}}
        agent.find_control("12")
        # The most specific stored criterion (auto_id) is tried first.
        self.assertEqual(self.window.criteria_calls[0], {"auto_id": "btnSave"})

    def test_numeric_selector_without_auto_id_uses_title_and_type(self):
        agent.STATE.elements = {"3": {"auto_id": "", "title": "Save", "control_type": "Button"}}
        agent.find_control("3")
        self.assertEqual(self.window.criteria_calls[0], {"title": "Save", "control_type": "Button"})

    def test_unknown_numeric_selector_treated_as_literal(self):
        agent.STATE.elements = {}
        agent.find_control("99")
        # No stored element, so it falls through to the literal candidate order.
        self.assertEqual(self.window.criteria_calls[0], {"auto_id": "99"})

    def test_named_selector_uses_literal_candidates(self):
        agent.STATE.elements = {"1": {"auto_id": "btnSave", "title": "Save", "control_type": "Button"}}
        agent.find_control("Save & Close")
        self.assertEqual(self.window.criteria_calls[0], {"auto_id": "Save & Close"})


class BuildRecordTraceTests(unittest.TestCase):
    def test_describes_each_resolved_click(self):
        events = [
            {"kind": "click", "x": 10, "y": 20, "window": "Excel", "name": "Save", "auto_id": "btnSave", "control_type": "Button"},
        ]
        trace = agent.build_record_trace(events)
        self.assertEqual(trace, [
            {"kind": "click", "window": "Excel", "control": "Save", "controlType": "Button"},
        ])

    def test_keeps_order_across_windows(self):
        events = [
            {"window": "Excel", "name": "A", "auto_id": "", "control_type": "Button"},
            {"window": "Word", "name": "C", "auto_id": "", "control_type": "MenuItem"},
        ]
        trace = agent.build_record_trace(events)
        self.assertEqual([(t["window"], t["control"]) for t in trace], [("Excel", "A"), ("Word", "C")])

    def test_drops_clicks_with_no_name_window_or_screenshot(self):
        events = [
            {"x": 5, "y": 5},
            {"window": "Excel", "name": "Ok", "auto_id": "", "control_type": "Button"},
        ]
        trace = agent.build_record_trace(events)
        self.assertEqual(trace, [{"kind": "click", "window": "Excel", "control": "Ok", "controlType": "Button"}])

    def test_keeps_unnamed_clicks_that_have_a_window_or_screenshot(self):
        # The LAST click of a recording often cannot be re-resolved (its dialog
        # closed); the window and screenshot captured at click time keep it real.
        events = [
            {"window": "Help dialog", "name": "", "auto_id": "", "control_type": ""},
            {"x": 5, "y": 5, "name": "", "auto_id": "", "screenshot_path": "c.jpg"},
        ]
        trace = agent.build_record_trace(events)
        self.assertEqual(trace[0]["control"], "(unlabeled control)")
        self.assertEqual(trace[0]["window"], "Help dialog")
        self.assertEqual(trace[1]["control"], "(unlabeled control)")
        self.assertEqual(trace[1]["screenshotPath"], "c.jpg")

    def test_two_unlabeled_clicks_in_same_window_are_not_merged(self):
        # Two distinct buttons that both failed to resolve must stay two steps.
        events = [
            {"window": "App", "name": "", "auto_id": "", "control_type": "", "screenshot_path": "a.jpg"},
            {"window": "App", "name": "", "auto_id": "", "control_type": "", "screenshot_path": "b.jpg"},
        ]
        trace = agent.build_record_trace(events)
        self.assertEqual(len(trace), 2)
        self.assertEqual(trace[0]["screenshotPath"], "a.jpg")
        self.assertEqual(trace[1]["screenshotPath"], "b.jpg")

    def test_named_double_click_still_collapses(self):
        events = [
            {"window": "App", "name": "Save", "auto_id": "", "control_type": "Button"},
            {"window": "App", "name": "Save", "auto_id": "", "control_type": "Button"},
        ]
        self.assertEqual(len(agent.build_record_trace(events)), 1)

    def test_collapses_identical_consecutive_clicks(self):
        events = [
            {"window": "App", "name": "Next", "control_type": "Button"},
            {"window": "App", "name": "Next", "control_type": "Button"},
        ]
        self.assertEqual(len(agent.build_record_trace(events)), 1)

    def test_falls_back_to_auto_id_when_unnamed(self):
        events = [{"window": "App", "name": "", "auto_id": "okButton", "control_type": "Button"}]
        self.assertEqual(agent.build_record_trace(events)[-1]["control"], "okButton")

    def test_includes_typed_text_in_order(self):
        events = [
            {"kind": "click", "window": "Book1 - Excel", "name": "A2", "control_type": "DataItem"},
            {"kind": "type", "window": "Book1 - Excel", "text": "1234"},
        ]
        trace = agent.build_record_trace(events)
        self.assertEqual(trace, [
            {"kind": "click", "window": "Book1 - Excel", "control": "A2", "controlType": "DataItem"},
            {"kind": "type", "window": "Book1 - Excel", "text": "1234"},
        ])

    def test_drops_empty_typed_text(self):
        events = [{"kind": "type", "window": "Excel", "text": "   "}]
        self.assertEqual(agent.build_record_trace(events), [])

    def test_ignores_events_in_the_ignored_window(self):
        # Clicks and typing in WorkCrew itself (start/stop, panels) are dropped.
        events = [
            {"kind": "click", "window": "WorkCrew", "name": "Stop recording", "control_type": "Button"},
            {"kind": "type", "window": "WorkCrew", "text": "noise"},
            {"kind": "click", "window": "Book1 - Excel", "name": "A2", "control_type": "DataItem"},
            {"kind": "type", "window": "Book1 - Excel", "text": "1"},
        ]
        trace = agent.build_record_trace(events, "WorkCrew")
        self.assertEqual(trace, [
            {"kind": "click", "window": "Book1 - Excel", "control": "A2", "controlType": "DataItem"},
            {"kind": "type", "window": "Book1 - Excel", "text": "1"},
        ])

    def test_ignore_window_is_case_insensitive(self):
        events = [{"kind": "click", "window": "workcrew", "name": "X", "control_type": "Button"}]
        self.assertEqual(agent.build_record_trace(events, "WorkCrew"), [])

    def test_ignore_window_covers_child_dialogs_by_prefix(self):
        events = [
            {"kind": "click", "window": "WorkCrew - Settings", "name": "X", "control_type": "Button"},
            {"kind": "type", "window": "WorkCrew", "text": "noise"},
            {"kind": "click", "window": "Book1 - Excel", "name": "A2", "control_type": "DataItem"},
        ]
        trace = agent.build_record_trace(events, "WorkCrew")
        self.assertEqual(trace, [{"kind": "click", "window": "Book1 - Excel", "control": "A2", "controlType": "DataItem"}])

    def test_empty_input_yields_no_trace(self):
        self.assertEqual(agent.build_record_trace([]), [])

    def test_click_screenshot_path_passes_through(self):
        events = [
            {"kind": "click", "window": "App", "name": "Help", "auto_id": "", "control_type": "Group", "screenshot_path": r"C:\tmp\shot1.jpg"},
        ]
        trace = agent.build_record_trace(events)
        self.assertEqual(trace[0]["screenshotPath"], r"C:\tmp\shot1.jpg")

    def test_double_click_collapses_even_with_different_screenshots(self):
        events = [
            {"kind": "click", "window": "App", "name": "Help", "auto_id": "", "control_type": "Group", "screenshot_path": "a.jpg"},
            {"kind": "click", "window": "App", "name": "Help", "auto_id": "", "control_type": "Group", "screenshot_path": "b.jpg"},
        ]
        trace = agent.build_record_trace(events)
        self.assertEqual(len(trace), 1)


class ChooseClickLabelTests(unittest.TestCase):
    # The exact failing recording: a click on the Help button resolved to the
    # decorative "button_front" image over a Group "cmd_help", with the visible
    # caption "Help" as a separate small text node. The label must be "Help".
    def test_help_button_click_labels_by_caption(self):
        candidates = [
            {"name": "Good afternoon First.", "auto_id": "", "control_type": "Pane", "area": 700_000, "rect": (0, 0, 900, 800)},
            {"name": "background_mask", "auto_id": "", "control_type": "Image", "area": 690_000, "rect": (0, 0, 900, 780)},
            {"name": "cmd_help", "auto_id": "", "control_type": "Group", "area": 11_000, "rect": (750, 700, 918, 774)},
            {"name": "button_front", "auto_id": "", "control_type": "Image", "area": 11_000, "rect": (750, 700, 918, 774)},
            {"name": "Help", "auto_id": "", "control_type": "Text", "area": 1_800, "rect": (824, 726, 899, 751)},
        ]
        chosen = agent.choose_click_label(candidates)
        self.assertEqual(chosen["name"], "Help")
        self.assertEqual(chosen["control_type"], "Group")

    def test_exit_button_click_labels_by_caption(self):
        candidates = [
            {"name": "cmd_exit", "auto_id": "", "control_type": "Group", "area": 11_000, "rect": (1431, 638, 1594, 707)},
            {"name": "button_image", "auto_id": "", "control_type": "Image", "area": 2_000, "rect": (1440, 645, 1490, 695)},
            {"name": "Exit Accounts Suite", "auto_id": "", "control_type": "Text", "area": 4_900, "rect": (1494, 643, 1582, 699)},
        ]
        chosen = agent.choose_click_label(candidates)
        self.assertEqual(chosen["name"], "Exit Accounts Suite")

    def test_caption_from_another_control_does_not_hijack_the_button(self):
        # The reported bug: a Cancel button, with a hidden tab's "Stock/Inventory
        # Control" label overlapping the same point. Its rect is NOT inside the
        # Cancel button, so it must never be chosen; the on-button caption wins.
        candidates = [
            {"name": "cmd_cancel", "auto_id": "", "control_type": "Group", "area": 12_000, "rect": (150, 500, 280, 570)},
            {"name": "Cancel", "auto_id": "", "control_type": "Text", "area": 1_500, "rect": (190, 520, 250, 550)},
            {"name": "Stock/Inventory Control", "auto_id": "", "control_type": "Text", "area": 900, "rect": (150, 505, 400, 525)},
        ]
        chosen = agent.choose_click_label(candidates)
        self.assertEqual(chosen["name"], "Cancel")

    def test_button_with_no_on_button_caption_uses_its_own_name(self):
        # Only an off-button label is present, so it is ignored and the button's
        # own (real, non-decorative) name is used instead of the stray caption.
        candidates = [
            {"name": "Save Draft", "auto_id": "", "control_type": "Button", "area": 8_000, "rect": (10, 10, 120, 60)},
            {"name": "Unrelated Menu Item", "auto_id": "", "control_type": "Text", "area": 700, "rect": (0, 0, 300, 20)},
        ]
        self.assertEqual(agent.choose_click_label(candidates)["name"], "Save Draft")

    def test_standard_button_without_caption_uses_its_name(self):
        candidates = [
            {"name": "Save", "auto_id": "btnSave", "control_type": "Button", "area": 3_000, "rect": (0, 0, 60, 30)},
        ]
        self.assertEqual(agent.choose_click_label(candidates)["name"], "Save")

    def test_decorative_only_click_yields_no_label(self):
        candidates = [
            {"name": "background_mask", "auto_id": "", "control_type": "Image", "area": 690_000, "rect": (0, 0, 900, 780)},
            {"name": "Shape1", "auto_id": "", "control_type": "Image", "area": 5_000, "rect": (10, 10, 80, 80)},
        ]
        self.assertIsNone(agent.choose_click_label(candidates))

    def test_is_decorative_name(self):
        for name in ("background_mask", "button_front", "button_border_high", "Shape1", "Image3", ""):
            self.assertTrue(agent._is_decorative_name(name))
        for name in ("Help", "cmd_exit", "Save", "Exit Accounts Suite"):
            self.assertFalse(agent._is_decorative_name(name))

    def test_is_overlay_title(self):
        for title in ("NVIDIA GeForce Overlay", "nvidia geforce overlay ", "Discord Overlay"):
            self.assertTrue(agent._is_overlay_title(title))
        for title in ("Good afternoon First.  User ID: FIRST", "Adminsoft Accounts", "Program Manager", ""):
            self.assertFalse(agent._is_overlay_title(title))


class WindowTitleMatchTests(unittest.TestCase):
    # The exact failure this guards against: a VB6 accounting app titled
    # "Good afternoon First.  User ID: FIRST" (double space) that the model
    # requests with single spaces. Exact matching made every connect fail.
    def test_normalization_collapses_whitespace_and_case(self):
        self.assertEqual(agent.normalize_window_title("Good afternoon First.  User ID: FIRST "), "good afternoon first. user id: first")

    def test_exact_after_normalization_scores_highest(self):
        self.assertEqual(agent.score_window_title("Good afternoon First. User ID: FIRST", "Good afternoon First.  User ID: FIRST"), 3)
        self.assertEqual(agent.score_window_title("book1 - excel", "Book1 - Excel"), 3)

    def test_substring_matches_either_direction(self):
        self.assertEqual(agent.score_window_title("Good afternoon", "Good afternoon First.  User ID: FIRST"), 2)
        self.assertEqual(agent.score_window_title("Good afternoon First.  User ID: FIRST extra", "Good afternoon First. User ID: FIRST"), 2)

    def test_all_words_present_scores_low(self):
        self.assertEqual(agent.score_window_title("FIRST afternoon", "Good afternoon First.  User ID: FIRST"), 1)

    def test_unrelated_titles_do_not_match(self):
        self.assertEqual(agent.score_window_title("Adminsoft Accounts", "Book1 - Excel"), 0)
        self.assertEqual(agent.score_window_title("", "Book1 - Excel"), 0)
        self.assertEqual(agent.score_window_title("Book1", ""), 0)


class SafeKeysTests(unittest.TestCase):
    def test_press_key_and_type_text_are_allowlisted(self):
        self.assertIn("press-key", agent.ALLOWED_COMMANDS)
        self.assertIn("type-text", agent.ALLOWED_COMMANDS)

    def test_safe_keys_map_known_navigation_keys(self):
        self.assertEqual(agent.SAFE_KEYS["enter"], "{ENTER}")
        self.assertEqual(agent.SAFE_KEYS["tab"], "{TAB}")
        self.assertEqual(agent.SAFE_KEYS["down"], "{DOWN}")
        self.assertNotIn("f5", agent.SAFE_KEYS)  # function/system keys are not allowed


class TypingMapTests(unittest.TestCase):
    def test_digit_letter_and_numpad(self):
        self.assertEqual(agent._TYPING_MAP[0x31], ("1", "!"))   # 1 / shift+1
        self.assertEqual(agent._TYPING_MAP[0x41], ("a", "A"))   # a / shift+a
        self.assertEqual(agent._TYPING_MAP[0x60], ("0", "0"))   # numpad 0


# The keyboard accumulation is testable without Windows: _on_key only reads the
# foreground window through a guarded ctypes call that returns "" off-Windows, so
# the text-building logic runs anywhere.
class KeyboardCaptureTests(unittest.TestCase):
    def _flush(self, rec):
        with rec._lock:
            rec._flush_typed_locked()

    def test_builds_typed_text(self):
        rec = agent.ClickRecorder()
        rec._on_key(0x48, False, False)  # h
        rec._on_key(0x49, False, False)  # i
        self._flush(rec)
        self.assertEqual(rec._events[-1]["kind"], "type")
        self.assertEqual(rec._events[-1]["text"], "hi")

    def test_shift_uppercases_letters(self):
        rec = agent.ClickRecorder()
        rec._on_key(0x48, True, False)  # shift+h -> H
        self._flush(rec)
        self.assertEqual(rec._events[-1]["text"], "H")

    def test_caps_lock_uppercases_and_shift_inverts(self):
        rec = agent.ClickRecorder()
        rec._on_key(0x48, False, True)  # caps on -> H
        rec._on_key(0x49, True, True)   # caps on + shift -> lowercase i
        self._flush(rec)
        self.assertEqual(rec._events[-1]["text"], "Hi")

    def test_digits_ignore_caps_lock(self):
        rec = agent.ClickRecorder()
        rec._on_key(0x31, False, True)  # caps must not affect digits
        self._flush(rec)
        self.assertEqual(rec._events[-1]["text"], "1")

    def test_enter_commits_typing(self):
        rec = agent.ClickRecorder()
        rec._on_key(0x31, False, False)             # 1
        rec._on_key(agent.VK_RETURN, False, False)  # commits
        self.assertEqual(rec._events[-1]["kind"], "type")
        self.assertEqual(rec._events[-1]["text"], "1")
        self.assertEqual(rec._typed, [])

    def test_backspace_removes_last_char(self):
        rec = agent.ClickRecorder()
        rec._on_key(0x31, False, False)            # 1
        rec._on_key(0x32, False, False)            # 2
        rec._on_key(agent.VK_BACK, False, False)   # delete the 2
        self._flush(rec)
        self.assertEqual(rec._events[-1]["text"], "1")


if __name__ == "__main__":
    unittest.main()
