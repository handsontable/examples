// The API tokens page (DEV-2583, ADR-0037) — mint, see, and revoke the
// persistent credentials that stand in for a broker login in CI.
//
// Wholly undesigned; no frame models any of it (ADR-0023 rule 1). The frame this
// page borrows is Settings': the same top bar with a static pill, the same left
// nav, the same heading, the same card. The judgment calls:
//
//   * The plaintext is shown in a callout above the list, not in a dialog. A
//     dialog is dismissed by a stray Escape, and this is the only moment the
//     token exists — the callout stays until the page is left, and says so.
//   * The list is the whole team's tokens, because revocation is (ADR-0037), and
//     each row names its creator so "whose is this" never needs asking.
//   * Revoked rows stay, greyed, with who killed them. They are the audit trail;
//     hiding them would make the list look like it had never had a problem.
//   * Revoke is confirmed in a `Dialog`, copying My Demos' delete: it breaks
//     something running elsewhere and cannot be undone.
//   * No last-used-precise-time, only the date: the stamp is coarsened to the
//     hour on the server, so rendering minutes would be a lie about precision.
//   * A session running *on* a token gets an explanation instead of the page.
//     Tokens are fenced off token management entirely (ADR-0037), so every
//     control here would 403 — the same reasoning that hides Ask AI and Style
//     from such a session, except this page cannot be hidden: it is reachable by
//     URL, and the account menu row is disabled rather than absent.

import { useEffect, useState, type CSSProperties } from "react";
import {
  Dialog,
  IconCopy,
  SideNav,
  Spinner,
  TopBar,
  formatCreated,
  shellStyles,
  theme,
} from "@handsontable/demo-editor-shell";
import { isTokenSession, login, logout, type User } from "./auth.js";
import { isSessionExpired } from "./apiError.js";
import {
  fetchTokens,
  mintApiToken,
  revokeApiToken,
  type ApiToken,
  type MintedToken,
} from "./tokens.js";
import { useProfile } from "./useProfile.js";
import {
  fieldInput,
  fieldLabel as label,
  ghostButton,
  primaryButton,
} from "./formStyles.js";
import { reportError } from "./sentry.js";

/** What the server accepts (`MAX_TOKEN_NAME` in the Worker's `token.ts`).
 *  Mirrored only to stop the form sending something it knows will 400. */
const MAX_TOKEN_NAME = 64;

/** The display form, and the only one there is — the server has no masking helper
 *  of its own, because it never renders a token. The id is public by design and
 *  the secret is gone the moment the mint response has been read. */
const masked = (id: string) => `hot_pat_${id}_${"•".repeat(8)}`;

export interface ApiTokensPageProps {
  apiBase: string;
  user: User;
}

