// pipeline/o11y-box-config.test.mjs
//
// Pins the ADR-0041 §B.4 Loki keys and the Grafana sub-path/Live/auth.proxy
// settings (ADR-0041 §A) that containers/o11y/** ships. Each assertion below
// was verified by hand to fail when its key is removed from the source file
// (T01 Outcome / T01-report.md records the exact removal -> failing
// assertion -> revert loop, per docs/TESTING.md "no hollow assertions").
//
// Zero-dependency parsing on purpose (T00 owns adding any new dependency,
// runner/pnpm-lock.yaml has no yaml package): the Loki config files are
// committed as valid JSON, which is also valid YAML — Loki (go-yaml) and
// this test read the exact same bytes, so there is no second, driftable
// copy of the config shape. The one non-JSON piece is the env-var
// placeholders Loki expands at runtime (`-config.expand-env=true`); this
// test replaces each `${VAR}` token with a JSON string literal before
// parsing so the *committed* file stays byte-identical to what Loki reads
// (verified separately with `loki -verify-config`, see the T01 report).
//
// grafana.ini is real INI, not YAML/JSON — parsed with a small strict
// section/key=value reader below rather than adding an ini dependency.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const O11Y_DIR = join(__dirname, "..", "containers", "o11y");

function readText(relPath) {
  return readFileSync(join(O11Y_DIR, relPath), "utf8");
}

function parseJsonWithEnvPlaceholders(text) {
  // Two shapes appear in the committed config: a quoted placeholder
  // ("key": "${VAR}", the common case) and a bare one ("key": ${VAR}, used
  // where Loki needs a typed, non-string value after expansion — e.g. the
  // "insecure" boolean). Replace the quoted form whole first so it does not
  // get double-quoted by the bare-token pass that follows.
  const withPlaceholders = text
    .replace(/"\$\{[A-Z0-9_]+\}"/g, '"__ENV_PLACEHOLDER__"')
    .replace(/\$\{[A-Z0-9_]+\}/g, '"__ENV_PLACEHOLDER__"');
  return JSON.parse(withPlaceholders);
}

// A strict-enough INI reader for grafana.ini: sections `[name]`, `key = value`
// lines, `;`/`#` comments, blank lines. Throws on anything else so a config
// shape this test does not understand cannot silently pass. Not a general
// INI parser — just enough for this one file.
function parseIni(text) {
  const sections = { "": {} };
  let current = "";
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith(";") || line.startsWith("#")) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      current = sectionMatch[1];
      sections[current] ??= {};
      continue;
    }
    const kvMatch = line.match(/^([^=]+?)\s*=\s*(.*)$/);
    if (!kvMatch) {
      throw new Error(`grafana.ini: unparsable line under [${current}]: ${JSON.stringify(rawLine)}`);
    }
    const [, key, value] = kvMatch;
    sections[current][key.trim()] = value.trim();
  }
  return sections;
}

// --- Loki config: both loki-config.yaml (S3) and loki-config.filesystem.yaml
// (the STORAGE=filesystem escape hatch, T01-D2) carry the full §B.4 key set
// — the filesystem file is a second, otherwise-unpinned copy of every key
// below, and it IS built into the image and boot-tested (see T01 report).

