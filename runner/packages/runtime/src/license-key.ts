import type { FilesMap } from "./types.js";

/**
 * The internal Handsontable test key (handsontable/handsontable#14133,
 * `handsontable/test/helpers/licenseKey.js`). Works for builds released on or before
 * 2036-11-04; renew it from there.
 *
 * Core skips the license check on handsontable.com and its one-label subdomains, but
 * the live previews run on `*-sandpack.codesandbox.io` (Tier 1) and
 * `<port>-<session>.demos.handsontable.com` (Tier 2), where a keyless grid shows the
 * lock screen. Saved demos (`/d/:id`, `/embed/:id`) are served from
 * demos.handsontable.com itself and need no key.
 */
export const PREVIEW_LICENSE_KEY =
  'This is a Handsontable license key for HANDSONTABLE INTERNAL TEST KEY, issued on 2026-11-04 for the "NOT FOR PRODUCTION USE" project. It includes 1 test license: > 1. INTERNAL TEST KEY for the Handsontable test suites, for builds released on or before 2036-11-04 (UTC). NOT LICENSED FOR PRODUCTION OR ANY OTHER USE. [eyJwcm9kdWN0cyI6eyJoYW5kc29udGFibGUiOnsiY2FwYWJpbGl0aWVzIjpbImNvcmUiXSwicmVsZWFzZV91bnRpbCI6IjIwMzYtMTEtMDQiLCJub3RpY2UiOjAsImdyYWNlIjowLCJmbGFncyI6W119fSwidiI6MiwicHJvc2UiOiJiMjM1MGRmYWQ4YjM4NDMzNmU4MTZhMjU2MzgwNzFlZjU0M2I3ZWQ3ZjhmNjJhNjVjZjFiNTk4NzE2OTU2NDVmIn036525f7e3148e6adf22b9413fdf817c41079854724b09573574ed3ebf0e64e2a940e4a380137db866c6bac0242f06f6caa89713bb1885cedbf18a43095cdd501]';

const PLACEHOLDER = "your-license-key";
const KEY_LITERAL = JSON.stringify(PREVIEW_LICENSE_KEY);

/** `// licenseKey: 'your-license-key', // …` and Angular's `// license: …` global config. */
const OPTION_LINE = /^([ \t]*)\/\/[ \t]*(licenseKey|license):[ \t]*(['"])your-license-key\3[^\r\n]*/gm;
/** `// licenseKey="your-license-key" // …` inside a JSX opening tag. */
const JSX_LINE = /^([ \t]*)\/\/[ \t]*licenseKey="your-license-key"[^\r\n]*/gm;
/** `<!-- licenseKey="your-license-key" … -->` written above a Vue `<HotTable` tag. */
const VUE_COMMENT = /<!--[ \t]*licenseKey="your-license-key"(?:(?!-->)[\s\S])*-->(\s*)<(HotTable|hot-table)\b/g;

function inject(source: string): string {
  return source
    .replace(OPTION_LINE, (_m, indent: string, prop: string) => `${indent}${prop}: ${KEY_LITERAL},`)
    .replace(JSX_LINE, (_m, indent: string) => `${indent}licenseKey={${KEY_LITERAL}}`)
    .replace(VUE_COMMENT, (_m, gap: string, tag: string) => `${gap}<${tag} license-key='${PREVIEW_LICENSE_KEY}'`);
}

/**
 * Turn the commented-out `licenseKey` placeholder into a live option holding the test
 * key. Apply it only to the files the preview executes, never to the authored map:
 * Download-zip, fork, save and the StackBlitz/CodeSandbox exports must keep the
 * placeholder. A key the user typed in is not the placeholder and is left alone.
 * Returns the same map when nothing matched.
 */
export function injectPreviewLicenseKey(files: FilesMap): FilesMap {
  let out: FilesMap | null = null;
  for (const [path, source] of Object.entries(files)) {
    if (!source.includes(PLACEHOLDER) || path.endsWith(".json")) continue;
    const next = inject(source);
    if (next === source) continue;
    out ??= { ...files };
    out[path] = next;
  }
  return out ?? files;
}
