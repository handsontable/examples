// The guide's routing and anchor slugs (DEV-2522), and its parity with the
// product it describes (DEV-2203).
//
// Three things are worth pinning here. Routing, because a stale `/guide/<something>`
// link must land on the overview rather than a blank page. The anchors, because
// the page's contents list and the rendered headings get their ids from the same
// function by position — if that ordering or the de-duplication drifts, every
// deeplink in the guide silently scrolls to the wrong section. And the facts,
// because the guide prints URLs, limits and starter names that live in the
// product — a number that drifts from its constant is a lie with a byline.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

import {
  GUIDE_TRACKS,
  guideHeadings,
  guidePath,
  guideSections,
  guideTitle,
  guideTrack,
  headingSlug,
  isGuideTrackSlug,
  parseGuideRoute,
} from "../apps/authoring/src/guideTracks.ts";
import { MAX_DESCRIPTION } from "../workers/api/src/demo-info.ts";
// Built output, the way version.test.mjs imports it: version.ts pulls in `semver`
// via `./types.js` specifiers that --experimental-strip-types cannot resolve.
import { DEFAULT_MAX_MAJOR, DEFAULT_MIN_MAJOR } from "../packages/runtime/dist/version.js";

// mcp-create.ts stopped being import-free once the build-toolchain gate landed
// (Sentry DEMOS-31): it now pulls in build-command.js by the repo's NodeNext-
// style specifier, which bare --experimental-strip-types cannot resolve — the
// same reason mcp-create.test.mjs and mcp-routes.test.mjs already register the
// .js->.ts hook before importing it dynamically.
register("./fixtures/worker-hooks.mjs", import.meta.url);
const { MAX_MCP_BYTES, MAX_MCP_FILES } = await import("../workers/api/src/mcp-create.ts");

const here = path.dirname(fileURLToPath(import.meta.url));
const docs = path.join(here, "../docs/guide");

/** Every track plus the overview, read once — the parity tests below scan them all. */
const DOC_NAMES = [...GUIDE_TRACKS.map((t) => t.slug), "overview"];
const readDoc = (name) => fs.readFileSync(path.join(docs, `${name}.md`), "utf8");

/** A constant that is not exported (or lives in a module the test runner cannot
 *  import, like the worker entry) is read out of the source instead — the
 *  arrangement theme-tokens.test.mjs uses for its generated-file guards. */
function sourceConst(relPath, name) {
  const source = fs.readFileSync(path.join(here, relPath), "utf8");
  const m = source.match(new RegExp(`const ${name} = ([^;]+);`));
  assert.ok(m, `${relPath} no longer declares ${name} — update the guide and this test`);
  return m[1];
}

test("the four tracks are the four routes, least technical first", () => {
  assert.deepEqual(
    GUIDE_TRACKS.map((t) => t.slug),
    ["everyone", "support", "devrel", "developers"],
  );
  // The non-technical pair leads: the overview groups the cards in this order, and
  // someone in sales should not have to read past "PR builds" to find their page.
  assert.deepEqual(
    GUIDE_TRACKS.map((t) => t.technical),
    [false, false, true, true],
  );
  for (const t of GUIDE_TRACKS) {
    assert.equal(guidePath(t.slug), `/guide/${t.slug}`);
    assert.equal(guideTrack(t.slug)?.slug, t.slug);
    assert.ok(t.label && t.audience && t.blurb, `${t.slug} needs a label, audience and blurb`);
    assert.equal(t.covers.length, 3, `${t.slug} card lists three things`);
  }
  assert.equal(guideTrack("nope"), null);
  assert.ok(isGuideTrackSlug("support"));
  assert.ok(!isGuideTrackSlug("Support "));
});

test("route parsing: overview, tracks, trailing slashes, and stale links", () => {
  assert.deepEqual(parseGuideRoute("/guide"), { track: null, unknown: false });
  assert.deepEqual(parseGuideRoute("/guide/"), { track: null, unknown: false });
  assert.deepEqual(parseGuideRoute("/guide/support"), { track: "support", unknown: false });
  assert.deepEqual(parseGuideRoute("/guide/support/"), { track: "support", unknown: false });
  // Case and encoding, because links get typed and copied by hand.
  assert.deepEqual(parseGuideRoute("/guide/DevRel"), { track: "devrel", unknown: false });
  assert.deepEqual(parseGuideRoute("/guide/%64evelopers"), { track: "developers", unknown: false });
  // A track that does not exist is the overview *plus* a word about it — never an
  // empty page, and never a redirect that hides the typo.
  assert.deepEqual(parseGuideRoute("/guide/marketing"), { track: null, unknown: true });
  assert.deepEqual(parseGuideRoute("/guide/support/extra"), { track: null, unknown: true });
});

