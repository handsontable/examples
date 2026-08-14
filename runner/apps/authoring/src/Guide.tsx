// The in-app guide (`/guide`, DEV-2503; role-based tracks, DEV-2522).
//
// One document became four, because four teams read this page for four different
// reasons: someone in sales wants one sentence typed into Claude, support wants the
// browser routes, DevRel wants embeds, a developer wants a demo built from a pull
// request. A single scroll made each of them skim three quarters of it.
//
// The content is `runner/docs/guide/*.md`, imported raw and rendered with the same
// markdown renderer the Ask AI panel uses. One source of truth on purpose: a second
// copy inside a .tsx would drift from the docs within a release, and the docs are the
// version that gets reviewed in PRs.
//
// Page shell follows `Settings.tsx` — same top bar, same left nav — because this is
// the third page of that family; the only thing added here is the track switcher and
// the contents list, which are navigation, not prose.

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { SideNav, TopBar, shellStyles, theme } from "@handsontable/demo-editor-shell";
import overviewMarkdown from "../../../docs/guide/overview.md?raw";
import everyoneMarkdown from "../../../docs/guide/everyone.md?raw";
import supportMarkdown from "../../../docs/guide/support.md?raw";
import devrelMarkdown from "../../../docs/guide/devrel.md?raw";
import developersMarkdown from "../../../docs/guide/developers.md?raw";
import { logout, type User } from "./auth.js";
import { Markdown } from "./markdown.js";
import {
  GUIDE_TRACKS,
  guideHeadings,
  guidePath,
  guideSections,
  guideTitle,
  guideTrack,
  parseGuideRoute,
  type GuideTrack,
  type GuideTrackSlug,
} from "./guideTracks.js";
import { useProfile } from "./useProfile.js";

/** The tracks' text, keyed the way the route names them. */
const TRACK_MARKDOWN: Record<GuideTrackSlug, string> = {
  everyone: everyoneMarkdown,
  support: supportMarkdown,
  devrel: devrelMarkdown,
  developers: developersMarkdown,
};

export interface GuidePageProps {
  apiBase: string;
  user: User;
}

export function GuidePage({ apiBase, user }: GuidePageProps) {
  const profile = useProfile(apiBase, user.email);
  const route = parseGuideRoute(location.pathname);
  const track = route.track ? guideTrack(route.track) : null;

  return (
    <div style={{ ...shellStyles.shell, gridTemplateRows: "auto 1fr" }}>
      <TopBar
        examplePill={
          <div style={shellStyles.examplePill(false)}>
            <span style={shellStyles.pillLabel}>{track ? track.label : "Guide"}</span>
          </div>
        }
        accountEmail={user.email}
        accountDisplayName={profile?.display_name}
        accountAvatarUrl={profile?.avatar_url}
        onMyDemos={() => { location.href = "/my-demos"; }}
        onSettings={() => { location.href = "/settings"; }}
        onGuide={() => { location.href = "/guide"; }}
        // Public target, as on Settings: this page sends a null user to `login()`,
        // so logging out to `/guide` would walk them straight back to the broker.
        onLogout={() => logout("/")}
      />

      <div style={body}>
        <SideNav
          active="guide"
          guideSubItems={GUIDE_TRACKS.map((t) => ({
            href: guidePath(t.slug),
            label: t.label,
            active: t.slug === route.track,
          }))}
          onLogout={() => logout("/")}
        />
        <main style={content}>
          {track ? (
            <TrackView track={track} markdown={TRACK_MARKDOWN[track.slug]} />
          ) : (
            <Overview unknown={route.unknown} />
          )}
        </main>
      </div>
    </div>
  );
}

/** `/guide` — what the site is, and which track to read. */
function Overview({ unknown }: { unknown: boolean }) {
  const headings = useMemo(() => guideHeadings(overviewMarkdown), []);
  const ids = useMemo(() => headings.map((h) => h.id), [headings]);

  return (
    <div style={column}>
      <p style={eyebrow}>Guide</p>
      <h1 style={pageTitle}>Using demos.handsontable.com</h1>
      <p style={lede}>
        Every way to build a live Handsontable demo and turn it into a link a client can
        open. Pick the track that matches your job — the four cover different routes to
        the same thing, and none of them needs a checkout.
      </p>

      {unknown && (
        <p style={notice} role="status">
          That guide page does not exist. Here are the four that do.
        </p>
      )}

      <div style={cardGrid}>
        {GUIDE_TRACKS.map((t) => (
          <TrackCard key={t.slug} track={t} />
        ))}
      </div>

      <article style={prose}>
        <Markdown text={overviewMarkdown} document headingIds={ids} />
      </article>
    </div>
  );
}

