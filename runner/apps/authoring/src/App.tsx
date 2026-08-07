import { useCallback, useEffect, useRef, useState } from "react";
import { EditorShell, theme, logoUrl, type PreviewStatus } from "@handsontable/demo-editor-shell";
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
import { ContainerRuntime, ContainerBootFailure, SessionStartError, isBudgetRefusal } from "@handsontable/demo-runtime/container";
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
import { MyDemos } from "./MyDemos.js";
import { AdminPanel } from "./Admin.js";
import { AskAiButton, ChatPanel } from "./Chat.js";
import { StyleButton, StylePanel } from "./StylePanel.js";
import { ShareLinks } from "./ShareLinks.js";
import { reportError, reportingEnabled, Sentry } from "./sentry.js";

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
  // A cost-guardrail refusal (DEV-2030) is a deliberate product state, and the
  // server already phrased it for users — never rewrite it as a connectivity
  // problem, which is what the heuristic below would do with a 503.
  if (isBudgetRefusal(e)) return e.message;
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

/**
 * Decide whether a preview failure is ours to fix, and report it if so.
 *
 * `DemoRuntime.onError` is a mixed channel. On the Sandpack engine it carries
 * compile and runtime errors from the example code being edited — a typo
 * mid-keystroke, an example that was imported broken. That is product output, not
 * an application fault, and reporting it would bury the signal (and the quota)
 * under one issue per syntax error.
 *
 * The container engine is the opposite: `SessionStartError` is how the Tier-2
 * instance pool refuses a session (the exhaustion class of failure behind PR #87)
 * and `ContainerBootFailure` is a dev server that could not install or start.
 * Those are exactly what we want to hear about. 410 is excluded — it means the
 * client had already navigated away and the server tore the session down, which
 * is the designed outcome, not a failure.
 *
 * Fingerprinted by error class: `ContainerBootFailure` carries the raw boot log,
 * which differs per example and would otherwise shard one problem into hundreds
 * of issues.
 */
function reportRuntimeError(e: unknown, engine: string): void {
  if (!reportingEnabled || engine !== "container") return;
  // The budget guardrail refusing a session is the guardrail working. It would
  // otherwise arrive as a flood of identical 503s at exactly the moment the
  // team is already dealing with the spend.
  if (isBudgetRefusal(e)) return;
  if (e instanceof SessionStartError) {
    if (e.status === 410) return;
    Sentry.captureException(e, {
      tags: { context: "tier2-session-start", session_status: String(e.status) },
      fingerprint: ["tier2-session-start", String(e.status)],
    });
    return;
  }
  if (e instanceof ContainerBootFailure) {
    Sentry.captureException(e, {
      tags: { context: "tier2-container-boot" },
      fingerprint: ["tier2-container-boot"],
    });
    return;
  }
  // Normal teardown: dispose() races a pending message, or the tab is closing.
  if (e instanceof Error && e.message === "The session was closed.") return;
  Sentry.captureException(e, { tags: { context: "tier2-runtime" } });
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

type EditorRoute =
  | { mode: "play" }
  | { mode: "edit"; id: string }
  | { mode: "share"; id: string };

function parseRoute(): EditorRoute {
  const m = location.pathname.match(/^\/(edit|share)\/([A-Za-z0-9_-]+)\/?$/);
  if (m) return { mode: m[1] as "edit" | "share", id: m[2]! };
  return { mode: "play" };
}

/**
 * Tell the API a page was viewed.
 *
 * The authoring app is served by its own static Worker, so its views are
 * invisible to the API's analytics unless we say so. Only the path is sent —
 * never the query string, which can carry a `?docs=` deep link or anything
 * else a user pasted — and the server normalises even that into a fixed label
 * set. No id is generated or stored on the client; see workers/api/src/
 * analytics.ts for what the server does and does not keep.
 */
function beacon(path: string): void {
  void fetch(`${API_BASE}/api/beacon`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
    keepalive: true,
  }).catch(() => { /* analytics must never surface to a user */ });
}

