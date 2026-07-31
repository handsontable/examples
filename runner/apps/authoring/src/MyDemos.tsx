// The My Demos page (`114:25521`) — a route, not the 340px right-hand drawer it
// was before T9.
//
// Frame: left nav (My demos / Settings / a rule / Log out), a centred "My Demos"
// pill in the top bar, and a grid of 334×172 cards. Each card is framework +
// Handsontable version, a kebab, title + description, then author and created
// date. A `+ Create` tile closes the grid.
//
// Undesigned, dev judgment (ADR-0023 rule 1), all confirmed on DEV-2163:
//   * empty state — every frame draws a populated grid
//   * revoked cards — the API only ever revokes, rows persist forever, and no
//     frame draws that state. They stay visible and muted; destructive kebab
//     items go away with them.
//   * the delete confirmation — the kebab says Delete, no frame confirms it, and
//     the pre-T9 drawer fired DELETE on the first click with no prompt at all
//   * loading and error states — the drawer had bare "Loading…" text and
//     swallowed every delete failure silently

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  AccountMenu,
  Dialog,
  IconDotsVertical,
  IconListDetails,
  IconLogin2,
  IconPlus,
  IconSettings2,
  Spinner,
  TopBar,
  formatCreated,
  shellStyles,
  theme,
} from "@handsontable/demo-editor-shell";
import { getEntry } from "./catalog.js";
import { getToken, logout, type User } from "./auth.js";

/** Mirrors the `GET /api/demos` projection. The pre-T9 drawer declared a narrower
 *  shape and threw away `description`, `created_at` and `forked_from` — all three
 *  are on the card in `114:26635`, and all three were already in the response. */
interface DemoListItem {
  id: string;
  title: string;
  description: string | null;
  framework: string;
  tier: number;
  ht_version: string;
  forked_from: string | null;
  visibility: string;
  revoked: number;
  created_at: string;
  updated_at: string;
}

type Busy = { id: string; what: "fork" | "delete" } | null;

export interface MyDemosPageProps {
  apiBase: string;
  user: User;
}

