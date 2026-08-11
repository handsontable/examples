// The Settings page (`114:26833`) — the page behind the row T9 drew greyed out.
//
// Frame: the same top bar with a static "Settings" pill (the chevron `114:26884`
// is hidden there, so the label is text, not a trigger), the same left nav as My
// Demos with Settings active, an "Settings" heading, and one 252px card holding
// Name, Description and an avatar row.
//
// Undesigned, dev judgment (ADR-0023 rule 1):
//   * Save/Cancel — the card has no room for buttons and the frame draws none,
//     but `EditInfoDialog` established explicit commit for exactly this kind of
//     edit in T9 ("committed or discarded, not ambient"), and autosave-on-blur
//     would make a mistyped name a silent write. The pair sits below the card.
//   * The avatar saves immediately instead. Staging a File through Save would
//     mean holding the blob, a second failure path, and an object-URL preview
//     that lies about what is stored — for a control whose whole content is one
//     round trip.
//   * In-flight and error states — no frame models either, and both an upload
//     and a save can fail.
//   * First visit with no row: the fields are empty and the placeholder shows
//     what will be used instead (the email's local part).

import { useRef, useState, type CSSProperties } from "react";
import {
  SideNav,
  Spinner,
  TopBar,
  shellStyles,
  theme,
} from "@handsontable/demo-editor-shell";
import { logout, type User } from "./auth.js";
import {
  removeAvatar,
  saveProfile,
  uploadAvatar,
  type Profile,
} from "./profile.js";
import { useProfile } from "./useProfile.js";
import {
  fieldInput,
  fieldLabel as label,
  fieldTextarea,
  formFooter as footer,
  ghostButton,
  primaryButton,
} from "./formStyles.js";
import { reportError } from "./sentry.js";

/** What the server accepts. Mirrored here only to stop the form sending
 *  something it already knows will 400 — the server is still the authority. */
const MAX_DISPLAY_NAME = 64;
const MAX_DESCRIPTION = 280;

export interface SettingsPageProps {
  apiBase: string;
  user: User;
}

export function SettingsPage({ apiBase, user }: SettingsPageProps) {
  const loaded = useProfile(apiBase, user.email);
  // Only this page's own writes. Seeding it from the cache would pin the form to
  // the cached row for the lifetime of the page — `loaded` would never be shown
  // — and `useProfile` already seeds itself from the same cache, so first paint
  // is instant either way.
  const [saved, setSaved] = useState<Profile | null>(null);
  const profile = saved ?? loaded;

  const [draft, setDraft] = useState<{ name: string; description: string } | null>(null);
  const [busy, setBusy] = useState<null | "save" | "upload" | "remove">(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // The draft is null until the user types: the profile arrives asynchronously,
  // and seeding state from it on mount would either show empty fields until the
  // fetch landed or clobber typing that started before it did.
  const name = draft?.name ?? profile?.saved_name ?? "";
  const description = draft?.description ?? profile?.description ?? "";
  const edit = (patch: Partial<{ name: string; description: string }>) =>
    setDraft({ name, description, ...patch });

  const dirty = draft !== null
    && (draft.name !== (profile?.saved_name ?? "") || draft.description !== (profile?.description ?? ""));

  const fallbackName = user.email.split("@")[0] ?? user.email;
  const initial = profile?.initial ?? (name.trim()[0] ?? user.email.trim()[0] ?? "?").toUpperCase();

  function settle(next: Profile, message: string) {
    setSaved(next);
    setDraft(null);
    setStatus(message);
  }

  function fail(e: unknown, context: string) {
    reportError(e, context);
    setError(e instanceof Error ? e.message : String(e));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy("save");
    setError(null);
    setStatus(null);
    try {
      // Empty means "clear it" — the server stores NULL and goes back to the
      // derived default, which is why the placeholder shows what that will be.
      settle(
        await saveProfile(apiBase, {
          display_name: name.trim() || null,
          description: description.trim() || null,
        }),
        "Saved.",
      );
    } catch (err) {
      fail(err, "profile-save");
    } finally {
      setBusy(null);
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Clear the input either way: picking the same file twice in a row fires no
    // change event otherwise, so a failed upload could not be retried.
    e.target.value = "";
    if (!file) return;
    setBusy("upload");
    setError(null);
    setStatus(null);
    try {
      settle(await uploadAvatar(apiBase, file), "Avatar updated.");
    } catch (err) {
      fail(err, "profile-avatar-upload");
    } finally {
      setBusy(null);
    }
  }

  async function onRemove() {
    setBusy("remove");
    setError(null);
    setStatus(null);
    try {
      settle(await removeAvatar(apiBase), "Avatar removed.");
    } catch (err) {
      fail(err, "profile-avatar-remove");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ ...shellStyles.shell, gridTemplateRows: "auto 1fr" }}>
      <TopBar
        examplePill={
          <div style={shellStyles.examplePill(false)}>
            <span style={shellStyles.pillLabel}>Settings</span>
          </div>
        }
        accountEmail={user.email}
        accountDisplayName={profile?.display_name}
        accountAvatarUrl={profile?.avatar_url}
        onMyDemos={() => { location.href = "/my-demos"; }}
        onSettings={() => { location.href = "/settings"; }}
        // Public target, always: this page answers a null user with `login()`,
        // so a bare reload would walk the user who just logged out straight back
        // into the broker (see `auth.ts`).
        onLogout={() => logout("/")}
      />

      <div style={body}>
        <SideNav active="settings" onLogout={() => logout("/")} />

        <main style={content}>
          <h1 style={heading}>Settings</h1>

          {error && <p style={errorText} role="alert">{error}</p>}
          {status && !error && <p style={statusText} role="status">{status}</p>}

          <form style={card} onSubmit={submit}>
            <label style={label} htmlFor="hot-profile-name">Name</label>
            <input
              id="hot-profile-name"
              style={input}
              value={name}
              placeholder={fallbackName}
              maxLength={MAX_DISPLAY_NAME}
              onChange={(e) => edit({ name: e.target.value })}
            />

            <label style={{ ...label, marginTop: theme.space(4) }} htmlFor="hot-profile-description">
              Description
            </label>
            <textarea
              id="hot-profile-description"
              style={textarea}
              value={description}
              rows={3}
              maxLength={MAX_DESCRIPTION}
              onChange={(e) => edit({ description: e.target.value })}
            />

            {/* The avatar row is not part of the form's submit: Upload and Remove
                each complete on their own. `type="button"` on both, or Enter in
                the Name field would fire whichever came first. */}
            <div style={avatarRow}>
              <span style={avatarPreview} aria-hidden="true">
                {profile?.avatar_url
                  ? <img src={profile.avatar_url} alt="" style={avatarImage} />
                  : initial}
              </span>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                style={{ display: "none" }}
                onChange={(e) => void onFile(e)}
              />
              <button
                type="button"
                style={ghost}
                onClick={() => fileRef.current?.click()}
                disabled={busy !== null}
              >
                {busy === "upload" ? <Spinner size={14} /> : "Upload"}
              </button>
              <button
                type="button"
                style={ghost}
                onClick={() => void onRemove()}
                disabled={busy !== null || !profile?.avatar_url}
                title={profile?.avatar_url ? "Go back to the monogram" : "No avatar to remove"}
              >
                {busy === "remove" ? <Spinner size={14} /> : "Remove"}
              </button>
            </div>

            <div style={footer}>
              <button type="submit" style={primary} disabled={busy !== null || !dirty}>
                {busy === "save" ? <Spinner size={14} /> : "Save"}
              </button>
              {/* Discards back to what is stored, matching the Edit info dialog:
                  the draft only ever lived in local state. */}
              <button
                type="button"
                style={ghost}
                onClick={() => { setDraft(null); setError(null); setStatus(null); }}
                disabled={busy !== null || !dirty}
              >
                Cancel
              </button>
            </div>
          </form>
        </main>
      </div>
    </div>
  );
}

// ---- styles ----------------------------------------------------------------
// Fields and buttons come from `formStyles.ts` — the Edit info dialog's look,
// which is the app's one established form look. Only the differences this page
// needs are spelled out below.

const body: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "320px minmax(0, 1fr)",
  minHeight: 0,
  overflow: "hidden",
};