for (const configFile of ["loki/loki-config.yaml", "loki/loki-config.filesystem.yaml"]) {
  test(`${configFile}: ADR-0041 §B.4 keys are pinned`, () => {
    const raw = readText(configFile);
    const config = parseJsonWithEnvPlaceholders(raw);

    // I2 (fix round 1): multi-tenancy is not optional here — flip this to
    // false and both tenants collapse into Loki's single `fake` tenant,
    // silently merging browser and worker streams.
    assert.equal(config.auth_enabled, true, "auth_enabled (browser/worker tenant isolation)");

    assert.equal(config.ingester.wal.flush_on_shutdown, true, "ingester.wal.flush_on_shutdown");
    assert.equal(config.ingester.max_chunk_age, "2h", "ingester.max_chunk_age");

    assert.equal(config.limits_config.shard_streams.enabled, false, "limits_config.shard_streams.enabled");
    // M6 (fix round 1): the boolean gate, not just its paired max-age — a
    // false here makes reject_old_samples_max_age a no-op.
    assert.equal(config.limits_config.reject_old_samples, true, "limits_config.reject_old_samples");
    assert.equal(
      config.limits_config.reject_old_samples_max_age,
      "7d",
      "limits_config.reject_old_samples_max_age",
    );
    assert.ok(config.limits_config.ingestion_rate_mb >= 16, "limits_config.ingestion_rate_mb >= 16");
    assert.ok(config.limits_config.ingestion_burst_size_mb >= 32, "limits_config.ingestion_burst_size_mb >= 32");
    assert.equal(config.limits_config.max_line_size, "256KB", "limits_config.max_line_size");

    // query_ingesters_within lives under `querier`, not `limits_config` — Loki
    // 3.3.2 rejects it under limits_config (verified with `-verify-config`,
    // see the T01 report).
    assert.equal(config.querier.query_ingesters_within, "168h", "querier.query_ingesters_within");

    assert.equal(config.runtime_config.file, "/etc/loki/runtime-config.yaml", "runtime_config.file");
    assert.equal(
      config.compactor.retention_enabled,
      false,
      "compactor.retention_enabled (R2 lifecycle owns retention)",
    );
  });

  test(`${configFile}: otlp_config promotes EXACTLY the contract §3 resource attributes`, () => {
    const raw = readText(configFile);
    const config = parseJsonWithEnvPlaceholders(raw);

    const resourceAttributes = config.limits_config.otlp_config.resource_attributes;

    // P1 (fix round 1): Loki ships a BUILT-IN default promotion list
    // (service.name, service.namespace, service.instance.id,
    // deployment.environment, cloud.region, cloud.availability_zone, and a
    // run of k8s.*/container.* keys — confirmed via
    // `loki -help` -> `-distributor.otlp.default_resource_attributes_as_
    // index_labels`) that applies ON TOP OF `attributes_config` unless
    // explicitly turned off. Exit criterion 15 needs the EXACT contract
    // label set, so a subset-plus-exclusions check is not enough — a
    // record carrying `deployment.environment` (note: not the contract's
    // `deployment.environment.name`) would silently pick up a label this
    // config never asked for. `ignore_defaults: true` disables that list;
    // verified with a real push carrying `service.namespace` and
    // `deployment.environment` (T01 report) that neither becomes a label
    // once this is set.
    assert.equal(resourceAttributes.ignore_defaults, true, "resource_attributes.ignore_defaults");

    const attributesConfig = resourceAttributes.attributes_config;
    assert.ok(Array.isArray(attributesConfig) && attributesConfig.length > 0, "attributes_config is non-empty");

    const indexLabelEntries = attributesConfig.filter((entry) => entry.action === "index_label");
    assert.ok(indexLabelEntries.length > 0, "at least one index_label entry");
    const promoted = new Set(indexLabelEntries.flatMap((entry) => entry.attributes));

    // docs/observability-contract.md §3: EXACTLY this set becomes a Loki
    // label — not a subset, not a superset.
    const expectedLabels = [
      "service.name",
      "deployment.environment.name",
      "hot.surface",
      "hot.tier",
      "hot.framework",
      "hot.ht_major",
      "hot.outcome",
    ];
    assert.deepEqual(
      [...promoted].sort(),
      [...expectedLabels].sort(),
      "the promoted-attribute set is exactly the contract §3 label set",
    );

    // §3 says these are NEVER labels: service.version ("no" in the Loki-label
    // column), and the structured-metadata-only set (hot.kind included —
    // the Faro item kind, §3's last structured-metadata-only entry).
    for (const attr of ["service.version", "hot.demo_id", "session.id", "cf.ray", "hot.kind"]) {
      assert.ok(!promoted.has(attr), `${attr} must NOT be promoted to a label`);
    }
  });
}

