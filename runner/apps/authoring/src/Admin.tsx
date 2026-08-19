// Internal usage + cost panel (/admin), added with the DEV-2030 guardrails.
//
// The page loads from one authenticated call to `GET /api/admin/usage` — the cost
// ledger, usage counters, anonymous audience aggregates, demo inventory and the
// first page of live-session meters. Two things it can change: the guardrail
// settings (ceiling, tiers, alerts, enforcement) via `PUT /api/admin/settings`,
// and a live session's existence via `DELETE /api/admin/sessions/:ref`. Paging
// the session table re-reads `GET /api/admin/sessions` alone rather than the
// whole report, since none of the aggregates move when you turn a page.
//
// Session ids are never rendered — they are bearer capabilities for the
// unauthenticated `/api/session/:id/*` routes, so the server sends a digest, and
// the kill button sends that digest back for the server to resolve.
//
// Charts are plain divs. A chart library would be a new dependency in the
// authoring bundle for six bar charts on an internal page.

import { useCallback, useEffect, useState } from "react";
import { theme, logoUrl } from "@handsontable/demo-editor-shell";
import { assertApiOk, readApiJson } from "./api.js";
import { reportError } from "./sentry.js";

interface LedgerRow { day: string; sku: string; source: string; units: number; usd: number }
interface UsageRow { day: string; metric: string; dimension: string; count: number }
interface LiveSession {
  /** A one-way digest, not the session id: ids are bearer capabilities for the
   *  unauthenticated /api/session/:id/* routes and must not be handed out. The
   *  kill button below sends this back and the server resolves it. */
  ref: string;
  framework: string;
  startedAt: number;
  /** Wall clock since the session started. */
  awakeSeconds: number;
  /** Awake time the ledger stands behind — see session-listing.ts. */
  billableSeconds: number;
  quietSeconds: number;
  /** `slept`: the meter has been quiet longer than the container's idle window,
   *  so it has scaled to zero and stopped billing. Its meter row survives for
   *  24h regardless, which is what the default filter hides (DEV-2567). */
  state: "awake" | "slept";
  estimatedUsd: number;
}

interface LiveSessionsPage {
  rows: LiveSession[];
  offset: number;
  limit: number;
  /** Rows matching the current filter, across every page. */
  total: number;
  awakeCount: number;
  /** Every meter in KV, filter ignored — what unchecking the box would show. */
  meterCount: number;
  truncated: boolean;
}

/** The editable guardrail settings (dollars, not fractions — see settings.ts). */
export interface BudgetSettings {
  limitUsd: number;
  warnUsd: number;
  anonBlockUsd: number;
  newBlockUsd: number;
  closedUsd: number;
  enforce: boolean;
  alertsUsd: number[];
  source?: "defaults" | "override";
  updatedAt?: string | null;
  updatedBy?: string | null;
}

interface Bucket { value: string; views: number }

interface Audience {
  totals: { views: number; visitors: number; bots: number };
  daily: { day: string; views: number; visitors: number }[];
  pages: Bucket[];
  demos: Bucket[];
  referrers: Bucket[];
  countries: Bucket[];
  devices: Bucket[];
  browsers: Bucket[];
  languages: Bucket[];
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
  };
  settings: BudgetSettings;
  audience: Audience;
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
  /** The default view only (awake, first page). Paging and the "show all"
   *  toggle go to `GET /api/admin/sessions`, so neither re-runs the aggregates. */
  liveSessions: LiveSessionsPage;
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
  llm: "AI assistant",
};

const METRIC_LABEL: Record<string, string> = {
  session_started: "Live sessions started",
  session_denied: "Sessions refused (budget)",
  build: "Builds run",
  share_created: "Shares created",
  share_view: "Share views",
  embed_view: "Embed views",
  chat_message: "Assistant questions",
  chat_edit: "Assistant answers with code",
  chat_edit_applied: "Assistant edits applied",
  chat_edit_undone: "Assistant edits undone",
  chat_denied: "Assistant requests refused",
  chat_error: "Assistant failures",
};

export interface AdminPanelProps {
  apiBase: string;
  token: string | null;
}

