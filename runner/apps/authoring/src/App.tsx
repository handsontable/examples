import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorShell, theme, logoUrl, type PreviewStatus } from "@handsontable/demo-editor-shell";
import {
  applyHandsontableVersion,
  validateHandsontableVersion,
  type CatalogEntry,
  type DemoRuntime,
  type FilesMap,
} from "@handsontable/demo-runtime";
import { SandpackRuntime } from "@handsontable/demo-runtime/sandpack";
import { ContainerRuntime } from "@handsontable/demo-runtime/container";
import { catalog, getEntry, fetchVersions, VERSION_OPTIONS, DEFAULT_VERSION } from "./catalog.js";
import { currentUser, login, logout, getToken, type User } from "./auth.js";
import { ShareDialog, type ShareResult } from "./ShareDialog.js";
import { MyDemos } from "./MyDemos.js";

const SANDPACK_BUNDLER_URL = import.meta.env.VITE_SANDPACK_BUNDLER_URL || undefined;
const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8787";

export function App() {
  // The editor/playground is public. Sign-in is only needed to create a
  // persistent client demo (Share) or to see "My demos".
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => {
    currentUser().then(setUser);
  }, []);

  if (user === undefined) return <Splash text="Loading…" />;
  return <Authoring user={user} />;
}

function Splash({ text }: { text: string }) {
  return (
    <div style={centered}>
      <Logo size={40} />
      <p style={{ color: theme.color.textMuted, fontFamily: theme.font.ui }}>{text}</p>
    </div>
  );
}