test("loki-config.yaml: S3 storage is env-driven, never a baked credential", () => {
  const raw = readText("loki/loki-config.yaml");
  // Deliberately NOT JSON.parse here: this is exactly the property that
  // parseJsonWithEnvPlaceholders would hide (it replaces every ${VAR} with a
  // placeholder). Assert on the raw text that every S3 credential field is
  // still an unexpanded placeholder in the committed file.
  for (const key of ["LOKI_S3_ENDPOINT", "LOKI_S3_ACCESS_KEY_ID", "LOKI_S3_SECRET_ACCESS_KEY", "LOKI_S3_BUCKET"]) {
    assert.ok(raw.includes(`\${${key}}`), `loki-config.yaml references \${${key}}, not a literal value`);
  }
  assert.doesNotMatch(raw, /AKIA[0-9A-Z]{16}/, "no literal AWS-shaped access key in the config");
});

test("runtime-config.yaml: per-tenant max_query_lookback matches R2 lifecycle retention", () => {
  const config = JSON.parse(readText("loki/runtime-config.yaml"));
  // browser chunks expire at 30d (§B.4/§H); worker chunks at 90d. A query
  // must never be able to reach past-retention index entries.
  assert.equal(config.overrides.browser.max_query_lookback, "720h", "browser max_query_lookback (30d)");
  assert.equal(config.overrides.worker.max_query_lookback, "2160h", "worker max_query_lookback (90d)");
});

// --- Grafana: containers/o11y/grafana/grafana.ini ---------------------------

test("grafana.ini: sub-path, Live and auth.proxy are pinned", () => {
  const ini = parseIni(readText("grafana/grafana.ini"));

  assert.equal(ini.server.serve_from_sub_path, "true", "[server] serve_from_sub_path");
  assert.match(ini.server.root_url, /\/grafana\/$/, "[server] root_url ends in /grafana/");

  assert.equal(ini["auth.proxy"].enabled, "true", "[auth.proxy] enabled");
  assert.equal(ini["auth.proxy"].header_name, "X-O11Y-GRAFANA-USER", "[auth.proxy] header_name");
  assert.equal(ini["auth.proxy"].auto_sign_up, "true", "[auth.proxy] auto_sign_up");

  assert.equal(ini.users.auto_assign_org_role, "Viewer", "[users] auto_assign_org_role (auto sign-up as Viewer)");

  // Grafana Live disabled for Grafana's OWN frontend (ADR-0041 §A, T01-D1
  // updated in fix round 1): `GET /api/frontend/settings` reports
  // `liveEnabled: false` with this set — checked behaviourally in
  // local/stop-roundtrip.mjs. It does not refuse a raw client dialing
  // `/api/live/ws` directly (grafana/grafana#72072); that enforcement is
  // GrafanaBox.containerFetch's job in phase 2, not this config.
  assert.equal(ini.live.max_connections, "0", "[live] max_connections disables Grafana Live for its own frontend");
});

test("grafana.ini: auth.proxy is the ONLY trusted identity — basic auth and the admin fallback are off", () => {
  const ini = parseIni(readText("grafana/grafana.ini"));
  // T01-D1's sibling finding: unlike Live, this one IS fully enforced by
  // Grafana itself — verified with `curl -u admin:admin` returning 401
  // once these are set (200 beforehand). A Viewer-only, proxy-authenticated
  // design must not have a second, unrelated way in.
  assert.equal(ini["auth.basic"].enabled, "false", "[auth.basic] enabled must be false");
  assert.equal(
    ini.security.disable_initial_admin_creation,
    "true",
    "[security] disable_initial_admin_creation (no admin/admin fallback once basic auth is off)",
  );
});

// M10 (fix round 1): the previous "serve_from_sub_path and root_url agree"
// test asserted exactly what "sub-path, Live and auth.proxy are pinned"
// above already covers (serve_from_sub_path === "true", root_url ending in
// /grafana/) — a duplicate, not a second real check. Removed rather than
// kept as dead weight.

// --- Grafana provisioning: containers/o11y/grafana/provisioning/datasources
// -------------------------------------------------------------------------

