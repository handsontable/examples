// "Ask about this example" — the playground chat panel (DEV-2047).
//
// The panel is scoped to whatever is open in the editor: it sends the current
// files with every question, so the assistant answers about *this* code rather
// than Handsontable in general, and can hand back edits to it.
//
// Edits are never applied on their own. The user sees which files would change
// and presses Apply; one press of Undo puts the previous contents back. An
// assistant that silently rewrites the file you are looking at is not a
// feature, it is a data-loss bug with good intentions.

import { useEffect, useRef, useState } from "react";
import { theme } from "@handsontable/demo-editor-shell";
import type { FilesMap } from "@handsontable/demo-runtime";
import { searchDocs } from "./docsSearch.js";
import { Markdown } from "./markdown.js";
import { reportError } from "./sentry.js";

interface Edit {
  path: string;
  contents: string;
  why?: string;
}

interface DocLink {
  title: string;
  url: string;
}

interface Turn {
  role: "user" | "assistant";
  content: string;
  edits?: Edit[];
  references?: string[];
  pages?: DocLink[];
  /** Contents replaced by an applied edit, kept so Undo can restore them. */
  undo?: FilesMap;
  error?: boolean;
}

export interface ChatPanelProps {
  apiBase: string;
  /** Broker token of the signed-in user, when there is one. Sent so the budget
   *  guard can recognise them: at its `anon_blocked` tier the assistant is
   *  signed-in-only, and without this header a signed-in user is refused
   *  exactly when the tier is meant to keep them working. */
  token: string | null;
  framework: string;
  htVersion: string;
  docsPath: string | null;
  /** Read the editor's live files at send time, not at mount time. */
  getFiles: () => FilesMap;
  /** Write a file back into the editor + running preview. */
  applyEdit: (path: string, contents: string) => void;
  onClose: () => void;
}

const SUGGESTIONS = [
  "What does this example do?",
  "Explain the Handsontable options used here",
  "Add a column with a checkbox renderer",
  "Make the first two columns frozen",
];

/** Report whether a proposed edit was taken. Fire-and-forget: the panel must
 *  never make the user wait on analytics, and a lost count is not worth a
 *  retry. Only the event name and the framework are sent. */
