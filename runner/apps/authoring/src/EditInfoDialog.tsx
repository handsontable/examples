import { useState } from "react";
import { Dialog, theme } from "@handsontable/demo-editor-shell";

/** Title + description editor for a saved demo, built to `114:24410`.
 *
 *  Before T9 these were two bare inputs sitting in the authed action bar, always
 *  visible and saved implicitly with the rest of the workspace. The frame makes
 *  them a dialog behind the BOX INFO pencil (`114:21684`), with an explicit
 *  Save/Cancel — so edits are now committed or discarded, not ambient.
 *
 *  Cancel and the title row's X both discard: the draft lives in local state and
 *  is only lifted on Save. */
export function EditInfoDialog({
  title,
  description,
  onSave,
  onClose,
}: {
  title: string;
  description: string;
  onSave: (next: { title: string; description: string }) => void;
  onClose: () => void;
}) {
  const [draftTitle, setDraftTitle] = useState(title);
  const [draftDescription, setDraftDescription] = useState(description);

  // The API rejects an empty title (400), and the frame shows no error state, so
  // the affordance is a disabled button rather than a message.
  const valid = draftTitle.trim().length > 0;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    onSave({ title: draftTitle.trim(), description: draftDescription });
  }

  return (
    <Dialog title="Edit info" onClose={onClose}>
      <form onSubmit={submit}>
        <label style={label} htmlFor="hot-edit-title">
          Title
        </label>
        <input
          id="hot-edit-title"
          style={input}
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          required
        />

        <label style={{ ...label, marginTop: theme.space(4) }} htmlFor="hot-edit-description">
          Description
        </label>
        <textarea
          id="hot-edit-description"
          style={textarea}
          value={draftDescription}
          onChange={(e) => setDraftDescription(e.target.value)}
          rows={4}
        />

        <div style={footer}>
          <button type="submit" style={primary} disabled={!valid}>
            Save
          </button>
          <button type="button" style={ghost} onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

const label: React.CSSProperties = {
  display: "block",
  marginBottom: theme.space(2),
  fontSize: 13,
  color: theme.color.text,
};

const input: React.CSSProperties = {
  width: "100%",
  height: 36,
  padding: `0 ${theme.space(3)}`,
  border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.md,
  background: theme.color.surfaceSunken,
  color: theme.color.text,
  fontFamily: theme.font.ui,
  fontSize: 13,
};

const textarea: React.CSSProperties = {
  ...input,
  height: "auto",
  minHeight: 88,
  padding: theme.space(3),
  resize: "vertical",
  lineHeight: 1.5,
};

// Save then Cancel, left-aligned — the frame's order, which is not the ordering
// the old dialog used (right-aligned, Done last).
const footer: React.CSSProperties = {
  display: "flex",
  gap: theme.space(2),
  marginTop: theme.space(5),
};

const ghost: React.CSSProperties = {
  height: 32,
  padding: `0 ${theme.space(3)}`,
  border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.md,
  // Outline-only per the frames — `surface` painted a black block on the
  // `surfaceRaised` card in dark, invisible in light where the two collapse.
  background: "transparent",
  color: theme.color.text,
  fontFamily: theme.font.ui,
  fontSize: 13,
  cursor: "pointer",
};

const primary: React.CSSProperties = {
  ...ghost,
  border: `1px solid ${theme.color.accent}`,
  background: theme.color.accent,
  color: theme.color.accentContrast,
  fontWeight: 600,
};
