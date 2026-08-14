from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes
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
    # Screen-level input for apps that publish no usable controls.
    "click-at",
    "double-click-at",
    "right-click-at",
    "drag",
    "scroll-at",
    "key-combo",
    "record-start",
    "record-stop",
}

# Key combinations the model may send with key-combo. This is an allowlist, not a
# parser: a free-form chord string would let a planner (or anything that could
# influence one) reach Windows itself, so only these named combinations exist.
# Nothing here can close a session, reach the Run dialog, or switch user.
SAFE_COMBOS = {
    "ctrl+s": "^s",
    "ctrl+o": "^o",
    "ctrl+p": "^p",
    "ctrl+n": "^n",
    "ctrl+c": "^c",
    "ctrl+x": "^x",
    "ctrl+v": "^v",
    "ctrl+z": "^z",
    "ctrl+y": "^y",
    "ctrl+a": "^a",
    "ctrl+f": "^f",
    "ctrl+home": "^{HOME}",
    "ctrl+end": "^{END}",
    "alt+f4": "%{F4}",
    "shift+tab": "+{TAB}",
    "f2": "{F2}",
    "f3": "{F3}",
    "f5": "{F5}",
    "f9": "{F9}",
    "f10": "{F10}",
    "f11": "{F11}",
    "f12": "{F12}",
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


def optional_int(value: Any, name: str, minimum: int, maximum: int) -> int | None:
    """A whole number within range, or None when the field is absent.

    Booleans are refused explicitly: in Python True is an int, so a sloppy check
    would happily accept it and click at (1, 1).
    """
    if value is None:
        return None
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValueError(f"{name} must be a whole number")
    if not (minimum <= value <= maximum):
        raise ValueError(f"{name} is out of range")
    return value


def validate_action(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("Action must be an object")
    # x/y/toX/toY/scrollAmount belong to the screen-level commands, which act on
    # coordinates instead of a named control. Everything outside this set is
    # refused outright rather than ignored, so an unexpected field is a loud
    # error instead of a silently dropped instruction.
    permitted = {
        "kind", "command", "application", "windowTitle", "control", "value",
        "x", "y", "toX", "toY", "scrollAmount"
    }
    if set(value) - permitted:
        raise ValueError("Action contains unsupported fields")
    if value.get("kind") != "windows":
        raise ValueError("Invalid action kind")
    command = value.get("command")
    if command not in ALLOWED_COMMANDS:
        raise ValueError("Unsupported Windows command")
    # The action is rebuilt field by field rather than passed through, so an
    # attacker cannot smuggle anything past the checks. That means EVERY field a
    # command needs must be listed here: leaving one out silently drops it, and
    # the command then fails as though the caller never sent it.
    result = {
        "kind": "windows",
        "command": command,
        "application": optional_text(value.get("application"), 260),
        "windowTitle": optional_text(value.get("windowTitle"), 500),
        "control": optional_text(value.get("control"), 500),
        "value": optional_text(value.get("value"), MAX_TEXT_LENGTH),
        # Screen coordinates for the pixel-level commands. Bounded well past any
        # real display so a second monitor (negative coordinates) still works.
        "x": optional_int(value.get("x"), "x", -20_000, 20_000),
        "y": optional_int(value.get("y"), "y", -20_000, 20_000),
        "toX": optional_int(value.get("toX"), "toX", -20_000, 20_000),
        "toY": optional_int(value.get("toY"), "toY", -20_000, 20_000),
        "scrollAmount": optional_int(value.get("scrollAmount"), "scrollAmount", -25, 25),
    }
    return result


# Windows that belong to the desktop itself and are never what a user means.
_SHELL_WINDOW_TITLES = {
    "program manager",
    "windows input experience",
    "microsoft text input application",
    "windows shell experience host",
    "settings",
    "search",
    "start",
}


def _visible_windows_win32() -> list[tuple[int, str]]:
    """Every real, visible, titled top-level window, asked of Windows directly.

    This is the listing that still answers when UI Automation does not. A program
    running as administrator is invisible to a program that is not: Windows
    blocks the accessibility tree across that boundary, so an ERP started with
    "Run as administrator" is simply absent from the UIA listing while sitting
    plainly on screen, and the app reports that it cannot find a window the user
    is looking straight at. EnumWindows is not blocked that way, so comparing the
    two listings turns "I cannot see it" into the actual reason.
    """
    user32 = ctypes.windll.user32  # type: ignore[attr-defined]
    found: list[tuple[int, str]] = []

    def collect(hwnd: int, _param: int) -> bool:
        try:
            if not user32.IsWindowVisible(hwnd):
                return True
            title = _window_title_of(int(hwnd)).strip()
            if not title or title.lower() in _SHELL_WINDOW_TITLES:
                return True
            # Cloaked windows are the ones the shell keeps alive off screen
            # (background store apps, a virtual desktop that is not showing).
            # They report themselves visible and are not on screen.
            cloaked = ctypes.c_int(0)
            try:
                ctypes.windll.dwmapi.DwmGetWindowAttribute(  # type: ignore[attr-defined]
                    ctypes.wintypes.HWND(int(hwnd)), 14, ctypes.byref(cloaked), ctypes.sizeof(cloaked)
                )
            except Exception:
                cloaked = ctypes.c_int(0)
            if cloaked.value:
                return True
            # Anything this small is a tooltip or a stray host window, not an app.
            rect = ctypes.wintypes.RECT()
            if not user32.GetWindowRect(ctypes.wintypes.HWND(int(hwnd)), ctypes.byref(rect)):
                return True
            if rect.right - rect.left < 200 or rect.bottom - rect.top < 120:
                return True
            found.append((int(hwnd), title[:500]))
        except Exception:
            # One bad window must never stop the walk.
            pass
        return True

    callback = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.wintypes.HWND, ctypes.wintypes.LPARAM)(collect)
    user32.EnumWindows(callback, 0)
    return found


BLOCKED_WINDOW_NOTE = (
    "This window is on screen but WorkCrew cannot see inside it or click it. That is Windows blocking it, "
    "and it happens when the program was started as administrator while WorkCrew was not. Tell the user to "
    "close WorkCrew and start it with Run as administrator (or to reopen this program normally), then try "
    "again. Do not report this window as missing or closed: it is open."
)


def merge_window_listings(
    controllable: list[dict[str, Any]], on_screen: list[tuple[int, str]]
) -> list[dict[str, Any]]:
    """Combine the windows UI Automation can drive with everything Windows says
    is on screen, so a window that is present but unreachable is reported as
    exactly that rather than silently dropped."""
    known = {entry.get("handle") for entry in controllable if entry.get("handle")}
    merged: list[dict[str, Any]] = list(controllable)
    for handle, title in on_screen:
        if handle in known:
            continue
        merged.append({
            "title": title,
            "type": "Window",
            "handle": handle,
            "controllable": False,
            "note": BLOCKED_WINDOW_NOTE,
        })
    return merged


def list_windows() -> str:
    _, Desktop = _load_pywinauto()
    windows: list[dict[str, Any]] = []
    for window in Desktop(backend="uia").windows():
        try:
            title = window.window_text().strip()
            if not title or not window.is_visible():
                continue
            rectangle = window.rectangle()
            handle = 0
            try:
                handle = int(getattr(window, "handle", 0) or 0)
            except Exception:
                handle = 0
            windows.append({
                "title": title[:500],
                "type": window.element_info.control_type,
                "handle": handle,
                "controllable": True,
                "rectangle": [rectangle.left, rectangle.top, rectangle.right, rectangle.bottom],
            })
        except Exception:
            # A single inaccessible window must never abort the whole listing.
            continue
    try:
        windows = merge_window_listings(windows, _visible_windows_win32())
    except Exception:
        # The second opinion is a diagnosis aid, never a reason to fail the
        # listing that already worked.
        pass
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
        # Before reporting it missing, ask Windows itself. A window that is on
        # screen but absent from the accessibility tree is the signature of a
        # program running as administrator while WorkCrew is not, and saying
        # "no such window" about an app the user is looking straight at is the
        # single most confusing thing this tool can do.
        try:
            blocked = [title for _, title in _visible_windows_win32() if score_window_title(requested, title)]
        except Exception:
            blocked = []
        if blocked:
            raise ValueError(
                f'"{blocked[0]}" is open on screen, but Windows will not let WorkCrew see inside it or click it. '
                "This happens when a program runs as administrator and WorkCrew does not. Tell the user to close "
                "WorkCrew and start it with Run as administrator (or to reopen that program normally), then try "
                "again. Do not tell the user the window is missing or closed: it is open."
            )
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
        # Wait only for the window to EXIST and be VISIBLE, not for UI Automation
        # to call it "ready". Ready means enabled and responsive to UIA, and the
        # very apps this most needs to drive, the ones that paint their own
        # interface and expose almost nothing to accessibility, often never report
        # ready even while sitting plainly on screen (Express Accounts is one).
        # Requiring ready made connect time out on exactly those apps, blocking
        # the screen path before it could start. Existence and visibility are
        # enough: the screenshot-and-click path needs the handle, not UIA state.
        try:
            window.wait("exists visible", timeout=10)
        except Exception:
            # Even a visibility wait can time out on a stubborn app that is
            # nonetheless real and on screen. list-windows already confirmed the
            # window, so keep the connection: a failed wait must not deny the one
            # path (working by eye) that does not depend on UIA at all.
            pass
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


# Full-screen, click-through overlays sit visually on top of every app but pass
# clicks through to whatever is beneath them. A click lands in the real app, but a
# naive point lookup returns the overlay, so recordings get attributed to it (for
# example "NVIDIA GeForce Overlay") instead of the app the person actually used.
_OVERLAY_TITLES = frozenset({
    "nvidia geforce overlay",
    "geforce overlay",
    "discord overlay",
})

def _is_overlay_title(title: str) -> bool:
    return (title or "").strip().lower() in _OVERLAY_TITLES


# Per-click screenshot crops. A small image around each click is attached to the
# recording so the model that writes the instruction SEES the button the person
# pressed, exactly like reviewing a screen capture, instead of trusting control
# names alone. Small crops keep the token cost of each image low.
RECORD_SHOT_WIDTH = 480
RECORD_SHOT_HEIGHT = 360
RECORD_MAX_SHOTS = 16
_SM_XVIRTUALSCREEN, _SM_YVIRTUALSCREEN = 76, 77
_SM_CXVIRTUALSCREEN, _SM_CYVIRTUALSCREEN = 78, 79


def _draw_click_marker(image: Any, cx: int, cy: int) -> None:
    """Draw a red target ring at (cx, cy) on the crop so the model sees EXACTLY
    where the person clicked, the way the Claude browser extension marks a click.
    A white halo around the red keeps it visible on any background."""
    from PIL import ImageDraw

    draw = ImageDraw.Draw(image)
    radius = 26
    # White outer ring first (contrast), then the red ring on top of it.
    draw.ellipse((cx - radius - 2, cy - radius - 2, cx + radius + 2, cy + radius + 2), outline=(255, 255, 255), width=6)
    draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), outline=(255, 0, 0), width=4)
    # A small solid dot at the exact click point.
    draw.ellipse((cx - 4, cy - 4, cx + 4, cy + 4), fill=(255, 0, 0), outline=(255, 255, 255))