export function ApiTokensPage({ apiBase, user }: ApiTokensPageProps) {
  const profile = useProfile(apiBase, user.email);
  // Read once: it can only change by a reload (see `App.tsx`).
  const [tokenSession] = useState(isTokenSession);
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  const [name, setName] = useState("");
  // The one and only sight of a plaintext token. Deliberately not persisted
  // anywhere — a reload is meant to lose it, because the server already has.
  const [minted, setMinted] = useState<MintedToken | null>(null);
  const [confirming, setConfirming] = useState<ApiToken | null>(null);
  const [busy, setBusy] = useState<null | "mint" | "revoke">(null);
  // Distinct from `tokens === null`, which means "still loading". A failed read
  // must not render the empty state: this page's whole job is enumerating live
  // credentials, and "No tokens yet" is the one thing it then cannot know.
  const [loadFailed, setLoadFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // A token may not read the listing, and asking anyway would put a 403 on the
    // page under an explanation that already says so.
    if (tokenSession) return;
    let live = true;
    fetchTokens(apiBase)
      .then((list) => { if (live) setTokens(list); })
      .catch((e) => {
        if (!live) return;
        if (isSessionExpired(e)) return login();
        fail(e, "tokens-list");
        setLoadFailed(true);
      });
    return () => { live = false; };
  }, [apiBase, tokenSession]);

  function fail(e: unknown, context: string) {
    reportError(e, context);
    setError(e instanceof Error ? e.message : String(e));
  }

  async function mint(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy("mint");
    setError(null);
    try {
      const created = await mintApiToken(apiBase, trimmed);
      setMinted(created);
      setCopied(false);
      setName("");
      // The mint response is itself a listing row, so the table updates without
      // a second round trip — and `token` is dropped on the way in, so the
      // plaintext lives in exactly one piece of state.
      const { token: _plaintext, ...row } = created;
      setTokens((current) => [row, ...(current ?? [])]);
    } catch (e) {
      if (isSessionExpired(e)) return login();
      fail(e, "tokens-mint");
    } finally {
      setBusy(null);
    }
  }

  async function revoke(target: ApiToken) {
    setBusy("revoke");
    setError(null);
    try {
      await revokeApiToken(apiBase, target.id);
      const now = new Date().toISOString();
      setTokens((current) =>
        (current ?? []).map((row) =>
          row.id === target.id ? { ...row, revoked_at: now, revoked_by: user.email } : row,
        ));
      // The plaintext on screen may be the one just killed; it is no longer
      // worth offering to copy.
      if (minted?.id === target.id) setMinted(null);
      setConfirming(null);
    } catch (e) {
      // Kept on this page rather than swallowed: a revoke that failed because a
      // colleague got there first (404) or because the session went stale (401)
      // must not read as a revoke that worked.
      if (isSessionExpired(e)) return login();
      fail(e, "tokens-revoke");
    } finally {
      setBusy(null);
    }
  }

  async function copy() {
    if (!minted) return;
    try {
      await navigator.clipboard.writeText(minted.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked; the field is selectable, so it can still be copied by hand */
    }
  }

  return (
    <div style={{ ...shellStyles.shell, gridTemplateRows: "auto 1fr" }}>
      <TopBar
        examplePill={
          <div style={shellStyles.examplePill(false)}>
            <span style={shellStyles.pillLabel}>API tokens</span>
          </div>
        }
        accountEmail={user.email}
        accountDisplayName={profile?.display_name}
        accountAvatarUrl={profile?.avatar_url}
        onMyDemos={() => { location.href = "/my-demos"; }}
        onSettings={() => { location.href = "/settings"; }}
        onApiTokens={tokenSession ? undefined : () => { location.href = "/api-tokens"; }}
        onGuide={() => { location.href = "/guide"; }}
        onLogout={() => logout("/")}
      />

      <div style={body}>
        <SideNav active="apiTokens" onLogout={() => logout("/")} />

        <main style={content}>
          <h1 style={heading}>API tokens</h1>
          <p style={intro}>
            A token authenticates against this API the way you do, and never expires — the
            nightly test matrix uses one. It cannot use the AI features, change the
            guardrail settings, or manage tokens. Every token here belongs to the team:
            anyone can see one, and anyone can revoke one.
          </p>

          {tokenSession && (
            <p style={errorText} role="status">
              This page is not available to a session signed in with an API token. A token
              cannot create, list or revoke tokens — sign in with your Google account to
              manage them.
            </p>
          )}

          {error && !confirming && <p style={errorText} role="alert">{error}</p>}

          {minted && (
            <div style={callout} role="status">
              <p style={calloutTitle}>Copy your token now</p>
              <p style={calloutBody}>
                This is the only time it is shown. Once you leave this page there is no way
                to see it again — the server keeps a hash, not the token.
              </p>
              <div style={field}>
                <input
                  style={fieldValue}
                  value={minted.token}
                  readOnly
                  aria-label="Your new API token"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <button
                  type="button"
                  className="hot-icon-btn"
                  style={copyButton}
                  onClick={() => void copy()}
                  aria-label="Copy the new API token"
                  title={copied ? "Copied" : "Copy"}
                >
                  <IconCopy />
                </button>
              </div>
            </div>
          )}

          {!tokenSession && (
          <form style={card} onSubmit={(e) => void mint(e)}>
            <label style={label} htmlFor="hot-token-name">Name</label>
            <input
              id="hot-token-name"
              style={input}
              value={name}
              placeholder="nightly e2e"
              maxLength={MAX_TOKEN_NAME}
              onChange={(e) => setName(e.target.value)}
            />
            <p style={hint}>
              What this token is for, so the next person can tell whether revoking it will
              break something.
            </p>
            <div style={cardFooter}>
              {/* Also inert until the listing has landed: minting first would
                  prepend the new row, then the in-flight GET would resolve and
                  replace state with the pre-mint snapshot, dropping the token
                  whose plaintext is still on screen. */}
              <button
                type="submit"
                style={primaryButton}
                disabled={busy !== null || !name.trim() || (tokens === null && !loadFailed)}
              >
                {busy === "mint" ? <Spinner size={14} /> : "Create token"}
              </button>
            </div>
          </form>
          )}

          {tokenSession
            ? null
            : loadFailed
            ? <p style={muted}>The token list could not be loaded. Reload to try again.</p>
            : tokens === null
            ? <p style={muted}><Spinner size={14} /> Loading tokens…</p>
            : tokens.length === 0
              ? <p style={muted}>No tokens yet.</p>
              : (
                <ul style={list}>
                  {tokens.map((token) => (
                    <TokenRow
                      key={token.id}
                      token={token}
                      busy={busy !== null}
                      onRevoke={() => setConfirming(token)}
                    />
                  ))}
                </ul>
              )}
        </main>
      </div>

      {confirming && (
        <Dialog
          title="Revoke this token?"
          onClose={() => { if (busy !== "revoke") setConfirming(null); }}
        >
          {error && <p style={errorText} role="alert">{error}</p>}
          <p style={confirmBody}>
            <strong>{confirming.name}</strong> stops working on its very next request.
            Anything using it — a nightly workflow, a script, somebody's shell — starts
            failing with 401. This can't be undone; mint a new token instead.
          </p>
          <div style={confirmFooter}>
            <button
              type="button"
              style={dangerButton}
              onClick={() => void revoke(confirming)}
              disabled={busy === "revoke"}
            >
              {busy === "revoke" ? "Revoking…" : "Revoke"}
            </button>
            {/* `data-autofocus`, not React's `autoFocus`: `Dialog` focuses the
                content's first focusable from an effect that runs *after* the
                layout-phase autoFocus, so it would win and land focus on Revoke
                — where Enter or Space revokes a live credential without the
                question having been answered. The marker is the hatch Dialog
                documents for exactly this, and what every other destructive
                confirm in the app uses. */}
            <button
              type="button"
              style={ghostButton}
              onClick={() => setConfirming(null)}
              disabled={busy === "revoke"}
              data-autofocus
            >
              Cancel
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function TokenRow({
  token,
  busy,
  onRevoke,
}: {
  token: ApiToken;
  busy: boolean;
  onRevoke: () => void;
}) {
  const revoked = token.revoked_at !== null;
  return (
    <li style={row(revoked)}>
      <div style={rowMain}>
        <span style={rowName}>{token.name}</span>
        <code style={rowId}>{masked(token.id)}</code>
      </div>
      <div style={rowMeta}>
        <span>{token.created_by}</span>
        <span>created {formatCreated(token.created_at) ?? token.created_at}</span>
        <span>
          {token.last_used_at
            ? `last used ${formatCreated(token.last_used_at) ?? token.last_used_at}`
            : "never used"}
        </span>
        {revoked && (
          <span style={revokedTag}>
            revoked{token.revoked_by ? ` by ${token.revoked_by}` : ""}
          </span>
        )}
      </div>
      {!revoked && (
        <button type="button" style={rowAction} onClick={onRevoke} disabled={busy}>
          Revoke
        </button>
      )}
    </li>
  );
}

// ---- styles ----------------------------------------------------------------
// The frame is Settings' (`114:26833`) — same body grid, same content padding,
// same heading and card. Only what this page adds is spelled out.

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
  margin: `0 0 ${theme.space(2)}`,
  fontFamily: theme.font.ui,
  fontSize: 20,
  fontWeight: 600,
  color: theme.color.text,
};

const intro: CSSProperties = {
  maxWidth: 620,
  margin: `0 0 ${theme.space(4)}`,
  fontFamily: theme.font.ui,
  fontSize: 13,
  lineHeight: 1.5,
  color: theme.color.textMuted,
};

const card: CSSProperties = {
  maxWidth: 520,
  padding: theme.space(4),
  borderRadius: theme.radius.md,
  background: theme.color.surfaceMuted,
};

const cardFooter: CSSProperties = { display: "flex", marginTop: theme.space(4) };

const input: CSSProperties = { ...fieldInput, boxSizing: "border-box" };

const hint: CSSProperties = {
  margin: `${theme.space(2)} 0 0`,
  fontFamily: theme.font.ui,
  fontSize: 12,
  lineHeight: 1.45,
  color: theme.color.textMuted,
};

// `accent`, not `danger`: minting is not a warning, it is a one-time reveal. The
// border is what stops it reading as another card.
const callout: CSSProperties = {
  maxWidth: 620,
  marginBottom: theme.space(4),
  padding: theme.space(4),
  border: `1px solid ${theme.color.accent}`,
  borderRadius: theme.radius.md,
  background: theme.color.surfaceMuted,
};

const calloutTitle: CSSProperties = {
  margin: `0 0 ${theme.space(1)}`,
  fontFamily: theme.font.ui,
  fontSize: 13,
  fontWeight: 600,
  color: theme.color.text,
};

const calloutBody: CSSProperties = {
  margin: `0 0 ${theme.space(3)}`,
  fontFamily: theme.font.ui,
  fontSize: 12.5,
  lineHeight: 1.45,
  color: theme.color.textMuted,
};

// `controlBorder`, not `border`: this is an outlined control on `surfaceSunken`,
// and in dark those two tokens are #353535 against #222222 — the plain `border`
// reads as no edge at all, on the one field that has to stay obvious after a
// mint. The shared `fieldInput` uses `controlBorder` for exactly this reason
// (Bugbot, #252).
const field: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: theme.space(1),
  padding: `0 ${theme.space(1)} 0 ${theme.space(3)}`,
  border: `1px solid ${theme.color.controlBorder}`,
  borderRadius: theme.radius.md,
  background: theme.color.surfaceSunken,
};

const fieldValue: CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: 32,
  border: "none",
  outline: "none",
  background: "transparent",
  color: theme.color.text,
  fontFamily: theme.font.mono,
  fontSize: 12.5,
};

const copyButton: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
  flex: "0 0 auto",
  border: "none",
  borderRadius: theme.radius.sm,
  color: theme.color.textMuted,
  cursor: "pointer",
};

