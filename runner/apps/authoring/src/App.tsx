import { useCallback, useEffect, useRef, useState } from "react";
import {
  EditorShell,
  FullBar,
  markUrl,
  PreviewStatusBar,
  shellStyles,
  Spinner,
  theme,
  TopBar,
  useLogoUrl,
  type PreviewStatus,
} from "@handsontable/demo-editor-shell";
import {
  applyHandsontableCss,
  applyHandsontableVersion,
  deriveDocsBucketCandidate,
  isNextPrereleaseVersion,
  validateHandsontableVersion,
  type CatalogEntry,
  type DemoRuntime,
  type FilesMap,
} from "@handsontable/demo-runtime";
import { SandpackRuntime } from "@handsontable/demo-runtime/sandpack";
import { ContainerRuntime, ContainerBootFailure } from "@handsontable/demo-runtime/container";
import { zipSync, strToU8 } from "fflate";
import { catalog, getEntry, fetchVersions, checkVersionExists, VERSION_OPTIONS, DEFAULT_VERSION } from "./catalog.js";
import {
  fetchDocsManifest,
  loadDocsExample,
  type DocsManifest,
  type DocsManifestItem,
} from "./docs-catalog.js";
import { DocsCascader, type CascaderLeaf } from "./DocsCascader.js";
import { currentUser, login, logout, getToken, type User } from "./auth.js";
import { ShareLinks } from "./ShareLinks.js";
import { EditInfoDialog } from "./EditInfoDialog.js";
import { MyDemosPage } from "./MyDemos.js";

const SANDPACK_BUNDLER_URL = import.meta.env.VITE_SANDPACK_BUNDLER_URL || undefined;
const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8787";

// Framework preference (used to auto-pick a variant when an example is chosen and
// the current one isn't available) + short labels for the framework picker.
const FW_PREF = ["react", "typescript", "javascript", "vue", "angular"];
const FW_LABEL: Record<string, string> = {
  javascript: "JavaScript",
  typescript: "TypeScript",
  react: "React",
  vue: "Vue",
  angular: "Angular",
};
// Runner framework → Handsontable docs URL prefix (TypeScript shares the JS docs).
const FW_DOCS: Record<string, string> = {
  javascript: "javascript-data-grid",
  typescript: "javascript-data-grid",
  react: "react-data-grid",
  vue: "vue-data-grid",
  angular: "angular-data-grid",
};

/** Numeric major of a plain release version (e.g. "17.1.0" -> 17), or null for
 * next-dist-tag / pkg.pr.new / non-release refs, which are never floor-checked. */
function releaseMajor(version: string): number | null {
  if (isNextPrereleaseVersion(version)) return null;
  const m = /^(\d+)\./.exec(version.trim());
  return m ? Number(m[1]) : null;
}

/** A starter may declare a minimum core major (e.g. the UI-library starters need
 * the themes API added in Handsontable 17); hide lower published majors from its
 * version picker. next/custom refs (major null) always pass through. */
function versionsForEntry(options: string[], minCoreMajor: number | null): string[] {
  if (minCoreMajor == null) return options;
  return options.filter((v) => {
    const major = releaseMajor(v);
    return major == null || major >= minCoreMajor;
  });
}

/** Public documentation page URL for a docs example. */
function docsPageUrl(framework: string, permalink: string): string {
  const prefix = FW_DOCS[framework] ?? "javascript-data-grid";
  return `https://handsontable.com/docs/${prefix}${permalink}/`;
}

/** Turn a raw runtime error into a message that explains container prerequisites. */
function describeRuntimeError(e: unknown, engine: string, version: string): string {
  // A boot-script failure carries its own real (and possibly multiline) log
  // text — show it verbatim rather than running it through the connectivity
  // heuristic below, which would otherwise misfire on words like "fetching"
  // that pnpm's own error output happens to contain.
  if (e instanceof ContainerBootFailure) return e.message;
  const msg = e instanceof Error ? e.message : String(e);
  if (engine === "container" && /failed to fetch|networkerror|load failed|session start failed|fetch/i.test(msg)) {
    return "This example runs on the container engine, which needs the demo server (Cloudflare Sandbox). It isn't reachable here — run the local API worker (requires Docker) or open this example on the deployed demos.handsontable.com.";
  }
  // Sandpack's own bundler message for an unresolved dependency reads like a
  // transient hiccup worth retrying ("please try again in a couple
  // seconds") — misleading when the actual cause is a pinned Handsontable
  // version that was never published, which no amount of retrying fixes.
  if (engine === "sandpack" && /could not fetch dependencies/i.test(msg)) {
    return `Handsontable ${version} could not be fetched. Check that this exact version is published on npm.`;
  }
  return msg;
}

function pinHandsontableFiles(files: FilesMap, version: string): FilesMap {
  const validated = validateHandsontableVersion(version);
  if (!validated.ok || files["/package.json"] === undefined) return files;
  try {
    return applyHandsontableCss(
      applyHandsontableVersion(files, validated.value),
      validated.value,
    );
  } catch {
    return files;
  }
}

function isMissingDocsResource(error: unknown): boolean {
  return error instanceof Error && /\b404\b/.test(error.message);
}

/** Zip a file map and hand it to the browser. Module-level because two callers need
 *  it: the shell's `Download` (live, possibly-edited workspace) and full mode, which
 *  has no workspace — only the files it fetched from the source snapshot. */
