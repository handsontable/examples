// containers/o11y/local/redact.mjs
//
// A-I1: split out of stop-roundtrip.mjs so it is unit-testable — that file
// runs `main()` unconditionally at module scope (it is a CLI script, not a
// library), so importing it directly from a test would run the whole real
// docker-compose roundtrip.
//
// Scrubs a fixed list of known secret VALUES (not a pattern match) out of
// arbitrary text before it is ever printed. Used by stop-roundtrip.mjs's
// `sh()` on every command-failure log line (cmd, stdout, stderr), so a
// transient `docker exec` failure into MinIO's admin CLI — which embeds the
// root MINIO_PASSWORD, and, for the restricted-user setup calls, that user's
// generated password, in plain text in the shell script it runs — never
// leaks either value into stdout/stderr (CI logs, a developer's terminal).

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
