import { test, expect, type Page } from "@playwright/test";
import { abortSandpackHosts } from "./helpers";

// The Theme builder in the demo runner (DEV-4070): the parts of the old
// theme-builder app that are new here — the styling chat as a conversation, the
// wide layout, and a link that opens a demo with the panel already open.
//
// Deterministic: the bundler is aborted and `/api/theme` is stubbed, so these
// assert the panel's own behaviour, not a model's taste. Where a request body is
// the property under test, it is read off the intercepted request.

const PANEL = 'aside[aria-label="Theme builder for this demo"]';

const GREEN_RAMP = {
  "primary.100": "#e6f4ea",
  "primary.200": "#b9dfc4",
  "primary.300": "#7dbf90",
  "primary.400": "#3d9e58",
  "primary.500": "#1a7a38",
  "primary.600": "#0d5225",
} as const;

async function stubVersions(page: Page) {
  await page.route("**/api/versions", (route) =>
    route.fulfill({ json: { latest: "18.0.0", next: "19.0.0-next.1", versions: ["18.0.0", "17.1.0"] } }),
  );
  await abortSandpackHosts(page);
}

async function send(page: Page, prompt: string) {
  const panel = page.locator(PANEL);
  await panel.getByLabel("Describe the style you want").fill(prompt);
  await panel.getByRole("button", { name: "Send", exact: true }).click();
}

test.describe("Theme builder chat", () => {
  test("a follow-up is sent with the turns before it, and each answer says what changed", async ({ page }) => {
    await stubVersions(page);
    const bodies: { prompt: string; history?: { role: string; content: string }[] }[] = [];
    await page.route("**/api/theme", async (route) => {
      bodies.push(route.request().postDataJSON());
      const first = bodies.length === 1;
      await route.fulfill({
        json: first
          ? { message: "Green brand ramp.", tokens: {}, palette: GREEN_RAMP, config: {} }
          : { message: "Compact and dark.", tokens: {}, palette: {}, config: { density: "compact", colorScheme: "dark" } },
      });
    });

    await page.goto("/?example=react");
    await page.getByRole("button", { name: "Theme builder", exact: true }).click();
    const panel = page.locator(PANEL);
    await panel.getByRole("tab", { name: "AI" }).click();

    await send(page, "make it green");
    await expect(panel.getByText("Green brand ramp.")).toBeVisible();
    await expect(panel.locator('[aria-label="What changed"]').first()).toContainText("brand ramp");

    await send(page, "darker and denser");
    await expect(panel.getByText("Compact and dark.")).toBeVisible();

    expect(bodies).toHaveLength(2);
    expect(bodies[0].history ?? []).toEqual([]);
    // The second request carries the first exchange — that is what lets the
    // model read "darker" as "darker than the green".
    expect(bodies[1].prompt).toBe("darker and denser");
    expect(bodies[1].history).toEqual([
      { role: "user", content: "make it green" },
      { role: "assistant", content: "Green brand ramp." },
    ]);
    const second = panel.locator('[aria-label="What changed"]').nth(1);
    await expect(second).toContainText("dark scheme");
    await expect(second).toContainText("compact density");

    // Clearing the conversation clears what the next request remembers, not the theme.
    await panel.getByRole("button", { name: "Clear conversation" }).click();
    await expect(panel.getByText("Green brand ramp.")).toHaveCount(0);
    await expect(panel.getByText("Style it in your own words")).toBeVisible();
    await send(page, "warmer");
    await expect.poll(() => bodies.length).toBe(3);
    expect(bodies[2].history ?? []).toEqual([]);
  });

  test("a failed request takes its question back out of the conversation", async ({ page }) => {
    await stubVersions(page);
    await page.route("**/api/theme", (route) => route.fulfill({ status: 503, json: { error: "unavailable" } }));

    await page.goto("/?example=react");
    await page.getByRole("button", { name: "Theme builder", exact: true }).click();
    const panel = page.locator(PANEL);
    await panel.getByRole("tab", { name: "AI" }).click();

    await send(page, "make it green");
    await expect(panel.getByRole("status")).toBeVisible();
    // The prompt is back in the box to retry, and no orphan bubble is left
    // above it to be sent as history with the retry.
    await expect(panel.getByLabel("Describe the style you want")).toHaveValue("make it green");
    await expect(panel.locator(".hot-chat-bubble")).toHaveCount(0);
  });
});

