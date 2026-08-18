/**
 * Pending-text bookkeeping + flush-with-retry for the FALDA opencode
 * capture plugin (falda-capture.ts).
 *
 * Extracted into its own dependency-free module (no @opencode-ai/plugin
 * import) so it can be exercised by `npm test` without opencode's plugin
 * SDK installed — see test/capture_flush.test.ts.
 *
 * Bug this closes (docs/future/reliability-hardening.md finding 9): a
 * naive flush() that deletes the pending entry before calling out to
 * FALDA, then only reverts a "flushed" marker on failure, permanently
 * loses the accumulated turn text on any network/tool-call failure —
 * unless opencode happens to re-emit a full text-part update later, that
 * turn is gone from FALDA for good. flush() here restores the full
 * pre-flush state (the pending entry AND the settled-role marker) on
 * failure, so a later text-part update or settle event — or a caller-
 * driven retry — can still deliver it.
 */

export interface PendingText {
  sessionID: string;
  text: string[];
}

/** Delivers one flushed turn's text. Throwing signals a failed delivery
 *  attempt — CaptureFlushQueue.flush() restores state and rethrows so the
 *  caller can log it. */
export type SendFn = (params: { messageId: string; sessionID: string; role: string; text: string }) => Promise<void>;

export class CaptureFlushQueue {
  // messageID -> accumulated text parts, until the message settles.
  private pending = new Map<string, PendingText>();
  // messageID -> role, for messages whose settle event arrived before
  // their text part(s) did — flush as soon as the text part shows up.
  private settledRole = new Map<string, string>();
  // messageID already successfully flushed, to avoid double-capture.
  private flushedIds = new Set<string>();

  /** TextPart updates carry the full accumulated text, not a delta —
   *  overwrite, don't append. Creates the pending entry if this is the
   *  first part seen for this message id. */
  recordPart(messageId: string, sessionID: string, text: string): void {
    const entry = this.pending.get(messageId) ?? { sessionID, text: [] };
    entry.text = [text];
    this.pending.set(messageId, entry);
  }

  getSettledRole(messageId: string): string | undefined {
    return this.settledRole.get(messageId);
  }

  setSettledRole(messageId: string, role: string): void {
    this.settledRole.set(messageId, role);
  }

  hasPending(messageId: string): boolean {
    return this.pending.has(messageId);
  }

  /** True if this message has a non-empty, not-yet-flushed pending text —
   *  i.e. flush() would actually attempt delivery rather than no-op. */
  hasDeliverableText(messageId: string): boolean {
    if (this.flushedIds.has(messageId)) return false;
    const entry = this.pending.get(messageId);
    return !!entry && entry.text.join("\n").trim().length > 0;
  }

  /**
   * Attempt delivery for `messageId`. No-ops if there's nothing pending,
   * it's already flushed, or the accumulated text is empty/whitespace.
   *
   * On success: pending/settledRole are cleared and flushedIds gains the
   * id — permanently, so a later duplicate event doesn't re-deliver.
   *
   * On failure (send() throws): the pending entry and settled-role marker
   * are both restored to their pre-flush values (flushedIds is also
   * reverted), and the error is rethrown for the caller to log/handle —
   * this is the fix for finding 9: previously only flushedIds was
   * reverted, so the accumulated text was already gone from `pending` and
   * the turn was lost unless another full text-part update happened to
   * arrive later.
   */
  async flush(messageId: string, role: string, send: SendFn): Promise<void> {
    const entry = this.pending.get(messageId);
    if (!entry || this.flushedIds.has(messageId)) return;
    const text = entry.text.join("\n").trim();
    if (!text) return;

    const priorSettledRole = this.settledRole.get(messageId);
    this.pending.delete(messageId);
    this.settledRole.delete(messageId);
    this.flushedIds.add(messageId);
    try {
      await send({ messageId, sessionID: entry.sessionID, role, text });
    } catch (e) {
      this.flushedIds.delete(messageId);
      this.pending.set(messageId, entry);
      if (priorSettledRole !== undefined) this.settledRole.set(messageId, priorSettledRole);
      throw e;
    }
  }
}