test("heading slugs ignore markdown marks, punctuation and case", () => {
  assert.equal(headingSlug("What this site is"), "what-this-site-is");
  assert.equal(headingSlug("1. Pick a starting point"), "1-pick-a-starting-point");
  assert.equal(headingSlug("Save, fork, share"), "save-fork-share");
  // Emphasis and code marks are formatting, not identity: the same heading with and
  // without them has to anchor to the same place.
  assert.equal(headingSlug("**Save** the demo"), headingSlug("Save the demo"));
  assert.equal(headingSlug("The `.env` rule"), "the-env-rule");
  assert.equal(headingSlug("  Trailing --- dashes  "), "trailing-dashes");
  assert.equal(headingSlug("Ask Claude for a demo"), "ask-claude-for-a-demo");
});

test("headings come back in document order, with code fences skipped", () => {
  const md = [
    "# Title",
    "",
    "## First section",
    "",
    "```bash",
    "# not a heading, a shell comment",
    "## neither is this",
    "```",
    "",
    "### A subsection",
    "",
    "~~~",
    "# nor this, tilde-fenced",
    "~~~",
    "",
    "## Second section",
  ].join("\n");

  assert.deepEqual(guideHeadings(md), [
    { level: 1, title: "Title", id: "title" },
    { level: 2, title: "First section", id: "first-section" },
    { level: 3, title: "A subsection", id: "a-subsection" },
    { level: 2, title: "Second section", id: "second-section" },
  ]);
  // The contents list shows `##`/`###` only: the `#` is the page title, already
  // rendered above the list.
  assert.deepEqual(
    guideSections(md).map((s) => s.id),
    ["first-section", "a-subsection", "second-section"],
  );
  assert.equal(guideTitle(md), "Title");
  assert.equal(guideTitle("## No title here"), null);
});

test("repeated headings get unique ids, so no deeplink is ambiguous", () => {
  const md = ["## Before you send", "## Details", "### Before you send", "## Details"].join("\n");
  assert.deepEqual(
    guideHeadings(md).map((h) => h.id),
    ["before-you-send", "details", "before-you-send-2", "details-2"],
  );
});

test("a heading that slugs to nothing still gets a usable id", () => {
  // Not hypothetical for long: the moment someone writes an emoji-only heading, a
  // bare "" id would collide with every other one and anchor nowhere.
  const ids = guideHeadings(["## 🎉", "## 🎉"].join("\n")).map((h) => h.id);
  assert.deepEqual(ids, ["section-1", "section-2"]);
});

test("every shipped track document is renderable and anchorable", () => {
  for (const track of GUIDE_TRACKS) {
    const md = fs.readFileSync(path.join(docs, `${track.slug}.md`), "utf8");
    // Each track owns its title, because the page renders no heading of its own.
    assert.ok(guideTitle(md), `${track.slug}.md needs a "# " title`);
    const sections = guideSections(md);
    assert.ok(sections.length >= 4, `${track.slug}.md has ${sections.length} sections`);
    assert.equal(
      new Set(sections.map((s) => s.id)).size,
      sections.length,
      `${track.slug}.md produced a duplicate anchor`,
    );
  }

  // The overview is the exception, and deliberately so: its title and the four track
  // cards are drawn by the page, so a `# ` heading here would render twice.
  const overview = fs.readFileSync(path.join(docs, "overview.md"), "utf8");
  assert.equal(guideTitle(overview), null, "overview.md must not carry a `# ` heading");
  assert.ok(guideSections(overview).length >= 4);
});

