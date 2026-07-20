import { useCallback, useEffect, useRef, useState } from "react";
import { EditorShell, theme, logoUrl, type PreviewStatus } from "@handsontable/demo-editor-shell";
import {
  applyHandsontableCss,
  applyHandsontableVersion,
  deriveDocsBucketCandidate,
  validateHandsontableVersion,
  type CatalogEntry,
  type DemoRuntime,
  type FilesMap,
} from "@handsontable/demo-runtime";
import { SandpackRuntime } from "@handsontable/demo-runtime/sandpack";
import { ContainerRuntime } from "@handsontable/demo-runtime/container";
import { zipSync, strToU8 } from "fflate";
import { catalog, getEntry, fetchVersions, VERSION_OPTIONS, DEFAULT_VERSION } from "./catalog.js";
import {
  fetchDocsManifest,
  loadDocsExample,
  type DocsManifest,
  type DocsManifestItem,
} from "./docs-catalog.js";
import { DocsCascader, type CascaderLeaf } from "./DocsCascader.js";
import { currentUser, login, logout, getToken, type User } from "./auth.js";
import { MyDemos } from "./MyDemos.js";
import { ShareLinks } from "./ShareLinks.js";

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

/** Public documentation page URL for a docs example. */
function docsPageUrl(framework: string, permalink: string): string {
  const prefix = FW_DOCS[framework] ?? "javascript-data-grid";
  return `https://handsontable.com/docs/${prefix}${permalink}/`;
}

/** Turn a raw runtime error into a message that explains container prerequisites. */
function describeRuntimeError(e: unknown, engine: string): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (engine === "container" && /failed to fetch|networkerror|load failed|session start failed|fetch/i.test(msg)) {
    return "This example runs on the container engine, which needs the demo server (Cloudflare Sandbox). It isn't reachable here — run the local API worker (requires Docker) or open this example on the deployed demos.handsontable.com.";
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

type EditorRoute =
  | { mode: "play" }
  | { mode: "edit"; id: string }
  | { mode: "share"; id: string };

function parseRoute(): EditorRoute {
  const m = location.pathname.match(/^\/(edit|share)\/([A-Za-z0-9_-]+)\/?$/);
  if (m) return { mode: m[1] as "edit" | "share", id: m[2]! };
  return { mode: "play" };
}

export function App() {
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
    setErrorMessage(null);
    const v = validateHandsontableVersion(version);
    if (!v.ok) {
      setStatus("error");
      setErrorMessage(v.message);
      return;
    }
    setStatus("booting");
    setBootLog("");
    setSyncing(false);
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
      setErrorMessage(describeRuntimeError(e, entry.engine));
    });
    runtimeRef.current = runtime;
    runtime.mount(filesRef.current).catch((e: unknown) => {
      if (!cancelled) {
        setStatus("error");
        setErrorMessage(describeRuntimeError(e, entry.engine));
      }
    });
    return () => {
      cancelled = true;
      runtime.dispose();
      if (runtimeRef.current === runtime) runtimeRef.current = null;
    };
    // mountGen forces a remount when files are replaced (example switch or fork/edit load).
  }, [iframeEl, entry, version, mountGen, sourceLoaded, docsNotFound, docsRuntimeBlocked]);

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
      setDirty(false);
      dirtyRef.current = false;
    } catch (e) {
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
        {!isShare && user && (
          <button style={ghostBtn} onClick={() => setMyDemosOpen((v) => !v)}>My demos</button>
        )}
        <div style={{ flex: 1 }} />
        {errorMessage && (
          <span style={{ color: theme.color.danger, fontSize: 12, maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={errorMessage}>
            {errorMessage}
          </span>
        )}
        {versionWarning && (
          <span style={{ color: theme.color.warning, fontSize: 12, maxWidth: 380 }} title={versionWarning}>
            {versionWarning}
          </span>
        )}
        {isShare ? (
          <>
            <button style={ghostBtn} onClick={downloadZip} title="Download this example (including your edits) as a .zip">
              Download
            </button>
            <span style={{ color: theme.color.textMuted, fontSize: 12, fontFamily: theme.font.mono, whiteSpace: "nowrap" }}>
              {entry.displayName} · HOT {version}
            </span>
          </>
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
        versionOptions={versionOptions}
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
