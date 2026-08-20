/**
 * Recall budget resolution (src/recall/budgets.ts).
 *
 * Covers the two-tier default model (explicit vs. auto), env overrides, and
 * the fallback-on-invalid-input behavior shared by all four resolvers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ATOM_ITEM_CAP,
  DEFAULT_AUTO_RECALL_BUDGET,
  DEFAULT_MAX_RECALL_BUDGET,
  DEFAULT_RECALL_BUDGET,
  DEFAULT_SCENE_ITEM_CAP,
  resolveAtomItemCap,
  resolveAutoRecallBudget,
  resolveMaxRecallBudget,
  resolveRecallBudget,
  resolveSceneItemCap,
} from "../src/recall/budgets.js";

test("resolveRecallBudget: defaults to DEFAULT_RECALL_BUDGET when unset", () => {
  assert.equal(resolveRecallBudget(undefined), DEFAULT_RECALL_BUDGET);
  assert.equal(resolveRecallBudget(""), DEFAULT_RECALL_BUDGET);
});

test("resolveAutoRecallBudget: defaults to DEFAULT_AUTO_RECALL_BUDGET when unset", () => {
  assert.equal(resolveAutoRecallBudget(undefined), DEFAULT_AUTO_RECALL_BUDGET);
});

test("auto default is strictly smaller than explicit default", () => {
  assert.ok(DEFAULT_AUTO_RECALL_BUDGET < DEFAULT_RECALL_BUDGET,
    "automatic per-task recall must default smaller than explicit falda_recall");
});

test("resolveMaxRecallBudget: defaults to DEFAULT_MAX_RECALL_BUDGET, and exceeds both tier defaults", () => {
  assert.equal(resolveMaxRecallBudget(undefined), DEFAULT_MAX_RECALL_BUDGET);
  assert.ok(DEFAULT_MAX_RECALL_BUDGET > DEFAULT_RECALL_BUDGET);
  assert.ok(DEFAULT_MAX_RECALL_BUDGET > DEFAULT_AUTO_RECALL_BUDGET);
});

test("env override: a valid positive integer string is honored", () => {
  assert.equal(resolveRecallBudget("9000"), 9000);
  assert.equal(resolveAutoRecallBudget("1234"), 1234);
  assert.equal(resolveMaxRecallBudget("50000"), 50000);
});

test("env override: non-integer values are floored", () => {
  assert.equal(resolveRecallBudget("1000.9"), 1000);
});

test("env override: invalid, zero, or negative values fall back to the default", () => {
  for (const bad of ["not-a-number", "0", "-500", "NaN", "Infinity"]) {
    assert.equal(resolveRecallBudget(bad), DEFAULT_RECALL_BUDGET, `expected fallback for ${bad}`);
  }
});

test("resolveAtomItemCap: defaults to DEFAULT_ATOM_ITEM_CAP when unset, honors env override", () => {
  assert.equal(resolveAtomItemCap(undefined), DEFAULT_ATOM_ITEM_CAP);
  assert.equal(resolveAtomItemCap(""), DEFAULT_ATOM_ITEM_CAP);
  assert.equal(resolveAtomItemCap("750"), 750);
  assert.equal(resolveAtomItemCap("not-a-number"), DEFAULT_ATOM_ITEM_CAP);
});

test("resolveSceneItemCap: defaults to DEFAULT_SCENE_ITEM_CAP when unset, honors env override", () => {
  assert.equal(resolveSceneItemCap(undefined), DEFAULT_SCENE_ITEM_CAP);
  assert.equal(resolveSceneItemCap(""), DEFAULT_SCENE_ITEM_CAP);
  assert.equal(resolveSceneItemCap("2500"), 2500);
  assert.equal(resolveSceneItemCap("0"), DEFAULT_SCENE_ITEM_CAP);
});

test("scene item cap default is strictly larger than atom item cap default", () => {
  assert.ok(DEFAULT_SCENE_ITEM_CAP > DEFAULT_ATOM_ITEM_CAP,
    "scenes need more room than atoms for a title+summary to be useful");
});