function TrackCard({ track }: { track: GuideTrack }) {
  return (
    <a href={guidePath(track.slug)} style={card} className="hot-guide-card">
      <div style={cardHead}>
        <span style={badge(track.technical)}>{track.audience}</span>
      </div>
      <h2 style={cardTitle}>{track.label}</h2>
      <p style={cardBlurb}>{track.blurb}</p>
      <ul style={cardList}>
        {track.covers.map((line) => (
          <li key={line} style={cardListItem}>{line}</li>
        ))}
      </ul>
      <span style={cardMore}>Read this track &rarr;</span>
    </a>
  );
}

/** `/guide/:track` — the switcher, the contents list, and one document. */
function TrackView({ track, markdown }: { track: GuideTrack; markdown: string }) {
  const headings = useMemo(() => guideHeadings(markdown), [markdown]);
  const ids = useMemo(() => headings.map((h) => h.id), [headings]);
  const sections = useMemo(() => guideSections(markdown), [markdown]);
  const title = guideTitle(markdown);

  // Scroll to the section a deeplink named. The browser does this itself on load —
  // but only against the document it has, and this one is empty until the identity
  // resolves and React mounts the prose, so by the time the heading exists the
  // browser has long given up. Without this, every `#section` link anyone pastes
  // lands the reader at the top of the page instead.
  useEffect(() => {
    const id = decodeURIComponent(location.hash.replace(/^#/, ""));
    if (!id) return;
    const target = ids.includes(id) ? document.getElementById(id) : null;
    target?.scrollIntoView();
  }, [ids]);

  return (
    <div style={column}>
      <div style={trackLayout}>
        <article style={prose}>
          {/* The document supplies its own `# ` heading; this page adds none — two
              would be a duplicated h1 in the same landmark. The badge above it is
              the one thing the file cannot say for itself. */}
          <p style={{ ...eyebrow, margin: `0 0 ${theme.space(2)}` }}>
            {track.audience}
          </p>
          <Markdown text={markdown} document headingIds={ids} />
        </article>

        <Contents track={track.slug} sections={sections} title={title} />
      </div>
    </div>
  );
}


/**
 * "On this page", and the page's deeplink surface: every row is an anchor to a
 * heading, and its `#` copies the absolute link to that section — the thing you paste
 * into a ticket instead of writing out the steps again.
 */
function Contents({
  track,
  sections,
  title,
}: {
  track: GuideTrackSlug;
  sections: { level: number; title: string; id: string }[];
  title: string | null;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 1400);
    return () => clearTimeout(t);
  }, [copied]);

  async function copy(id: string) {
    const url = `${location.origin}${guidePath(track)}#${id}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(id);
    } catch {
      // A denied clipboard is not a failure worth a dialog: the row is a link, so
      // the reader can still copy it the ordinary way.
      setCopied(null);
    }
  }

  if (sections.length === 0) return null;

  return (
    <aside style={contents} aria-label={title ? `Contents of ${title}` : "Contents"}>
      <p style={contentsHead}>On this page</p>
      <ul style={contentsList}>
        {sections.map((s) => (
          <li key={s.id} style={contentsItem(s.level)}>
            <a href={`#${s.id}`} style={contentsLink}>
              {s.title}
            </a>
            <button
              type="button"
              onClick={() => copy(s.id)}
              style={copyButton(copied === s.id)}
              title={`Copy a link to "${s.title}"`}
              aria-label={`Copy a link to "${s.title}"`}
            >
              {copied === s.id ? "copied" : "#"}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

const body: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "220px minmax(0, 1fr)",
  minHeight: 0,
  overflow: "hidden",
};

const content: CSSProperties = {
  padding: theme.space(6),
  overflowY: "auto",
  background: theme.color.surface,
};

/** One centred column for both views, so switching tracks does not move the page. */
const column: CSSProperties = {
  maxWidth: 1040,
  margin: "0 auto",
  paddingBottom: theme.space(8),
};

/** A reading measure, not the full window: this is prose, and a 1,000px line is
 *  unreadable. */
const prose: CSSProperties = {
  maxWidth: 720,
  minWidth: 0,
  fontFamily: theme.font.ui,
  fontSize: 14,
  lineHeight: 1.65,
  color: theme.color.text,
};

const trackLayout: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) 220px",
  gap: theme.space(6),
  alignItems: "start",
};

