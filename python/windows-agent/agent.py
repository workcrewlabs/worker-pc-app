from __future__ import annotations

import argparse
import ctypes
import hmac
import json
import os
import queue
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

# Navigation and editing keys the model may send via press-key. These are plain,
# non-destructive keys (no system hotkeys, no modifier chords), so a spreadsheet
# or form can be navigated and confirmed (select a cell, type, press Enter) while
# type-keys still rejects arbitrary brace sequences and chords for safety.
SAFE_KEYS = {
    "enter": "{ENTER}",
    "tab": "{TAB}",
    "escape": "{ESC}",
    "esc": "{ESC}",
    "up": "{UP}",
    "down": "{DOWN}",
    "left": "{LEFT}",
    "right": "{RIGHT}",
    "home": "{HOME}",
    "end": "{END}",
    "pageup": "{PGUP}",
    "pagedown": "{PGDN}",
    "backspace": "{BACKSPACE}",
    "delete": "{DELETE}",
    "del": "{DELETE}",
    "space": "{SPACE}",
}

# pywinauto's type_keys treats ^ % + ~ ( ) { } as a keystroke language (Ctrl,
# Alt, Shift, Enter, grouping). To type a value EXACTLY as given, each of those
# characters is wrapped in braces, which pywinauto types as the literal
# character. This guarantees type-text and type-keys produce plain text only,
# never a hotkey or chord, and that values like "50% off" or "a+b" type verbatim.
_TYPE_KEYS_META = set("^%+~(){}")


def escape_for_type_keys(text: str) -> str:
    return "".join("{" + ch + "}" if ch in _TYPE_KEYS_META else ch for ch in text)
ALLOWED_COMMANDS = {
    "list-windows",
    "connect",
    "inspect",
    "click",
    "set-text",
    "type-keys",
    "type-text",
    "press-key",
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
    # Legacy business apps (VB6/Delphi and the like) draw their own buttons as
    # Group or Pane containers rather than real Buttons. These are only kept when
    # they look like a command (see build_inspect), so ordinary layout containers
    # are still filtered out.
    "Group",
    "Pane",
})

# Static text that is the caption of one of those custom buttons ("Exit Accounts
# Suite" drawn over a Group named cmd_exit). Used only to LABEL a button with the
# words the user actually sees; it is never itself an actionable control.
LABEL_CONTROL_TYPES = frozenset({"Text", "Static"})

# A control whose name is an internal identifier (cmd_exit, btnSave, Command1)
# rather than a human caption. When a custom button has one of these AND a visible
# text caption sits on top of it, the caption is shown to the model instead.
_INTERNAL_NAME_RE = re.compile(r"^(cmd|btn|button|command)[ _-]?", re.IGNORECASE)
_NO_SPACE_TOKEN_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*$")


def _looks_internal(name: str) -> bool:
    return bool(_INTERNAL_NAME_RE.match(name) or (_NO_SPACE_TOKEN_RE.match(name) and "_" in name))


def _rect_of(info: dict[str, Any]) -> list[int] | None:
    rect = info.get("rect")
    if isinstance(rect, (list, tuple)) and len(rect) == 4:
        try:
            return [int(rect[0]), int(rect[1]), int(rect[2]), int(rect[3])]
        except (TypeError, ValueError):
            return None
    return None


def _caption_over(rect: list[int], labels: list[tuple[str, list[int]]]) -> str:
    """The visible text whose center sits inside the given control rectangle, i.e.
    the caption drawn on a custom button. Empty when there is none."""
    for text, lr in labels:
        cx = (lr[0] + lr[2]) / 2
        cy = (lr[1] + lr[3]) / 2
        if rect[0] <= cx <= rect[2] and rect[1] <= cy <= rect[3]:
            return text
    return ""

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
VK_BACK = 0x08
VK_TAB = 0x09
VK_RETURN = 0x0D
VK_SHIFT = 0x10
VK_CONTROL = 0x11
VK_MENU = 0x12
VK_CAPITAL = 0x14
RECORD_POLL_SECONDS = 0.02          # ~50 Hz: responsive without busy-spinning.
RECORD_MAX_EVENTS = 400             # Caps memory; matches the summarize request limit.
RECORD_MAX_SECONDS = 20 * 60        # Safety stop so a forgotten session ends.
RECORD_MAX_TYPED = 1000             # Caps the length of one captured typing run.


