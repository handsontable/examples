// The left sidebar (`72:16975`): BOX INFO + FILES at the top, DEPENDENCIES pinned to the
// bottom. The sidebar itself does not scroll — the FILES body does, or DEPENDENCIES would
// scroll away with a long file list.
import { useState, type CSSProperties } from "react";
import { BoxInfo, type BoxInfoProps } from "./BoxInfo.js";
import { Dependencies } from "./Dependencies.js";
import { FileTree, type FileTreeProps } from "./FileTree.js";
import { s } from "./styles.js";

type SectionId = "boxInfo" | "files" | "dependencies";

export interface SidebarProps
  extends Pick<BoxInfoProps, "title" | "description" | "createdAt" | "onEdit">,
    Pick<
      FileTreeProps,
      | "paths"
      | "active"
      | "onSelect"
      | "onDownloadAll"
      | "editable"
      | "onAddFile"
      | "onAddFiles"
      | "onRenameFile"
      | "onDeleteFile"
    > {
  /** Raw `/package.json` contents, for the DEPENDENCIES list. */
  packageJson?: string;
}

export function Sidebar({
  title,
  description,
  createdAt,
  onEdit,
  packageJson,
  paths,
  active,
  onSelect,
  onDownloadAll,
  editable,
  onAddFile,
  onAddFiles,
  onRenameFile,
  onDeleteFile,
}: SidebarProps) {
  // Which sections are shut. Same negation as the file tree's `shutDirs`: the default is
  // all-expanded, and that default must not need re-seeding when the workspace changes.
  const [shut, setShut] = useState<ReadonlySet<SectionId>>(() => new Set<SectionId>());

  const toggle = (id: SectionId) => () =>
    setShut((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <nav style={s.sidebar} aria-label="Demo sidebar">
      <div style={top}>
        <BoxInfo
          title={title}
          description={description}
          createdAt={createdAt}
          onEdit={onEdit}
          collapsed={shut.has("boxInfo")}
          onToggle={toggle("boxInfo")}
        />
        <FileTree
          paths={paths}
          active={active}
          onSelect={onSelect}
          collapsed={shut.has("files")}
          onToggle={toggle("files")}
          onDownloadAll={onDownloadAll}
          editable={editable}
          onAddFile={onAddFile}
          onAddFiles={onAddFiles}
          onRenameFile={onRenameFile}
          onDeleteFile={onDeleteFile}
        />
      </div>
      <Dependencies
        packageJson={packageJson}
        collapsed={shut.has("dependencies")}
        onToggle={toggle("dependencies")}
      />
    </nav>
  );
}

const top: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
};
