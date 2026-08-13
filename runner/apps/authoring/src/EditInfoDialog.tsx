import { useState } from "react";
import { Dialog, theme } from "@handsontable/demo-editor-shell";
import { MarkdownField, MAX_DESCRIPTION } from "./MarkdownField.js";
import {
  fieldInput as input,
  fieldLabel as label,
  formFooter as footer,
  ghostButton as ghost,
  primaryButton as primary,
} from "./formStyles.js";

/** Title + markdown description editor for a saved demo, built to `114:24410`.
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

  // The API rejects an empty title and an over-long description (both 400), and
  // the frame shows no error state, so the affordance is a disabled button. The
  // description's length is reported by the field itself, which is where the
  // number is useful.
  const valid = draftTitle.trim().length > 0 && draftDescription.length <= MAX_DESCRIPTION;

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

        {/* Markdown, several paragraphs if it wants to be (DEV-2507). The toolbar
            is what makes typing the syntax unnecessary; the preview renders through
            the same component the demo pages use. */}
        <div style={{ marginTop: theme.space(4) }}>
          <MarkdownField
            id="hot-edit-description"
            label="Description"
            value={draftDescription}
            onChange={setDraftDescription}
          />
        </div>

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

// The field and button styles live in `formStyles.ts` — the Settings page
// (DEV-2166) is the second surface to want them, and a second copy is how the
// two start disagreeing.