def _build_typing_map() -> dict[int, tuple[str, str]]:
    """Map virtual-key codes to the (normal, shifted) character they produce, so
    polled key presses can be turned into the text the user typed. Covers digits,
    letters, the numpad, and common punctuation: enough to capture data entry like
    spreadsheet values without a full keyboard-layout engine."""
    mapping: dict[int, tuple[str, str]] = {}
    shifted_digits = ")!@#$%^&*("
    for vk in range(0x30, 0x3A):  # 0-9
        mapping[vk] = (chr(vk), shifted_digits[vk - 0x30])
    for vk in range(0x41, 0x5B):  # A-Z
        mapping[vk] = (chr(vk).lower(), chr(vk))
    for i in range(10):  # numpad 0-9
        mapping[0x60 + i] = (str(i), str(i))
    mapping[0x20] = (" ", " ")
    mapping[0x6E] = (".", ".")  # numpad decimal
    mapping[0x6B] = ("+", "+")  # numpad add
    mapping[0x6D] = ("-", "-")  # numpad subtract
    mapping[0x6F] = ("/", "/")  # numpad divide
    mapping[0xBA] = (";", ":")
    mapping[0xBB] = ("=", "+")
    mapping[0xBC] = (",", "<")
    mapping[0xBD] = ("-", "_")
    mapping[0xBE] = (".", ">")
    mapping[0xBF] = ("/", "?")
    mapping[0xC0] = ("`", "~")
    return mapping


_TYPING_MAP = _build_typing_map()


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


def normalize_window_title(value: str) -> str:
    """Collapse whitespace runs and casing so titles compare the way a person
    reads them. Real window titles carry double spaces and trailing blanks (the
    VB6-era apps this exists for are the worst offenders), and the model
    round-trips titles through text where that spacing does not survive."""
    return re.sub(r"\s+", " ", value).strip().lower()


def score_window_title(requested: str, actual: str) -> int:
    """How well an open window's title matches the requested one. 3 exact after
    normalization, 2 when one contains the other (a greeting title grows a
    suffix, or the model sends just the app name), 1 when every requested word
    appears in the title, 0 no match. Pure so it is unit testable."""
    wanted = normalize_window_title(requested)
    have = normalize_window_title(actual)
    if not wanted or not have:
        return 0
    if wanted == have:
        return 3
    if wanted in have or have in wanted:
        return 2
    have_words = set(have.split(" "))
    if all(word in have_words for word in wanted.split(" ")):
        return 1
    return 0


def resolve_window(requested: str) -> Any:
    """Find the best open window for a requested title. Exact matching is a trap
    here: titles drift (spacing, status suffixes) between list-windows and the
    connect that follows, so the lookup is normalized and fuzzy, preferring the
    strongest then shortest match."""
    _, Desktop = _load_pywinauto()
    best = None
    best_rank: tuple[int, int] | None = None
    for window in Desktop(backend="uia").windows():
        try:
            title = window.window_text()
            if not title or not title.strip() or not window.is_visible():
                continue
            score = score_window_title(requested, title)
            if score == 0:
                continue
            rank = (-score, len(title))
            if best_rank is None or rank < best_rank:
                best = window
                best_rank = rank
        except Exception:
            continue
    if best is None:
        raise ValueError(
            f'No open window matches "{requested}". Use list-windows to see the open windows and connect with one of those titles.'
        )
    return best


