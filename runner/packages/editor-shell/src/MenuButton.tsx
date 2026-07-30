// Label + chevron trigger with a popover listbox — the shape the design gives
// the version and framework pickers (`72:16737`, `72:16741`). A native <select>
// cannot draw a chevron of our own, so the row-2 pills are built by hand.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { IconChevronDown } from "./icons/index.js";
import { s } from "./styles.js";

export interface MenuOption {
  value: string;
  label: string;
}

export interface MenuButtonProps {
  /** Accessible name for the trigger — the visible label is often abbreviated. */
  ariaLabel: string;
  /** Trigger content: plain text, or an icon + text for the framework pill. */
  children: ReactNode;
  options: MenuOption[];
  value: string;
  onSelect: (value: string) => void;
  title?: string;
  disabled?: boolean;
}

export function MenuButton({
  ariaLabel,
  children,
  options,
  value,
  onSelect,
  title,
  disabled,
}: MenuButtonProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Dismiss on outside click / Escape. Registered only while open so the shell
  // isn't holding document listeners for every closed menu on the bar.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} style={{ position: "relative", flex: "0 0 auto" }}>
      <button
        type="button"
        className="hot-icon-btn"
        style={s.menuButton}
        onClick={() => setOpen((o) => !o)}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={title}
        disabled={disabled}
      >
        {children}
        <IconChevronDown />
      </button>

      {open && (
        <div style={s.menuPopover} role="listbox" aria-label={ariaLabel}>
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              style={s.menuItem(o.value === value)}
              onClick={() => {
                setOpen(false);
                if (o.value !== value) onSelect(o.value);
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
