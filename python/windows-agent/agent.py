from __future__ import annotations

import argparse
import ctypes
import hmac
import json
import os
import re
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

# Note on imports: pywinauto is imported lazily inside the handler functions
# that actually drive the desktop (see _load_pywinauto). This keeps the pure
# validation and request handling logic importable without the package present,
# so the unit tests can run under plain pytest with only the standard library.
# Runtime behavior is unchanged when pywinauto is installed.


MAX_BODY_BYTES = 64 * 1024
MAX_TEXT_LENGTH = 10_000
CONTROL_WAIT_TIMEOUT = 10
CONTROL_PROBE_TIMEOUT = 1
ALLOWED_COMMANDS = {
    "list-windows",
    "connect",
    "inspect",
    "click",
    "set-text",
    "type-keys",
    "get-text",
    "screenshot",
    "record-start",
    "record-stop",
}

# Control types the model can actually act on. inspect returns only these, which
# drops decorative and layout nodes (panes, groups, separators, images, plain
# static text) that a full UI Automation tree dump is mostly made of. Sending
# only interactable controls is the single biggest per-snapshot token saving and
# also makes the snapshot easier for the model to reason about.
INTERACTABLE_CONTROL_TYPES = frozenset({
    "Button",
    "CheckBox",
    "ComboBox",
    "Edit",
    "Document",
    "Hyperlink",
    "ListItem",
    "MenuItem",
    "RadioButton",
    "TabItem",
    "TreeItem",
    "Slider",
    "Spinner",
    "SplitButton",
    "DataItem",
    "HeaderItem",
    "Custom",
})

# Most interactable controls the model needs in one window. Bounds the snapshot
# size; the rare window with more controls is still navigable because the model
# can act on what it sees and re-inspect after the view changes.
MAX_INSPECT_CONTROLS = 200

# Click recording. The recorder polls the left mouse button and cursor position
# rather than installing a low-level Windows hook, so it needs no message pump
# and no extra dependency (just ctypes from the standard library). On each new
# press it resolves the UI Automation element under the cursor, so a recorded
# session replays by control name, never by screen coordinates.
VK_LBUTTON = 0x01
RECORD_POLL_SECONDS = 0.02          # ~50 Hz: responsive without busy-spinning.
RECORD_MAX_EVENTS = 500             # Caps memory and replay length.
RECORD_MAX_SECONDS = 20 * 60        # Safety stop so a forgotten session ends.


class AgentState:
    def __init__(self) -> None:
        self.application: Any = None
        self.window: Any = None
        # Maps the short numeric id shown in the last inspect output to the
        # concrete selector criteria for that control, so a later "click 12"
        # resolves to the real element. Reset whenever the window changes.
        self.elements: dict[str, dict[str, str]] = {}
        # The active click recorder, if a record-start is in progress.
        self.recorder: Any = None
        self.lock = threading.RLock()


STATE = AgentState()


def _load_pywinauto() -> Any:
    # Imported lazily so the module can be imported for validation and tests
    # without pywinauto installed. When the helper actually runs on Windows the
    # package is present and this returns the live module objects.
    from pywinauto import Application, Desktop

    return Application, Desktop


def require_text(value: Any, field: str, maximum: int = 500) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} is required")
    if len(value) > maximum:
        raise ValueError(f"{field} is too long")
    return value.strip()


def optional_text(value: Any, maximum: int = 500) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > maximum:
        raise ValueError("Invalid text value")
    return value