export function App() {
  // /admin — the internal usage + cost panel (DEV-2030). Sits outside the
  // editor routes entirely: it renders no runtime and boots no container.
  if (location.pathname.replace(/\/+$/, "") === "/admin") return <AdminGate />;

  const route = parseRoute();
  // The share page is a public, read-only playground — no auth needed.
  if (route.mode === "share") {
    // ?mode=full → chrome-less, example-only, full-window (for iframe embedding).
    const full = new URLSearchParams(location.search).get("mode") === "full";
    return full ? <FullEmbed id={route.id} /> : <Authoring user={null} route={route} />;
  }
  return <Gate route={route} />;
}

/** Chrome-less full-window view of a saved demo's built output — the whole
 *  window is just the running example, so `/share/:id?mode=full` drops cleanly
 *  into an <iframe> on any site. Wraps the static /d/:id/ build (cheap, instant,
 *  no live container); the outer SPA page carries no frame restrictions. */
function FullEmbed({ id }: { id: string }) {
  return (
    <iframe
      title="Handsontable demo"
      src={`${API_BASE}/d/${id}/`}
      style={{ position: "fixed", inset: 0, width: "100%", height: "100%", border: "none", display: "block" }}
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
    />
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

  if (user === undefined) return <Splash text="Loading…" />;
  if (user === null && route.mode === "edit") return <Splash text="Sign in to edit this demo…" />;
  return <Authoring user={user} route={route} />;
}

/** Login gate for /admin. Same broker identity as the edit page — the panel
 *  shows internal spend, so it is not for anonymous visitors. */
function AdminGate() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => { currentUser().then(setUser); }, []);
  useEffect(() => { if (user === null) login(); }, [user]);

  if (user === undefined) return <Splash text="Loading…" />;
  if (user === null) return <Splash text="Sign in to view usage…" />;
  return <AdminPanel apiBase={API_BASE} token={getToken()} />;
}

