import test from "node:test";
import assert from "node:assert/strict";
import {
  applyHandsontableCss,
  pickLatestNextVersion,
  selectedReleaseMajor,
  validateHandsontableVersion,
} from "../packages/runtime/dist/version.js";

// DEV-2207: `dist/handsontable.full.min.css` was removed from the package at
// 17.0.0, so every pre-DEV-2207 artifact 404s at >=17 — where core injects its
// own core stylesheet and applies `mainTheme` anyway, making the link both dead
// and unnecessary. The wrapper no longer emits it; applyHandsontableCss is now
// only a migration shim for demos already saved with it baked in: strip at >=17
// (and for -next builds), rewrite the version segment at <=16, where the file is
// still published and is the only thing that styles a class-less grid.
const cssUrl = (version) =>
  `https://unpkg.com/handsontable@${version}/dist/handsontable.full.min.css`;
const cssLink = (version) => `  <link rel="stylesheet" href="${cssUrl(version)}" />\n`;

test("strips the legacy CSS link at majors >= 17, in root and src/index.html", () => {
  const files = {
    "/index.html": `<head>\n${cssLink("18.0.0")}  <title>x</title>\n</head>`,
    "/src/main.ts": "console.log('unchanged');",
  };

  const result = applyHandsontableCss(files, { ref: "17.1.0", pkgPrNew: false });

  assert.notStrictEqual(result, files);
  // The whole line goes, indentation and newline included — no blank line left.
  assert.equal(result["/index.html"], "<head>\n  <title>x</title>\n</head>");
  assert.equal(result["/src/main.ts"], files["/src/main.ts"]);

  // Angular's HTML lives at src/index.html; same treatment.
  const angular = applyHandsontableCss(
    { "/src/index.html": `<head>\n${cssLink("18.0.0")}</head>` },
    { ref: "18.0.0", pkgPrNew: false },
  );
  assert.equal(angular["/src/index.html"], "<head>\n</head>");
});

// The trap this test exists for: a nightly is `0.0.0-next-<hash>-<date>`, whose
// plain-semver major is 0. A naive `major <= 16` check therefore classifies the
// NEWEST core as legacy-era and re-pins the dead URL onto it — and `next` is the
// larger docs bucket, so that would be the majority of saved demos.
test("strips the legacy CSS link for -next builds, whose semver major is a misleading 0", () => {
  // `17.0.0-rc15` is here to pin the other half of the prerelease rule: an rc is
  // a normal release candidate, so its real major (17) decides, and it strips.
  // Loosening the -next regex to prereleases generally would flip it to rewrite.
  for (const ref of ["0.0.0-next-232ad3d-20260810", "19.0.0-next.2", "17.0.0-rc15"]) {
    const result = applyHandsontableCss(
      { "/index.html": `<head>\n${cssLink("18.0.0")}</head>` },
      { ref, pkgPrNew: false },
    );
    assert.equal(result["/index.html"], "<head>\n</head>", `${ref} should strip, not rewrite`);
  }
});

test("rewrites the version segment at majors <= 16, where the legacy file still exists", () => {
  for (const ref of ["16.2.0", "15.0.0", "16.2.0-rc1"]) {
    const result = applyHandsontableCss(
      { "/index.html": `<head>\n${cssLink("18.0.0")}</head>` },
      { ref, pkgPrNew: false },
    );
    assert.equal(result["/index.html"], `<head>\n${cssLink(ref)}</head>`);
  }
});

test("leaves files unchanged without a matching HTML entry or for pkg.pr.new versions", () => {
  const noHtmlFiles = { "/src/main.ts": "console.log('unchanged');" };
  assert.strictEqual(
    applyHandsontableCss(noHtmlFiles, { ref: "17.1.0", pkgPrNew: false }),
    noHtmlFiles,
  );

  const pkgPrNewFiles = {
    "/index.html": `<link rel="stylesheet" href="${cssUrl("18.0.0")}" />`,
  };
  assert.strictEqual(
    applyHandsontableCss(pkgPrNewFiles, { ref: "1234", pkgPrNew: true }),
    pkgPrNewFiles,
  );

  // Post-DEV-2207 artifacts carry no Handsontable stylesheet, so the shim is a
  // no-op on them at every version — including the identity of the files map.
  const freshFiles = { "/index.html": "<head>\n  <title>x</title>\n</head>" };
  for (const ref of ["18.0.0", "16.2.0", "0.0.0-next-232ad3d-20260810"]) {
    assert.strictEqual(applyHandsontableCss(freshFiles, { ref, pkgPrNew: false }), freshFiles);
  }
});

