// Branded HTML bodies for the browser-facing error responses on /d/:id and
// /embed/:id (DEV-2163 / T9).
//
// No Figma frame exists for these — ADR-0023 rule 1, dev judgment against the
// T0 token set. What changed in T9 is *only* the body: every caller keeps the
// status and the trigger it already had. A revoked share link was a bare
// `text/plain` "This demo has been revoked." with no branding at all.
//
// The worker cannot import `@handsontable/demo-editor-shell` — it is a separate
// package, bundled by wrangler, and the shell is browser/React code. So the
// handful of values below are duplicated literals, in the same spirit as the
// pre-paint script in `apps/authoring/index.html`. Keep them in sync with
// `packages/editor-shell/src/theme.ts`; this file is the fourth sanctioned
// exception to "no colour literal outside theme.ts" (ADR-0028).
//
// Self-contained by necessity: one inline <style>, one inline SVG, no fetches.
// `prefers-color-scheme` rather than `data-hot-theme`, because there is no app
// here to have read the user's stored choice.

/** Mirrors `packages/editor-shell/src/theme.ts`. Light first, dark under the media query. */
const LIGHT = {
  surface: "#ffffff",
  surfaceRaised: "#ffffff",
  surfaceSunken: "#f7f7f9",
  border: "#e7e7e9",
  text: "#262624",
  textMuted: "#727272",
  accent: "#1A42E8",
} as const;

const DARK: Record<keyof typeof LIGHT, string> = {
  surface: "#070604",
  surfaceRaised: "#222222",
  surfaceSunken: "#000000",
  border: "#222222",
  text: "#d1d1d4",
  textMuted: "#8f8f94",
  // Same value as light: `accent` is the brand blue and is mode-invariant in
  // `theme.ts`. This briefly shipped as `#4669F6`, which is dark `splitterActive`
  // — a different token that happens to be a lifted blue. Don't "fix" the
  // duplication away; the Record type is what keeps the two palettes in step.
  accent: "#1A42E8",
};

/** `packages/editor-shell/src/mark.svg`, inlined. Mode-invariant brand asset. */
const MARK = `<svg width="40" height="40" viewBox="0 0 400 400" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect width="400" height="400" rx="72" fill="#0F0F10"/><path d="M91 77h50v67h59V77h50v175h-50v-69h-59v69H91V77Z" fill="#FFFFFF"/><rect x="262" y="265" width="58" height="58" fill="#FFFFFF"/></svg>`;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );

const vars = (p: Record<string, string>) =>
  Object.entries(p)
    .map(([k, v]) => `--c-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${v}`)
    .join(";");

export interface ErrorPageInit {
  status: number;
  title: string;
  body: string;
  /** Rendered as a link back to the playground. Omitted inside an embed. */
  homeUrl?: string;
  /**
   * When set, the page reloads itself after this many seconds and the response
   * carries a matching `Retry-After` (DEV-2537).
   *
   * The two halves are not redundant: `Retry-After` is the correct-HTTP half,
   * but no browser acts on it for a navigation, so the meta-refresh is the half
   * that actually recovers a visitor. Optional, and every pre-existing caller
   * omits it — a 404 that reloaded itself would be a loop, not a recovery.
   */
  refreshSeconds?: number;
  /**
   * Tell the embedding shell what this document is (DEV-2547).
   *
   * Only the live-preview pages set it. The frame is cross-origin, so the shell
   * cannot read it — but this page is ours, so it can speak: an inline script
   * posts `{ source: "demo-preview", state }` to the parent, which is what keeps
   * `data-preview-status` from reaching "ready" over an apology page. Omitted by
   * every other caller: `/d/:id` and `/embed/:id` errors replace the whole page,
   * not a frame inside one, so there is no parent to tell.
   */
  previewState?: "booting" | "dead";
}

/** A whole number of seconds, at least 1 — `content="0"` is a busy loop. */
const refreshInterval = (seconds: number) => Math.max(1, Math.round(seconds));

/**
 * The parent notification, inlined.
 *
 * Inline rather than a module: this document is served by the Worker in place of
 * whatever the frame asked for, so a second request for a script file would hit
 * the same dead port. No CSP is set on these responses (`errorPageResponse`) and
 * the shell's iframe carries `allow-scripts`
 * (`packages/editor-shell/src/PreviewPane.tsx`), so it runs.
 *
 * `"*"` as the target origin: the shell is on the app origin and this page is on
 * the per-session preview origin, and the message carries no secret — it says
 * only what the visitor can already see. The receiver checks the *sender* origin
 * instead, which is the half that matters.
 *
 * Runs at parse time, so the message is queued before this document's `load`
 * fires — the ordering the shell's per-navigation decision depends on.
 */
const previewStateScript = (state: "booting" | "dead") =>
  `\n<script>try{if(window.parent!==window)window.parent.postMessage({source:"demo-preview",state:"${state}"},"*")}catch(e){}</script>`;

/**
 * A minimal branded error document.
 *
 * `homeUrl` is deliberately optional: `/embed/:id` renders inside a third-party
 * docs page, where a full-width "Back to the playground" call to action would be
 * wrong. The caller decides.
 */
export function errorPageHtml({
  status,
  title,
  body,
  homeUrl,
  refreshSeconds,
  previewState,
}: ErrorPageInit): string {
  // A number formatted straight into the attribute — never through escapeHtml,
  // which takes a string and would happily pass one through.
  const refresh =
    refreshSeconds === undefined ? "" : `\n<meta http-equiv="refresh" content="${refreshInterval(refreshSeconds)}">`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">${refresh}
<title>${escapeHtml(title)} — Handsontable Demos</title>
<style>
:root{${vars(LIGHT)};color-scheme:light}
@media (prefers-color-scheme:dark){:root{${vars(DARK)};color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
background:var(--c-surface-sunken);color:var(--c-text);
font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:420px;width:100%;padding:32px;border-radius:12px;text-align:center;
background:var(--c-surface-raised);border:1px solid var(--c-border)}
svg{border-radius:8px}
.status{margin:16px 0 0;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--c-text-muted)}
h1{margin:4px 0 8px;font-size:20px;font-weight:600}
p{margin:0;color:var(--c-text-muted)}
a{display:inline-block;margin-top:24px;color:var(--c-accent);text-decoration:none;font-weight:600}
a:hover{text-decoration:underline}
</style>
</head>
<body>
<main>
${MARK}
<p class="status">Error ${status}</p>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(body)}</p>
${homeUrl ? `<a href="${escapeHtml(homeUrl)}">Back to the playground</a>` : ""}
</main>${previewState === undefined ? "" : previewStateScript(previewState)}
</body>
</html>`;
}

/** `errorPageHtml` wrapped in a Response, with the status it describes. */
export function errorPageResponse(init: ErrorPageInit): Response {
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  if (init.refreshSeconds !== undefined) {
    headers.set("Retry-After", String(refreshInterval(init.refreshSeconds)));
  }
  return new Response(errorPageHtml(init), { status: init.status, headers });
}

/**
 * Whether a request path should get the HTML page rather than plain text.
 *
 * A missing `/assets/index-a1b2c3.js` under a live demo is a 404 too, and
 * answering it with a styled document would be noise in the network panel and
 * garbage to whatever tried to parse it. Only document-ish requests — the demo
 * root, an explicit `.html`, or an extensionless path — get the page.
 */
export function wantsHtmlError(subpath: string): boolean {
  const clean = subpath.replace(/^\/+/, "").replace(/\/+$/, "");
  if (clean === "") return true;
  const last = clean.split("/").pop() ?? "";
  if (!last.includes(".")) return true;
  return last.endsWith(".html");
}