def connect_window(title: str) -> str:
    Application, _ = _load_pywinauto()
    with STATE.lock:
        # Resolve the title fuzzily, then attach by window HANDLE: the handle
        # identifies exactly the window that matched, no second title lookup
        # that could miss (or hit a different window with a similar name).
        resolved = resolve_window(title)
        handle = resolved.handle
        application = Application(backend="uia").connect(handle=handle, timeout=10)
        window = application.window(handle=handle)
        window.wait("exists visible ready", timeout=10)
        STATE.application = application
        STATE.window = window
        # A new window invalidates any numbered controls from a prior inspect.
        STATE.elements = {}
        actual = resolved.window_text().strip()[:200]
    return f"Connected to {actual}"


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
    and unnamed nodes are dropped. Custom-drawn buttons (Group/Pane containers)
    are labeled with the visible caption text sitting on top of them, so a button
    the user calls "Exit Accounts Suite" is shown by that name even though its
    real control name is an internal identifier like cmd_exit. The returned map
    lets find_control turn the number back into auto_id/title criteria, using the
    REAL identifier (never the cosmetic caption).
    """
    # Visible text captions with a rectangle, used to name custom buttons.
    labels: list[tuple[str, list[int]]] = []
    for info in infos:
        if (info.get("control_type") or "").strip() in LABEL_CONTROL_TYPES:
            text = (info.get("name") or "").strip()
            rect = _rect_of(info)
            if text and rect:
                labels.append((text[:200], rect))

    elements: dict[str, dict[str, str]] = {}
    lines: list[str] = []
    next_id = 1
    for info in infos:
        control_type = (info.get("control_type") or "").strip()
        name = (info.get("name") or "").strip()
        auto_id = (info.get("auto_id") or "").strip()
        if control_type not in INTERACTABLE_CONTROL_TYPES:
            continue
        rect = _rect_of(info)
        caption = _caption_over(rect, labels) if rect else ""
        # Group/Pane are only real controls when they behave like a button: a
        # caption drawn on them, or an internal command name (cmd_exit, btnSave).
        # This keeps ordinary layout containers out of the snapshot.
        if control_type in {"Group", "Pane"}:
            if not caption and not (name and _looks_internal(name)):
                continue
        elif not name and not auto_id:
            # Other interactable controls almost always carry a name or auto id;
            # requiring one filters anonymous filler (blank rows, spacer custom).
            continue
        # Show the human caption when the control's own name is an internal token;
        # otherwise the real name is already what the user sees.
        display = caption if (caption and (not name or _looks_internal(name))) else (name or auto_id)
        identifier = str(next_id)
        elements[identifier] = {"auto_id": auto_id, "title": name, "control_type": control_type, "rect": rect or []}
        lines.append(f'{identifier} {control_type} "{display[:200]}"')
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


def _stored_click_point(selector: str) -> tuple[int, int] | None:
    """The center of the rectangle recorded for a numbered control in the last
    inspect, used as a positional fallback when the control will not resolve by
    name. None when there is no usable rectangle."""
    stored = STATE.elements.get(selector) if selector.isdigit() else None
    if not stored:
        return None
    rect = stored.get("rect")
    if isinstance(rect, (list, tuple)) and len(rect) == 4:
        left, top, right, bottom = rect
        if right > left and bottom > top:
            return (int((left + right) / 2), int((top + bottom) / 2))
    return None


def _click_at(x: int, y: int) -> None:
    """Move the mouse to a screen point and left click there via pywinauto's
    input backend, so a custom-drawn button that ignores UIA still responds."""
    from pywinauto import mouse

    mouse.click(button="left", coords=(x, y))


def _foreground_window_title() -> str:
    """The title of the window currently in front, used to tag typed text with the
    app it went into (and to drop typing that happened in WorkCrew itself)."""
    try:
        user32 = ctypes.windll.user32  # type: ignore[attr-defined]
        hwnd = user32.GetForegroundWindow()
        if not hwnd:
            return ""
        length = int(user32.GetWindowTextLengthW(hwnd))
        buffer = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buffer, length + 1)
        return str(buffer.value or "")
    except Exception:
        return ""


# Names of the decorative image layers legacy apps stack to draw one button
# (background, borders, the icon, a front overlay). A click resolves to whichever
# of these is on top, so recording must look past them to the real button.
_DECORATIVE_NAME_RE = re.compile(
    r"^(background_mask|button_(background|border_\w+|front|image)|shape\d*|image\d*|picture\d*|label\d*)$",
    re.IGNORECASE,
)


def _is_decorative_name(name: str) -> bool:
    return not name or bool(_DECORATIVE_NAME_RE.match(name.strip()))


def choose_click_label(candidates: list[dict[str, Any]]) -> dict[str, str] | None:
    """Pick the human label for a click from the controls whose rectangle contains
    the clicked point. Prefers the visible caption text over an internal button id,
    and the smallest containing control over a big background. Pure so it can be
    unit tested. Each candidate: {name, auto_id, control_type, area}."""
    contained = [c for c in candidates if (c.get("area") or 0) > 0]
    captions = sorted(
        [c for c in contained
         if (c.get("control_type") or "") in LABEL_CONTROL_TYPES and (c.get("name") or "").strip()],
        key=lambda c: c["area"],
    )
    buttons = sorted(
        [c for c in contained
         if (c.get("control_type") or "") in INTERACTABLE_CONTROL_TYPES
         and (c.get("control_type") or "") != "Window"
         and not _is_decorative_name((c.get("name") or ""))
         and ((c.get("name") or "").strip() or (c.get("auto_id") or "").strip())],
        key=lambda c: c["area"],
    )
    caption = captions[0]["name"].strip() if captions else ""
    if buttons:
        button = buttons[0]
        label = caption or (button.get("name") or "").strip() or (button.get("auto_id") or "").strip()
        return {"name": label[:500], "auto_id": (button.get("auto_id") or "")[:500], "control_type": (button.get("control_type") or "")[:100]}
    if caption:
        return {"name": caption[:500], "auto_id": "", "control_type": "Text"}
    return None


def _label_at_point(top: Any, x: int, y: int) -> dict[str, str] | None:
    """Scan a top-level window's controls for the ones whose rectangle contains the
    click point and choose the best human label. Controls covering most of the
    window (backgrounds, the window itself) are skipped so a real button wins."""
    try:
        top_rect = top.rectangle()
        win_area = max(1, (top_rect.right - top_rect.left) * (top_rect.bottom - top_rect.top))
    except Exception:
        win_area = None
    candidates: list[dict[str, Any]] = []
    try:
        descendants = top.descendants()[:1200]
    except Exception:
        return None
    for control in descendants:
        try:
            info = control.element_info
            rect = info.rectangle
            if not (rect.left <= x <= rect.right and rect.top <= y <= rect.bottom):
                continue
            area = max(1, (rect.right - rect.left) * (rect.bottom - rect.top))
            # A control that fills most of the window is a background/container, not
            # the button the person meant to click.
            if win_area is not None and area >= 0.7 * win_area:
                continue
            candidates.append({
                "name": str(info.name or ""),
                "auto_id": str(info.automation_id or ""),
                "control_type": str(info.control_type or ""),
                "area": area,
            })
        except Exception:
            continue
    return choose_click_label(candidates)


def _resolve_element(x: int, y: int) -> dict[str, str] | None:
    """Resolve the UI Automation element under a screen point to a stable
    description (window title, control name, automation id, control type). Returns
    None if nothing usable is there, so an unresolved click is simply dropped from
    the recording rather than recorded as a fragile coordinate.

    Custom-drawn buttons resolve to a decorative image layer at the click point, so
    when the raw element has no useful name the surrounding window is searched for
    the real button and its visible caption (the same idea inspect uses)."""
    try:
        _, Desktop = _load_pywinauto()
        element = Desktop(backend="uia").from_point(x, y)
        info = element.element_info
        try:
            top = element.top_level_parent()
            window = str(top.window_text() or "")
        except Exception:
            top = None
            window = ""
        name = str(info.name or "")
        auto_id = str(info.automation_id or "")
        control_type = str(info.control_type or "")
        # If the click landed on a decorative layer or an unnamed node, find the
        # real labeled button at that point instead.
        if top is not None and (_is_decorative_name(name) or control_type not in INTERACTABLE_CONTROL_TYPES):
            better = _label_at_point(top, x, y)
            if better is not None:
                name = better["name"]
                auto_id = better["auto_id"]
                control_type = better["control_type"]
        return {
            "window": window[:500],
            "name": name[:500],
            "auto_id": auto_id[:500],
            "control_type": control_type[:100],
        }
    except Exception:
        return None


class ClickRecorder:
    """Records the user's clicks AND typing by polling the mouse and keyboard. On
    each new click it resolves the element under the cursor; key presses accumulate
    into the text the user typed and are emitted as a "type" event when a click,
    Enter/Tab, or stop ends the run. The result is a readable trace the model turns
    into a reusable instruction.

    ignore_window is the WorkCrew window title: clicks and typing that happen in
    WorkCrew itself (starting/stopping the recording, its own panels and buttons)
    are dropped so only the user's work in the target app is recorded.

    The capture loop touches only ctypes and pywinauto, never AgentState, so it
    needs no lock and cannot deadlock with the request handler."""

    def __init__(self, ignore_window: str = "") -> None:
        self.ignore_window = (ignore_window or "").strip()
        self._ignore_lower = self.ignore_window.lower()
        self._events: list[dict[str, Any]] = []
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        # Element resolution (a slow UI Automation round trip) runs on a separate
        # thread so it never stalls keyboard/mouse sampling on the poll loop. The
        # poll loop appends a placeholder click immediately and queues it here.
        self._resolver: threading.Thread | None = None
        self._queue: "queue.Queue[tuple[dict[str, Any], int, int] | None]" = queue.Queue()
        self._lock = threading.Lock()
        # Typed characters accumulate here with the window they were typed in, then
        # flush to one "type" event on the next click, Enter/Tab, or stop.
        self._typed: list[str] = []
        self._typed_window: str = ""

    def start(self) -> None:
        self._resolver = threading.Thread(target=self._resolve_loop, name="wc-click-resolver", daemon=True)
        self._resolver.start()
        self._thread = threading.Thread(target=self._loop, name="wc-click-recorder", daemon=True)
        self._thread.start()

    def stop(self) -> list[dict[str, Any]]:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=3)
        # The poll loop has stopped, so no more clicks will be queued. Let the
        # resolver finish the ones already queued, then exit on the sentinel.
        self._queue.put(None)
        if self._resolver is not None:
            self._resolver.join(timeout=3)
        with self._lock:
            self._flush_typed_locked()
            return list(self._events)

    def _loop(self) -> None:
        started = time.monotonic()
        user32 = ctypes.windll.user32  # type: ignore[attr-defined]
        tracked = list(_TYPING_MAP.keys()) + [VK_BACK, VK_RETURN, VK_TAB]
        # Prime previous states so keys/buttons already held when recording begins
        # are not captured as fresh presses.
        mouse_down = bool(user32.GetAsyncKeyState(VK_LBUTTON) & 0x8000)
        key_down: dict[int, bool] = {vk: bool(user32.GetAsyncKeyState(vk) & 0x8000) for vk in tracked}
        while not self._stop.is_set():
            if time.monotonic() - started > RECORD_MAX_SECONDS:
                break
            current_mouse = bool(user32.GetAsyncKeyState(VK_LBUTTON) & 0x8000)
            if current_mouse and not mouse_down:
                self._capture(*_cursor_point())
            mouse_down = current_mouse
            shift = bool(user32.GetAsyncKeyState(VK_SHIFT) & 0x8000)
            caps = bool(user32.GetKeyState(VK_CAPITAL) & 1)
            ctrl = bool(user32.GetAsyncKeyState(VK_CONTROL) & 0x8000)
            alt = bool(user32.GetAsyncKeyState(VK_MENU) & 0x8000)
            for vk in tracked:
                down = bool(user32.GetAsyncKeyState(vk) & 0x8000)
                if down and not key_down[vk]:
                    self._on_key(vk, shift, caps, ctrl, alt)
                key_down[vk] = down
            time.sleep(RECORD_POLL_SECONDS)

    def _resolve_loop(self) -> None:
        # Drain queued clicks, resolving each element off the poll thread and
        # filling the placeholder in place. Exits on the None sentinel.
        while True:
            item = self._queue.get()
            if item is None:
                return
            event, x, y = item
            resolved = _resolve_element(x, y)
            if resolved:
                with self._lock:
                    event.update(resolved)

    def _on_key(self, vk: int, shift: bool, caps: bool, ctrl: bool = False, alt: bool = False) -> None:
        # A held Ctrl or Alt means a hotkey (Ctrl+S, Alt+Tab), not text, so it is
        # never captured as typed characters.
        if ctrl or alt:
            return
        # Enter and Tab commit the current run (move to the next field/cell).
        if vk in (VK_RETURN, VK_TAB):
            with self._lock:
                self._flush_typed_locked()
            return
        if vk == VK_BACK:
            with self._lock:
                if self._typed:
                    self._typed.pop()
            return
        pair = _TYPING_MAP.get(vk)
        if pair is None:
            return
        if 0x41 <= vk <= 0x5A:  # letters: Caps Lock and Shift combine
            character = pair[1] if (shift ^ caps) else pair[0]
        else:
            character = pair[1] if shift else pair[0]
        # Scope typing to the foreground app, re-checked every key. Typing in
        # WorkCrew itself is never captured, and a change of foreground window ends
        # the current run so each run is attributed to one app.
        window = _foreground_window_title()
        if self._ignore_lower and window.strip().lower().startswith(self._ignore_lower):
            return
        with self._lock:
            if self._typed and window != self._typed_window:
                self._flush_typed_locked()
            if not self._typed:
                self._typed_window = window
            if len(self._typed) < RECORD_MAX_TYPED:
                self._typed.append(character)

    def _flush_typed_locked(self) -> None:
        # Emit the accumulated typing as one event. Caller holds self._lock.
        if not self._typed:
            return
        text = "".join(self._typed).strip()
        window = self._typed_window
        self._typed = []
        self._typed_window = ""
        if text and len(self._events) < RECORD_MAX_EVENTS:
            self._events.append({"kind": "type", "window": window[:500], "text": text[:RECORD_MAX_TYPED]})

    def _capture(self, x: int, y: int) -> None:
        # A click ends the current typing run so events stay in order. The click is
        # appended immediately as a placeholder and resolved off-thread.
        with self._lock:
            self._flush_typed_locked()
            if len(self._events) >= RECORD_MAX_EVENTS:
                return
            event: dict[str, Any] = {"kind": "click", "x": x, "y": y}
            self._events.append(event)
        self._queue.put((event, x, y))


def build_record_trace(events: list[dict[str, Any]], ignore_window: str = "") -> list[dict[str, Any]]:
    """Turn recorded click and type events into a readable trace for the model.

    Pure and side-effect free so it can be unit tested without pywinauto or a
    desktop. A click becomes a {kind: click, window, control, controlType} entry
    (clicks whose element did not resolve to a name are dropped, and a click
    identical to the one just before it is collapsed). A typing run becomes a
    {kind: type, window, text} entry. Anything that happened in ignore_window (the
    WorkCrew app itself: starting/stopping the recording, its own panels and
    buttons) is dropped, so only the user's work in the target app is described.
    The trace is descriptive, not replayable steps: the model turns it into a
    reusable instruction that the automation loop runs.
    """
    ignore = (ignore_window or "").strip().lower()
    trace: list[dict[str, Any]] = []
    for event in events:
        window = (event.get("window") or "").strip()
        # Drop WorkCrew's own window and its child dialogs (title-prefixed).
        if ignore and window.lower().startswith(ignore):
            continue
        if event.get("kind") == "type":
            text = (event.get("text") or "").strip()
            if text:
                trace.append({"kind": "type", "window": window, "text": text})
            continue
        name = (event.get("name") or "").strip()
        auto_id = (event.get("auto_id") or "").strip()
        control = name or auto_id
        if not control:
            continue
        entry = {"kind": "click", "window": window, "control": control, "controlType": (event.get("control_type") or "").strip()}
        if trace and trace[-1] == entry:
            continue
        trace.append(entry)
    return trace


def inspect_window() -> str:
    window = require_window()
    infos: list[dict[str, Any]] = []
    for control in window.descendants()[:800]:
        try:
            info = control.element_info
            entry: dict[str, Any] = {
                "name": str(info.name or "")[:500],
                "auto_id": str(info.automation_id or "")[:500],
                "control_type": str(info.control_type or "")[:100],
            }
            try:
                rect = info.rectangle
                entry["rect"] = [rect.left, rect.top, rect.right, rect.bottom]
            except Exception:
                pass
            infos.append(entry)
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
        # windowTitle carries the WorkCrew window title to ignore, so the user's
        # own clicks in WorkCrew (start/stop, panels) are not part of the recording.
        ignore_window = optional_text(action.get("windowTitle"), 500) or ""
        with STATE.lock:
            if STATE.recorder is not None:
                return "Recording is already in progress"
            recorder = ClickRecorder(ignore_window=ignore_window)
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
        return json.dumps(build_record_trace(events, recorder.ignore_window), ensure_ascii=True)

    with STATE.lock:
        if command == "inspect":
            return inspect_window()
        if command == "screenshot":
            # With a connected window, capture just that window; before any
            # connect, capture the whole screen instead of erroring out.
            if STATE.window is not None:
                image = STATE.window.capture_as_image()
            else:
                from PIL import ImageGrab

                image = ImageGrab.grab()
            output = Path(tempfile.gettempdir()) / f"workcrew-window-{os.getpid()}.png"
            image.save(output)
            return str(output)
        if command == "press-key":
            # Send one allowlisted navigation/editing key to the focused control,
            # for example to confirm a spreadsheet cell with Enter. Only the safe
            # keys above are permitted; anything else is rejected.
            key = require_text(action.get("value"), "value", 40).lower()
            sequence = SAFE_KEYS.get(key)
            if sequence is None:
                raise ValueError("That key is not allowed")
            require_window().type_keys(sequence, set_foreground=True)
            return f"Pressed {key}"
        if command == "type-text":
            # Type literal text into whatever is focused in the connected window
            # (for example the active spreadsheet cell after it is selected), with
            # no control lookup. Every keystroke-language metacharacter is escaped,
            # so the value can only ever produce plain text, never a chord/hotkey.
            value = optional_text(action.get("value"), MAX_TEXT_LENGTH) or ""
            require_window().type_keys(escape_for_type_keys(value), with_spaces=True, set_foreground=True)
            return "Typed text"

        selector = require_text(action.get("control"), "control")
        if command == "click":
            # Click by the control when it resolves, but always fall back to a real
            # mouse click at its recorded rectangle center. Custom-drawn buttons
            # (the Group/Pane controls in legacy business apps) often refuse a UIA
            # invoke or fail to re-resolve by name, yet a positional click on their
            # center always works, which is what the user sees themselves do.
            try:
                control = find_control(selector)
                control.click_input()
                return f"Clicked control {selector}"
            except Exception:
                point = _stored_click_point(selector)
                if point is None:
                    raise
                _click_at(*point)
                return f"Clicked control {selector}"

        control = find_control(selector)
        if command == "set-text":
            value = optional_text(action.get("value"), MAX_TEXT_LENGTH) or ""
            control.set_edit_text(value)
            return f"Updated control {selector}"
        if command == "type-keys":
            value = optional_text(action.get("value"), MAX_TEXT_LENGTH) or ""
            # Every keystroke-language metacharacter (^ % + ~ ( ) { }) is escaped to
            # its literal form, so model-supplied text can only type literal text,
            # never trigger a key chord or hotkey. Special keys go through press-key.
            control.type_keys(escape_for_type_keys(value), with_spaces=True, set_foreground=True)
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