export function AdminPanel({ apiBase, token }: AdminPanelProps) {
  const [days, setDays] = useState(30);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Session counts as of the table's own last read, which moves independently
   *  of the report once someone pages or kills a row. Null until it does. */
  const [sessionCounts, setSessionCounts] = useState<{ awakeCount: number; meterCount: number } | null>(null);

  const load = useCallback(
    (window: number) => {
      setError(null);
      fetch(`${apiBase}/api/admin/usage?days=${window}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
        .then(async (r) => {
          if (!r.ok) throw new Error(`usage request failed (${r.status})`);
          setReport((await r.json()) as UsageReport);
          // The report carries a fresh first page, so the table's own counts are
          // superseded; dropping them here is what lets a window switch or a
          // Refresh re-seed the section instead of leaving it on stale numbers.
          setSessionCounts(null);
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

          <SettingsForm
            apiBase={apiBase}
            token={token}
            settings={report.settings}
            onSaved={() => load(days)}
          />

          <section style={grid}>
            <Stat
              label="Live sessions now"
              value={int((sessionCounts ?? report.liveSessions).awakeCount)}
              hint={`${(sessionCounts ?? report.liveSessions).meterCount} metered in the last 24h, including sessions whose container has already slept`}
            />
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

          <AssistantSection report={report} />

          <AudienceSection audience={report.audience} days={report.windowDays} />

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
            {["session_started", "build", "share_view", "embed_view", "chat_message", "chat_edit", "session_denied"].map((metric) => {
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

          {/* Keyed on the report's stamp: the section seeds its page from
              `initial` once, so without this a window switch (which refetches
              /usage and returns a fresh first page) would never reach the table. */}
          <LiveSessionsSection
            key={report.generatedAt}
            apiBase={apiBase}
            token={token}
            initial={report.liveSessions}
            onCounts={setSessionCounts}
          />

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
                            <a style={{ color: theme.color.accentText }} href={`/share/${d.id}`} target="_blank" rel="noreferrer">
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
  const { budget, settings } = report;
  const tier = TIERS[budget.tier] ?? { label: budget.tier, color: theme.color.text };
  const pct = Math.max(0, Math.min(1, budget.pct));
  const limit = settings.limitUsd || 1;
  const marks: [string, number][] = [
    ["warn", settings.warnUsd / limit],
    ["sign-in", settings.anonBlockUsd / limit],
    ["no new", settings.newBlockUsd / limit],
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
          ? `Enforcing: sign-in required from ${usd(settings.anonBlockUsd)}, no new sessions or builds from `
            + `${usd(settings.newBlockUsd)}, running sessions torn down at ${usd(settings.closedUsd)}. `
            + "Shared demos and embeds keep working at every tier."
          : "Observe-only: tiers are computed and logged but nothing is refused. Turn enforcement on below "
            + "once these figures track the Cloudflare Billable Usage dashboard."}
      </p>
    </section>
  );
}

/**
 * The guardrail settings, editable here rather than in wrangler.jsonc.
 *
 * The moment you actually need to move a threshold — a spike, a demo day, a
 * bill that surprised someone — is the moment you least want to be waiting on
 * a deploy. Saving writes an override (with who changed it and when); Reset
 * drops it back to the values committed in the Worker config.
 */
function SettingsForm({
  apiBase,
  token,
  settings,
  onSaved,
}: {
  apiBase: string;
  token: string | null;
  settings: BudgetSettings;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<BudgetSettings>(settings);
  const [alertsText, setAlertsText] = useState(settings.alertsUsd.join(", "));
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // Re-sync when the parent reloads (another tab may have changed them).
  useEffect(() => {
    setDraft(settings);
    setAlertsText(settings.alertsUsd.join(", "));
  }, [settings]);

  const field = (key: keyof BudgetSettings, label: string, hint: string) => (
    <label style={{ display: "block", marginBottom: 10 }}>
      <div style={{ fontSize: 12, marginBottom: 3 }}>{label}</div>
      <input
        type="number"
        min={0}
        step="1"
        value={String(draft[key] ?? "")}
        onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) })}
        style={input}
      />
      <div style={{ fontSize: 11, color: theme.color.textMuted, marginTop: 2 }}>{hint}</div>
    </label>
  );

  async function submit(method: "PUT" | "DELETE") {
    setState("saving");
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/admin/settings`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: method === "PUT"
          ? JSON.stringify({
              ...draft,
              alertsUsd: alertsText
                .split(",")
                .map((s) => Number(s.trim()))
                .filter((n) => Number.isFinite(n) && n > 0),
            })
          : undefined,
      });
      // Was a bare `res.json()` before the shared reader (DEV-2534) — which also
      // threw a SyntaxError, rather than the described failure, whenever the
      // error body was not JSON.
      await assertApiOk(res, `request failed (${res.status})`);
      setState("saved");
      onSaved();
    } catch (e: unknown) {
      reportError(e, "admin-settings-save");
      setError(e instanceof Error ? e.message : String(e));
      setState("idle");
    }
  }

  const pctOf = (v: number) => (draft.limitUsd > 0 ? `${Math.round((v / draft.limitUsd) * 100)}% of the ceiling` : "");

  return (
    <section style={{ marginTop: 18 }}>
      <button type="button" style={chip} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? "▾" : "▸"} Guardrail settings
        <span style={{ color: theme.color.textMuted, marginLeft: 8 }}>
          {settings.source === "override"
            ? `overridden${settings.updatedBy ? ` by ${settings.updatedBy}` : ""}`
            : "using wrangler.jsonc defaults"}
        </span>
      </button>

      {open && (
        <div style={{ ...card, background: theme.color.surface, borderLeftWidth: 1, marginTop: 10 }}>
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
            <div style={{ minWidth: 200, flex: "1 1 200px" }}>
              {field("limitUsd", "Monthly ceiling ($)", "The number everything else is measured against.")}
              {field("warnUsd", "Notice ($)", `${pctOf(draft.warnUsd)} — banner in the editor.`)}
            </div>
            <div style={{ minWidth: 200, flex: "1 1 200px" }}>
              {field("anonBlockUsd", "Sign-in required ($)", `${pctOf(draft.anonBlockUsd)} — anonymous live editing stops.`)}
              {field("newBlockUsd", "No new sessions ($)", `${pctOf(draft.newBlockUsd)} — running ones finish.`)}
            </div>
            <div style={{ minWidth: 200, flex: "1 1 200px" }}>
              {field("closedUsd", "Close live editing ($)", `${pctOf(draft.closedUsd)} — running sessions torn down.`)}
              <label style={{ display: "block", marginBottom: 10 }}>
                <div style={{ fontSize: 12, marginBottom: 3 }}>Alert thresholds ($)</div>
                <input
                  type="text"
                  value={alertsText}
                  onChange={(e) => setAlertsText(e.target.value)}
                  placeholder="200, 500, 800"
                  style={input}
                />
                <div style={{ fontSize: 11, color: theme.color.textMuted, marginTop: 2 }}>
                  Notify once per month per threshold, on this runner’s own spend.
                </div>
              </label>
            </div>
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: 8, margin: "4px 0 12px" }}>
            <input
              type="checkbox"
              checked={draft.enforce}
              onChange={(e) => setDraft({ ...draft, enforce: e.target.checked })}
            />
            <span style={{ fontSize: 13 }}>
              Enforce the tiers. <span style={{ color: theme.color.textMuted }}>
                Off = observe and log only; nothing is ever refused.
              </span>
            </span>
          </label>

          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button
              type="button"
              style={{ ...chip, ...chipActive }}
              disabled={state === "saving"}
              onClick={() => void submit("PUT")}
            >
              {state === "saving" ? "Saving…" : "Save"}
            </button>
            <button type="button" style={chip} onClick={() => void submit("DELETE")}>
              Reset to defaults
            </button>
            {state === "saved" && <span style={{ fontSize: 12, color: "#1a8f5a" }}>Saved.</span>}
            {error && <span style={{ fontSize: 12, color: theme.color.danger }}>{error}</span>}
            {settings.updatedAt && (
              <span style={{ fontSize: 11.5, color: theme.color.textMuted }}>
                Last changed {new Date(settings.updatedAt).toLocaleString()}
              </span>
            )}
          </div>

          <p style={note}>
            Tiers must stay in order (notice ≤ sign-in ≤ no new ≤ close) and none may exceed the ceiling;
            the server rejects anything else. Changes take effect within a minute across all locations.
          </p>
        </div>
      )}
    </section>
  );
}

