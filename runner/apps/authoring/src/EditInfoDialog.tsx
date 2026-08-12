import { useState, type CSSProperties } from "react";
import { Dialog, Spinner, theme } from "@handsontable/demo-editor-shell";
import {
  fieldInput as input,
  fieldLabel as label,
  fieldTextarea as textarea,
  formFooter as footer,
  ghostButton as ghost,
  primaryButton as primary,
} from "./formStyles.js";
import { reportError } from "./sentry.js";

/** Title + description editor for a saved demo, built to `114:24410`.
 *
 *  Before T9 these were two bare inputs sitting in the authed action bar, always
 *  visible and saved implicitly with the rest of the workspace. The frame makes
 *  them a dialog behind the BOX INFO pencil (`114:21684`), with an explicit
 *  Save/Cancel — so edits are now committed or discarded, not ambient.
 *
 *  Save *writes* (DEV-2495). It used to lift the drafts into the workspace and
 *  mark it dirty, leaving the actual PATCH to the top bar's Save — deliberately,
 *  on the grounds that code and metadata are one snapshot and saving here would
 *  rebuild twice. That reasoning was wrong: `PATCH /api/demos/:id` only rebuilds
 *  when the body carries `files` (`workers/api/src/index.ts`), and the branch
 *  this sends to is a plain row update. Meanwhile a button labelled Save that
 *  silently staged lost the edit whenever the tab closed first, and made My
 *  demos' **Rename** — which is this dialog, opened by `?edit=info` — a no-op.
 *
 *  Cancel and the title row's X both discard: the draft lives in local state and
 *  is only sent on Save. */
export function EditInfoDialog({
  apiBase,
  demoId,
  token,
  title,
  description,
  onSave,
  onClose,
}: {
  apiBase: string;
  demoId: string;
  /** Bearer for the PATCH; the endpoint is owner-only. */
  token: string | null;
  title: string;
  description: string;
  /** The server took it. The parent holds the same two fields for the pill, the
   *  BOX INFO rows and its own workspace save, so it is told what landed. */
  onSave: (next: { title: string; description: string }) => void;
  onClose: () => void;
}) {
  const [draftTitle, setDraftTitle] = useState(title);
  const [draftDescription, setDraftDescription] = useState(description);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Every way out of the dialog, in-flight-aware. `Dialog` routes Escape, the
   *  scrim and the X to one `onClose` with no notion of a pending request, so
   *  without this the three of them could unmount the card mid-PATCH — a failure
   *  would then have nowhere to report, and a late success would still apply to
   *  the workspace after the user had asked to get out. Cancel is disabled while
   *  busy for the same reason; this is the other three routes. */
  const dismiss = () => { if (!busy) onClose(); };

  // The API rejects an empty title (400), and the frame shows no error state, so
  // the affordance is a disabled button rather than a message. A *failed write*
  // is a different thing and does get a message — see below.
  const valid = draftTitle.trim().length > 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || busy) return;
    // Normalised once, then both sent and lifted. Trimming on the way out but
    // lifting the raw draft would leave the parent holding "   " for a
    // description the server stored as NULL — and the example pill renders
    // `title={description || undefined}`, so the divergence shows up as a
    // tooltip made of spaces.
    const next = { title: draftTitle.trim(), description: draftDescription.trim() };
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/demos/${demoId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        // No `files`: that key is what makes the endpoint rebuild the snapshot.
        // Metadata alone is one UPDATE and no container.
        body: JSON.stringify({ title: next.title, description: next.description || null }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `save failed (${res.status})`);
      }
      onSave(next);
      onClose();
    } catch (err) {
      // Stays open, draft intact. Closing on a failed write would look exactly
      // like the staging bug this dialog was fixed for: dismissed, nothing saved.
      reportError(err, "demo-info-save");
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Edit info" onClose={dismiss}>
      <form onSubmit={submit}>
        {error && <p style={errorText} role="alert">{error}</p>}

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
          <button type="submit" style={primary} disabled={!valid || busy}>
            {busy ? <Spinner size={14} /> : "Save"}
          </button>
          <button type="button" style={ghost} onClick={dismiss} disabled={busy}>
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

/** Matches the Settings page's failed-save notice, for the same reason the
 *  fields match: one form look. */
const errorText: CSSProperties = {
  margin: `0 0 ${theme.space(3)}`,
  padding: theme.space(3),
  borderRadius: theme.radius.md,
  border: `1px solid ${theme.color.dangerBorder}`,
  fontFamily: theme.font.ui,
  fontSize: 13,
  color: theme.color.danger,
};
