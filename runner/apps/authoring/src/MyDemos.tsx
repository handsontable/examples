import { useEffect, useState } from "react";
import { theme } from "@handsontable/demo-editor-shell";

interface DemoListItem {
  id: string;
  title: string;
  description: string | null;
  framework: string;
  tier: number;
  ht_version: string;
  revoked: number;
  updated_at: string;
}

export interface MyDemosProps {
  apiBase: string;
  token: string | null;
  onOpen: (id: string) => void;
  onClose: () => void;
}

/** Side panel listing the signed-in user's demos (GET /api/demos?mine). */
export function MyDemos({ apiBase, token, onOpen, onClose }: MyDemosProps) {
  const [demos, setDemos] = useState<DemoListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${apiBase}/api/demos`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`(${r.status})`);
        const data = (await r.json()) as { demos: DemoListItem[] };
        setDemos(data.demos);
      })
      .catch((e) => setError(String(e)));
  }, [apiBase, token]);

  async function remove(id: string) {
    const res = await fetch(`${apiBase}/api/demos/${id}`, {
      method: "DELETE",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }).catch(() => null);
    if (res && (res.status === 204 || res.ok)) {
      setDemos((cur) => (cur ? cur.map((d) => (d.id === id ? { ...d, revoked: 1 } : d)) : cur));
    }
  }

  return (
    <div style={panel}>
      <div style={header}>
        <strong style={{ fontFamily: theme.font.ui }}>My demos</strong>
        <button style={x} onClick={onClose}>✕</button>
      </div>
      {error && <p style={{ color: theme.color.danger, padding: 12 }}>Couldn’t load demos {error}</p>}
      {!demos && !error && <p style={{ color: theme.color.textMuted, padding: 12 }}>Loading…</p>}
      {demos && demos.length === 0 && (
        <p style={{ color: theme.color.textMuted, padding: 12, fontSize: 13 }}>
          No demos yet. Edit an example and click Share.
        </p>
      )}
      {demos?.map((d) => (
        <div key={d.id} style={item}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {d.title} {d.revoked ? "· revoked" : ""}
            </div>
            <div style={{ fontSize: 11.5, color: theme.color.textMuted }}>
              {d.framework} · HOT {d.ht_version}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {!d.revoked && (
              <a style={link} href={`${apiBase}/d/${d.id}`} target="_blank" rel="noreferrer">View</a>
            )}
            <button style={link} onClick={() => onOpen(d.id)}>Edit</button>
            {!d.revoked && (
              <button style={{ ...link, color: "#d1242f", borderColor: "#f3c2c2" }} onClick={() => remove(d.id)}>
                Delete
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

const panel: React.CSSProperties = {
  position: "fixed", top: 0, right: 0, height: "100%", width: 340, maxWidth: "90vw",
  background: "#fff", borderLeft: `1px solid ${theme.color.border}`,
  boxShadow: "-8px 0 24px rgba(0,0,0,0.08)", zIndex: 900, overflowY: "auto",
  fontFamily: theme.font.ui,
};
const header: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between",
  padding: "12px 14px", borderBottom: `1px solid ${theme.color.border}`,
};
const x: React.CSSProperties = { border: "none", background: "none", cursor: "pointer", fontSize: 16, color: theme.color.textMuted };
const item: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
  padding: "10px 14px", borderBottom: `1px solid ${theme.color.surfaceMuted}`,
};
const link: React.CSSProperties = {
  fontFamily: theme.font.ui, fontSize: 12, color: theme.color.accent,
  border: `1px solid ${theme.color.border}`, borderRadius: 6, padding: "3px 8px",
  background: "#fff", cursor: "pointer", textDecoration: "none",
};