test.describe("Theme builder layout", () => {
  test("the panel widens and narrows on demand", async ({ page }) => {
    await stubVersions(page);
    await page.goto("/?example=react");
    await page.getByRole("button", { name: "Theme builder", exact: true }).click();
    const panel = page.locator(PANEL);
    const width = () => panel.evaluate((el) => Math.round(el.getBoundingClientRect().width));

    await expect.poll(width).toBe(400);
    await panel.getByRole("button", { name: "Widen the theme builder" }).click();
    await expect.poll(width).toBe(720);
    await panel.getByRole("button", { name: "Narrow the theme builder" }).click();
    await expect.poll(width).toBe(400);
  });

  test("opening a component widens it into list and detail side by side", async ({ page }) => {
    await stubVersions(page);
    await page.goto("/?example=react&theme-builder&tab=component");
    const panel = page.locator(PANEL);
    const width = () => panel.evaluate((el) => Math.round(el.getBoundingClientRect().width));

    await expect.poll(width).toBe(400);
    await panel.getByRole("button", { name: "Buttons", exact: true }).click();
    await expect.poll(width).toBe(720);
    // The list stays beside the open component, so another is one click away.
    await expect(panel.getByRole("button", { name: "Buttons", exact: true })).toHaveAttribute("aria-current", "true");
    await panel.getByRole("button", { name: "Pagination", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Pagination", exact: true })).toHaveAttribute("aria-current", "true");
  });
});

test.describe("Theme builder link", () => {
  test("?theme-builder opens the panel on load, on the tab the link names", async ({ page }) => {
    await stubVersions(page);
    await page.goto("/?example=react&theme-builder&tab=ai");

    const panel = page.locator(PANEL);
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("tab", { name: "AI" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("button", { name: "Theme builder", exact: true })).toHaveAttribute("aria-pressed", "true");
  });

  test("?panel=theme-builder is the same link", async ({ page }) => {
    await stubVersions(page);
    await page.goto("/?example=react&panel=theme-builder");
    await expect(page.locator(PANEL)).toBeVisible();
  });

  test("the address bar follows the panel, so it is always the link to what is on screen", async ({ page }) => {
    await stubVersions(page);
    await page.goto("/?example=react");
    await expect(page.locator(PANEL)).toHaveCount(0);

    await page.getByRole("button", { name: "Theme builder", exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.has("theme-builder")).toBe(true);
    // The example and version survive alongside it.
    expect(new URL(page.url()).searchParams.get("example")).toBe("react");

    await page.locator(PANEL).getByRole("button", { name: "Close theme builder" }).click();
    await expect.poll(() => new URL(page.url()).searchParams.has("theme-builder")).toBe(false);

    // And a reload of the open state reopens it.
    await page.getByRole("button", { name: "Theme builder", exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.has("theme-builder")).toBe(true);
    await page.reload();
    await expect(page.locator(PANEL)).toBeVisible();
  });

  test("Copy link hands out the example with the panel open", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await stubVersions(page);
    await page.goto("/?example=react");
    await page.getByRole("button", { name: "Theme builder", exact: true }).click();

    const panel = page.locator(PANEL);
    await panel.getByRole("button", { name: "Copy a link to this demo with the Theme builder open" }).click();
    await expect(panel.locator("[data-theme-builder-link-note]")).toContainText("Link copied");

    const copied = new URL(await page.evaluate(() => navigator.clipboard.readText()));
    expect(copied.searchParams.has("theme-builder")).toBe(true);
    expect(copied.searchParams.get("example")).toBe("react");
    // The playground's link is honest that an unsaved theme is not in it.
    await expect(panel.locator("[data-theme-builder-link-note]")).toContainText("not in it until you save");
  });
});
