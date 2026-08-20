import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog,
  EditorShell,
  FullBar,
  markUrl,
  PreviewStatusBar,
  shellStyles,
  Spinner,
  theme,
  TopBar,
  useLogoUrl,
  useTheme,
  type PreviewStatus,
} from "@handsontable/demo-editor-shell";
import {
  isSchemeReady,
  SCHEME_MESSAGE_TYPE,
  type SchemeMode,
} from "@handsontable/demo-runtime/scheme";
import {
  deriveDocsBucketCandidate,
  isNextPrereleaseVersion,
  pinHandsontableFiles as pinToVersionRef,
  resolveStarterBucket,
  selectedReleaseMajor,
  validateHandsontableVersion,
  type CatalogEntry,
  type DemoRuntime,
  type FilesMap,
  type WriteFileOptions,
} from "@handsontable/demo-runtime";
import {
  SandpackRuntime,
  isCompilerUnavailable,
  rearmCompilerLoad,
} from "@handsontable/demo-runtime/sandpack";
import { ContainerRuntime, ContainerBootFailure, SessionStartError, isBudgetRefusal } from "@handsontable/demo-runtime/container";
import { zipSync, strToU8 } from "fflate";
import { catalog, getEntry, fetchVersions, checkVersionExists, VERSION_OPTIONS, DEFAULT_VERSION } from "./catalog.js";
import {
  fetchDocsManifest,
  loadDocsExample,
  isDocsResourceMissing,
  type DocsManifest,
  type DocsManifestItem,
} from "./docs-catalog.js";
import { loadStarterExample, toPlaceholderEntry } from "./starter-catalog.js";
import { DocsCascader, type CascaderLeaf } from "./DocsCascader.js";
import { currentUser, login, logout, getToken, type User } from "./auth.js";
import { assertApiOk, readApiJson } from "./api.js";
import { isSessionExpired } from "./apiError.js";
import { formFooter, ghostButton, primaryButton } from "./formStyles.js";
import { AdminPanel } from "./Admin.js";
import { applyDroppedFiles } from "./addFiles.js";
import { AskAiButton, ChatPanel } from "./Chat.js";
import { StyleButton, StylePanel } from "./StylePanel.js";
import { buildResetChanges, hasWiredTheme, THEME_MODULE_BASENAME } from "./theme/codegen.js";
import { ShareLinks } from "./ShareLinks.js";
import { EditInfoDialog } from "./EditInfoDialog.js";
import { GuidePage } from "./Guide.js";
import { guideTrack, parseGuideRoute } from "./guideTracks.js";
import { elapsedBucket } from "./sessionDiagnostics.js";
import { Markdown } from "./markdown.js";
import { MyDemosPage } from "./MyDemos.js";
import { SettingsPage } from "./Settings.js";
import { useProfile } from "./useProfile.js";
import { monitorDemos, reportDemoEvent, reportError, reportingEnabled, Sentry } from "./sentry.js";
import { isMonitorPayload } from "@handsontable/demo-runtime/monitor";
import { tier1Report } from "./tier1Report.js";

const SANDPACK_BUNDLER_URL = import.meta.env.VITE_SANDPACK_BUNDLER_URL || undefined;
const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8787";

// Framework preference (used to auto-pick a variant when an example is chosen and
// the current one isn't available) + short labels for the framework picker.
const FW_PREF = ["react", "typescript", "javascript", "vue", "angular"];
const FW_LABEL: Record<string, string> = {
  javascript: "JavaScript",
  typescript: "TypeScript",
  react: "React",
  vue: "Vue",
  angular: "Angular",
};
// Runner framework → Handsontable docs URL prefix (TypeScript shares the JS docs).
const FW_DOCS: Record<string, string> = {
  javascript: "javascript-data-grid",
  typescript: "javascript-data-grid",
  react: "react-data-grid",
  vue: "vue-data-grid",
  angular: "angular-data-grid",
};

/** The Style panel writes `import … from "handsontable/themes"` plus three
 * `themes/static/variables/*` imports into the demo, and none of those paths
 * exist before 17.0.0 — below that the generated module cannot resolve its own
 * imports and the preview fails to compile (DEV-2560).
 *
 * Deliberately not the runner's `DEFAULT_MIN_MAJOR` (15): that floor is "cores
 * we boot", this one is "cores with a theme API". It is the same cut line
 * `pipeline/blank-starters.mjs` calls `isLegacyBucket`. */
const THEME_API_MIN_MAJOR = 17;

/** Said when a version change takes a generated theme module back out (DEV-2571).
 *  Names the removal, because it is an edit to the visitor's files that they did
 *  not make — and says where the theme went, since it is still in localStorage
 *  and reopening the panel on a supported core writes it back. */
const THEME_REMOVED_NOTICE =
  `Theming needs Handsontable ${THEME_API_MIN_MAJOR} or newer, so the custom theme was removed from this demo`
  + ` — reopen Style on ${THEME_API_MIN_MAJOR} or newer to put it back.`;

/** A starter may declare a minimum core major (e.g. the UI-library starters need
 * the themes API added in Handsontable 17); hide lower published majors from its
 * version picker. next/custom refs (major null) always pass through. */
function versionsForEntry(options: string[], minCoreMajor: number | null): string[] {
  if (minCoreMajor == null) return options;
  return options.filter((v) => {
    const major = selectedReleaseMajor(v);
    return major == null || major >= minCoreMajor;
  });
}

/** Public documentation page URL for a docs example. */
function docsPageUrl(framework: string, permalink: string): string {
  const prefix = FW_DOCS[framework] ?? "javascript-data-grid";
  return `https://handsontable.com/docs/${prefix}${permalink}/`;
}

/** Turn a raw runtime error into a message that explains container prerequisites. */
function describeRuntimeError(e: unknown, engine: string, version: string): string {
  // A boot-script failure explains itself: a one-line cause, with the recent boot
  // output beside it on the error object. Compose the two here — the error card
  // renders `errorMessage` and nothing else, so this is the only place a user ever
  // sees the log — and skip the connectivity heuristic below, which would otherwise
  // misfire on words like "fetching" that pnpm's own error output happens to contain.
  // The cause line deliberately shows twice, once as the headline and once in place,
  // so the tail stays a faithful copy of what the container printed.
  if (e instanceof ContainerBootFailure) return e.log ? `${e.message}\n\n${e.log}` : e.message;
  // A cost-guardrail refusal (DEV-2030) is a deliberate product state, and the
  // server already phrased it for users — never rewrite it as a connectivity
  // problem, which is what the heuristic below would do with a 503.
  if (isBudgetRefusal(e)) return e.message;
  // Our own compiler chunk never arrived (DEV-2569). Worded without asserting a cause we
  // cannot prove: a rotated-out asset after a deploy and a blocked or offline fetch are
  // indistinguishable from here, and both are cured by the same two actions. Deliberately
  // avoids the words the connectivity heuristic below matches on ("fetch", "load failed").
  if (isCompilerUnavailable(e)) {
    return "The preview compiler could not be downloaded, so this example cannot be built. Restart the preview to try again, or reload the page — a tab left open across a deployment has to reload to pick up the current version.";
  }
  const msg = e instanceof Error ? e.message : String(e);
  // ⚠ This heuristic REPLACES the runtime's message, so every alternative below is a
  // contract with whoever writes those messages. `sessionStartMessage` in
  // packages/runtime/src/container.ts phrases two tiers to miss this test deliberately
  // — gateway-timeout (504/522/524) and service-unavailable (an envelope-less 503,
  // DEV-2553) — and its connectivity tiers to hit it, which is what still gets a
  // developer whose own worker is down the right answer. Widening the alternation — or
  // letting "fetch" back into either of those sentences — tells a production visitor
  // whose sandbox never started to install Docker and run a worker (DEV-2538/DEV-2553,
  // Sentry DEMOS-9).
  // `runner/pipeline/session-start-failure.test.mjs` pins the other end.
  if (engine === "container" && /failed to fetch|networkerror|load failed|session start failed|fetch/i.test(msg)) {
    return "This example runs on the container engine, which needs the demo server (Cloudflare Sandbox). It isn't reachable here — run the local API worker (requires Docker) or open this example on the deployed demos.handsontable.com.";
  }
  // Sandpack's own bundler message for an unresolved dependency reads like a
  // transient hiccup worth retrying ("please try again in a couple
  // seconds") — misleading when the actual cause is a pinned Handsontable
  // version that was never published, which no amount of retrying fixes.
  if (engine === "sandpack" && /could not fetch dependencies/i.test(msg)) {
    return `Handsontable ${version} could not be fetched. Check that this exact version is published on npm.`;
  }
  return msg;
}

/**
 * Decide whether a preview failure is ours to fix, and report it if so.
 *
 * `DemoRuntime.onError` is a mixed channel. On the Sandpack engine it carries
 * compile and runtime errors from the example code being edited — a typo
 * mid-keystroke, an example that was imported broken. That is product output, not
 * an application fault, and reporting it would bury the signal (and the quota)
 * under one issue per syntax error.
 *
 * The container engine is the opposite: `SessionStartError` is how the Tier-2
 * instance pool refuses a session (the exhaustion class of failure behind PR #87)
 * and `ContainerBootFailure` is a dev server that could not install or start.
 * Those are exactly what we want to hear about. 410 is excluded — it means the
 * client had already navigated away and the server tore the session down, which
 * is the designed outcome, not a failure.
 *
 * Fingerprinted by error class, not by message: one boot failure is one issue no
 * matter which example or framework hit it, and the grouping stays stable as the
 * message text improves (DEV-2533 replaced the raw log with a one-line cause). The
 * log travels as `extra.bootLog` instead — extras take no part in grouping, titling
 * or stack parsing, which is exactly what putting it in the message got wrong.
 */
function reportRuntimeError(e: unknown, engine: string, framework: string): void {
  if (!reportingEnabled) return;
  // Tier-1 compile and runtime errors are the "product output" case above — dropped
  // by default, reported while demo monitoring is on (DEV-2527). They arrive as
  // ordinary app-surface events rather than through `reportDemoEvent`, because this
  // channel is the shell's own view of the failure, not something the preview
  // relayed: `Sentry.captureException` below keeps the engine tag and the fingerprint
  // rules that follow.
  if (engine !== "container") {
    // Every rule for this branch — which failures are reported at all, how they group, and
    // what the issue is titled — lives in `tier1Report.ts` so it can be unit-tested; this
    // file cannot be imported by `node --test`. Two of those rules used to be inline here
    // and are worth naming: the DEV-2552 stand-down for a throw the in-preview reporter
    // already owns, and the DEV-2527 `monitorDemos` gate, which the compiler-asset branch
    // deliberately sits ahead of (DEV-2569).
    const report = tier1Report({
      name: e instanceof Error ? e.name : "",
      message: e instanceof Error ? e.message : String(e),
      compilerUnavailable: isCompilerUnavailable(e),
      assetUrl: e instanceof Error ? (e as { assetUrl?: string | null }).assetUrl ?? null : null,
      causeMessage: e instanceof Error && e.cause instanceof Error ? e.cause.message : null,
      replay: e instanceof Error && (e as { replay?: boolean }).replay === true,
      online: navigator.onLine,
      monitorDemos,
    });
    if (!report) return;
    // Captured as a fresh error rather than `e`, and this is the whole of DEMOS-15's second
    // defect: a Sentry issue takes its title from `name: message` and re-derives it on every
    // new event, so a per-event message on a flat fingerprint means the issue is titled after
    // whichever sample arrived last — a visitor's typo, or one deploy's hashed chunk name.
    // The real text goes to `extra`, which takes no part in grouping or titling. The stack
    // being dropped costs nothing: it was `SandpackRuntime.onMessage`, which points at us
    // rather than at the failure.
    const titled = new Error(report.synthesizeAs.message, { cause: e });
    titled.name = report.synthesizeAs.name;
    Sentry.captureException(titled, {
      tags: report.tags,
      fingerprint: report.fingerprint,
      level: report.level,
      extra: report.extra,
    });
    return;
  }
  // The budget guardrail refusing a session is the guardrail working. It would
  // otherwise arrive as a flood of identical 503s at exactly the moment the
  // team is already dealing with the spend.
  if (isBudgetRefusal(e)) return;
  if (e instanceof SessionStartError) {
    if (e.status === 410) return;
    // The server's machine-readable reason joins the fingerprint when it sent
    // one (DEV-2556). Status alone is too coarse now that the Worker refuses at
    // capacity with its own 503: `at_capacity` — every container slot taken,
    // which is a spend decision — would otherwise land in the same issue as an
    // envelope-less platform 503 ("The sandbox service is unavailable right
    // now"), which is a gateway fault and has nothing to do with our pool. That
    // grouping is the only capacity evidence the create side has left, since the
    // refusal is now a returned 503 rather than a throw the outer catch reports.
    //
    // Appended rather than substituted so uncoded failures keep the exact
    // fingerprint they have today: no live issue regroups, and only the coded
    // refusals split off. `budget_*` codes never reach here (suppressed above).
    const code = typeof e.code === "string" && e.code.length > 0 ? e.code : null;
    // DEV-2559. Three facets that make DEMOS-9's 83 events answerable, all of them
    // TAGS beside the fingerprint and never inside it: the fingerprint below stays
    // byte-identical, because sharding one continuous signal by framework would
    // destroy the only trend the issue has.
    //
    // `framework` uses the key `reportDemoEvent` already tags with, so both sides of
    // the preview boundary facet together. Deliberately added to this branch alone —
    // the boot and compile branches have no question pending on them, and tag churn
    // there would only muddy their own histories.
    //
    // `session_elapsed_bucket` over a raw-ms tag: see sessionDiagnostics.ts. The exact
    // count rides in `extra`, which is not searchable but is readable per event.
    //
    // `cf_ray` is a tag rather than an extra precisely because it IS searchable, which
    // makes the reverse join work — spot a slow invocation in Cloudflare's Workers
    // Logs, search the ray here, and find out whether it was one of these. That gives
    // it ~one value per event, which is only acceptable because this path fires a
    // handful of times a day; it would be the wrong call on a hot one.
    const diagnostics = e.diagnostics;
    Sentry.captureException(e, {
      tags: {
        context: "tier2-session-start",
        session_status: String(e.status),
        framework,
        ...(code ? { session_refusal: code } : {}),
        ...(diagnostics
          ? {
              session_elapsed_bucket: elapsedBucket(diagnostics.elapsedMs),
              ...(diagnostics.ray ? { cf_ray: diagnostics.ray } : {}),
            }
          : {}),
      },
      fingerprint: ["tier2-session-start", String(e.status), ...(code ? [code] : [])],
      ...(diagnostics ? { extra: { sessionElapsedMs: diagnostics.elapsedMs } } : {}),
    });
    return;
  }
  if (e instanceof ContainerBootFailure) {
    Sentry.captureException(e, {
      tags: { context: "tier2-container-boot" },
      fingerprint: ["tier2-container-boot"],
      // Bounded upstream (the status route tails 2500 bytes, `bootFailureDetail`
      // keeps 40 lines) and already redacted of preview hosts, so no extra cap here.
      ...(e.log ? { extra: { bootLog: e.log } } : {}),
    });
    return;
  }
  // Normal teardown: dispose() races a pending message, or the tab is closing.
  if (e instanceof Error && e.message === "The session was closed.") return;
  Sentry.captureException(e, { tags: { context: "tier2-runtime" } });
}

/** Pin the workspace to the version state's ref. Thin wrapper over the shared
 *  `pinHandsontableFiles` (packages/runtime), which the API worker also calls
 *  since DEV-2565 — one rewrite rule, two callers.
 *
 *  An unusable version is left unpinned rather than thrown: the mount guard owns
 *  that message and refuses to boot behind this, and the only way to reach it now
 *  is a hand-typed `?v=`, since the API no longer stores a ref the validator
 *  rejects. */
