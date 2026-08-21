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
import { Drawer, IconArrowUp, IconSparkles, theme } from "@handsontable/demo-editor-shell";
import type { FilesMap } from "@handsontable/demo-runtime";
import { searchDocs } from "./docsSearch.js";
import { useAutoGrow } from "./useAutoGrow.js";
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
  // The composer grows with the question up to `.hot-chat-input`'s max-height.
  const inputRef = useAutoGrow(input);
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

  /** The composer, pinned under the scrolling transcript by `Drawer`. Full-bleed
   *  on the panel surface with the send arrow floated inside the field — the docs
   *  assistant's composer (`.da-input` / `.da-send`), not a padded form row. */
  const footer = (
    <>
      <form
        className="hot-chat-composer"
        onSubmit={(e) => { e.preventDefault(); void send(input); }}
      >
        <textarea
          ref={inputRef}
          className="hot-chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(input); }
          }}
          placeholder="Ask a question…"
          rows={1}
          maxLength={800}
          disabled={busy}
          aria-label="Your question"
        />
        <button
          type="submit"
          className="hot-chat-send"
          disabled={busy || !input.trim()}
          aria-label="Send"
        >
          <IconArrowUp />
        </button>
      </form>
      <p className="hot-chat-disclaimer">
        AI-generated responses may be inaccurate. Verify critical information before use.
      </p>
    </>
  );

  return (
    <Drawer
      title="Ask AI"
      icon={<IconSparkles size={18} />}
      label="Ask about this example"
      onClose={onClose}
      footer={footer}
      footerStyle={{ padding: 0, background: theme.color.surfaceRaised }}
    >
      <div ref={listRef} className="hot-chat-list">
        {turns.length === 0 && (
          <div>
            <h3 className="hot-chat-welcome-title">How can I help?</h3>
            <p className="hot-chat-welcome-text">
              I answer questions about the example you have open — grounded in the
              Handsontable docs — and any code change arrives as a proposal for you
              to apply.
            </p>
            <div className="hot-panel-menu">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="hot-panel-suggestion hot-panel-menu-item"
                  style={{ opacity: busy ? 0.5 : 1 }}
                  disabled={busy}
                  onClick={() => void send(s)}
                >
                  <span>{s}</span>
                  <span className="hot-chat-arrow" aria-hidden="true">→</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((turn, i) => (
          <div key={i} className={turn.role === "user" ? "hot-chat-bubble" : "hot-chat-answer"}>
            {/* The user bubble is accent-filled, where inline code and links
                cannot keep the colours they carry elsewhere (Bugbot #248). */}
            <Markdown text={turn.content} error={turn.error} onAccent={turn.role === "user"} />

            {turn.edits && turn.edits.length > 0 && (
              <div className="hot-chat-edit-box">
                <div className="hot-chat-edit-head">
                  {turn.undo ? "Applied to" : "Proposed changes to"} {turn.edits.length} file
                  {turn.edits.length > 1 ? "s" : ""}
                </div>
                {turn.edits.map((edit) => (
                  <div key={edit.path} style={{ marginBottom: theme.space(1) }}>
                    <code className="hot-chat-path-chip">{edit.path}</code>
                    {edit.why && <span className="hot-chat-edit-why">{edit.why}</span>}
                  </div>
                ))}
                <div style={{ display: "flex", gap: theme.space(2), marginTop: theme.space(2) }}>
                  {turn.undo
                    ? <button type="button" className="hot-btn-ghost" onClick={() => undo(i)}>Undo</button>
                    : <button type="button" className="hot-btn-primary" onClick={() => apply(i)}>Apply</button>}
                </div>
              </div>
            )}

            {(turn.references?.length || turn.pages?.length) ? (
              <div className="hot-chat-docs">
                <div className="hot-chat-docs-label">Documentation</div>
                {[...new Set([...(turn.references ?? []), ...(turn.pages ?? []).map((p) => p.url)])]
                  .slice(0, 6)
                  .map((url) => (
                    <a key={url} href={url} target="_blank" rel="noreferrer" className="hot-chat-doc-link">
                      {(turn.pages ?? []).find((p) => p.url === url)?.title ?? prettyUrl(url)}
                    </a>
                  ))}
              </div>
            ) : null}
          </div>
        ))}

        {busy && <div className="hot-chat-answer hot-chat-muted">{status ?? "Thinking…"}</div>}
      </div>
    </Drawer>
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
      style={{ position: "relative", display: "inline-flex", flex: "0 0 auto" }}
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
        <IconSparkles />
        Ask AI
      </button>

      {show && (
        <span id="ask-ai-hint" role="tooltip" className="hot-cta-tooltip">
          <strong>Ask about this example</strong>
          <span className="hot-cta-tooltip-intro">
            Scoped to the code you have open — not Handsontable in general.
          </span>
          <span className="hot-cta-tooltip-item">“What does this example do?”</span>
          <span className="hot-cta-tooltip-item">“Make the first two columns frozen” — the edit arrives ready to apply</span>
          <span className="hot-cta-tooltip-item">Grounded in the Handsontable docs, with links</span>
          <span className="hot-cta-tooltip-note">
            Changes are never applied without you — Apply, then Undo if you don’t like it.
          </span>
        </span>
      )}
    </span>
  );
}

const prettyUrl = (url: string) => url.replace(/^https:\/\/handsontable\.com\/docs\//, "").replace(/\/$/, "");

// ---- Styles ------------------------------------------------------------------
//
// The drawer chrome is `Drawer` in the shell (DEV-2209); everything this panel
// paints lives as classes in `panels.css` — imported once from main.tsx — with
// only per-instance values (busy opacity, list margins) inline. The one style
// object left is `askBtn`, the toolbar trigger.

// Deliberately the same neutral treatment as every other toolbar button: this
// used to carry the accent border and text, which read as the primary action on
// a bar where it is one option among several.
// The two live in the redesigned 72px top bar, which is `surfaceRaised` and has a
// dark mode. `#fff` and `border` were both fine on the pre-redesign bar; on this one
// `#fff` is a white block in dark, and dark `border` *is* `surfaceRaised`, so the
// outline disappears. Transparent + `controlBorder` is the bar's own idiom (ADR-0028).
const askBtn: React.CSSProperties = {
  // Metrics match the bar's own `actionButton` (36px, `radius.md`, 13/600): these sit
  // between the mode action and the theme toggle, and the old bar's 26px pill read as
  // a leftover beside them. The `✨` this used to lead with is now `IconSparkles`
  // (DEV-2209): an emoji renders in the OS's own colour and weight, so it was the one
  // mark on the bar that could not follow the theme.
  display: "inline-flex", alignItems: "center", gap: theme.space(2),
  height: 36, padding: `0 ${theme.space(3)}`, flex: "0 0 auto",
  fontFamily: theme.font.ui, ...theme.type.base, fontWeight: 600,
  background: "transparent", color: theme.color.text,
  border: `1px solid ${theme.color.controlBorder}`, borderRadius: theme.radius.md,
  cursor: "pointer", whiteSpace: "nowrap",
};
