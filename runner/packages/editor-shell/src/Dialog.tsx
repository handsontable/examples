// Modal dialog shell — scrim, card, title row, close button (DEV-2163 / T9).
//
// Built to the two After Login dialog frames, which are the same card at the same
// width with different contents: `114:23289` (Share this demo) and `114:24410`
// (Edit info). Both draw a 356px card, 24px padding, a 12px radius, an 18px
// semibold title and a bare `tabler-icon-x` in the top-right corner.
//
// This exists because there was no dialog primitive at all: `ShareLinks` and
// `MyDemos` each hand-rolled an overlay with duplicated style objects, and
// neither had `role="dialog"`, a focus trap, or an Escape handler. The frames
// don't specify any of that — it's the part a frame can't draw.

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import { IconX } from "./icons/index.js";
import { theme } from "./theme.js";

/** Everything focusable we might trap, in DOM order. */
const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  /** Rendered in the title row and wired to `aria-labelledby`. */
  title: string;
  /** Escape, the scrim, and the close button all route here. */
  onClose: () => void;
  children: ReactNode;
  /** Card width in px. Both designed dialogs use the default. */
  width?: number;
}

export function Dialog({ title, onClose, children, width = 356 }: DialogProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  /** Just the caller's content, so initial focus can skip the close button. */
  const contentRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  // Read once, on mount: by the time we restore, the trigger may be the only
  // sensible target and `document.activeElement` will be inside the card.
  const returnTo = useRef<HTMLElement | null>(null);

  /** Tab order: everything focusable in the card, close button included. */
  const focusables = useCallback(
    () => Array.from(cardRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []),
    [],
  );

  useEffect(() => {
    returnTo.current = document.activeElement as HTMLElement | null;
    // Deliberately *not* `focusables()[0]`. The close button lives in the title
    // row, above `children`, so it is always first in the DOM — and landing there
    // means Edit info and Rename open with focus on the X: typing does nothing,
    // and Space dismisses the dialog instead of entering a character.
    //
    // Prefer whatever the content marks `data-autofocus`, else its first
    // focusable, else the close button, else the card. Never nothing, or the
    // first Tab escapes to the page behind the scrim.
    //
    // The `data-autofocus` hatch exists for destructive confirms: their first
    // content control is the destructive one, and landing there means Space or
    // Enter carries out the thing being confirmed. They point it at Cancel.
    const content = Array.from(
      contentRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
    );
    const marked = contentRef.current?.querySelector<HTMLElement>("[data-autofocus]");
    (marked ?? content[0] ?? focusables()[0] ?? cardRef.current)?.focus();
    return () => returnTo.current?.focus?.();
  }, [focusables]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      // Cycle within the card. Without this, Tab walks into the page behind the
      // scrim, which is still fully interactive to a keyboard.
      const items = focusables();
      const active = document.activeElement;
      const inside = !!cardRef.current?.contains(active);

      // Nothing focusable left — every control disabled — so park on the card
      // rather than letting Tab leave. Same reason as the branch below.
      if (items.length === 0) {
        e.preventDefault();
        cardRef.current?.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;

      // Focus outside the card is reachable without the user ever tabbing out:
      // disabling the control that had focus drops it to <body>. The delete
      // confirmation does exactly that — pressing Delete disables both Delete
      // and Cancel while the request is in flight. Pull it back on *either*
      // direction; handling only Shift+Tab let a forward Tab walk into the page
      // behind the scrim while dismissal was still blocked.
      if (!inside) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose, focusables]);

  return (
    <div style={overlay} onMouseDown={onClose}>
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{ ...card, width }}
        // mousedown, not click: a drag that starts inside the card and releases on
        // the scrim would otherwise close it — losing whatever was being typed.
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={titleRow}>
          <h2 id={titleId} style={heading}>
            {title}
          </h2>
          <button
            type="button"
            className="hot-icon-btn"
            style={closeButton}
            onClick={onClose}
            aria-label="Close dialog"
          >
            <IconX size={20} />
          </button>
        </div>
        <div ref={contentRef}>{children}</div>
      </div>
    </div>
  );
}

const overlay: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 1000,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: theme.space(4),
  background: theme.color.scrim,
};

const card: CSSProperties = {
  maxWidth: "100%",
  maxHeight: "100%",
  overflowY: "auto",
  padding: theme.space(6),
  borderRadius: theme.radius.lg,
  background: theme.color.surfaceRaised,
  boxShadow: theme.shadow.dialog,
  color: theme.color.text,
  fontFamily: theme.font.ui,
  outline: "none",
};

const titleRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: theme.space(3),
  marginBottom: theme.space(5),
};

const heading: CSSProperties = {
  margin: 0,
  fontSize: 18,
  fontWeight: 600,
  color: theme.color.text,
};

// No inline `background`: it would outrank `.hot-icon-btn:hover` in the app's
// global block (plan open item 16, "applies to T5–T9").
const closeButton: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
  flex: "0 0 auto",
  marginRight: -4,
  padding: 0,
  border: "none",
  borderRadius: theme.radius.md,
  color: theme.color.textMuted,
  cursor: "pointer",
};
