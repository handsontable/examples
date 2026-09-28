#!/usr/bin/env node
// A tiny local-only stand-in for a Slack incoming webhook (ADR-0041 §F.3).
// `pnpm dev:full` points the o11y worker's `SLACK_WEBHOOK_URL` at this
// server instead of a real Slack webhook, so a fired alert is visible
// locally without touching a real Slack channel.
//
// Usage: node scripts/o11y-slack-capture.mjs --port <port>

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
  // Loopback only: without an explicit host, `listen(port)` binds every
  // interface, exposing unauthenticated alert text to the LAN.
  server.listen(port, "127.0.0.1");
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