def validate_action(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("Action must be an object")
    permitted = {"kind", "command", "application", "windowTitle", "control", "value"}
    if set(value) - permitted:
        raise ValueError("Action contains unsupported fields")
    if value.get("kind") != "windows":
        raise ValueError("Invalid action kind")
    command = value.get("command")
    if command not in ALLOWED_COMMANDS:
        raise ValueError("Unsupported Windows command")
    result = {
        "kind": "windows",
        "command": command,
        "application": optional_text(value.get("application"), 260),
        "windowTitle": optional_text(value.get("windowTitle"), 500),
        "control": optional_text(value.get("control"), 500),
        "value": optional_text(value.get("value"), MAX_TEXT_LENGTH),
    }
    return result


def list_windows() -> str:
    _, Desktop = _load_pywinauto()
    windows: list[dict[str, Any]] = []
    for window in Desktop(backend="uia").windows():
        try:
            title = window.window_text().strip()
            if not title or not window.is_visible():
                continue
            rectangle = window.rectangle()
            windows.append({
                "title": title[:500],
                "type": window.element_info.control_type,
                "rectangle": [rectangle.left, rectangle.top, rectangle.right, rectangle.bottom],
            })
        except Exception:
            # A single inaccessible window must never abort the whole listing.
            continue
    return json.dumps(windows[:100], ensure_ascii=True)


def connect_window(title: str) -> str:
    Application, _ = _load_pywinauto()
    with STATE.lock:
        application = Application(backend="uia").connect(title=title, timeout=10)
        window = application.window(title=title)
        window.wait("exists visible ready", timeout=10)
        STATE.application = application
        STATE.window = window
        # A new window invalidates any numbered controls from a prior inspect.
        STATE.elements = {}
    return f"Connected to {title}"


def require_window() -> Any:
    if STATE.window is None:
        raise ValueError("Connect to a window first")
    return STATE.window


def find_control(selector: str) -> Any:
    # Try the most specific and stable selectors first, then fall back to
    # progressively looser matches. Each candidate gets a short bounded probe so
    # a missing control does not stall on the full wait timeout. The selector is
    # plain text supplied by the caller, never code, so no candidate can do more
    # than name a control to locate.
    window = require_window()
    # A numeric selector refers to a control numbered in the last inspect. Resolve
    # it to the concrete criteria recorded then, most specific first. Any other
    # selector is treated as a literal name/auto_id/type, so the model can still
    # reference controls by name and older callers keep working.
    stored = STATE.elements.get(selector) if selector.isdigit() else None
    if stored is not None:
        candidates = []
        if stored.get("auto_id"):
            candidates.append({"auto_id": stored["auto_id"]})
        if stored.get("title") and stored.get("control_type"):
            candidates.append({"title": stored["title"], "control_type": stored["control_type"]})
        if stored.get("title"):
            candidates.append({"title": stored["title"]})
        if not candidates:
            candidates = [{"best_match": selector}]
    else:
        candidates = [
            {"auto_id": selector},
            {"title": selector},
            {"control_type": selector},
            {"best_match": selector},
        ]
    for criteria in candidates:
        try:
            control = window.child_window(**criteria)
            if control.exists(timeout=CONTROL_PROBE_TIMEOUT):
                control.wait("exists visible enabled ready", timeout=CONTROL_WAIT_TIMEOUT)
                return control
        except Exception:
            # An unusable criterion (for example a value that is not a known
            # control type) should fall through to the next candidate rather
            # than surface as an internal error.
            continue
    raise ValueError("Control not found")


def build_inspect(infos: list[dict[str, str]]) -> tuple[str, dict[str, dict[str, str]]]:
    """Turn raw control descriptions into the compact, numbered snapshot the model
    sees, plus the id->selector map used to resolve a later action.

    Pure and side-effect free so it can be unit tested without pywinauto. Each
    kept control becomes one line like ``12 Button "Save & Close"``; decorative
    and unnamed nodes are dropped. The returned map lets find_control turn the
    number back into auto_id/title criteria.
    """
    elements: dict[str, dict[str, str]] = {}
    lines: list[str] = []
    next_id = 1
    for info in infos:
        control_type = (info.get("control_type") or "").strip()
        name = (info.get("name") or "").strip()
        auto_id = (info.get("auto_id") or "").strip()
        if control_type not in INTERACTABLE_CONTROL_TYPES:
            continue
        # A genuinely actionable control almost always has a name or an
        # automation id; requiring one filters out anonymous filler that shares
        # an interactable type (blank custom panes, unlabeled list rows).
        if not name and not auto_id:
            continue
        identifier = str(next_id)
        elements[identifier] = {"auto_id": auto_id, "title": name, "control_type": control_type}
        label = name or auto_id
        lines.append(f'{identifier} {control_type} "{label[:200]}"')
        next_id += 1
        if next_id > MAX_INSPECT_CONTROLS:
            break
    text = "\n".join(lines) if lines else "(no interactable controls found on this screen)"
    return text, elements


class _POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


def _cursor_point() -> tuple[int, int]:
    point = _POINT()
    ctypes.windll.user32.GetCursorPos(ctypes.byref(point))  # type: ignore[attr-defined]
    return int(point.x), int(point.y)


def _resolve_element(x: int, y: int) -> dict[str, str] | None:
    """Resolve the UI Automation element under a screen point to a stable
    description (window title, control name, automation id, control type). Returns
    None if nothing usable is there, so an unresolved click is simply dropped from
    the recording rather than recorded as a fragile coordinate."""
    try:
        _, Desktop = _load_pywinauto()
        element = Desktop(backend="uia").from_point(x, y)
        info = element.element_info
        try:
            window = str(element.top_level_parent().window_text() or "")
        except Exception:
            window = ""
        return {
            "window": window[:500],
            "name": str(info.name or "")[:500],
            "auto_id": str(info.automation_id or "")[:500],
            "control_type": str(info.control_type or "")[:100],
        }
    except Exception:
        return None


class ClickRecorder:
    """Records the user's left clicks by polling the mouse button and cursor. On
    each new press it resolves the element under the cursor on a worker thread, so
    the recording is a list of named controls that can be replayed deterministically.

    The capture loop touches only ctypes and pywinauto, never AgentState, so it
    needs no lock and cannot deadlock with the request handler."""

    def __init__(self) -> None:
        self._events: list[dict[str, Any]] = []
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()

    def start(self) -> None:
        self._thread = threading.Thread(target=self._loop, name="wc-click-recorder", daemon=True)
        self._thread.start()

    def stop(self) -> list[dict[str, Any]]:
        self._stop.set()
        thread = self._thread
        if thread is not None:
            thread.join(timeout=3)
        with self._lock:
            return list(self._events)

    def _loop(self) -> None:
        started = time.monotonic()
        user32 = ctypes.windll.user32  # type: ignore[attr-defined]
        # Prime the previous state from the live button so a click already held
        # when recording begins is not captured as a fresh press.
        was_down = bool(user32.GetAsyncKeyState(VK_LBUTTON) & 0x8000)
        while not self._stop.is_set():
            if time.monotonic() - started > RECORD_MAX_SECONDS:
                break
            is_down = bool(user32.GetAsyncKeyState(VK_LBUTTON) & 0x8000)
            if is_down and not was_down:
                self._capture(*_cursor_point())
            was_down = is_down
            time.sleep(RECORD_POLL_SECONDS)

    def _capture(self, x: int, y: int) -> None:
        with self._lock:
            if len(self._events) >= RECORD_MAX_EVENTS:
                return
        resolved = _resolve_element(x, y)
        event: dict[str, Any] = {"x": x, "y": y}
        if resolved:
            event.update(resolved)
        with self._lock:
            self._events.append(event)


def build_record_steps(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Turn recorded click events into replayable Windows automation actions.

    Pure and side-effect free so it can be unit tested without pywinauto or a
    desktop. A click becomes a step only if its element resolved to a stable name
    or automation id; unresolved clicks are dropped (replay never uses screen
    coordinates). A connect step is emitted whenever the target window changes, so
    replay reconnects before clicking controls that live in a different window.
    """
    steps: list[dict[str, Any]] = []
    current_window: str | None = None
    for event in events:
        window = (event.get("window") or "").strip()
        name = (event.get("name") or "").strip()
        auto_id = (event.get("auto_id") or "").strip()
        control = name or auto_id
        if not control:
            continue
        if window and window != current_window:
            steps.append({"kind": "windows", "command": "connect", "windowTitle": window})
            current_window = window
        step: dict[str, Any] = {"kind": "windows", "command": "click", "control": control}
        if window:
            step["windowTitle"] = window
        steps.append(step)
    return steps


def inspect_window() -> str:
    window = require_window()
    infos: list[dict[str, str]] = []
    for control in window.descendants()[:500]:
        try:
            info = control.element_info
            infos.append({
                "name": str(info.name or "")[:500],
                "auto_id": str(info.automation_id or "")[:500],
                "control_type": str(info.control_type or "")[:100],
            })
        except Exception:
            # Skip any descendant that cannot be read instead of failing inspect.
            continue
    text, elements = build_inspect(infos)
    # Already called under STATE.lock from execute_action; record the id map so a
    # following click/set-text/get-text can resolve a numbered reference.
    STATE.elements = elements
    return text


def execute_action(action: dict[str, Any]) -> str:
    command = action["command"]
    if command == "list-windows":
        return list_windows()
    if command == "connect":
        return connect_window(require_text(action.get("windowTitle"), "windowTitle"))
    if command == "record-start":
        with STATE.lock:
            if STATE.recorder is not None:
                return "Recording is already in progress"
            recorder = ClickRecorder()
            STATE.recorder = recorder
        recorder.start()
        return "Recording started"
    if command == "record-stop":
        with STATE.lock:
            recorder = STATE.recorder
            STATE.recorder = None
        if recorder is None:
            return json.dumps([], ensure_ascii=True)
        events = recorder.stop()
        return json.dumps(build_record_steps(events), ensure_ascii=True)

    with STATE.lock:
        if command == "inspect":
            return inspect_window()
        if command == "screenshot":
            image = require_window().capture_as_image()
            output = Path(tempfile.gettempdir()) / f"workcrew-window-{os.getpid()}.png"
            image.save(output)
            return str(output)

        selector = require_text(action.get("control"), "control")
        control = find_control(selector)
        if command == "click":
            control.click_input()
            return f"Clicked control {selector}"
        if command == "set-text":
            value = optional_text(action.get("value"), MAX_TEXT_LENGTH) or ""
            control.set_edit_text(value)
            return f"Updated control {selector}"
        if command == "type-keys":
            value = optional_text(action.get("value"), MAX_TEXT_LENGTH) or ""
            # pywinauto's type_keys interprets braces as special key sequences
            # (for example {ENTER}, {VK_LWIN}, modifier chords). Rejecting any
            # brace keeps model supplied text from triggering arbitrary key
            # chords or hotkeys, so typing can only ever produce literal text.
            if re.search(r"[{}]", value):
                raise ValueError("Special key sequences are not allowed")
            control.type_keys(value, with_spaces=True, set_foreground=True)
            return f"Typed into control {selector}"
        if command == "get-text":
            return str(control.window_text())[:MAX_TEXT_LENGTH]
    raise ValueError("Unsupported action")


def create_handler(expected_token: str) -> type[BaseHTTPRequestHandler]:
    expected_authorization = f"Bearer {expected_token}"

    class Handler(BaseHTTPRequestHandler):
        server_version = "WorkCrewWindowsAgent/0.1"

        def log_message(self, format_string: str, *args: Any) -> None:
            # Logging is suppressed so request details (including any text
            # payloads) never reach stdout or stderr.
            return

        def authorized(self) -> bool:
            supplied = self.headers.get("authorization", "")
            # Constant-time compare avoids leaking the token through timing.
            return hmac.compare_digest(supplied, expected_authorization)

        def send_json(self, status: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.send_header("cache-control", "no-store")
            self.send_header("x-content-type-options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            if self.path != "/health":
                self.send_json(404, {"ok": False, "error": "Not found"})
                return
            if not self.authorized():
                self.send_json(401, {"ok": False, "error": "Unauthorized"})
                return
            self.send_json(200, {"ok": True})

        def do_POST(self) -> None:
            if self.path != "/action":
                self.send_json(404, {"ok": False, "error": "Not found"})
                return
            if not self.authorized():
                self.send_json(401, {"ok": False, "error": "Unauthorized"})
                return
            try:
                length = int(self.headers.get("content-length", "0"))
                if length <= 0 or length > MAX_BODY_BYTES:
                    raise ValueError("Invalid request size")
                body = self.rfile.read(length)
                action = validate_action(json.loads(body.decode("utf-8")))
                output = execute_action(action)
                self.send_json(200, {"ok": True, "output": output})
            except (ValueError, json.JSONDecodeError) as error:
                # Validation errors are safe to return: they describe the
                # request shape, not internal state.
                self.send_json(400, {"ok": False, "error": str(error)})
            except Exception:
                # Any other failure may carry internal detail (paths, library
                # internals), so return a generic message and keep the specifics
                # off the wire. Logging is suppressed, so nothing leaks anywhere.
                self.send_json(500, {"ok": False, "error": "The Windows action failed"})

    return Handler


def main() -> int:
    parser = argparse.ArgumentParser(description="WorkCrew local Windows automation helper")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--token", required=True)
    args = parser.parse_args()
    if args.host != "127.0.0.1":
        raise SystemExit("Only the local loopback address is allowed")
    if len(args.token) < 32:
        raise SystemExit("A strong launch token is required")
    server = ThreadingHTTPServer((args.host, args.port), create_handler(args.token))
    print(json.dumps({"port": server.server_port}), flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
