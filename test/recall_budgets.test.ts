/**
 * Recall budget resolution (src/recall/budgets.ts).
 *
 * Covers the two-tier default model (explicit vs. auto), env overrides, and
 * the fallback-on-invalid-input behavior shared by all four resolvers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_AUTO_RECALL_BUDGET,
  DEFAULT_LEGACY_ATOM_BUDGET,
  DEFAULT_MAX_RECALL_BUDGET,
  DEFAULT_RECALL_BUDGET,
  resolveAutoRecallBudget,
  resolveLegacyAtomBudget,
  resolveMaxRecallBudget,
  resolveRecallBudget,
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

test("resolveLegacyAtomBudget: defaults to DEFAULT_LEGACY_ATOM_BUDGET when unset", () => {
  assert.equal(resolveLegacyAtomBudget(undefined), DEFAULT_LEGACY_ATOM_BUDGET);
});

test("env override: a valid positive integer string is honored", () => {
  assert.equal(resolveRecallBudget("9000"), 9000);
  assert.equal(resolveAutoRecallBudget("1234"), 1234);
  assert.equal(resolveMaxRecallBudget("50000"), 50000);
  assert.equal(resolveLegacyAtomBudget("7777"), 7777);
});

test("env override: non-integer values are floored", () => {
  assert.equal(resolveRecallBudget("1000.9"), 1000);
});

test("env override: invalid, zero, or negative values fall back to the default", () => {
  for (const bad of ["not-a-number", "0", "-500", "NaN", "Infinity"]) {
    assert.equal(resolveRecallBudget(bad), DEFAULT_RECALL_BUDGET, `expected fallback for ${bad}`);
  }
});
