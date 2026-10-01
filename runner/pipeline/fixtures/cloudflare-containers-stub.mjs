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
    // (self) -> void. The SDK's `applyOutboundInterception()`; a test makes it
    // throw to model a missing `ctx.exports.ContainerProxy` or a rejected
    // `interceptOutboundHttp`.
    async applyOutboundInterception(_self) {},
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
    // The real `Container.prototype.stop` only
    // signals the process (SIGTERM) and awaits `syncPendingStoppedEvents` —
    // it never sets `status: "stopping"` (that status exists in the
    // library's types and its `ContainerState.setStopping()` method exists,
    // but nothing in the package ever calls it). `getState()` keeps
    // reporting whatever it reported before `stop()` was called
    // (`"running"`/`"healthy"`) until the container process actually exits
    // and the real `onStop` path (or, here, a test explicitly setting
    // `self._state = { status: "stopped", ... }`) reflects that. This used
    // to fabricate `"stopping"`, which is exactly why `box.ts`'s own
    // a `state.status === "stopping"` branch would have a test that
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

/** Name-only stand-in: `index.ts` re-exports it for workerd's outbound interception. */
export class ContainerProxy {}

/** `@cloudflare/containers@0.3.7` `container.js:41`: class name -> hostname -> handler. */
export const outboundByHostRegistry = new Map();

/** What the SDK's `ContainerProxy.fetch` does (`container.js:199-232`): strip trailing dots
 *  from the hostname, then look the handler up by CLASS NAME in the registry. */
export function proxyLookup(className, url) {
  let hostname = new URL(url).hostname;
  while (hostname.endsWith(".")) hostname = hostname.slice(0, -1);
  return outboundByHostRegistry.get(className)?.[hostname];
}

export class Container {
  // The SDK backs these with the registry (`container.js:272-277`), so a
  // `static outboundByHost = {...}` class field (own property, bypasses the
  // inherited setter) registers nothing and the proxy never finds the handler.
  static get outboundByHost() {
    return outboundByHostRegistry.get(this.name);
  }
  static set outboundByHost(handlers) {
    outboundByHostRegistry.set(this.name, handlers);
  }

  constructor(ctx, env, options) {
    this.ctx = ctx;
    this.env = env;
    this.options = options;
    // See box.ts's `containerFetch` override: a real
    // `DurableObjectState.container` (public, unlike the base library's own
    // private `this.container` field) is what `box.ts` now ALSO checks
    // before letting the base class's own auto-start path run, because a
    // persisted `getState()` status can lag the real container by a few
    // minutes after a host loss (its own doc comment). Every test in this
    // repo simulates container lifecycle purely by assigning `_state`
    // (directly, or via a `hooks.start`/`hooks.stop` override) — the setter
    // below keeps `ctx.container.running` in lockstep with whatever `_state`
    // a test sets, so every EXISTING test (where the two never actually
    // diverge) keeps passing unchanged. A test that wants to model the
    // desync itself (a stale "healthy" `_state` after the real process
    // already exited) sets `box.ctx.container.running = false` AFTER
    // setting `_state`, deliberately breaking the lockstep for that one
    // assertion.
    if (!this.ctx.container) this.ctx.container = { running: false };
    const alreadyRunning = this.ctx.container.running === true;
    this._state = { status: alreadyRunning ? "running" : "stopped", lastChange: Date.now() };
    // SDK `container.js:344`/`:361-369`: a public, writable field, armed once
    // in the constructor when the class registered an outbound handler (the
    // SDK does it inside `blockConcurrencyWhile`, after its first await;
    // nothing here reads it before that settles).
    this.usingInterception = outboundByHostRegistry.get(this.constructor.name) !== undefined;
    // SDK `container.js:370-372`: inside `blockConcurrencyWhile`, after its
    // first await (so subclass fields and prototype methods exist), a container
    // that is already running re-applies the interception, neither awaited nor
    // caught. A microtask models that ordering.
    queueMicrotask(() => {
      if (this.ctx.container.running) this.applyOutboundInterceptionPromise = this.applyOutboundInterception();
    });
  }

  /** SDK `container.js:1170`: TS-private, a plain prototype method at runtime. */
  async applyOutboundInterception() {
    await hooks.applyOutboundInterception(this);
  }

  /** SDK `container.js:1151-1156`. */
  async refreshOutboundInterception() {
    if (!this.usingInterception) return;
    this.applyOutboundInterceptionPromise = this.applyOutboundInterception();
    await this.applyOutboundInterceptionPromise;
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
    // SDK `doStartContainer` (`container.js:1373-1377`): the interception is
    // refreshed before `container.start()` and only when the container is not
    // yet running and `usingInterception` is set; a throw there escapes `start()`.
    if (!this.ctx.container.running && this.usingInterception) {
      await this.refreshOutboundInterception();
    }
    return hooks.start(this, startOptions, waitOptions);
  }

  async startAndWaitForPorts(portsOrArgs, cancellationOptions, startOptions) {
    return hooks.startAndWaitForPorts(this, portsOrArgs, cancellationOptions, startOptions);
  }

  // ---- in-flight accounting and the idle clock ------------------------------
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

  /** The real `Container.schedule()` persists to SQLite and is later
   *  invoked by the base class's own `alarm()` loop — machinery this stub
   *  does not reimplement (see `box.ts`'s own tests, `o11y-wake.test.mjs`,
   *  which monkey-patch `instance.schedule` per test instead, to observe
   *  what gets scheduled without needing real timing). This default just
   *  records the call and never auto-invokes it — a harmless no-op for
   *  every test that calls `wake()`/`#doWake` (which schedules the 4-hour
   *  hard cap) without caring about scheduling at all. */
  async schedule(when, callback, payload) {
    this._scheduled ??= [];
    const entry = { taskId: `stub-${this._scheduled.length}`, when, callback, payload };
    this._scheduled.push(entry);
    return entry;
  }
}
