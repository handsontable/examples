// Structural stand-in for `@cloudflare/containers` under plain `node --test`
// (the real package imports `cloudflare:workers` at load time, which only
// exists inside workerd — the same reason worker-hooks.mjs stubs
// `@cloudflare/sandbox`). Provides just the `Container` surface
// `workers/o11y/src/box.ts` actually uses: a constructor storing
// `ctx`/`env`, `getState()`, `start()`, `containerFetch()`, and the
// lifecycle hooks, all routed through the mutable `hooks` registry below so
// a test can install its own spy/behaviour per call without a mocking
// library. Reset `hooks` to `defaultHooks()` in a `beforeEach`/`afterEach` —
// this module is shared (imported once) across every test in a file.

export function defaultHooks() {
  return {
    // (self, startOptions, waitOptions) -> void
    async start(self, _startOptions, _waitOptions) {
      self._state = { status: "running", lastChange: Date.now() };
    },
    // (self, port|undefined, cancellationOptions|undefined, startOptions|undefined) -> void
    async startAndWaitForPorts(self) {
      self._state = { status: "healthy", lastChange: Date.now() };
    },
    // (self, requestOrUrl, portOrInit, portParam) -> Response
    async containerFetch(_self, _requestOrUrl, _portOrInit, _portParam) {
      return new Response("stub: containerFetch not configured for this call", { status: 500 });
    },
    // (self, signal) -> void
    async stop(self, _signal) {
      self._state = { status: "stopping", lastChange: Date.now() };
    },
  };
}

export const hooks = defaultHooks();

export class Container {
  constructor(ctx, env, options) {
    this.ctx = ctx;
    this.env = env;
    this.options = options;
    this._state = { status: "stopped", lastChange: Date.now() };
  }

  async getState() {
    return { ...this._state };
  }

  async start(startOptions, waitOptions) {
    return hooks.start(this, startOptions, waitOptions);
  }

  async startAndWaitForPorts(portsOrArgs, cancellationOptions, startOptions) {
    return hooks.startAndWaitForPorts(this, portsOrArgs, cancellationOptions, startOptions);
  }

  async containerFetch(requestOrUrl, portOrInit, portParam) {
    return hooks.containerFetch(this, requestOrUrl, portOrInit, portParam);
  }

  async stop(signal) {
    return hooks.stop(this, signal);
  }

  async destroy() {
    this._state = { status: "stopped_with_code", exitCode: 137, lastChange: Date.now() };
  }

  onStart() {}
  onStop(_params) {}
  onActivityExpired() {
    return this.stop();
  }
  onError(error) {
    throw error;
  }
  renewActivityTimeout() {}

  /** T03 addition: the real `Container.schedule()` persists to SQLite and
   *  is later invoked by the base class's own `alarm()` loop — machinery
   *  this stub does not reimplement (see `box.ts`'s own T03 tests,
   *  `o11y-wake.test.mjs`, which monkey-patch `instance.schedule` per test
   *  instead, to observe WHAT gets scheduled without needing real timing).
   *  This default just records the call and never auto-invokes it — a
   *  harmless no-op for every T01 test that calls `wake()`/`#doWake` (which
   *  now schedules the 4-hour hard cap) without caring about scheduling at
   *  all. */
  async schedule(when, callback, payload) {
    this._scheduled ??= [];
    const entry = { taskId: `stub-${this._scheduled.length}`, when, callback, payload };
    this._scheduled.push(entry);
    return entry;
  }
}
