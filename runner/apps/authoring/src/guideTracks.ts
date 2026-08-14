// The guide's route table and anchor slugs (DEV-2522).
//
// `/guide` used to be one document; four teams need four pages, so it is now an
// overview plus one track per audience. This module is the part worth testing on
// its own: which path means which track, and what a heading's deeplink anchor is.
//
// Dependency-free on purpose — `pipeline/guide-tracks.test.mjs` imports it with
// `--experimental-strip-types`, which cannot resolve sibling `./x.js` specifiers.
// The markdown itself is imported (`?raw`) by `Guide.tsx`, not here, for the same
// reason: a Vite import would make this file untestable in node.

export type GuideTrackSlug = "everyone" | "support" | "devrel" | "developers";

export interface GuideTrack {
  slug: GuideTrackSlug;
  /** Nav label. Short — it sits in a tab strip. */
  label: string;
  /** Who the track is written for, shown as its badge. */
  audience: string;
  /** One sentence on the overview card. */
  blurb: string;
  /** Three things the track covers, for the card's list. */
  covers: string[];
  /** True for the tracks that need no code, so the overview can group them. */
  technical: boolean;
}

/** Display order, on the cards and in the tab strip: least technical first. */
export const GUIDE_TRACKS: GuideTrack[] = [
  {
    slug: "everyone",
    label: "Ask Claude",
    audience: "Everyone · non-technical",
    blurb:
      "Describe the demo you want in a sentence and get the client link back. No editor, no files, no browser step.",
    covers: [
      "Creating a demo through the Handsontable MCP",
      "Which of the four links to send",
      "What to check before a client sees it",
    ],
    technical: false,
  },
  {
    slug: "support",
    label: "In the browser",
    audience: "Support",
    blurb:
      "Every route you can take without leaving the playground: starters, documentation examples, forks, imports and file drops.",
    covers: [
      "Starters, blank templates and docs examples",
      "Importing a customer's JSFiddle or StackBlitz",
      "Title, description, Save, and the client link",
    ],
    technical: false,
  },
  {
    slug: "devrel",
    label: "Docs & blog",
    audience: "DevRel",
    blurb:
      "Turning a demo into a running example inside a page we publish, and keeping it working after the next release.",
    covers: [
      "The embed URL, and sizing the iframe",
      "Pinning the version an article claims",
      "Styling a demo to match the page",
    ],
    technical: true,
  },
  {
    slug: "developers",
    label: "PR builds & tooling",
    audience: "Developers",
    blurb:
      "Demos built from an unreleased pull request or a nightly, published from your own project, and what to do when a build fails.",
    covers: [
      "A pull request number as the version",
      "Tier-1 vs container starters, and the budget",
      "The publish-demo plugin, and what the runner accepts",
    ],
    technical: true,
  },
];

const SLUGS = new Set<string>(GUIDE_TRACKS.map((t) => t.slug));

export function isGuideTrackSlug(value: string): value is GuideTrackSlug {
  return SLUGS.has(value);
}

export function guideTrack(slug: string): GuideTrack | null {
  return GUIDE_TRACKS.find((t) => t.slug === slug) ?? null;
}

export interface GuideRoute {
  /** null on the overview. */
  track: GuideTrackSlug | null;
  /** True when the path named a track that does not exist — the page says so
   *  rather than rendering an empty column, and still shows the overview. */
  unknown: boolean;
}

/**
 * Parse `/guide`, `/guide/`, `/guide/support`, `/guide/support/`.
 *
 * A path this cannot read is *not* an error: it resolves to the overview with
 * `unknown` set, because a stale link (a renamed track, a typo in Slack) should
 * land somewhere useful.
 */
export function parseGuideRoute(pathname: string): GuideRoute {
  const rest = pathname.replace(/^\/guide\/?/, "").replace(/\/+$/, "");
  if (rest === "") return { track: null, unknown: false };
  const slug = decodeURIComponent(rest).toLowerCase();
  if (isGuideTrackSlug(slug)) return { track: slug, unknown: false };
  return { track: null, unknown: true };
}

/** The path a track is served at. */
export function guidePath(slug: GuideTrackSlug): string {
  return `/guide/${slug}`;
}

/**
 * A heading's anchor: lowercase, non-alphanumerics collapsed to single dashes.
 *
 * Markdown emphasis and code marks are stripped first, so `**Save** the demo` and
 * `Save the demo` anchor the same — the marks are formatting, not identity.
 */
export function headingSlug(text: string): string {
  return text
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/[*_]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface GuideSection {
  /** 1 for `#`, 2 for `##`, 3 for `###`… */
  level: number;
  title: string;
  id: string;
}

/**
 * Every heading of a document, in order, with its anchor id.
 *
 * Fenced code blocks are skipped: a `# comment` inside a shell example is not a
 * heading, and treating it as one puts nonsense in the contents list and shifts
 * every id after it.
 *
 * Duplicate headings get `-2`, `-3`… suffixes, so every id on the page is unique
 * and a deeplink cannot be ambiguous. The order is the renderer's order too, which
 * is what lets the page hand `Markdown` these ids by position rather than making
 * the renderer slug anything itself.
 */
export function guideHeadings(markdown: string): GuideSection[] {
  const headings: GuideSection[] = [];
  const seen = new Map<string, number>();
  let inFence = false;

  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!m) continue;

    const title = m[2]!.replace(/`([^`]*)`/g, "$1").replace(/\*\*([^*]*)\*\*/g, "$1");
    const base = headingSlug(m[2]!);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    headings.push({
      level: m[1]!.length,
      title,
      // An emoji-only heading would slug to "", which is not a usable anchor;
      // position keeps it unique without pretending it has a name.
      id: base === "" ? `section-${headings.length + 1}` : count === 1 ? base : `${base}-${count}`,
    });
  }

  return headings;
}

/** The subset a track's "on this page" list shows: its `##` and `###` headings. */
export function guideSections(markdown: string): GuideSection[] {
  return guideHeadings(markdown).filter((h) => h.level === 2 || h.level === 3);
}

/** The document's `# ` title, or null — the page uses it as the heading. */
export function guideTitle(markdown: string): string | null {
  const m = /^#\s+(.+?)\s*$/m.exec(markdown);
  return m ? m[1]!.trim() : null;
}