/**
 * The AI assistant (DEV-2047): how much it is used, whether its edits are
 * actually taken, what it costs, and how often it refuses or fails.
 *
 * "Edits applied" is the number that matters. Questions asked says the button
 * is discoverable; edits applied says the answers were good enough to keep.
 */
function AssistantSection({ report }: { report: UsageReport }) {
  const usage = report.usage;
  const questions = sumMetric(usage, "chat_message");
  const withCode = sumMetric(usage, "chat_edit");
  const applied = sumMetric(usage, "chat_edit_applied");
  const undone = sumMetric(usage, "chat_edit_undone");
  const denied = sumMetric(usage, "chat_denied");
  const errors = sumMetric(usage, "chat_error");
  // Windowed, not month-to-date: dividing MTD spend by a 7- or 90-day question
  // count only agrees by coincidence, and silently misreports the rest of the
  // time. The ledger rows are already filtered to the selected window.
  const spendUsd = windowedSpend(report.ledger, "llm");

  if (questions + denied + errors === 0) {
    return (
      <Section title="AI assistant">
        <p style={note}>
          Nobody has asked the assistant anything in this window. If questions <em>are</em> being
          asked and this stays empty, check that the <code>LITELLM_API_KEY</code> secret is set —
          without it every question returns 503 and is counted under Failures.
        </p>
      </Section>
    );
  }

  return (
    <Section title={`AI assistant (${report.windowDays}d)`}>
      <section style={grid}>
        <Stat label="Questions asked" value={int(questions)} />
        <Stat
          label="Answers with code"
          value={`${int(withCode)}${questions ? ` (${Math.round((withCode / questions) * 100)}%)` : ""}`}
          hint="Answers that proposed at least one file edit"
        />
        <Stat
          label="Edits applied"
          value={`${int(applied)}${withCode ? ` (${Math.round((applied / withCode) * 100)}%)` : ""}`}
          hint="Proposals the user actually accepted — the quality signal"
        />
        <Stat label="Edits undone" value={int(undone)} hint="Applied, then reverted" />
        <Stat label={`Spend (${report.windowDays}d)`} value={usd(spendUsd)} />
        <Stat
          label="Cost per answer"
          value={questions ? usd(spendUsd / questions) : "—"}
          hint="Assistant spend over questions asked, both in this window"
        />
        <Stat label="Refused" value={int(denied)} hint="Rate limit or budget tier" />
        <Stat label="Failures" value={int(errors)} hint="Gateway unavailable or misconfigured" />
      </section>

      <div style={{ display: "flex", gap: 32, flexWrap: "wrap", marginTop: 18 }}>
        <div style={{ minWidth: 280, flex: "1 1 280px" }}>
          <div style={subhead}>Questions per day</div>
          <Bars rows={dailyMetric(usage, "chat_message")} format={int} emptyText="—" />
        </div>
        <div style={{ minWidth: 280, flex: "1 1 280px" }}>
          <div style={subhead}>Edits applied per day</div>
          <Bars rows={dailyMetric(usage, "chat_edit_applied")} format={int} emptyText="—" />
        </div>
      </div>

      <div style={{ display: "flex", gap: 32, flexWrap: "wrap", marginTop: 18 }}>
        <div style={{ minWidth: 240, flex: "1 1 240px" }}>
          <div style={subhead}>Frameworks asked about</div>
          <Bars rows={byDimension(usage, "chat_message")} format={int} emptyText="—" />
        </div>
        <div style={{ minWidth: 240, flex: "1 1 240px" }}>
          <div style={subhead}>Refusals by reason</div>
          <Bars rows={byDimension(usage, "chat_denied")} format={int} emptyText="None — nothing was turned away." />
        </div>
      </div>

      <p style={note}>
        Counted the same way as everything else here: daily aggregates only. Question text is
        never stored — only that a question was asked, and against which framework.
      </p>
    </Section>
  );
}

