from __future__ import annotations

import argparse
import hmac
import json
import os
import re
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from pywinauto import Application, Desktop


MAX_BODY_BYTES = 64 * 1024
MAX_TEXT_LENGTH = 10_000
ALLOWED_COMMANDS = {
    "list-windows",
    "connect",
    "inspect",
    "click",
    "set-text",
    "type-keys",
    "get-text",
    "screenshot",
}


class AgentState:
    def __init__(self) -> None:
        self.application: Application | None = None
        self.window: Any = None
        self.lock = threading.RLock()


STATE = AgentState()


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
            continue
    return json.dumps(windows[:100], ensure_ascii=True)


def connect_window(title: str) -> str:
    with STATE.lock:
        application = Application(backend="uia").connect(title=title, timeout=10)
        window = application.window(title=title)
        window.wait("exists visible ready", timeout=10)
        STATE.application = application
        STATE.window = window
    return f"Connected to {title}"


def require_window() -> Any:
    if STATE.window is None:
        raise ValueError("Connect to a window first")
    return STATE.window


def find_control(selector: str) -> Any:
    window = require_window()
    control = window.child_window(auto_id=selector)
    if not control.exists(timeout=1):
        control = window.child_window(title=selector)
    control.wait("exists visible enabled ready", timeout=10)
    return control


def inspect_window() -> str:
    window = require_window()
    controls: list[dict[str, str]] = []
    for control in window.descendants()[:500]:
        try:
            info = control.element_info
            controls.append({
                "name": str(info.name or "")[:500],
                "auto_id": str(info.automation_id or "")[:500],
                "control_type": str(info.control_type or "")[:100],
            })
        except Exception:
            continue
    return json.dumps(controls, ensure_ascii=True)


def execute_action(action: dict[str, Any]) -> str:
    command = action["command"]
    if command == "list-windows":
        return list_windows()
    if command == "connect":
        return connect_window(require_text(action.get("windowTitle"), "windowTitle"))

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
            if re.search(r"[{}]", value):
                raise ValueError("Special key sequences are not allowed")
            control.type_keys(value, with_spaces=True, set_foreground=True)
            return f"Typed into control {selector}"
        if command == "get-text":
            return str(control.window_text())[:MAX_TEXT_LENGTH]
    raise ValueError("Unsupported action")


def create_handler(expected_token: str) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "WorkCrewWindowsAgent/0.1"

        def log_message(self, format_string: str, *args: Any) -> None:
            return

        def send_json(self, status: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.send_header("cache-control", "no-store")
            self.send_header("x-content-type-options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self) -> None:
            if self.path != "/action":
                self.send_json(404, {"ok": False, "error": "Not found"})
                return
            supplied = self.headers.get("authorization", "")
            if not hmac.compare_digest(supplied, f"Bearer {expected_token}"):
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
                self.send_json(400, {"ok": False, "error": str(error)})
            except Exception:
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
