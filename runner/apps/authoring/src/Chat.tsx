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
import { Drawer, IconSparkles, theme } from "@handsontable/demo-editor-shell";
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

  /** The composer, pinned under the scrolling transcript by `Drawer`. */
  const footer = (
    <>
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
      <p style={{ ...muted, fontSize: 12, margin: `${theme.space(2)} 0 0` }}>
        Answers can be wrong — check the code before you rely on it.
      </p>
    </>
  );

  return (
    <Drawer title="Ask about this example" onClose={onClose} footer={footer}>
      <div ref={listRef} style={list}>
        {turns.length === 0 && (
          <div style={{ padding: `${theme.space(1)} 0` }}>
            <p style={{ ...muted, marginTop: 0 }}>
              Ask what this example does, what an option means, or ask for a change —
              answers are grounded in the Handsontable documentation, and any code change is
              shown for you to apply.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: theme.space(2) }}>
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="hot-panel-suggestion"
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
                <div style={{ fontSize: 12, color: theme.color.textMuted, marginBottom: theme.space(2) }}>
                  {turn.undo ? "Applied to" : "Proposed changes to"} {turn.edits.length} file
                  {turn.edits.length > 1 ? "s" : ""}
                </div>
                {turn.edits.map((edit) => (
                  <div key={edit.path} style={{ marginBottom: theme.space(1) }}>
                    <code style={pathChip}>{edit.path}</code>
                    {edit.why && <span style={{ ...muted, fontSize: 12, marginLeft: theme.space(2) }}>{edit.why}</span>}
                  </div>
                ))}
                <div style={{ display: "flex", gap: theme.space(2), marginTop: theme.space(2) }}>
                  {turn.undo
                    ? <button type="button" style={ghost} onClick={() => undo(i)}>Undo</button>
                    : <button type="button" style={primary} onClick={() => apply(i)}>Apply</button>}
                </div>
              </div>
            )}

            {(turn.references?.length || turn.pages?.length) ? (
              <div style={{ marginTop: theme.space(2), fontSize: 12 }}>
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
        <span id="ask-ai-hint" role="tooltip" style={tooltip}>
          <strong style={{ display: "block", marginBottom: theme.space(1) }}>Ask about this example</strong>
          <span style={{ display: "block", color: theme.color.textMuted, marginBottom: theme.space(2) }}>
            Scoped to the code you have open — not Handsontable in general.
          </span>
          <span style={tooltipItem}>“What does this example do?”</span>
          <span style={tooltipItem}>“Make the first two columns frozen” — the edit arrives ready to apply</span>
          <span style={tooltipItem}>Grounded in the Handsontable docs, with links</span>
          <span style={{ display: "block", marginTop: theme.space(2), color: theme.color.textMuted }}>
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
// The drawer itself — fixed panel, header, close button, composer band — is
// `Drawer` in the shell now, shared with the style panel (DEV-2209). What is left
// is the transcript, on the shell's scales: `space(n)` padding, `radius.sm|md`,
// and 13/12 type. `controlBorder` on control outlines, because the drawer is
// painted `surfaceRaised` and dark `border` *is* `surfaceRaised`.

/** The transcript is the scroller, not `Drawer`'s body: `listRef.scrollTo` has
 *  to reach the element that actually overflows. A definite `height: 100%`
 *  inside the body's flex track plus its own `overflow` keeps the scroll here
 *  and leaves the body with nothing to scroll. */
const list: React.CSSProperties = {
  height: "100%", overflowY: "auto",
  padding: `${theme.space(3)} ${theme.space(4)}`, fontSize: 13,
};
const muted: React.CSSProperties = { color: theme.color.textMuted };
const userBubble: React.CSSProperties = {
  background: theme.color.surfaceMuted, borderRadius: theme.radius.md,
  padding: `${theme.space(2)} ${theme.space(3)}`, margin: `0 0 ${theme.space(3)} auto`,
  maxWidth: "90%", width: "fit-content",
};
const assistantBubble: React.CSSProperties = { padding: `0 0 ${theme.space(3)}`, maxWidth: "100%" };
const editBox: React.CSSProperties = {
  border: `1px solid ${theme.color.controlBorder}`, borderRadius: theme.radius.md,
  padding: theme.space(3), marginTop: theme.space(2), background: theme.color.surfaceMuted,
};
const pathChip: React.CSSProperties = {
  fontFamily: theme.font.mono, fontSize: 12, background: theme.color.surface,
  border: `1px solid ${theme.color.controlBorder}`, borderRadius: theme.radius.sm,
  padding: `1px ${theme.space(1)}`,
};
const docLink: React.CSSProperties = {
  display: "block", color: theme.color.accentText, textDecoration: "none", padding: "1px 0",
};
const composer: React.CSSProperties = { display: "flex", gap: theme.space(2) };
const textarea: React.CSSProperties = {
  flex: 1, resize: "none", fontFamily: theme.font.ui, fontSize: 13,
  padding: `${theme.space(2)} ${theme.space(2)}`,
  border: `1px solid ${theme.color.controlBorder}`, borderRadius: theme.radius.md,
  // Explicit, not the UA's `field` default via `color-scheme`: every other
  // control in the two panels is painted `surface`, and one that is not looks
  // like a different control in dark.
  background: theme.color.surface, color: theme.color.text,
};
const primary: React.CSSProperties = {
  fontFamily: theme.font.ui, fontSize: 13, background: theme.color.accent,
  color: theme.color.accentContrast, border: "none", borderRadius: theme.radius.sm,
  padding: `${theme.space(2)} ${theme.space(3)}`, cursor: "pointer",
};
const ghost: React.CSSProperties = {
  fontFamily: theme.font.ui, fontSize: 13, background: theme.color.surface, color: theme.color.text,
  border: `1px solid ${theme.color.controlBorder}`, borderRadius: theme.radius.sm,
  padding: `${theme.space(2)} ${theme.space(3)}`, cursor: "pointer",
};
/** No `background`: `.hot-panel-suggestion` owns the fill and its rollover, and
 *  an inline one — `ghost`'s `surface` included — would outrank it (ADR-0026). */
const suggestion: React.CSSProperties = {
  ...ghost, background: undefined, textAlign: "left", color: theme.color.accentText,
};

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
  fontFamily: theme.font.ui, fontSize: 13, fontWeight: 600,
  background: "transparent", color: theme.color.text,
  border: `1px solid ${theme.color.controlBorder}`, borderRadius: theme.radius.md,
  cursor: "pointer", whiteSpace: "nowrap",
};
const tooltip: React.CSSProperties = {
  position: "absolute", top: `calc(100% + ${theme.space(2)})`, left: 0, zIndex: 950, width: 320,
  background: theme.color.surfaceRaised, border: `1px solid ${theme.color.controlBorder}`,
  borderRadius: theme.radius.md, boxShadow: theme.shadow.popover,
  padding: `${theme.space(2)} ${theme.space(3)}`,
  fontFamily: theme.font.ui, fontSize: 12, color: theme.color.text,
  textAlign: "left", whiteSpace: "normal", cursor: "default",
};
const tooltipItem: React.CSSProperties = { display: "block", padding: `${theme.space(1)} 0` };
