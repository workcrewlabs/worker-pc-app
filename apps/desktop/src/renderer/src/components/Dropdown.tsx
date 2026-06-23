import { useEffect, useRef, useState } from "react";

// A small custom dropdown styled like the Claude desktop app: a rounded, dark
// popup with a selected checkmark, instead of the unstylable native select
// popup. The menu is positioned with fixed coordinates measured from the
// trigger, so it is never clipped by a parent's overflow. Closes on outside
// click, Escape, scroll, or resize.

export type DropdownOption<T extends string> = { value: T; label: string };

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
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const current = options.find((option) => option.value === value);

  function place() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const style: React.CSSProperties = { position: "fixed", minWidth: Math.max(190, Math.round(rect.width)) };
    if (direction === "up") style.bottom = Math.round(window.innerHeight - rect.top + 6);
    else style.top = Math.round(rect.bottom + 6);
    if (align === "right") style.right = Math.round(window.innerWidth - rect.right);
    else style.left = Math.round(rect.left);
    setMenuStyle(style);
  }

  function toggle() {
    if (!open) place();
    setOpen((value) => !value);
  }

  useEffect(() => {
    if (!open) return;
    function onPointer(event: MouseEvent) {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    function onReflow() {
      setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  }, [open]);

  return (
    <div className="wc-dropdown">
      <button
        ref={triggerRef}
        type="button"
        className="wc-dropdown-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={toggle}
      >
        <span>{current?.label ?? ""}</span>
        <svg className="wc-dropdown-chevron" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div ref={menuRef} className="wc-dropdown-menu" role="listbox" aria-label={ariaLabel} style={menuStyle}>
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
              <span>{option.label}</span>
              {option.value === value && <span className="wc-dropdown-check" aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