test("the tracks divide the material rather than repeating it", () => {
  const read = (name) => fs.readFileSync(path.join(docs, `${name}.md`), "utf8");
  const everyone = read("everyone");
  const support = read("support");
  const devrel = read("devrel");
  const developers = read("developers");

  // The division the ticket asked for, asserted where it is falsifiable: each
  // team's own subject is on its own page, and the two that are easy to blur —
  // PR builds and embedding — sit on exactly one page each.
  assert.match(everyone, /Handsontable MCP/);
  assert.match(support, /My demos . Import|My demos &rarr; Import|My demos → Import/);
  assert.match(devrel, /embed\/<id>\//);
  assert.match(developers, /pkg\.pr\.new/);

  assert.ok(!/pkg\.pr\.new/.test(support), "PR builds belong to the developers track");
  assert.ok(!/pkg\.pr\.new/.test(everyone), "PR builds belong to the developers track");
  assert.ok(!/<iframe/.test(support), "embedding belongs to the devrel track");
});

test("every cross-track link points at a track that exists", () => {
  // The tracks refer to each other in prose, and a link to `/guide/marketing` would
  // land the reader on the overview's "does not exist" notice — a broken link that
  // looks like a working one. The parser only admits root-relative paths, so these
  // are the only guide links that can be written.
  const slugs = new Set(GUIDE_TRACKS.map((t) => t.slug));
  let seen = 0;
  for (const name of [...GUIDE_TRACKS.map((t) => t.slug), "overview"]) {
    const md = fs.readFileSync(path.join(docs, `${name}.md`), "utf8");
    for (const m of md.matchAll(/\]\(\/guide\/([a-z-]+)(#[^)]*)?\)/g)) {
      seen += 1;
      assert.ok(slugs.has(m[1]), `${name}.md links to /guide/${m[1]}, which is not a track`);
    }
  }
  // And the cross-links are actually there: the same-tab rendering they rely on is
  // dead code otherwise, which is how it shipped broken the first time.
  assert.ok(seen >= 3, `expected the tracks to cross-reference each other, found ${seen} links`);
});

test("every figure the guide references is a file the app ships", () => {
  const assets = path.join(here, "../apps/authoring/public");
  let seen = 0;
  for (const name of [...GUIDE_TRACKS.map((t) => t.slug), "overview"]) {
    const md = fs.readFileSync(path.join(docs, `${name}.md`), "utf8");
    for (const m of md.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)) {
      seen += 1;
      const [, alt, src] = m;
      // Same-origin paths only: the parser drops anything else to plain text, so a
      // URL here would render as a stray sentence rather than a figure.
      assert.ok(src.startsWith("/guide/"), `${name}.md: ${src} is not a /guide/ asset`);
      assert.ok(alt.length > 12, `${name}.md: ${src} needs real alt text, got "${alt}"`);
      assert.ok(
        fs.existsSync(path.join(assets, src.replace(/^\//, ""))),
        `${name}.md references ${src}, which is not in apps/authoring/public`,
      );
    }
  }
  assert.ok(seen >= 8, `expected the guide to carry figures, found ${seen}`);

  // …and nothing sits in the assets folder unused: these ship with the app, and a
  // forgotten screenshot is weight in every deploy.
  const referenced = new Set();
  for (const name of [...GUIDE_TRACKS.map((t) => t.slug), "overview"]) {
    const md = fs.readFileSync(path.join(docs, `${name}.md`), "utf8");
    for (const m of md.matchAll(/!\[[^\]]*\]\(\/guide\/([^)\s]+)\)/g)) referenced.add(m[1]);
  }
  for (const file of fs.readdirSync(path.join(assets, "guide"))) {
    assert.ok(referenced.has(file), `apps/authoring/public/guide/${file} is referenced by no track`);
  }
});

test("no HTML entities in the guide's markdown", () => {
  // The renderer prints text verbatim — it builds React elements and never touches
  // innerHTML, which is what makes it safe for model output. So `&mdash;` reaches the
  // reader as "&mdash;". Write the character.
  for (const name of DOC_NAMES) {
    const md = readDoc(name);
    const found = [...md.matchAll(/&[a-zA-Z]+;/g)].map((m) => m[0]);
    assert.deepEqual(found, [], `${name}.md contains HTML entities: ${found.join(", ")}`);
  }
});

// ---- Parity with the product (DEV-2203) --------------------------------------
//
// The guide asserts facts about the runner: which URLs open, which limits apply,
// which starters run where. Those facts live in the product's own files, so the
// guide is tested against them — a reader pasting an example URL out of the guide
// must land on a page that exists.

test("every ?docs= URL the guide prints exists in the release bucket", () => {
  // The bucket the guide's unversioned URLs resolve to: the current release line.
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(here, "../apps/authoring/public/docs-examples/18.0/manifest.json"),
      "utf8",
    ),
  );
  const known = new Set(manifest.examples.map((e) => e.docsPath));

  let seen = 0;
  for (const name of DOC_NAMES) {
    // The path ends at the next query parameter (`&v=`, `&mode=`), closing
    // backtick (the URL tables), pipe, or whitespace (the code fences).
    for (const m of readDoc(name).matchAll(/[?&]docs=([^&\s)`|]+)/g)) {
      seen += 1;
      const docsPath = decodeURIComponent(m[1]);
      assert.ok(
        known.has(docsPath),
        `${name}.md prints ?docs=${docsPath}, which is not in the 18.0 bucket`,
      );
    }
  }
  // The guide leans on ?docs= URLs as the way in — them all vanishing would mean
  // the extraction regex broke, not that the guide went quiet.
  assert.ok(seen >= 4, `expected the guide to print ?docs= URLs, found ${seen}`);
});

test("the guide's numbers are the product's numbers", () => {
  const all = DOC_NAMES.map(readDoc).join("\n");

  // The MCP caps (everyone.md's "what it will not do", developers.md's limits).
  assert.match(all, new RegExp(`\\b${MAX_MCP_FILES} (?:text )?files\\b`));
  assert.match(all, new RegExp(`\\b${MAX_MCP_BYTES / 1024} KB\\b`));

  // The drop ceiling is a different constant than the MCP's (Bugbot, #188):
  // developers.md says the file drop "stops at N files", and that N is
  // dropFiles.ts's own MAX_DROP_FILES — the two ceilings can diverge.
  const maxDrop = Number(sourceConst("../packages/editor-shell/src/dropFiles.ts", "MAX_DROP_FILES"));
  assert.match(all, new RegExp(`stops at ${maxDrop} files`));

  // The description field's ceiling (support.md's title-and-description section).
  assert.match(all, new RegExp(`\\b${MAX_DESCRIPTION.toLocaleString("en-US")} characters\\b`));

  // The version range and the bare-integer rule (developers.md). The guide commits
  // to the exact split: majors read as versions, the refused gap, the PR-ref floor.
  const minBare = Number(sourceConst("../packages/runtime/src/version.ts", "MIN_BARE_NUMERIC_PKG_PR_NEW_REF"));
  assert.match(all, new RegExp(`\\*\\*${DEFAULT_MIN_MAJOR}–${DEFAULT_MAX_MAJOR}\\*\\*`));
  assert.match(all, new RegExp(`≥ ${minBare}\\b`));
  assert.match(all, new RegExp(`from ${minBare} up`));
  assert.match(all, new RegExp(`\`${DEFAULT_MAX_MAJOR + 1}\`–\`${minBare - 1}\``));

  // The Theme Builder handover TTL (overview.md's URL table, support.md). The worker
  // entry cannot be imported here, so the declaration is pinned instead: if the TTL
  // stops being 24 hours, this fails and the guide gets rewritten with it.
  assert.equal(sourceConst("../workers/api/src/index.ts", "PAYLOAD_TTL_SECONDS"), "24 * 60 * 60");
  assert.match(all, /\b24 hours\b/);
});

test("the guide's starter keys match the catalog", () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(here, "../catalog.json"), "utf8"));
  const keys = new Set(catalog.examples.map((e) => e.framework));

  let seen = 0;
  for (const name of DOC_NAMES) {
    const md = readDoc(name);
    // Every ?example= the guide prints must open something.
    for (const m of md.matchAll(/[?&]example=([A-Za-z0-9.-]+)/g)) {
      seen += 1;
      assert.ok(keys.has(m[1]), `${name}.md prints ?example=${m[1]}, which is not a catalog key`);
    }
    // The URL table lists alternates as bare code spans next to the ?example= rows
    // ("also `blank-ts`, `blank-react`") — those are keys too, and rename with them.
    for (const line of md.split("\n")) {
      if (!line.includes("?example=")) continue;
      for (const m of line.matchAll(/`([a-z][a-z0-9.-]*)`/g)) {
        seen += 1;
        assert.ok(keys.has(m[1]), `${name}.md lists \`${m[1]}\` as a starter, which is not a catalog key`);
      }
    }
  }
  assert.ok(seen >= 5, `expected the guide to name starters, found ${seen}`);
});