function Splash({ text }: { text: string }) {
  return (
    <div style={centered}>
      <Logo size={40} />
      <p style={{ color: theme.color.textMuted, fontFamily: theme.font.ui }}>{text}</p>
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

function Authoring({ user, route }: { user: User | null; route: EditorRoute }) {
  const savedId = route.mode === "edit" || route.mode === "share" ? route.id : null;
  const isShare = route.mode === "share";

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
  // Cost-guardrail notice (DEV-2030): non-null once spend crosses the warn
  // threshold, so a user learns live sessions are about to get restricted
  // *before* one is refused. Null whenever the guardrail is observe-only.
  const [budgetNotice, setBudgetNotice] = useState<string | null>(null);
  const [bootLog, setBootLog] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const [syncing, setSyncing] = useState(false); // container rebuild in flight
  const containerModeRef = useRef(false);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped whenever the whole workspace is replaced (example switch or fork) so
  // the runtime remounts even when the framework is unchanged.
  const [mountGen, setMountGen] = useState(0);

  const [iframeEl, setIframeEl] = useState<HTMLIFrameElement | null>(null);
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
  const [saving, setSaving] = useState(false);
  const [forking, setForking] = useState(false);
  const [embedding, setEmbedding] = useState(false);
  const [shareLinksOpen, setShareLinksOpen] = useState(false);
  const [linksId, setLinksId] = useState<string | null>(null);
  const [forkedFrom, setForkedFrom] = useState<string | null>(`catalog:${framework}`);
  const [myDemosOpen, setMyDemosOpen] = useState(false);
  // "Ask about this example" (DEV-2047). Available on every route, including
  // the public /share view — explaining a demo is exactly what a shared link
  // is for.
  const [chatOpen, setChatOpen] = useState(false);
  // "Style this demo" — the Theme Builder controls, applied to the open
  // example. Mutually exclusive with the chat panel: they occupy the same edge
  // of the screen, and both are secondary to the code.
  const [styleOpen, setStyleOpen] = useState(false);
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

  /** Replace the whole workspace (entry + files + lineage) and remount. */
  const loadWorkspace = useCallback((nextEntry: CatalogEntry, nextFiles: FilesMap, lineage: string) => {
    filesRef.current = nextFiles; // ensure the mount effect reads the new files
    setEntry(nextEntry);
    setFramework(nextEntry.framework);
    setFiles(nextFiles);
    setForkedFrom(lineage);
    setDirty(false);
    dirtyRef.current = false;
    setErrorMessage(null);
    setMountGen((g) => g + 1);
  }, []);

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
          const meta = (await metaRes.json()) as { title: string; description: string | null; ht_version: string };
          setTitle(meta.title ?? "");
          setDescription(meta.description ?? "");
          if (meta.ht_version) {
            hadUrlVersion.current = true; // keep the demo's pinned version, don't override with latest
            setVersion(meta.ht_version);
          }
        }
        loadWorkspace(getEntry(src.framework), src.files, savedId);
        setSourceLoaded(true);
      } catch (error) {
        // A share/edit link that no longer resolves: missing D1 row, unreadable R2
        // snapshot, or a framework the catalog no longer has.
        reportError(error, "saved-demo-load");
        if (!cancelled) { setErrorMessage("This demo is unavailable."); setSourceLoaded(true); }
      }
    })();
    return () => { cancelled = true; };
  }, [savedId, isShare, loadWorkspace]);

  // One anonymous page view per mount (the editor is a single-page app, so
  // this is its equivalent of a page load).
  useEffect(() => { beacon(location.pathname); }, []);

  // Cost guardrail state. Cheap (KV-cached server side) and read once per page
  // load: the tier only moves on the scale of hours. Failures are silent — an
  // unreachable budget endpoint must never put a warning in front of a user.
  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/budget`)
      .then((r) => (r.ok ? r.json() : null))
      .then((state: { notice?: string | null } | null) => {
        if (!cancelled && state?.notice) setBudgetNotice(state.notice);
      })
      .catch(() => { /* no notice is the right fallback */ });
    return () => { cancelled = true; };
  }, []);

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
      .catch((error) => {
        // Fails open onto the hardcoded VERSION_OPTIONS, so the picker silently
        // goes stale rather than breaking — worth knowing about.
        reportError(error, "versions-fetch");
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
          // The DEV-2130 class: a docs page links an example the runner can't
          // open. Tagged by which step failed so a missing artifact (docs linking
          // an example that was never imported) is distinguishable from a
          // transient fetch.
          reportError(error, `docs-example-load:${isMissingDocsResource(error) ? "path" : "fetch"}`);
          failOpenDocs(isMissingDocsResource(error) ? "path" : "fetch");
        }
      })
      .catch((error) => {
        reportError(error, `docs-bucket-resolve:${isMissingDocsResource(error) ? "bucket" : "fetch"}`);
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
      } catch (error) {
        reportError(error, "docs-example-switch");
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
    containerModeRef.current = entry.engine === "container";
    let cancelled = false;
    const runtime =
      entry.engine === "container"
        ? new ContainerRuntime(entry, {
            iframe: iframeEl,
            apiBase: API_BASE,
            version: v.value,
            // Identifies the caller to the cost guardrail: at >=80% of the
            // monthly budget live sessions are signed-in-only (DEV-2030).
            authToken: getToken(),
          })
        : new SandpackRuntime(entry, { iframe: iframeEl, bundlerURL: SANDPACK_BUNDLER_URL, version: v.value });
    if (entry.engine === "container") {
      (runtime as ContainerRuntime).onProgress((log) => !cancelled && setBootLog(log));
    }
    runtime.onReady(() => !cancelled && setStatus("ready"));
    runtime.onError((e) => {
      if (cancelled) return;
      setStatus("error");
      setErrorMessage(describeRuntimeError(e, entry.engine, v.value.ref));
      reportRuntimeError(e, entry.engine);
    });
    runtimeRef.current = runtime;
    runtime.mount(filesRef.current).catch((e: unknown) => {
      if (!cancelled) {
        setStatus("error");
        setErrorMessage(describeRuntimeError(e, entry.engine, v.value.ref));
      }
      // Reported even when cancelled: a session the pool refused still failed,
      // and the unmount that set `cancelled` is often the user giving up on it.
      reportRuntimeError(e, entry.engine);
    });
    return () => {
      cancelled = true;
      runtime.dispose();
      if (runtimeRef.current === runtime) runtimeRef.current = null;
    };
    // mountGen forces a remount when files are replaced (example switch or fork/edit load).
  }, [iframeEl, entry, version, mountGen, sourceLoaded, docsNotFound, docsRuntimeBlocked, versionPending, docsPath]);

  const onEdit = useCallback((path: string, contents: string) => {
    const next = { ...filesRef.current, [path]: contents };
    filesRef.current = next;
    setFiles(next);
    setDirty(true);
    dirtyRef.current = true;
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
  }, []);

  // ---- File-tree CRUD (CodeSandbox-style). Edits the in-memory workspace and
  // the live preview; only Save (edit mode, owner) persists them. ----
  const addFile = useCallback((path: string) => {
    if (filesRef.current[path] !== undefined) return;
    const next = { ...filesRef.current, [path]: "" };
    filesRef.current = next;
    setFiles(next);
    setDirty(true);
    dirtyRef.current = true;
    try { runtimeRef.current?.writeFile(path, ""); } catch { /* not mounted */ }
  }, []);

  const deleteFile = useCallback((path: string) => {
    if (filesRef.current[path] === undefined) return;
    const next = { ...filesRef.current };
    delete next[path];
    filesRef.current = next;
    setFiles(next);
    setDirty(true);
    dirtyRef.current = true;
    try { runtimeRef.current?.deleteFile?.(path); } catch { /* not mounted */ }
  }, []);

  const renameFile = useCallback((oldPath: string, newPath: string) => {
    const content = filesRef.current[oldPath] ?? "";
    const next = { ...filesRef.current };
    delete next[oldPath];
    next[newPath] = content;
    filesRef.current = next;
    setFiles(next);
    setDirty(true);
    dirtyRef.current = true;
    try {
      runtimeRef.current?.writeFile(newPath, content);
      runtimeRef.current?.deleteFile?.(oldPath);
    } catch { /* not mounted */ }
  }, []);

  /** Download the current (possibly-edited) workspace as a .zip. */
  const downloadZip = useCallback(() => {
    const entries: Record<string, Uint8Array> = {};
    for (const [p, c] of Object.entries(filesRef.current)) entries[p.replace(/^\//, "")] = strToU8(c);
    const bytes = zipSync(entries, { level: 6 });
    const base = (title || entry.displayName || "handsontable-demo")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "handsontable-demo";
    const blob = new Blob([bytes as BlobPart], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${base}.zip`;
    a.click();
    URL.revokeObjectURL(url);
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
      reportError(e, "demo-embed");
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
      reportError(e, "demo-fork");
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
      setDirty(false);
      dirtyRef.current = false;
    } catch (e) {
      // Losing a save is the worst outcome in the app — the user's edits are only
      // in this tab's memory until the PATCH lands.
      reportError(e, "demo-save");
      setErrorMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [savedId, isShare, title, description, version]);

  const clientUrl = linksId ? `${location.origin}/share/${linksId}` : "";
  const embedUrl = linksId ? `${API_BASE}/embed/${linksId}` : "";

  // The framework variants available for the currently-open docs example — drive
  // the separate framework picker shown next to the example Cascader.
  const currentDocsMeta = docsPath ? docsItems.find((i) => i.docsPath === docsPath) : undefined;
  const currentFrameworks = currentDocsMeta
    ? docsItems
        .filter((i) => i.guide === currentDocsMeta.guide && i.exampleId === currentDocsMeta.exampleId)
        .sort((a, b) => FW_PREF.indexOf(a.framework) - FW_PREF.indexOf(b.framework))
    : [];

  // True when the user has changed something that nothing is going to save:
  // the playground and the public share view both keep edits in memory only.
  // The edit page has a Save button, so it is excluded — there the work has
  // somewhere to go.
  const unsavedWork = dirty && route.mode !== "edit";

  if (docsNotFound) return <NotFound path={initialDocs} transient={docsNotFoundTransient} />;
  if (savedId && !sourceLoaded) return <Splash text="Loading demo…" />;

  return (
    <div style={{ height: "100%", display: "grid", gridTemplateRows: "auto 1fr" }}>
      <div style={topBar}>
        {route.mode === "share" ? (
          <>
            <Logo size={22} />
            <div style={{ minWidth: 0 }}>
              <div style={sharedTitle}>{title || "Shared demo"}</div>
              {description && <div style={sharedDesc}>{description}</div>}
            </div>
          </>
        ) : route.mode === "edit" ? (
          <>
            <span style={{ color: theme.color.textMuted }}>Editing</span>
            <input
              style={{ ...selectStyle, fontFamily: theme.font.ui, width: 220 }}
              value={title}
              onChange={(e) => { setTitle(e.target.value); setDirty(true); }}
              placeholder="Demo title"
              aria-label="Demo title"
            />
            <input
              style={{ ...selectStyle, fontFamily: theme.font.ui, width: 300 }}
              value={description}
              onChange={(e) => { setDescription(e.target.value); setDirty(true); }}
              placeholder="Description (optional)"
              aria-label="Demo description"
            />
          </>
        ) : (
          <>
            <span style={{ color: theme.color.textMuted }}>Example</span>
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
            {currentFrameworks.length > 0 && (
              <div style={{ display: "flex", gap: 4 }} role="group" aria-label="Framework">
                {currentFrameworks.map((f) => {
                  const active = f.docsPath === docsPath;
                  return (
                    <button
                      key={f.framework}
                      type="button"
                      onClick={() => void selectDocs(f.docsPath)}
                      style={{ ...fwBtn, ...(active ? fwBtnActive : null) }}
                      title={f.displayName}
                      aria-pressed={active}
                    >
                      {FW_LABEL[f.framework] ?? f.displayName}
                    </button>
                  );
                })}
              </div>
            )}
            {currentDocsMeta && (
              <a
                style={githubLink}
                href={docsPageUrl(framework, currentDocsMeta.docPermalink)}
                target="_blank"
                rel="noreferrer"
                title="Open the documentation page for this example"
              >
                See in documentation ↗
              </a>
            )}
            <a
              style={githubLink}
              href={
                docsPath
                  ? `https://github.com/handsontable/handsontable/tree/develop/docs/content/${docsPath.split("/").slice(0, -1).join("/")}`
                  : `https://github.com/handsontable/examples/tree/master/examples/${framework}`
              }
              target="_blank"
              rel="noreferrer"
              title="View this example's source on GitHub"
            >
              {docsPath ? "See on GitHub ↗" : "Fork on GitHub ↗"}
            </a>
          </>
        )}
        <AskAiButton open={chatOpen} onToggle={() => { setChatOpen((v) => !v); setStyleOpen(false); }} />
        <StyleButton open={styleOpen} onToggle={() => { setStyleOpen((v) => !v); setChatOpen(false); }} />
        {!isShare && user && (
          <button style={ghostBtn} onClick={() => setMyDemosOpen((v) => !v)}>My demos</button>
        )}
        {!isShare && user && (
          <a
            style={{ ...ghostBtn, textDecoration: "none", display: "inline-flex", alignItems: "center" }}
            href="/admin"
            title="Usage and cost of the demo runner"
          >
            Usage
          </a>
        )}
        <div style={{ flex: 1 }} />
        {budgetNotice && (
          <span style={{ color: theme.color.warning, fontSize: 12, maxWidth: 380 }} title={budgetNotice}>
            {budgetNotice}
          </span>
        )}
        {versionWarning && (
          <span style={{ color: theme.color.warning, fontSize: 12, maxWidth: 380 }} title={versionWarning}>
            {versionWarning}
          </span>
        )}
        {/* Download is available on every route, not just /share. Most people
            here are anonymous, nothing persists their edits, and a refresh
            takes the work with it — so the one way out of the playground with
            your changes has to be present before you need it, not discovered
            afterwards. It highlights once there is something to lose. */}
        <button
          style={{
            ...ghostBtn,
            ...(unsavedWork ? { color: theme.color.accent, borderColor: theme.color.accent } : null),
          }}
          onClick={downloadZip}
          title={
            unsavedWork
              ? "Your edits are not saved anywhere — download the example with your changes as a .zip"
              : "Download this example (including any edits) as a .zip"
          }
        >
          Download{unsavedWork ? " •" : ""}
        </button>
        {isShare ? (
          <span style={{ color: theme.color.textMuted, fontSize: 12, fontFamily: theme.font.mono, whiteSpace: "nowrap" }}>
            {entry.displayName} · HOT {version}
          </span>
        ) : user ? (
          <>
            <span style={{ color: theme.color.textMuted, fontSize: 12 }}>{user.email}</span>
            <button style={ghostBtn} onClick={logout}>Log out</button>
          </>
        ) : (
          <button style={ghostBtn} onClick={login}>Sign in with Handsontable</button>
        )}
      </div>

      <EditorShell
        frameworkLabel={entry.displayName}
        files={files}
        entry={entry.entry}
        iframeRef={setIframeEl}
        status={status}
        errorMessage={errorMessage}
        bootLog={bootLog}
        syncing={syncing}
        version={version}
        versionOptions={docsPath ? versionOptions : versionsForEntry(versionOptions, entry.minCoreMajor)}
        onVersionChange={changeVersion}
        onEdit={onEdit}
        onAddFile={addFile}
        onRenameFile={renameFile}
        onDeleteFile={deleteFile}
        onSave={onSave}
        onShare={() => { setLinksId(savedId); setShareLinksOpen(true); }}
        onFork={onFork}
        onEmbed={onEmbed}
        embedding={embedding}
        authed={!!user}
        mode={route.mode}
        sharing={forking}
        saving={saving}
        dirty={dirty}
      />

      {shareLinksOpen && linksId && (
        <ShareLinks clientUrl={clientUrl} embedUrl={embedUrl} onClose={() => setShareLinksOpen(false)} />
      )}

      {styleOpen && (
        <StylePanel
          apiBase={API_BASE}
          token={getToken()}
          getFiles={() => filesRef.current}
          applyEdit={onEdit}
          onClose={() => setStyleOpen(false)}
        />
      )}
      {chatOpen && (
        <ChatPanel
          apiBase={API_BASE}
          token={getToken()}
          framework={framework}
          htVersion={version}
          docsPath={docsPath}
          getFiles={() => filesRef.current}
          applyEdit={onEdit}
          onClose={() => setChatOpen(false)}
        />
      )}
      {myDemosOpen && (
        <MyDemos apiBase={API_BASE} token={getToken()} onClose={() => setMyDemosOpen(false)} />
      )}
    </div>
  );
}

