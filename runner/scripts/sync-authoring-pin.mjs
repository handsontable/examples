// Keeps the three hand-held Handsontable version facts in step with the starter buckets that
// `import-starters.yml` re-pins every Monday (DEV-2735 / #423 follow-up):
//
//   1. `apps/authoring/package.json` `handsontable`  — the authoring app's own pin
//   2. `apps/authoring/src/theme/presets.ts` `BUNDLED_VERSION`
//   3. `packages/runtime/src/dep-shims.ts` `HOT_LAST_KNOWN_GOOD` — newest stable verified free of
//      syntax babel 6 cannot parse. A default version above it is tarball-scanned on every
//      mount, which a network-less deterministic e2e cannot do (#424).
//
// (1) and (2) follow `catalog.json` `bucketVersions[<pin's major>]`. (3) moves only when the new
// version's tarball has no blocking file that the current known-good's tarball lacks; otherwise
// it is left alone and `sync-authoring-pin.test.mjs` goes red with the reason.
//
// Usage: node scripts/sync-authoring-pin.mjs   (then `pnpm install --lockfile-only`)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Mirrors HOT_BLOCKING_SYNTAX in packages/runtime/src/dep-shims.ts (a test pins the two together).
export const BLOCKING_SYNTAX = /(?:\?\?|\|\||&&)=|\(\?<[=!A-Za-z_$]/;

const PIN_RE = /("handsontable":\s*")(\d+\.\d+\.\d+)(")/;
const BUNDLED_RE = /(export const BUNDLED_VERSION = ")([^"]+)(")/;
const KNOWN_GOOD_RE = /(const HOT_LAST_KNOWN_GOOD = \[)(\d+), (\d+), (\d+)(\] as const;)/;

const parse = (v) => /^(\d+)\.(\d+)\.(\d+)$/.exec(v)?.slice(1).map(Number) ?? null;
const newer = (a, b) => (a[0] - b[0] || a[1] - b[1] || a[2] - b[2]) > 0;

/** Package-relative paths of the non-`dist/` `.js` files whose source has blocking syntax. */
export function blockingFiles(files) {
  return Object.keys(files)
    .filter((rel) => rel.endsWith(".js") && !rel.startsWith("dist/") && BLOCKING_SYNTAX.test(files[rel]))
    .sort();
}

/** Pure: the three file texts and the two blocking-file sets in, the new texts out. */
export function planSync({ pkgText, presetsText, shimsText, target, oldBlocking, newBlocking }) {
  const out = { pkgText, presetsText, shimsText, notes: [] };
  const pin = PIN_RE.exec(pkgText)?.[2];
  if (!pin) throw new Error("apps/authoring/package.json has no exact handsontable pin");
  if (target && target !== pin) {
    out.pkgText = pkgText.replace(PIN_RE, `$1${target}$3`);
    out.presetsText = presetsText.replace(BUNDLED_RE, `$1${target}$3`);
    out.notes.push(`authoring pin ${pin} -> ${target}`);
  }
  const good = KNOWN_GOOD_RE.exec(shimsText);
  const goodV = good && good.slice(2, 5).map(Number);
  const want = parse(target ?? "");
  if (goodV && want && newer(want, goodV) && want[0] === goodV[0]) {
    const added = newBlocking.filter((f) => !oldBlocking.includes(f));
    if (added.length === 0) {
      out.shimsText = shimsText.replace(KNOWN_GOOD_RE, `$1${want.join(", ")}$5`);
      out.notes.push(`HOT_LAST_KNOWN_GOOD ${goodV.join(".")} -> ${target}`);
    } else {
      out.notes.push(`HOT_LAST_KNOWN_GOOD left at ${goodV.join(".")}: ${target} adds blocking syntax in ${added.join(", ")}`);
    }
  }
  return out;
}

/** Download a registry tarball and read its `.js` files (needs the system `tar`). */
export async function fetchPackageJs(version, fetchImpl = fetch) {
  const res = await fetchImpl(`https://registry.npmjs.org/handsontable/-/handsontable-${version}.tgz`);
  if (!res.ok) throw new Error(`handsontable@${version} tarball: registry returned ${res.status}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ht-tgz-"));
  try {
    fs.writeFileSync(path.join(dir, "pkg.tgz"), Buffer.from(await res.arrayBuffer()));
    execFileSync("tar", ["xzf", "pkg.tgz"], { cwd: dir });
    const root = path.join(dir, "package");
    const files = {};
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".js")) files[path.relative(root, full).split(path.sep).join("/")] = fs.readFileSync(full, "utf8");
      }
    };
    walk(root);
    return files;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function syncAuthoringPin({ root, fetchPkg = fetchPackageJs } = {}) {
  const at = (p) => path.join(root, p);
  const pkgText = fs.readFileSync(at("apps/authoring/package.json"), "utf8");
  const presetsText = fs.readFileSync(at("apps/authoring/src/theme/presets.ts"), "utf8");
  const shimsText = fs.readFileSync(at("packages/runtime/src/dep-shims.ts"), "utf8");
  const { bucketVersions } = JSON.parse(fs.readFileSync(at("catalog.json"), "utf8"));
  const pin = PIN_RE.exec(pkgText)?.[2];
  const target = pin && bucketVersions?.[pin.split(".")[0]];
  const good = KNOWN_GOOD_RE.exec(shimsText)?.slice(2, 5).join(".");
  let oldBlocking = [];
  let newBlocking = [];
  if (target && good && parse(target) && newer(parse(target), parse(good)) && target.split(".")[0] === good.split(".")[0]) {
    oldBlocking = blockingFiles(await fetchPkg(good));
    newBlocking = blockingFiles(await fetchPkg(target));
  }
  const plan = planSync({ pkgText, presetsText, shimsText, target, oldBlocking, newBlocking });
  fs.writeFileSync(at("apps/authoring/package.json"), plan.pkgText);
  fs.writeFileSync(at("apps/authoring/src/theme/presets.ts"), plan.presetsText);
  fs.writeFileSync(at("packages/runtime/src/dep-shims.ts"), plan.shimsText);
  return plan.notes;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const notes = await syncAuthoringPin({ root });
  console.log(notes.length ? notes.join("\n") : "authoring pin and known-good already in step");
}
