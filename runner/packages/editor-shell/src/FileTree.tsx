import { s } from "./styles.js";

export interface FileTreeProps {
  paths: string[];
  active: string;
  onSelect: (path: string) => void;
}

/** Flat, sorted file list. A nested tree can replace this without touching the
 *  shell's contract — the editor only needs (paths, active, onSelect). */
export function FileTree({ paths, active, onSelect }: FileTreeProps) {
  const sorted = [...paths].sort((a, b) => a.localeCompare(b));
  return (
    <nav style={s.sidebar} aria-label="Files">
      {sorted.map((p) => (
        <button
          key={p}
          type="button"
          style={s.fileItem(p === active)}
          onClick={() => onSelect(p)}
          title={p}
        >
          {p.replace(/^\//, "")}
        </button>
      ))}
    </nav>
  );
}
