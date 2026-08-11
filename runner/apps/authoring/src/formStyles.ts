// The app's one form look, built to `114:24410` and reused by every surface that
// asks the user to type something: the Edit info dialog and the Settings page.
//
// Lifted out of `EditInfoDialog.tsx` when the second consumer arrived rather
// than copied — a third set of near-identical inputs is how the two stop
// matching. Values are unchanged from the dialog's originals; anything a given
// surface needs on top (a different `minHeight`, `boxSizing` inside a card) is
// spread over these at the call site.

import { theme } from "@handsontable/demo-editor-shell";

export const fieldLabel: React.CSSProperties = {
  display: "block",
  marginBottom: theme.space(2),
  fontSize: 13,
  color: theme.color.text,
};

// `controlBorder`, not `border`. In dark, `border` *is* `surfaceRaised`
// (#222222), so a field outlined with it disappears completely inside a `Dialog`
// and is barely there on the Settings card (#19191c) — the same failure DEV-2209
// fixed on the top bar. `controlBorder` (#353535) is the token for anything the
// user is meant to see the edge of.
export const fieldInput: React.CSSProperties = {
  width: "100%",
  height: 36,
  padding: `0 ${theme.space(3)}`,
  border: `1px solid ${theme.color.controlBorder}`,
  borderRadius: theme.radius.md,
  background: theme.color.surfaceSunken,
  color: theme.color.text,
  fontFamily: theme.font.ui,
  fontSize: 13,
};

export const fieldTextarea: React.CSSProperties = {
  ...fieldInput,
  height: "auto",
  minHeight: 88,
  padding: theme.space(3),
  resize: "vertical",
  lineHeight: 1.5,
};

/** Save then Cancel, left-aligned — the frame's order, which is not the ordering
 *  the pre-T9 dialog used (right-aligned, Done last). */
export const formFooter: React.CSSProperties = {
  display: "flex",
  gap: theme.space(2),
  marginTop: theme.space(5),
};

export const ghostButton: React.CSSProperties = {
  height: 32,
  padding: `0 ${theme.space(3)}`,
  // `controlBorder` for the reason above, and most acutely here: the button is
  // transparent, so the outline is the entire control. With `border` in dark,
  // Cancel / Upload / Remove render as bare floating text.
  border: `1px solid ${theme.color.controlBorder}`,
  borderRadius: theme.radius.md,
  // Outline-only per the frames — `surface` painted a black block on the
  // `surfaceRaised` card in dark, invisible in light where the two collapse.
  background: "transparent",
  color: theme.color.text,
  fontFamily: theme.font.ui,
  fontSize: 13,
  cursor: "pointer",
};

export const primaryButton: React.CSSProperties = {
  ...ghostButton,
  border: `1px solid ${theme.color.accent}`,
  background: theme.color.accent,
  color: theme.color.accentContrast,
  fontWeight: 600,
};
