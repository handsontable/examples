import { useEffect, useRef } from "react";

/**
 * Grow a composer textarea with its content, up to the `max-height` its class
 * carries (`.hot-chat-input`, 128px — six lines of 12/20).
 *
 * Both composers ship `rows={1}`, so without this the field stays one line tall
 * and a long question scrolls inside a 44px slot with `resize: none` removing
 * the manual way out. The `max-height` in the stylesheet only clamps a height
 * that something sets; nothing did.
 *
 * Keyed on the *value* rather than an input handler so a programmatic reset —
 * the send path clearing the box — shrinks the field back down too.
 */
export function useAutoGrow(value: string) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // `auto` first, or `scrollHeight` reports the height already set and the
    // field can only ever grow. The stylesheet's `min-height` floors the empty
    // case and `max-height` caps the long one, which is where the textarea's
    // own scrollbar takes over.
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return ref;
}