test("datasources.yaml: fixed uids and tenant headers are pinned (T09 depends on the uids)", () => {
  const raw = readText("grafana/provisioning/datasources/datasources.yaml");

  // I2 (fix round 1): Grafana's sqlite state is disposable — a fresh DB on
  // every wake — so a dashboard (T09) that references a datasource by uid
  // breaks on every wake if these drift or go back to auto-generated ids.
  for (const uid of ["loki-browser", "loki-worker", "clickhouse-runner-events"]) {
    // End-of-line anchored, not just a trailing \b: "loki-browser-x" also
    // has a word boundary right after "loki-browser" (word char -> "-"),
    // so \b alone would still match a renamed/suffixed uid.
    assert.match(raw, new RegExp(`uid:\\s*${uid}\\s*$`, "m"), `datasource uid ${uid} is pinned`);
  }

  // The whole point of two Loki datasources is that they carry DIFFERENT
  // X-Scope-OrgID values — assert each one is paired with its own tenant,
  // not just that both tenant strings appear somewhere in the file.
  const browserBlock = raw.slice(raw.indexOf("uid: loki-browser"), raw.indexOf("uid: loki-worker"));
  const workerBlock = raw.slice(raw.indexOf("uid: loki-worker"), raw.indexOf("uid: clickhouse-runner-events"));
  assert.match(browserBlock, /httpHeaderValue1:\s*browser\b/, "loki-browser datasource sends X-Scope-OrgID: browser");
  assert.match(workerBlock, /httpHeaderValue1:\s*worker\b/, "loki-worker datasource sends X-Scope-OrgID: worker");
});

// --- compose.yml: no GF_* env var may silently override a pinned key -------

test("compose.yml: no GF_* override for the pinned grafana.ini keys", () => {
  const compose = readText("compose.yml");
  // M7 (fix round 1): `\Z` is not a recognized escape in a JS RegExp — it
  // matched a literal capital "Z", not "end of string". `box` happens not
  // to be followed by one in this file, so the lookahead's second branch
  // was accidentally dead rather than wrong, but it was still a bug.
  // `$(?![\s\S])` is the correct "true end of string" alternative to pair
  // with the "next top-level service" lookahead.
  const boxServiceMatch = compose.match(/^\s{2}box:[\s\S]*?(?=^\s{2}\S|$(?![\s\S]))/m);
  assert.ok(boxServiceMatch, "compose.yml has a `box` service block");
  const boxBlock = boxServiceMatch[0];

  // M4 (fix round 1): an explicit denylist only catches names someone
  // thought to list. Every GF_* token in the box block must be exactly
  // GF_SERVER_ROOT_URL — the one override this file is allowed to make.
  const gfVars = new Set([...boxBlock.matchAll(/\bGF_[A-Z0-9_]+\b/g)].map(([m]) => m));
  assert.deepEqual(
    [...gfVars],
    ["GF_SERVER_ROOT_URL"],
    "the only GF_* token in the box block is GF_SERVER_ROOT_URL (host:port varies per run)",
  );
});

