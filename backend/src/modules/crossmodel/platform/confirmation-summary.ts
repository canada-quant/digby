/**
 * Honest preview clip for staged-confirmation summaries — the loopjacking
 * representation-mismatch fix (R&D test-bench experiment #4, goal b3f240e4
 * todo cd366b85; arXiv:2609.21081 "Loopjacking: Hijacking Human-in-the-Loop
 * Approval").
 *
 * The staged-confirmation pipeline is byte-bound end-to-end (args deep-frozen
 * at registration, confirm executes the stored row — pending-confirmations.ts;
 * no client/model args channel on either confirm path), but the OWNER'S
 * APPROVAL REPRESENTATION was not: summarizeConsequentialCall and
 * stageAccountTool clipped user-authored payload fields at ~100 chars
 * SILENTLY, so the pending-action card showed a benign-looking prefix while
 * the full staged body executed. That is the paper's first attack class — a
 * representation mismatch between what the human approves and what executes.
 *
 * Every preview clip now carries the hidden count and what executes, so the
 * card can never pretend to be the whole payload. Length (not a hash) is the
 * honest signal: the owner holds no independent copy of the hidden tail to
 * compare a hash against — the marker tells them the preview is incomplete
 * and to ask the chat for the full staged text before clicking Confirm.
 */
export function clipStagedPayloadPreview(value: unknown, n = 120): string {
  const clean = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= n) return clean;
  return `${clean.slice(0, n)} …[+${clean.length - n} chars not shown — the FULL staged text executes on Confirm]`;
}
