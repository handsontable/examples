import type { FilesMap } from "./types.js";

/** The internal test key from handsontable/handsontable#14133 (`handsontable/test/helpers/licenseKey.js`),
 *  valid for builds released on or before 2036-11-04. Previews need it because core's keyless bypass
 *  covers only handsontable.com and one-label subdomains. */
export const PREVIEW_LICENSE_KEY =
  'This is a Handsontable license key for HANDSONTABLE INTERNAL TEST KEY, issued on 2026-11-04 for the "NOT FOR PRODUCTION USE" project. It includes 1 test license: > 1. INTERNAL TEST KEY for the Handsontable test suites, for builds released on or before 2036-11-04 (UTC). NOT LICENSED FOR PRODUCTION OR ANY OTHER USE. [eyJwcm9kdWN0cyI6eyJoYW5kc29udGFibGUiOnsiY2FwYWJpbGl0aWVzIjpbImNvcmUiXSwicmVsZWFzZV91bnRpbCI6IjIwMzYtMTEtMDQiLCJub3RpY2UiOjAsImdyYWNlIjowLCJmbGFncyI6W119fSwidiI6MiwicHJvc2UiOiJiMjM1MGRmYWQ4YjM4NDMzNmU4MTZhMjU2MzgwNzFlZjU0M2I3ZWQ3ZjhmNjJhNjVjZjFiNTk4NzE2OTU2NDVmIn036525f7e3148e6adf22b9413fdf817c41079854724b09573574ed3ebf0e64e2a940e4a380137db866c6bac0242f06f6caa89713bb1885cedbf18a43095cdd501]';

const PLACEHOLDER = "your-license-key";
const KEY_LITERAL = JSON.stringify(PREVIEW_LICENSE_KEY);

/** `// licenseKey: 'your-license-key', // …`, and Angular's `// license: …` global config. */
const OPTION_LINE = new RegExp(`^([ \\t]*)//[ \\t]*(licenseKey|license):[ \\t]*(['"])${PLACEHOLDER}\\3`);
/** `// licenseKey="your-license-key" // …` inside a JSX opening tag. */
const JSX_LINE = new RegExp(`^([ \\t]*)//[ \\t]*licenseKey="${PLACEHOLDER}"`);
/** `<!-- licenseKey="your-license-key" … -->` directly above a Vue `<HotTable` tag. */
const VUE_COMMENT = new RegExp(
  `<!--[ \\t]*licenseKey="${PLACEHOLDER}"(?:(?!-->)[\\s\\S])*-->(\\s*)<(HotTable|hot-table)\\b`,
  "g",
);
/** A live key option or attribute, which the injected one must not override or duplicate. */
const LIVE_KEY = /^[ \t]*(?:licenseKey|license)[ \t]*[:=]/;

/** The last line above `index` with code on it, without a trailing `// …` comment. */
function previousCode(lines: string[], index: number): string {
  for (let i = index - 1; i >= 0; i--) {
    const code = (lines[i] ?? "").replace(/(^|\s)\/\/.*$/, "").trim();
    if (code) return code;
  }
  return "";
}

/** Whether a sibling line of `index` (same indent, same block) already sets a key. */
function siblingHasKey(lines: string[], index: number, indent: string): boolean {
  for (const step of [-1, 1]) {
    for (let i = index + step; i >= 0 && i < lines.length; i += step) {
      const line = lines[i] ?? "";
      if (!line.trim()) continue;
      const lineIndent = /^[ \t]*/.exec(line)?.[0] ?? "";
      if (lineIndent.length < indent.length) break;
      if (lineIndent === indent && LIVE_KEY.test(line)) return true;
    }
  }
  return false;
}

/** Whether the `<HotTable` tag the Vue placeholder sits above already has a key attribute. */
function vueTagHasKey(tag: string): boolean {
  return /\s:?(?:license-key|licenseKey)\s*=/.test(tag.slice(0, tag.indexOf(">") + 1 || undefined));
}

/**
 * Turn a commented-out placeholder in one file into a live option holding the test key. A line is
 * rewritten only where the result parses: after a `,` or `{` for an option, outside JSX children for
 * an attribute. A placeholder whose object or tag already sets a key is left alone.
 */
export function injectPreviewLicenseKeySource(path: string, source: string): string {
  if (!source.includes(PLACEHOLDER) || path.endsWith(".json")) return source;
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const option = OPTION_LINE.exec(line);
    if (option) {
      const indent = option[1] ?? "";
      if (/[,{]$/.test(previousCode(lines, i)) && !siblingHasKey(lines, i, indent)) {
        lines[i] = `${indent}${option[2]}: ${KEY_LITERAL},`;
      }
      continue;
    }
    const jsx = JSX_LINE.exec(line);
    if (jsx) {
      const indent = jsx[1] ?? "";
      if (!/>$/.test(previousCode(lines, i)) && !siblingHasKey(lines, i, indent)) {
        lines[i] = `${indent}licenseKey={${KEY_LITERAL}}`;
      }
    }
  }
  const joined = lines.join("\n");
  return joined.replace(VUE_COMMENT, (match, gap: string, tag: string, offset: number) =>
    vueTagHasKey(joined.slice(offset + match.length - tag.length - 1))
      ? match
      : `${gap}<${tag} license-key='${PREVIEW_LICENSE_KEY}'`,
  );
}

/**
 * The map version of `injectPreviewLicenseKeySource`, for the files a preview executes. Never apply it
 * to the authored map: download, save and the exports keep the placeholder. Returns the same map when
 * nothing changed.
 */
export function injectPreviewLicenseKey(files: FilesMap): FilesMap {
  let out: FilesMap | null = null;
  for (const [path, source] of Object.entries(files)) {
    const next = injectPreviewLicenseKeySource(path, source);
    if (next === source) continue;
    out ??= { ...files };
    out[path] = next;
  }
  return out ?? files;
}