function reportChatEvent(apiBase: string, event: "edit_applied" | "edit_undone", framework: string): void {
  void fetch(`${apiBase}/api/chat/event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, framework }),
    keepalive: true,
  }).catch(() => {});
}

/** The runner keeps file paths with a leading slash; the API takes them without. */
const toApiPath = (path: string) => (path.startsWith("/") ? path.slice(1) : path);
const toEditorPath = (path: string) => (path.startsWith("/") ? path : `/${path}`);

export function ChatPanel({
  apiBase,
  token,
  framework,
  htVersion,
  docsPath,
  getFiles,
  applyEdit,
  onClose,
}: ChatPanelProps) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // `busy` state lags a fast second click by a render; this ref does not.
  const busyRef = useRef(false);
  // A mirror of `turns` that is safe to read inside async code. Reading state
  // through a stale closure is what made Apply's undo map disappear when a
  // follow-up answer landed.
  const turnsRef = useRef<Turn[]>([]);
  useEffect(() => { turnsRef.current = turns; }, [turns]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, busy]);

  async function send(question: string) {
    const text = question.trim();
    if (!text || busyRef.current) return;
    busyRef.current = true;
    setInput("");
    setBusy(true);
    // Every state update below appends to whatever is current rather than
    // replacing a snapshot: an Apply that happens while this request is in
    // flight must not be overwritten when the answer arrives.
    const history = [...turnsRef.current, { role: "user" as const, content: text }];
    setTurns((prev) => [...prev, { role: "user", content: text }]);

    try {
      // Grounding first, in the browser (see docsSearch.ts for why it cannot
      // happen server-side). A failure here is silent: the answer is then
      // ungrounded, which is worse than grounded but far better than nothing.
      setStatus("Searching the documentation…");
      const snippets = await searchDocs(text, framework);

      setStatus(snippets.length ? `Thinking (${snippets.length} doc sources)…` : "Thinking…");
      const files = Object.fromEntries(
        Object.entries(getFiles()).map(([path, contents]) => [toApiPath(path), contents]),
      );

      const res = await fetch(`${apiBase}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          messages: history.map(({ role, content }) => ({ role, content })),
          framework,
          htVersion,
          docsPath: docsPath ?? undefined,
          files,
          snippets: snippets.map((s) => ({ title: s.title, content: s.content, url: s.url })),
        }),
      });

      const body = (await res.json().catch(() => ({}))) as {
        message?: string;
        edits?: Edit[];
        references?: string[];
        pages?: DocLink[];
        error?: string;
      };

      if (!res.ok) {
        // The server phrases refusals (rate limit, budget, misconfiguration)
        // for users already — show them rather than a status code.
        setTurns((prev) => [...prev, {
          role: "assistant",
          content: body.message ?? `The assistant is unavailable (${res.status}).`,
          error: true,
        }]);
        return;
      }

      setTurns((prev) => [...prev, {
        role: "assistant",
        content: body.message ?? "",
        edits: body.edits ?? [],
        references: body.references ?? [],
        pages: body.pages ?? [],
      }]);
    } catch (err) {
      reportError(err, "example-chat");
      setTurns((prev) => [...prev, {
        role: "assistant",
        content: "Couldn’t reach the assistant. Check your connection and try again.",
        error: true,
      }]);
    } finally {
      busyRef.current = false;
      setBusy(false);
      setStatus(null);
    }
  }

  // Both of these write files and then record the result. The writes happen
  // OUTSIDE the state updater on purpose: React invokes updaters twice under
  // StrictMode, and a second pass would snapshot the just-written contents as
  // the "previous" ones — Undo would then restore the assistant's version.

  /** Apply every edit in a turn, remembering what was there before. */
  function apply(index: number) {
    const turn = turnsRef.current[index];
    if (!turn?.edits?.length || turn.undo) return;
    const files = getFiles();
    const undo: FilesMap = {};
    for (const edit of turn.edits) {
      const path = toEditorPath(edit.path);
      // A file the example doesn't have yet is recorded as an empty string,
      // so Undo blanks it rather than leaving the assistant's version behind.
      undo[path] = files[path] ?? "";
      applyEdit(path, edit.contents);
    }
    setTurns((current) => current.map((t, i) => (i === index ? { ...t, undo } : t)));
    reportChatEvent(apiBase, "edit_applied", framework);
  }

  function undo(index: number) {
    const turn = turnsRef.current[index];
    if (!turn?.undo) return;
    for (const [path, contents] of Object.entries(turn.undo)) applyEdit(path, contents);
    setTurns((current) => current.map((t, i) => (i === index ? { ...t, undo: undefined } : t)));
    reportChatEvent(apiBase, "edit_undone", framework);
  }

  return (
    <aside style={panel} aria-label="Ask about this example">
      <header style={head}>
        <strong style={{ fontFamily: theme.font.ui, fontSize: 14 }}>Ask about this example</strong>
        <button style={closeBtn} onClick={onClose} aria-label="Close chat">✕</button>
      </header>

      <div ref={listRef} style={list}>
        {turns.length === 0 && (
          <div style={{ padding: "4px 2px" }}>
            <p style={{ ...muted, marginTop: 0 }}>
              Ask what this example does, what an option means, or ask for a change —
              answers are grounded in the Handsontable documentation, and any code change is
              shown for you to apply.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  style={{ ...suggestion, opacity: busy ? 0.5 : 1 }}
                  disabled={busy}
                  onClick={() => void send(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((turn, i) => (
          <div key={i} style={turn.role === "user" ? userBubble : assistantBubble}>
            <Markdown text={turn.content} error={turn.error} />

            {turn.edits && turn.edits.length > 0 && (
              <div style={editBox}>
                <div style={{ fontSize: 11.5, color: theme.color.textMuted, marginBottom: 6 }}>
                  {turn.undo ? "Applied to" : "Proposed changes to"} {turn.edits.length} file
                  {turn.edits.length > 1 ? "s" : ""}
                </div>
                {turn.edits.map((edit) => (
                  <div key={edit.path} style={{ marginBottom: 4 }}>
                    <code style={pathChip}>{edit.path}</code>
                    {edit.why && <span style={{ ...muted, fontSize: 11.5, marginLeft: 6 }}>{edit.why}</span>}
                  </div>
                ))}
                <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                  {turn.undo
                    ? <button type="button" style={ghost} onClick={() => undo(i)}>Undo</button>
                    : <button type="button" style={primary} onClick={() => apply(i)}>Apply</button>}
                </div>
              </div>
            )}

            {(turn.references?.length || turn.pages?.length) ? (
              <div style={{ marginTop: 8, fontSize: 11.5 }}>
                <div style={{ color: theme.color.textMuted, marginBottom: 2 }}>Documentation</div>
                {[...new Set([...(turn.references ?? []), ...(turn.pages ?? []).map((p) => p.url)])]
                  .slice(0, 6)
                  .map((url) => (
                    <a key={url} href={url} target="_blank" rel="noreferrer" style={docLink}>
                      {(turn.pages ?? []).find((p) => p.url === url)?.title ?? prettyUrl(url)}
                    </a>
                  ))}
              </div>
            ) : null}
          </div>
        ))}

        {busy && <div style={{ ...assistantBubble, ...muted }}>{status ?? "Thinking…"}</div>}
      </div>

      <form
        style={composer}
        onSubmit={(e) => { e.preventDefault(); void send(input); }}
      >
        <textarea
          style={textarea}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(input); }
          }}
          placeholder="Ask about this example…"
          rows={2}
          maxLength={800}
          disabled={busy}
          aria-label="Your question"
        />
        <button type="submit" style={{ ...primary, opacity: busy || !input.trim() ? 0.5 : 1 }} disabled={busy || !input.trim()}>
          Send
        </button>
      </form>
      <p style={{ ...muted, fontSize: 11, margin: "0 12px 10px" }}>
        Answers can be wrong — check the code before you rely on it.
      </p>
    </aside>
  );
}

