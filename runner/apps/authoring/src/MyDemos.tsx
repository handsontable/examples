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

import {
  useCallback,
  useEffect,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  Dialog,
  MenuButton,
  IconDotsVertical,
  IconPlus,
  SideNav,
  Spinner,
  TopBar,
  formatCreated,
  shellStyles,
  theme,
} from "@handsontable/demo-editor-shell";
import { getEntry } from "./catalog.js";
import { Markdown } from "./markdown.js";
import { filterByOwner, ownerNameFromSlug, ownerOptions } from "./demoOwners.js";
import { getToken, logout, type User } from "./auth.js";
import { displayNameFromEmail, initialFromEmail } from "./displayName.js";
import { fieldInput, fieldLabel, formFooter, ghostButton, primaryButton } from "./formStyles.js";
import { useProfile } from "./useProfile.js";
import { reportError } from "./sentry.js";

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
  /** Whose demo this is (DEV-2506). Present in both scopes; on `all` it is what
   *  decides whether a card is editable. */
  created_by: string;
}

/** In-flight action **per demo id**, not one global slot.
 *
 *  A single slot looked adequate because each card disables its own kebab — but
 *  it only disables *its own*. Starting a fork on a second card while the first
 *  is still running overwrote the slot, dropping the first card's spinner, and
 *  whichever request settled first cleared the other one's state too. */
type BusyMap = Record<string, "fork" | "delete">;

export interface MyDemosPageProps {
  apiBase: string;
  user: User;
  /** `mine` (the default) or `all` — the team's demos, read-only except your own
   *  (DEV-2506). One page for both: the grid, the cards and every action are the
   *  same, and a second page would be the copy that drifts. */
  scope?: "mine" | "all";
}

