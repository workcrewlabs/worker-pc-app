import { useEffect, useRef, useState } from "react";

// A small custom dropdown styled like the Claude desktop app: a rounded, dark
// popup with a selected checkmark, instead of the unstylable native select
// popup. The menu is absolutely positioned within its wrapper (the composer
// toolbar uses overflow: visible, so it is not clipped) and opens up or down,
// left- or right-aligned. It closes on an outside click or Escape.
//
// An option may carry an optional one-line description shown under its label.

export type DropdownOption<T extends string> = { value: T; label: string; description?: string };

export function Dropdown<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  header,
  direction = "down",
  align = "left"
}: {
  value: T;
  options: DropdownOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  header?: string;
  direction?: "up" | "down";
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    // Close when the user clicks anywhere outside this dropdown, or presses
    // Escape. Nothing here closes on scroll/resize, so a momentary layout change
    // can never snap the menu shut the instant it opens.
    function onPointer(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const menuClass = [
    "wc-dropdown-menu",
    direction === "up" ? "wc-dropdown-up" : "",
    align === "right" ? "wc-dropdown-right" : ""
  ].filter(Boolean).join(" ");

  return (
    <div className="wc-dropdown" ref={rootRef}>
      <button
        type="button"
        className="wc-dropdown-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{current?.label ?? ""}</span>
        <svg className="wc-dropdown-chevron" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className={menuClass} role="listbox" aria-label={ariaLabel}>
          {header && <div className="wc-dropdown-header">{header}</div>}
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={`wc-dropdown-item ${option.value === value ? "is-selected" : ""}`}
              onClick={() => { onChange(option.value); setOpen(false); }}
            >
              <span className="wc-dropdown-item-text">
                <span className="wc-dropdown-item-label">{option.label}</span>
                {option.description && <span className="wc-dropdown-item-desc">{option.description}</span>}
              </span>
              {option.value === value && <span className="wc-dropdown-check" aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