test("the guide's container claims match the catalog engines", () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(here, "../catalog.json"), "utf8"));
  const byKey = new Map(catalog.examples.map((e) => [e.framework, e]));

  // The names the prose uses, mapped to catalog keys — the display names carry
  // qualifiers ("React (Vite, JS)") that the slugs do not.
  const NAME_TO_KEY = [
    ["Angular", "angular"],
    ["Next.js", "next.js"],
    ["Nuxt", "nuxt"],
    ["Astro", "astro"],
    ["Remix", "remix"],
    ["MUI", "mui"],
    ["Ant Design", "ant-design"],
    ["Fluent UI", "fluent-ui"],
    ["Base Web", "base-web"],
    ["React (Vite, JS)", "react-js"],
  ];
  const IN_BROWSER_NAMES = [
    ["JavaScript", "javascript"],
    ["TypeScript", "typescript"],
    ["React", "react"],
    ["Vue", "vue"],
  ];

  const md = readDoc("developers");
  const start = md.indexOf("## Where a demo runs");
  assert.ok(start >= 0, "developers.md lost its 'Where a demo runs' section");
  const nextHeading = md.indexOf("\n## ", start + 1);
  const section = md.slice(start, nextHeading === -1 ? undefined : nextHeading);

  // The catalog's `tier` field does not track the engine split (the UI-library
  // starters are tier 1 *and* engine "container"), which is exactly how the guide
  // once drifted. The section speaks in engines; tiers stay out of it.
  assert.ok(!/tier[- ]?\d/i.test(section), "developers.md claims catalog tiers; speak in engines");

  const split = section.indexOf("**Container**");
  assert.ok(split >= 0, "developers.md lost its container bullet");
  const inBrowserPart = section.slice(0, split);
  const containerPart = section.slice(split);

  let found = 0;
  for (const [displayName, key] of NAME_TO_KEY) {
    if (!containerPart.includes(displayName)) continue;
    found += 1;
    assert.equal(
      byKey.get(key)?.engine,
      "container",
      `developers.md lists ${displayName} as a container starter, but catalog.json says engine=${byKey.get(key)?.engine}`,
    );
  }
  assert.ok(found >= 9, `expected the container list to name the container starters, found ${found}`);

  for (const [displayName, key] of IN_BROWSER_NAMES) {
    assert.ok(inBrowserPart.includes(displayName), `the in-browser bullet lost ${displayName}`);
    assert.equal(
      byKey.get(key)?.engine,
      "sandpack",
      `developers.md lists ${displayName} as in-browser, but catalog.json says engine=${byKey.get(key)?.engine}`,
    );
  }
});

test("every MCP prompt in the guide names the tool it needs", () => {
  // Claude fetches tools on demand: a prompt that does not start with `Load
  // create_demo` / `Load update_demo` is the one that comes back "I do not have that
  // tool", and the reader on this track has no way to diagnose that.
  const fenced = /```\n([\s\S]*?)```/g;
  let checked = 0;
  for (const name of [...GUIDE_TRACKS.map((t) => t.slug), "overview"]) {
    const md = fs.readFileSync(path.join(docs, `${name}.md`), "utf8");
    for (const m of md.matchAll(fenced)) {
      const body = m[1];
      // Naming either tool is what makes a block an MCP prompt — no second filter.
      // The first version also tested `\bdemo\b` (which cannot match inside
      // `update_demo`) and excluded blocks with a URL on their own line, which between
      // them skipped the one prompt this test exists to guard.
      if (!/create_demo|update_demo/.test(body)) continue;
      checked += 1;
      assert.match(
        body.trim(),
        /^Load (create_demo|update_demo),/,
        `${name}.md has a prompt that does not open by loading the tool: ${body.trim().slice(0, 60)}`,
      );
    }
  }
  assert.ok(checked >= 6, `expected the guide to carry MCP prompts, found ${checked}`);
});
