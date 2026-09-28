// containers/o11y/local/redact.mjs
//
// Split out of stop-roundtrip.mjs so it is unit-testable — that file runs
// `main()` unconditionally at module scope, so importing it would run the
// whole real docker-compose roundtrip. Scrubs known secret VALUES (not a
// pattern match) out of text before it is ever printed.

/**
 * @param {string} text
 * @param {ReadonlyArray<string | undefined | null>} secrets
 * @returns {string}
 */
export function scrubSecrets(text, secrets) {
  let out = text ?? "";
  for (const secret of secrets) {
    // A falsy/empty secret would match everywhere (`"".split("")` splits
    // every character) — skip those rather than mangling the text.
    if (secret) out = out.split(secret).join("<redacted>");
  }
  return out;
}