/**
 * The toolbar entry point, with a tooltip that says what the thing can do.
 *
 * "Ask AI" alone is a label, not an invitation — nobody clicks a chat button
 * to find out whether it can edit their code. The tooltip is the only place a
 * first-time user learns that answers are grounded in the docs and that a
 * change arrives as an edit they can apply, so it earns its space.
 */
export function AskAiButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const [hint, setHint] = useState(false);
  // Never over the top of the panel it opens: once the panel is up, the
  // tooltip is repeating what the user can already read.
  const show = hint && !open;

  return (
    <span
      style={{ position: "relative", display: "inline-flex" }}
      onMouseEnter={() => setHint(true)}
      onMouseLeave={() => setHint(false)}
    >
      <button
        type="button"
        style={askBtn}
        onClick={onToggle}
        onFocus={() => setHint(true)}
        onBlur={() => setHint(false)}
        onKeyDown={(e) => { if (e.key === "Escape") setHint(false); }}
        aria-pressed={open}
        aria-describedby={show ? "ask-ai-hint" : undefined}
      >
        ✨ Ask AI
      </button>

      {show && (
        <span id="ask-ai-hint" role="tooltip" style={tooltip}>
          <strong style={{ display: "block", marginBottom: 4 }}>Ask about this example</strong>
          <span style={{ display: "block", color: theme.color.textMuted, marginBottom: 6 }}>
            Scoped to the code you have open — not Handsontable in general.
          </span>
          <span style={tooltipItem}>💬 “What does this example do?”</span>
          <span style={tooltipItem}>🔧 “Make the first two columns frozen” — the edit arrives ready to apply</span>
          <span style={tooltipItem}>📚 Grounded in the Handsontable docs, with links</span>
          <span style={{ display: "block", marginTop: 6, color: theme.color.textMuted, fontSize: 11 }}>
            Changes are never applied without you — Apply, then Undo if you don’t like it.
          </span>
        </span>
      )}
    </span>
  );
}

