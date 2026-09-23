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

    assert.equal(config.ingester.wal.flush_on_shutdown, true, "ingester.wal.flush_on_shutdown");
    assert.equal(config.ingester.max_chunk_age, "2h", "ingester.max_chunk_age");

    assert.equal(config.limits_config.shard_streams.enabled, false, "limits_config.shard_streams.enabled");
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

  test(`${configFile}: otlp_config promotes exactly the contract §3 resource attributes`, () => {
    const raw = readText(configFile);
    const config = parseJsonWithEnvPlaceholders(raw);

    const attributesConfig = config.limits_config.otlp_config.resource_attributes.attributes_config;
    assert.ok(Array.isArray(attributesConfig) && attributesConfig.length > 0, "attributes_config is non-empty");

    const indexLabelEntries = attributesConfig.filter((entry) => entry.action === "index_label");
    assert.ok(indexLabelEntries.length > 0, "at least one index_label entry");
    const promoted = new Set(indexLabelEntries.flatMap((entry) => entry.attributes));

    // docs/observability-contract.md §3: these MUST become Loki labels.
    for (const attr of [
      "service.name",
      "deployment.environment.name",
      "hot.surface",
      "hot.tier",
      "hot.framework",
      "hot.ht_major",
      "hot.outcome",
    ]) {
      assert.ok(promoted.has(attr), `${attr} is promoted to a label`);
    }

    // §3 says these are NEVER labels: service.version ("no" in the Loki-label
    // column), and the structured-metadata-only set.
    for (const attr of ["service.version", "hot.demo_id", "session.id", "cf.ray"]) {
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

  // Grafana Live disabled (ADR-0041 §A) — 0 refuses every websocket.
  assert.equal(ini.live.max_connections, "0", "[live] max_connections disables Grafana Live");
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

test("grafana.ini: serve_from_sub_path and root_url agree (the documented silent-break trap)", () => {
  const ini = parseIni(readText("grafana/grafana.ini"));
  assert.equal(ini.server.serve_from_sub_path, "true");
  assert.ok(ini.server.root_url.includes("/grafana/"), "root_url carries the same /grafana/ sub-path");
});

// --- compose.yml: no GF_* env var may silently override a pinned key -------

test("compose.yml: no GF_* override for the pinned grafana.ini keys", () => {
  const compose = readText("compose.yml");
  const boxServiceMatch = compose.match(/^\s{2}box:[\s\S]*?(?=^\s{2}\S|\Z)/m);
  assert.ok(boxServiceMatch, "compose.yml has a `box` service block");
  const boxBlock = boxServiceMatch[0];

  const forbidden = [
    "GF_SERVER_SERVE_FROM_SUB_PATH",
    "GF_AUTH_PROXY_ENABLED",
    "GF_AUTH_PROXY_HEADER_NAME",
    "GF_LIVE_MAX_CONNECTIONS",
    "GF_USERS_AUTO_ASSIGN_ORG_ROLE",
  ];
  for (const name of forbidden) {
    assert.ok(!boxBlock.includes(name), `compose.yml must not set ${name} (would silently override grafana.ini)`);
  }
  // The one GF_* override compose.yml IS allowed (and expected) to set: the
  // host-varying root_url.
  assert.ok(boxBlock.includes("GF_SERVER_ROOT_URL"), "compose.yml sets GF_SERVER_ROOT_URL (host:port varies per run)");
});

test("compose.yml: every box/minio/clickhouse host port is env-overridable (COMMON.md rule 5)", () => {
  const compose = readText("compose.yml");
  const portLines = [...compose.matchAll(/^\s*- "127\.0\.0\.1:\$\{([A-Z0-9_]+):-(\d+)\}:(\d+)"/gm)];
  assert.ok(portLines.length >= 4, "at least 4 published host ports (grafana, loki, minio api, minio console)");
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
  assert.doesNotMatch(dockerfile, /LOKI_S3_SECRET_ACCESS_KEY\s*=/, "no baked secret default");
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