function downloadWorkspaceZip(files: FilesMap, name: string): void {
  const entries: Record<string, Uint8Array> = {};
  for (const [p, c] of Object.entries(files)) entries[p.replace(/^\//, "")] = strToU8(c);
  const bytes = zipSync(entries, { level: 6 });
  const base = (name || "handsontable-demo")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "handsontable-demo";
  const blob = new Blob([bytes as BlobPart], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${base}.zip`;
  a.click();
  URL.revokeObjectURL(url);
}

type EditorRoute =
  | { mode: "play" }
  | { mode: "edit"; id: string }
  | { mode: "share"; id: string };

/** Routes that are not the editor at all. Kept out of `EditorRoute` so every
 *  `route.mode` switch inside `Authoring` stays exhaustive over editor modes. */
type AppRoute = EditorRoute | { mode: "myDemos" };

function parseRoute(): AppRoute {
  if (/^\/my-demos\/?$/.test(location.pathname)) return { mode: "myDemos" };
  const m = location.pathname.match(/^\/(edit|share)\/([A-Za-z0-9_-]+)\/?$/);
  if (m) return { mode: m[1] as "edit" | "share", id: m[2]! };
  return { mode: "play" };
}

/**
 * `?mode=full` resolves for a *saved* demo only — full mode shows the prebuilt
 * `/d/:id/` artifact, and `play` has no id and therefore no artifact. `window-maximize`
 * is withheld in `play` for the same reason, so the param cannot be reached from the UI
 * there either.
 *
 * `edit` resolves it as well as `share`: `/edit/:id` is auth-gated, but the build full
 * mode renders is the one `/share/:id` already serves publicly, so this exposes nothing
 * new — and the maximize button has to work from the editor, which is where it lives.
 */
function fullModeId(route: AppRoute): string | null {
  if (route.mode === "play" || route.mode === "myDemos") return null;
  return new URLSearchParams(location.search).get("mode") === "full" ? route.id : null;
}

const SITE_TITLE = "Handsontable Demos";

/**
 * Sets `document.title`. Before T9 there was one static title — "Handsontable
 * Demos — Authoring" — which was wrong on `/share/:id` (public, not authoring)
 * and uninformative in a tab strip full of demos.
 *
 * A hook rather than a render-time assignment: the demo's own title arrives
 * asynchronously, and writing during render would make the effect order decide
 * what a browser tab says.
 */
function useDocumentTitle(name?: string | null) {
  useEffect(() => {
    document.title = name ? `${name} — ${SITE_TITLE}` : SITE_TITLE;
  }, [name]);
}

export function App() {
  const route = parseRoute();
  const fullId = fullModeId(route);
  if (fullId) return <FullMode id={fullId} />;
  // Before `Gate`/`Authoring`, which boot a container session this page has no
  // use for. It is auth-gated all the same — the listing is per-user.
  if (route.mode === "myDemos") return <MyDemosRoute />;
  // The share page is a public, read-only playground — no auth needed.
  if (route.mode === "share") return <ShareRoute route={route} />;
  return <Gate route={route} />;
}

/** `/my-demos`. Same login-on-anonymous contract as `/edit/:id`: the listing is
 *  `WHERE created_by = <caller>`, so there is nothing to show a stranger. */
function MyDemosRoute() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => {
    currentUser().then(setUser);
  }, []);
  useEffect(() => {
    if (user === null) login(); // return_to preserves /my-demos
  }, [user]);
  useDocumentTitle("My demos");

  if (user === undefined) return <Splash text="Loading data …" />;
  if (user === null) return <Splash text="Sign in to see your demos…" />;
  return <MyDemosPage apiBase={API_BASE} user={user} />;
}

/**
 * `/share/:id` — public and read-only, so the workspace is always anonymous
 * (`user={null}`: no action bar, no file CRUD, no save).
 *
 * The *account menu* is a separate question. Before T9 the top bar keyed off the
 * same `user`, so a signed-in visitor opening someone's share link was offered
 * "Sign in". The identity is resolved here and handed to the top bar alone —
 * never rendered as a gate, so nothing waits on it and the page paints as fast
 * as it always did.
 *
 * `undefined` while that resolve is in flight, and it is a real wait: `currentUser()`
 * round-trips the external broker. Seeding `null` instead would mean "anonymous,
 * confirmed" for those few hundred milliseconds and the bar would offer a signed-in
 * visitor **Sign in** — reintroducing the exact thing this split exists to remove,
 * clickable. Pending renders neither control.
 */
function ShareRoute({ route }: { route: { mode: "share"; id: string } }) {
  const [accountUser, setAccountUser] = useState<User | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    currentUser().then((u) => { if (live) setAccountUser(u); });
    return () => { live = false; };
  }, []);
  return (
    <Authoring
      user={null}
      accountUser={accountUser ?? null}
      accountPending={accountUser === undefined}
      route={route}
    />
  );
}

/**
 * `65:20432` — a saved demo's built output, full window, under the design's chrome:
 * top bar, URL bar, preview, status bar. No editor, no sidebar, no authed action bar.
 *
 * Wraps the static `/d/:id/` build, so this stays the cheap path — no Sandpack, no
 * container, nothing to boot. The chrome renders on the first paint (the iframe starts
 * loading immediately) and the metadata fills in behind it; a `Splash` here would delay
 * the demo itself to wait on a title.
 *
 * Nothing in this view needs auth: the build it shows is what `/share/:id` already
 * serves publicly. Hence no `Sign in` — the frame draws none either.
 */
function FullMode({ id }: { id: string }) {
  const [title, setTitle] = useState("");
  const [version, setVersion] = useState(DEFAULT_VERSION);
  const [frameworkName, setFrameworkName] = useState<string | undefined>(undefined);
  const [files, setFiles] = useState<FilesMap | null>(null);
  const [status, setStatus] = useState<PreviewStatus>("booting");
  // Bumped by refresh; re-keys the iframe (which re-requests the build) and re-probes.
  const [reloadGen, setReloadGen] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/demos/${id}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((meta: { title?: string; ht_version?: string } | null) => {
        if (cancelled || !meta) return;
        setTitle(meta.title ?? "");
        if (meta.ht_version) setVersion(meta.ht_version);
      })
      .catch(() => { /* the status dot reports the build; a missing title is not an error state */ });
    return () => { cancelled = true; };
  }, [id]);

  useDocumentTitle(title || null);

  // `framework` and the files only exist on the source snapshot. The files are what
  // `Download` zips; without them the button hides rather than handing over an empty zip.
  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/demos/${id}/source`)
      .then((res) => (res.ok ? res.json() : null))
      .then((src: { framework: string; files: FilesMap } | null) => {
        if (cancelled || !src) return;
        setFiles(src.files);
        // The design's short label ("React (Vite, TS)") comes from the starter catalog,
        // same resolution the shell's status bar uses in every other mode.
        setFrameworkName(catalog.examples.find((x) => x.framework === src.framework)?.displayName);
      })
      .catch(() => { /* Download stays hidden */ });
    return () => { cancelled = true; };
  }, [id]);

  // The dot cannot come from the iframe's `load` event: that fires for a 404 page too,
  // and `/d/:id/` only exists if `runBuild` succeeded at fork time — a demo without a
  // build would report `ready` over the worker's "Not found". The frame is cross-origin,
  // so it cannot be introspected either. Probe the same URL instead: `GET`, because the
  // route is gated on it (`workers/api/src/index.ts`), and the HTML entry is served
  // `max-age=0, must-revalidate`, so this is one conditional request rather than a
  // second download. 404 (no demo / no artifact) and 410 (revoked) both fail `ok`.
  useEffect(() => {
    let cancelled = false;
    setStatus("booting");
    fetch(`${API_BASE}/d/${id}/`)
      .then((res) => { if (!cancelled) setStatus(res.ok ? "ready" : "error"); })
      .catch(() => { if (!cancelled) setStatus("error"); });
    return () => { cancelled = true; };
  }, [id, reloadGen]);

  /** Leaving full mode is a navigation, not `window.close()`: `close()` only works for
   *  a window the script opened, so it silently does nothing on a pasted link. */
  const leaveFullWindow = useCallback(() => {
    const url = new URL(location.href);
    url.searchParams.delete("mode");
    location.assign(url.toString());
  }, []);

  return (
    <div style={{ ...shellStyles.shell, gridTemplateRows: "auto 1fr" }}>
      {/* No `accountEmail`: `65:20432` draws no account control, and full mode had
          no Sign in either — it was already passing `authed={false}` with no
          `onSignIn`, so the top-right has always been theme toggle + Download. */}
      <TopBar
        examplePill={
          <div style={shellStyles.examplePill(false)}>
            <img src={markUrl} alt="" style={shellStyles.examplePillMark} />
            <span style={pillLabel}>{title || "Shared demo"}</span>
          </div>
        }
        onDownload={files ? () => downloadWorkspaceZip(files, title) : undefined}
      />

      <div style={{ display: "grid", gridTemplateRows: "auto 1fr auto", minHeight: 0 }}>
        <FullBar
          url={`${location.origin}/share/${id}`}
          onRefresh={() => setReloadGen((g) => g + 1)}
          onMinimize={leaveFullWindow}
        />

        <iframe
          key={reloadGen}
          title="Handsontable demo"
          src={`${API_BASE}/d/${id}/`}
          style={{ width: "100%", height: "100%", border: "none", display: "block" }}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
        />

        <PreviewStatusBar status={status} frameworkName={frameworkName} version={version} />
      </div>
    </div>
  );
}

