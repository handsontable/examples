// Reproduction harness for DEV-2580: does what we inject into a Tier-2 document
// survive an SSR framework's hydration?
//
// Stands in for the two things production puts around a container's dev server:
// the proxy seam in `workers/api/src/index.ts` (`injectMonitor` then
// `injectScheme`), and the shell that owns the iframe and answers the receiver's
// `ready` with a colour scheme. Then it loads the result in chromium and reports
// the console, the head, and the grid's own computed colours.
//
// It exists because the failure it catches is invisible to a unit test: React 18
// with `hydrateRoot(document, …)` — which is remix's client entry, and the strictest
// hydrator in the catalog — throws away the whole document when `<head>` holds
// anything the server did not render. A `<script>`, the newline in front of it, and
// a `<style>` appended before hydration each did it on their own.
//
// Not a spec: it needs a framework starter installed and built, which the
// deterministic suite has no business doing. The standing guard is the nightly
// starter matrix (`E2E_STARTER_MATRIX=1`); this is what you run while changing
// `packages/runtime/src/{monitor,scheme,inject-html}.ts`.
//
// Usage, with a starter already serving (e.g. in examples/remix:
// `npx remix vite:build && PORT=3199 npx remix-serve ./build/server/index.js`):
//
//   node runner/scripts/ssr-hydration-probe.mjs --upstream=http://127.0.0.1:3199
//   node runner/scripts/ssr-hydration-probe.mjs --inject=none      # the control
//   node runner/scripts/ssr-hydration-probe.mjs --mode=auto        # shell stands down
//
// Exit code 1 when the frame reported a hydration error — and equally when the run
// proved nothing: no grid, or (outside `--mode=auto`) no override. A probe that
// answers "clean" for a 404 page, a mistyped `--inject`, or a demo that never
// mounted is a green bisect step over a run that never happened.

import http from "node:http";
import { chromium } from "@playwright/test";
import { injectReporterIntoHtml } from "../packages/runtime/dist/monitor.js";
import { injectSchemeIntoHtml } from "../packages/runtime/dist/scheme.js";

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const UPSTREAM = arg("upstream", "http://127.0.0.1:3199");
const PORT = Number(arg("port", "3300"));
// `both` is production (MONITOR_DEMOS=1 on the prod host); the single-injector
// modes are how you attribute a failure to one of them.
const INJECT = arg("inject", "both");
// What the fake shell answers `ready` with. `light`/`dark` install the override,
// `auto` is the shell standing down — and the override is the second head writer,
// so both directions matter.
const MODE = arg("mode", "dark");

/** The shell: an iframe plus the scheme half of the parent's postMessage contract. */
const SHELL = `<!doctype html><meta charset="utf-8"><title>shell</title>
<script>
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (d && d.source === 'hot-runner-scheme' && d.ready) {
      e.source.postMessage({ source: 'hot-runner-scheme', mode: ${JSON.stringify(MODE)} }, '*');
      console.log('shell: answered ready with ${MODE}');
    }
  });
</script>
<iframe id="preview" src="/" style="width:900px;height:600px;border:0"></iframe>`;

const server = http.createServer(async (req, res) => {
  if (req.url === "/__shell") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(SHELL);
    return;
  }
  let upstream;
  try {
    upstream = await fetch(UPSTREAM + req.url, {
      method: req.method,
      headers: { ...req.headers, host: new URL(UPSTREAM).host },
      redirect: "manual",
    });
  } catch (error) {
    // A refused upstream is a probe misconfiguration, not a hydration result. Answer
    // it so the verdict below reports "no grid mounted" instead of the process dying
    // on an unhandled rejection halfway through the run.
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`probe: ${UPSTREAM} refused the request (${error.message}) — is the starter serving?`);
    return;
  }
  const headers = Object.fromEntries(upstream.headers.entries());
  // Same two reasons the real seam has: the body is replaced, so a stale length is
  // a truncated page; and `fetch` already decoded the payload.
  delete headers["content-length"];
  delete headers["content-encoding"];
  const type = (upstream.headers.get("content-type") ?? "").toLowerCase();
  if (!type.includes("text/html")) {
    res.writeHead(upstream.status, headers);
    res.end(Buffer.from(await upstream.arrayBuffer()));
    return;
  }
  let html = await upstream.text();
  if (INJECT === "both" || INJECT === "monitor") html = injectReporterIntoHtml(html);
  if (INJECT === "both" || INJECT === "scheme") html = injectSchemeIntoHtml(html);
  res.writeHead(upstream.status, headers);
  res.end(html);
});

await new Promise((resolve) => server.listen(PORT, resolve));
console.log(`probing ${UPSTREAM} through :${PORT}  inject=${INJECT} mode=${MODE}`);

let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage();
  const messages = [];
  page.on("console", (m) => messages.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => messages.push(`[pageerror] ${e.message.split("\n")[0]}`));
  await page.goto(`http://127.0.0.1:${PORT}/__shell`, { waitUntil: "load" });
  const frame = page.frames().find((f) => f !== page.mainFrame());
  if (!frame) throw new Error("the shell rendered no preview frame");
  await frame.waitForLoadState("load").catch(() => {});
  // The grid mounts after hydration, and a mismatch is reported during it. Long
  // enough to see both without polling for something a broken run never reaches.
  await page.waitForTimeout(6000);

  const state = await frame.evaluate(() => {
    const cell = document.querySelector(".handsontable td, .htCore td");
    return {
      head: Array.from(document.head.children)
        .map((el) => el.tagName.toLowerCase() + (el.id ? `#${el.id}` : ""))
        .join(","),
      // Both carriers of the override: the adopted sheet (what ships) and the
      // `<style>` fallback (older Safari).
      adopted: Array.from(document.adoptedStyleSheets ?? [])
        .flatMap((sheet) => Array.from(sheet.cssRules).map((rule) => rule.cssText))
        .join(""),
      styleElement: document.getElementById("hot-runner-scheme")?.textContent ?? null,
      grid: !!document.querySelector(".handsontable, .ht-wrapper, .htCore"),
      // The scheme is only observable as colour: a green hydration run with a grid
      // that never flipped is the silent no-op this line exists to catch.
      cell: cell ? getComputedStyle(cell).backgroundColor : null,
    };
  });

  // React minifies these in a built starter: #418 is the mismatch, #423 the
  // "switching the whole root to client rendering" that follows it.
  const hydration = messages.filter((m) => /Hydration failed|invariant=(418|423)/.test(m));

  console.log("--- console");
  for (const m of messages) console.log(m.slice(0, 200));
  console.log("--- head        :", state.head);
  console.log("--- override    :", state.adopted || state.styleElement || "(none)");
  console.log("--- grid / cell :", state.grid, state.cell);
  console.log("--- hydration   :", hydration.length ? `${hydration.length} error(s)` : "clean");

  // `auto` is the shell standing down, so no override is the expected result there.
  const override = state.adopted || state.styleElement;
  const unproven = [
    hydration.length ? `${hydration.length} hydration error(s)` : null,
    state.grid ? null : "no grid mounted — is the upstream serving the demo?",
    MODE === "auto" || override ? null : `no colour-scheme override for mode=${MODE}`,
  ].filter(Boolean);
  if (unproven.length) {
    console.log("--- FAIL        :", unproven.join("; "));
    process.exitCode = 1;
  } else {
    console.log("--- PASS        : hydration clean, grid mounted, override as expected");
  }
} finally {
  // Both closers in a `finally`: the http server keeps the event loop alive, so an
  // evaluate error or a chromium crash would hang the terminal mid-bisect instead of
  // printing why.
  await browser?.close();
  server.close();
}
