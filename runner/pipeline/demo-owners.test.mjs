// The owner filter's helpers (DEV-2519).
//
// The counting, the ordering and the matching are what break quietly, so they live
// in a pure module and are covered here rather than through a dropdown.
//
// Run: node --experimental-strip-types --test pipeline/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  filterByOwner,
  isOwnedBy,
  ownerNameFromSlug,
  ownerOptions,
  ownerSlug,
} from "../apps/authoring/src/demoOwners.ts";
// The same formatter the page passes in — imported here as `.ts`, which is how the
// pipeline tests reach app modules.
import { displayNameFromEmail } from "../apps/authoring/src/displayName.ts";

const demo = (createdBy, id = createdBy) => ({ id, created_by: createdBy });

const LIST = [
  demo("marek.martuszewski@handsontable.com", "a"),
  demo("adam.zawadzki@handsontable.com", "b"),
  demo("marek.martuszewski@handsontable.com", "c"),
  demo("mateusz.wojczal@handsontable.com", "d"),
  demo("marek.martuszewski@handsontable.com", "e"),
];

test("a slug is the local part, lowercased", () => {
  assert.equal(ownerSlug("Marek.Martuszewski@Handsontable.com"), "marek.martuszewski");
  assert.equal(ownerSlug("  dev@handsontable.com "), "dev");
  // The URL never carries the domain: these links get pasted around, and everyone
  // here shares one.
  assert.equal(ownerSlug("dev@handsontable.com").includes("@"), false);
  assert.equal(ownerSlug(""), "");
});

test("options are the owners actually present, counted", () => {
  const options = ownerOptions(LIST, displayNameFromEmail);
  assert.deepEqual(options.map((o) => o.label), [
    "Everyone (5)",
    "Adam Zawadzki (1)",
    "Marek Martuszewski (3)",
    "Mateusz Wojczal (1)",
  ]);
  // Everyone first and empty-valued, so it is the default with no URL parameter.
  assert.equal(options[0].value, "");
  assert.equal(options[0].count, LIST.length);
});

test("owners are ordered by the name shown, not by the address", () => {
  // Sorting by email would put `zoe.b` before `adam.zawadzki`; the reader sees
  // names, so the order has to follow those.
  const options = ownerOptions(
    [demo("zoe.brown@handsontable.com"), demo("adam.zawadzki@handsontable.com")],
    displayNameFromEmail,
  );
  assert.deepEqual(options.slice(1).map((o) => o.label), ["Adam Zawadzki (1)", "Zoe Brown (1)"]);
});

test("an empty list still offers Everyone", () => {
  assert.deepEqual(ownerOptions([], displayNameFromEmail), [{ value: "", label: "Everyone (0)", count: 0 }]);
});

test("a row with no owner is counted in the total but gets no option", () => {
  const options = ownerOptions(
    [demo("dev@handsontable.com"), { id: "x", created_by: "" }],
    displayNameFromEmail,
  );
  assert.equal(options[0].label, "Everyone (2)");
  assert.deepEqual(options.slice(1).map((o) => o.value), ["dev"]);
});

test("two casings of one address are one owner, not two", () => {
  // `created_by` has two writers (DEV-2501): the browser stores the broker's
  // casing, the MCP path a normalised one. Options keyed on the raw value would
  // list the same person twice, each with half their demos.
  const options = ownerOptions(
    [demo("Dev@Handsontable.com", "a"), demo("dev@handsontable.com", "b")],
    displayNameFromEmail,
  );
  assert.deepEqual(options.map((o) => o.label), ["Everyone (2)", "Dev (2)"]);
  assert.equal(options[1].value, "dev");
});

test("filtering matches on the slug, case-insensitively", () => {
  assert.deepEqual(filterByOwner(LIST, "marek.martuszewski").map((d) => d.id), ["a", "c", "e"]);
  assert.deepEqual(filterByOwner(LIST, "MAREK.MARTUSZEWSKI").map((d) => d.id), ["a", "c", "e"]);
  assert.deepEqual(filterByOwner(LIST, " mateusz.wojczal ").map((d) => d.id), ["d"]);
});

test("no filter means everything, and an unknown owner means nothing", () => {
  assert.equal(filterByOwner(LIST, "").length, LIST.length);
  // The URL is user-editable, so an unrecognized owner is a normal input, not an
  // error — they simply have no demos here.
  assert.deepEqual(filterByOwner(LIST, "nobody.here"), []);
});

test("the empty-result line names the person", () => {
  assert.equal(ownerNameFromSlug("marek.martuszewski", displayNameFromEmail), "Marek Martuszewski");
});

test("isOwnedBy folds case — two writers fill created_by (DEV-2501)", () => {
  // The browser stores the broker's address as-is; the MCP service path stores a
  // normalised one. An exact match rendered your own demo as a stranger's.
  assert.ok(isOwnedBy("dev@handsontable.com", "Dev@Handsontable.com"));
  assert.ok(isOwnedBy("Dev@Handsontable.com", "dev@handsontable.com"));
  assert.ok(!isOwnedBy("other@handsontable.com", "dev@handsontable.com"));
  // Never let two blanks add up to ownership of a row.
  assert.ok(!isOwnedBy("", ""));
  assert.ok(!isOwnedBy(null, undefined));
});
