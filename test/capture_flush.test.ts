/**
 * docs/future/reliability-hardening.md finding 9 — OpenCode capture plugin
 * can lose a turn on a failed flush.
 *
 * Covers integrations/opencode/plugin/capture-flush.ts, the extracted
 * pending-text/flush state machine used by falda-capture.ts. Extracted
 * (and imported directly here) specifically so this logic is testable by
 * `npm test` without opencode's plugin SDK (@opencode-ai/plugin) installed
 * — that package is a type-only import in falda-capture.ts and is not a
 * dependency of this repo.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CaptureFlushQueue } from "../integrations/opencode/plugin/capture-flush.js";

test("flush(): successful delivery clears pending state and marks flushed", async () => {
  const q = new CaptureFlushQueue();
  const delivered: Array<{ sessionID: string; role: string; text: string }> = [];
  q.recordPart("m1", "sess-1", "hello world");

  await q.flush("m1", "user", async ({ sessionID, role, text }) => {
    delivered.push({ sessionID, role, text });
  });

  assert.equal(delivered.length, 1, "send() called exactly once");
  assert.deepEqual(delivered[0], { sessionID: "sess-1", role: "user", text: "hello world" });
  assert.equal(q.hasPending("m1"), false, "pending entry cleared after success");
  assert.equal(q.hasDeliverableText("m1"), false, "already-flushed id has nothing left to deliver");

  // A second flush attempt is a true no-op — does not call send() again.
  await q.flush("m1", "user", async () => { delivered.push({ sessionID: "x", role: "x", text: "x" }); });
  assert.equal(delivered.length, 1, "flushed id is never re-delivered");
});

test("flush(): a failed send() restores the pending entry instead of losing it", async () => {
  const q = new CaptureFlushQueue();
  q.recordPart("m2", "sess-2", "important turn text");

  await assert.rejects(
    () => q.flush("m2", "assistant", async () => { throw new Error("network down"); }),
    /network down/,
  );

  assert.equal(q.hasPending("m2"), true, "pending entry restored, not lost, after a failed flush");
  assert.equal(q.hasDeliverableText("m2"), true, "the turn is still deliverable — this is the finding 9 fix");
});

test("flush(): settledRole set before the failed attempt is also restored", async () => {
  const q = new CaptureFlushQueue();
  // Simulate message.updated (settle) arriving before the text part —
  // falda-capture.ts's event handler calls setSettledRole() in that case.
  q.setSettledRole("m3", "assistant");
  q.recordPart("m3", "sess-3", "streamed text");
  assert.equal(q.getSettledRole("m3"), "assistant");

  await assert.rejects(
    () => q.flush("m3", "assistant", async () => { throw new Error("boom"); }),
  );

  assert.equal(q.getSettledRole("m3"), "assistant", "settledRole restored after a failed flush");
  assert.equal(q.hasPending("m3"), true);
});

test("flush(): a retry after a failure delivers exactly once (no loss, no duplication)", async () => {
  const q = new CaptureFlushQueue();
  q.recordPart("m4", "sess-4", "retry me");
  let attempts = 0;
  const delivered: string[] = [];

  await assert.rejects(() => q.flush("m4", "user", async () => {
    attempts++;
    throw new Error("first attempt fails");
  }));
  assert.equal(q.hasDeliverableText("m4"), true, "still pending after first failed attempt");

  // A later text-part update (TextPart carries the full accumulated text,
  // not a delta) arrives before the retry — must not lose or duplicate.
  q.recordPart("m4", "sess-4", "retry me");

  await q.flush("m4", "user", async ({ text }) => {
    attempts++;
    delivered.push(text);
  });

  assert.equal(attempts, 2, "exactly two delivery attempts total");
  assert.deepEqual(delivered, ["retry me"], "delivered exactly once, with the correct text");
  assert.equal(q.hasPending("m4"), false);
  assert.equal(q.hasDeliverableText("m4"), false);
});

test("flush(): no-ops when there is nothing pending, or the accumulated text is blank", async () => {
  const q = new CaptureFlushQueue();
  let calls = 0;
  await q.flush("never-seen", "user", async () => { calls++; });
  assert.equal(calls, 0, "no pending entry -> no-op");

  q.recordPart("blank", "sess-5", "   \n  ");
  await q.flush("blank", "user", async () => { calls++; });
  assert.equal(calls, 0, "whitespace-only accumulated text -> no-op, not a spurious delivery");
});

test("recordPart(): overwrites (not appends) — TextPart carries full accumulated text", () => {
  const q = new CaptureFlushQueue();
  q.recordPart("m5", "sess-6", "hello");
  q.recordPart("m5", "sess-6", "hello world");
  assert.equal(q.hasDeliverableText("m5"), true);
  // Verified indirectly: only the latest text is delivered, not a
  // concatenation of both calls.
  return new Promise<void>((resolve, reject) => {
    q.flush("m5", "user", async ({ text }) => {
      try {
        assert.equal(text, "hello world");
        resolve();
      } catch (e) { reject(e); }
    }).catch(reject);
  });
});
