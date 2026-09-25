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

/** `@cloudflare/containers` `dist/lib/helpers.js#parseTimeExpression`:
 *  seconds, from a number or an `"<n>s|m|h"` string. */
function parseTimeExpression(expr) {
  if (typeof expr === "number") return expr;
  const match = /^(\d+)([smh])$/.exec(expr);
  if (!match) throw new Error(`invalid time expression ${expr}`);
  const value = parseInt(match[1], 10);
  return match[2] === "s" ? value : match[2] === "m" ? value * 60 : value * 3600;
}

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

  // ---- in-flight accounting and the idle clock (F6, V-triage) -------------
  //
  // Mirrors `@cloudflare/containers@0.3.7` `dist/lib/container.js`, because
  // this is what decides whether the `sleepAfter` idle stop can ever fire:
  // - `containerFetch` does `inflightRequests++` (:887) before proxying;
  // - a response WITH a body is returned as `new Response(readable, res)`
  //   after `res.body.pipeTo(writable).finally(() => decrementInflight())`
  //   through an `IdentityTransformStream` (:955-960), so the count drops
  //   only once the CALLER consumes or cancels that body;
  // - a body-less response, or a throw, decrements at once (:962, :966);
  // - `isActivityExpired()` (:1687-1692) returns false and renews the clock
  //   while `inflightRequests > 0`; the base `alarm()` loop calls it and
  //   `onActivityExpired()` → `stop()` only when it returns true (:1566).
  // Before this, `renewActivityTimeout()` was a no-op and nothing counted,
  // so a caller that never released a response body (box.ts `isReady()`
  // did exactly that on every probe) looked idle here and pinned the real
  // container awake until the 4-hour cap. Deviations: a hook that THROWS
  // still throws (the real library turns it into a 500 response), so
  // existing tests that inject a throw keep their meaning; WebSocket
  // responses are not modelled (nothing here proxies one).
  inflightRequests = 0;
  sleepAfterMs = 0;

  async containerFetch(requestOrUrl, portOrInit, portParam) {
    this.inflightRequests++;
    let res;
    try {
      this.renewActivityTimeout();
      res = await hooks.containerFetch(this, requestOrUrl, portOrInit, portParam);
    } catch (e) {
      this.decrementInflight();
      throw e;
    }
    if (res.body !== null) {
      const { readable, writable } = new TransformStream();
      res.body
        .pipeTo(writable)
        .finally(() => this.decrementInflight())
        // The library leaves this rejection (a cancelled body) unhandled;
        // under node it would crash the test process instead.
        .catch(() => {});
      return new Response(readable, res);
    }
    this.decrementInflight();
    return res;
  }

  decrementInflight() {
    this.inflightRequests = Math.max(0, this.inflightRequests - 1);
    if (this.inflightRequests === 0) this.renewActivityTimeout();
  }

  renewActivityTimeout() {
    this.sleepAfterMs = Date.now() + parseTimeExpression(this.sleepAfter ?? "10m") * 1000;
  }

  isActivityExpired() {
    if (this.inflightRequests > 0) {
      this.renewActivityTimeout();
      return false;
    }
    return this.sleepAfterMs <= Date.now();
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