export function MyDemosPage({ apiBase, user, scope = "mine" }: MyDemosPageProps) {
  const [demos, setDemos] = useState<DemoListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<BusyMap>({});
  const [confirming, setConfirming] = useState<DemoListItem | null>(null);
  /** The Import dialog (DEV-2504) — a URL prompt, nothing more: the fetch itself
   *  happens once, in the playground, off the `?import=` param. */
  const [importing, setImporting] = useState(false);
  /** `?owner=<local-part>` on `/all-demos` (DEV-2519). Seeded from the URL so a
   *  filtered view is a link, and written back with `replaceState` — a filter is
   *  not a navigation. */
  const [owner, setOwner] = useState(() =>
    scope === "all" ? (new URLSearchParams(location.search).get("owner") ?? "").toLowerCase() : "",
  );

  const markBusy = (id: string, what: "fork" | "delete") =>
    setBusy((b) => ({ ...b, [id]: what }));
  const clearBusy = (id: string) =>
    setBusy((b) => {
      const { [id]: _gone, ...rest } = b;
      return rest;
    });

  const load = useCallback(async () => {
    setError(null);
    const token = getToken();
    try {
      const res = await fetch(`${apiBase}/api/demos?scope=${scope}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        throw new Error(
          scope === "all"
            ? `Couldn't load the team's demos (${res.status}).`
            : `Couldn't load your demos (${res.status}).`,
        );
      }
      const data = (await res.json()) as { demos: DemoListItem[] };
      setDemos(data.demos);
    } catch (e) {
      reportError(e, "my-demos-list");
      setDemos([]);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [apiBase, scope]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Revoke. The endpoint has never hard-deleted — it sets `revoked=1` and the row
   *  stays. Reflected locally rather than refetched: the list is `updated_at DESC`
   *  and a refetch would reorder the grid under the user's cursor. */
  async function remove(demo: DemoListItem) {
    markBusy(demo.id, "delete");
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
      // no-op. Say so instead. Reported too: a non-OK response is as silent
      // server-side as a network error and needs the same visibility.
      reportError(e, "demo-revoke");
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      clearBusy(demo.id);
      // Only if this demo's dialog is still the one open. An unconditional clear
      // would close a confirmation the user had since opened for a *different*
      // card, when this request happened to settle underneath it.
      setConfirming((cur) => (cur?.id === demo.id ? null : cur));
    }
  }

  /** There is no fork endpoint — `forked_from` is bookkeeping the client sets at
   *  create time. So a fork is: read the source snapshot, POST it back as a new
   *  demo. Same two calls `App.tsx`'s `onFork` makes. */
  async function fork(demo: DemoListItem) {
    markBusy(demo.id, "fork");
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
      reportError(e, "demo-fork");
      setError(e instanceof Error ? e.message : String(e));
      clearBusy(demo.id);
    }
    // No `finally`: the success path navigates away, and clearing `busy` first
    // would flash the card back to idle mid-navigation.
  }

  // The author line's name and monogram. The profile supplies both once it
  // resolves (DEV-2166); until then — and for a user who never saved one — the
  // address itself does, by the same rule the server applies, so the line does
  // not visibly change under the reader when the fetch lands.
  const profile = useProfile(apiBase, user.email);
  const ownerName = profile?.display_name ?? displayNameFromEmail(user.email);
  const ownerInitial = profile?.initial ?? initialFromEmail(user.email);
  const ownerAvatar = profile?.avatar_url ?? null;

  // Both from the loaded rows: the options are whoever is actually in this list,
  // and the grid renders the subset. Client-side because the scope's listing is
  // already here — a round trip to hide cards would be slower and no more correct.
  const ownerChoices = useMemo(() => ownerOptions(demos ?? [], displayNameFromEmail), [demos]);
  const visibleDemos = useMemo(() => filterByOwner(demos ?? [], owner), [demos, owner]);

  const chooseOwner = useCallback((next: string) => {
    setOwner(next);
    const url = new URL(location.href);
    if (next) url.searchParams.set("owner", next);
    else url.searchParams.delete("owner");
    history.replaceState(null, "", url.pathname + url.search);
  }, []);

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
            <span style={shellStyles.pillLabel}>{scope === "all" ? "All demos" : "My Demos"}</span>
          </div>
        }
        accountEmail={user.email}
        accountDisplayName={profile?.display_name}
        accountAvatarUrl={ownerAvatar}
        onMyDemos={() => { location.href = "/my-demos"; }}
        onSettings={() => { location.href = "/settings"; }}
        onGuide={() => { location.href = "/guide"; }}
        // Never a bare reload here: `/my-demos` answers a null user with
        // `login()`, so logging out in place would re-enter the broker.
        onLogout={() => logout("/")}
      />

      <div style={body}>
        <SideNav active={scope === "all" ? "allDemos" : "myDemos"} onLogout={() => logout("/")} />

        <main style={content}>
          {error && <p style={errorText} role="alert">{error}</p>}

          {!demos && <div style={loading}><Spinner size={20} /><span>Loading your demos…</span></div>}

          {/* Only on the team list: My demos has exactly one owner, so a filter
              there would be furniture. */}
          {scope === "all" && demos && demos.length > 0 && (
            <div style={filterBar}>
              <span style={filterLabel}>Owner</span>
              <MenuButton
                ariaLabel="Filter demos by owner"
                title="Show one person's demos"
                options={ownerChoices}
                value={owner}
                onSelect={chooseOwner}
              >
                {ownerChoices.find((choice) => choice.value === owner)?.label ?? "Everyone"}
              </MenuButton>
            </div>
          )}

          {demos && (
            <div style={grid}>
              {visibleDemos.map((d) => {
                // Ownership is compared here, not trusted from the scope: the
                // team list contains your own demos too, and those stay editable.
                const mine = d.created_by === user.email;
                return (
                  <DemoCard
                    key={d.id}
                    demo={d}
                    mine={mine}
                    // Your own profile only names your own demos. Someone else's
                    // card falls back to their address (`displayNameFromEmail`) —
                    // fetching a profile per card would be a request per row for a
                    // name that is already derivable.
                    ownerName={mine ? ownerName : displayNameFromEmail(d.created_by)}
                    ownerInitial={mine ? ownerInitial : initialFromEmail(d.created_by)}
                    ownerAvatar={mine ? ownerAvatar : null}
                    busy={busy[d.id] ?? null}
                    onCopyLink={() => void copyLink(d)}
                    onFork={() => void fork(d)}
                    onDelete={() => setConfirming(d)}
                  />
                );
              })}
              {/* Only on your own list: Create and Import belong where your demos
                  are; the team list is for looking at what exists. */}
              {scope === "mine" && (
                <>
                  <CreateTile />
                  <ImportTile onClick={() => setImporting(true)} />
                </>
              )}
            </div>
          )}

          {/* Simple, per the DEV-2163 decision: one line beside the Create tile,
              no illustration. The tile is already the call to action. */}
          {/* A filter that matches nothing is not an empty listing: the generic line
              would read as "nobody has saved anything", which is wrong and
              confusing when you have just picked a name. */}
          {demos && demos.length > 0 && visibleDemos.length === 0 && !error && (
            <p style={emptyText}>No demos from {ownerNameFromSlug(owner, displayNameFromEmail)}.</p>
          )}

          {demos && demos.length === 0 && !error && (
            scope === "all" ? (
              <p style={emptyText}>Nobody has saved a demo yet.</p>
            ) : (
              <p style={emptyText}>
                No demos yet. Open an example, edit it, and fork it to save your first one — or
                import one from JSFiddle or StackBlitz. The{" "}
                <a href="/guide" style={{ color: theme.color.accentText }}>guide</a> walks through
                both.
              </p>
            )
          )}
        </main>
      </div>

      {/* Every dismissal is withheld once the DELETE is in flight — Cancel, the X,
          Escape and the scrim all route through `onClose`.

          Not an oversight dressed up: aborting the fetch would not un-revoke
          anything. The worker has the request, and `AbortController` only stops
          the client listening for the answer. A Cancel that left the demo revoked
          would be a worse lie than a button that briefly refuses. It settles in
          one round trip and the label says what is happening. */}
      {importing && <ImportDialog onClose={() => setImporting(false)} />}

      {confirming && (
        <Dialog
          title="Delete this demo?"
          onClose={() => {
            if (busy[confirming.id] === "delete") return;
            setConfirming(null);
          }}
        >
          <p style={confirmBody}>
            <strong>{confirming.title}</strong> will stop resolving: its share link starts
            returning 410 and anyone holding it loses access. This can't be undone.
          </p>
          <div style={confirmFooter}>
            <button
              type="button"
              style={dangerButton}
              onClick={() => void remove(confirming)}
              disabled={busy[confirming.id] === "delete"}
            >
              {busy[confirming.id] === "delete" ? "Deleting…" : "Delete"}
            </button>
            {/* Focus lands here, not on Delete: the destructive control is first
                in the DOM, and focusing it would make Space or Enter delete the
                demo the dialog exists to ask about. */}
            <button
              type="button"
              data-autofocus
              style={ghostButton}
              onClick={() => setConfirming(null)}
              disabled={busy[confirming.id] === "delete"}
            >
              Cancel
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function DemoCard({
  demo,
  mine,
  ownerName,
  ownerInitial,
  ownerAvatar,
  busy,
  onCopyLink,
  onFork,
  onDelete,
}: {
  demo: DemoListItem;
  /** Owned by the signed-in user? Read-only when false (DEV-2506). */
  mine: boolean;
  ownerName: string;
  ownerInitial: string;
  ownerAvatar: string | null;
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
            mine={mine}
            busy={busy}
            onCopyLink={onCopyLink}
            onFork={onFork}
            onDelete={onDelete}
          />
        )}
      </header>

      <div style={cardBody}>
        <h2 style={cardTitle}>{demo.title}</h2>
        {/* Markdown, clamped to the frame's three lines (DEV-2507). No expand
            affordance here: the card is a link to the demo, and the sidebar there
            shows the whole thing. */}
        {demo.description && (
          <div style={cardDescription} data-testid="card-description">
            <Markdown text={demo.description} />
          </div>
        )}
      </div>

      <footer style={cardFoot}>
        {/* The frame's author line. Every row in this list is the caller's own —
            `GET /api/demos` is hardcoded `WHERE created_by = <caller>` — so the
            owner is known without the API returning one, which it doesn't:
            `created_by` is an email and `publicView` strips it. Name and picture
            now come from the caller's own profile (DEV-2166), falling back to
            the email's local part and the same monogram the account menu draws.
            Note this is still the *caller*, not the demo's author: on a shared
            demo page there is no shell code to render one at all. */}
        <span style={author}>
          <span style={authorMark} aria-hidden="true">
            {ownerAvatar ? <img src={ownerAvatar} alt="" style={authorImage} /> : ownerInitial}
          </span>
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
  mine,
  busy,
  onCopyLink,
  onFork,
  onDelete,
}: {
  demo: DemoListItem;
  mine: boolean;
  busy: "fork" | "delete" | null;
  onCopyLink: () => void;
  onFork: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  /** Open upwards when there isn't room below. */
  const [dropUp, setDropUp] = useState(false);

  // The grid scrolls (`main` is `overflow-y: auto`), so a card near the bottom
  // opens its menu past the fold — measured at 631px against a 620px pane. The
  // pane can be scrolled to reach it, but a menu that appears off-screen reads
  // as broken. Measure the real popover rather than assume a height: the row
  // count is fixed today but the menu is not.
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = wrapRef.current?.getBoundingClientRect();
    const menu = popRef.current?.getBoundingClientRect();
    if (!trigger || !menu) return;
    const pane = wrapRef.current?.closest("main")?.getBoundingClientRect();
    const limit = Math.min(pane?.bottom ?? Infinity, window.innerHeight);
    // Only flip if flipping actually helps — on a very short viewport neither
    // direction fits and dropping up would just clip against the top instead.
    const fitsBelow = trigger.bottom + menu.height <= limit;
    const fitsAbove = trigger.top - menu.height >= (pane?.top ?? 0);
    setDropUp(!fitsBelow && fitsAbove);
  }, [open]);

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
        <div ref={popRef} style={cardPopover(dropUp)} role="menu">
          {/* Someone else's demo opens in the read-only playground: browse the
              code, try changes, download a zip — but no Save, and no version
              change. `/edit/:id` would offer a Save the API refuses (403). */}
          <a
            href={mine ? `/edit/${demo.id}` : `/share/${demo.id}`}
            role="menuitem"
            className="hot-menu-row"
            style={cardMenuRow()}
          >
            Open
          </a>
          <button type="button" role="menuitem" className="hot-menu-row" style={cardMenuRow()} onClick={act(onCopyLink)}>
            Copy link
          </button>
          {/* Fork stays on every card, and is the *point* of seeing other
              people's: it mints a demo owned by you. */}
          <button type="button" role="menuitem" className="hot-menu-row" style={cardMenuRow()} onClick={act(onFork)}>
            Fork
          </button>
          {/* Rename and Delete are the owner's alone. Rendering them disabled was
              the alternative; a menu of two dead rows explains nothing that their
              absence doesn't. */}
          {mine && (
            <>
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
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** `114:26723`. Points at the blank starter (DEV-2499), not the playground's
 *  default: "Create" means starting from nothing, and the playground opens the
 *  React *showcase* — sample data, ten plugins, two helper modules. The
 *  playground is still one pick away for anyone who wanted that instead. */
function CreateTile() {
  return (
    <a href="/?example=blank" style={createTile}>
      <IconPlus size={24} />
      <span style={createLabel}>Create</span>
    </a>
  );
}

/** Beside Create: the other way to get a workspace that is not a fork. */
function ImportTile({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} style={{ ...createTile, border: "none" }}>
      <IconPlus size={24} />
      <span style={createLabel}>Import</span>
    </button>
  );
}

/**
 * Paste a JSFiddle or StackBlitz URL. This does not import anything itself — it
 * hands the URL to the playground as `?import=`, which is where the workspace
 * lives and where the one `POST /api/import` happens. One fetch, one code path,
 * and the result is a shareable URL rather than dialog state.
 */
function ImportDialog({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState("");
  const trimmed = url.trim();
  // Client-side host check only, and only to keep the obvious mistake from
  // costing a round trip — the Worker's `resolveSource` is the real gate.
  const looksSupported = /^https:\/\/(www\.)?(jsfiddle\.net|stackblitz\.com)\//i.test(trimmed);
  const isCodeSandbox = /^https:\/\/(www\.)?codesandbox\.io\//i.test(trimmed);

  return (
    <Dialog title="Import a project" onClose={onClose}>
      <label htmlFor="import-url" style={fieldLabel}>
        JSFiddle or StackBlitz URL
      </label>
      <input
        id="import-url"
        data-autofocus
        style={fieldInput}
        placeholder="https://jsfiddle.net/1bw9tphk/1/"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && looksSupported) go(trimmed);
        }}
      />
      <p style={importHint}>
        {isCodeSandbox
          ? "CodeSandbox blocks automated reads. Export the sandbox to a .zip there, then drag its files onto the FILES panel."
          : "The project opens as an unsaved workspace — review it, then Save to keep it."}
      </p>
      <div style={formFooter}>
        <button
          type="button"
          style={primaryButton}
          disabled={!looksSupported}
          onClick={() => go(trimmed)}
        >
          Import
        </button>
        <button type="button" style={ghostButton} onClick={onClose}>
          Cancel
        </button>
      </div>
    </Dialog>
  );
}

