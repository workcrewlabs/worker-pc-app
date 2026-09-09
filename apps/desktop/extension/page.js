// Everything that happens INSIDE a page: describing it, and acting on it.
//
// This file is injected by background.js and runs in the extension's isolated
// world, which persists for the life of the page. That is what lets a snapshot
// hand out refs (e1, e2, ...) that a later action can still resolve: the map
// lives on window.__wcRefs until the page navigates.
//
// It is deliberately plain JavaScript with no imports, because chrome.scripting
// injects a single function body and cannot pull in modules.

function wcPageAgent(command) {
  const MAX_CHARS = 60000;
  const MAX_NODES = 800;

  function refs() {
    if (!window.__wcRefs || !(window.__wcRefs instanceof Map)) window.__wcRefs = new Map();
    return window.__wcRefs;
  }

  function visible(el) {
    if (!(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return false;
    if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return false;
    const box = el.getBoundingClientRect();
    // Zero-sized elements are not reachable by a person, so they are noise to
    // the model too. Elements scrolled out of view still count: the page is
    // taller than the window and the model may well want to scroll to them.
    return box.width > 0 && box.height > 0;
  }

  function roleOf(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.trim().toLowerCase();
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return el.hasAttribute("href") ? "link" : "generic";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "img") return "img";
    if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4" || tag === "h5" || tag === "h6") return "heading";
    if (tag === "nav") return "navigation";
    if (tag === "main") return "main";
    if (tag === "header") return "banner";
    if (tag === "footer") return "contentinfo";
    if (tag === "form") return "form";
    if (tag === "table") return "table";
    if (tag === "li") return "listitem";
    if (tag === "summary") return "button";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button" || type === "reset") return "button";
      if (type === "range") return "slider";
      if (type === "search") return "searchbox";
      return "textbox";
    }
    return "generic";
  }

  function clean(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, 160);
  }

  function nameOf(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const parts = labelledBy.split(/\s+/).map((id) => {
        const node = document.getElementById(id);
        return node ? node.textContent : "";
      });
      const joined = clean(parts.join(" "));
      if (joined) return joined;
    }
    if (el.id) {
      const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (label && label.textContent) return clean(label.textContent);
    }
    const wrapping = el.closest("label");
    if (wrapping && wrapping.textContent) {
      const text = clean(wrapping.textContent);
      if (text) return text;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "img") return clean(el.getAttribute("alt"));
    if (tag === "input" || tag === "textarea") {
      const placeholder = el.getAttribute("placeholder");
      if (placeholder) return clean(placeholder);
      const title = el.getAttribute("title");
      if (title) return clean(title);
      return "";
    }
    // For everything else the visible text is the name a person would use.
    return clean(el.textContent);
  }

  // Whether this element is worth a line of its own. Interactive things always
  // are, because they are what actions target. Structural and text elements
  // earn a line only when they carry meaning, so a page does not arrive as
  // thousands of anonymous divs.
  function interesting(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "script" || tag === "style" || tag === "noscript" || tag === "svg" || tag === "path") return false;
    const role = roleOf(el);
    if (["link", "button", "textbox", "searchbox", "combobox", "checkbox", "radio", "slider", "heading", "listitem", "tab", "menuitem", "option", "switch"].includes(role)) return true;
    if (el.hasAttribute("contenteditable")) return true;
    if (typeof el.onclick === "function" || el.hasAttribute("onclick")) return true;
    return false;
  }

  function valueOf(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") return el.checked ? "checked" : "unchecked";
      if (type === "password") return el.value ? "(filled)" : "";
      return clean(el.value);
    }
    if (tag === "textarea") return clean(el.value);
    if (tag === "select") {
      const option = el.options[el.selectedIndex];
      return option ? clean(option.text) : "";
    }
    return "";
  }

  function snapshot() {
    const map = refs();
    map.clear();
    const lines = [];
    let counter = 0;
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode;
    while (node && lines.length < MAX_NODES) {
      if (node instanceof Element && interesting(node) && visible(node)) {
        counter += 1;
        const ref = "e" + counter;
        map.set(ref, node);
        const role = roleOf(node);
        const name = nameOf(node);
        const value = valueOf(node);
        let line = "- " + role;
        if (name) line += ' "' + name + '"';
        if (value) line += " [" + value + "]";
        line += " [ref=" + ref + "]";
        if (node.disabled) line += " (disabled)";
        lines.push(line);
      }
      node = walker.nextNode();
    }
    const header = "Page: " + document.title + "\nURL: " + location.href;
    let body = lines.join("\n");
    if (body.length > MAX_CHARS) body = body.slice(0, MAX_CHARS) + "\n...[truncated]";
    if (!lines.length) body = "(no interactive elements found on this page)";
    return header + "\n" + body;
  }

  function resolve(ref) {
    if (!/^e\d{1,6}$/.test(String(ref || ""))) {
      throw new Error("A current element reference is required. Take a snapshot first.");
    }
    const el = refs().get(ref);
    if (!el || !el.isConnected) {
      throw new Error("That element is no longer on the page. Take a fresh snapshot.");
    }
    return el;
  }

  function bySelector(selector) {
    const value = String(selector || "").trim();
    if (!value || value.length > 500) throw new Error("A recorded element selector is required.");
    const el = document.querySelector(value);
    if (!el) throw new Error("No element matches that selector any more.");
    return el;
  }

  // React and similar frameworks listen for input events rather than reading
  // the property, so a plain value assignment is invisible to them. Setting
  // through the native setter and then dispatching is what makes typed text
  // actually register.
  function setValue(el, text) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(el, text);
    else el.value = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function focusAnd(el) {
    el.scrollIntoView({ block: "center", inline: "center" });
    if (typeof el.focus === "function") el.focus();
  }

  const kind = command && command.command;
  const target = command && command.target;
  const value = command && command.value;

  switch (kind) {
    case "snapshot":
      return snapshot();
    case "click": {
      const el = resolve(target);
      focusAnd(el);
      el.click();
      return "Clicked.";
    }
    case "click-selector": {
      const el = bySelector(target);
      focusAnd(el);
      el.click();
      return "Clicked.";
    }
    case "fill": {
      const el = resolve(target);
      focusAnd(el);
      setValue(el, String(value == null ? "" : value));
      return "Filled.";
    }
    case "fill-selector": {
      const el = bySelector(target);
      focusAnd(el);
      setValue(el, String(value == null ? "" : value));
      return "Filled.";
    }
    case "type": {
      const el = target ? resolve(target) : document.activeElement;
      if (!el) throw new Error("Nothing is focused to type into.");
      focusAnd(el);
      setValue(el, (el.value || "") + String(value == null ? "" : value));
      return "Typed.";
    }
    case "press": {
      const key = String((command && command.key) || "");
      if (!key) throw new Error("A key is required.");
      const el = document.activeElement || document.body;
      for (const type of ["keydown", "keypress", "keyup"]) {
        el.dispatchEvent(new KeyboardEvent(type, { key: key, bubbles: true, cancelable: true }));
      }
      // Enter inside a form should submit it, which is what a person pressing
      // Enter expects; synthetic key events alone do not do that.
      if (key === "Enter" && el.form && typeof el.form.requestSubmit === "function") {
        el.form.requestSubmit();
      }
      return "Pressed " + key + ".";
    }
    case "select": {
      const el = resolve(target);
      setValue(el, String(value == null ? "" : value));
      return "Selected.";
    }
    case "check":
    case "uncheck": {
      const el = resolve(target);
      const want = kind === "check";
      if (el.checked !== want) el.click();
      return want ? "Checked." : "Unchecked.";
    }
    case "hover": {
      const el = resolve(target);
      el.scrollIntoView({ block: "center" });
      el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      return "Hovered.";
    }
    default:
      throw new Error("Unsupported browser command: " + String(kind));
  }
}
