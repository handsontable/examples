// Internal usage + cost panel (/admin), added with the DEV-2030 guardrails.
//
// Everything it renders comes from one authenticated call to
// `GET /api/admin/usage` — daily cost ledger rows, daily usage counters, demo
// inventory and the live-session meters. Read-only by design: this page exists
// to answer "what is the runner costing and who is using it", not to change
// anything. Enforcement thresholds are configuration (wrangler.jsonc vars), so
// they are shown here but not editable.
//
// Charts are plain divs. A chart library would be a new dependency in the
// authoring bundle for six bar charts on an internal page.

import { useCallback, useEffect, useState } from "react";
import { theme, logoUrl } from "@handsontable/demo-editor-shell";
import { reportError } from "./sentry.js";

interface LedgerRow { day: string; sku: string; source: string; units: number; usd: number }
interface UsageRow { day: string; metric: string; dimension: string; count: number }
interface LiveSession {
  sessionId: string;
  framework: string;
  startedAt: number;
  awakeSeconds: number;
  estimatedUsd: number;
}

interface UsageReport {
  generatedAt: number;
  windowDays: number;
  budget: {
    tier: string;
    pct: number;
    spendUsd: number;
    limitUsd: number;
    reconciled: boolean;
    enforced: boolean;
    thresholds: { warn: number; anonBlocked: number; newBlocked: number; closed: number };
  };
  spendBySku: Record<string, { estimate: number; billing: number }>;
  ledger: LedgerRow[];
  usage: UsageRow[];
  demos: {
    total: number;
    revoked: number;
    createdInWindow: number;
    byFramework: { framework: string; count: number }[];
    topViewed: { id: string; title: string; framework: string; views: number }[];
  };
  liveSessions: LiveSession[];
}

const WINDOWS = [7, 30, 90];

