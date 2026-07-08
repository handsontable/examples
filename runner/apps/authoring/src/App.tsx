import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorShell, theme, type PreviewStatus } from "@handsontable/demo-editor-shell";
import {
  validateHandsontableVersion,
  type CatalogEntry,
  type DemoRuntime,
  type FilesMap,
} from "@handsontable/demo-runtime";
import { SandpackRuntime } from "@handsontable/demo-runtime/sandpack";
import { ContainerRuntime } from "@handsontable/demo-runtime/container";
import { catalog, getEntry, VERSION_OPTIONS, DEFAULT_VERSION } from "./catalog.js";
import { currentUser, login, logout, getToken, type User } from "./auth.js";
import { ShareDialog, type ShareResult } from "./ShareDialog.js";
import { MyDemos } from "./MyDemos.js";

const SANDPACK_BUNDLER_URL = import.meta.env.VITE_SANDPACK_BUNDLER_URL || undefined;
const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8787";

export function App() {
  // ---- Auth gate -----------------------------------------------------------
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => {
    currentUser().then(setUser);
  }, []);

  if (user === undefined) return <Splash text="Signing in…" />;
  if (user === null) return <LoginScreen />;
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

function LoginScreen() {
  return (
    <div style={centered}>
      <Logo size={48} />
      <h1 style={{ fontFamily: theme.font.ui, fontSize: 22, margin: "16px 0 4px" }}>
        Handsontable Demos
      </h1>
      <p style={{ color: theme.color.textMuted, fontFamily: theme.font.ui, marginTop: 0 }}>
        Internal tool — sign in with your Handsontable account.
      </p>
      <button style={{ ...primaryBtn, marginTop: 16 }} onClick={login}>
        Sign in with Handsontable
      </button>
    </div>
  );
}

function Authoring({ user }: { user: User }) {
  const [framework, setFramework] = useState<string>("react");
  const entry = useMemo<CatalogEntry>(() => getEntry(framework), [framework]);

  const [files, setFiles] = useState<FilesMap>(() => ({ ...entry.files }));
  const [version, setVersion] = useState<string>(DEFAULT_VERSION);
  const [status, setStatus] = useState<PreviewStatus>("booting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
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
    let cancelled = false;
    const runtime =
      entry.tier === 2
        ? new ContainerRuntime(entry, { iframe: iframeEl, apiBase: API_BASE, version: v.value })
        : new SandpackRuntime(entry, { iframe: iframeEl, bundlerURL: SANDPACK_BUNDLER_URL, version: v.value });
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
              {e.displayName} · Tier {e.tier}
            </option>
          ))}
        </select>
        <button style={ghostBtn} onClick={() => setMyDemosOpen((v) => !v)}>My demos</button>
        <div style={{ flex: 1 }} />
        <span style={{ color: theme.color.textMuted, fontSize: 12 }}>{user.email}</span>
        <button style={ghostBtn} onClick={logout}>Log out</button>
      </div>

      <EditorShell
        frameworkLabel={entry.displayName}
        files={files}
        entry={entry.entry}
        iframeRef={setIframeEl}
        status={status}
        errorMessage={errorMessage}
        version={version}
        versionOptions={VERSION_OPTIONS}
        onVersionChange={setVersion}
        onEdit={onEdit}
        onSave={() => setDirty(false)}
        onShare={() => setShareOpen(true)}
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
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="1" y="1" width="22" height="22" rx="4" fill={theme.color.accent} />
      <path d="M7 6v12M17 6v12M7 12h10" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
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
const primaryBtn: React.CSSProperties = {
  fontFamily: theme.font.ui,
  fontSize: 14,
  fontWeight: 600,
  border: `1px solid ${theme.color.accent}`,
  background: theme.color.accent,
  color: "#fff",
  borderRadius: 8,
  padding: "10px 18px",
  cursor: "pointer",
};
