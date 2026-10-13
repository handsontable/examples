// The injected receiver reports the first rendered grid cell to the shell.
// Executes the shipped source against a fake document, so a probe that
// reads well but never posts fails here.

import test from "node:test";
import assert from "node:assert/strict";
import { GRID_CELL_SELECTOR, SCHEME_MESSAGE_TYPE, SCHEME_RECEIVER_SOURCE } from "../packages/runtime/dist/scheme.js";

/** `cells` is the live answer to the grid selector; `observers` collects what the receiver registers. */
function run({ withObserver = true } = {}) {
  const posted = [];
  const observers = [];
  const state = { cells: 0 };
  const parent = { postMessage: (message) => posted.push(message) };
  const window = { parent, addEventListener() {} };
  const document = {
    documentElement: {},
    adoptedStyleSheets: [],
    querySelector: (selector) => {
      assert.equal(selector, GRID_CELL_SELECTOR);
      return state.cells > 0 ? {} : null;
    },
  };
  class FakeObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      observers.push(this);
    }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  new Function("window", "document", "MutationObserver", SCHEME_RECEIVER_SOURCE)(
    window,
    document,
    withObserver ? FakeObserver : undefined,
  );
  return {
    posted,
    observers,
    mountCell() {
      state.cells = 1;
      for (const o of observers) if (!o.disconnected) o.callback([]);
    },
  };
}

const grids = (posted) => posted.filter((m) => m.grid === true);

test("the receiver announces that it watches for the grid, and reports nothing before one exists", () => {
  const r = run();
  assert.deepEqual(r.posted, [{ source: SCHEME_MESSAGE_TYPE, ready: true, probesGrid: true }]);
});

test("the first rendered cell is reported once and the observer stops", () => {
  const r = run();
  r.mountCell();
  r.mountCell();
  assert.deepEqual(grids(r.posted), [{ source: SCHEME_MESSAGE_TYPE, grid: true }]);
  assert.equal(r.observers[0].disconnected, true);
});

test("a grid already in the document when the receiver runs is reported without an observer", () => {
  const posted = [];
  const window = { parent: { postMessage: (m) => posted.push(m) }, addEventListener() {} };
  const document = { documentElement: {}, adoptedStyleSheets: [], querySelector: () => ({}) };
  new Function("window", "document", "MutationObserver", SCHEME_RECEIVER_SOURCE)(window, document, function Never() {
    throw new Error("no observer is needed once a cell exists");
  });
  assert.deepEqual(posted, [
    { source: SCHEME_MESSAGE_TYPE, ready: true, probesGrid: true },
    { source: SCHEME_MESSAGE_TYPE, grid: true },
  ]);
});

test("without a MutationObserver the receiver does not promise a grid message", () => {
  const r = run({ withObserver: false });
  assert.deepEqual(r.posted, [{ source: SCHEME_MESSAGE_TYPE, ready: true }]);
  assert.equal(r.observers.length, 0);
});
