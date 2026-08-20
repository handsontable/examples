// One rule for "is this HTML URL a file in the sandbox, or something the browser
// fetches?", shared by the two places that must agree on it: `transpile.ts`, which
// drops `<link>` tags whose local target is missing, and `head-assets.ts`, which
// re-creates the head assets the bundler discarded. If the two ever disagreed, a
// link one of them dropped would be resurrected by the other.

/** Normalize an HTML src/href value to a files-map key ("/…"), or null if external. */
export function toFilesKey(value: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(value)) return null; // http:, data:, protocol-relative …
  if (value.startsWith("/")) return value;
  if (value.startsWith("./")) return `/${value.slice(2)}`;
  return `/${value}`;
}