// ---- small shared UI bits --------------------------------------------------

function Logo({ size = 24 }: { size?: number }) {
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
const topBar: React.CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "center",
  padding: "6px 16px",
  borderBottom: `1px solid ${theme.color.border}`,
  fontFamily: theme.font.ui,
  fontSize: 13,
  background: theme.color.surfaceMuted,
};
const selectStyle: React.CSSProperties = {
  fontFamily: theme.font.mono,
  fontSize: 13,
  padding: "4px 8px",
  borderRadius: 8,
  border: `1px solid ${theme.color.border}`,
  boxSizing: "border-box",
};
const ghostBtn: React.CSSProperties = {
  fontFamily: theme.font.ui,
  fontSize: 12.5,
  border: `1px solid ${theme.color.border}`,
  background: theme.color.surface,
  borderRadius: 8,
  padding: "5px 10px",
  cursor: "pointer",
};
const fwBtn: React.CSSProperties = {
  fontFamily: theme.font.ui,
  fontSize: 12,
  border: `1px solid ${theme.color.border}`,
  background: theme.color.surface,
  color: theme.color.textMuted,
  borderRadius: 7,
  padding: "4px 9px",
  cursor: "pointer",
  whiteSpace: "nowrap",
};
const fwBtnActive: React.CSSProperties = {
  background: theme.color.accent,
  color: "#fff",
  borderColor: theme.color.accent,
  fontWeight: 600,
};
const githubLink: React.CSSProperties = {
  fontFamily: theme.font.ui,
  fontSize: 12.5,
  color: theme.color.text,
  textDecoration: "none",
  border: `1px solid ${theme.color.border}`,
  background: theme.color.surface,
  borderRadius: 8,
  padding: "5px 10px",
  whiteSpace: "nowrap",
};
const sharedTitle: React.CSSProperties = {
  fontSize: 14, fontWeight: 600, color: theme.color.text,
  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
};
const sharedDesc: React.CSSProperties = {
  fontSize: 12, color: theme.color.textMuted,
  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
};
