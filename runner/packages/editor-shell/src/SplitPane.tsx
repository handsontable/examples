// The draggable editor/preview seam (`85:9970` dark, `85:16935` light — both are
// the *drag* state; at rest this is just the 1px boundary the editor column used
// to carry as a `borderRight`).
//
// The ratio is a fraction of the **whole body**, sidebar track included, which is
// what keeps the seam still when the sidebar is toggled (`styles.ts`'s `body`).
import {
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { s, SIDEBAR_WIDTH, SPLITTER_HIT_SLOP, SPLIT_VAR } from "./styles.js";
import { SPLIT_STORAGE_KEY } from "./theme.js";

/** The designed split — the preview starts at x=864 of 1728 (`72:15697`). */
export const SPLIT_DEFAULT = 0.5;

/** Hard bounds, whatever the viewport. */
const MIN_FRACTION = 0.2;
const MAX_FRACTION = 0.8;
/** Neither pane goes below this while the viewport has room for both. Narrow
 *  viewports are T9's; here the hard bounds simply win. */
const MIN_PANE = 320;
/** Arrow-key step. */
const STEP = 0.02;

const bound = (f: number) => Math.min(MAX_FRACTION, Math.max(MIN_FRACTION, f));

const asWidth = (f: number) => `${(f * 100).toFixed(3)}%`;

/** Restore an earlier session's ratio. Mirrors `useTheme`'s `storedChoice()`:
 *  storage can be disabled outright, and a junk value must not win. */
function storedFraction(): number {
  try {
    const raw = Number.parseFloat(localStorage.getItem(SPLIT_STORAGE_KEY) ?? "");
    return Number.isFinite(raw) ? bound(raw) : SPLIT_DEFAULT;
  } catch {
    return SPLIT_DEFAULT; // private mode / storage disabled
  }
}

/** Hard bounds *plus* the px minima, using the width the drag already measured. */
function clampToPanes(f: number, width: number, sidebarOpen: boolean): number {
  const lo = Math.max(MIN_FRACTION, MIN_PANE / width);
  // The editor keeps whatever the sidebar and the 1px splitter leave it.
  const hi = Math.min(MAX_FRACTION, (width - (sidebarOpen ? SIDEBAR_WIDTH : 0) - 1 - MIN_PANE) / width);
  if (hi < lo) return bound(f); // too narrow for both minima
  return Math.min(hi, Math.max(lo, f));
}

export interface SplitPane {
  /** Goes on the body grid — the drag measures against it and writes onto it. */
  bodyRef: RefObject<HTMLDivElement | null>;
  /** Merge into `s.body(...)`: carries the ratio as the custom property. */
  bodyStyle: CSSProperties;
  fraction: number;
  dragging: boolean;
  /** Paint the accent seam: hovered, focused, or being dragged. */
  active: boolean;
  setHovered: (hovered: boolean) => void;
  setFocused: (focused: boolean) => void;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  endDrag: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  reset: () => void;
}

/**
 * Owns the ratio: restore, clamp, drag, persist.
 *
 * The ratio reaches the DOM two ways on purpose. React renders it as an inline
 * custom property, so the restored value is on the grid in the *first* paint —
 * a layout effect could not do that reliably, since a child's layout effect runs
 * before its ancestor's ref is attached and the write would silently no-op.
 * A drag then writes the same property straight onto the node, because
 * re-rendering per pointermove would walk the keyed CodeMirror instance
 * (ADR-0016) and the preview pane. State and `localStorage` are touched once, on
 * `pointerup`, at which point React re-renders the value the DOM already shows.
 */
export function useSplitPane(sidebarOpen: boolean): SplitPane {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [fraction, setFraction] = useState(storedFraction);
  const [dragging, setDragging] = useState(false);
  // Two flags, not one: the accent bar is the *only* focus affordance (a focus
  // ring on a 1px track is a slit), so a pointer passing over and off a focused
  // separator must not take the keyboard user's indicator with it.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  /** The live value mid-drag, which state deliberately does not track. */
  const live = useRef(fraction);

  const write = useCallback((f: number) => {
    live.current = f;
    bodyRef.current?.style.setProperty(SPLIT_VAR, asWidth(f));
  }, []);

  const commit = useCallback(
    (f: number) => {
      write(f);
      setFraction(f);
      try {
        localStorage.setItem(SPLIT_STORAGE_KEY, f.toFixed(4));
      } catch {
        // Not persisted, still applied for this session.
      }
    },
    [write],
  );

  /** The fraction a pointer at `clientX` asks for, clamped. */
  const fractionAt = useCallback(
    (clientX: number): number | null => {
      const rect = bodyRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return null;
      return clampToPanes((rect.right - clientX) / rect.width, rect.width, sidebarOpen);
    },
    [sidebarOpen],
  );

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection dragged out of the pane under the press
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  }, []);

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      const next = fractionAt(e.clientX);
      if (next !== null) write(next);
    },
    [dragging, fractionAt, write],
  );

  const endDrag = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      // Recompute hover from where the pointer actually is rather than trusting a
      // `pointerleave` to arrive. During the drag the hit target is the overlay,
      // a descendant, so the separator never gets one; releasing capture makes the
      // browser re-derive boundary events, and Chromium does fire the leave — but
      // a clamped drag ends with the pointer far from the seam, and an engine that
      // skipped that would leave the accent painted at rest.
      const rect = e.currentTarget.getBoundingClientRect();
      setHovered(
        e.clientX >= rect.left - SPLITTER_HIT_SLOP &&
          e.clientX <= rect.right + SPLITTER_HIT_SLOP &&
          e.clientY >= rect.top &&
          e.clientY <= rect.bottom,
      );
      setDragging(false);
      commit(live.current);
    },
    [commit, dragging],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      // Left grows the preview, right grows the editor — the seam follows the key.
      const delta = e.key === "ArrowLeft" ? STEP : e.key === "ArrowRight" ? -STEP : 0;
      if (delta === 0 && e.key !== "Home") return;
      e.preventDefault();
      const want = e.key === "Home" ? SPLIT_DEFAULT : live.current + delta;
      const rect = bodyRef.current?.getBoundingClientRect();
      commit(rect && rect.width > 0 ? clampToPanes(want, rect.width, sidebarOpen) : bound(want));
    },
    [commit, sidebarOpen],
  );

  return {
    bodyRef,
    bodyStyle: { [SPLIT_VAR]: asWidth(fraction) } as CSSProperties,
    fraction,
    dragging,
    active: dragging || hovered || focused,
    setHovered,
    setFocused,
    onPointerDown,
    onPointerMove,
    endDrag,
    onKeyDown,
    reset: useCallback(() => commit(SPLIT_DEFAULT), [commit]),
  };
}