function Authoring({ user }: { user: User | null }) {
  // Initial example/version come from the URL so the app is deep-linkable.
  const [framework, setFramework] = useState<string>(() => {
    const p = new URLSearchParams(location.search).get("example");
    return catalog.examples.some((e) => e.framework === p) ? (p as string) : "react";
  });
  const hadUrlVersion = useRef<boolean>(new URLSearchParams(location.search).has("v"));
  const entry = useMemo<CatalogEntry>(() => getEntry(framework), [framework]);

  const [files, setFiles] = useState<FilesMap>(() => ({ ...entry.files }));
  const [version, setVersion] = useState<string>(
    () => new URLSearchParams(location.search).get("v") || DEFAULT_VERSION,
  );
  const [versionOptions, setVersionOptions] = useState<string[]>(VERSION_OPTIONS);
  const [status, setStatus] = useState<PreviewStatus>("booting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [bootLog, setBootLog] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  // Bumped whenever the whole workspace is replaced (example switch or fork) so
  // the runtime remounts even when the framework is unchanged.
  const [mountGen, setMountGen] = useState(0);

  const [iframeEl, setIframeEl] = useState<HTMLIFrameElement | null>(null);
  const runtimeRef = useRef<DemoRuntime | null>(null);
  const filesRef = useRef<FilesMap>(files);
  filesRef.current = files;

  // Sharing / My demos UI state.
  const [shareOpen, setShareOpen] = useState(false);
  const [shareResult, setShareResult] = useState<ShareResult | null>(null);
  const [forkedFrom, setForkedFrom] = useState<string | null>("catalog:react");
  const [myDemosOpen, setMyDemosOpen] = useState(false);

  /** Replace the whole workspace with a fresh file set + lineage, and remount. */
  const loadWorkspace = useCallback((fw: string, nextFiles: FilesMap, lineage: string) => {
    filesRef.current = nextFiles; // ensure the mount effect reads the new files
    setFramework(fw);
    setFiles(nextFiles);
    setForkedFrom(lineage);
    setDirty(false);
    setShareResult(null);
    setErrorMessage(null);
    setMountGen((g) => g + 1);
  }, []);

  // Load real published versions from the API (npm-backed); default to latest
  // unless a version was deep-linked via the URL.
  useEffect(() => {
    let cancelled = false;
    fetchVersions(API_BASE)
      .then(({ latest, next, versions }) => {
        if (cancelled) return;
        const opts = [...new Set([latest, ...versions, next].filter((v): v is string => !!v))];
        if (opts.length) setVersionOptions(opts);
        if (latest && !hadUrlVersion.current) {
          setVersion((cur) => (cur === DEFAULT_VERSION ? latest : cur));
        }
      })
      .catch(() => { /* keep fallback options */ });
    return () => { cancelled = true; };
  }, []);

  // Reflect the selected version in the editor's package.json (re-pin
  // handsontable + wrapper), keeping any other edits. This is what the bundler
  // and container also install, so what you see matches what runs.
  useEffect(() => {
    const v = validateHandsontableVersion(version);
    if (!v.ok) return;
    setFiles((prev) => {
      if (prev["/package.json"] === undefined) return prev;
      let next: FilesMap;
      try {
        next = applyHandsontableVersion(prev, v.value);
      } catch {
        return prev;
      }
      if (next["/package.json"] === prev["/package.json"]) return prev; // no change
      filesRef.current = next;
      return next;
    });
  }, [version, framework, mountGen]);

  // Keep the URL in sync with the selected example + version (deep-linkable).
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    p.set("example", framework);
    p.set("v", version);
    history.replaceState(null, "", `${location.pathname}?${p.toString()}`);
  }, [framework, version]);

  /** Pick a catalog example as a fresh starting template. */
  const selectExample = useCallback(
    (fw: string) => loadWorkspace(fw, { ...getEntry(fw).files }, `catalog:${fw}`),
    [loadWorkspace],
  );

  useEffect(() => {
    if (!iframeEl) return;
    setErrorMessage(null);
    const v = validateHandsontableVersion(version);
    if (!v.ok) {
      setStatus("error");
      setErrorMessage(v.message);
      return;
    }
    setStatus("booting");
    setBootLog("");
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
      setErrorMessage(e.message);
    });
    runtimeRef.current = runtime;
    runtime.mount(filesRef.current).catch((e: unknown) => {
      if (!cancelled) {
        setStatus("error");
        setErrorMessage(e instanceof Error ? e.message : String(e));
      }
    });
    return () => {
      cancelled = true;
      runtime.dispose();
      if (runtimeRef.current === runtime) runtimeRef.current = null;
    };
    // mountGen forces a remount when files are replaced without a framework change.
  }, [iframeEl, entry, version, mountGen]);

  const onEdit = useCallback((path: string, contents: string) => {
    setFiles((prev) => ({ ...prev, [path]: contents }));
    setDirty(true);
    try {
      runtimeRef.current?.writeFile(path, contents);
    } catch {
      /* not mounted */
    }
  }, []);

  /** Open a saved demo as a fork: fetch its source FIRST, then load it wholesale.
   *  On failure, the current workspace and lineage are left untouched. */
  const openFork = useCallback(
    async (id: string) => {
      const token = getToken();
      let res: Response | null = null;
      try {
        res = await fetch(`${API_BASE}/api/demos/${id}/source`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
      } catch {
        res = null;
      }
      if (!res || !res.ok) {
        setErrorMessage(`Couldn't load demo ${id} to fork.`);
        return;
      }
      const data = (await res.json()) as { framework: string; files: FilesMap };
      setMyDemosOpen(false);
      loadWorkspace(data.framework, data.files, id);
    },
    [loadWorkspace],
  );

  return (
    <div style={{ height: "100%", display: "grid", gridTemplateRows: "auto 1fr" }}>
      <div style={topBar}>
        <span style={{ color: theme.color.textMuted }}>Example</span>
        <select value={framework} onChange={(e) => selectExample(e.target.value)} style={selectStyle}>
          {catalog.examples.map((e) => (
            <option key={e.framework} value={e.framework}>
              {e.displayName}
            </option>
          ))}
        </select>
        {user && (
          <button style={ghostBtn} onClick={() => setMyDemosOpen((v) => !v)}>My demos</button>
        )}
        <div style={{ flex: 1 }} />
        {user ? (
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
        version={version}
        versionOptions={versionOptions}
        onVersionChange={setVersion}
        onEdit={onEdit}
        onSave={() => setDirty(false)}
        onShare={() => (user ? setShareOpen(true) : login())}
        onFork={() => (user ? setShareOpen(true) : login())}
        authed={!!user}
        shareUrl={shareResult?.viewUrl ?? null}
        dirty={dirty}
      />

      {shareOpen && (
        <ShareDialog
          apiBase={API_BASE}
          framework={entry.framework}
          files={files}
          version={version}
          forkedFrom={forkedFrom}
          token={getToken()}
          initialResult={shareResult}
          onResult={setShareResult}
          onClose={() => setShareOpen(false)}
        />
      )}

      {myDemosOpen && (
        <MyDemos apiBase={API_BASE} token={getToken()} onOpen={openFork} onClose={() => setMyDemosOpen(false)} />
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