/**
 * Audience: what a simplified analytics product would show, from data that
 * cannot identify anyone.
 *
 * No cookies and no client-side id are involved. Unique visitors come from a
 * one-way hash of a daily rotating salt with the IP and user agent, which is
 * why a returning visitor counts once per day and cannot be followed across
 * days — the salt that made yesterday's hashes is deleted.
 */
function AudienceSection({ audience, days }: { audience: Audience; days: number }) {
  const { totals } = audience;
  const dailyViews = audience.daily.map((d) => ({ label: d.day, value: d.views }));
  const dailyVisitors = audience.daily.map((d) => ({ label: d.day, value: d.visitors }));

  return (
    <Section title={`Audience (${days}d, anonymous)`}>
      <section style={grid}>
        <Stat label="Page views" value={int(totals.views)} />
        <Stat
          label="Unique visitors"
          value={int(totals.visitors)}
          hint="Counted per day; a returning visitor counts once per day, by design"
        />
        <Stat label="Bot requests" value={int(totals.bots)} hint="Excluded from every other number here" />
        <Stat
          label="Views per visitor"
          value={totals.visitors ? (totals.views / totals.visitors).toFixed(1) : "—"}
        />
      </section>

      <div style={{ display: "flex", gap: 32, flexWrap: "wrap", marginTop: 16 }}>
        <div style={{ minWidth: 280, flex: "1 1 280px" }}>
          <div style={subhead}>Views per day</div>
          <Bars rows={dailyViews} format={int} emptyText="Nothing recorded yet." />
        </div>
        <div style={{ minWidth: 280, flex: "1 1 280px" }}>
          <div style={subhead}>Unique visitors per day</div>
          <Bars rows={dailyVisitors} format={int} emptyText="" />
        </div>
      </div>

      <div style={{ display: "flex", gap: 32, flexWrap: "wrap", marginTop: 18 }}>
        <TopList title="Pages" rows={audience.pages} />
        <TopList title="Demos" rows={audience.demos} />
        <TopList title="Referrers" rows={audience.referrers} />
      </div>
      <div style={{ display: "flex", gap: 32, flexWrap: "wrap", marginTop: 18 }}>
        <TopList title="Countries" rows={audience.countries} upper />
        <TopList title="Devices" rows={audience.devices} />
        <TopList title="Browsers" rows={audience.browsers} />
        <TopList title="Languages" rows={audience.languages} upper />
      </div>

      <p style={note}>
        No cookies, no IP addresses, no user agents and no URLs with query strings are stored — only these
        daily counts. Unique visitors use a salted hash that is rotated (and then deleted) every day, so the
        same person on two days cannot be recognised as the same person.
      </p>
    </Section>
  );
}