/** A full navigation, not a router push: the playground reads `?import=` on mount. */
function go(url: string) {
  location.href = `/?import=${encodeURIComponent(url)}`;
}

// ---- styles ----------------------------------------------------------------

const body: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "320px minmax(0, 1fr)",
  minHeight: 0,
  overflow: "hidden",
};

/** The card menu's separator. Same rule the shared `SideNav` draws — it was one
 *  constant when the nav lived here, and both are one line. */
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
// would outrank `.hot-demo-card:hover` (ADR-0026 — the shorthand carries
// `border-color`, so it wins over a rule naming only the longhand). A revoked
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

const cardPopover = (dropUp: boolean): CSSProperties => ({
  position: "absolute",
  ...(dropUp ? { bottom: "100%" } : { top: "100%" }),
  right: 0,
  zIndex: 30,
  width: 120,
  padding: theme.space(1),
  borderRadius: theme.radius.md,
  border: `1px solid ${theme.color.border}`,
  background: theme.color.surfaceRaised,
  boxShadow: theme.shadow.popover,
});

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

/** The frame gives the description exactly three lines.
 *
 *  Height, not `-webkit-line-clamp`: since DEV-2507 the description is *rendered
 *  markdown*, so the box's children are blocks (`p`, `ul`, a heading). Line-clamp
 *  only counts the line boxes of an inline formatting context — with block
 *  children it clamps unreliably or not at all, which let a multi-paragraph
 *  description stretch the card and with it the grid row. Three 20px lines is the
 *  same three lines, and it holds whatever the content is. */