const prettyUrl = (url: string) => url.replace(/^https:\/\/handsontable\.com\/docs\//, "").replace(/\/$/, "");

// ---- Styles ------------------------------------------------------------------

const panel: React.CSSProperties = {
  position: "fixed", top: 0, right: 0, height: "100%", width: 400, maxWidth: "95vw",
  background: "#fff", borderLeft: `1px solid ${theme.color.border}`,
  boxShadow: "-8px 0 24px rgba(0,0,0,0.08)", zIndex: 900,
  display: "flex", flexDirection: "column", fontFamily: theme.font.ui, color: theme.color.text,
};
const head: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between",
  padding: "12px 14px", borderBottom: `1px solid ${theme.color.border}`,
};
const closeBtn: React.CSSProperties = {
  border: "none", background: "none", cursor: "pointer", fontSize: 16, color: theme.color.textMuted,
};
const list: React.CSSProperties = { flex: 1, overflowY: "auto", padding: "12px 14px", fontSize: 13 };
const muted: React.CSSProperties = { color: theme.color.textMuted };
const userBubble: React.CSSProperties = {
  background: theme.color.surfaceMuted, borderRadius: theme.radius.md,
  padding: "8px 10px", margin: "0 0 10px auto", maxWidth: "90%", width: "fit-content",
};
const assistantBubble: React.CSSProperties = { padding: "2px 0 10px", maxWidth: "100%" };
const editBox: React.CSSProperties = {
  border: `1px solid ${theme.color.border}`, borderRadius: theme.radius.md,
  padding: 10, marginTop: 8, background: theme.color.surfaceMuted,
};
const pathChip: React.CSSProperties = {
  fontFamily: theme.font.mono, fontSize: 11.5, background: "#fff",
  border: `1px solid ${theme.color.border}`, borderRadius: 4, padding: "1px 5px",
};
const docLink: React.CSSProperties = {
  display: "block", color: theme.color.accent, textDecoration: "none", padding: "1px 0",
};
const composer: React.CSSProperties = {
  display: "flex", gap: 6, padding: "10px 12px 6px", borderTop: `1px solid ${theme.color.border}`,
};
const textarea: React.CSSProperties = {
  flex: 1, resize: "none", fontFamily: theme.font.ui, fontSize: 13, padding: "6px 8px",
  border: `1px solid ${theme.color.border}`, borderRadius: theme.radius.md, color: theme.color.text,
};
const primary: React.CSSProperties = {
  fontFamily: theme.font.ui, fontSize: 12.5, background: theme.color.accent,
  color: theme.color.accentContrast, border: "none", borderRadius: 6, padding: "6px 12px", cursor: "pointer",
};
const ghost: React.CSSProperties = {
  fontFamily: theme.font.ui, fontSize: 12.5, background: "#fff", color: theme.color.text,
  border: `1px solid ${theme.color.border}`, borderRadius: 6, padding: "6px 12px", cursor: "pointer",
};
const suggestion: React.CSSProperties = {
  ...ghost, textAlign: "left", fontSize: 12, color: theme.color.accent, cursor: "pointer",
};

// Deliberately the same neutral treatment as every other toolbar button: this
// used to carry the accent border and text, which read as the primary action on
// a bar where it is one option among several.
const askBtn: React.CSSProperties = {
  fontFamily: theme.font.ui, fontSize: 12.5, background: "#fff", color: theme.color.text,
  border: `1px solid ${theme.color.border}`, borderRadius: 6, padding: "5px 11px",
  cursor: "pointer", whiteSpace: "nowrap",
};
const tooltip: React.CSSProperties = {
  position: "absolute", top: "calc(100% + 8px)", left: 0, zIndex: 950, width: 320,
  background: "#fff", border: `1px solid ${theme.color.border}`, borderRadius: theme.radius.md,
  boxShadow: "0 8px 24px rgba(0,0,0,0.12)", padding: "10px 12px",
  fontFamily: theme.font.ui, fontSize: 12, color: theme.color.text,
  textAlign: "left", whiteSpace: "normal", cursor: "default",
};
const tooltipItem: React.CSSProperties = { display: "block", padding: "2px 0" };
