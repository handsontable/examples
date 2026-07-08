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

const SANDPACK_BUNDLER_URL = import.meta.env.VITE_SANDPACK_BUNDLER_URL || undefined;
const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8787";

export function App() {
  const [framework, setFramework] = useState<string>("react");
  const entry = useMemo<CatalogEntry>(() => getEntry(framework), [framework]);

  const [files, setFiles] = useState<FilesMap>(() => ({ ...entry.files }));
  const [version, setVersion] = useState<string>(DEFAULT_VERSION);
  const [status, setStatus] = useState<PreviewStatus>("booting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);

  const [iframeEl, setIframeEl] = useState<HTMLIFrameElement | null>(null);
  const runtimeRef = useRef<DemoRuntime | null>(null);
  const filesRef = useRef<FilesMap>(files);
  filesRef.current = files;

  // Load fresh files when the selected example changes.
  useEffect(() => {
    const fresh = { ...entry.files };
    setFiles(fresh);
    filesRef.current = fresh;
    setDirty(false);
    setShareUrl(null);
  }, [entry]);

  // (Re)mount the runtime whenever the iframe, example, or version changes.
  useEffect(() => {
    if (!iframeEl) return;
    setErrorMessage(null);
    setShareUrl(null);

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
        : new SandpackRuntime(entry, {
            iframe: iframeEl,
            bundlerURL: SANDPACK_BUNDLER_URL,
            version: v.value,
          });
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
  }, [iframeEl, entry, version]);

  const onEdit = useCallback((path: string, contents: string) => {
    setFiles((prev) => ({ ...prev, [path]: contents }));
    setDirty(true);
    // Tier-1: stream the edit for near-instant recompile.
    try {
      runtimeRef.current?.writeFile(path, contents);
    } catch {
      /* runtime not mounted (e.g. Tier-2 placeholder) */
    }
  }, []);

  const onSave = useCallback(() => setDirty(false), []);

  const onShare = useCallback(() => {
    // Sharing endpoint (snapshot -> build -> R2 -> short id) lands in Deliverable 5.
    setErrorMessage("Sharing (permanent /d/:id links) arrives in Deliverable 5.");
  }, []);

  return (
    <div style={{ height: "100%", display: "grid", gridTemplateRows: "auto 1fr" }}>
      <div
        style={{
          display: "flex",
          gap: 10,
          alignItems: "center",
          padding: "6px 16px",
          borderBottom: `1px solid ${theme.color.border}`,
          fontFamily: theme.font.ui,
          fontSize: 13,
          background: theme.color.surfaceMuted,
        }}
      >
        <span style={{ color: theme.color.textMuted }}>Example</span>
        <select
          value={framework}
          onChange={(e) => setFramework(e.target.value)}
          style={{
            fontFamily: theme.font.mono,
            fontSize: 13,
            padding: "4px 8px",
            borderRadius: 8,
            border: `1px solid ${theme.color.border}`,
          }}
        >
          {catalog.examples.map((e) => (
            <option key={e.framework} value={e.framework}>
              {e.displayName} · Tier {e.tier}
            </option>
          ))}
        </select>
        <span style={{ color: theme.color.textMuted, fontSize: 12 }}>
          {catalog.examples.length} examples · {SANDPACK_BUNDLER_URL ? "self-hosted bundler" : "hosted bundler"}
        </span>
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
        onSave={onSave}
        onShare={onShare}
        shareUrl={shareUrl}
        dirty={dirty}
      />
    </div>
  );
}
