// The in-app guide (`/guide`, DEV-2503) — what a signed-in team member can do
// here, from picking a starter to sharing, embedding and importing.
//
// The content is `runner/docs/create-and-share-a-demo.md`, imported raw and
// rendered with the same markdown renderer the Ask AI panel uses. One source of
// truth on purpose: a second copy inside a .tsx would drift from the doc within a
// release, and the doc is the version that gets reviewed in PRs.
//
// Page shell follows `Settings.tsx` — same top bar, same left nav, one content
// column — because this is the third page of that family and inventing a third
// layout for it would be the only thing making it look special.

import type { CSSProperties } from "react";
import { SideNav, TopBar, shellStyles, theme } from "@handsontable/demo-editor-shell";
import guideMarkdown from "../../../docs/create-and-share-a-demo.md?raw";
import { logout, type User } from "./auth.js";
import { Markdown } from "./markdown.js";
import { useProfile } from "./useProfile.js";

export interface GuidePageProps {
  apiBase: string;
  user: User;
}

export function GuidePage({ apiBase, user }: GuidePageProps) {
  const profile = useProfile(apiBase, user.email);

  return (
    <div style={{ ...shellStyles.shell, gridTemplateRows: "auto 1fr" }}>
      <TopBar
        examplePill={
          <div style={shellStyles.examplePill(false)}>
            <span style={shellStyles.pillLabel}>Guide</span>
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
        <SideNav active="guide" onLogout={() => logout("/")} />

        <main style={content}>
          {/* The document supplies its own `# ` heading, so this page adds none —
              two would be a duplicated h1 in the same landmark. */}
          <article style={prose}>
            <Markdown text={guideMarkdown} document />
          </article>
        </main>
      </div>
    </div>
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

/** A reading measure, not the full window: this is prose, and a 1,400px line is
 *  unreadable. Centred so a wide window does not leave it hugging the nav. */
const prose: CSSProperties = {
  maxWidth: 760,
  margin: "0 auto",
  paddingBottom: theme.space(8),
  fontFamily: theme.font.ui,
  fontSize: 14,
  lineHeight: 1.65,
  color: theme.color.text,
};