function TopList({ title, rows, upper }: { title: string; rows: Bucket[]; upper?: boolean }) {
  return (
    <div style={{ minWidth: 200, flex: "1 1 200px" }}>
      <div style={subhead}>{title}</div>
      <Bars
        rows={rows.map((r) => ({ label: upper ? r.value.toUpperCase() : r.value, value: r.views }))}
        format={int}
        emptyText="—"
      />
    </div>
  );
}

/**
 * The live-session table (DEV-2567): filter, pager, kill button.
 *
 * It owns its own fetches instead of re-running `load(days)`, because the report
 * around it is D1 aggregates plus an analytics rollup and none of that changes
 * when someone turns a page. The first page arrives inside the report, so the
 * common case still costs no extra request.
 *
 * The filter defaults ON. Before this, every meter key in KV was a row and the
 * table claimed 50 "live" sessions against a 5-instance pool — the meter outlives
 * its container by up to 24h, because `hasSessionMeter` doubles as a budget gate
 * and cannot have a short TTL. Unchecking the box is how you reach that tail,
 * which is exactly where a phantom row has to be visible to be killed.
 */
function LiveSessionsSection({
  apiBase,
  token,
  initial,
  onCounts,
}: {
  apiBase: string;
  token: string | null;
  initial: LiveSessionsPage;
  /** Lifts the counts back to the "Live sessions now" stat, which is otherwise
   *  fed from the report and would sit there contradicting the table under it
   *  after a kill. */
  onCounts: (counts: { awakeCount: number; meterCount: number }) => void;
}) {
  const [page, setPage] = useState(initial);
  const [awakeOnly, setAwakeOnly] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The ref a confirmation is pending for. Two clicks to kill: this ends
   *  somebody else's running work, and the rows are addressed by an
   *  indistinguishable 8-hex digest, so a misclick is easy and unrecoverable. */
  const [confirming, setConfirming] = useState<string | null>(null);

  const authHeaders: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const fetchPage = useCallback(
    async (next: { awakeOnly: boolean; offset: number }) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(
          `${apiBase}/api/admin/sessions?awake=${next.awakeOnly ? "1" : "0"}&offset=${next.offset}`,
          { headers: authHeaders },
        );
        const fresh = await readApiJson<LiveSessionsPage>(res, `sessions request failed (${res.status})`);
        setPage(fresh);
        onCounts({ awakeCount: fresh.awakeCount, meterCount: fresh.meterCount });
        setConfirming(null);
      } catch (e: unknown) {
        reportError(e, "admin-sessions");
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    // `authHeaders` is derived from `token`, which is listed.
    [apiBase, token, onCounts],
  );

  async function kill(ref: string) {
    setBusy(true);
    setError(null);
    // Held in a local, NOT in state: the reload below starts with `setError(null)`,
    // so anything set here would be wiped before it could render — which is how
    // the 409 "matches more than one session" and any 500 from the teardown were
    // silently unreachable, leaving the operator with a row that did not go away
    // and no reason why. Re-applied after the reload instead.
    let failure: string | null = null;
    try {
      const res = await fetch(`${apiBase}/api/admin/sessions/${ref}`, {
        method: "DELETE",
        headers: authHeaders,
      });
      // A 404 means the row was already gone — someone else's teardown won the
      // race. Not worth an error banner, but the reload below has to happen
      // either way or the stale row sits there inviting a second click.
      if (res.status !== 404) await assertApiOk(res, `kill failed (${res.status})`);
    } catch (e: unknown) {
      reportError(e, "admin-session-kill");
      failure = e instanceof Error ? e.message : String(e);
    } finally {
      setBusy(false);
      // Re-read rather than splice the row out locally: a kill changes both
      // counts and can empty the page, and `pageOf` corrects an offset that ran
      // off the end.
      await fetchPage({ awakeOnly, offset: page.offset });
      if (failure) setError(failure);
    }
  }

  const first = page.total === 0 ? 0 : page.offset + 1;
  const last = Math.min(page.offset + page.limit, page.total);
  const sleptCount = page.meterCount - page.awakeCount;

  return (
    <Section title="Live sessions">
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={awakeOnly}
            disabled={busy}
            onChange={(e) => {
              const next = e.target.checked;
              setAwakeOnly(next);
              // Back to page one: the offset means nothing across a filter change.
              void fetchPage({ awakeOnly: next, offset: 0 });
            }}
          />
          Only sessions still awake
        </label>
        <span style={{ fontSize: 12, color: theme.color.textMuted }}>
          {int(page.awakeCount)} awake
          {sleptCount > 0 && ` · ${int(sleptCount)} slept but still metered (24h window)`}
        </span>
      </div>

      {error && <p style={{ color: theme.color.danger, fontSize: 13 }}>{error}</p>}

      {page.rows.length === 0 ? (
        <p style={note}>
          {awakeOnly
            ? sleptCount > 0
              ? "No containers awake right now — uncheck the filter to see the sessions that have already slept."
              : "No containers awake right now."
            : "No sessions metered in the last 24h."}
        </p>
      ) : (
        <table style={table}>
          <thead>
            <tr>
              <Th>Session</Th>
              <Th>Example</Th>
              <Th>State</Th>
              <Th align="right">Age</Th>
              <Th align="right">Est. cost</Th>
              <Th align="right">Action</Th>
            </tr>
          </thead>
          <tbody>
            {page.rows.map((s) => (
              <tr key={s.ref}>
                <Td mono>{s.ref}</Td>
                <Td>{s.framework}</Td>
                <Td>
                  <span style={{ color: s.state === "awake" ? theme.color.text : theme.color.textMuted }}>
                    {s.state === "awake" ? "awake" : `slept · quiet ${duration(s.quietSeconds)}`}
                  </span>
                </Td>
                <Td align="right">{duration(s.awakeSeconds)}</Td>
                {/* Priced off billable time, not age: a slept row's container
                    stopped billing when it scaled to zero, and charging it for
                    the whole 24h is how the old table read as a runaway bill. */}
                <Td align="right" title={`${duration(s.billableSeconds)} billable`}>{usd(s.estimatedUsd)}</Td>
                <Td align="right">
                  {confirming === s.ref ? (
                    <span style={{ display: "inline-flex", gap: 6 }}>
                      <button
                        type="button"
                        style={{ ...chip, color: theme.color.danger }}
                        disabled={busy}
                        onClick={() => void kill(s.ref)}
                      >
                        Confirm kill
                      </button>
                      <button type="button" style={chip} disabled={busy} onClick={() => setConfirming(null)}>
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button type="button" style={chip} disabled={busy} onClick={() => setConfirming(s.ref)}>
                      Kill
                    </button>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {page.total > page.limit && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
          <button
            type="button"
            style={chip}
            disabled={busy || page.offset === 0}
            onClick={() => void fetchPage({ awakeOnly, offset: Math.max(0, page.offset - page.limit) })}
          >
            ← Previous
          </button>
          <span style={{ fontSize: 12, color: theme.color.textMuted }}>
            {int(first)}–{int(last)} of {int(page.total)}
          </span>
          <button
            type="button"
            style={chip}
            disabled={busy || last >= page.total}
            onClick={() => void fetchPage({ awakeOnly, offset: page.offset + page.limit })}
          >
            Next →
          </button>
        </div>
      )}

      <p style={note}>
        Derived from the awake-window meters. A meter is written when the session starts and dropped
        on a clean teardown, but it is kept for 24 hours otherwise — so a client that vanished without
        one (killed tab, dropped <code>pagehide</code> request) leaves a row here long after its
        container scaled to zero and stopped billing. Those rows are the <em>slept</em> ones, hidden by
        default. A backgrounded tab whose HMR socket is still holding its container awake also reads as
        slept, because the keepalive that ticks the meter is suppressed while the tab is hidden.
        {page.truncated && " More meters exist than this scan reads; counts are a lower bound."}
      </p>
    </Section>
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
  title,
}: {
  children: React.ReactNode;
  align?: "right";
  muted?: boolean;
  mono?: boolean;
  colSpan?: number;
  title?: string;
}) => (
  <td
    colSpan={colSpan}
    title={title}
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

/** Spend on one SKU inside the report window, preferring reconciled figures
 *  per day exactly as the ceiling's own arithmetic does. */
function windowedSpend(rows: LedgerRow[], sku: string): number {
  const perDay = new Map<string, { estimate: number; billing: number }>();
  for (const row of rows) {
    if (row.sku !== sku) continue;
    const cur = perDay.get(row.day) ?? { estimate: 0, billing: 0 };
    if (row.source === "billing") cur.billing += row.usd;
    else cur.estimate += row.usd;
    perDay.set(row.day, cur);
  }
  return [...perDay.values()].reduce((sum, v) => sum + (v.billing > 0 ? v.billing : v.estimate), 0);
}

/** Totals per `dimension` for one metric (framework, refusal reason, …). */
function byDimension(rows: UsageRow[], metric: string): { label: string; value: number }[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (row.metric !== metric) continue;
    const label = row.dimension || "(unspecified)";
    totals.set(label, (totals.get(label) ?? 0) + row.count);
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }));
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
  fontFamily: theme.font.ui, fontSize: 12, color: theme.color.text, background: theme.color.surfaceRaised,
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
  color: theme.color.accentContrast, borderRadius: 999, padding: "2px 9px", fontSize: 11.5, fontWeight: 600,
};
const meter: React.CSSProperties = {
  position: "relative", height: 10, borderRadius: 999, background: theme.color.surfaceMuted,
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
const input: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", fontFamily: theme.font.ui, fontSize: 13,
  padding: "5px 8px", border: `1px solid ${theme.color.border}`, borderRadius: 6, color: theme.color.text,
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
