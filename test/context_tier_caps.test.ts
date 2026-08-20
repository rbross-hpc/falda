/**
 * Tests for tier-specific per-item caps and skip-and-continue admission in
 * assembleContext() (src/distill/context.ts).
 *
 * Covers the two behavior changes from the old single global 2000-char cap
 * + break-on-first-miss admission loop:
 *   1. T1 atoms and T2 scenes now truncate at different, independently
 *      tunable caps (FALDA_RECALL_ATOM_ITEM_CAP / FALDA_RECALL_SCENE_ITEM_CAP,
 *      src/recall/budgets.ts) instead of one shared PER_ITEM_CHAR_LIMIT.
 *   2. A ranked candidate that doesn't fit the tier's remaining budget is
 *      skipped, not treated as end-of-tier — lower-ranked candidates that
 *      *do* fit still get admitted instead of the whole tier going unused.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Falda } from "../src/falda.js";
import { makeLocalEmbedder } from "../src/embedder.js";
import { assembleContext } from "../src/distill/context.js";
import { DEFAULT_ATOM_ITEM_CAP, DEFAULT_SCENE_ITEM_CAP } from "../src/recall/budgets.js";

function makeStore(dim = 32) {
  const blobDir = fs.mkdtempSync(path.join(os.tmpdir(), "falda-context-caps-"));
  const s = new Falda({ dbPath: ":memory:", blobDir, embed: makeLocalEmbedder(dim), dim });
  return { s, blobDir };
}

function cleanup(s: Falda, blobDir: string) {
  s.close();
  fs.rmSync(blobDir, { recursive: true, force: true });
}

describe("assembleContext: tier-specific per-item caps", () => {
  test("T1 atom content truncates at the atom cap, not a larger scene-sized cap", async () => {
    const { s, blobDir } = makeStore();
    try {
      const longContent = "atom filler content about widgets ".repeat(100); // well over DEFAULT_ATOM_ITEM_CAP
      await s.upsertAtom({ type: "fact", content: longContent });
      const ctx = await assembleContext(s, "widgets", 20000);
      assert.ok(ctx.ranked_atoms.length > 0, "atom admitted");
      assert.ok(
        ctx.ranked_atoms[0].length <= DEFAULT_ATOM_ITEM_CAP,
        `atom truncated to <= ${DEFAULT_ATOM_ITEM_CAP} chars, got ${ctx.ranked_atoms[0].length}`,
      );
      assert.ok(ctx.ranked_atoms[0].endsWith("..."), "truncated with ellipsis");
    } finally { cleanup(s, blobDir); }
  });

  test("T2 scene content truncates at the (larger) scene cap, not the atom cap", async () => {
    const { s, blobDir } = makeStore();
    try {
      const a = await s.upsertAtom({ type: "fact", content: "widget calibration fact" });
      const longSummary = "widget calibration details and history. ".repeat(80); // over atom cap, may exceed scene cap too
      await s.upsertScene({
        scene_kind: "topic", title: "Widget calibration", atom_ids: [a.id], summary: longSummary,
      });
      const ctx = await assembleContext(s, "widget calibration", 20000);
      assert.ok(ctx.scenes.length > 0, "scene admitted");
      assert.ok(
        ctx.scenes[0].length <= DEFAULT_SCENE_ITEM_CAP,
        `scene truncated to <= ${DEFAULT_SCENE_ITEM_CAP} chars, got ${ctx.scenes[0].length}`,
      );
      // The scene cap is strictly larger than the atom cap by construction
      // (see src/recall/budgets.ts) — a scene should be able to carry more
      // content than an atom would be allowed to.
      assert.ok(DEFAULT_SCENE_ITEM_CAP > DEFAULT_ATOM_ITEM_CAP, "scene cap > atom cap (sanity)");
    } finally { cleanup(s, blobDir); }
  });
});

describe("assembleContext: skip-and-continue admission (does not stop at first non-fitting item)", () => {
  test("an oversized top-ranked atom is skipped, not a tier-ending break — smaller lower-ranked atoms still get admitted", async () => {
    const { s, blobDir } = makeStore();
    try {
      // High priority (0) => highest priorityWeight => ranks above the
      // default-priority (100) atoms below, regardless of rrf tie-breaking.
      await s.upsertAtom({
        id: "big",
        type: "fact",
        content: "widget calibration ".repeat(80), // truncates to DEFAULT_ATOM_ITEM_CAP (600) chars
        priority: 0,
      });
      await s.upsertAtom({ id: "small-1", type: "fact", content: "widget calibration note one", priority: 100 });
      await s.upsertAtom({ id: "small-2", type: "fact", content: "widget calibration note two", priority: 100 });

      // atoms tier fraction is 0.40 by default; pick a total budget whose
      // atoms allowance is smaller than the truncated "big" atom (600 chars)
      // but comfortably fits both small atoms after skipping it.
      const budget = 250; // atoms allowance = floor(250*0.40) = 100
      const ctx = await assembleContext(s, "widget calibration", budget);

      const admittedIds = ctx.items.filter((i) => i.tier === "T1" && i.source === "ranked").map((i) => i.id);
      assert.ok(!admittedIds.includes("big"), "oversized top-ranked atom does not fit and is excluded");
      assert.ok(
        admittedIds.includes("small-1") || admittedIds.includes("small-2"),
        `at least one smaller lower-ranked atom should still be admitted after skipping 'big' (got: ${admittedIds.join(",")})`,
      );
      assert.equal(ctx.truncated, true, "truncated flag set since at least one candidate did not fit");
    } finally { cleanup(s, blobDir); }
  });

  test("an oversized top-ranked scene is skipped, not a tier-ending break — a smaller lower-ranked scene still gets admitted", async () => {
    const { s, blobDir } = makeStore();
    try {
      const aBig = await s.upsertAtom({ content: "widget calibration alpha", type: "fact" });
      await s.upsertScene({
        scene_id: "scene-big",
        scene_kind: "topic",
        title: "Widget calibration deep dive",
        atom_ids: [aBig.id],
        summary: "widget calibration deep dive details. ".repeat(60), // truncates to DEFAULT_SCENE_ITEM_CAP
      });

      const aSmall = await s.upsertAtom({ content: "widget calibration beta", type: "fact" });
      await s.upsertScene({
        scene_id: "scene-small",
        scene_kind: "topic",
        title: "Widget calibration notes",
        atom_ids: [aSmall.id],
        summary: "short note",
      });

      // scenes tier fraction is 0.25 by default; pick a budget whose scenes
      // allowance is smaller than the truncated big scene but fits the small one.
      const budget = 800; // scenes allowance = floor(800*0.25) = 200
      const ctx = await assembleContext(s, "widget calibration", budget);

      const admittedSceneIds = ctx.items.filter((i) => i.tier === "T2").map((i) => i.id);
      assert.ok(!admittedSceneIds.includes("scene-big"), "oversized scene excluded");
      // Both candidates are deterministically ranked (local embedder, no
      // network/randomness) — assert unconditionally that the small scene
      // is admitted, so a regression that abandons the tier entirely after
      // skipping the first candidate is actually caught rather than
      // vacuously passing on an empty result.
      assert.ok(admittedSceneIds.includes("scene-small"), "small scene admitted instead of tier going empty");
    } finally { cleanup(s, blobDir); }
  });
});
