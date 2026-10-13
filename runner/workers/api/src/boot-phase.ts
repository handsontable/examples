// Which step the boot script is in, read off the `::...::` markers it echoes into
// the boot log (`index.ts`, the Tier-2 session script). The marker line is found by
// grep over the whole log, because the 2500-byte tail the status route returns has
// long since scrolled past it once the dev server starts logging.
//
// Free of Cloudflare imports so `pipeline/` can exercise it directly.

export type BootStatusPhase = "seeding" | "installing" | "starting";

const SEPARATOR = "__BOOT_LOG__";

/** The markers the boot script echoes, by the phase each one starts. */
const MARKERS: readonly [string, BootStatusPhase][] = [
  ["::seeding", "seeding"],
  ["::reconciling", "installing"],
  ["::starting", "starting"],
];

/** One shell command: the newest phase marker line, the separator, then the log tail. */
export function bootStatusCommand(logPath: string): string {
  return (
    `sh -lc "grep -E '^::(seeding|reconciling|starting)' ${logPath} 2>/dev/null | tail -n 1; ` +
    `echo ${SEPARATOR}; tail -c 2500 ${logPath} 2>/dev/null || true"`
  );
}

/** Inverse of `bootStatusCommand`. Output without the separator is a bare log tail. */
export function splitBootStatus(stdout: string): { phase: BootStatusPhase | undefined; log: string } {
  const at = stdout.indexOf(`${SEPARATOR}\n`);
  if (at === -1) return { phase: undefined, log: stdout };
  const marker = stdout.slice(0, at).trim();
  const phase = MARKERS.find(([prefix]) => marker.startsWith(prefix))?.[1];
  return { phase, log: stdout.slice(at + SEPARATOR.length + 1) };
}