const cardDescription: CSSProperties = {
  margin: `${theme.space(1)} 0 0`,
  fontFamily: theme.font.ui,
  fontSize: 12,
  lineHeight: "20px",
  color: theme.color.textMuted,
  maxHeight: 60,
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
  overflow: "hidden",
};

const authorImage: CSSProperties = {
  width: "100%",
  height: "100%",
  // Centre-crop: there is no crop UI, so a non-square upload has to be made
  // circular on render or it stretches.
  objectFit: "cover",
  display: "block",
};

const createdText: CSSProperties = { whiteSpace: "nowrap" };

/** One row above the grid. `space(2)` off the cards, so the control reads as part
 *  of the listing rather than as page chrome. */
const filterBar: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: theme.space(2),
  padding: `0 ${theme.space(2)} ${theme.space(2)}`,
};

const filterLabel: CSSProperties = {
  fontFamily: theme.font.ui,
  fontSize: 12,
  color: theme.color.textMuted,
};

const importHint: CSSProperties = {
  margin: `${theme.space(2)} 0 0`,
  fontFamily: theme.font.ui,
  fontSize: 12,
  lineHeight: 1.5,
  color: theme.color.textMuted,
};

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

// The delete confirmation's buttons are the shared pair — it is the same dialog
// footer as Edit info, and its local copy still outlined with `border`, which in
// dark is `surfaceRaised`: Cancel rendered as bare text inside the dialog.
const dangerButton: CSSProperties = {
  ...ghostButton,
  border: `1px solid ${theme.color.danger}`,
  background: theme.color.danger,
  color: theme.color.accentContrast,
  fontWeight: 600,
};
