import { test, expect } from "@playwright/test";
import { TOKEN_KEYS } from "../workers/api/src/theme-tokens.generated.js";

// The two AI endpoints, live (DEV-2203). Everything about the panels' chrome
// and behaviour is deterministic elsewhere (panels.spec.ts, style-apply's
// recorded /api/theme payloads); what nothing else proves is that the deployed
// gateway chain — worker → LiteLLM → model → whitelist — returns something
// usable at all.
//
// API-level on purpose: a request-fixture call is cheaper and calmer than
// driving the drawers, and the shape of the answer is the whole assertion —
// content quality is not a thing a test should have an opinion on.
//
// Every call here spends real LLM budget and shares the 8/minute-per-IP rate
// bucket with actual users, so: two calls, one file, double-gated.
//
//   E2E_AI=1 E2E_BASE_URL=https://demos.handsontable.com pnpm e2e e2e/ai-live.spec.ts

test.describe("AI endpoints answer usably", () => {
  test.skip(!process.env.E2E_BASE_URL, "needs a deployed API origin");
  test.skip(process.env.E2E_AI !== "1", "set E2E_AI=1 to spend LLM budget on live answer checks");
  test.describe.configure({ timeout: 120_000 });

  test("/api/chat returns an answer with the documented shape", async ({ request, baseURL }) => {
    const res = await request.post(`${baseURL}/api/chat`, {
      data: {
        messages: [{ role: "user", content: "How do I enable column sorting?" }],
        framework: "react",
        // Relative paths only — the validator silently drops anything else,
        // and an all-dropped map fails as "files are required".
        files: { "src/index.tsx": "import { HotTable } from '@handsontable/react-wrapper';\n" },
        snippets: [],
      },
    });

    // A shared per-IP bucket means a 429 is traffic, not a product failure.
    test.skip(res.status() === 429, "chat rate limit reached from this IP — not a product failure");
    expect(res.status(), await res.text().catch(() => "")).toBe(200);

    const body = (await res.json()) as { message?: unknown; edits?: unknown; references?: unknown; pages?: unknown };
    expect(typeof body.message).toBe("string");
    expect((body.message as string).trim().length).toBeGreaterThan(0);
    expect(Array.isArray(body.edits)).toBe(true);
    expect(Array.isArray(body.references)).toBe(true);
    expect(Array.isArray(body.pages)).toBe(true);
  });

  test("/api/theme returns a whitelist-clean suggestion", async ({ request, baseURL }) => {
    const res = await request.post(`${baseURL}/api/theme`, {
      data: { prompt: "corporate green", current: {} },
    });

    test.skip(res.status() === 429, "theme shares the chat rate bucket — not a product failure");
    expect(res.status(), await res.text().catch(() => "")).toBe(200);

    const body = (await res.json()) as {
      message?: unknown;
      tokens?: Record<string, unknown>;
      palette?: Record<string, unknown>;
      config?: Record<string, unknown>;
    };
    expect(typeof body.message).toBe("string");

    // The whitelist is the product's own generated set — every token key the
    // model got past the sanitiser must be in it, or the sanitiser regressed.
    for (const key of Object.keys(body.tokens ?? {})) {
      expect(TOKEN_KEYS.has(key), `token "${key}" is in the generated whitelist`).toBe(true);
    }
    for (const key of Object.keys(body.palette ?? {})) {
      expect(key).toMatch(/^(primary\.\d+|palette\.\d+|white|black)$/);
    }

    // "corporate green" must move *something* — an empty suggestion is a 200
    // that helps nobody (the DEV-2497 class of quiet failure).
    const moved =
      Object.keys(body.tokens ?? {}).length + Object.keys(body.palette ?? {}).length +
      Object.keys(body.config ?? {}).length;
    expect(moved, "the suggestion changes at least one thing").toBeGreaterThan(0);
  });
});