/** Resolves the signed-in user; sends the edit page to login when anonymous. */
function Gate({ route }: { route: { mode: "play" } | { mode: "edit"; id: string } }) {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => {
    currentUser().then(setUser);
  }, []);
  useEffect(() => {
    if (user === null && route.mode === "edit") login(); // return_to preserves /edit/:id
  }, [user, route.mode]);

  // The frame gives the loading screen one string, so both load states use it. The
  // sign-in line below is a different message, not a load state, and keeps its own.
  if (user === undefined) return <Splash text="Loading data …" />;
  if (user === null && route.mode === "edit") return <Splash text="Sign in to edit this demo…" />;
  return <Authoring user={user} route={route} />;
}

/** `72:14610`: a spinner and one line, nothing else. The frame draws the top bar above
 *  it, which this cannot — the splash renders precisely because the shell's state (user,
 *  example, version) hasn't resolved yet, so there is no chrome to draw. Either the
 *  frame is a composite (chrome drawn for context, not specified for this state), or
 *  the app wants a real skeleton top bar during load — a bigger change than a splash. */
function Splash({ text }: { text: string }) {
  return (
    <div style={centered}>
      <Spinner size={20} />
      <p style={{ color: theme.color.textMuted, fontFamily: theme.font.ui, margin: 0 }}>{text}</p>
    </div>
  );
}

function NotFound({ path, transient = false }: { path: string | null; transient?: boolean }) {
  return (
    <div style={centered}>
      <Logo size={40} />
      <p style={{ color: theme.color.text, fontFamily: theme.font.ui, fontWeight: 600, margin: 0 }}>
        {transient ? "Example temporarily unavailable" : "Example not found"}
      </p>
      <p style={{ color: theme.color.textMuted, fontFamily: theme.font.ui, margin: 0 }}>
        {transient
          ? "The documentation catalog could not be loaded. Try again later."
          : "This example may not be imported yet."}
      </p>
      {path && (
        <code style={{ color: theme.color.textMuted, fontSize: 12 }}>{path}</code>
      )}
      <a href="/" style={{ color: theme.color.accent, fontFamily: theme.font.ui }}>
        Back to the playground
      </a>
    </div>
  );
}