const eyebrow: CSSProperties = {
  margin: `0 0 ${theme.space(2)}`,
  fontFamily: theme.font.ui,
  fontSize: 11,
  letterSpacing: ".12em",
  textTransform: "uppercase",
  color: theme.color.textMuted,
};

const pageTitle: CSSProperties = {
  margin: `0 0 ${theme.space(3)}`,
  fontFamily: theme.font.ui,
  fontSize: 26,
  lineHeight: 1.15,
  letterSpacing: "-.01em",
  color: theme.color.text,
};

const lede: CSSProperties = {
  margin: `0 0 ${theme.space(5)}`,
  maxWidth: 640,
  fontFamily: theme.font.ui,
  fontSize: 14,
  lineHeight: 1.65,
  color: theme.color.textMuted,
};

const notice: CSSProperties = {
  margin: `0 0 ${theme.space(4)}`,
  padding: `${theme.space(2)} ${theme.space(3)}`,
  borderLeft: `2px solid ${theme.color.accent}`,
  background: theme.color.surfaceSunken,
  fontFamily: theme.font.ui,
  fontSize: 13,
  color: theme.color.text,
};

const cardGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))",
  gap: theme.space(3),
  marginBottom: theme.space(7),
};

/** No `border` here: the resting border lives in the app's stylesheet next to the
 *  hover, because an inline shorthand carries border-color and would outrank it —
 *  ADR-0026, and the mistake `.hot-demo-card` already documents. */
const card: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: theme.space(1),
  padding: theme.space(3),
  borderRadius: theme.radius.md,
  textDecoration: "none",
  color: theme.color.text,
  fontFamily: theme.font.ui,
};

const cardHead: CSSProperties = { display: "flex", alignItems: "center", gap: theme.space(1) };

const badge = (technical: boolean): CSSProperties => ({
  display: "inline-block",
  padding: "1px 6px",
  borderRadius: theme.radius.sm,
  border: `1px solid ${theme.color.border}`,
  background: technical ? theme.color.surfaceSunken : theme.color.accentSoft,
  color: technical ? theme.color.textMuted : theme.color.accent,
  fontSize: 10,
  letterSpacing: ".06em",
  textTransform: "uppercase",
});

const cardTitle: CSSProperties = {
  margin: `${theme.space(1)} 0 0`,
  fontSize: 15,
  lineHeight: 1.3,
  color: theme.color.text,
};

const cardBlurb: CSSProperties = {
  margin: 0,
  fontSize: 12.5,
  lineHeight: 1.55,
  color: theme.color.textMuted,
};

const cardList: CSSProperties = {
  margin: `${theme.space(1)} 0 0`,
  padding: 0,
  listStyle: "none",
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const cardListItem: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.5,
  color: theme.color.textMuted,
  paddingLeft: 10,
  position: "relative",
  // A dash, not a bullet: three of these sit inside a card that is already a list
  // item on the page, and a second bullet level reads as an outline.
  textIndent: -10,
};

const cardMore: CSSProperties = {
  marginTop: "auto",
  paddingTop: theme.space(2),
  fontSize: 12,
  color: theme.color.accent,
};



const contents: CSSProperties = {
  position: "sticky",
  top: 0,
  fontFamily: theme.font.ui,
};

const contentsHead: CSSProperties = {
  margin: `0 0 ${theme.space(2)}`,
  fontSize: 11,
  letterSpacing: ".1em",
  textTransform: "uppercase",
  color: theme.color.textMuted,
};

const contentsList: CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: "none",
  display: "flex",
  flexDirection: "column",
  gap: 1,
  borderLeft: `1px solid ${theme.color.border}`,
};

const contentsItem = (level: number): CSSProperties => ({
  display: "flex",
  alignItems: "baseline",
  gap: 4,
  paddingLeft: level === 3 ? theme.space(3) : theme.space(2),
});

const contentsLink: CSSProperties = {
  flex: 1,
  fontSize: 12,
  lineHeight: 1.45,
  color: theme.color.textMuted,
  textDecoration: "none",
};

const copyButton = (copied: boolean): CSSProperties => ({
  flex: "0 0 auto",
  padding: "0 3px",
  border: "none",
  background: "transparent",
  color: copied ? theme.color.accent : theme.color.textMuted,
  fontFamily: theme.font.ui,
  fontSize: 10,
  cursor: "pointer",
});