export function MyDemosPage({ apiBase, user }: MyDemosPageProps) {
  const [demos, setDemos] = useState<DemoListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [confirming, setConfirming] = useState<DemoListItem | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const token = getToken();
    try {
      const res = await fetch(`${apiBase}/api/demos`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`Couldn't load your demos (${res.status}).`);
      const data = (await res.json()) as { demos: DemoListItem[] };
      setDemos(data.demos);
    } catch (e) {
      setDemos([]);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [apiBase]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Revoke. The endpoint has never hard-deleted — it sets `revoked=1` and the row
   *  stays. Reflected locally rather than refetched: the list is `updated_at DESC`
   *  and a refetch would reorder the grid under the user's cursor. */
  async function remove(demo: DemoListItem) {
    setBusy({ id: demo.id, what: "delete" });
    setError(null);
    const token = getToken();
    try {
      const res = await fetch(`${apiBase}/api/demos/${demo.id}`, {
        method: "DELETE",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!(res.status === 204 || res.ok)) throw new Error(`Delete failed (${res.status}).`);
      setDemos((cur) => cur?.map((d) => (d.id === demo.id ? { ...d, revoked: 1 } : d)) ?? cur);
    } catch (e) {
      // The drawer's `.catch(() => null)` meant a failed delete looked like a
      // no-op. Say so instead.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  }

  /** There is no fork endpoint — `forked_from` is bookkeeping the client sets at
   *  create time. So a fork is: read the source snapshot, POST it back as a new
   *  demo. Same two calls `App.tsx`'s `onFork` makes. */
  async function fork(demo: DemoListItem) {
    setBusy({ id: demo.id, what: "fork" });
    setError(null);
    const token = getToken();
    try {
      const srcRes = await fetch(`${apiBase}/api/demos/${demo.id}/source`);
      if (!srcRes.ok) throw new Error(`Couldn't read that demo's files (${srcRes.status}).`);
      const src = (await srcRes.json()) as { framework: string; files: Record<string, string> };
      const res = await fetch(`${apiBase}/api/demos`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          framework: src.framework,
          files: src.files,
          title: `${demo.title} - Fork`,
          description: demo.description ?? undefined,
          htVersion: demo.ht_version,
          forkedFrom: demo.id,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Fork failed (${res.status}).`);
      }
      const { id } = (await res.json()) as { id: string };
      location.href = `/edit/${id}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
    // No `finally`: the success path navigates away, and clearing `busy` first
    // would flash the card back to idle mid-navigation.
  }

  // No display name exists anywhere in the stack, so the local part of the email
  // stands in for one on every card's author line.
  const ownerName = user.email.split("@")[0] ?? user.email;
  const ownerInitial = (user.email.trim()[0] ?? "?").toUpperCase();

  async function copyLink(demo: DemoListItem) {
    try {
      await navigator.clipboard.writeText(`${location.origin}/share/${demo.id}`);
    } catch {
      /* clipboard blocked; nothing to fall back to from a menu item */
    }
  }

  return (
    <div style={{ ...shellStyles.shell, gridTemplateRows: "auto 1fr" }}>
      <TopBar
        examplePill={
          <div style={shellStyles.examplePill(false)}>
            <span style={pillLabel}>My Demos</span>
          </div>
        }
        accountEmail={user.email}
        onMyDemos={() => { location.href = "/my-demos"; }}
        onLogout={logout}
      />

      <div style={body}>
        <SideNav />

        <main style={content}>
          {error && <p style={errorText} role="alert">{error}</p>}

          {!demos && <div style={loading}><Spinner size={20} /><span>Loading your demos…</span></div>}

          {demos && (
            <div style={grid}>
              {demos.map((d) => (
                <DemoCard
                  key={d.id}
                  demo={d}
                  ownerName={ownerName}
                  ownerInitial={ownerInitial}
                  busy={busy?.id === d.id ? busy.what : null}
                  onCopyLink={() => void copyLink(d)}
                  onFork={() => void fork(d)}
                  onDelete={() => setConfirming(d)}
                />
              ))}
              <CreateTile />
            </div>
          )}

          {/* Simple, per the DEV-2163 decision: one line beside the Create tile,
              no illustration. The tile is already the call to action. */}
          {demos && demos.length === 0 && !error && (
            <p style={emptyText}>
              No demos yet. Open an example, edit it, and fork it to save your first one.
            </p>
          )}
        </main>
      </div>

      {confirming && (
        <Dialog title="Delete this demo?" onClose={() => setConfirming(null)}>
          <p style={confirmBody}>
            <strong>{confirming.title}</strong> will stop resolving: its share link starts
            returning 410 and anyone holding it loses access. This can't be undone.
          </p>
          <div style={confirmFooter}>
            <button
              type="button"
              style={dangerButton}
              onClick={() => void remove(confirming)}
              disabled={busy?.what === "delete"}
            >
              {busy?.what === "delete" ? "Deleting…" : "Delete"}
            </button>
            <button type="button" style={ghostButton} onClick={() => setConfirming(null)}>
              Cancel
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

/** Left column (`114:26608`). Mirrors the account menu's three entries — same
 *  icons, same order, same disabled Settings. */
function SideNav() {
  return (
    <nav style={sideNav} aria-label="Account">
      <a href="/my-demos" className="hot-menu-row" data-active="true" style={navRow()} aria-current="page">
        <IconListDetails />
        My demos
      </a>
      <button type="button" style={navRow(true)} disabled title="Profile settings are not built yet">
        <IconSettings2 />
        Settings
      </button>
      <div style={navRule} role="separator" />
      <button type="button" className="hot-menu-row" style={navRow()} onClick={logout}>
        <IconLogin2 />
        Log out
      </button>
    </nav>
  );
}

function DemoCard({
  demo,
  ownerName,
  ownerInitial,
  busy,
  onCopyLink,
  onFork,
  onDelete,
}: {
  demo: DemoListItem;
  ownerName: string;
  ownerInitial: string;
  busy: "fork" | "delete" | null;
  onCopyLink: () => void;
  onFork: () => void;
  onDelete: () => void;
}) {
  const revoked = !!demo.revoked;
  const created = formatCreated(demo.created_at);
  // The list gives a framework *key*; the card shows the catalog's display name.
  // A key can outlive its catalog entry, so fall back rather than throw.
  let frameworkLabel = demo.framework;
  try {
    frameworkLabel = getEntry(demo.framework).displayName;
  } catch {
    /* unknown key — show it raw */
  }

  return (
    <article className={revoked ? undefined : "hot-demo-card"} style={card(revoked)}>
      <header style={cardHead}>
        <span style={cardMeta}>
          <span>{frameworkLabel}</span>
          <span>Handsontable {demo.ht_version}</span>
          {revoked && <span style={revokedBadge}>revoked</span>}
        </span>
        {/* No kebab at all on a revoked demo. Every action needs something the
            revoke took away: `getDemoSource` returns null once `revoked` is set
            (`share.ts`), so Open and Rename both land on "This demo is
            unavailable."; Copy link hands out a 410; Fork has no source to read;
            and Delete already happened. A menu of five dead ends is worse than
            no menu. */}
        {!revoked && (
          <CardMenu
            demo={demo}
            busy={busy}
            onCopyLink={onCopyLink}
            onFork={onFork}
            onDelete={onDelete}
          />
        )}
      </header>

      <div style={cardBody}>
        <h2 style={cardTitle}>{demo.title}</h2>
        {demo.description && <p style={cardDescription}>{demo.description}</p>}
      </div>

      <footer style={cardFoot}>
        {/* The frame's author line. Every row in this list is the caller's own —
            `GET /api/demos` is hardcoded `WHERE created_by = <caller>` — so the
            owner is known without the API returning one, which it doesn't:
            `created_by` is an email and `publicView` strips it. Name and picture
            don't exist anywhere, hence the local part and the same monogram the
            account menu draws. */}
        <span style={author}>
          <span style={authorMark} aria-hidden="true">{ownerInitial}</span>
          {ownerName}
        </span>
        {created && <span style={createdText}>Created {created}</span>}
      </footer>
    </article>
  );
}

/** The kebab (`114:27012`): Open / Copy link / Fork / Rename / rule / Delete.
 *
 *  Rename reuses the Edit info dialog rather than growing a second title editor
 *  here — a demo's title and its code are one PATCH, and the dialog already
 *  lives on the edit page. `?edit=info` is what makes it Rename and not a
 *  duplicate of Open: it opens the same page with the dialog already up. */
function CardMenu({
  demo,
  busy,
  onCopyLink,
  onFork,
  onDelete,
}: {
  demo: DemoListItem;
  busy: "fork" | "delete" | null;
  onCopyLink: () => void;
  onFork: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

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

  const act = (fn: () => void) => () => { setOpen(false); fn(); };

  return (
    <div ref={wrapRef} style={{ position: "relative", flex: "0 0 auto" }}>
      <button
        type="button"
        className="hot-icon-btn"
        style={kebab}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${demo.title}`}
        disabled={!!busy}
      >
        {busy ? <Spinner size={16} /> : <IconDotsVertical />}
      </button>

      {open && (
        <div style={cardPopover} role="menu">
          <a href={`/edit/${demo.id}`} role="menuitem" className="hot-menu-row" style={cardMenuRow()}>
            Open
          </a>
          <button type="button" role="menuitem" className="hot-menu-row" style={cardMenuRow()} onClick={act(onCopyLink)}>
            Copy link
          </button>
          <button type="button" role="menuitem" className="hot-menu-row" style={cardMenuRow()} onClick={act(onFork)}>
            Fork
          </button>
          <a href={`/edit/${demo.id}?edit=info`} role="menuitem" className="hot-menu-row" style={cardMenuRow()}>
            Rename
          </a>
          <div style={navRule} role="separator" />
          <button
            type="button"
            role="menuitem"
            className="hot-menu-row"
            data-danger="true"
            style={cardMenuRow(true)}
            onClick={act(onDelete)}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

/** `114:26723`. There is no blank-demo flow — creating one means forking a
 *  catalog example — so the tile goes to the playground. */
function CreateTile() {
  return (
    <a href="/" style={createTile}>
      <IconPlus size={24} />
      <span style={createLabel}>Create</span>
    </a>
  );
}

// ---- styles ----------------------------------------------------------------

const body: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "320px minmax(0, 1fr)",
  minHeight: 0,
  overflow: "hidden",
};

const sideNav: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  padding: theme.space(2),
  borderRight: `1px solid ${theme.color.border}`,
  background: theme.color.surfaceSunken,
  overflowY: "auto",
};

// Enabled rows set no `background` at all: `.hot-menu-row` supplies both the
// transparent base and the hover, and an inline value would outrank the hover
// (open item 16). The disabled row isn't hoverable, so it can carry its own —
// and it must, or the UA's `buttonface` paints a grey slab.
const navRow = (disabled = false): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: theme.space(3),
  height: 44,
  padding: `0 ${theme.space(4)}`,
  border: "none",
  borderRadius: theme.radius.md,
  ...(disabled ? { background: "transparent" } : {}),
  color: disabled ? theme.color.textMuted : theme.color.text,
  opacity: disabled ? 0.5 : 1,
  fontFamily: theme.font.ui,
  fontSize: 13,
  textAlign: "left",
  textDecoration: "none",
  cursor: disabled ? "default" : "pointer",
});

const navRule: CSSProperties = {
  height: 1,
  margin: `${theme.space(2)} ${theme.space(2)}`,
  background: theme.color.border,
};

const content: CSSProperties = {
  padding: theme.space(2),
  overflowY: "auto",
  background: theme.color.surface,
};

/** The frame lays out 334px cards. `auto-fill` rather than a fixed count is the
 *  whole of T9's responsive answer here — no breakpoint frame exists to build to,
 *  and wrapping is free. */
const grid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(300px, 334px))",
  gap: 10,
  alignItems: "start",
};

// No inline `border` on a live card: the shorthand carries `border-color`, which
// would outrank `.hot-demo-card:hover` (open item 16's shape again). A revoked
// card takes no class — nothing on it is interactive — so it carries its own.
const card = (revoked: boolean): CSSProperties => ({
  display: "flex",
  flexDirection: "column",
  minHeight: 172,
  padding: theme.space(4),
  borderRadius: theme.radius.md,
  ...(revoked ? { border: `1px solid ${theme.color.border}` } : {}),
  background: theme.color.surfaceMuted,
  opacity: revoked ? 0.55 : 1,
});

const cardHead: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: theme.space(2),
};

const cardMeta: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: theme.space(3),
  minWidth: 0,
  fontFamily: theme.font.ui,
  fontSize: 12,
  lineHeight: "20px",
  color: theme.color.textMuted,
};

const revokedBadge: CSSProperties = {
  padding: `0 ${theme.space(2)}`,
  borderRadius: theme.radius.sm,
  border: `1px solid ${theme.color.dangerBorder}`,
  color: theme.color.danger,
  fontSize: 11,
};

const kebab: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 24,
  height: 24,
  flex: "0 0 auto",
  marginRight: -4,
  padding: 0,
  border: "none",
  borderRadius: theme.radius.sm,
  color: theme.color.textMuted,
  cursor: "pointer",
};

const cardPopover: CSSProperties = {
  position: "absolute",
  top: "100%",
  right: 0,
  zIndex: 30,
  width: 120,
  padding: theme.space(1),
  borderRadius: theme.radius.md,
  border: `1px solid ${theme.color.border}`,
  background: theme.color.surfaceRaised,
  boxShadow: theme.shadow.popover,
};

// The destructive row sets no `color` either — `.hot-menu-row[data-danger]` owns
// both the resting red and the inverted hover, and an inline colour would leave
// red text on the red fill.
const cardMenuRow = (danger = false): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  width: "100%",
  height: 32,
  padding: `0 ${theme.space(3)}`,
  border: "none",
  borderRadius: theme.radius.sm,
  ...(danger ? {} : { color: theme.color.text }),
  fontFamily: theme.font.ui,
  fontSize: 13,
  textAlign: "left",
  textDecoration: "none",
  whiteSpace: "nowrap",
  cursor: "pointer",
});

const cardBody: CSSProperties = { flex: 1, marginTop: theme.space(3), minWidth: 0 };

const cardTitle: CSSProperties = {
  margin: 0,
  fontFamily: theme.font.ui,
  fontSize: 13,
  fontWeight: 600,
  lineHeight: "20px",
  color: theme.color.text,
};

const cardDescription: CSSProperties = {
  margin: `${theme.space(1)} 0 0`,
  fontFamily: theme.font.ui,
  fontSize: 12,
  lineHeight: "20px",
  color: theme.color.textMuted,
  // The frame gives the description exactly three lines.
  display: "-webkit-box",
  WebkitLineClamp: 3,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
};

const cardFoot: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: theme.space(2),
  marginTop: theme.space(3),
  fontFamily: theme.font.ui,
  fontSize: 12,
  lineHeight: "20px",
  color: theme.color.textMuted,
};

const author: CSSProperties = { display: "flex", alignItems: "center", gap: theme.space(2) };

const authorMark: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 20,
  height: 20,
  borderRadius: "50%",
  flex: "0 0 auto",
  background: theme.color.accent,
  color: theme.color.accentContrast,
  fontSize: 11,
  fontWeight: 600,
  lineHeight: 1,
};

const createdText: CSSProperties = { whiteSpace: "nowrap" };

const createTile: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  justifyContent: "space-between",
  minHeight: 172,
  padding: theme.space(4),
  borderRadius: theme.radius.md,
  border: `1px dashed ${theme.color.border}`,
  color: theme.color.textMuted,
  textDecoration: "none",
};

const createLabel: CSSProperties = { fontFamily: theme.font.ui, fontSize: 13, lineHeight: "20px" };

const loading: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: theme.space(3),
  padding: theme.space(4),
  fontFamily: theme.font.ui,
  fontSize: 13,
  color: theme.color.textMuted,
};

const emptyText: CSSProperties = {
  margin: `${theme.space(4)} 0 0`,
  padding: `0 ${theme.space(2)}`,
  fontFamily: theme.font.ui,
  fontSize: 13,
  color: theme.color.textMuted,
};

const errorText: CSSProperties = {
  margin: `0 0 ${theme.space(3)}`,
  padding: theme.space(3),
  borderRadius: theme.radius.md,
  border: `1px solid ${theme.color.dangerBorder}`,
  fontFamily: theme.font.ui,
  fontSize: 13,
  color: theme.color.danger,
};

const pillLabel: CSSProperties = {
  fontFamily: theme.font.ui,
  fontSize: 13,
  fontWeight: 500,
  color: theme.color.text,
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

const ghostButton: CSSProperties = {
  height: 32,
  padding: `0 ${theme.space(3)}`,
  border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.md,
  background: theme.color.surface,
  color: theme.color.text,
  fontFamily: theme.font.ui,
  fontSize: 13,
  cursor: "pointer",
};

const dangerButton: CSSProperties = {
  ...ghostButton,
  border: `1px solid ${theme.color.danger}`,
  background: theme.color.danger,
  color: theme.color.accentContrast,
  fontWeight: 600,
};
