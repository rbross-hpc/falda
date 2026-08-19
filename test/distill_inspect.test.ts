/**
 * Tests for `falda distill inspect` (src/inspect/).
 *
 * Fully offline: temp root on disk, deterministic local embedder, mock LLM,
 * no network, no server. Mirrors the stats.test.ts / distill_core.test.ts
 * setup patterns.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PoolManager } from "../src/pools.js";
import { makeLocalEmbedder } from "../src/embedder.js";
import { distillOnce } from "../src/distill/core.js";
import { listAllStores } from "../src/stats.js";
import {
  listDistillationPasses, buildInspectReport, getDecisionEvidence, getPassDecisions,
} from "../src/inspect/distill.js";
import { computeInspectionWarnings, resolveInspectWarnThresholds } from "../src/inspect/warnings.js";
import { renderHuman, renderJson } from "../src/inspect/format.js";
import { buildDistillFixture } from "../src/inspect/fixture.js";
import Database from "better-sqlite3";

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "falda-inspect-"));
}

function makeMockLLM(responses: string[]): (prompt: string) => Promise<string> {
  const queue = [...responses];
  return async (prompt: string): Promise<string> => {
    const r = queue.shift();
    if (r === undefined) throw new Error(`Mock LLM ran out of responses (prompt: ${prompt.slice(0, 80)})`);
    return r;
  };
}

describe("distill inspect", () => {
  let root: string;
  let pools: PoolManager;

  before(async () => {
    root = makeTempRoot();
    pools = new PoolManager({ root, embed: makeLocalEmbedder(32), dim: 32 });

    // ── acme:self — one pass: 2 store + 1 skip, 2 scenes created, core regenerated.
    const acme = pools.resolve("acme", undefined, true);
    await acme.addStream("sess-1", [
      { role: "user", content: "The deploy script lives in bin/release" },
      { role: "user", content: "Run docker compose up --build" },
    ]);
    await distillOnce(acme, makeMockLLM([
      [
        `{"type":"fact","content":"The deploy script lives in bin/release.","confidence":"high"}`,
        `{"type":"fact","content":"Run docker compose up --build.","confidence":"low"}`,
      ].join("\n"),
      // Batched: one reply covering both candidates (see
      // docs/future/distill-consolidation-batching.md).
      JSON.stringify([
        { candidate: 0, action: "store", target_ids: [], rationale: "New durable fact." },
        { candidate: 1, action: "skip", target_ids: [], rationale: "Transient operational command, not durable memory." },
      ]),
      "Deploy workflow session", "Discussed the deploy script location.",
      "Deployment tooling", "Covers deployment scripts and tooling.",
      "# Agent core\n\nKnows deploy script in bin/release.",
    ]), { storeKey: "acme:self", model: "gpt-4o-mini", promptVersion: "v1", distillerVersion: "0.1.0" });

    // Second pass on acme: update the deploy atom.
    await acme.addStream("sess-1", [{ role: "user", content: "actually it moved to scripts/release" }]);
    const existingAtomId = acme.queryAtoms({}).items.find((a) => a.content.includes("bin/release"))!.id;
    await distillOnce(acme, makeMockLLM([
      `{"type":"fact","content":"The deploy script lives in scripts/release.","confidence":"high"}`,
      `{"action":"update","target_ids":["${existingAtomId}"],"rationale":"New evidence supersedes prior location."}`,
      "Deploy workflow session", "Deploy script moved.",
      "Deployment tooling", "Covers deployment scripts and tooling.",
      "# Agent core\n\nDeploy script now in scripts/release.",
    ]), { storeKey: "acme:self", model: "gpt-4o-mini", promptVersion: "v1", distillerVersion: "0.1.0" });

    // ── beta:self — separate tenant/store, one pass, no decisions overlap with acme.
    const beta = pools.resolve("beta", undefined, true);
    await beta.addStream("sess-b", [{ role: "user", content: "the sensor calibrates at 4.2K" }]);
    await distillOnce(beta, makeMockLLM([
      `{"type":"fact","content":"The sensor calibrates at 4.2K.","confidence":"high"}`,
      `{"action":"store","target_ids":[],"rationale":"New fact."}`,
      "Calibration session", "Sensor calibration discussed.",
      "Physics", "Physics facts.",
      "# Core\nSensor at 4.2K.",
    ]), { storeKey: "beta:self", model: "gpt-4o-mini", promptVersion: "v1", distillerVersion: "0.1.0" });

    // ── never-distilled:self — has stream data but no distillation_passes row.
    const never = pools.resolve("never-distilled", undefined, true);
    await never.addStream("sess-n", [{ role: "user", content: "hello" }]);

    pools.closeAll();
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  test("lists newest passes first", () => {
    const passes = listDistillationPasses({ root, tenant: "acme" });
    assert.equal(passes.length, 2);
    assert.ok(passes[0].started_at >= passes[1].started_at, "newest first");
  });

  test("--last filtering caps result count", () => {
    const passes = listDistillationPasses({ root, tenant: "acme", last: 1 });
    assert.equal(passes.length, 1);
  });

  test("--since filtering excludes passes older than the window", () => {
    const none = listDistillationPasses({ root, tenant: "acme", sinceMs: 1 }); // 1ms window — everything excluded
    assert.equal(none.length, 0);
    const all = listDistillationPasses({ root, tenant: "acme", sinceMs: 3_600_000 });
    assert.equal(all.length, 2);
  });

  test("--action filtering only returns passes containing that action", () => {
    const updatePasses = listDistillationPasses({ root, tenant: "acme", actions: ["update"] });
    assert.equal(updatePasses.length, 1);
    const skipPasses = listDistillationPasses({ root, tenant: "acme", actions: ["skip"] });
    assert.equal(skipPasses.length, 1);
    // Both skip and update passes are distinct passes here.
    assert.notEqual(updatePasses[0].pass_id, skipPasses[0].pass_id);
  });

  test("--pass exact lookup returns exactly one pass", () => {
    const all = listDistillationPasses({ root, tenant: "acme" });
    const target = all[1].pass_id; // the first (oldest) pass
    const found = listDistillationPasses({ root, tenant: "acme", passId: target });
    assert.equal(found.length, 1);
    assert.equal(found[0].pass_id, target);
  });

  test("cross-tenant inspection is rejected — wrong tenant sees nothing", () => {
    const report = buildInspectReport({ root, tenant: "acme" });
    const wrongTenant = buildInspectReport({ root, tenant: "nonexistent-tenant" });
    assert.ok(report.passes.length > 0);
    assert.equal(wrongTenant.passes.length, 0);
    // acme's passes never leak into beta's scope either.
    const betaReport = buildInspectReport({ root, tenant: "beta" });
    assert.ok(betaReport.passes.every((p) => p.store_key === "beta:self"));
  });

  test("only instrumented passes are listed — a store with stream but no distillation is invisible", () => {
    const passes = listDistillationPasses({ root, tenant: "never-distilled" });
    assert.equal(passes.length, 0, "no distillation_passes row exists for this store");
  });

  test("skipped candidate remains inspectable after the pass (regression)", () => {
    const report = buildInspectReport({ root, tenant: "acme", actions: ["skip"] });
    assert.equal(report.passes.length, 1);
    const skipDecision = report.passes[0].decisions.find((d) => d.action === "skip");
    assert.ok(skipDecision, "skip decision present");
    assert.equal(skipDecision!.candidate.type, "fact");
    assert.equal(skipDecision!.candidate.content, "Run docker compose up --build.");
    assert.equal(skipDecision!.candidate.confidence, "low");
    assert.equal(skipDecision!.atom_id, null, "no durable atom for a skip");
  });

  test("evidence resolves through stream.id for a skip (pass-window fallback)", () => {
    const report = buildInspectReport({ root, tenant: "acme", actions: ["skip"], evidence: true });
    const pass = report.passes[0];
    const skipDecision = pass.decisions.find((d) => d.action === "skip")!;
    const evidence = pass.evidence![skipDecision.id];
    assert.ok(evidence.turns.length > 0, "evidence turns present for skip via window fallback");
    assert.ok(evidence.turns.some((t) => t.content.includes("docker compose")));
  });

  test("evidence resolves through stream.id via atom_evidence for a stored atom", () => {
    const report = buildInspectReport({ root, tenant: "acme", actions: ["store"], evidence: true, last: 1 });
    const storePass = report.passes.find((p) => p.decisions.some((d) => d.action === "store"));
    assert.ok(storePass);
    const storeDecision = storePass!.decisions.find((d) => d.action === "store")!;
    const evidence = storePass!.evidence![storeDecision.id];
    assert.ok(evidence.turns.length > 0);
    assert.ok(evidence.turns.every((t) => t.stream_id));
  });

  test("update decision displays old + replacement atom ids", () => {
    const report = buildInspectReport({ root, tenant: "acme", actions: ["update"] });
    const updateDecision = report.passes[0].decisions.find((d) => d.action === "update")!;
    assert.equal(updateDecision.target_ids.length, 1, "old atom id present");
    assert.ok(updateDecision.atom_id, "new atom id present");
    assert.notEqual(updateDecision.atom_id, updateDecision.target_ids[0]);
  });

  test("merge displays all absorbed targets", async () => {
    // Separate store dedicated to a merge scenario.
    const mergeStore = pools.resolve("merge-tenant", undefined, true);
    await mergeStore.addStream("sess-m", [{ role: "user", content: "seed" }]);
    const a1 = await mergeStore.upsertAtom({ id: "atom-1", type: "fact", content: "Fact A." });
    const a2 = await mergeStore.upsertAtom({ id: "atom-2", type: "fact", content: "Fact B." });
    await mergeStore.addStream("sess-m", [{ role: "user", content: "A and B are the same thing" }]);

    await distillOnce(mergeStore, makeMockLLM([
      `{"type":"fact","content":"Facts A and B describe the same thing.","confidence":"high"}`,
      `{"action":"merge","target_ids":["atom-1","atom-2"],"rationale":"These describe the same durable configuration."}`,
      "Merge session", "Merged facts.",
      "Merge topic", "Merged facts summary.",
      "# Core\nMerged.",
    ]), { storeKey: "merge-tenant:self", model: "gpt-4o-mini", promptVersion: "v1", distillerVersion: "0.1.0" });

    const report = buildInspectReport({ root, tenant: "merge-tenant" });
    const mergeDecision = report.passes[0].decisions.find((d) => d.action === "merge")!;
    assert.deepEqual(mergeDecision.target_ids.sort(), ["atom-1", "atom-2"]);
    assert.ok(mergeDecision.atom_id, "winner atom id present");
  });

  test("scene membership deltas are correct", () => {
    const report = buildInspectReport({ root, tenant: "acme", last: 2 });
    const firstPass = report.passes[report.passes.length - 1]; // oldest of the two
    const episodeEffect = firstPass.scenes.find((s) => s.scene_kind === "episode")!;
    assert.equal(episodeEffect.effect, "created");
    assert.equal(episodeEffect.members_before, 0);
    assert.equal(episodeEffect.members_after, 1);
    assert.equal(episodeEffect.added.length, 1);
  });

  test("Core changed/skipped detection is correct", () => {
    const report = buildInspectReport({ root, tenant: "acme" });
    for (const p of report.passes) {
      assert.ok(p.core, "core effect recorded for every pass");
      assert.equal(p.core!.effect, "regenerated");
      assert.equal(p.core_changed, true);
    }
  });

  test("warnings trigger at configured thresholds", () => {
    const thresholds = resolveInspectWarnThresholds({ FALDA_INSPECT_WARN_LARGE_MERGE_ATOMS: "1" } as any);
    const decisions = getPassDecisions(
      // Reuse merge-tenant's db directly for a raw decisions query.
      new Database(listAllStores(root).find((s) => s.label === "merge-tenant:self")!.dbPath, { readonly: true }),
      buildInspectReport({ root, tenant: "merge-tenant" }).passes[0].pass_id,
    );
    const warnings = computeInspectionWarnings({
      input_turn_count: 2, candidate_count: 1, decisions, scenes: [], core: null,
    }, thresholds);
    assert.ok(warnings.some((w) => w.code === "large_merge"), "large_merge warning fires at threshold=1");
  });

  test("JSON and human output derive from the same data", () => {
    const report = buildInspectReport({ root, tenant: "acme" });
    const json = JSON.parse(renderJson(report));
    assert.equal(json.passes.length, report.passes.length);
    assert.equal(json.passes[0].pass_id, report.passes[0].pass_id);
    const human = renderHuman(report);
    assert.ok(human.includes(report.passes[0].pass_id), "human output references the same pass id");
  });

  test("inspection performs no mutations", () => {
    const dbPath = listAllStores(root).find((s) => s.label === "acme:self")!.dbPath;
    const before = fs.readFileSync(dbPath);
    buildInspectReport({ root, tenant: "acme", evidence: true, verbose: true });
    buildInspectReport({ root, tenant: "acme", random: 1 });
    const after = fs.readFileSync(dbPath);
    assert.ok(before.equals(after), "store file bytes unchanged after inspection");
  });

  test("random filtering respects action and store scope", () => {
    const report = buildInspectReport({ root, tenant: "acme", random: 100, actions: ["skip"] });
    assert.ok(report.selection_note?.includes("random sample"));
    for (const p of report.passes) {
      assert.ok(p.decisions.every((d) => d.action === "skip"), "random sample honors --action filter");
      assert.equal(p.store_key, "acme:self", "random sample honors --tenant scope");
    }
  });

  test("fixture export contains candidate, evidence, decision, and resulting atom", () => {
    const report = buildInspectReport({ root, tenant: "acme", actions: ["store"], last: 1, evidence: true });
    const pass = report.passes[0];
    const dbPath = listAllStores(root).find((s) => s.label === "acme:self")!.dbPath;
    const db = new Database(dbPath, { readonly: true });
    const fixture = buildDistillFixture(db, pass);
    db.close();
    assert.ok(fixture.cases.length > 0);
    const c = fixture.cases[0];
    assert.ok(c.candidate.content, "candidate captured");
    assert.ok(c.input_evidence.turns.length > 0, "evidence captured");
    assert.ok(c.applied_decision.action, "decision captured");
    assert.ok(c.resulting_atom_id, "resulting atom captured");
  });
});
