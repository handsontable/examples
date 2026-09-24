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
    //
    // Fix round (finding B-M1): the real `Container.prototype.stop` only
    // signals the process (SIGTERM) and awaits `syncPendingStoppedEvents` —
    // it never sets `status: "stopping"` (that status exists in the
    // library's types and its `ContainerState.setStopping()` method exists,
    // but nothing in the package ever calls it). `getState()` keeps
    // reporting whatever it reported before `stop()` was called
    // (`"running"`/`"healthy"`) until the container process actually exits
    // and the real `onStop` path (or, here, a test explicitly setting
    // `self._state = { status: "stopped", ... }`) reflects that. This used
    // to fabricate `"stopping"`, which is exactly why `box.ts`'s own
    // (now-deleted) `state.status === "stopping"` branch had a test that
    // passed against a state the real library never produces.
    async stop(_self, _signal) {},
  };
}

export const hooks = defaultHooks();

export class Container {
  constructor(ctx, env, options) {
    this.ctx = ctx;
    this.env = env;
    this.options = options;
    // F2 fix (B-I4 — see box.ts's `containerFetch` override): a real
    // `DurableObjectState.container` (public, unlike the base library's own
    // private `this.container` field) is what `box.ts` now ALSO checks
    // before letting the base class's own auto-start path run, because a
    // persisted `getState()` status can lag the real container by a few
    // minutes after a host loss (its own doc comment). Every test in this
    // repo simulates container lifecycle purely by assigning `_state`
    // (directly, or via a `hooks.start`/`hooks.stop` override) — the setter
    // below keeps `ctx.container.running` in lockstep with whatever `_state`
    // a test sets, so every EXISTING test (where the two never actually
    // diverge) keeps passing unchanged. A test that wants to model the B-I4
    // desync itself (a stale "healthy" `_state` after the real process
    // already exited) sets `box.ctx.container.running = false` AFTER
    // setting `_state`, deliberately breaking the lockstep for that one
    // assertion.
    if (!this.ctx.container) this.ctx.container = { running: false };
    this._state = { status: "stopped", lastChange: Date.now() };
  }

  get _state() {
    return this.__state;
  }

  set _state(value) {
    this.__state = value;
    this.ctx.container.running = value?.status === "running" || value?.status === "healthy";
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
