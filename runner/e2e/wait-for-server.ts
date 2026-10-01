/** True once a spawned child is gone, whether it exited (`exitCode`) or was
 *  killed by a signal (`exitCode` stays null and `signalCode` is set). */
export function hasProcessExited(child: { exitCode: number | null; signalCode: NodeJS.Signals | null }): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Polls `url` until it answers (any status). Rejects at `timeoutMs` with the
 *  last fetch error, or immediately once `hasExited()` reports the process
 *  that should be serving it is already gone. */
export function waitForServer(
  url: string,
  timeoutMs: number,
  hasExited: () => boolean = () => false,
  pollMs = 200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (hasExited()) {
        reject(new Error(`the process serving ${url} exited before it answered`));
        return;
      }
      fetch(url)
        .then(() => resolve())
        .catch((err) => {
          if (Date.now() > deadline) reject(err);
          else setTimeout(attempt, pollMs);
        });
    };
    attempt();
  });
}
