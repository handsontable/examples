#!/usr/bin/env node
// A tiny local-only stand-in for a Slack incoming webhook (ADR-0041 §F.3,
// `workers/o11y/src/alerts/notify.ts#slackPoster`). `pnpm dev:full` points
// the o11y worker's local `SLACK_WEBHOOK_URL` at this server (see
// `scripts/dev-lib.mjs#o11yDevVarsPatch`) instead of a real Slack webhook,
// so a fired alert (ADR §F.3 rules, or the fixture replay's new-fingerprint
// event) is visible locally without ever touching a real Slack channel.
//
// Closes the gap `docs/observability-contract.md` used to document as
// already built ("a local capture server started by `pnpm o11y:dev`") but
// wasn't — see that doc's §10 table and this task's report for the history.
//
// Usage: node scripts/o11y-slack-capture.mjs --port <port>
//
// Every POST body is printed to stdout (prefixed by the caller's own log
// prefixer when spawned from dev.mjs) and kept in memory (last 50) so a
// test — or a curious developer — can `curl http://localhost:<port>/_captured`
// to see what was posted, in addition to watching it stream by in the
// terminal. Accepts any path (Slack's own incoming-webhook URLs carry a
// per-webhook path segment; this stand-in does not need to match it) and
// always answers `200 ok`, matching a real Slack webhook's own response
// body for a successful post — `notify.ts#slackPoster` doesn't inspect the
// response either way, but a non-2xx would be indistinguishable from an
// actual Slack outage in the terminal log.

import { createServer } from "node:http";

const MAX_CAPTURED = 50;

/** @param {number} port
 *  @returns {{ server: import("node:http").Server, captured: {at: string, path: string, body: unknown}[], close: () => Promise<void> }} */
export function createSlackCaptureServer(port) {
  const captured = [];
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/_captured") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(captured));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("method not allowed");
      return;
    }
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
      const entry = { at: new Date().toISOString(), path: req.url ?? "/", body };
      captured.push(entry);
      while (captured.length > MAX_CAPTURED) captured.shift();
      const text = typeof body === "object" && body && "text" in body ? String(body.text) : raw;
      console.log(`[slack] captured alert post: ${text}`);
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });
  });
  server.listen(port);
  return {
    server,
    captured,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function main() {
  const args = process.argv.slice(2);
  const portIndex = args.indexOf("--port");
  const port = portIndex !== -1 ? Number(args[portIndex + 1]) : 4210;
  if (!Number.isInteger(port) || port <= 0) {
    console.error(`[slack] invalid --port: ${args[portIndex + 1]}`);
    process.exit(1);
  }
  const { close } = createSlackCaptureServer(port);
  console.log(`[slack] local Slack capture server listening on http://localhost:${port} (POST any path; GET /_captured to inspect)`);
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, async () => {
      await close();
      process.exit(0);
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