def _capture_click_shot(x: int, y: int, index: int) -> str | None:
    """Save a small screenshot around a click, marked with a red circle at the
    exact click point (clamped to the virtual screen, so multi-monitor setups
    work), and return its file path, or None when capture fails. Never raises: a
    recording must survive a failed screenshot."""
    try:
        from PIL import ImageGrab

        user32 = ctypes.windll.user32  # type: ignore[attr-defined]
        vx = int(user32.GetSystemMetrics(_SM_XVIRTUALSCREEN))
        vy = int(user32.GetSystemMetrics(_SM_YVIRTUALSCREEN))
        vw = int(user32.GetSystemMetrics(_SM_CXVIRTUALSCREEN))
        vh = int(user32.GetSystemMetrics(_SM_CYVIRTUALSCREEN))
        left = max(vx, min(x - RECORD_SHOT_WIDTH // 2, vx + vw - RECORD_SHOT_WIDTH))
        top = max(vy, min(y - RECORD_SHOT_HEIGHT // 2, vy + vh - RECORD_SHOT_HEIGHT))
        image = ImageGrab.grab(bbox=(left, top, left + RECORD_SHOT_WIDTH, top + RECORD_SHOT_HEIGHT), all_screens=True).convert("RGB")
        # Mark the click at its real position within the crop (near an edge the
        # crop is clamped, so the click is not always the exact centre).
        _draw_click_marker(image, x - left, y - top)
        # JPEG keeps each crop small (usually under 30 KB) so several fit in one
        # summarize request without blowing the API body limit.
        output = Path(tempfile.gettempdir()) / f"workcrew-rec-{os.getpid()}-{index}.jpg"
        image.save(output, "JPEG", quality=80)
        return str(output)
    except Exception:
        return None


_GA_ROOT = 2


def _window_title_of(hwnd: int) -> str:
    user32 = ctypes.windll.user32  # type: ignore[attr-defined]
    length = int(user32.GetWindowTextLengthW(hwnd))
    buffer = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, buffer, length + 1)
    return str(buffer.value or "")


def _real_window_at(x: int, y: int) -> tuple[int | None, str]:
    """The top-level window that would actually RECEIVE a click at a screen
    point, per the OS's own hit testing (WindowFromPoint). This is the ground
    truth for recording: it skips click-through overlays, hidden windows, and
    windows parked on other virtual desktops, all of which fooled bookkeeping
    approaches (a recording once attributed every click to "NVIDIA GeForce
    Overlay", and another to invisible browser windows). Returns (hwnd, title)
    or (None, "")."""
    try:
        from ctypes import wintypes

        class _PT(ctypes.Structure):
            _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

        user32 = ctypes.windll.user32  # type: ignore[attr-defined]
        user32.WindowFromPoint.restype = wintypes.HWND
        user32.WindowFromPoint.argtypes = [_PT]
        user32.GetAncestor.restype = wintypes.HWND
        user32.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]

        hwnd = user32.WindowFromPoint(_PT(x, y))
        if not hwnd:
            return None, ""
        root = user32.GetAncestor(hwnd, _GA_ROOT) or hwnd
        title = _window_title_of(int(root))
        # An overlay can still be hit while it is interactive; in that case the
        # click really did go to it, but it is never the app the person is
        # working in, so report no window and let the caller fall back.
        if not title.strip() or _is_overlay_title(title):
            return None, ""
        return int(root), title
    except Exception:
        return None, ""


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


def require_point(action: dict[str, Any], x_key: str = "x", y_key: str = "y") -> tuple[int, int]:
    """Read a screen point off an action, refusing anything that is not a real
    coordinate. The transport already bounds these, but the agent is a separate
    process that must not trust its caller."""
    raw_x, raw_y = action.get(x_key), action.get(y_key)
    if not isinstance(raw_x, int) or not isinstance(raw_y, int) or isinstance(raw_x, bool) or isinstance(raw_y, bool):
        raise ValueError(f"{x_key} and {y_key} must be whole numbers")
    if not (-20000 <= raw_x <= 20000) or not (-20000 <= raw_y <= 20000):
        raise ValueError("Those coordinates are off the screen")
    return raw_x, raw_y


def _connected_window_rect(window: Any) -> tuple[int, int, int, int] | None:
    """The window's true screen rectangle, asked of win32 directly.

    UI Automation lies about geometry for some real business apps: Express
    Accounts reports its rectangle as 0,0,0,0 while sitting plainly on screen.
    GetWindowRect on the raw handle answers correctly for exactly those apps, so
    it is asked first and the UIA rectangle is only a fallback.
    """
    handle = None
    try:
        handle = getattr(window, "handle", None)
    except Exception:
        handle = None
    if handle:
        try:
            rect = ctypes.wintypes.RECT()
            if ctypes.windll.user32.GetWindowRect(ctypes.wintypes.HWND(int(handle)), ctypes.byref(rect)):
                if rect.right - rect.left > 8 and rect.bottom - rect.top > 8:
                    return (int(rect.left), int(rect.top), int(rect.right), int(rect.bottom))
        except Exception:
            pass
    try:
        rectangle = window.rectangle()
        if rectangle.right - rectangle.left > 8 and rectangle.bottom - rectangle.top > 8:
            return (int(rectangle.left), int(rectangle.top), int(rectangle.right), int(rectangle.bottom))
    except Exception:
        pass
    return None


def _ensure_foreground(window: Any) -> None:
    """Bring the connected window to the front before photographing the screen or
    acting on it, so captures show the app rather than whatever covered it, and
    screen clicks land in the app they were aimed at."""
    if window is None:
        return
    try:
        window.set_focus()
        time.sleep(0.2)
    except Exception:
        pass


def capture_window_payload(window: Any) -> dict[str, Any]:
    """Capture ONLY the connected window, and say where it sits on screen.

    There is deliberately no whole-desktop fallback. An earlier version grabbed
    the full screen when a window reported a useless rectangle, and on a
    multi-monitor PC that photographed an unrelated display, once including a
    live video call. Captures are shown to the planner, so they leave the
    machine; when the window cannot be located, the honest move is to say so,
    never to photograph everything.

    The returned left/top are the window's screen origin. They let the desktop
    translate positions in the picture back into screen points, which is what
    lets the planner work purely in the picture it was shown, the way the
    reference computer-use loops do.
    """
    if window is None:
        raise ValueError("Connect to the app's window first; WorkCrew only captures the app it is working in")
    rect = _connected_window_rect(window)
    if rect is None:
        raise ValueError("This app's window cannot be located on screen, so it cannot be captured")
    _ensure_foreground(window)
    from PIL import ImageGrab

    # Grab the whole virtual desktop in memory, crop to the window, and save only
    # the crop. The full grab never touches disk and never leaves this function;
    # cropping to the window's own rectangle is what keeps every other window out
    # of the picture.
    user32 = ctypes.windll.user32
    virtual_left = int(user32.GetSystemMetrics(76))
    virtual_top = int(user32.GetSystemMetrics(77))
    whole = ImageGrab.grab(all_screens=True)
    image = whole.crop((rect[0] - virtual_left, rect[1] - virtual_top, rect[2] - virtual_left, rect[3] - virtual_top))
    output = Path(tempfile.gettempdir()) / f"workcrew-window-{os.getpid()}.png"
    image.save(output)
    return {"path": str(output), "left": rect[0], "top": rect[1], "width": image.width, "height": image.height}


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


def _rect_mostly_inside(inner: tuple[int, int, int, int] | None, outer: tuple[int, int, int, int] | None, frac: float = 0.7) -> bool:
    """Whether at least `frac` of the inner rectangle's area lies within the outer
    one. A button's own caption is mostly inside it; a wider label that merely
    clips the same point (a hidden menu item, a neighbouring field) is not."""
    if not inner or not outer:
        return False
    ix = max(0, min(inner[2], outer[2]) - max(inner[0], outer[0]))
    iy = max(0, min(inner[3], outer[3]) - max(inner[1], outer[1]))
    inter = ix * iy
    inner_area = max(1, (inner[2] - inner[0]) * (inner[3] - inner[1]))
    return inter / inner_area >= frac


def choose_click_label(candidates: list[dict[str, Any]]) -> dict[str, str] | None:
    """Pick the human label for a click from the controls whose rectangle contains
    the clicked point. The click's button is the SMALLEST interactable control at
    the point; its label is a caption drawn ON that button (a text node whose
    center lies inside the button's rectangle), never a stray label elsewhere in
    the window. Pure so it can be unit tested. Each candidate carries {name,
    auto_id, control_type, area, rect}."""
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
    if buttons:
        button = buttons[0]
        # A caption for THIS button must sit mostly within the button's own
        # rectangle, so a hidden or neighbouring label (a menu item from another
        # tab, say) that only clips the same point can never win.
        on_button = [c for c in captions if _rect_mostly_inside(c.get("rect"), button.get("rect"))]
        caption = on_button[0]["name"].strip() if on_button else ""
        label = caption or (button.get("name") or "").strip() or (button.get("auto_id") or "").strip()
        return {"name": label[:500], "auto_id": (button.get("auto_id") or "")[:500], "control_type": (button.get("control_type") or "")[:100]}
    if captions:
        # No interactable control at the point: fall back to the smallest visible
        # caption there (a plain clickable label or link).
        return {"name": captions[0]["name"].strip()[:500], "auto_id": "", "control_type": "Text"}
    return None


def _label_at_point(top: Any, x: int, y: int) -> dict[str, str] | None:
    """Find the best human label for a click by looking only at controls that are
    actually VISIBLE at the click point. Hidden content (a tab that is not on top,
    an off-screen list) keeps its geometry in the accessibility tree and used to
    hijack labels; filtering by visibility and constraining the caption to the
    clicked button removes that whole class of error."""
    try:
        top_rect = top.rectangle()
        win_area = max(1, (top_rect.right - top_rect.left) * (top_rect.bottom - top_rect.top))
    except Exception:
        win_area = None
    candidates: list[dict[str, Any]] = []
    try:
        descendants = top.descendants()[:1500]
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
            # Skip controls that are not really shown: a hidden tab's labels still
            # contain the point geometrically but are off-screen, and picking one
            # is exactly the bug this guards against.
            try:
                if not control.is_visible():
                    continue
            except Exception:
                pass
            candidates.append({
                "name": str(info.name or ""),
                "auto_id": str(info.automation_id or ""),
                "control_type": str(info.control_type or ""),
                "area": area,
                "rect": (rect.left, rect.top, rect.right, rect.bottom),
            })
        except Exception:
            continue
    return choose_click_label(candidates)


def _resolve_element(x: int, y: int, hwnd: int | None = None, window_title: str = "") -> dict[str, str] | None:
    """Resolve the UI Automation element under a screen point to a stable
    description (window title, control name, automation id, control type). Returns
    None if nothing usable is there, so an unresolved click is simply dropped from
    the recording rather than recorded as a fragile coordinate.

    When the recorder passes the window it hit-tested AT CLICK TIME (hwnd and
    title), that window is authoritative: this may run seconds after the click,
    by which time a newly opened window can cover the clicked spot, and a fresh
    lookup would blame the wrong app. Without a handle, the OS hit test runs now.
    Custom-drawn buttons resolve to a decorative image layer, so the window is
    searched for the real button and its visible caption."""
    try:
        _, Desktop = _load_pywinauto()

        window = window_title or ""
        top = None
        if hwnd is None:
            hwnd, real_title = _real_window_at(x, y)
            if hwnd is not None:
                window = real_title
        if hwnd is not None:
            try:
                top = Desktop(backend="uia").window(handle=hwnd)
            except Exception:
                top = None

        name = auto_id = control_type = ""
        if top is None:
            # Fall back to the raw element the OS reports under the point.
            element = Desktop(backend="uia").from_point(x, y)
            info = element.element_info
            name = str(info.name or "")
            auto_id = str(info.automation_id or "")
            control_type = str(info.control_type or "")
            try:
                top = element.top_level_parent()
                if not window:
                    window = str(top.window_text() or "")
            except Exception:
                top = None

        # Find the real labeled control at the point (skips decorative layers and
        # names custom buttons by their visible caption). Keep the raw element only
        # when nothing better is found.
        if top is not None and (not name or _is_decorative_name(name) or control_type not in INTERACTABLE_CONTROL_TYPES):
            better = _label_at_point(top, x, y)
            if better is not None:
                name = better["name"]
                auto_id = better["auto_id"]
                control_type = better["control_type"]

        if not window and not name and not auto_id:
            return None
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
        self._queue: "queue.Queue[tuple[dict[str, Any], int, int, int | None, str] | None]" = queue.Queue()
        self._lock = threading.Lock()
        # Screenshots taken so far this recording (bounded by RECORD_MAX_SHOTS).
        # Touched only on the poll thread, so no lock is needed.
        self._shot_count = 0
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
        # The poll loop has stopped, so no more clicks will be queued. Give the
        # resolver real time to finish the queued tail: the LAST clicks of a
        # recording are usually the point of it, and a short timeout here once
        # silently dropped them.
        self._queue.put(None)
        if self._resolver is not None:
            self._resolver.join(timeout=20)
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
        # Drain queued clicks, filling in the slow part (the control's name via a
        # UI Automation round trip) off the poll thread. The window and screenshot
        # were already captured at click time, so the lookup runs against the
        # window that was really clicked even if the screen has since changed.
        while True:
            item = self._queue.get()
            if item is None:
                return
            event, x, y, hwnd, title = item
            resolved = _resolve_element(x, y, hwnd, title)
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
        # A click ends the current typing run so events stay in order. The two
        # time-critical facts are captured RIGHT NOW, before the screen reacts to
        # the click: which window received it (the OS hit test, instant) and a
        # small screenshot around it. Only the slow control-name lookup is
        # deferred to the resolver thread, pinned to the window captured here.
        hwnd, title = _real_window_at(x, y)
        # Never record clicks in WorkCrew itself (starting/stopping the recording).
        if self._ignore_lower and title.strip().lower().startswith(self._ignore_lower):
            return
        with self._lock:
            self._flush_typed_locked()
            if len(self._events) >= RECORD_MAX_EVENTS:
                return
            event: dict[str, Any] = {"kind": "click", "x": x, "y": y}
            if title.strip():
                event["window"] = title[:500]
            shot = None
            if self._shot_count < RECORD_MAX_SHOTS:
                shot = _capture_click_shot(x, y, self._shot_count)
                if shot is not None:
                    self._shot_count += 1
                    event["screenshot_path"] = shot
            self._events.append(event)
        self._queue.put((event, x, y, hwnd, title))


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
        shot = (event.get("screenshot_path") or "").strip()
        control = name or auto_id
        # A click whose control never got a name is still a real step when we
        # know where it happened or have its screenshot; only a click with no
        # name, no window, AND no image is unusable noise.
        if not control:
            if not shot and not window:
                continue
            control = "(unlabeled control)"
        entry: dict[str, Any] = {"kind": "click", "window": window, "control": control, "controlType": (event.get("control_type") or "").strip()}
        # Collapse a consecutive repeat of the SAME named control (a double-click
        # is one action). Never collapse unlabeled clicks: two different buttons
        # that both failed to resolve to a name would otherwise merge and a real
        # step would be lost, so those are always kept (their screenshots tell the
        # model they differ).
        prev = trace[-1] if trace else None
        is_named_repeat = (
            prev is not None
            and control != "(unlabeled control)"
            and {k: v for k, v in prev.items() if k != "screenshotPath"} == entry
        )
        if is_named_repeat:
            continue
        if shot:
            entry["screenshotPath"] = shot
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
            # Window-only capture, returned as JSON with the window's screen
            # origin so the desktop can map picture positions back to screen
            # points. The desktop reads the file, downscales it, deletes it, and
            # shows the picture itself to the planner.
            return json.dumps(capture_window_payload(STATE.window), ensure_ascii=True)

        # Screen-level input. These deliberately do NOT resolve a control: they are
        # the fallback for apps that name nothing, so they act on the coordinates
        # the planner read off a screenshot, exactly like a person pointing.
        if command in {"click-at", "double-click-at", "right-click-at"}:
            from pywinauto import mouse

            _ensure_foreground(STATE.window)
            x, y = require_point(action)
            button = "right" if command == "right-click-at" else "left"
            if command == "double-click-at":
                mouse.double_click(button=button, coords=(x, y))
                return f"Double clicked at {x}, {y}"
            mouse.click(button=button, coords=(x, y))
            return f"{'Right clicked' if button == 'right' else 'Clicked'} at {x}, {y}"

        if command == "drag":
            from pywinauto import mouse

            _ensure_foreground(STATE.window)
            start = require_point(action)
            end = require_point(action, "toX", "toY")
            mouse.press(button="left", coords=start)
            try:
                mouse.move(coords=end)
            finally:
                # Always release, or the desktop is left with the button held down
                # and every later click behaves as a drag.
                mouse.release(button="left", coords=end)
            return f"Dragged from {start[0]}, {start[1]} to {end[0]}, {end[1]}"

        if command == "scroll-at":
            from pywinauto import mouse

            _ensure_foreground(STATE.window)
            x, y = require_point(action)
            raw = action.get("scrollAmount")
            if not isinstance(raw, int) or isinstance(raw, bool) or not (-25 <= raw <= 25) or raw == 0:
                raise ValueError("scrollAmount must be a whole number of notches between -25 and 25")
            mouse.scroll(coords=(x, y), wheel_dist=raw)
            return f"Scrolled {'up' if raw > 0 else 'down'} at {x}, {y}"

        if command == "key-combo":
            # One allowlisted key combination sent to the focused window. Unlike
            # type-text this is NOT escaped, because a combination is the point;
            # safety comes from the combination being on the list at all.
            combo = require_text(action.get("value"), "value", 40).lower().replace(" ", "")
            sequence = SAFE_COMBOS.get(combo)
            if sequence is None:
                raise ValueError("That key combination is not allowed")
            window = STATE.window
            if window is not None:
                window.type_keys(sequence, set_foreground=True)
            else:
                from pywinauto import keyboard

                keyboard.send_keys(sequence)
            return f"Pressed {combo}"
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
