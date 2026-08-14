// The guide's routing and anchor slugs (DEV-2522).
//
// Two things are worth pinning here. Routing, because a stale `/guide/<something>`
// link must land on the overview rather than a blank page. And the anchors, because
// the page's contents list and the rendered headings get their ids from the same
// function by position — if that ordering or the de-duplication drifts, every
// deeplink in the guide silently scrolls to the wrong section.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const here = path.dirname(fileURLToPath(import.meta.url));
const docs = path.join(here, "../docs/guide");

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
  for (const name of [...GUIDE_TRACKS.map((t) => t.slug), "overview"]) {
    const md = fs.readFileSync(path.join(docs, `${name}.md`), "utf8");
    const found = [...md.matchAll(/&[a-zA-Z]+;/g)].map((m) => m[0]);
    assert.deepEqual(found, [], `${name}.md contains HTML entities: ${found.join(", ")}`);
  }
});