test("compose.yml: every box/minio/clickhouse host port is env-overridable (COMMON.md rule 5)", () => {
  const compose = readText("compose.yml");
  const portLines = [...compose.matchAll(/^\s*- "127\.0\.0\.1:\$\{([A-Z0-9_]+):-(\d+)\}:(\d+)"/gm)];
  // M5 (fix round 1): every `- "..."` line under any service's `ports:`
  // must be one of these env-overridable lines — not just "at least 4 of
  // them exist somewhere". A `9000:9000` slipped in verbatim for a fifth
  // service would previously still pass this test.
  const allPublishedPortLines = compose.split("\n").filter((line) => /^\s*- "[\d.]+:/.test(line));
  assert.equal(
    portLines.length,
    allPublishedPortLines.length,
    "every published host port line matches the env-overridable 127.0.0.1:${VAR:-default}:port shape",
  );
  assert.equal(portLines.length, 6, "box (2) + minio (2) + clickhouse (2) published ports");
  for (const [, envVar] of portLines) {
    assert.match(envVar, /^O11Y_/, `${envVar} follows the O11Y_* naming convention`);
  }
  // The contract's own defaults (docs/observability-contract.md §1), read
  // from THIS specific published-port line's own captured default — not a
  // free-floating match anywhere in the file, which the Grafana line alone
  // would satisfy vacuously via its OWN unrelated GF_SERVER_ROOT_URL
  // occurrence of the same substring.
  const byVar = new Map(portLines.map(([, envVar, def]) => [envVar, def]));
  assert.equal(byVar.get("O11Y_GRAFANA_PORT"), "3000", "Grafana host port defaults to the contract's 3000");
  assert.equal(byVar.get("O11Y_LOKI_PORT"), "3100", "Loki host port defaults to the contract's 3100");
  assert.equal(byVar.get("O11Y_CLICKHOUSE_PORT"), "8123", "ClickHouse host port defaults to the contract's 8123");
});

// --- Dockerfile: pins that the right config files are actually loaded ------

test("Dockerfile: loads the same config files this test pins (source-grep pin)", () => {
  const dockerfile = readText("Dockerfile");
  assert.match(dockerfile, /loki\/loki-config\.yaml/, "COPYs loki-config.yaml");
  assert.match(dockerfile, /loki\/loki-config\.filesystem\.yaml/, "COPYs loki-config.filesystem.yaml (STORAGE=filesystem)");
  assert.match(dockerfile, /loki\/runtime-config\.yaml/, "COPYs runtime-config.yaml");
  assert.match(dockerfile, /grafana\/grafana\.ini/, "COPYs grafana.ini");
  assert.match(dockerfile, /grafana\/provisioning/, "COPYs the Grafana provisioning directory");
  // No secret baked into the image (ADR-0041 traps): the S3 credential env
  // names must never appear as a literal ENV/ARG default in the Dockerfile.
  // M8 (fix round 1): `KEY\s*=` alone misses Dockerfile's space-separated
  // `ENV KEY value` form (no `=` at all) — check both shapes for ENV and
  // ARG. A bare `ARG LOKI_S3_SECRET_ACCESS_KEY` with no value is not
  // matched (that only declares the name, it does not bake a value).
  assert.doesNotMatch(
    dockerfile,
    /^\s*(ENV|ARG)\s+LOKI_S3_SECRET_ACCESS_KEY(\s*=\s*\S+|\s+\S+)/m,
    "no baked secret default (ENV/ARG, = or space form)",
  );
});

// --- r2-lifecycle-rules.json: shape T10 applies via wrangler ---------------

test("r2-lifecycle-rules.json: matches the real R2 lifecycle API body shape, one rule per real key prefix", () => {
  const raw = readText("r2-lifecycle-rules.json");
  const doc = JSON.parse(raw);
  // Only "rules" at the top level — verified against Cloudflare's own R2
  // "update bucket lifecycle configuration" API reference
  // (developers.cloudflare.com/api/resources/r2/.../lifecycle/methods/update),
  // applied with `wrangler r2 bucket lifecycle set <bucket> --file <path>`.
  // An extra field here (a "_comment", say) risks the API or wrangler
  // rejecting the whole document, so this test also pins the top-level key
  // set, not just parseability.
  assert.deepEqual(Object.keys(doc), ["rules"], "only a top-level `rules` key");
  assert.ok(Array.isArray(doc.rules) && doc.rules.length === 4, "exactly 4 rules");

  const byPrefix = new Map(doc.rules.map((r) => [r.conditions.prefix, r]));
  // Prefixes matched against the REAL key layout Loki 3.3.2 writes,
  // confirmed by the T01 spike (containers/o11y/local/stop-roundtrip.mjs):
  // browser/<fp>/..., worker/<fp>/..., index/index/<table>/...,
  // state/wakes/<wakeId>/clean.
  const expectedAgeSeconds = {
    "browser/": 30 * 24 * 3600,
    "worker/": 90 * 24 * 3600,
    "index/": 90 * 24 * 3600,
    "state/": 30 * 24 * 3600,
  };
  for (const [prefix, maxAge] of Object.entries(expectedAgeSeconds)) {
    const rule = byPrefix.get(prefix);
    assert.ok(rule, `a rule exists for prefix ${prefix}`);
    assert.equal(rule.enabled, true, `${prefix} rule is enabled`);
    assert.equal(rule.deleteObjectsTransition.condition.type, "Age", `${prefix} uses an Age condition`);
    assert.equal(rule.deleteObjectsTransition.condition.maxAge, maxAge, `${prefix} maxAge is ${maxAge}s`);
  }
});