const usd = (n: number): string => (n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);
const int = (n: number): string => n.toLocaleString("en-US");
const duration = (seconds: number): string => {
  const m = Math.floor(seconds / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m ${Math.floor(seconds % 60)}s`;
};

/** Human label + colour per degradation tier (mirrors budget.ts). */
const TIERS: Record<string, { label: string; color: string }> = {
  ok: { label: "OK", color: "#1a8f5a" },
  warn: { label: "Warning", color: theme.color.warning },
  anon_blocked: { label: "Sign-in required", color: theme.color.warning },
  new_blocked: { label: "New sessions blocked", color: theme.color.danger },
  closed: { label: "Closed — static only", color: theme.color.danger },
};

const SKU_LABEL: Record<string, string> = {
  container: "Containers",
  egress: "Egress",
  workers: "Workers requests",
  r2: "R2 storage",
};

const METRIC_LABEL: Record<string, string> = {
  session_started: "Live sessions started",
  session_denied: "Sessions refused (budget)",
  build: "Builds run",
  share_created: "Shares created",
  share_view: "Share views",
  embed_view: "Embed views",
};

export interface AdminPanelProps {
  apiBase: string;
  token: string | null;
}

export function AdminPanel({ apiBase, token }: AdminPanelProps) {
  const [days, setDays] = useState(30);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    (window: number) => {
      setError(null);
      fetch(`${apiBase}/api/admin/usage?days=${window}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
        .then(async (r) => {
          if (!r.ok) throw new Error(`usage request failed (${r.status})`);
          setReport((await r.json()) as UsageReport);
        })
        .catch((e: unknown) => {
          // The panel is the only view of spend; a silent failure here is how
          // you find out about a cost problem a week late.
          reportError(e, "admin-usage");
          setError(e instanceof Error ? e.message : String(e));
        });
    },
    [apiBase, token],
  );

  useEffect(() => { load(days); }, [load, days]);

  return (
    <div style={page}>
      <header style={head}>
        <img src={logoUrl} alt="" width={22} height={22} />
        <h1 style={h1}>Demo runner · usage &amp; cost</h1>
        <div style={{ flex: 1 }} />
        <div role="group" aria-label="Time window" style={{ display: "flex", gap: 4 }}>
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setDays(w)}
              style={{ ...chip, ...(w === days ? chipActive : null) }}
              aria-pressed={w === days}
            >
              {w}d
            </button>
          ))}
        </div>
        <button type="button" style={chip} onClick={() => load(days)}>Refresh</button>
        <a style={{ ...chip, textDecoration: "none" }} href="/">← Editor</a>
      </header>

      {error && <p style={{ color: theme.color.danger }}>Couldn’t load usage: {error}</p>}
      {!report && !error && <p style={{ color: theme.color.textMuted }}>Loading…</p>}

      {report && (
        <>
          <BudgetCard report={report} />

          <section style={grid}>
            <Stat label="Live sessions now" value={int(report.liveSessions.length)} />
            <Stat
              label={`Sessions started (${report.windowDays}d)`}
              value={int(sumMetric(report.usage, "session_started"))}
            />
            <Stat
              label={`Builds (${report.windowDays}d)`}
              value={int(sumMetric(report.usage, "build"))}
            />
            <Stat
              label={`Share + embed views (${report.windowDays}d)`}
              value={int(sumMetric(report.usage, "share_view") + sumMetric(report.usage, "embed_view"))}
            />
            <Stat label="Demos stored" value={`${int(report.demos.total)} (${int(report.demos.revoked)} revoked)`} />
            <Stat
              label="Sessions refused"
              value={int(sumMetric(report.usage, "session_denied"))}
              hint="How often the guardrail turned someone away"
            />
          </section>

          <Section title="Month-to-date spend by SKU">
            <table style={table}>
              <thead>
                <tr><Th>SKU</Th><Th align="right">Estimated</Th><Th align="right">Reconciled</Th><Th>Basis</Th></tr>
              </thead>
              <tbody>
                {Object.entries(report.spendBySku).length === 0 && (
                  <tr><Td colSpan={4}>Nothing metered yet this month.</Td></tr>
                )}
                {Object.entries(report.spendBySku).map(([sku, v]) => (
                  <tr key={sku}>
                    <Td>{SKU_LABEL[sku] ?? sku}</Td>
                    <Td align="right">{usd(v.estimate)}</Td>
                    <Td align="right">{v.billing > 0 ? usd(v.billing) : "—"}</Td>
                    <Td muted>
                      {v.billing > 0 ? "Cloudflare analytics (nightly)" : "Worker estimate"}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p style={note}>
              Reconciled figures replace the estimate for the same day. Container compute has no
              public per-account analytics dataset, so it stays an estimate — it is also the one SKU
              Cloudflare already caps for us, via <code>max_instances</code>.
            </p>
          </Section>

          <Section title={`Daily spend (${report.windowDays}d)`}>
            <Bars
              rows={dailySpend(report.ledger)}
              format={usd}
              emptyText="No ledger rows yet."
            />
          </Section>

          <Section title={`Daily activity (${report.windowDays}d)`}>
            {["session_started", "build", "share_view", "embed_view", "session_denied"].map((metric) => {
              const rows = dailyMetric(report.usage, metric);
              if (!rows.length) return null;
              return (
                <div key={metric} style={{ marginBottom: 18 }}>
                  <div style={subhead}>{METRIC_LABEL[metric] ?? metric}</div>
                  <Bars rows={rows} format={int} emptyText="" />
                </div>
              );
            })}
          </Section>

          <Section title="Live sessions">
            {report.liveSessions.length === 0 ? (
              <p style={note}>No containers awake right now.</p>
            ) : (
              <table style={table}>
                <thead>
                  <tr><Th>Session</Th><Th>Example</Th><Th align="right">Awake</Th><Th align="right">Est. cost</Th></tr>
                </thead>
                <tbody>
                  {report.liveSessions.map((s) => (
                    <tr key={s.sessionId}>
                      <Td mono>{s.sessionId}</Td>
                      <Td>{s.framework}</Td>
                      <Td align="right">{duration(s.awakeSeconds)}</Td>
                      <Td align="right">{usd(s.estimatedUsd)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p style={note}>
              Derived from the awake-window meters, so a session lingers here until its idle window
              lapses if the client vanished without a clean teardown.
            </p>
          </Section>

          <Section title="Demos">
            <div style={{ display: "flex", gap: 32, flexWrap: "wrap" }}>
              <div style={{ minWidth: 260, flex: "1 1 260px" }}>
                <div style={subhead}>By framework</div>
                <Bars
                  rows={report.demos.byFramework.map((f) => ({ label: f.framework, value: f.count }))}
                  format={int}
                  emptyText="No demos yet."
                />
              </div>
              <div style={{ minWidth: 300, flex: "2 1 320px" }}>
                <div style={subhead}>Most viewed ({report.windowDays}d)</div>
                {report.demos.topViewed.length === 0 ? (
                  <p style={note}>No views recorded yet.</p>
                ) : (
                  <table style={table}>
                    <thead><tr><Th>Demo</Th><Th>Example</Th><Th align="right">Views</Th></tr></thead>
                    <tbody>
                      {report.demos.topViewed.map((d) => (
                        <tr key={d.id}>
                          <Td>
                            <a style={{ color: theme.color.accent }} href={`/share/${d.id}`} target="_blank" rel="noreferrer">
                              {d.title}
                            </a>
                          </Td>
                          <Td muted>{d.framework}</Td>
                          <Td align="right">{int(d.views)}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </Section>

          <p style={{ ...note, marginTop: 24 }}>
            Generated {new Date(report.generatedAt).toLocaleString()}. Counters are daily aggregates —
            no per-request data is stored.
          </p>
        </>
      )}
    </div>
  );
}

/** Budget headline: where spend sits against the ceiling, and what each
 *  threshold will do when it is crossed. */
function BudgetCard({ report }: { report: UsageReport }) {
  const { budget } = report;
  const tier = TIERS[budget.tier] ?? { label: budget.tier, color: theme.color.text };
  const pct = Math.max(0, Math.min(1, budget.pct));
  const marks: [string, number][] = [
    ["warn", budget.thresholds.warn],
    ["sign-in", budget.thresholds.anonBlocked],
    ["no new", budget.thresholds.newBlocked],
  ];

  return (
    <section style={{ ...card, borderColor: tier.color }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 26 }}>{usd(budget.spendUsd)}</strong>
        <span style={{ color: theme.color.textMuted }}>of {usd(budget.limitUsd)} this month</span>
        <span style={{ ...pill, background: tier.color }}>{tier.label}</span>
        {!budget.enforced && (
          <span style={{ ...pill, background: theme.color.textMuted }} title="BUDGET_ENFORCE=0">
            observe-only
          </span>
        )}
        {!budget.reconciled && (
          <span style={{ color: theme.color.textMuted, fontSize: 12 }}>
            includes unreconciled estimates
          </span>
        )}
      </div>

      <div style={meter} aria-hidden>
        <div style={{ ...meterFill, width: `${pct * 100}%`, background: tier.color }} />
        {marks.map(([label, at]) => (
          <div key={label} style={{ ...meterMark, left: `${Math.min(1, at) * 100}%` }} title={`${label} at ${Math.round(at * 100)}%`} />
        ))}
      </div>

      <p style={note}>
        {budget.enforced
          ? "Enforcing: at 80% live sessions require a Handsontable sign-in, at 95% no new sessions or builds start, at 100% running sessions are torn down. Shared demos and embeds keep working at every tier."
          : "Observe-only: tiers are computed and logged but nothing is refused. Flip BUDGET_ENFORCE to 1 once these figures track the Cloudflare Billable Usage dashboard."}
      </p>
    </section>
  );
}

// ---- Small presentational pieces ---------------------------------------------

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 28 }}>
      <h2 style={h2}>{title}</h2>
      {children}
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div style={statCard} title={hint}>
      <div style={{ fontSize: 22, fontWeight: 600 }}>{value}</div>
      <div style={{ fontSize: 12, color: theme.color.textMuted }}>{label}</div>
    </div>
  );
}

function Bars({
  rows,
  format,
  emptyText,
}: {
  rows: { label: string; value: number }[];
  format: (n: number) => string;
  emptyText: string;
}) {
  if (!rows.length) return emptyText ? <p style={note}>{emptyText}</p> : null;
  const max = Math.max(...rows.map((r) => r.value), 0.0001);
  return (
    <div>
      {rows.map((r) => (
        <div key={r.label} style={barRow}>
          <span style={barLabel}>{r.label}</span>
          <span style={barTrack}>
            <span style={{ ...barFill, width: `${(r.value / max) * 100}%` }} />
          </span>
          <span style={barValue}>{format(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

const Th = ({ children, align }: { children: React.ReactNode; align?: "right" }) => (
  <th style={{ ...th, textAlign: align ?? "left" }}>{children}</th>
);
const Td = ({
  children,
  align,
  muted,
  mono,
  colSpan,
}: {
  children: React.ReactNode;
  align?: "right";
  muted?: boolean;
  mono?: boolean;
  colSpan?: number;
}) => (
  <td
    colSpan={colSpan}
    style={{
      ...td,
      textAlign: align ?? "left",
      color: muted ? theme.color.textMuted : undefined,
      fontFamily: mono ? theme.font.mono : undefined,
    }}
  >
    {children}
  </td>
);

// ---- Aggregation -------------------------------------------------------------

const sumMetric = (rows: UsageRow[], metric: string): number =>
  rows.reduce((n, r) => (r.metric === metric ? n + r.count : n), 0);

/** Ledger rows -> one bar per day, preferring reconciled over estimated for
 *  each (day, sku) exactly as the Worker's own ceiling arithmetic does. */
function dailySpend(rows: LedgerRow[]): { label: string; value: number }[] {
  const perDaySku = new Map<string, { estimate: number; billing: number }>();
  for (const r of rows) {
    const key = `${r.day}|${r.sku}`;
    const cur = perDaySku.get(key) ?? { estimate: 0, billing: 0 };
    if (r.source === "billing") cur.billing += r.usd;
    else cur.estimate += r.usd;
    perDaySku.set(key, cur);
  }
  const perDay = new Map<string, number>();
  for (const [key, v] of perDaySku) {
    const day = key.slice(0, key.indexOf("|"));
    perDay.set(day, (perDay.get(day) ?? 0) + (v.billing > 0 ? v.billing : v.estimate));
  }
  return [...perDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([label, value]) => ({ label, value }));
}

function dailyMetric(rows: UsageRow[], metric: string): { label: string; value: number }[] {
  const perDay = new Map<string, number>();
  for (const r of rows) {
    if (r.metric !== metric) continue;
    perDay.set(r.day, (perDay.get(r.day) ?? 0) + r.count);
  }
  return [...perDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([label, value]) => ({ label, value }));
}

// ---- Styles ------------------------------------------------------------------

const page: React.CSSProperties = {
  fontFamily: theme.font.ui, color: theme.color.text, background: theme.color.surface,
  minHeight: "100%", padding: "20px 24px 60px", maxWidth: 1100, margin: "0 auto",
};
const head: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 10, paddingBottom: 14,
  borderBottom: `1px solid ${theme.color.border}`, flexWrap: "wrap",
};
const h1: React.CSSProperties = { fontSize: 17, margin: 0, fontWeight: 600 };
const h2: React.CSSProperties = { fontSize: 14, margin: "0 0 10px", fontWeight: 600 };
const subhead: React.CSSProperties = { fontSize: 12, color: theme.color.textMuted, margin: "0 0 6px" };
const chip: React.CSSProperties = {
  fontFamily: theme.font.ui, fontSize: 12, color: theme.color.text, background: "#fff",
  border: `1px solid ${theme.color.border}`, borderRadius: 6, padding: "4px 9px", cursor: "pointer",
};
const chipActive: React.CSSProperties = {
  background: theme.color.accent, color: theme.color.accentContrast, borderColor: theme.color.accent,
};
const card: React.CSSProperties = {
  marginTop: 18, padding: 16, border: `1px solid ${theme.color.border}`,
  borderLeftWidth: 4, borderRadius: theme.radius.md, background: theme.color.surfaceMuted,
};
const pill: React.CSSProperties = {
  color: "#fff", borderRadius: 999, padding: "2px 9px", fontSize: 11.5, fontWeight: 600,
};
const meter: React.CSSProperties = {
  position: "relative", height: 10, borderRadius: 999, background: "#fff",
  border: `1px solid ${theme.color.border}`, margin: "14px 0 10px", overflow: "hidden",
};
const meterFill: React.CSSProperties = { position: "absolute", inset: 0, borderRadius: 999 };
const meterMark: React.CSSProperties = {
  position: "absolute", top: 0, bottom: 0, width: 1, background: theme.color.textMuted, opacity: 0.6,
};
const grid: React.CSSProperties = {
  display: "grid", gap: 10, marginTop: 16,
  gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
};
const statCard: React.CSSProperties = {
  border: `1px solid ${theme.color.border}`, borderRadius: theme.radius.md, padding: "10px 12px",
};
const table: React.CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 13 };
const th: React.CSSProperties = {
  fontSize: 11.5, textTransform: "uppercase", letterSpacing: 0.4, color: theme.color.textMuted,
  fontWeight: 600, padding: "6px 8px", borderBottom: `1px solid ${theme.color.border}`,
};
const td: React.CSSProperties = { padding: "6px 8px", borderBottom: `1px solid ${theme.color.surfaceMuted}` };
const note: React.CSSProperties = { fontSize: 12, color: theme.color.textMuted, margin: "10px 0 0", maxWidth: 720 };
const barRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "2px 0" };
const barLabel: React.CSSProperties = {
  width: 96, flex: "0 0 96px", fontSize: 11.5, color: theme.color.textMuted, fontFamily: theme.font.mono,
};
const barTrack: React.CSSProperties = {
  flex: 1, height: 12, background: theme.color.surfaceMuted, borderRadius: 3, overflow: "hidden",
};
const barFill: React.CSSProperties = { display: "block", height: "100%", background: theme.color.accent };
const barValue: React.CSSProperties = { width: 78, textAlign: "right", fontSize: 12, fontVariantNumeric: "tabular-nums" };