// DEV-2102 / ADR-0021 decision 10: majors below 15 were never empirically
// verified, so validateHandsontableVersion rejects them by default — the same
// floor GET /api/versions already enforces, now also covering direct
// session/API calls that bypass the version dropdown.
test("rejects majors below the default floor (15)", () => {
  for (const value of ["14.5.0", "14", "14.2", "0.0.1"]) {
    const result = validateHandsontableVersion(value);
    assert.equal(result.ok, false, `expected ${value} to be rejected`);
    assert.match(result.message, /must be at least 15/);
  }
});

test("accepts majors within the default 15-19 range", () => {
  for (const value of ["15.0.0", "17.1", "19"]) {
    const result = validateHandsontableVersion(value);
    assert.equal(result.ok, true, `expected ${value} to be accepted`);
  }
});

test("pkg.pr.new refs bypass the floor (and ceiling) check", () => {
  assert.equal(validateHandsontableVersion("1234").ok, true);
  assert.equal(validateHandsontableVersion("https://pkg.pr.new/handsontable@abc123").ok, true);
});

test("custom minMajor/maxMajor override the defaults", () => {
  assert.equal(validateHandsontableVersion("14.0.0", 19, 10).ok, true);
  assert.equal(validateHandsontableVersion("9.0.0", 19, 10).ok, false);
});

// The npm `next` dist-tag went stale on 2026-02-19 while nightlies kept
// publishing — /api/versions kept advertising the February build as "next",
// re-pinning docs examples onto a five-month-old core at runtime. Never trust
// the tag: pick the newest `-next` version by publish date from the registry
// `time` map. (The importer applies the same rule at build time in
// pipeline/docs-import-config.mjs.)
test("pickLatestNextVersion picks the newest -next build by publish date", () => {
  const time = {
    created: "2020-01-01T00:00:00.000Z",
    modified: "2026-07-24T09:00:00.000Z",
    "18.0.1": "2026-06-02T10:00:00.000Z",
    // Alphabetically larger hash than the July builds — a string sort would
    // wrongly pick this one.
    "0.0.0-next-64139ae-20260219": "2026-02-19T04:00:00.000Z",
    "0.0.0-next-9366f60-20260723": "2026-07-23T04:00:00.000Z",
    "0.0.0-next-09631ad-20260724": "2026-07-24T04:00:00.000Z",
  };
  assert.equal(pickLatestNextVersion(time), "0.0.0-next-09631ad-20260724");
});

test("pickLatestNextVersion counts dotted -next prereleases and skips invalid dates", () => {
  assert.equal(
    pickLatestNextVersion({
      "19.0.0-next.2": "2026-07-01T00:00:00.000Z",
      "0.0.0-next-aaaaaaa-20260601": "not-a-date",
      "18.0.1": "2026-07-24T08:00:00.000Z",
    }),
    "19.0.0-next.2",
  );
});

test("pickLatestNextVersion returns null when no -next versions exist", () => {
  assert.equal(pickLatestNextVersion({ created: "2020-01-01T00:00:00.000Z", "18.0.1": "2026-06-02T10:00:00.000Z" }), null);
  assert.equal(pickLatestNextVersion({}), null);
  assert.equal(pickLatestNextVersion(undefined), null);
});

// DEV-2571 (Sentry DEMOS-1P): the authoring app used to read the major straight
// off the raw version string with /^(\d+)\./, so a bare npm-style partial — "16",
// "16.2", both of which validateHandsontableVersion accepts and both reachable
// through the version pencil and a hand-typed ?v= — answered null. null is the
// pass-through the theming gate grants `next`/pkg.pr.new refs, so `?v=16` opened
// the Style panel on a core with no theme API at all. Validate first: the major
// comes off the *normalized* ref, and null now means only "no semver here".
test("selectedReleaseMajor reads the major off the validated ref, partials included", () => {
  assert.equal(selectedReleaseMajor("17.1.0"), 17);
  assert.equal(selectedReleaseMajor("16"), 16);
  assert.equal(selectedReleaseMajor("16.2"), 16);
  assert.equal(selectedReleaseMajor(" 18.0.0 "), 18);
});

test("selectedReleaseMajor answers null only for refs carrying no comparable semver", () => {
  // The npm `next` nightly parses as major 0 and is really a post-18 build.
  assert.equal(selectedReleaseMajor("0.0.0-next-64139ae-20260219"), null);
  // A dotted prerelease is a -next build too.
  assert.equal(selectedReleaseMajor("19.0.0-next.1"), null);
  // pkg.pr.new build ids, bare and as a URL.
  assert.equal(selectedReleaseMajor("7940"), null);
  assert.equal(selectedReleaseMajor("https://pkg.pr.new/handsontable@7940"), null);
  // Anything the validator refuses has no major to report — a range, a dist-tag,
  // a major under the floor, junk.
  assert.equal(selectedReleaseMajor("^17.0.0"), null);
  assert.equal(selectedReleaseMajor("latest"), null);
  assert.equal(selectedReleaseMajor("14.0.0"), null);
  assert.equal(selectedReleaseMajor(""), null);
});