function pinHandsontableFiles(files: FilesMap, version: string): FilesMap {
  const validated = validateHandsontableVersion(version);
  if (!validated.ok) return files;
  return pinToVersionRef(files, validated.value);
}

/** Did the host simply not have this docs resource? Delegates to the loader's
 *  typed error (DEV-2535): the old `/\b404\b/` message sniff missed the deployed
 *  host entirely, which serves 200 + index.html for a miss and so surfaced as a
 *  JSON SyntaxError, and it could equally misfire on a docs path containing
 *  "404" interpolated into an unrelated failure's message. */
function isMissingDocsResource(error: unknown): boolean {
  return isDocsResourceMissing(error);
}

/** Zip a file map and hand it to the browser. Module-level because two callers need
 *  it: the shell's `Download` (live, possibly-edited workspace) and full mode, which
 *  has no workspace — only the files it fetched from the source snapshot. */
function downloadWorkspaceZip(files: FilesMap, name: string): void {
  const entries: Record<string, Uint8Array> = {};
  for (const [p, c] of Object.entries(files)) entries[p.replace(/^\//, "")] = strToU8(c);
  const bytes = zipSync(entries, { level: 6 });
  const base = (name || "handsontable-demo")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "handsontable-demo";
  const blob = new Blob([bytes as BlobPart], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${base}.zip`;
  a.click();
  URL.revokeObjectURL(url);
}

type EditorRoute =
  | { mode: "play" }
  | { mode: "edit"; id: string }
  | { mode: "share"; id: string };

/** Routes that are not the editor at all. Kept out of `EditorRoute` so every
 *  `route.mode` switch inside `Authoring` stays exhaustive over editor modes. */
type AppRoute =
  | EditorRoute
  | { mode: "myDemos" }
  | { mode: "allDemos" }
  | { mode: "settings" }
  | { mode: "guide" };

function parseRoute(): AppRoute {
  if (/^\/my-demos\/?$/.test(location.pathname)) return { mode: "myDemos" };
  // `/all-demos` (DEV-2506) — the same listing with a wider scope.
  if (/^\/all-demos\/?$/.test(location.pathname)) return { mode: "allDemos" };
  // `/settings` (DEV-2166). Before this line the fallthrough below matched it and
  // the profile page silently rendered the playground — the static Worker already
  // serves index.html for it (`not_found_handling: "single-page-application"`),
  // so it never 404'd, it just showed the wrong thing.
  if (/^\/settings\/?$/.test(location.pathname)) return { mode: "settings" };
  // `/guide` (DEV-2503) — the in-app how-to. Same shape as the two above: matched
  // before the editor fallthrough, which would otherwise read it as a demo id.
  // `/guide` and `/guide/<track>` (DEV-2522): one route, because the page reads the
  // track off the path itself — a mode per track would put the guide's table of
  // contents in two places.
  if (/^\/guide(\/[^/]*)?\/?$/.test(location.pathname)) return { mode: "guide" };
  const m = location.pathname.match(/^\/(edit|share)\/([A-Za-z0-9_-]+)\/?$/);
  if (m) return { mode: m[1] as "edit" | "share", id: m[2]! };
  return { mode: "play" };
}

/**
 * Tell the API a page was viewed.
 *
 * The authoring app is served by its own static Worker, so its views are
 * invisible to the API's analytics unless we say so. Only the path is sent —
 * never the query string, which can carry a `?docs=` deep link or anything
 * else a user pasted — and the server normalises even that into a fixed label
 * set. No id is generated or stored on the client; see workers/api/src/
 * analytics.ts for what the server does and does not keep.
 */
function beacon(path: string): void {
  void fetch(`${API_BASE}/api/beacon`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
    keepalive: true,
  }).catch(() => { /* analytics must never surface to a user */ });
}

/**
 * `?mode=full` resolves for a *saved* demo only — full mode shows the prebuilt
 * `/d/:id/` artifact, and `play` has no id and therefore no artifact. `window-maximize`
 * is withheld in `play` for the same reason, so the param cannot be reached from the UI
 * there either.
 *
 * `edit` resolves it as well as `share`: `/edit/:id` is auth-gated, but the build full
 * mode renders is the one `/share/:id` already serves publicly, so this exposes nothing
 * new — and the maximize button has to work from the editor, which is where it lives.
 */
function fullModeId(route: AppRoute): string | null {
  if (
    route.mode === "play" ||
    route.mode === "myDemos" ||
    route.mode === "allDemos" ||
    route.mode === "settings" ||
    route.mode === "guide"
  ) return null;
  return new URLSearchParams(location.search).get("mode") === "full" ? route.id : null;
}

const SITE_TITLE = "Handsontable Demos";

/**
 * Sets `document.title`. Before T9 there was one static title — "Handsontable
 * Demos — Authoring" — which was wrong on `/share/:id` (public, not authoring)
 * and uninformative in a tab strip full of demos.
 *
 * A hook rather than a render-time assignment: the demo's own title arrives
 * asynchronously, and writing during render would make the effect order decide
 * what a browser tab says.
 */
function useDocumentTitle(name?: string | null) {
  useEffect(() => {
    document.title = name ? `${name} — ${SITE_TITLE}` : SITE_TITLE;
  }, [name]);
}

export function App() {
  // /admin — the internal usage + cost panel (DEV-2030). Sits outside the
  // editor routes entirely: it renders no runtime and boots no container.
  if (location.pathname.replace(/\/+$/, "") === "/admin") return <AdminGate />;

  const route = parseRoute();
  const fullId = fullModeId(route);
  if (fullId) return <FullMode id={fullId} />;
  // Before `Gate`/`Authoring`, which boot a container session this page has no
  // use for. It is auth-gated all the same — the listing is per-user.
  if (route.mode === "myDemos") return <MyDemosRoute />;
  if (route.mode === "allDemos") return <MyDemosRoute scope="all" />;
  // Same story as My demos: auth-gated, renders no runtime, boots no container.
  if (route.mode === "settings") return <SettingsRoute />;
  // Login-gated like the two above: the guide describes what signing in unlocks,
  // and it is the account menu that offers it.
  if (route.mode === "guide") return <GuideRoute />;
  // The share page is a public, read-only playground — no auth needed.
  if (route.mode === "share") return <ShareRoute route={route} />;
  return <Gate route={route} />;
}

/** `/my-demos`. Same login-on-anonymous contract as `/edit/:id`: the listing is
 *  `WHERE created_by = <caller>`, so there is nothing to show a stranger. */
function MyDemosRoute({ scope = "mine" }: { scope?: "mine" | "all" }) {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => {
    currentUser().then(setUser);
  }, []);
  useEffect(() => {
    if (user === null) login(); // return_to preserves /my-demos, /all-demos
  }, [user]);
  useDocumentTitle(scope === "all" ? "All demos" : "My demos");

  if (user === undefined) return <Splash text="Loading data …" />;
  // Signed in either way: `/all-demos` lists internal work, and the endpoint
  // behind it is authenticated.
  if (user === null) {
    return <Splash text={scope === "all" ? "Sign in to see the team's demos…" : "Sign in to see your demos…"} />;
  }
  return <MyDemosPage apiBase={API_BASE} user={user} scope={scope} />;
}

/** `/settings` (DEV-2166). A profile is per-user by definition, so the same
 *  login-on-anonymous contract as `/my-demos`. */
function SettingsRoute() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => {
    currentUser().then(setUser);
  }, []);
  useEffect(() => {
    if (user === null) login(); // return_to preserves /settings
  }, [user]);
  useDocumentTitle("Settings");

  if (user === undefined) return <Splash text="Loading data …" />;
  if (user === null) return <Splash text="Sign in to change your profile…" />;
  return <SettingsPage apiBase={API_BASE} user={user} />;
}

/** `/guide` and `/guide/<track>` (DEV-2503, tracks in DEV-2522). The content is the
 *  markdown in `runner/docs/guide/`; this route only gates and frames it. */
function GuideRoute() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => {
    currentUser().then(setUser);
  }, []);
  useEffect(() => {
    if (user === null) login(); // return_to preserves /guide and the track path
  }, [user]);
  // Named by track, so four open guide tabs are four distinguishable tabs.
  const guideSlug = parseGuideRoute(location.pathname).track;
  const guideLabel = guideSlug ? guideTrack(guideSlug)?.label : null;
  useDocumentTitle(guideLabel ? `Guide: ${guideLabel}` : "Guide");

  if (user === undefined) return <Splash text="Loading data …" />;
  if (user === null) return <Splash text="Sign in to read the guide…" />;
  return <GuidePage apiBase={API_BASE} user={user} />;
}

/**
 * `/share/:id` — public and read-only, so the workspace is always anonymous
 * (`user={null}`: no action bar, no file CRUD, no save).
 *
 * The *account menu* is a separate question. Before T9 the top bar keyed off the
 * same `user`, so a signed-in visitor opening someone's share link was offered
 * "Sign in". The identity is resolved here and handed to the top bar alone —
 * never rendered as a gate, so nothing waits on it and the page paints as fast
 * as it always did.
 *
 * `undefined` while that resolve is in flight, and it is a real wait: `currentUser()`
 * round-trips the external broker. Seeding `null` instead would mean "anonymous,
 * confirmed" for those few hundred milliseconds and the bar would offer a signed-in
 * visitor **Sign in** — reintroducing the exact thing this split exists to remove,
 * clickable. Pending renders neither control.
 */
function ShareRoute({ route }: { route: { mode: "share"; id: string } }) {
  const [accountUser, setAccountUser] = useState<User | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    currentUser().then((u) => { if (live) setAccountUser(u); });
    return () => { live = false; };
  }, []);
  return (
    <Authoring
      user={null}
      accountUser={accountUser ?? null}
      accountPending={accountUser === undefined}
      route={route}
    />
  );
}

/**
 * `65:20432` — a saved demo's built output, full window, under the design's chrome:
 * top bar, URL bar, preview, status bar. No editor, no sidebar, no authed action bar.
 *
 * Wraps the static `/d/:id/` build, so this stays the cheap path — no Sandpack, no
 * container, nothing to boot. The chrome renders on the first paint (the iframe starts
 * loading immediately) and the metadata fills in behind it; a `Splash` here would delay
 * the demo itself to wait on a title.
 *
 * Nothing in this view needs auth: the build it shows is what `/share/:id` already
 * serves publicly. Hence no `Sign in` — the frame draws none either.
 */
function FullMode({ id }: { id: string }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [version, setVersion] = useState(DEFAULT_VERSION);
  const [frameworkName, setFrameworkName] = useState<string | undefined>(undefined);
  const [files, setFiles] = useState<FilesMap | null>(null);
  const [status, setStatus] = useState<PreviewStatus>("booting");
  // Bumped by refresh; re-keys the iframe (which re-requests the build) and re-probes.
  const [reloadGen, setReloadGen] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // `no-store` (DEV-2495): this endpoint answers `max-age=60,
    // stale-while-revalidate=300` for the public share traffic it exists for, and
    // `invalidateDemo` clears only the worker's KV copy — nothing reaches the
    // browser cache. Without this, opening full mode right after an Edit info save
    // shows the *old* title for up to a minute, which reads as the save not landing.
    fetch(`${API_BASE}/api/demos/${id}`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((meta: { title?: string; description?: string | null; ht_version?: string } | null) => {
        if (cancelled || !meta) return;
        setTitle(meta.title ?? "");
        setDescription(meta.description ?? "");
        // Only a ref the validator accepts. This view is handed `ht_version`
        // verbatim, so a demo saved before DEV-2565 carries the "latest" sentinel
        // here, and the snapshot read below is what repairs it — but these two
        // fetches settle in either order. Gating on validity is what makes the
        // displayed version independent of which one lands last.
        if (meta.ht_version && validateHandsontableVersion(meta.ht_version).ok) {
          setVersion(meta.ht_version);
        }
      })
      .catch(() => { /* the status dot reports the build; a missing title is not an error state */ });
    return () => { cancelled = true; };
  }, [id]);

  useDocumentTitle(title || null);

  // `framework` and the files only exist on the source snapshot. The files are what
  // `Download` zips; without them the button hides rather than handing over an empty zip.
  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/demos/${id}/source`)
      .then((res) => (res.ok ? res.json() : null))
      .then((src: { framework: string; files: FilesMap; htVersion?: string | null } | null) => {
        if (cancelled || !src) return;
        setFiles(src.files);
        // The repaired ref (DEV-2565) — the metadata read above hands this view
        // `ht_version` verbatim, so a demo saved before that fix would print the
        // "latest" sentinel as its version.
        if (src.htVersion) setVersion(src.htVersion);
        // The design's short label ("React (Vite, TS)") comes from the starter catalog,
        // same resolution the shell's status bar uses in every other mode.
        setFrameworkName(catalog.examples.find((x) => x.framework === src.framework)?.displayName);
      })
      .catch(() => { /* Download stays hidden */ });
    return () => { cancelled = true; };
  }, [id]);

  // The dot cannot come from the iframe's `load` event: that fires for a 404 page too,
  // and `/d/:id/` only exists if `runBuild` succeeded at fork time — a demo without a
  // build would report `ready` over the worker's "Not found". The frame is cross-origin,
  // so it cannot be introspected either. Probe the same URL instead: `GET`, because the
  // route is gated on it (`workers/api/src/index.ts`), and the HTML entry is served
  // `max-age=0, must-revalidate`, so this is one conditional request rather than a
  // second download. 404 (no demo / no artifact) and 410 (revoked) both fail `ok`.
  useEffect(() => {
    let cancelled = false;
    setStatus("booting");
    fetch(`${API_BASE}/d/${id}/`)
      .then((res) => { if (!cancelled) setStatus(res.ok ? "ready" : "error"); })
      .catch(() => { if (!cancelled) setStatus("error"); });
    return () => { cancelled = true; };
  }, [id, reloadGen]);

  /** Leaving full mode is a navigation, not `window.close()`. A tab the maximize button
   *  opened could close itself — it has an opener — but a *pasted* `?mode=full` link is
   *  a tab no script opened, where `close()` silently does nothing. One path that works
   *  everywhere beats two, so both navigate. */
  const leaveFullWindow = useCallback(() => {
    const url = new URL(location.href);
    url.searchParams.delete("mode");
    location.assign(url.toString());
  }, []);

  return (
    <div style={{ ...shellStyles.shell, gridTemplateRows: "auto 1fr" }}>
      {/* No `accountEmail`: `65:20432` draws no account control, and full mode had
          no Sign in either — it was already passing `authed={false}` with no
          `onSignIn`, so the top-right has always been theme toggle + Download. */}
      <TopBar
        examplePill={
          <div style={shellStyles.examplePill(false)}>
            <img src={markUrl} alt="" style={shellStyles.examplePillMark} />
            <span style={pillLabel}>{title || "Shared demo"}</span>
          </div>
        }
        onDownload={files ? () => downloadWorkspaceZip(files, title) : undefined}
      />

      {/* The row track follows the caption: the iframe's `1fr` has to stay on the
          row the iframe is actually in, and a conditional child shifts every row
          after it. */}
      <div
        style={{
          display: "grid",
          gridTemplateRows: description ? "auto auto 1fr auto" : "auto 1fr auto",
          minHeight: 0,
        }}
      >
        {/* The demo's description, which until DEV-2495 was fetched and thrown away.
            Undesigned — `65:20432` draws no subtitle — so ADR-0023 rule 1: a muted
            caption on the seam above the URL bar, the quietest place that is still
            *shown* rather than a hover. Rendered only when there is one, so a demo
            without a description keeps the frame exactly as drawn.

            Local to this view rather than a `FullBar` prop: that component is shared
            with full mode in `play`, where there is no saved row to describe. */}
        {description && (
          // The attribute is for the e2e that asserts the *absence* of this line:
          // matching on text cannot tell "no caption" from "caption not filled in
          // yet", and matching on `p` would catch whatever else the chrome renders.
          <p data-demo-description style={fullDescription} title={description}>{description}</p>
        )}

        <FullBar
          url={`${location.origin}/share/${id}`}
          onRefresh={() => setReloadGen((g) => g + 1)}
          onMinimize={leaveFullWindow}
        />

        <iframe
          key={reloadGen}
          title="Handsontable demo"
          src={`${API_BASE}/d/${id}/`}
          style={{ width: "100%", height: "100%", border: "none", display: "block" }}
          // `allow-downloads` for the same reason as the preview pane (DEV-2203): a
          // demo that exports a file has to be able to hand it over here too.
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
        />

        <PreviewStatusBar status={status} frameworkName={frameworkName} version={version} />
      </div>
    </div>
  );
}

/** The full-mode description caption. Sized and coloured off the same tokens the
 *  bar below it uses (`s.bar`: 36px tall, 13px UI text, one border seam), a step
 *  quieter — it is context for the demo, not chrome you operate. One line: a
 *  description can be a paragraph, and the demo is what the window is for. */
const fullDescription: React.CSSProperties = {
  margin: 0,
  padding: `${theme.space(2)} ${theme.space(3)}`,
  borderBottom: `1px solid ${theme.color.border}`,
  background: theme.color.surface,
  fontFamily: theme.font.ui,
  fontSize: 13,
  color: theme.color.textMuted,
  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
};

/** Resolves the signed-in user; sends the edit page to login when anonymous. */
function Gate({ route }: { route: { mode: "play" } | { mode: "edit"; id: string } }) {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => {
    currentUser().then(setUser);
  }, []);
  useEffect(() => {
    if (user === null && route.mode === "edit") login(); // return_to preserves /edit/:id
  }, [user, route.mode]);

  /**
   * May this user edit this demo? (DEV-2506)
   *
   * Being signed in was the whole of the old gate, which was fine while the only
   * way to reach `/edit/:id` was from your own list. Now that the team's demos are
   * browsable, a link can land anyone here — and the editor would offer a Save the
   * API refuses with a 403, which is a worse answer than not offering it.
   *
   * `undefined` while the answer is in flight; `edit` waits for it rather than
   * flashing an editor a reader cannot use.
   */
  const [canEdit, setCanEdit] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    if (route.mode !== "edit" || !user) return;
    let live = true;
    const token = getToken();
    fetch(`${API_BASE}/api/demos/${route.id}/access`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((res) => (res.ok ? (res.json() as Promise<{ owned?: boolean }>) : null))
      .then((body) => {
        if (!live) return;
        // Only an explicit `owned: false` sends someone away. A missing demo is not
        // an ownership question (the editor's own load path renders that), and a
        // body without the field is an answer we do not understand — treating
        // either as "not yours" would bounce an owner to /share on a payload shape,
        // which is exactly what happened to the older specs' generic
        // `**/api/demos/**` stub the first time this shipped.
        setCanEdit(typeof body?.owned === "boolean" ? body.owned : true);
      })
      // Fail *open*: the API still refuses a stranger's save, so the worst case is
      // the behaviour that shipped before this check. Failing closed would lock an
      // owner out of their own demo on one flaky request.
      .catch(() => { if (live) setCanEdit(true); });
    return () => { live = false; };
  }, [route, user]);

  // Someone else's demo is the read-only playground, and the address bar should
  // say so — a `/edit/` URL showing a page with no Save is its own small lie.
  useEffect(() => {
    if (route.mode === "edit" && canEdit === false) location.replace(`/share/${route.id}`);
  }, [route, canEdit]);

  // The frame gives the loading screen one string, so both load states use it. The
  // sign-in line below is a different message, not a load state, and keeps its own.
  if (user === undefined) return <Splash text="Loading data …" />;
  if (user === null && route.mode === "edit") return <Splash text="Sign in to edit this demo…" />;
  if (route.mode === "edit" && canEdit !== true) return <Splash text="Loading data …" />;
  return <Authoring user={user} route={route} />;
}

/** Login gate for /admin. Same broker identity as the edit page — the panel
 *  shows internal spend, so it is not for anonymous visitors. */
function AdminGate() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => { currentUser().then(setUser); }, []);
  useEffect(() => { if (user === null) login(); }, [user]);

  if (user === undefined) return <Splash text="Loading…" />;
  if (user === null) return <Splash text="Sign in to view usage…" />;
  return <AdminPanel apiBase={API_BASE} token={getToken()} />;
}

/** `72:14610`: a spinner and one line, nothing else. The frame draws the top bar above
 *  it, which this cannot — the splash renders precisely because the shell's state (user,
 *  example, version) hasn't resolved yet, so there is no chrome to draw. Either the
 *  frame is a composite (chrome drawn for context, not specified for this state), or
 *  the app wants a real skeleton top bar during load — a bigger change than a splash. */
function Splash({ text }: { text: string }) {
  return (
    <div style={centered}>
      <Spinner size={20} />
      <p style={{ color: theme.color.textMuted, fontFamily: theme.font.ui, margin: 0 }}>{text}</p>
    </div>
  );
}

function NotFound({ path, transient = false }: { path: string | null; transient?: boolean }) {
  return (
    <div style={centered}>
      <Logo size={40} />
      <p style={{ color: theme.color.text, fontFamily: theme.font.ui, fontWeight: 600, margin: 0 }}>
        {transient ? "Example temporarily unavailable" : "Example not found"}
      </p>
      <p style={{ color: theme.color.textMuted, fontFamily: theme.font.ui, margin: 0 }}>
        {transient
          ? "The documentation catalog could not be loaded. Try again later."
          : "This example may not be imported yet."}
      </p>
      {path && (
        <code style={{ color: theme.color.textMuted, fontSize: 12 }}>{path}</code>
      )}
      <a href="/" style={{ color: theme.color.accentText, fontFamily: theme.font.ui }}>
        Back to the playground
      </a>
    </div>
  );
}

/** Does this lineage name a workspace that came from outside the catalog?
 *
 *  `import:<provider>` (DEV-2504) and `payload:<source>` (DEV-2517) both arrive
 *  with their own files and their own title, so `loadWorkspace` must not treat
 *  either one's *own* load as the thing that replaced it. Every other lineage —
 *  `catalog:<framework>`, a saved demo's id — is a workspace that does. */
function isAdHocLineage(lineage: string): boolean {
  return /^(import|payload):/.test(lineage);
}

function Authoring({
  user,
  route,
  // Defaults to `user`: in `play` and `edit` the workspace identity *is* the
  // account identity. Only `ShareRoute` passes them apart.
  accountUser = user,
  // Only `ShareRoute` sets this. `Gate` resolves the user before it renders
  // `Authoring` at all, so there is never an unresolved window there.
  accountPending = false,
}: {
  user: User | null;
  route: EditorRoute;
  accountUser?: User | null;
  accountPending?: boolean;
}) {
  const savedId = route.mode === "edit" || route.mode === "share" ? route.id : null;
  const isShare = route.mode === "share";
  // Changing the *file set* follows being signed in (ADR-0025), not the mode — see the
  // `onAddFile` props below. One flag, not the expression three times: `EditorShell`
  // derives its `editable` switch from `!!onAddFile` and `FileTree` gates the header
  // `+` / `folder-plus` *and* the per-row ✎ / ✕ on it, so the three handlers have to
  // appear and disappear together or the sidebar contradicts itself.
  const canEditFiles = !!user && !isShare;

  // The account menu's avatar. Keyed off `accountUser` for the same reason the
  // menu itself is: a signed-in visitor on `/share/:id` still has one.
  const profile = useProfile(API_BASE, accountUser?.email);

  // Initial example/version come from the URL so the playground is deep-linkable.
  // `?docs=<content-path>` opens a documentation-guide example (lazy-loaded);
  // `?example=<framework>` opens one of the built-in starter templates.
  const initialDocs = route.mode === "play"
    ? new URLSearchParams(location.search).get("docs")
    : null;
  // `?import=<provider url>` pulls a JSFiddle/StackBlitz project in through
  // `POST /api/import` (DEV-2504). A URL rather than dialog state so the import
  // is shareable and survives a reload, the same way `?example=` and `?docs=` are.
  const initialImport = route.mode === "play"
    ? new URLSearchParams(location.search).get("import")
    : null;
  // `?payload=<id>` opens an ad-hoc project the Theme Builder handed to
  // `POST /api/payload` (DEV-2517). A param rather than a POST into this page for
  // the same reason as `?import=`: the boot is one plain GET the browser can
  // repeat, and the id is all the Theme Builder has to know about us.
  const initialPayload = route.mode === "play"
    ? new URLSearchParams(location.search).get("payload")
    : null;
  const [framework, setFramework] = useState<string>(() => {
    const p = new URLSearchParams(location.search).get("example");
    return catalog.examples.some((e) => e.framework === p) ? (p as string) : "react";
  });
  const hadUrlVersion = useRef<boolean>(new URLSearchParams(location.search).has("v"));
  // The active example entry — a starter template or a docs example, both
  // lazy-loaded per version bucket. Starts as a files-less placeholder built
  // from the catalog index; the runtime-mount effect stays gated until a real
  // artifact replaces it.
  const [entry, setEntry] = useState<CatalogEntry>(() => toPlaceholderEntry(getEntry(framework)));
  // Non-null when the current example is a documentation-guide example.
  const [docsPath, setDocsPath] = useState<string | null>(initialDocs);
  /** Lifecycle of a workspace that came from *outside* the catalog — an
   *  `?import=` URL or a `?payload=` id (DEV-2517). Idle when there is none,
   *  loading while the Worker answers, loaded once that workspace is the open
   *  one, failed with a message the user can act on.
   *
   *  One phase for both on purpose: everything downstream cares only that the
   *  files are not a starter's — the starter-load gate below must stay shut, and
   *  the version picker has to re-pin the files itself. The `import` names are
   *  kept because two effects and a save path read them; a payload is the second
   *  kind of ad-hoc workspace, not a second mechanism. */
  const [importPhase, setImportPhase] = useState<"idle" | "loading" | "loaded" | "failed">(
    initialImport || initialPayload ? "loading" : "idle",
  );
  const [importSkipped, setImportSkipped] = useState<{ path: string; reason: string }[]>([]);
  /** The provider's own title for an imported workspace. Kept apart from `title`
   *  because `title` is also the saved-demo field: Share and Fork mint their names
   *  from `entry.displayName`, which for an import is the *starter* the framework
   *  resolved to ("TypeScript (Vite)"), so "ToolBar Demo" would be lost on save. */
  const [importedTitle, setImportedTitle] = useState<string | null>(null);
  /** `starterGen` as it stood when an import landed — see the starter-load gate.
   *  A ref as well as the state, because the import effect reads it after an
   *  await, where its own closure's copy would be the value from mount. */
  const importStarterGenRef = useRef(0);
  const starterGenRef = useRef(0);
  // Docs examples for the currently-resolved version bucket.
  const [docsItems, setDocsItems] = useState<DocsManifestItem[]>([]);
  const [activeDocsBucket, setActiveDocsBucket] = useState<string | null>(null);
  const [activeDocsManifest, setActiveDocsManifest] = useState<DocsManifest | null>(null);

  /** The shell's own light/dark, so the preview can be told about it (DEV-2561). */
  const { mode: themeMode } = useTheme();

  const [files, setFiles] = useState<FilesMap>(() => ({ ...entry.files }));
  const [version, setVersion] = useState<string>(
    () => new URLSearchParams(location.search).get("v") || DEFAULT_VERSION,
  );
  const [versionOptions, setVersionOptions] = useState<string[]>(VERSION_OPTIONS);
  const [nextVersion, setNextVersion] = useState("");
  const [versionsResolved, setVersionsResolved] = useState(false);
  const [status, setStatus] = useState<PreviewStatus>("booting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Set when an authed action came back 401 (DEV-2534). Its own state rather
  // than an `errorMessage`, because `errorMessage` renders into a `<pre>` in the
  // preview pane and this needs a button: the answer to an expired session is
  // "sign in again", which is an action, not a sentence.
  const [sessionExpired, setSessionExpired] = useState(false);
  const [versionWarning, setVersionWarning] = useState<string | null>(null);
  /** Did the floor below just cost this demo its theme module? Its own state, not
   *  a `versionWarning` string: the dirty-switch branches set that one *after*
   *  this runs, in the same commit, and applying a theme is what makes a
   *  workspace dirty — so the message would always be the one the user did not
   *  need (DEV-2571). */
  const [themeRemoved, setThemeRemoved] = useState(false);
  // Cost-guardrail notice (DEV-2030): non-null once spend crosses the warn
  // threshold, so a user learns live sessions are about to get restricted
  // *before* one is refused. Null whenever the guardrail is observe-only.
  const [budgetNotice, setBudgetNotice] = useState<string | null>(null);
  const [bootLog, setBootLog] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  // Which *files* are unsaved, for the per-tab dot in the editor strip (T12, ADR-0025
  // §3). `dirty` is what `Save •` and the docs-switch guard read; this is what dots a
  // tab. Kept as two pieces of state: every caller of `markDirty` names a path since
  // DEV-2495 took the Edit info dialog off it, so the two happen to agree today, but
  // collapsing `dirty` into `dirtyPaths.size > 0` is a refactor with its own blast
  // radius (every mutation site) and no bug behind it.
  const [dirtyPaths, setDirtyPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [syncing, setSyncing] = useState(false); // container rebuild in flight
  const [refreshing, setRefreshing] = useState(false); // row-2 refresh in flight
  // Guards the refresh promise's own completion: a second click, an example switch or a
  // version change can land mid-flight, and a stale settle must not clear a newer spinner.
  const refreshSeqRef = useRef(0);
  const containerModeRef = useRef(false);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped whenever the whole workspace is replaced (example switch or fork) so
  // the runtime remounts even when the framework is unchanged.
  const [mountGen, setMountGen] = useState(0);
  // Bumped by the error card's "Restart preview". Its own counter rather than `mountGen`:
  // that one doubles as `EditorShell`'s `workspaceKey`, and a retry is not a new
  // workspace — sharing it would close the user's open tabs to fix the preview.
  const [retryGen, setRetryGen] = useState(0);
  // Whether the current failure is one a remount could clear. False for the refusals the
  // mount effect makes *before* building a runtime — an unsupported version, a starter
  // below its core floor. Those depend on the version picker, not on the preview, and
  // offering to restart them would promise something the button cannot deliver.
  const [retryable, setRetryable] = useState(true);
  /** Full mode as a layout, not a route (ADR-0027 §13). Seeded from the URL so a pasted
   *  `?mode=full` link opens in it, then owned as state so entering and leaving cost no
   *  navigation — see `openFullWindow`.
   *
   *  `play` only by construction: `App` dispatches `?mode=full` on a saved demo to
   *  `FullMode` before `Authoring` renders at all, so a `full` here can only be a
   *  playground. The route check says so rather than relying on that ordering. */
  const [full, setFull] = useState(
    () => route.mode === "play" && new URLSearchParams(location.search).get("mode") === "full",
  );

  const [iframeEl, setIframeEl] = useState<HTMLIFrameElement | null>(null);
  // Where the running preview lives, as reported by mount(). Tier 2 gives the
  // container's preview origin; Tier 1 has none to give (Sandpack renders into
  // the iframe without navigating), so the row-2 field falls back.
  const [previewUrl, setPreviewUrl] = useState("");
  const runtimeRef = useRef<DemoRuntime | null>(null);
  const filesRef = useRef<FilesMap>(files);
  filesRef.current = files;

  // ---- Test contract (DEV-2203) -------------------------------------------
  // The workspace files, readable by the E2E suite (e2e/style-panel.spec.ts)
  // without scraping CodeMirror's DOM — `.cm-content` is virtualised, so it
  // only holds the lines on screen and file-content assertions against it
  // pass or fail on scroll position. `filesRef` is updated synchronously by
  // every edit path, including the Style panel's quiet writes, so the hook
  // sees a write before any debounce fires. Same standing as the preview's
  // `data-preview-status` (PreviewPane.tsx): rename or remove only together
  // with the suite. Exposes nothing that is not already client-side in the
  // user's own tab, and doubles as a support tool ("run
  // __HOT_FILES__() in the console and send me the result").
  useEffect(() => {
    const w = window as unknown as { __HOT_FILES__?: () => FilesMap };
    w.__HOT_FILES__ = () => ({ ...filesRef.current });
    return () => {
      delete w.__HOT_FILES__;
    };
  }, []);

  // Gates the first mount until the workspace source has resolved: a saved
  // demo's snapshot, a `?docs=` example, or (since starters are lazy-fetched
  // per bucket, DEV-2213) the starter artifact itself.
  const [sourceLoaded, setSourceLoaded] = useState(false);
  const [docsNotFound, setDocsNotFound] = useState(false);
  const [docsNotFoundTransient, setDocsNotFoundTransient] = useState(false);
  const [docsRuntimeBlocked, setDocsRuntimeBlocked] = useState(!!initialDocs);
  // Starter analogue of docsRuntimeBlocked: set by the unified starter refusal
  // (below-floor major, version with no bucket, artifact fetch failure) so the
  // mount effect can't boot the placeholder or stale files. Only consulted
  // while a starter is open (docsPath null).
  const [starterRuntimeBlocked, setStarterRuntimeBlocked] = useState(false);
  // Bumped by selectExample so re-picking the already-open starter still
  // resets it to pristine files (the framework state alone wouldn't change).
  const [starterGen, setStarterGen] = useState(0);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  /** Saved demos only — the sidebar's BOX INFO drops the row when it's empty. */
  const [createdAt, setCreatedAt] = useState("");
  const [saving, setSaving] = useState(false);
  const [forking, setForking] = useState(false);
  const [embedding, setEmbedding] = useState(false);
  const [shareLinksOpen, setShareLinksOpen] = useState(false);
  const [linksId, setLinksId] = useState<string | null>(null);
  const [forkedFrom, setForkedFrom] = useState<string | null>(`catalog:${framework}`);
  // "Ask about this example" (DEV-2047). Available on every route, including
  // the public /share view — explaining a demo is exactly what a shared link
  // is for.
  const [chatOpen, setChatOpen] = useState(false);
  // "Style this demo" — the Theme Builder controls, applied to the open
  // example. Mutually exclusive with the chat panel: they occupy the same edge
  // of the screen, and both are secondary to the code.
  const [styleOpen, setStyleOpen] = useState(false);
  /** Can this demo's core be themed at all? `selectedReleaseMajor` answers null
   *  for the `next` dist-tag and for pkg.pr.new refs, which are post-18 builds —
   *  those pass, since refusing them would block exactly the people testing them.
   *
   *  It validates before reading the major, which is load-bearing: a bare `16` or
   *  `16.2` is a version both the pencil and `?v=` accept, and the raw-string
   *  reading this replaced found no `\d+\.` in either, answered null, and so
   *  handed a v16 core the prerelease pass-through (DEV-2571). */
  const themingSupported = (() => {
    const major = selectedReleaseMajor(version);
    return major === null || major >= THEME_API_MIN_MAJOR;
  })();
  // Switching the version *down* has to close an open panel, not just hide it:
  // `styleOpen` would stay latched true and the toolbar button would keep
  // reading as pressed with nothing on screen.
  //
  // And the panel is not the only thing that has to go (DEV-2571, Sentry
  // DEMOS-1P). The generated theme module is a real workspace file, and a
  // version switch on a dirty workspace deliberately *keeps* the files it finds
  // (ADR-0021 §6) — applying a theme is what dirtied it, so a themed demo takes
  // exactly that branch on the way down and arrives on a core where
  // `handsontable/themes` does not exist. The preview then fails to resolve the
  // module's own imports. Reset is already the operation that takes a theme back
  // out, restores the `themeName` and container class it displaced, and leaves
  // the module inert, so reuse it rather than inventing a second unwire.
  //
  // Nothing of the visitor's is lost: the theme *state* lives in localStorage
  // (`StylePanel`), and reopening the panel on a supported core reconciles it
  // straight back into the demo.
  //
  // `files` in the deps, not just `themingSupported`: a saved, shared or
  // imported workspace can *arrive* already themed on a sub-17 pin, with no
  // version change anywhere — a fix hanging off the version handler alone would
  // ship green and leave that path reporting.
  //
  // Declared above the runtime-mount effect on purpose. Effects run in
  // declaration order, so this write to `filesRef.current` lands before the
  // remount that a version change triggers reads it; below the mount effect the
  // broken module gets compiled once and only then repaired, which is the very
  // event this fixes.
  useEffect(() => {
    if (themingSupported) return;
    setStyleOpen(false);
    if (!hasWiredTheme(filesRef.current)) return;
    let next = filesRef.current;
    for (const change of buildResetChanges(next)) {
      next = { ...next, [change.path]: change.contents };
      // Covers a `files` change that moves no mount dependency. Safe to do
      // unconditionally: in both runtimes a non-quiet write supersedes any
      // quiet write still pending for the same path (`sandpack.ts` keeps one
      // authoritative `files` map; `container.ts` deletes the path from both
      // queues first), so the Style panel's unmount flush cannot push the
      // themed module back over this.
      runtimeRef.current?.writeFile(change.path, change.contents);
    }
    filesRef.current = next;
    setFiles(next);
    // Deliberately not `markDirty`: this is a repair of a workspace that cannot
    // run, not an edit the visitor made. Dirtying it would light up `Save •` on
    // a shared demo nobody has touched.
    setThemeRemoved(true);
  }, [themingSupported, files]);
  /** Edit info (`114:24410`), opened from the BOX INFO pencil. Replaces the two
   *  bare inputs T2 had to park in the authed action bar for want of a frame.
   *
   *  Seeded from `?edit=info`, which is what My Demos' **Rename** navigates to —
   *  without it Rename and Open would be the same link. Read once, at mount:
   *  after that the dialog is the user's to open and close. */
  const [editInfoOpen, setEditInfoOpen] = useState(
    () => route.mode === "edit" && new URLSearchParams(location.search).get("edit") === "info",
  );

  /** Close the dialog *and* drop `?edit=info`.
   *
   *  The param is a one-shot instruction from My Demos' Rename, not state. Left
   *  in the URL it outlives the thing it opened: a reload — or anything else
   *  that remounts — reopens the dialog the user already dismissed or saved, and
   *  the link is wrong if copied. `replaceState` so it doesn't add history. */
  const closeEditInfo = useCallback(() => {
    setEditInfoOpen(false);
    const url = new URL(location.href);
    if (url.searchParams.has("edit")) {
      url.searchParams.delete("edit");
      history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
  }, []);
  const docsPathRef = useRef<string | null>(docsPath);
  const dirtyRef = useRef(dirty);
  const sourceLoadedRef = useRef(sourceLoaded);
  const activeDocsBucketRef = useRef<string | null>(activeDocsBucket);
  const activeDocsManifestRef = useRef<DocsManifest | null>(activeDocsManifest);
  const docsRequestSeqRef = useRef(0);
  const starterRequestSeqRef = useRef(0);
  // Bucket the open starter workspace was fetched from; a version change
  // inside the same bucket only re-pins in place instead of refetching.
  const activeStarterBucketRef = useRef<string | null>(null);
  /** Read by the monitor relay only (DEV-2527). A ref, not a dependency of the mount
   *  effect: `savedId` appears the moment a demo is saved, and remounting the preview
   *  on save would throw away the running session the user just saved. */
  const savedIdRef = useRef<string | null>(null);
  docsPathRef.current = docsPath;
  dirtyRef.current = dirty;
  sourceLoadedRef.current = sourceLoaded;
  activeDocsBucketRef.current = activeDocsBucket;
  activeDocsManifestRef.current = activeDocsManifest;
  savedIdRef.current = savedId;

  /** Mark the workspace unsaved, and the named files with it.
   *
   *  Every mutation below goes through this rather than setting `dirty` alone, so the
   *  two can't drift — a dot that outlives its edit, or an edit with no dot, both read
   *  as bugs in the indicator rather than in the caller that forgot a line.
   *
   *  The no-paths call is still accepted — it means "unsaved, but no tab to dot" —
   *  but nothing uses it since DEV-2495: the Edit info dialog, its only caller, now
   *  writes its own PATCH instead of staging an edit for the workspace save. */
  const markDirty = useCallback((...touched: string[]) => {
    setDirty(true);
    dirtyRef.current = true;
    if (!touched.length) return;
    setDirtyPaths((prev) => {
      const next = new Set(prev);
      for (const p of touched) next.add(p);
      return next;
    });
  }, []);

  /** Saved or replaced — nothing is outstanding. */
  const clearDirty = useCallback(() => {
    setDirty(false);
    dirtyRef.current = false;
    setDirtyPaths((prev) => (prev.size ? new Set() : prev));
  }, []);

  /** Replace the whole workspace (entry + files + lineage) and remount. */
  /** One line naming what an import refused, or null when it took everything.
   *  Built here rather than in the Worker so the wording lives with the UI. */
  /** The single `Notice` slot in the preview bar (DEV-2173 owns its placement).
   *  Two facts can be true at once after a downgrade — the theme was removed,
   *  and the edits kept may not match the new version's API — and the theme
   *  leads because it reports a change to the visitor's files rather than a
   *  caveat about them (DEV-2571). */
  const versionNotice = useMemo(
    () => [themeRemoved ? THEME_REMOVED_NOTICE : null, versionWarning].filter(Boolean).join(" ") || null,
    [themeRemoved, versionWarning],
  );

  const importNotice = useMemo(() => {
    if (!importSkipped.length) return null;
    const shown = importSkipped.slice(0, 2).map((s) => `${s.path} (${s.reason})`);
    const rest = importSkipped.length - shown.length;
    return `Not imported: ${shown.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}.`;
  }, [importSkipped]);

  const loadWorkspace = useCallback(
    (nextEntry: CatalogEntry, nextFiles: FilesMap, lineage: string) => {
      // Whatever workspace replaces an ad-hoc one is no longer its, so its title
      // and its skipped-files notice are cleared here — at the moment the new
      // files are installed, which a failed starter or docs load never reaches.
      // Doing it in the pickers instead left a failed switch showing the previous
      // import's notice and minting Fork/Share names from its title.
      if (!isAdHocLineage(lineage)) {
        setImportPhase("idle");
        setImportedTitle(null);
        setImportSkipped([]);
      }
      filesRef.current = nextFiles; // ensure the mount effect reads the new files
      // A new workspace has not had anything taken out of it. Cleared here rather
      // than in each picker because every install lands here — starter, docs,
      // import, payload, saved demo — and the notice is about the files that just
      // went away with the old one (DEV-2571). A workspace that genuinely arrives
      // themed below the floor sets it again in the same pass: this batches with
      // `setFiles`, and the strip effect runs after both.
      setThemeRemoved(false);
      setEntry(nextEntry);
      setFramework(nextEntry.framework);
      setFiles(nextFiles);
      setForkedFrom(lineage);
      clearDirty();
      setErrorMessage(null);
      // Also what tells `EditorShell` to discard its open tabs: this counter is passed
      // down as `workspaceKey`, and it is the only truthful "this is a different
      // workspace now" signal the app has.
      setMountGen((g) => g + 1);
    },
    [clearDirty],
  );

  // `?import=<url>`: hand the URL to the Worker, which fetches the provider page
  // and returns a workspace (DEV-2504). Deliberately unsaved — the author reviews
  // the imported files and Saves deliberately, exactly as after a fork.
  useEffect(() => {
    if (!initialImport) return;
    let cancelled = false;
    (async () => {
      const token = getToken();
      try {
        const res = await fetch(`${API_BASE}/api/import`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ url: initialImport }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          framework?: string;
          files?: FilesMap;
          title?: string;
          provider?: string;
          skipped?: { path: string; reason: string }[];
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok || !body.files || !body.framework) {
          setImportPhase("failed");
          setStatus("error");
          setRetryable(false);
          // The status wins over `body.error`, and the order matters (DEV-2534):
          // `/api/import` answers an expired session with `{"error":
          // "unauthorized"}` (workers/api/src/index.ts:1019-1020), so while
          // `body.error` was consulted first the 401 arm below was unreachable
          // and the word "unauthorized" was the whole of what the user was told
          // — the same defect as the migrated callsites, one branch further out.
          // The copy stays "Sign in", not "Your session expired": `/` is
          // reachable signed out, so a 401 here is as likely to mean "never
          // signed in" as "signed in an hour ago".
          setErrorMessage(
            res.status === 401
              ? "Sign in to import a project."
              : (body.error ?? "Could not import that URL."),
          );
          return;
        }
        // The framework has to exist in this catalog or `getEntry` throws and the
        // whole route unmounts; the Worker resolves it from BUILD_CONFIG, so a
        // mismatch means the two drifted.
        let indexEntry;
        try {
          indexEntry = getEntry(body.framework);
        } catch {
          setImportPhase("failed");
          setStatus("error");
          setRetryable(false);
          setErrorMessage(`The import resolved to an unknown framework (${body.framework}).`);
          return;
        }
        // A starter fetch may already be in flight from the first render (the
        // playground's default framework). Bumping the sequence makes its
        // response a no-op, so it cannot land on top of the import.
        starterRequestSeqRef.current += 1;
        importStarterGenRef.current = starterGenRef.current;
        loadWorkspace(toPlaceholderEntry(indexEntry), { ...body.files }, `import:${body.provider ?? "url"}`);
        if (body.title) {
          setTitle(body.title);
          setImportedTitle(body.title);
        }
        setImportSkipped(body.skipped ?? []);
        setImportPhase("loaded");
        // Release the mount gate the starter path owns: nothing else will, now
        // that the starter fetch is skipped for an imported workspace.
        setSourceLoaded(true);
        sourceLoadedRef.current = true;
        activeStarterBucketRef.current = null;
        // Drop `?import=` once it has been consumed, so a reload does not re-run
        // an import the user may since have edited on top of.
        const url = new URL(location.href);
        url.searchParams.delete("import");
        history.replaceState(null, "", url.pathname + url.search);
      } catch (error) {
        if (cancelled) return;
        reportError(error, "import-url");
        setImportPhase("failed");
        setStatus("error");
        setRetryable(false);
        setErrorMessage("Could not import that URL.");
      }
    })();
    return () => { cancelled = true; };
  }, [initialImport, loadWorkspace]);

  // `?payload=<id>`: read back a project the Theme Builder posted to
  // `POST /api/payload` and open it as an unsaved workspace (DEV-2517). The same
  // shape as the import above, with three differences that come from the route:
  // it is a public GET so no token is sent, the record carries no `provider` and
  // no `skipped[]`, and a miss is the case worth wording well — the record lives
  // 24 hours, so the failure users will actually hit is an expired link.
  useEffect(() => {
    if (!initialPayload) return;
    let cancelled = false;
    /** Take `?payload=` out of the URL. Called on success and on the two *permanent*
     *  failures, never on a transient one.
     *
     *  Bugbot: leaving it there after an expiry outlives the error card. The visitor
     *  picks a starter, the URL-sync effect copies `location.search` forward with the
     *  dead id still in it, and the next reload throws away the starter to show the
     *  expiry again — a link that can never work holding the page hostage. A 500 or a
     *  dropped connection is the opposite case: the record may well be alive, so the
     *  param stays and a reload retries. */
    const dropPayloadParam = () => {
      const url = new URL(location.href);
      url.searchParams.delete("payload");
      history.replaceState(null, "", url.pathname + url.search);
    };
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/payload/${encodeURIComponent(initialPayload)}`);
        const body = (await res.json().catch(() => ({}))) as {
          framework?: string;
          files?: FilesMap;
          title?: string;
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok || !body.files || !body.framework) {
          setImportPhase("failed");
          setStatus("error");
          setRetryable(false);
          // 404 is read as expired rather than as "no such id": KV cannot tell an
          // expired key from one that never existed, and the only thing that mints
          // these ids is the Theme Builder, seconds before the visit. The server's
          // own `error` is not shown here for the same reason — it says "not found".
          if (res.status === 404) {
            setErrorMessage(
              "This playground link has expired — generate a new one from the Theme Builder.",
            );
            dropPayloadParam();
          } else {
            setErrorMessage(body.error ?? "Could not open that playground link.");
          }
          return;
        }
        // Same guard as the import path: the Worker resolves the framework against
        // BUILD_CONFIG and this app against its catalog, so a mismatch means the
        // two drifted — and `getEntry` throwing here would unmount the route.
        let indexEntry;
        try {
          indexEntry = getEntry(body.framework);
        } catch {
          setImportPhase("failed");
          setStatus("error");
          setRetryable(false);
          setErrorMessage(`That link resolved to an unknown framework (${body.framework}).`);
          // Permanent too: the record is intact and we still cannot open it.
          dropPayloadParam();
          return;
        }
        // Both halves of the starter-load gate, as in the import effect: the
        // sequence bump neutralizes a fetch already in flight from the first
        // render, and the generation is what keeps the gate shut afterwards until
        // the user picks a starter themselves.
        starterRequestSeqRef.current += 1;
        importStarterGenRef.current = starterGenRef.current;
        loadWorkspace(toPlaceholderEntry(indexEntry), { ...body.files }, "payload:theme-builder");
        if (body.title) {
          setTitle(body.title);
          setImportedTitle(body.title);
        }
        // Nothing is dropped on this route — a payload that carries a file we
        // cannot accept is refused whole — so there is never a notice to show.
        setImportSkipped([]);
        setImportPhase("loaded");
        // Release the mount gate the starter path owns; the starter fetch is
        // skipped for this workspace, so nothing else will.
        setSourceLoaded(true);
        sourceLoadedRef.current = true;
        activeStarterBucketRef.current = null;
        // Consumed, so a reload does not reinstall the Theme Builder's files over
        // the edits made since.
        dropPayloadParam();
      } catch (error) {
        if (cancelled) return;
        reportError(error, "payload-boot");
        setImportPhase("failed");
        setStatus("error");
        setRetryable(false);
        setErrorMessage("Could not open that playground link.");
      }
    })();
    return () => { cancelled = true; };
  }, [initialPayload, loadWorkspace]);

  // Edit/share mode: load the saved demo's source + metadata into the workspace.
  useEffect(() => {
    if (!savedId) return;
    let cancelled = false;
    (async () => {
      const token = getToken();
      const headers: Record<string, string> = !isShare && token ? { Authorization: `Bearer ${token}` } : {};
      try {
        const [srcRes, metaRes] = await Promise.all([
          fetch(`${API_BASE}/api/demos/${savedId}/source`, { headers }),
          // `no-store` for the same reason `FullMode` uses it (DEV-2495): the
          // metadata endpoint is cached for a minute in the browser, and this is
          // the page you land on straight after renaming the demo.
          fetch(`${API_BASE}/api/demos/${savedId}`, { cache: "no-store" }),
        ]);
        if (cancelled) return;
        if (!srcRes.ok) {
          setErrorMessage(
            !isShare && srcRes.status === 401 ? "Please sign in to edit this demo." : "This demo is unavailable.",
          );
          setSourceLoaded(true);
          return;
        }
        const src = (await srcRes.json()) as {
          framework: string;
          files: FilesMap;
          /** The row's ref when the validator accepts it, else the one the snapshot
           *  itself pins — see `editorVersionRef` (DEV-2565). Preferred over
           *  `meta.ht_version` because demos saved before that fix hold the "latest"
           *  sentinel there, and adopting it as version state is a boot refusal. */
          htVersion?: string | null;
        };
        // Read outside the metadata branch on purpose: the version rides on the
        // snapshot now, so a transient metadata failure must not cost the demo its
        // pin — the editor would resolve latest and the next Save would re-pin the
        // demo to it.
        //
        // Presence, not truthiness: the route answers `null` for a legacy row whose
        // snapshot pins nothing exact, and *that* is the answer — falling back to
        // `meta.ht_version` there would adopt the "latest" sentinel and reproduce
        // the boot refusal this branch removes (DEV-2565).
        let pinnedVersion: string | null | undefined =
          "htVersion" in src ? src.htVersion : undefined;
        if (metaRes.ok) {
          const meta = (await metaRes.json()) as {
            title: string;
            description: string | null;
            ht_version: string;
            created_at: string | null;
          };
          setTitle(meta.title ?? "");
          setDescription(meta.description ?? "");
          setCreatedAt(meta.created_at ?? "");
          // The column is the fallback only for an API old enough not to send the
          // field at all.
          if (pinnedVersion === undefined) pinnedVersion = meta.ht_version;
        }
        if (pinnedVersion) {
          hadUrlVersion.current = true; // keep the demo's pinned version, don't override with latest
          setVersion(pinnedVersion);
        }
        loadWorkspace(toPlaceholderEntry(getEntry(src.framework)), src.files, savedId);
        setSourceLoaded(true);
      } catch (error) {
        // A share/edit link that no longer resolves: missing D1 row, unreadable R2
        // snapshot, or a framework the catalog no longer has.
        reportError(error, "saved-demo-load");
        if (!cancelled) { setErrorMessage("This demo is unavailable."); setSourceLoaded(true); }
      }
    })();
    return () => { cancelled = true; };
  }, [savedId, isShare, loadWorkspace]);

  // One anonymous page view per mount (the editor is a single-page app, so
  // this is its equivalent of a page load).
  useEffect(() => { beacon(location.pathname); }, []);

  // Cost guardrail state. Cheap (KV-cached server side) and read once per page
  // load: the tier only moves on the scale of hours. Failures are silent — an
  // unreachable budget endpoint must never put a warning in front of a user.
  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/budget`)
      .then((r) => (r.ok ? r.json() : null))
      .then((state: { notice?: string | null } | null) => {
        if (!cancelled && state?.notice) setBudgetNotice(state.notice);
      })
      .catch(() => { /* no notice is the right fallback */ });
    return () => { cancelled = true; };
  }, []);

  // Load real published versions from the API (npm-backed); default to latest
  // unless a version was deep-linked (or pinned by the demo being edited/shared).
  useEffect(() => {
    let cancelled = false;
    fetchVersions(API_BASE)
      .then(({ latest, next, versions }) => {
        if (cancelled) return;
        setNextVersion(next ?? "");
        const opts = [...new Set([latest, ...versions, next].filter((v): v is string => !!v))];
        if (opts.length) setVersionOptions(opts);
        if (latest && !hadUrlVersion.current) {
          setVersion((cur) => (cur === DEFAULT_VERSION ? latest : cur));
        }
        setVersionsResolved(true);
      })
      .catch((error) => {
        // Fails open onto the hardcoded VERSION_OPTIONS, so the picker silently
        // goes stale rather than breaking — worth knowing about.
        reportError(error, "versions-fetch");
        if (!cancelled) setVersionsResolved(true); // release buckets can still resolve without dist-tags.next
      });
    return () => { cancelled = true; };
  }, []);

  // A next-dist-tag version (0.0.0-next-<hash>-<date>) that doesn't match the
  // currently published next build may just be a docs/staging build's own
  // commit stamp — never published, so npm can't install it. Fall back to the
  // published next build and say so, rather than failing the container boot.
  // `versionCheckPending` holds the runtime-mount effect off the doomed
  // version while this resolves (see its use below) — otherwise a container
  // boot (or Sandpack fetch) can fire and fail before the fallback lands.
  const [versionCheckPending, setVersionCheckPending] = useState(false);
  useEffect(() => {
    if (!versionsResolved || !nextVersion) return;
    if (!isNextPrereleaseVersion(version) || version === nextVersion) {
      setVersionCheckPending(false);
      return;
    }
    let cancelled = false;
    const requested = version;
    setVersionCheckPending(true);
    checkVersionExists(API_BASE, requested).then((exists) => {
      if (cancelled) return;
      setVersionCheckPending(false);
      if (exists) return;
      setVersion(nextVersion);
      setVersionWarning(
        `Handsontable ${requested} isn't a published build; showing the latest next build (${nextVersion}) instead.`,
      );
    });
    return () => { cancelled = true; };
  }, [version, nextVersion, versionsResolved]);
  // True while a next-format version's real availability is still unknown:
  // either /api/versions hasn't resolved yet, or the exists-check above is
  // in flight. Blocks the runtime-mount effect until it's settled.
  const versionPending = isNextPrereleaseVersion(version) && (!versionsResolved || versionCheckPending);

  // A manifest fetch is the existence check for a derived bucket. Resolve it on
  // startup and every selected-version change, then swap or preserve an open
  // docs workspace according to its dirty state.
  useEffect(() => {
    if (route.mode === "share" || !versionsResolved) return;
    const requestSeq = ++docsRequestSeqRef.current;
    const openPath = docsPathRef.current;
    const initialLoad = !!initialDocs && !sourceLoadedRef.current;
    const candidate = deriveDocsBucketCandidate(version, nextVersion);

    setDocsItems([]);
    setActiveDocsBucket(null);
    setActiveDocsManifest(null);
    activeDocsBucketRef.current = null;
    activeDocsManifestRef.current = null;
    if (openPath) {
      setDocsRuntimeBlocked(true);
      setStatus("booting");
      setErrorMessage(null);
    }

    const failOpenDocs = (kind: "bucket" | "path" | "fetch") => {
      if (docsRequestSeqRef.current !== requestSeq) return;
      if (initialLoad) {
        setDocsNotFoundTransient(kind === "fetch");
        setDocsNotFound(true);
        setSourceLoaded(true);
        sourceLoadedRef.current = true;
        return;
      }
      if (!openPath) return;
      const message = kind === "bucket"
        ? `No documentation examples are available for Handsontable ${version}. Choose another version or a starter.`
        : kind === "path"
          ? `This documentation example is unavailable for Handsontable ${version}. Choose another version or a starter.`
          : `Could not load documentation examples for Handsontable ${version}. Try another version.`;
      setStatus("error");
      setErrorMessage(message);
      setDocsRuntimeBlocked(true);
    };

    if (!candidate) {
      failOpenDocs("bucket");
      return;
    }

    let cancelled = false;
    void fetchDocsManifest(candidate)
      .then(async (manifest) => {
        if (cancelled || docsRequestSeqRef.current !== requestSeq) return;
        setDocsItems(manifest.examples);
        setActiveDocsBucket(candidate);
        setActiveDocsManifest(manifest);
        activeDocsBucketRef.current = candidate;
        activeDocsManifestRef.current = manifest;
        if (!openPath) return;
        if (!manifest.examples.some((item) => item.docsPath === openPath)) {
          failOpenDocs("path");
          return;
        }

        if (dirtyRef.current) {
          const pinned = pinHandsontableFiles(filesRef.current, version);
          filesRef.current = pinned;
          setFiles(pinned);
          setVersionWarning(
            "This example has unsaved edits; its content may not match the selected version API.",
          );
          setErrorMessage(null);
          setDocsRuntimeBlocked(false);
          return;
        }

        try {
          const docsEntry = await loadDocsExample(candidate, openPath);
          if (cancelled || docsRequestSeqRef.current !== requestSeq) return;
          const nextFiles = manifest.hotVersion === version
            ? { ...docsEntry.files }
            : pinHandsontableFiles({ ...docsEntry.files }, version);
          loadWorkspace(docsEntry, nextFiles, `docs:${candidate}:${openPath}`);
          setDocsPath(openPath);
          docsPathRef.current = openPath;
          setVersionWarning(null);
          setDocsRuntimeBlocked(false);
          setSourceLoaded(true);
          sourceLoadedRef.current = true;
        } catch (error) {
          // The DEV-2130 class: a docs page links an example the runner can't
          // open. Tagged by which step failed so a missing artifact (docs linking
          // an example that was never imported) is distinguishable from a
          // transient fetch.
          reportError(error, `docs-example-load:${isMissingDocsResource(error) ? "path" : "fetch"}`);
          failOpenDocs(isMissingDocsResource(error) ? "path" : "fetch");
        }
      })
      .catch((error) => {
        reportError(error, `docs-bucket-resolve:${isMissingDocsResource(error) ? "bucket" : "fetch"}`);
        failOpenDocs(isMissingDocsResource(error) ? "bucket" : "fetch");
      });
    return () => { cancelled = true; };
  }, [initialDocs, loadWorkspace, nextVersion, route.mode, version, versionsResolved]);

  // Starter artifacts are lazy-fetched per version bucket (DEV-2213). Fetch on
  // starter select and on bucket-crossing version changes; a same-bucket
  // version change only re-pins the open files, preserving edits (the old
  // single-catalog behaviour). Below-floor majors, versions with no bucket,
  // and artifact fetch failures share one refusal — deliberately the same
  // message the mount guard uses.
  useEffect(() => {
    if (route.mode === "share" || savedId || docsPath) return;
    // An ad-hoc workspace — an import or a payload — owns its files the way a
    // saved demo does (`savedId` above) — but only until the user asks for a
    // starter, and *that* distinction is what two review rounds went around:
    //
    //  - gate on "loading" only, and the effect re-runs on the `framework` the
    //    import just set; `activeStarterBucketRef` is null and `loadWorkspace`
    //    cleared dirty, so both inner branches fall through to the fetch and a
    //    catalog starter replaces the import.
    //  - gate on "loaded" forever, and picking a starter can never fetch again.
    //  - release the gate inside `selectExample`/`selectDocs`, and a switch that
    //    *fails* leaves the import open with its protection already dropped.
    //
    // `starterGen` separates them: only `selectExample` bumps it, so an unchanged
    // generation means this run is the import's own re-render (or a version
    // change, which the re-pin effect below handles), and a bumped one means the
    // user picked something. Nothing has to be cleared early for it to hold.
    if (importPhase === "loading") return;
    // "failed" is gated the same way as "loaded" (DEV-2517). A boot that failed has
    // put an error card up explaining why; letting the default starter land wipes
    // it — `loadWorkspace` clears `errorMessage` — so the visitor is left in a
    // react starter they never asked for, with no trace of what went wrong. For an
    // expired payload link, that message *is* the whole answer.
    //
    // `importStarterGenRef` is deliberately not touched on the failure paths: it
    // still holds its mount value, so the gate is shut exactly while the user has
    // picked nothing, and a starter they chose while the boot was in flight still
    // lands on top of the card.
    //
    // Bugbot: that last part is why `importPhase` is in this effect's dependency
    // list. A pick made while the request is in flight returns early on "loading",
    // and without the dependency nothing re-runs when the phase becomes "failed" —
    // it only looked like it worked because `/api/versions` happening to resolve
    // afterwards re-ran the effect for its own reasons.
    if (
      (importPhase === "loaded" || importPhase === "failed")
      && starterGen === importStarterGenRef.current
    ) return;
    // Only next-format versions need nextVersion to resolve a bucket; plain
    // releases are not held on /api/versions.
    if (isNextPrereleaseVersion(version) && !versionsResolved) return;
    const requestSeq = ++starterRequestSeqRef.current;
    const v = validateHandsontableVersion(version);
    if (!v.ok) {
      // The mount guard owns the invalid-version message — but it is gated on
      // sourceLoaded, so release the gate or a deep-linked bad version shows
      // an eternal boot spinner instead of the refusal.
      setSourceLoaded(true);
      sourceLoadedRef.current = true;
      return;
    }

    const indexEntry = getEntry(framework);
    const requestedMajor = selectedReleaseMajor(v.value.ref);
    // pkg.pr.new refs are current-dev builds — they read the next bucket.
    const bucket = v.value.pkgPrNew
      ? "next"
      : resolveStarterBucket({
          selectedVersion: v.value.ref,
          nextVersion,
          bucketKeys: catalog.buckets,
        });
    const belowFloor =
      indexEntry.minCoreMajor != null &&
      requestedMajor != null &&
      requestedMajor < indexEntry.minCoreMajor;

    const refuseStarter = () => {
      if (starterRequestSeqRef.current !== requestSeq) return;
      setStarterRuntimeBlocked(true);
      setStatus("error");
      setErrorMessage(
        `Could not load this example for Handsontable ${version}. Try another version.`,
      );
      setRetryable(false);
      // Release the mount gate so the error card renders instead of a spinner.
      setSourceLoaded(true);
      sourceLoadedRef.current = true;
    };

    if (bucket == null || belowFloor) {
      refuseStarter();
      return;
    }

    if (sourceLoadedRef.current && entry.framework === framework) {
      // Same bucket: re-pin the open workspace in place.
      if (activeStarterBucketRef.current === bucket) {
        const pinned = pinHandsontableFiles(filesRef.current, version);
        filesRef.current = pinned;
        setFiles(pinned);
        return;
      }
      // Crossing buckets with unsaved edits: keep the edited files (re-pinned)
      // rather than discarding work for a snapshot swap — the docs behaviour.
      if (dirtyRef.current) {
        const pinned = pinHandsontableFiles(filesRef.current, version);
        filesRef.current = pinned;
        setFiles(pinned);
        setVersionWarning(
          "This example has unsaved edits; its content may not match the selected version API.",
        );
        return;
      }
    }

    let cancelled = false;
    void loadStarterExample(bucket, framework)
      .then((starter) => {
        if (cancelled || starterRequestSeqRef.current !== requestSeq) return;
        const nextFiles = starter.htCoreRange === v.value.ref
          ? { ...starter.files }
          : pinHandsontableFiles({ ...starter.files }, version);
        activeStarterBucketRef.current = bucket;
        setStarterRuntimeBlocked(false);
        loadWorkspace(starter, nextFiles, `catalog:${framework}`);
        setVersionWarning(null);
        setSourceLoaded(true);
        sourceLoadedRef.current = true;
      })
      .catch((error) => {
        // A bucket that exists but lacks this framework (deep link below an
        // old major's floor) or a transient fetch failure.
        reportError(error, "starter-load");
        refuseStarter();
      });
    return () => { cancelled = true; };
  }, [
    framework,
    starterGen,
    importPhase,
    version,
    nextVersion,
    versionsResolved,
    docsPath,
    savedId,
    route.mode,
    entry.framework,
    loadWorkspace,
  ]);

  // A version change on an ad-hoc workspace — an import or a payload — re-pins
  // its Handsontable dependencies in place. The starter effect is gated off while
  // one is open, so without this the version picker would move the label and
  // change nothing in the files.
  useEffect(() => {
    if (importPhase !== "loaded") return;
    const pinned = pinHandsontableFiles(filesRef.current, version);
    filesRef.current = pinned;
    setFiles(pinned);
  }, [importPhase, version]);

  // Keep the URL in sync with the selected example + version — playground only
  // (edit/share have their own /edit/:id, /share/:id paths). Docs examples use
  // `?docs=<content-path>`; starters use `?example=<framework>`.
  useEffect(() => {
    if (route.mode !== "play") return;
    const p = new URLSearchParams(location.search);
    if (docsPath) {
      p.set("docs", docsPath);
      p.delete("example");
    } else {
      p.set("example", framework);
      p.delete("docs");
    }
    p.set("v", version);
    history.replaceState(null, "", `${location.pathname}?${p.toString()}`);
  }, [framework, docsPath, version, route.mode]);

  /** Pick a catalog starter template as a fresh starting template (playground).
   *  Only points the starter-load effect at the framework; the effect resolves
   *  the bucket and fetches the artifact. Dropping `sourceLoaded` is what makes
   *  the reload pristine — with it down, the effect takes the fetch path even
   *  for the already-open framework instead of re-pinning edited files. */
  const selectExample = useCallback(
    (fw: string) => {
      docsRequestSeqRef.current += 1;
      setDocsPath(null);
      docsPathRef.current = null;
      setDocsRuntimeBlocked(false);
      setVersionWarning(null);
      setStatus("booting");
      setErrorMessage(null);
      setSourceLoaded(false);
      sourceLoadedRef.current = false;
      activeStarterBucketRef.current = null;
      setFramework(fw);
      starterGenRef.current += 1;
      setStarterGen(starterGenRef.current);
    },
    [],
  );

  /** Open a documentation-guide example (lazy-loaded by its docs content path). */
  const selectDocs = useCallback(
    async (dp: string) => {
      const bucket = activeDocsBucketRef.current;
      const manifest = activeDocsManifestRef.current;
      if (!bucket || !manifest || !manifest.examples.some((item) => item.docsPath === dp)) {
        setErrorMessage(`Could not load docs example: ${dp}`);
        return;
      }
      const requestSeq = ++docsRequestSeqRef.current;
      setDocsRuntimeBlocked(true);
      setStatus("booting");
      setErrorMessage(null);
      try {
        const e = await loadDocsExample(bucket, dp);
        if (docsRequestSeqRef.current !== requestSeq || activeDocsBucketRef.current !== bucket) return;
        const nextFiles = manifest.hotVersion === version
          ? { ...e.files }
          : pinHandsontableFiles({ ...e.files }, version);
        setDocsPath(dp);
        docsPathRef.current = dp;
        loadWorkspace(e, nextFiles, `docs:${bucket}:${dp}`);
        setVersionWarning(null);
        setDocsRuntimeBlocked(false);
      } catch (error) {
        reportError(error, "docs-example-switch");
        // Unlike the deep-link (`?docs=`) load path, a working workspace is already
        // open here, so a toolbar note is enough — no full-screen not-found takeover.
        if (docsRequestSeqRef.current === requestSeq) {
          setStatus("error");
          setErrorMessage(`Could not load docs example: ${dp}`);
          setDocsRuntimeBlocked(true);
        }
      }
    },
    [loadWorkspace, version],
  );

  const changeVersion = useCallback((next: string) => {
    docsRequestSeqRef.current += 1;
    setVersionWarning(null);
    setThemeRemoved(false);
    if (docsPathRef.current) {
      setDocsItems([]);
      setActiveDocsBucket(null);
      setActiveDocsManifest(null);
      activeDocsBucketRef.current = null;
      activeDocsManifestRef.current = null;
      setDocsRuntimeBlocked(true);
      setStatus("booting");
      setErrorMessage(null);
    }
    setVersion(next);
  }, []);

  // Dispose and visibly clear a preview while its target bucket/artifact is
  // unresolved or unavailable — docs or starter alike. The version picker and
  // editor remain usable.
  useEffect(() => {
    if (!iframeEl || !(docsRuntimeBlocked || (!docsPath && starterRuntimeBlocked))) return;
    runtimeRef.current?.dispose();
    runtimeRef.current = null;
    iframeEl.removeAttribute("srcdoc");
    iframeEl.src = "about:blank";
  }, [iframeEl, docsRuntimeBlocked, docsPath, starterRuntimeBlocked]);

  useEffect(() => {
    if (!iframeEl || !sourceLoaded || docsNotFound || docsRuntimeBlocked) return;
    if (!docsPath && starterRuntimeBlocked) return;
    if (versionPending) {
      // The previous run's cleanup (below) already disposed its runtime; put
      // the status back to booting so the UI doesn't keep showing "Live" (or
      // a stale error) over a torn-down preview while the version resolves.
      setStatus("booting");
      setErrorMessage(null);
      setBootLog("");
      return;
    }
    setErrorMessage(null);
    const v = validateHandsontableVersion(version);
    if (!v.ok) {
      setStatus("error");
      setErrorMessage(v.message);
      setRetryable(false);
      return;
    }
    // Per-starter floor: these starters were authored against a core API that
    // older majors lack, so booting them there produces a broken (or blank)
    // grid. Refuse rather than boot. `selectedReleaseMajor` (shared with the
    // version picker) returns null for next/pkg.pr.new refs, which bypass it.
    const requestedMajor = selectedReleaseMajor(v.value.ref);
    if (
      !docsPath &&
      entry.minCoreMajor != null &&
      requestedMajor != null &&
      requestedMajor < entry.minCoreMajor
    ) {
      setStatus("error");
      setErrorMessage(
        `Could not load this example for Handsontable ${version}. Try another version.`,
      );
      setRetryable(false);
      return;
    }
    setRetryable(true);
    setStatus("booting");
    setBootLog("");
    setSyncing(false);
    // A remount supersedes any refresh. Bump the sequence as well as clearing the flag,
    // so the superseded promise's own settle can't turn the spinner back off later.
    refreshSeqRef.current += 1;
    setRefreshing(false);
    containerModeRef.current = entry.engine === "container";
    let cancelled = false;
    const runtime =
      entry.engine === "container"
        ? new ContainerRuntime(entry, {
            iframe: iframeEl,
            apiBase: API_BASE,
            version: v.value,
            // Identifies the caller to the cost guardrail: at >=80% of the
            // monthly budget live sessions are signed-in-only (DEV-2030).
            authToken: getToken(),
            monitor: monitorDemos,
          })
        : new SandpackRuntime(entry, {
            iframe: iframeEl,
            bundlerURL: SANDPACK_BUNDLER_URL,
            version: v.value,
            monitor: monitorDemos,
          });
    // Resolved per event: the demo id can be minted (first save) while this very
    // preview is running, and the ref is how that reaches an already-wired relay.
    const demoContext = () => ({
      tier: (entry.engine === "container" ? 2 : 1) as 1 | 2,
      framework: entry.framework,
      demoId: savedIdRef.current,
    });
    if (entry.engine === "container") {
      (runtime as ContainerRuntime).onProgress((log) => !cancelled && setBootLog(log));
      // Post-boot dev-server faults (DEV-2527). Not gated on `cancelled`: a dev
      // server that logged an error still logged it, and an unmount is often the
      // user giving up on exactly that — the same reasoning as the mount catch below.
      (runtime as ContainerRuntime).onStderr((message) =>
        reportDemoEvent({ type: "hot-runner-monitor", kind: "stderr", message }, demoContext()),
      );
    }
    // The preview relays what it sees from inside the iframe (DEV-2527). Sender
    // identity is `event.source`, not the origin string: Tier 1 runs on Sandpack's
    // bundler host (a CodeSandbox default we do not configure) and Tier 2 on a
    // per-session wildcard subdomain, so there is no origin to match against — but
    // there is exactly one window we are willing to hear from.
    const onPreviewMessage = (event: MessageEvent) => {
      if (cancelled || event.source !== iframeEl.contentWindow) return;
      if (!isMonitorPayload(event.data)) return;
      reportDemoEvent(event.data, demoContext());
    };
    if (monitorDemos) window.addEventListener("message", onPreviewMessage);
    runtime.onReady(() => !cancelled && setStatus("ready"));
    runtime.onError((e) => {
      if (cancelled) return;
      setStatus("error");
      setErrorMessage(describeRuntimeError(e, entry.engine, v.value.ref));
      reportRuntimeError(e, entry.engine, entry.framework);
    });
    runtimeRef.current = runtime;
    setPreviewUrl("");
    runtime
      .mount(filesRef.current)
      .then(({ previewUrl: url }) => {
        // Container only. Tier 1 hands back whatever `iframe.src` happens to be
        // at mount time, which is Sandpack's *bundler* origin — not an address
        // the user could act on, and a CodeSandbox mark we don't surface
        // (ADR-0001, white-label). The row-2 field falls back instead.
        const own = entry.engine === "container" && /^https?:\/\//.test(url);
        if (!cancelled) setPreviewUrl(own ? url : "");
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setStatus("error");
          setErrorMessage(describeRuntimeError(e, entry.engine, v.value.ref));
        }
        // Reported even when cancelled: a session the pool refused still failed,
        // and the unmount that set `cancelled` is often the user giving up on it.
        reportRuntimeError(e, entry.engine, entry.framework);
      });
    return () => {
      cancelled = true;
      window.removeEventListener("message", onPreviewMessage);
      runtime.dispose();
      if (runtimeRef.current === runtime) runtimeRef.current = null;
    };
    // mountGen forces a remount when files are replaced (example switch or fork/edit load);
    // retryGen when the user asks for one from the error card.
  }, [iframeEl, entry, version, mountGen, retryGen, sourceLoaded, docsNotFound, docsRuntimeBlocked, starterRuntimeBlocked, versionPending, docsPath]);

  /** "Restart preview" — mount a fresh runtime from the current (edited) sources.
   *
   *  The way out of a failure the code has already outlived. Tier 1 recovers on its own
   *  now (the bundler's next clean compile re-emits ready), but Tier 2 cannot: a boot
   *  failure exits the container's dev server, and streaming the fixed file into a
   *  container with no dev server changes nothing. Only a new session re-runs it. */
  const retryPreview = useCallback(() => {
    // The Tier-1 compiler loader stops retrying after two failed fetches (DEV-2569) so a
    // stranded tab cannot burn 3 MB per keystroke. This is the one thing that lifts that:
    // an explicit request buys one more pair of attempts, so a visitor whose network came
    // back recovers without reloading and losing unsaved edits. A rotated-out chunk fails
    // again at once, which is what leaves the reload as the only cure for that case.
    rearmCompilerLoad();
    setStatus("booting");
    setErrorMessage(null);
    setBootLog("");
    setRetryGen((g) => g + 1);
  }, []);

  /** Container frameworks rebuild server-side (a few seconds); show feedback. */
  const showSyncing = useCallback(() => {
    if (!containerModeRef.current) return;
    setSyncing(true);
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => setSyncing(false), 4000);
  }, []);

  // `opts` is passed straight through to the runtime (`{ quiet: true }` for an edit
  // whose effect is already on screen — see StylePanel's live theme patch). The
  // workspace itself is updated the same way regardless: `filesRef` is what Save,
  // Download, Share and the next example switch read, so nothing may ever sit
  // between an edit and this assignment.
  const onEdit = useCallback(
    (path: string, contents: string, opts?: WriteFileOptions) => {
      const next = { ...filesRef.current, [path]: contents };
      filesRef.current = next;
      setFiles(next);
      markDirty(path);
      try {
        runtimeRef.current?.writeFile(path, contents, opts);
      } catch {
        /* not mounted */
      }
      // A quiet write reaches no dev server yet, so there is nothing to wait for. The
      // rebuild it is eventually flushed by reports its own progress (`flushQuietEdits`).
      if (opts?.quiet) return;
      showSyncing();
    },
    [markDirty, showSyncing],
  );

  /** Send a message into the running preview (DEV-2496: the Style panel's live theme
   *  patch). Cross-origin on both tiers — the bundler's origin for Tier 1, the
   *  container's for Tier 2 — which postMessage is fine with. */
  const postToPreview = useCallback((message: unknown) => {
    iframeEl?.contentWindow?.postMessage(message, "*");
  }, [iframeEl]);

  /** The other direction. Filtered by `event.source`, never by origin: the origin
   *  differs per tier and per session, but "did this come from the preview frame"
   *  is exactly the question being asked. */
  const onPreviewMessage = useCallback((cb: (data: unknown) => void) => {
    const listener = (event: MessageEvent) => {
      if (!iframeEl || event.source !== iframeEl.contentWindow) return;
      cb(event.data);
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [iframeEl]);

  /**
   * Carry the shell's colour scheme into the preview (DEV-2561, ADR-0035).
   *
   * Which demos the shell may decide for is settled *here*, not inside the
   * receiver: from within the frame, "the runner pinned this starter to light" and
   * "this demo deliberately declares light" are the same two words. Out here both
   * facts are in hand.
   *
   * `auto` is the stand-down signal — the receiver drops its override and whatever
   * the demo declares takes effect. Sent for a docs example (eight of the theming
   * guide's own examples ship an `ht-theme-*-dark` class they exist to
   * demonstrate) and from the moment the Style panel has written a theme module,
   * whose `colorScheme` is then the demo's own declaration.
   */
  const shellSchemeMode: SchemeMode = useMemo(() => {
    if (docsPath) return "auto";
    // Path presence, which latches this on `auto` forever after a Reset: the
    // module stays behind as an inert `customTheme = undefined`. `hasWiredTheme`
    // is the predicate that answers this correctly, and swapping it in is *not*
    // enough on its own — the shell then sends its mode again and the override
    // still does not come back, so there is a second cause in the bridge. Left
    // as found rather than half-fixed; needs its own ticket and its own test
    // (measured under DEV-2571, e2e/preview-scheme.spec.ts).
    const wired = Object.keys(files).some((path) => path.includes(THEME_MODULE_BASENAME));
    return wired ? "auto" : themeMode;
  }, [docsPath, files, themeMode]);

  /** Re-sent on every `ready`, not only on change: the iframe is replaced on each
   *  rebuild and the fresh document starts with no override at all. */
  useEffect(() => {
    if (!iframeEl) return;
    const send = () => postToPreview({ source: SCHEME_MESSAGE_TYPE, mode: shellSchemeMode });
    send();
    return onPreviewMessage((data) => {
      if (isSchemeReady(data)) send();
    });
  }, [iframeEl, onPreviewMessage, postToPreview, shellSchemeMode]);

  /** Push whatever a `{ quiet: true }` write left pending — the Style panel's fallback
   *  when a live patch did not land, and how a theme change that *must* rebuild (first
   *  apply, a preset swap) reaches the preview.
   *
   *  Which is why this reports progress the same way an ordinary edit does: on Tier 2
   *  that rebuild is a container round trip of several seconds, and it used to say so
   *  when theme edits went out as ordinary writes. */
  const flushQuietEdits = useCallback(() => {
    try {
      runtimeRef.current?.flushQuiet?.();
      showSyncing();
    } catch {
      /* not mounted */
    }
  }, [showSyncing]);

  // ---- File-tree CRUD (CodeSandbox-style). Edits the in-memory workspace and
  // the live preview; only Save (edit mode, owner) persists them. ----
  const addFile = useCallback(
    (path: string) => {
      if (filesRef.current[path] !== undefined) return;
      const next = { ...filesRef.current, [path]: "" };
      filesRef.current = next;
      setFiles(next);
      markDirty(path);
      try { runtimeRef.current?.writeFile(path, ""); } catch { /* not mounted */ }
    },
    [markDirty],
  );

  /** One drag & drop (DEV-2500), committed as a single change.
   *
   *  Not `addFile` in a loop: that would be one `setFiles` per file — and on a
   *  Tier-2 framework one dev-server rebuild per file, each invalidating the
   *  last. One state commit, one dirty-set update, then stream the files.
   *
   *  The map math lives in `addFiles.ts` under `pipeline/add-files.test.mjs`,
   *  which also greps this function: one `setFiles`, one ref commit, through
   *  `applyDroppedFiles`. Keep it that shape. */
  const addFiles = useCallback(
    (dropped: { path: string; contents: string }[]) => {
      const next = applyDroppedFiles(filesRef.current, dropped);
      // Reference-equal means an empty drop: nothing to commit, render or push.
      if (next === filesRef.current) return;
      filesRef.current = next;
      setFiles(next);
      // Variadic on purpose (see its definition): one call dots every dropped tab.
      markDirty(...dropped.map((file) => file.path));
      for (const { path, contents } of dropped) {
        try { runtimeRef.current?.writeFile(path, contents); } catch { /* not mounted */ }
      }
      // Container frameworks rebuild server-side; same feedback an edit gets.
      if (containerModeRef.current) {
        setSyncing(true);
        if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
        syncTimerRef.current = setTimeout(() => setSyncing(false), 4000);
      }
    },
    [markDirty],
  );

  const deleteFile = useCallback(
    (path: string) => {
      if (filesRef.current[path] === undefined) return;
      const next = { ...filesRef.current };
      delete next[path];
      filesRef.current = next;
      setFiles(next);
      // The workspace stays dirty — a deletion is unsaved work — but the *path* stops
      // being dirty, because there is no longer a file or a tab to dot.
      markDirty();
      setDirtyPaths((prev) => {
        if (!prev.has(path)) return prev;
        const rest = new Set(prev);
        rest.delete(path);
        return rest;
      });
      try { runtimeRef.current?.deleteFile?.(path); } catch { /* not mounted */ }
    },
    [markDirty],
  );

  const renameFile = useCallback(
    (oldPath: string, newPath: string) => {
      const content = filesRef.current[oldPath] ?? "";
      const next = { ...filesRef.current };
      delete next[oldPath];
      next[newPath] = content;
      filesRef.current = next;
      setFiles(next);
      // The rename itself is unsaved work, so the new path is dirty either way; the
      // old one has to go, or its dot would outlive the file it described. The tab
      // follows the rename — `EditorShell` remaps it (that wrapper is why renaming an
      // open file no longer closes its tab).
      markDirty(newPath);
      setDirtyPaths((prev) => {
        if (!prev.has(oldPath)) return prev;
        const rest = new Set(prev);
        rest.delete(oldPath);
        return rest;
      });
      try {
        runtimeRef.current?.writeFile(newPath, content);
        runtimeRef.current?.deleteFile?.(oldPath);
      } catch { /* not mounted */ }
    },
    [markDirty],
  );

  /** Download the current (possibly-edited) workspace as a .zip. */
  const downloadZip = useCallback(() => {
    downloadWorkspaceZip(filesRef.current, title || entry.displayName);
  }, [title, entry.displayName]);

  /** Create an embeddable (docs-only) version from the current playground code
   *  and show its embed URL — the logged-in path to embed a public example. */
  const onEmbed = useCallback(async () => {
    if (!user) return login();
    setEmbedding(true);
    setErrorMessage(null);
    try {
      const token = getToken();
      const res = await fetch(`${API_BASE}/api/demos`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          framework: entry.framework,
          files: filesRef.current,
          title: importedTitle ? `${importedTitle} (embed)` : `${entry.displayName} (embed)`,
          htVersion: version,
          forkedFrom: forkedFrom ?? undefined,
        }),
      });
      const { id } = await readApiJson<{ id: string }>(res, `embed failed (${res.status})`);
      setLinksId(id);
      setShareLinksOpen(true);
    } catch (e) {
      // The dialog answers this one; a `<pre>` full of prose with no button
      // would not (DEV-2534). `finally` still clears the in-flight state.
      if (isSessionExpired(e)) return setSessionExpired(true);
      reportError(e, "demo-embed");
      setErrorMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setEmbedding(false);
    }
  }, [user, entry, version, forkedFrom, importedTitle]);

  /** Fork the current playground code into a new saved demo, then open its edit page. */
  const onFork = useCallback(async () => {
    if (!user) return login();
    setForking(true);
    setErrorMessage(null);
    try {
      const token = getToken();
      const res = await fetch(`${API_BASE}/api/demos`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          framework: entry.framework,
          files: filesRef.current,
          // An imported project keeps its own name: "Fork of TypeScript (Vite)"
          // describes the starter its framework resolved to, not the demo.
          title: importedTitle ?? `Fork of ${entry.displayName}`,
          htVersion: version,
          forkedFrom: forkedFrom ?? undefined,
        }),
      });
      const { id } = await readApiJson<{ id: string }>(res, `fork failed (${res.status})`);
      location.href = `/edit/${id}`; // boot into the edit page for the new demo
    } catch (e) {
      // First statement, before any branch. There is no `finally` here on
      // purpose — the success path navigates away and clearing `forking` first
      // would flash the button back to idle mid-navigation — so every *failure*
      // path has to clear it itself. An early return added below it (the shape
      // `onEmbed` and `onSave` can use, since they do have a `finally`) would
      // leave the Fork button spinning forever on an expired session (DEV-2534).
      setForking(false);
      if (isSessionExpired(e)) return setSessionExpired(true);
      reportError(e, "demo-fork");
      setErrorMessage(e instanceof Error ? e.message : String(e));
    }
  }, [user, entry, version, forkedFrom, importedTitle]);

  /** Save the saved-demo edits: the code, which rebuilds the snapshot.
   *
   *  Deliberately *not* the title and description. Since DEV-2495 the Edit info
   *  dialog writes those itself, and sending them here as well gave the row two
   *  writers racing on one field: this PATCH captures the metadata when the user
   *  hits Save, but the server only writes it at the *end* of the rebuild
   *  (`updateDemo`), so a rename committed while a rebuild is in flight is
   *  overwritten by the pre-rename values seconds later. The UI keeps the new
   *  title, so it surfaces as the rename not sticking — the exact bug this branch
   *  exists to fix. Omitted keys leave the stored values alone (the endpoint falls
   *  back to `row.title` / `row.description`), so metadata has one writer. */
  const onSave = useCallback(async () => {
    if (!savedId || isShare) return;
    setSaving(true);
    setErrorMessage(null);
    try {
      const token = getToken();
      const res = await fetch(`${API_BASE}/api/demos/${savedId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          files: filesRef.current,
          htVersion: version,
        }),
      });
      await assertApiOk(res, `save failed (${res.status})`);
      clearDirty();
    } catch (e) {
      // Losing a save is the worst outcome in the app — the user's edits are only
      // in this tab's memory until the PATCH lands. Which is exactly why an
      // expired session opens a dialog here instead of calling `login()`: that
      // sets `location.href`, and the edits would go with the page (DEV-2534).
      // `dirty` is untouched, so the Save button keeps its dot and the work is
      // still there to re-save — or to Download — once the user is back in.
      if (isSessionExpired(e)) return setSessionExpired(true);
      reportError(e, "demo-save");
      setErrorMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [savedId, isShare, version, clearDirty]);

  /**
   * The preview bar's share icon, mode-aware (ADR-0025). `edit` has a saved demo
   * already, so it just opens the dialog; `play` has nothing to link to yet, so it
   * mints one first — which is precisely what the retired `Embed` button did, down
   * to the dialog it opened. Embed keeps no button of its own because that dialog's
   * third row already *is* the docs embed URL.
   *
   * `onFork` is deliberately not folded in with it: it posts the same body, but it
   * navigates to `/edit/:id` afterwards, and losing the playground is the difference
   * users actually care about.
   */
  const onShare = useCallback(() => {
    if (route.mode === "play") return void onEmbed();
    setLinksId(savedId);
    setShareLinksOpen(true);
  }, [route.mode, onEmbed, savedId]);

  /**
   * `Cmd/Ctrl+S`. The top bar's Save is the only authed action the design never
   * framed (ADR-0025), so it gets the shortcut every editor has trained people to
   * expect. Gated exactly as the button is, and `preventDefault` regardless of the
   * gate — offering the browser's "save this page" dialog inside an editor is
   * worse than doing nothing.
   */
  useEffect(() => {
    if (!user || route.mode !== "edit") return;
    const onKey = (e: KeyboardEvent) => {
      // Case-folded, because Caps Lock makes `e.key` "S" with `shiftKey` false —
      // which a bare `!== "s"` rejects, skipping the save *and* letting the
      // browser dialog through. `shiftKey` is still excluded on its own, so
      // Shift+Cmd+S stays free for whatever the browser does with it.
      if (e.key.toLowerCase() !== "s" || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      e.preventDefault();
      // A modal owns the keyboard while it is up, and `Dialog` traps Tab and
      // Escape but knows nothing about this. `EditInfoDialog` matters most: it
      // holds title and description as *drafts* and lifts them only on its own
      // Save, so saving the workspace from under it would persist the old
      // metadata while the dialog still shows the new — which reads, from the
      // outside, exactly like the dialog having saved. Swallowed rather than
      // passed through, so the browser's own dialog stays shut either way.
      if (editInfoOpen || shareLinksOpen) return;
      if (!saving) void onSave();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [user, route.mode, saving, onSave, editInfoOpen, shareLinksOpen]);

  /** Row-2 refresh (`72:15708`). Reloads the running preview in place — never a
   *  remount, which for Tier 2 would mint a fresh container session per click.
   *
   *  `reload()`'s promise settles when the refresh has landed (or timed out, or the
   *  runtime went away); it never rejects, so there is no failure branch here —
   *  `onError` already owns that. */
  const refreshPreview = useCallback(() => {
    const runtime = runtimeRef.current;
    if (!runtime?.reload) return;
    const seq = ++refreshSeqRef.current;
    setRefreshing(true);
    void Promise.resolve(runtime.reload()).then(() => {
      if (seq === refreshSeqRef.current) setRefreshing(false);
    });
  }, []);

  /** `window-maximize` (`72:15715`) — the preview without the editor (`65:20432`).
   *
   *  Two mechanics behind one button, because the two modes show different things
   *  (ADR-0027 §13). A saved demo has a prebuilt `/d/:id/` artifact, which is what the
   *  frames' full mode shows and what the share dialog hands out; that opens in a new
   *  tab, unchanged. A `play` workspace has no artifact — only the live preview already
   *  running in this tab — so full mode there is a layout change on the spot.
   *
   *  In place rather than `window.open` for `play`: a new tab would boot a second runtime,
   *  and for Tier 2 that means a second container session per click against a pool that
   *  already runs out. `replaceState` keeps the URL shareable without a navigation, so the
   *  session, its container and every unsaved edit survive the toggle. */
  const openFullWindow = useCallback(() => {
    const url = new URL(location.href);
    url.searchParams.set("mode", "full");
    if (route.mode !== "play") {
      // No `noopener`: it opens the tab as a fresh top-level context, and the browser
      // only clones `sessionStorage` into a tab that has an opener. The login token
      // lives there (`auth.ts`), so a `noopener` tab is signed *out* — invisible in
      // full mode, which needs no auth, until minimize navigates it to `/edit/:id`
      // and the gate sends an already-signed-in user back through the broker. The
      // target is this same origin with one param added, so there is nothing for an
      // opener reference to abuse.
      window.open(url.toString(), "_blank");
      return;
    }
    history.replaceState(null, "", url.pathname + url.search + url.hash);
    setFull(true);
  }, [route.mode]);

  /** `window-minimize` (`65:20496`) for the in-place form. `FullMode` has its own, which
   *  navigates because it *is* a route. */
  const leaveFullWindow = useCallback(() => {
    const url = new URL(location.href);
    url.searchParams.delete("mode");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
    setFull(false);
  }, []);

  const clientUrl = linksId ? `${location.origin}/share/${linksId}` : "";
  // No `?theme=`: `serveDemoAsset` takes `(env, id, subpath, { embed })` and never sees
  // a query string, so the hint we used to send was provably inert (ADR-0025). Embed
  // theming stays deferred — the example owns its own theme (ADR-0028).
  const embedUrl = linksId ? `${API_BASE}/embed/${linksId}` : "";

  // Same string the top bar's pill shows: a saved demo's title, otherwise the
  // example's display name.
  useDocumentTitle(title || entry.displayName);

  // The framework variants available for the currently-open docs example — drive
  // the separate framework picker shown next to the example Cascader.
  const currentDocsMeta = docsPath ? docsItems.find((i) => i.docsPath === docsPath) : undefined;
  const currentFrameworks = currentDocsMeta
    ? docsItems
        .filter((i) => i.guide === currentDocsMeta.guide && i.exampleId === currentDocsMeta.exampleId)
        .sort((a, b) => FW_PREF.indexOf(a.framework) - FW_PREF.indexOf(b.framework))
    : [];

  // Row 2's framework pill (`72:16741`) — same data and same show/hide rule as
  // the button group it replaces: only docs examples have variants, starters are
  // picked through the cascader instead (ADR-0023).
  const frameworks = currentFrameworks.map((f) => ({
    key: f.docsPath,
    label: FW_LABEL[f.framework] ?? f.displayName,
    active: f.docsPath === docsPath,
  }));

  // What the pill calls the open workspace. The cascader's trigger label, hoisted
  // because full mode shows the same string without the cascader — `65:21390` reads
  // "Drag to scroll - Standard example", a docs example's own name.
  const exampleLabel = currentDocsMeta
    ? `${currentDocsMeta.breadcrumb.join(" ▸ ")} · ${currentDocsMeta.exampleTitle}`
    : entry.displayName;

  // The public address for the row-2 field. Always `/share/:id`, never
  // `/edit/:id`, even while editing: the field is click-to-copy, and `/edit`
  // is auth-gated (`Gate` sends a signed-out visitor to the login broker, which
  // only accepts @handsontable.com). `/share/:id` is the same demo, served
  // without auth — the link `ShareLinks` hands out. A docs example or an unsaved
  // playground has neither, and falls back to `previewUrl`.
  const publicUrl = savedId ? `${location.origin}/share/${savedId}` : "";

  // The short project label for the preview status bar (`48:6706`). `entry.displayName`
  // is only usable for a starter; for a docs example it is the long
  // `"Columns ▸ … · Standard example · React (TS)"` string that `import-docs.mjs` builds,
  // which overwrites the short name irrecoverably. Resolving through the starter catalog
  // by framework key gives the design's exact wording ("React (Vite, TS)") and describes
  // the authored project, which is the same thing it describes for a starter. `.find`,
  // not `getEntry` — that throws on an unknown key.
  const frameworkName =
    catalog.examples.find((x) => x.framework === entry.framework)?.displayName ??
    entry.displayName;

  // True when the user has changed something that nothing is going to save:
  // the playground and the public share view both keep edits in memory only.
  // The edit page has a Save button, so it is excluded — there the work has
  // somewhere to go.
  const unsavedWork = dirty && route.mode !== "edit";

  if (docsNotFound) return <NotFound path={initialDocs} transient={docsNotFoundTransient} />;
  if (savedId && !sourceLoaded) return <Splash text="Loading data …" />;

  return (
    <div style={{ height: "100%", minHeight: 0 }}>
      <EditorShell
        frameworkLabel={entry.displayName}
        frameworkName={frameworkName}
        files={files}
        entry={entry.entry}
        // Tells the shell to discard its open tabs. `files` alone can't: it is replaced
        // on every keystroke as well as on every example switch, and two workspaces
        // routinely share path names. `mountGen` changes only in `loadWorkspace`, which
        // is exactly the "different workspace now" moment (T12).
        workspaceKey={mountGen}
        iframeRef={setIframeEl}
        status={status}
        errorMessage={errorMessage}
        bootLog={bootLog}
        containerBoot={entry.engine === "container"}
        // Withheld while a docs bucket/path is unresolved (the mount effect refuses to run
        // at all in that state) and for pre-mount version refusals: in both cases the
        // button would restart nothing.
        onRetry={docsRuntimeBlocked || !retryable ? undefined : retryPreview}
        syncing={syncing}
        refreshing={refreshing}
        version={version}
        versionOptions={docsPath ? versionOptions : versionsForEntry(versionOptions, entry.minCoreMajor)}
        onVersionChange={changeVersion}
        onEdit={onEdit}
        title={title || entry.displayName}
        // Rendered here rather than in the shell (DEV-2507): the parser lives in the
        // app, and this is the same renderer the demo card and the guide use.
        description={description ? <Markdown text={description} /> : undefined}
        createdAt={createdAt}
        // `edit` only — and no longer the same gate as the file CRUD below, which
        // follows sign-in (ADR-0025). Title and description belong to a *saved* demo
        // row; a `play` workspace has no record to edit, so being signed in there
        // gives the pencil nothing to open.
        onEditInfo={route.mode === "edit" ? () => setEditInfoOpen(true) : undefined}
        onDownloadAll={downloadZip}
        // Changing the *file set* follows being **signed in** (ADR-0025), not the mode.
        // Sticky `114:26599` states it — "CRUD w sidebar po zalogowaniu" — and the `hidden`
        // flag on `folder-plus` / `plus` is bimodal across the file: hidden in all 7 Before
        // Login frames, visible in all 4 After Login ones. So sticky `72:14532`'s "fork/view
        // mode" means *not signed in*, which is the reading ADR-0023 got wrong.
        //
        // `share` stays excluded: the design's only axis is Before / After Login and it never
        // models ownership, so letting a signed-in visitor mutate someone else's file set
        // would be a behaviour change rather than a restyle. (`ShareRoute` passes `user={null}`,
        // so `!!user` already excludes it — `isShare` says so out loud and survives that
        // changing.) Editing file *contents* is unaffected in all three modes, and nothing
        // persists here without `onSave`.
        onAddFile={canEditFiles ? addFile : undefined}
        onAddFiles={canEditFiles ? addFiles : undefined}
        onRenameFile={canEditFiles ? renameFile : undefined}
        onDeleteFile={canEditFiles ? deleteFile : undefined}
        onSave={onSave}
        onShare={onShare}
        onFork={onFork}
        authed={!!user}
        // Account menu (`114:21480`). Keyed off `accountUser`, not `user`, so it
        // survives `/share/:id` — see `ShareRoute`.
        accountEmail={accountUser?.email}
        // The profile behind the avatar (DEV-2166). Fetched here too, not only on
        // the pages that edit it: this is the bar the user spends their time on,
        // and an avatar that only appeared on `/my-demos` would read as a bug.
        accountDisplayName={profile?.display_name}
        accountAvatarUrl={profile?.avatar_url}
        onMyDemos={() => { location.href = "/my-demos"; }}
        // The internal usage + cost panel. Signed-in only by construction — the
        // account menu that holds it renders only for an identified user.
        onUsage={() => { location.href = "/admin"; }}
        onSettings={() => { location.href = "/settings"; }}
        onGuide={() => { location.href = "/guide"; }}
        // `edit` is auth-gated — `Gate` answers a null user with `login()`, so a
        // plain reload would bounce straight back to the broker. `play` and
        // `share` render fine anonymously and keep their example.
        onLogout={route.mode === "edit" ? () => logout("/") : () => logout()}
        mode={route.mode}
        forking={forking}
        // Only `play` mints, so only `play` is ever pending — `edit` opens the
        // dialog straight off `savedId`.
        sharing={embedding}
        saving={saving}
        // Two facts, not one: `dirty` is the workspace (the top bar's `Save •`, which
        // an Edit-info change must light up even though it touched no file), and
        // `dirtyPaths` is which files carry the per-tab dot (T12).
        dirty={dirty}
        dirtyPaths={dirtyPaths}
        versionWarning={versionNotice}
        budgetNotice={budgetNotice}
        importNotice={importNotice}
        // Ask AI and Style, both from DEV-2047. Available on every route — the
        // public `/share` view included, since explaining or restyling a demo is
        // exactly what a shared link invites. Mutually exclusive: since DEV-2209
        // they are literally the same surface — one `Drawer`, one `DRAWER_WIDTH`
        // (400) — on the same edge of the screen.
        secondaryActions={
          <>
            <AskAiButton open={chatOpen} onToggle={() => { setChatOpen((v) => !v); setStyleOpen(false); }} />
            <StyleButton
              open={styleOpen}
              onToggle={() => { setStyleOpen((v) => !v); setChatOpen(false); }}
              disabled={!themingSupported}
              disabledReason={`Theming needs Handsontable ${THEME_API_MIN_MAJOR} or newer — this demo is on ${version}.`}
            />
          </>
        }
        // ---- chrome (T2) --------------------------------------------------
        examplePill={
          // `full` joins the static branch: `65:21391` draws the pill's chevron
          // `hidden`, so the cascader is present but not openable. Switching example
          // from a view with no editor would replace a workspace you cannot see.
          full || isShare || route.mode === "edit" ? (
            // `alt=""`: the mark is branding, not information, and unlike BOX INFO's
            // badge no "Handsontable" text follows it here — a real `alt` would just
            // prepend noise to every pill's accessible name.
            <div style={shellStyles.examplePill(false)} title={description || undefined}>
              <img src={markUrl} alt="" style={shellStyles.examplePillMark} />
              {/* A saved demo has a title; a playground in full mode has only the
                  example it opened, and "Untitled demo" would be a worse answer than
                  the name the cascader was showing a moment ago. */}
              <span style={pillLabel}>
                {title || (isShare ? "Shared demo" : full ? exampleLabel : "Untitled demo")}
              </span>
            </div>
          ) : (
            // The mark is a *sibling* of the cascader, never inside its trigger —
            // inside, the <img> would join the trigger's accessible name. The pill
            // stays 480px: mark + 8px gap leave the 420px label region `72:15859`
            // draws, which the trigger's `flex: 1` absorbs.
            <div style={shellStyles.examplePill(true)}>
              <img src={markUrl} alt="" style={shellStyles.examplePillMark} />
              <DocsCascader
                manifestItems={docsItems}
                starters={catalog.examples.map((e) => ({ framework: e.framework, displayName: e.displayName }))}
                currentLabel={exampleLabel}
                selectedKey={
                  currentDocsMeta
                    ? `${currentDocsMeta.guide}|${currentDocsMeta.exampleId}`
                    : docsPath
                      ? undefined
                      : `starter:${framework}`
                }
                onSelect={(leaf: CascaderLeaf) => {
                  if (leaf.kind === "starter") { selectExample(leaf.framework); return; }
                  const pick =
                    leaf.frameworks.find((f) => f.framework === framework) ??
                    FW_PREF.map((p) => leaf.frameworks.find((f) => f.framework === p)).find(Boolean) ??
                    leaf.frameworks[0];
                  if (pick) void selectDocs(pick.docsPath);
                }}
              />
            </div>
          )
        }
        publicUrl={publicUrl}
        previewUrl={previewUrl}
        onRefreshPreview={refreshPreview}
        // Every mode, as `72:15706` and `65:20432` both draw it — the latter over a docs
        // example, which is always `play`. It was withheld in `play` until ADR-0027 §13,
        // on the reasoning that there is no `/d/:id/` build to show there; the answer is
        // that full mode shows the live preview instead, not that the button goes away.
        onMaximize={openFullWindow}
        fullMode={full}
        onMinimize={full ? leaveFullWindow : undefined}
        // Not gated on auth: share mode has always offered Download to anonymous
        // visitors, and no frame shows an anonymous share view (ADR-0023 rule 1).
        // `72:15697` (anonymous `play`) does draw `Sign in` alone — kept anyway, per the
        // same rule, rather than dropping a working control. See ADR-0027 §2.
        onDownload={downloadZip}
        downloadHighlight={unsavedWork}
        // Withheld while the identity is still resolving, which is the only thing
        // that makes the top bar render `Sign in`. Offering it to someone who turns
        // out to be signed in — and who could click it — is worse than a bar that
        // is briefly one control short.
        onSignIn={accountPending ? undefined : login}
        frameworks={frameworks}
        onFrameworkChange={(docsPathKey) => void selectDocs(docsPathKey)}
        docsUrl={currentDocsMeta ? docsPageUrl(framework, currentDocsMeta.docPermalink) : undefined}
        // Play only, as before. A saved demo's source is the demo itself, not
        // the starter it was forked from, so pointing at the starter repo there
        // would be wrong — and `48:6560`, the one edit-mode frame, ends its bar
        // at `window-maximize`.
        repoUrl={
          route.mode !== "play"
            ? undefined
            : docsPath
              ? `https://github.com/handsontable/handsontable/tree/develop/docs/content/${docsPath.split("/").slice(0, -1).join("/")}`
              : `https://github.com/handsontable/examples/tree/master/examples/${framework}`
        }
        repoLabel={docsPath ? "See this example on GitHub" : "Fork this starter on GitHub"}
      />

      {shareLinksOpen && linksId && (
        <ShareLinks clientUrl={clientUrl} embedUrl={embedUrl} onClose={() => setShareLinksOpen(false)} />
      )}

      {/* An expired session, asked about rather than acted on (DEV-2534).
          `login()` sets `location.href`, and the workspace only exists in this
          tab's memory — so the re-auth is offered, not taken. Dismissing it
          leaves the top bar's Download reachable, which is the escape hatch for
          someone who would rather take a zip than risk the round trip. */}
      {sessionExpired && (
        <Dialog title="Your session expired" onClose={() => setSessionExpired(false)}>
          <p style={sessionExpiredBody}>
            Sign in again to continue. Your unsaved work stays in this tab either way —
            you can also download it first.
          </p>
          <div style={formFooter}>
            <button type="button" style={primaryButton} onClick={login}>
              Sign in again
            </button>
            {/* Focus lands here, not on "Sign in again": that button leaves the
                page, and landing on it would make Space or Enter — pressed by
                someone who did not read a dialog they did not ask for — take the
                unsaved workspace with it. */}
            <button
              type="button"
              data-autofocus
              style={ghostButton}
              onClick={() => setSessionExpired(false)}
            >
              Not now
            </button>
          </div>
        </Dialog>
      )}

      {/* `savedId` narrows the dialog's `demoId` — the pencil is `edit`-only, so it
          is never null here, but the render guard is where that is provable. */}
      {editInfoOpen && savedId && (
        <EditInfoDialog
          apiBase={API_BASE}
          demoId={savedId}
          token={getToken()}
          title={title}
          description={description}
          onClose={closeEditInfo}
          // The dialog PATCHes on its own (DEV-2495) and this runs once the server
          // has taken it, so there is nothing outstanding to mark: no `markDirty()`.
          // It used to call it with no path — which is what left a `Save •` over an
          // edit that had, from the user's side, already been saved.
          onSave={(next) => {
            setTitle(next.title);
            setDescription(next.description);
          }}
        />
      )}

      {styleOpen && themingSupported && (
        <StylePanel
          apiBase={API_BASE}
          token={getToken()}
          htVersion={version}
          getFiles={() => filesRef.current}
          applyEdit={onEdit}
          postToPreview={postToPreview}
          onPreviewMessage={onPreviewMessage}
          flushQuietEdits={flushQuietEdits}
          onClose={() => setStyleOpen(false)}
        />
      )}
      {chatOpen && (
        <ChatPanel
          apiBase={API_BASE}
          token={getToken()}
          framework={framework}
          htVersion={version}
          docsPath={docsPath}
          getFiles={() => filesRef.current}
          applyEdit={onEdit}
          onClose={() => setChatOpen(false)}
        />
      )}
    </div>
  );
}

// ---- small shared UI bits --------------------------------------------------

function Logo({ size = 24 }: { size?: number }) {
  const logoUrl = useLogoUrl();
  return <img src={logoUrl} alt="Handsontable" style={{ height: size, display: "block" }} />;
}

/** The re-auth dialog's one paragraph — the same body treatment the delete
 *  confirmation in `MyDemos` uses, so the two modals read as one component. */
const sessionExpiredBody: React.CSSProperties = {
  margin: 0,
  fontFamily: theme.font.ui,
  fontSize: 13,
  lineHeight: 1.5,
  color: theme.color.textMuted,
};

const centered: React.CSSProperties = {
  height: "100%",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 12,
  background: theme.color.surface,
};
// `selectStyle` and `ghostBtn` lived here for the unframed authed-extras row —
// the title/description inputs and the My demos / Log out buttons. T9 moved all
// of that into the Edit info dialog and the account menu, both of which style
// themselves from the token set, so the two locals had no callers left.

/** The demo title inside the centred pill (`48:6583`). The shell's `pillLabel` is
 *  the shared type; a *title* can be arbitrarily long, so this one adds the
 *  ellipsis the static labels don't need. */
const pillLabel: React.CSSProperties = {
  ...shellStyles.pillLabel,
  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
};