const list: CSSProperties = {
  maxWidth: 620,
  margin: `${theme.space(4)} 0 0`,
  padding: 0,
  listStyle: "none",
  display: "flex",
  flexDirection: "column",
  gap: theme.space(2),
};

const row = (revoked: boolean): CSSProperties => ({
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  gridTemplateRows: "auto auto",
  alignItems: "center",
  gap: `${theme.space(1)} ${theme.space(3)}`,
  padding: theme.space(3),
  borderRadius: theme.radius.md,
  background: theme.color.surfaceMuted,
  // Greyed rather than hidden: a revoked row is the audit trail.
  opacity: revoked ? 0.6 : 1,
});

const rowMain: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: theme.space(2),
  minWidth: 0,
};

const rowName: CSSProperties = {
  fontFamily: theme.font.ui,
  fontSize: 13,
  fontWeight: 600,
  color: theme.color.text,
};

const rowId: CSSProperties = {
  fontFamily: theme.font.mono,
  fontSize: 12,
  color: theme.color.textMuted,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const rowMeta: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: `0 ${theme.space(3)}`,
  gridColumn: "1",
  fontFamily: theme.font.ui,
  fontSize: 12,
  color: theme.color.textMuted,
};

const revokedTag: CSSProperties = { color: theme.color.danger };

const rowAction: CSSProperties = {
  ...ghostButton,
  gridColumn: "2",
  gridRow: "1 / span 2",
};

const muted: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: theme.space(2),
  marginTop: theme.space(4),
  fontFamily: theme.font.ui,
  fontSize: 13,
  color: theme.color.textMuted,
};

const errorText: CSSProperties = {
  margin: `0 0 ${theme.space(3)}`,
  fontFamily: theme.font.ui,
  fontSize: 13,
  color: theme.color.danger,
};

const confirmBody: CSSProperties = {
  margin: 0,
  fontFamily: theme.font.ui,
  fontSize: 13,
  lineHeight: 1.5,
  color: theme.color.textMuted,
};

const confirmFooter: CSSProperties = {
  display: "flex",
  gap: theme.space(2),
  marginTop: theme.space(5),
};

const dangerButton: CSSProperties = {
  ...ghostButton,
  border: `1px solid ${theme.color.danger}`,
  background: theme.color.danger,
  color: theme.color.accentContrast,
  fontWeight: 600,
};