const content: CSSProperties = {
  padding: theme.space(4),
  overflowY: "auto",
  background: theme.color.surface,
};

const heading: CSSProperties = {
  margin: `0 0 ${theme.space(4)}`,
  fontFamily: theme.font.ui,
  fontSize: 20,
  fontWeight: 600,
  color: theme.color.text,
};

const card: CSSProperties = {
  maxWidth: 520,
  padding: theme.space(4),
  borderRadius: theme.radius.md,
  background: theme.color.surfaceMuted,
};

// `border-box` on top of the shared field: these sit in a padded card rather
// than a dialog, where `width: 100%` plus horizontal padding would overflow it.
const input: CSSProperties = { ...fieldInput, boxSizing: "border-box" };

// Shorter than the dialog's 88px — the frame's card is 252px and has an avatar
// row to fit under this.
const textarea: CSSProperties = { ...fieldTextarea, boxSizing: "border-box", minHeight: 72 };

const avatarRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: theme.space(3),
  marginTop: theme.space(4),
};

/** 24px per the frame — the same monogram the account menu draws, scaled down. */
const avatarPreview: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 24,
  height: 24,
  flex: "0 0 auto",
  borderRadius: "50%",
  overflow: "hidden",
  background: theme.color.accent,
  color: theme.color.accentContrast,
  fontFamily: theme.font.ui,
  fontSize: 12,
  fontWeight: 600,
  lineHeight: 1,
};

const avatarImage: CSSProperties = {
  width: "100%",
  height: "100%",
  // No crop UI — centre-crop keeps a non-square upload circular.
  objectFit: "cover",
  display: "block",
};

// Every button here can swap its label for a spinner mid-request, so they are
// centred flex boxes with a floor width — otherwise Save and Upload visibly
// shrink the moment they are pressed.
const pending: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 72,
};

const ghost: CSSProperties = { ...ghostButton, ...pending };
const primary: CSSProperties = { ...primaryButton, ...pending };

const errorText: CSSProperties = {
  margin: `0 0 ${theme.space(3)}`,
  padding: theme.space(3),
  borderRadius: theme.radius.md,
  border: `1px solid ${theme.color.dangerBorder}`,
  fontFamily: theme.font.ui,
  fontSize: 13,
  color: theme.color.danger,
};

const statusText: CSSProperties = {
  margin: `0 0 ${theme.space(3)}`,
  padding: `0 ${theme.space(1)}`,
  fontFamily: theme.font.ui,
  fontSize: 13,
  color: theme.color.textMuted,
};
