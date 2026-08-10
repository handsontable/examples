// The DEPENDENCIES section (`72:17065`): the workspace's runtime deps, each linked to npm.
import type { CSSProperties } from "react";
import { IconExternalLink } from "./icons/index.js";
import { SectionHeader, iconBtn } from "./SectionHeader.js";
import { theme } from "./theme.js";

export interface Dependency {
  name: string;
  url: string;
}

export interface DependenciesProps {
  /** Raw `/package.json` contents. Absent or malformed is a supported state. */
  packageJson?: string;
  collapsed: boolean;
  onToggle: () => void;
}

/** Runtime `dependencies` only — `devDependencies` are build machinery and the design
 *  lists just `handsontable`. Never throws: a workspace without a parseable
 *  `/package.json` is legitimate (see `pinHandsontableFiles`, which guards the same way). */
export function parseDependencies(packageJson: string | undefined): Dependency[] {
  if (!packageJson) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJson);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const deps = (parsed as { dependencies?: unknown }).dependencies;
  if (typeof deps !== "object" || deps === null) return [];

  return Object.keys(deps)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, url: `https://www.npmjs.com/package/${name}` }));
}

export function Dependencies({ packageJson, collapsed, onToggle }: DependenciesProps) {
  const deps = parseDependencies(packageJson);

  return (
    <section style={section} aria-label="Dependencies">
      <SectionHeader label="Dependencies" collapsed={collapsed} onToggle={onToggle} />
      {!collapsed && (
        <div style={body}>
          {deps.map((dep) => (
            <div key={dep.name} className="hot-dep-row" style={row}>
              <a href={dep.url} target="_blank" rel="noreferrer noopener" style={nameLink}>
                {dep.name}
              </a>
              <span style={urlText}>{dep.url}</span>
              <a
                href={dep.url}
                target="_blank"
                rel="noreferrer noopener"
                className="hot-dep-link"
                style={{ ...iconBtn, marginLeft: "auto" }}
                title={`${dep.name} on npm`}
              >
                <IconExternalLink />
              </a>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

const section: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  flex: "0 0 auto",
  paddingBottom: theme.space(3),
  background: theme.color.surface,
};

const body: CSSProperties = {
  display: "flex",
  flexDirection: "column",
};

const row: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: `${theme.space(2)} ${theme.space(3)}`,
  overflow: "clip",
};

const nameLink: CSSProperties = {
  fontFamily: theme.font.ui,
  fontSize: 10,
  lineHeight: "16px",
  color: theme.color.text,
  textDecoration: "none",
  flex: "0 0 auto",
};

const urlText: CSSProperties = {
  fontFamily: theme.font.mono,
  fontSize: 10,
  lineHeight: "16px",
  color: theme.color.textMuted,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};