function Authoring({
  user,
  route,
  // Defaults to `user`: in `play` and `edit` the workspace identity *is* the
  // account identity. Only `ShareRoute` passes them apart.
  accountUser = user,
  // Only `ShareRoute` sets this. `Gate` resolves the user before it renders
  // `Authoring` at all, so there is never an unresolved window there.
  accountPending = false,
}: {
  user: User | null;
  route: EditorRoute;
  accountUser?: User | null;
  accountPending?: boolean;
}) {
  const savedId = route.mode === "edit" || route.mode === "share" ? route.id : null;
  const isShare = route.mode === "share";
  // Changing the *file set* follows being signed in (ADR-0025), not the mode — see the
  // `onAddFile` props below. One flag, not the expression three times: `EditorShell`
  // derives its `editable` switch from `!!onAddFile` and `FileTree` gates the header
  // `+` / `folder-plus` *and* the per-row ✎ / ✕ on it, so the three handlers have to
  // appear and disappear together or the sidebar contradicts itself.
  const canEditFiles = !!user && !isShare;

  // Initial example/version come from the URL so the playground is deep-linkable.
  // `?docs=<content-path>` opens a documentation-guide example (lazy-loaded);
  // `?example=<framework>` opens one of the built-in starter templates.
  const initialDocs = route.mode === "play"
    ? new URLSearchParams(location.search).get("docs")
    : null;
  const [framework, setFramework] = useState<string>(() => {
    const p = new URLSearchParams(location.search).get("example");
    return catalog.examples.some((e) => e.framework === p) ? (p as string) : "react";
  });
  const hadUrlVersion = useRef<boolean>(new URLSearchParams(location.search).has("v"));
  // The active example entry — a starter template or a lazy-loaded docs example.
  const [entry, setEntry] = useState<CatalogEntry>(() => getEntry(framework));
  // Non-null when the current example is a documentation-guide example.
  const [docsPath, setDocsPath] = useState<string | null>(initialDocs);
  // Docs examples for the currently-resolved version bucket.
  const [docsItems, setDocsItems] = useState<DocsManifestItem[]>([]);
  const [activeDocsBucket, setActiveDocsBucket] = useState<string | null>(null);
  const [activeDocsManifest, setActiveDocsManifest] = useState<DocsManifest | null>(null);

  const [files, setFiles] = useState<FilesMap>(() => ({ ...entry.files }));
  const [version, setVersion] = useState<string>(
    () => new URLSearchParams(location.search).get("v") || DEFAULT_VERSION,
  );
  const [versionOptions, setVersionOptions] = useState<string[]>(VERSION_OPTIONS);
  const [nextVersion, setNextVersion] = useState("");
  const [versionsResolved, setVersionsResolved] = useState(false);
  const [status, setStatus] = useState<PreviewStatus>("booting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [versionWarning, setVersionWarning] = useState<string | null>(null);
  const [bootLog, setBootLog] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  // Which *files* are unsaved, for the per-tab dot in the editor strip (T12, ADR-0025
  // §3). Not derivable from `dirty`, and `dirty` is not derivable from it either: the
  // Edit info dialog marks the workspace dirty with no file path at all (see its
  // `onSave` below), and `dirty` is what `Save •` and the docs-switch guard read. Two
  // facts, two pieces of state.
  const [dirtyPaths, setDirtyPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [syncing, setSyncing] = useState(false); // container rebuild in flight
  const [refreshing, setRefreshing] = useState(false); // row-2 refresh in flight
  // Guards the refresh promise's own completion: a second click, an example switch or a
  // version change can land mid-flight, and a stale settle must not clear a newer spinner.
  const refreshSeqRef = useRef(0);
  const containerModeRef = useRef(false);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped whenever the whole workspace is replaced (example switch or fork) so
  // the runtime remounts even when the framework is unchanged.
  const [mountGen, setMountGen] = useState(0);

  const [iframeEl, setIframeEl] = useState<HTMLIFrameElement | null>(null);
  // Where the running preview lives, as reported by mount(). Tier 2 gives the
  // container's preview origin; Tier 1 has none to give (Sandpack renders into
  // the iframe without navigating), so the row-2 field falls back.
  const [previewUrl, setPreviewUrl] = useState("");
  const runtimeRef = useRef<DemoRuntime | null>(null);
  const filesRef = useRef<FilesMap>(files);
  filesRef.current = files;

  // Saved-demo state (edit + share modes). Also gates the first mount until a
  // `?docs=` example has resolved, so we don't briefly boot the starter first.
  const [sourceLoaded, setSourceLoaded] = useState(!savedId && !initialDocs);
  const [docsNotFound, setDocsNotFound] = useState(false);
  const [docsNotFoundTransient, setDocsNotFoundTransient] = useState(false);
  const [docsRuntimeBlocked, setDocsRuntimeBlocked] = useState(!!initialDocs);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  /** Saved demos only — the sidebar's BOX INFO drops the row when it's empty. */
  const [createdAt, setCreatedAt] = useState("");
  const [saving, setSaving] = useState(false);
  const [forking, setForking] = useState(false);
  const [embedding, setEmbedding] = useState(false);
  const [shareLinksOpen, setShareLinksOpen] = useState(false);
  const [linksId, setLinksId] = useState<string | null>(null);
  const [forkedFrom, setForkedFrom] = useState<string | null>(`catalog:${framework}`);
  /** Edit info (`114:24410`), opened from the BOX INFO pencil. Replaces the two
   *  bare inputs T2 had to park in the authed action bar for want of a frame.
   *
   *  Seeded from `?edit=info`, which is what My Demos' **Rename** navigates to —
   *  without it Rename and Open would be the same link. Read once, at mount:
   *  after that the dialog is the user's to open and close. */
  const [editInfoOpen, setEditInfoOpen] = useState(
    () => route.mode === "edit" && new URLSearchParams(location.search).get("edit") === "info",
  );

  /** Close the dialog *and* drop `?edit=info`.
   *
   *  The param is a one-shot instruction from My Demos' Rename, not state. Left
   *  in the URL it outlives the thing it opened: a reload — or anything else
   *  that remounts — reopens the dialog the user already dismissed or saved, and
   *  the link is wrong if copied. `replaceState` so it doesn't add history. */
  const closeEditInfo = useCallback(() => {
    setEditInfoOpen(false);
    const url = new URL(location.href);
    if (url.searchParams.has("edit")) {
      url.searchParams.delete("edit");
      history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
  }, []);
  const docsPathRef = useRef<string | null>(docsPath);
  const dirtyRef = useRef(dirty);
  const sourceLoadedRef = useRef(sourceLoaded);
  const activeDocsBucketRef = useRef<string | null>(activeDocsBucket);
  const activeDocsManifestRef = useRef<DocsManifest | null>(activeDocsManifest);
  const docsRequestSeqRef = useRef(0);
  docsPathRef.current = docsPath;
  dirtyRef.current = dirty;
  sourceLoadedRef.current = sourceLoaded;
  activeDocsBucketRef.current = activeDocsBucket;
  activeDocsManifestRef.current = activeDocsManifest;

  /** Mark the workspace unsaved, and the named files with it.
   *
   *  Every mutation below goes through this rather than setting `dirty` alone, so the
   *  two can't drift — a dot that outlives its edit, or an edit with no dot, both read
   *  as bugs in the indicator rather than in the caller that forgot a line.
   *
   *  Called with no paths for a metadata-only change (the Edit info dialog). */
  const markDirty = useCallback((...touched: string[]) => {
    setDirty(true);
    dirtyRef.current = true;
    if (!touched.length) return;
    setDirtyPaths((prev) => {
      const next = new Set(prev);
      for (const p of touched) next.add(p);
      return next;
    });
  }, []);

  /** Saved or replaced — nothing is outstanding. */
  const clearDirty = useCallback(() => {
    setDirty(false);
    dirtyRef.current = false;
    setDirtyPaths((prev) => (prev.size ? new Set() : prev));
  }, []);

  /** Replace the whole workspace (entry + files + lineage) and remount. */
  const loadWorkspace = useCallback(
    (nextEntry: CatalogEntry, nextFiles: FilesMap, lineage: string) => {
      filesRef.current = nextFiles; // ensure the mount effect reads the new files
      setEntry(nextEntry);
      setFramework(nextEntry.framework);
      setFiles(nextFiles);
      setForkedFrom(lineage);
      clearDirty();
      setErrorMessage(null);
      // Also what tells `EditorShell` to discard its open tabs: this counter is passed
      // down as `workspaceKey`, and it is the only truthful "this is a different
      // workspace now" signal the app has.
      setMountGen((g) => g + 1);
    },
    [clearDirty],
  );

  // Edit/share mode: load the saved demo's source + metadata into the workspace.
  useEffect(() => {
    if (!savedId) return;
    let cancelled = false;
    (async () => {
      const token = getToken();
      const headers: Record<string, string> = !isShare && token ? { Authorization: `Bearer ${token}` } : {};
      try {
        const [srcRes, metaRes] = await Promise.all([
          fetch(`${API_BASE}/api/demos/${savedId}/source`, { headers }),
          fetch(`${API_BASE}/api/demos/${savedId}`),
        ]);
        if (cancelled) return;
        if (!srcRes.ok) {
          setErrorMessage(
            !isShare && srcRes.status === 401 ? "Please sign in to edit this demo." : "This demo is unavailable.",
          );
          setSourceLoaded(true);
          return;
        }
        const src = (await srcRes.json()) as { framework: string; files: FilesMap };
        if (metaRes.ok) {
          const meta = (await metaRes.json()) as {
            title: string;
            description: string | null;
            ht_version: string;
            created_at: string | null;
          };
          setTitle(meta.title ?? "");
          setDescription(meta.description ?? "");
          setCreatedAt(meta.created_at ?? "");
          if (meta.ht_version) {
            hadUrlVersion.current = true; // keep the demo's pinned version, don't override with latest
            setVersion(meta.ht_version);
          }
        }
        loadWorkspace(getEntry(src.framework), src.files, savedId);
        setSourceLoaded(true);
      } catch {
        if (!cancelled) { setErrorMessage("This demo is unavailable."); setSourceLoaded(true); }
      }
    })();
    return () => { cancelled = true; };
  }, [savedId, isShare, loadWorkspace]);

  // Load real published versions from the API (npm-backed); default to latest
  // unless a version was deep-linked (or pinned by the demo being edited/shared).
  useEffect(() => {
    let cancelled = false;
    fetchVersions(API_BASE)
      .then(({ latest, next, versions }) => {
        if (cancelled) return;
        setNextVersion(next ?? "");
        const opts = [...new Set([latest, ...versions, next].filter((v): v is string => !!v))];
        if (opts.length) setVersionOptions(opts);
        if (latest && !hadUrlVersion.current) {
          setVersion((cur) => (cur === DEFAULT_VERSION ? latest : cur));
        }
        setVersionsResolved(true);
      })
      .catch(() => {
        if (!cancelled) setVersionsResolved(true); // release buckets can still resolve without dist-tags.next
      });
    return () => { cancelled = true; };
  }, []);

  // A next-dist-tag version (0.0.0-next-<hash>-<date>) that doesn't match the
  // currently published next build may just be a docs/staging build's own
  // commit stamp — never published, so npm can't install it. Fall back to the
  // published next build and say so, rather than failing the container boot.
  // `versionCheckPending` holds the runtime-mount effect off the doomed
  // version while this resolves (see its use below) — otherwise a container
  // boot (or Sandpack fetch) can fire and fail before the fallback lands.
  const [versionCheckPending, setVersionCheckPending] = useState(false);
  useEffect(() => {
    if (!versionsResolved || !nextVersion) return;
    if (!isNextPrereleaseVersion(version) || version === nextVersion) {
      setVersionCheckPending(false);
      return;
    }
    let cancelled = false;
    const requested = version;
    setVersionCheckPending(true);
    checkVersionExists(API_BASE, requested).then((exists) => {
      if (cancelled) return;
      setVersionCheckPending(false);
      if (exists) return;
      setVersion(nextVersion);
      setVersionWarning(
        `Handsontable ${requested} isn't a published build; showing the latest next build (${nextVersion}) instead.`,
      );
    });
    return () => { cancelled = true; };
  }, [version, nextVersion, versionsResolved]);
  // True while a next-format version's real availability is still unknown:
  // either /api/versions hasn't resolved yet, or the exists-check above is
  // in flight. Blocks the runtime-mount effect until it's settled.
  const versionPending = isNextPrereleaseVersion(version) && (!versionsResolved || versionCheckPending);

  // A manifest fetch is the existence check for a derived bucket. Resolve it on
  // startup and every selected-version change, then swap or preserve an open
  // docs workspace according to its dirty state.
  useEffect(() => {
    if (route.mode === "share" || !versionsResolved) return;
    const requestSeq = ++docsRequestSeqRef.current;
    const openPath = docsPathRef.current;
    const initialLoad = !!initialDocs && !sourceLoadedRef.current;
    const candidate = deriveDocsBucketCandidate(version, nextVersion);

    setDocsItems([]);
    setActiveDocsBucket(null);
    setActiveDocsManifest(null);
    activeDocsBucketRef.current = null;
    activeDocsManifestRef.current = null;
    if (openPath) {
      setDocsRuntimeBlocked(true);
      setStatus("booting");
      setErrorMessage(null);
    }

    const failOpenDocs = (kind: "bucket" | "path" | "fetch") => {
      if (docsRequestSeqRef.current !== requestSeq) return;
      if (initialLoad) {
        setDocsNotFoundTransient(kind === "fetch");
        setDocsNotFound(true);
        setSourceLoaded(true);
        sourceLoadedRef.current = true;
        return;
      }
      if (!openPath) return;
      const message = kind === "bucket"
        ? `No documentation examples are available for Handsontable ${version}. Choose another version or a starter.`
        : kind === "path"
          ? `This documentation example is unavailable for Handsontable ${version}. Choose another version or a starter.`
          : `Could not load documentation examples for Handsontable ${version}. Try another version.`;
      setStatus("error");
      setErrorMessage(message);
      setDocsRuntimeBlocked(true);
    };

    if (!candidate) {
      failOpenDocs("bucket");
      return;
    }

    let cancelled = false;
    void fetchDocsManifest(candidate)
      .then(async (manifest) => {
        if (cancelled || docsRequestSeqRef.current !== requestSeq) return;
        setDocsItems(manifest.examples);
        setActiveDocsBucket(candidate);
        setActiveDocsManifest(manifest);
        activeDocsBucketRef.current = candidate;
        activeDocsManifestRef.current = manifest;
        if (!openPath) return;
        if (!manifest.examples.some((item) => item.docsPath === openPath)) {
          failOpenDocs("path");
          return;
        }

        if (dirtyRef.current) {
          const pinned = pinHandsontableFiles(filesRef.current, version);
          filesRef.current = pinned;
          setFiles(pinned);
          setVersionWarning(
            "This example has unsaved edits; its content may not match the selected version API.",
          );
          setErrorMessage(null);
          setDocsRuntimeBlocked(false);
          return;
        }

        try {
          const docsEntry = await loadDocsExample(candidate, openPath);
          if (cancelled || docsRequestSeqRef.current !== requestSeq) return;
          const nextFiles = manifest.hotVersion === version
            ? { ...docsEntry.files }
            : pinHandsontableFiles({ ...docsEntry.files }, version);
          loadWorkspace(docsEntry, nextFiles, `docs:${candidate}:${openPath}`);
          setDocsPath(openPath);
          docsPathRef.current = openPath;
          setVersionWarning(null);
          setDocsRuntimeBlocked(false);
          setSourceLoaded(true);
          sourceLoadedRef.current = true;
        } catch (error) {
          failOpenDocs(isMissingDocsResource(error) ? "path" : "fetch");
        }
      })
      .catch((error) => {
        failOpenDocs(isMissingDocsResource(error) ? "bucket" : "fetch");
      });
    return () => { cancelled = true; };
  }, [initialDocs, loadWorkspace, nextVersion, route.mode, version, versionsResolved]);

  // Starters never load docs artifacts. Version changes only re-pin their
  // existing package/CSS files and preserve any edits.
  useEffect(() => {
    if (docsPath) return;
    const pinned = pinHandsontableFiles(filesRef.current, version);
    filesRef.current = pinned;
    setFiles(pinned);
  }, [docsPath, version]);

  // Keep the URL in sync with the selected example + version — playground only
  // (edit/share have their own /edit/:id, /share/:id paths). Docs examples use
  // `?docs=<content-path>`; starters use `?example=<framework>`.
  useEffect(() => {
    if (route.mode !== "play") return;
    const p = new URLSearchParams(location.search);
    if (docsPath) {
      p.set("docs", docsPath);
      p.delete("example");
    } else {
      p.set("example", framework);
      p.delete("docs");
    }
    p.set("v", version);
    history.replaceState(null, "", `${location.pathname}?${p.toString()}`);
  }, [framework, docsPath, version, route.mode]);

  /** Pick a catalog starter template as a fresh starting template (playground). */
  const selectExample = useCallback(
    (fw: string) => {
      docsRequestSeqRef.current += 1;
      setDocsPath(null);
      docsPathRef.current = null;
      setDocsRuntimeBlocked(false);
      setVersionWarning(null);
      const starter = getEntry(fw);
      loadWorkspace(starter, pinHandsontableFiles({ ...starter.files }, version), `catalog:${fw}`);
    },
    [loadWorkspace, version],
  );

  /** Open a documentation-guide example (lazy-loaded by its docs content path). */
  const selectDocs = useCallback(
    async (dp: string) => {
      const bucket = activeDocsBucketRef.current;
      const manifest = activeDocsManifestRef.current;
      if (!bucket || !manifest || !manifest.examples.some((item) => item.docsPath === dp)) {
        setErrorMessage(`Could not load docs example: ${dp}`);
        return;
      }
      const requestSeq = ++docsRequestSeqRef.current;
      setDocsRuntimeBlocked(true);
      setStatus("booting");
      setErrorMessage(null);
      try {
        const e = await loadDocsExample(bucket, dp);
        if (docsRequestSeqRef.current !== requestSeq || activeDocsBucketRef.current !== bucket) return;
        const nextFiles = manifest.hotVersion === version
          ? { ...e.files }
          : pinHandsontableFiles({ ...e.files }, version);
        setDocsPath(dp);
        docsPathRef.current = dp;
        loadWorkspace(e, nextFiles, `docs:${bucket}:${dp}`);
        setVersionWarning(null);
        setDocsRuntimeBlocked(false);
      } catch {
        // Unlike the deep-link (`?docs=`) load path, a working workspace is already
        // open here, so a toolbar note is enough — no full-screen not-found takeover.
        if (docsRequestSeqRef.current === requestSeq) {
          setStatus("error");
          setErrorMessage(`Could not load docs example: ${dp}`);
          setDocsRuntimeBlocked(true);
        }
      }
    },
    [loadWorkspace, version],
  );

  const changeVersion = useCallback((next: string) => {
    docsRequestSeqRef.current += 1;
    setVersionWarning(null);
    if (docsPathRef.current) {
      setDocsItems([]);
      setActiveDocsBucket(null);
      setActiveDocsManifest(null);
      activeDocsBucketRef.current = null;
      activeDocsManifestRef.current = null;
      setDocsRuntimeBlocked(true);
      setStatus("booting");
      setErrorMessage(null);
    }
    setVersion(next);
  }, []);

  // Dispose and visibly clear a docs preview while its target bucket/path is
  // unresolved or unavailable. The version picker and editor remain usable.
  useEffect(() => {
    if (!iframeEl || !docsRuntimeBlocked) return;
    runtimeRef.current?.dispose();
    runtimeRef.current = null;
    iframeEl.removeAttribute("srcdoc");
    iframeEl.src = "about:blank";
  }, [iframeEl, docsRuntimeBlocked]);

  useEffect(() => {
    if (!iframeEl || !sourceLoaded || docsNotFound || docsRuntimeBlocked) return;
    if (versionPending) {
      // The previous run's cleanup (below) already disposed its runtime; put
      // the status back to booting so the UI doesn't keep showing "Live" (or
      // a stale error) over a torn-down preview while the version resolves.
      setStatus("booting");
      setErrorMessage(null);
      setBootLog("");
      return;
    }
    setErrorMessage(null);
    const v = validateHandsontableVersion(version);
    if (!v.ok) {
      setStatus("error");
      setErrorMessage(v.message);
      return;
    }
    // Per-starter floor: these starters were authored against a core API that
    // older majors lack, so booting them there produces a broken (or blank)
    // grid. Refuse rather than boot. `releaseMajor` (shared with the version
    // picker) returns null for next/pkg.pr.new refs, which bypass the check.
    const requestedMajor = releaseMajor(v.value.ref);
    if (
      !docsPath &&
      entry.minCoreMajor != null &&
      requestedMajor != null &&
      requestedMajor < entry.minCoreMajor
    ) {
      setStatus("error");
      setErrorMessage(
        `Could not load this example for Handsontable ${version}. Try another version.`,
      );
      return;
    }
    setStatus("booting");
    setBootLog("");
    setSyncing(false);
    // A remount supersedes any refresh. Bump the sequence as well as clearing the flag,
    // so the superseded promise's own settle can't turn the spinner back off later.
    refreshSeqRef.current += 1;
    setRefreshing(false);
    containerModeRef.current = entry.engine === "container";
    let cancelled = false;
    const runtime =
      entry.engine === "container"
        ? new ContainerRuntime(entry, { iframe: iframeEl, apiBase: API_BASE, version: v.value })
        : new SandpackRuntime(entry, { iframe: iframeEl, bundlerURL: SANDPACK_BUNDLER_URL, version: v.value });
    if (entry.engine === "container") {
      (runtime as ContainerRuntime).onProgress((log) => !cancelled && setBootLog(log));
    }
    runtime.onReady(() => !cancelled && setStatus("ready"));
    runtime.onError((e) => {
      if (cancelled) return;
      setStatus("error");
      setErrorMessage(describeRuntimeError(e, entry.engine, v.value.ref));
    });
    runtimeRef.current = runtime;
    setPreviewUrl("");
    runtime
      .mount(filesRef.current)
      .then(({ previewUrl: url }) => {
        // Container only. Tier 1 hands back whatever `iframe.src` happens to be
        // at mount time, which is Sandpack's *bundler* origin — not an address
        // the user could act on, and a CodeSandbox mark we don't surface
        // (ADR-0001, white-label). The row-2 field falls back instead.
        const own = entry.engine === "container" && /^https?:\/\//.test(url);
        if (!cancelled) setPreviewUrl(own ? url : "");
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setStatus("error");
          setErrorMessage(describeRuntimeError(e, entry.engine, v.value.ref));
        }
      });
    return () => {
      cancelled = true;
      runtime.dispose();
      if (runtimeRef.current === runtime) runtimeRef.current = null;
    };
    // mountGen forces a remount when files are replaced (example switch or fork/edit load).
  }, [iframeEl, entry, version, mountGen, sourceLoaded, docsNotFound, docsRuntimeBlocked, versionPending, docsPath]);

  const onEdit = useCallback(
    (path: string, contents: string) => {
      const next = { ...filesRef.current, [path]: contents };
      filesRef.current = next;
      setFiles(next);
      markDirty(path);
      try {
        runtimeRef.current?.writeFile(path, contents);
      } catch {
        /* not mounted */
      }
      // Container frameworks rebuild server-side (a few seconds); show feedback.
      if (containerModeRef.current) {
        setSyncing(true);
        if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
        syncTimerRef.current = setTimeout(() => setSyncing(false), 4000);
      }
    },
    [markDirty],
  );

  // ---- File-tree CRUD (CodeSandbox-style). Edits the in-memory workspace and
  // the live preview; only Save (edit mode, owner) persists them. ----
  const addFile = useCallback(
    (path: string) => {
      if (filesRef.current[path] !== undefined) return;
      const next = { ...filesRef.current, [path]: "" };
      filesRef.current = next;
      setFiles(next);
      markDirty(path);
      try { runtimeRef.current?.writeFile(path, ""); } catch { /* not mounted */ }
    },
    [markDirty],
  );

  const deleteFile = useCallback(
    (path: string) => {
      if (filesRef.current[path] === undefined) return;
      const next = { ...filesRef.current };
      delete next[path];
      filesRef.current = next;
      setFiles(next);
      // The workspace stays dirty — a deletion is unsaved work — but the *path* stops
      // being dirty, because there is no longer a file or a tab to dot.
      markDirty();
      setDirtyPaths((prev) => {
        if (!prev.has(path)) return prev;
        const rest = new Set(prev);
        rest.delete(path);
        return rest;
      });
      try { runtimeRef.current?.deleteFile?.(path); } catch { /* not mounted */ }
    },
    [markDirty],
  );

  const renameFile = useCallback(
    (oldPath: string, newPath: string) => {
      const content = filesRef.current[oldPath] ?? "";
      const next = { ...filesRef.current };
      delete next[oldPath];
      next[newPath] = content;
      filesRef.current = next;
      setFiles(next);
      // The rename itself is unsaved work, so the new path is dirty either way; the
      // old one has to go, or its dot would outlive the file it described. The tab
      // follows the rename — `EditorShell` remaps it (that wrapper is why renaming an
      // open file no longer closes its tab).
      markDirty(newPath);
      setDirtyPaths((prev) => {
        if (!prev.has(oldPath)) return prev;
        const rest = new Set(prev);
        rest.delete(oldPath);
        return rest;
      });
      try {
        runtimeRef.current?.writeFile(newPath, content);
        runtimeRef.current?.deleteFile?.(oldPath);
      } catch { /* not mounted */ }
    },
    [markDirty],
  );

  /** Download the current (possibly-edited) workspace as a .zip. */
  const downloadZip = useCallback(() => {
    downloadWorkspaceZip(filesRef.current, title || entry.displayName);
  }, [title, entry.displayName]);

  /** Create an embeddable (docs-only) version from the current playground code
   *  and show its embed URL — the logged-in path to embed a public example. */
  const onEmbed = useCallback(async () => {
    if (!user) return login();
    setEmbedding(true);
    setErrorMessage(null);
    try {
      const token = getToken();
      const res = await fetch(`${API_BASE}/api/demos`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          framework: entry.framework,
          files: filesRef.current,
          title: `${entry.displayName} (embed)`,
          htVersion: version,
          forkedFrom: forkedFrom ?? undefined,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `embed failed (${res.status})`);
      }
      const { id } = (await res.json()) as { id: string };
      setLinksId(id);
      setShareLinksOpen(true);
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setEmbedding(false);
    }
  }, [user, entry, version, forkedFrom]);

  /** Fork the current playground code into a new saved demo, then open its edit page. */
  const onFork = useCallback(async () => {
    if (!user) return login();
    setForking(true);
    setErrorMessage(null);
    try {
      const token = getToken();
      const res = await fetch(`${API_BASE}/api/demos`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          framework: entry.framework,
          files: filesRef.current,
          title: `Fork of ${entry.displayName}`,
          htVersion: version,
          forkedFrom: forkedFrom ?? undefined,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `fork failed (${res.status})`);
      }
      const { id } = (await res.json()) as { id: string };
      location.href = `/edit/${id}`; // boot into the edit page for the new demo
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : String(e));
      setForking(false);
    }
  }, [user, entry, version, forkedFrom]);

  /** Save the saved-demo edits: title/description + code (rebuilds the snapshot). */
  const onSave = useCallback(async () => {
    if (!savedId || isShare) return;
    setSaving(true);
    setErrorMessage(null);
    try {
      const token = getToken();
      const res = await fetch(`${API_BASE}/api/demos/${savedId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          title: title.trim() || "Untitled demo",
          description: description.trim() || null,
          files: filesRef.current,
          htVersion: version,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `save failed (${res.status})`);
      }
      clearDirty();
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [savedId, isShare, title, description, version, clearDirty]);

  /**
   * The preview bar's share icon, mode-aware (ADR-0025). `edit` has a saved demo
   * already, so it just opens the dialog; `play` has nothing to link to yet, so it
   * mints one first — which is precisely what the retired `Embed` button did, down
   * to the dialog it opened. Embed keeps no button of its own because that dialog's
   * third row already *is* the docs embed URL.
   *
   * `onFork` is deliberately not folded in with it: it posts the same body, but it
   * navigates to `/edit/:id` afterwards, and losing the playground is the difference
   * users actually care about.
   */
  const onShare = useCallback(() => {
    if (route.mode === "play") return void onEmbed();
    setLinksId(savedId);
    setShareLinksOpen(true);
  }, [route.mode, onEmbed, savedId]);

  /**
   * `Cmd/Ctrl+S`. The top bar's Save is the only authed action the design never
   * framed (ADR-0025), so it gets the shortcut every editor has trained people to
   * expect. Gated exactly as the button is, and `preventDefault` regardless of the
   * gate — offering the browser's "save this page" dialog inside an editor is
   * worse than doing nothing.
   */
  useEffect(() => {
    if (!user || route.mode !== "edit") return;
    const onKey = (e: KeyboardEvent) => {
      // Case-folded, because Caps Lock makes `e.key` "S" with `shiftKey` false —
      // which a bare `!== "s"` rejects, skipping the save *and* letting the
      // browser dialog through. `shiftKey` is still excluded on its own, so
      // Shift+Cmd+S stays free for whatever the browser does with it.
      if (e.key.toLowerCase() !== "s" || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      e.preventDefault();
      // A modal owns the keyboard while it is up, and `Dialog` traps Tab and
      // Escape but knows nothing about this. `EditInfoDialog` matters most: it
      // holds title and description as *drafts* and lifts them only on its own
      // Save, so saving the workspace from under it would persist the old
      // metadata while the dialog still shows the new — which reads, from the
      // outside, exactly like the dialog having saved. Swallowed rather than
      // passed through, so the browser's own dialog stays shut either way.
      if (editInfoOpen || shareLinksOpen) return;
      if (!saving) void onSave();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [user, route.mode, saving, onSave, editInfoOpen, shareLinksOpen]);

  /** Row-2 refresh (`72:15708`). Reloads the running preview in place — never a
   *  remount, which for Tier 2 would mint a fresh container session per click.
   *
   *  `reload()`'s promise settles when the refresh has landed (or timed out, or the
   *  runtime went away); it never rejects, so there is no failure branch here —
   *  `onError` already owns that. */
  const refreshPreview = useCallback(() => {
    const runtime = runtimeRef.current;
    if (!runtime?.reload) return;
    const seq = ++refreshSeqRef.current;
    setRefreshing(true);
    void Promise.resolve(runtime.reload()).then(() => {
      if (seq === refreshSeqRef.current) setRefreshing(false);
    });
  }, []);

  /** `window-maximize` (`72:15715`). Opens `?mode=full` — the preview-only view of the
   *  demo's built output (`FullMode`, `65:20432`). Saved demos only: the button is
   *  withheld in `play`, which has no id and so no `/d/:id/` build to show. */
  const openFullWindow = useCallback(() => {
    const url = new URL(location.href);
    url.searchParams.set("mode", "full");
    window.open(url.toString(), "_blank", "noopener");
  }, []);

  const clientUrl = linksId ? `${location.origin}/share/${linksId}` : "";
  // No `?theme=`: `serveDemoAsset` takes `(env, id, subpath, { embed })` and never sees
  // a query string, so the hint we used to send was provably inert (ADR-0025). Embed
  // theming stays deferred — the example owns its own theme (ADR-0022).
  const embedUrl = linksId ? `${API_BASE}/embed/${linksId}` : "";

  // Same string the top bar's pill shows: a saved demo's title, otherwise the
  // example's display name.
  useDocumentTitle(title || entry.displayName);

  // The framework variants available for the currently-open docs example — drive
  // the separate framework picker shown next to the example Cascader.
  const currentDocsMeta = docsPath ? docsItems.find((i) => i.docsPath === docsPath) : undefined;
  const currentFrameworks = currentDocsMeta
    ? docsItems
        .filter((i) => i.guide === currentDocsMeta.guide && i.exampleId === currentDocsMeta.exampleId)
        .sort((a, b) => FW_PREF.indexOf(a.framework) - FW_PREF.indexOf(b.framework))
    : [];

  // Row 2's framework pill (`72:16741`) — same data and same show/hide rule as
  // the button group it replaces: only docs examples have variants, starters are
  // picked through the cascader instead (ADR-0023).
  const frameworks = currentFrameworks.map((f) => ({
    key: f.docsPath,
    label: FW_LABEL[f.framework] ?? f.displayName,
    active: f.docsPath === docsPath,
  }));

  // The public address for the row-2 field. Always `/share/:id`, never
  // `/edit/:id`, even while editing: the field is click-to-copy, and `/edit`
  // is auth-gated (`Gate` sends a signed-out visitor to the login broker, which
  // only accepts @handsontable.com). `/share/:id` is the same demo, served
  // without auth — the link `ShareLinks` hands out. A docs example or an unsaved
  // playground has neither, and falls back to `previewUrl`.
  const publicUrl = savedId ? `${location.origin}/share/${savedId}` : "";

  // The short project label for the preview status bar (`48:6706`). `entry.displayName`
  // is only usable for a starter; for a docs example it is the long
  // `"Columns ▸ … · Standard example · React (TS)"` string that `import-docs.mjs` builds,
  // which overwrites the short name irrecoverably. Resolving through the starter catalog
  // by framework key gives the design's exact wording ("React (Vite, TS)") and describes
  // the authored project, which is the same thing it describes for a starter. `.find`,
  // not `getEntry` — that throws on an unknown key.
  const frameworkName =
    catalog.examples.find((x) => x.framework === entry.framework)?.displayName ??
    entry.displayName;

  if (docsNotFound) return <NotFound path={initialDocs} transient={docsNotFoundTransient} />;
  if (savedId && !sourceLoaded) return <Splash text="Loading data …" />;

  return (
    <div style={{ height: "100%", minHeight: 0 }}>
      <EditorShell
        frameworkLabel={entry.displayName}
        frameworkName={frameworkName}
        files={files}
        entry={entry.entry}
        // Tells the shell to discard its open tabs. `files` alone can't: it is replaced
        // on every keystroke as well as on every example switch, and two workspaces
        // routinely share path names. `mountGen` changes only in `loadWorkspace`, which
        // is exactly the "different workspace now" moment (T12).
        workspaceKey={mountGen}
        iframeRef={setIframeEl}
        status={status}
        errorMessage={errorMessage}
        bootLog={bootLog}
        containerBoot={entry.engine === "container"}
        syncing={syncing}
        refreshing={refreshing}
        version={version}
        versionOptions={docsPath ? versionOptions : versionsForEntry(versionOptions, entry.minCoreMajor)}
        onVersionChange={changeVersion}
        onEdit={onEdit}
        title={title || entry.displayName}
        description={description}
        createdAt={createdAt}
        // `edit` only — and no longer the same gate as the file CRUD below, which
        // follows sign-in (ADR-0025). Title and description belong to a *saved* demo
        // row; a `play` workspace has no record to edit, so being signed in there
        // gives the pencil nothing to open.
        onEditInfo={route.mode === "edit" ? () => setEditInfoOpen(true) : undefined}
        onDownloadAll={downloadZip}
        // Changing the *file set* follows being **signed in** (ADR-0025), not the mode.
        // Sticky `114:26599` states it — "CRUD w sidebar po zalogowaniu" — and the `hidden`
        // flag on `folder-plus` / `plus` is bimodal across the file: hidden in all 7 Before
        // Login frames, visible in all 4 After Login ones. So sticky `72:14532`'s "fork/view
        // mode" means *not signed in*, which is the reading ADR-0023 got wrong.
        //
        // `share` stays excluded: the design's only axis is Before / After Login and it never
        // models ownership, so letting a signed-in visitor mutate someone else's file set
        // would be a behaviour change rather than a restyle. (`ShareRoute` passes `user={null}`,
        // so `!!user` already excludes it — `isShare` says so out loud and survives that
        // changing.) Editing file *contents* is unaffected in all three modes, and nothing
        // persists here without `onSave`.
        onAddFile={canEditFiles ? addFile : undefined}
        onRenameFile={canEditFiles ? renameFile : undefined}
        onDeleteFile={canEditFiles ? deleteFile : undefined}
        onSave={onSave}
        onShare={onShare}
        onFork={onFork}
        authed={!!user}
        // Account menu (`114:21480`). Keyed off `accountUser`, not `user`, so it
        // survives `/share/:id` — see `ShareRoute`.
        accountEmail={accountUser?.email}
        onMyDemos={() => { location.href = "/my-demos"; }}
        // `edit` is auth-gated — `Gate` answers a null user with `login()`, so a
        // plain reload would bounce straight back to the broker. `play` and
        // `share` render fine anonymously and keep their example.
        onLogout={route.mode === "edit" ? () => logout("/") : () => logout()}
        mode={route.mode}
        forking={forking}
        // Only `play` mints, so only `play` is ever pending — `edit` opens the
        // dialog straight off `savedId`.
        sharing={embedding}
        saving={saving}
        // Two facts, not one: `dirty` is the workspace (the top bar's `Save •`, which
        // an Edit-info change must light up even though it touched no file), and
        // `dirtyPaths` is which files carry the per-tab dot (T12).
        dirty={dirty}
        dirtyPaths={dirtyPaths}
        versionWarning={versionWarning}
        // ---- chrome (T2) --------------------------------------------------
        examplePill={
          isShare || route.mode === "edit" ? (
            // `alt=""`: the mark is branding, not information, and unlike BOX INFO's
            // badge no "Handsontable" text follows it here — a real `alt` would just
            // prepend noise to every pill's accessible name.
            <div style={shellStyles.examplePill(false)} title={description || undefined}>
              <img src={markUrl} alt="" style={shellStyles.examplePillMark} />
              <span style={pillLabel}>{title || (isShare ? "Shared demo" : "Untitled demo")}</span>
            </div>
          ) : (
            // The mark is a *sibling* of the cascader, never inside its trigger —
            // inside, the <img> would join the trigger's accessible name. The pill
            // stays 480px: mark + 8px gap leave the 420px label region `72:15859`
            // draws, which the trigger's `flex: 1` absorbs.
            <div style={shellStyles.examplePill(true)}>
              <img src={markUrl} alt="" style={shellStyles.examplePillMark} />
              <DocsCascader
                manifestItems={docsItems}
                starters={catalog.examples.map((e) => ({ framework: e.framework, displayName: e.displayName }))}
                currentLabel={
                  currentDocsMeta
                    ? `${currentDocsMeta.breadcrumb.join(" ▸ ")} · ${currentDocsMeta.exampleTitle}`
                    : entry.displayName
                }
                selectedKey={
                  currentDocsMeta
                    ? `${currentDocsMeta.guide}|${currentDocsMeta.exampleId}`
                    : docsPath
                      ? undefined
                      : `starter:${framework}`
                }
                onSelect={(leaf: CascaderLeaf) => {
                  if (leaf.kind === "starter") { selectExample(leaf.framework); return; }
                  const pick =
                    leaf.frameworks.find((f) => f.framework === framework) ??
                    FW_PREF.map((p) => leaf.frameworks.find((f) => f.framework === p)).find(Boolean) ??
                    leaf.frameworks[0];
                  if (pick) void selectDocs(pick.docsPath);
                }}
              />
            </div>
          )
        }
        publicUrl={publicUrl}
        previewUrl={previewUrl}
        onRefreshPreview={refreshPreview}
        // Saved demos only. `?mode=full` renders the prebuilt `/d/:id/` artifact, which a
        // `play` workspace does not have — before T8 the button there opened a duplicate
        // of the full app in a new tab.
        onMaximize={savedId ? openFullWindow : undefined}
        // Not gated on auth: share mode has always offered Download to anonymous
        // visitors, and no frame shows an anonymous share view (ADR-0023 rule 1).
        // `72:15697` (anonymous `play`) does draw `Sign in` alone — kept anyway, per the
        // same rule, rather than dropping a working control. See ADR-0027 §2.
        onDownload={downloadZip}
        // Withheld while the identity is still resolving, which is the only thing
        // that makes the top bar render `Sign in`. Offering it to someone who turns
        // out to be signed in — and who could click it — is worse than a bar that
        // is briefly one control short.
        onSignIn={accountPending ? undefined : login}
        frameworks={frameworks}
        onFrameworkChange={(docsPathKey) => void selectDocs(docsPathKey)}
        docsUrl={currentDocsMeta ? docsPageUrl(framework, currentDocsMeta.docPermalink) : undefined}
        // Play only, as before. A saved demo's source is the demo itself, not
        // the starter it was forked from, so pointing at the starter repo there
        // would be wrong — and `48:6560`, the one edit-mode frame, ends its bar
        // at `window-maximize`.
        repoUrl={
          route.mode !== "play"
            ? undefined
            : docsPath
              ? `https://github.com/handsontable/handsontable/tree/develop/docs/content/${docsPath.split("/").slice(0, -1).join("/")}`
              : `https://github.com/handsontable/examples/tree/master/examples/${framework}`
        }
        repoLabel={docsPath ? "See this example on GitHub" : "Fork this starter on GitHub"}
      />

      {shareLinksOpen && linksId && (
        <ShareLinks clientUrl={clientUrl} embedUrl={embedUrl} onClose={() => setShareLinksOpen(false)} />
      )}

      {editInfoOpen && (
        <EditInfoDialog
          title={title}
          description={description}
          onClose={closeEditInfo}
          // Marks the workspace dirty rather than PATCHing on its own: the code and
          // the metadata are one snapshot, and `onSave` sends both in a single
          // rebuilding PATCH. Saving here too would rebuild twice.
          //
          // `markDirty()` with no path, deliberately: the title and description belong
          // to no file, so this must not dot a tab. It is also the reason `dirty` can't
          // just be `dirtyPaths.size > 0` (T12).
          onSave={(next) => {
            setTitle(next.title);
            setDescription(next.description);
            markDirty();
            closeEditInfo();
          }}
        />
      )}
    </div>
  );
}

// ---- small shared UI bits --------------------------------------------------

function Logo({ size = 24 }: { size?: number }) {
  const logoUrl = useLogoUrl();
  return <img src={logoUrl} alt="Handsontable" style={{ height: size, display: "block" }} />;
}

const centered: React.CSSProperties = {
  height: "100%",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 12,
  background: theme.color.surface,
};
// `selectStyle` and `ghostBtn` lived here for the unframed authed-extras row —
// the title/description inputs and the My demos / Log out buttons. T9 moved all
// of that into the Edit info dialog and the account menu, both of which style
// themselves from the token set, so the two locals had no callers left.

/** The demo title inside the centred pill (`48:6583`). */
const pillLabel: React.CSSProperties = {
  fontSize: 13, fontWeight: 500, color: theme.color.text,
  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
};