export interface SplitHandleProps {
  split: SplitPane;
}

/** The 1px track, its widened hit area, the accent bar, and the drag overlay. */
export function SplitHandle({ split }: SplitHandleProps) {
  return (
    <div
      style={s.splitter}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the editor and preview"
      aria-valuenow={Math.round(split.fraction * 100)}
      aria-valuemin={Math.round(MIN_FRACTION * 100)}
      aria-valuemax={Math.round(MAX_FRACTION * 100)}
      tabIndex={0}
      // Stable selector for the e2e suite, on the `data-preview-status` precedent:
      // a machine-readable hook that a restyle cannot break.
      data-splitter=""
      data-dragging={split.dragging}
      onPointerDown={split.onPointerDown}
      onPointerMove={split.onPointerMove}
      onPointerUp={split.endDrag}
      onPointerCancel={split.endDrag}
      onKeyDown={split.onKeyDown}
      onDoubleClick={split.reset}
      onFocus={() => split.setFocused(true)}
      onBlur={() => split.setFocused(false)}
      onPointerEnter={() => split.setHovered(true)}
      onPointerLeave={() => split.setHovered(false)}
    >
      <div style={s.splitterBar(split.active)} />
      <div style={s.splitterHit} />
      {split.dragging && <div style={s.splitterOverlay} />}
    </div>
  );
}
