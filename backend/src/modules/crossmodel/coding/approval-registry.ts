/**
 * Digby Code — in-memory permission-approval registry (ask mode).
 *
 * When the agent hits a mutating tool in "ask" mode it emits a permission_request
 * SSE event and awaits a decision here. The client resolves it via
 * POST /coding/approvals/:approvalId. The registry itself stays PROCESS-LOCAL
 * (the worker awaits the promise), but cross-process transport rides Redis
 * (Phase 2 LEG 2c): awaitApproval publishes a pending-presence key the WEB
 * resolve endpoint uses for its ownership check, and the decision comes back
 * via the session's resolution mailbox, which the run executor drains into
 * applyApprovalResolution. The pending key is unpublished on BOTH exits
 * (resolve + timeout) so the endpoint can't see a stale pending.
 *
 * Phase 4 (pending-durable.ts): every wait also writes a DURABLE Redis record
 * keyed by id + a per-session fingerprint pointer (tool+args), so a decision
 * survives a worker restart — see pending-durable.ts for the three flows
 * (replay / alias / endpoint fallback).
 */

import { publishApprovalPending, unpublishApprovalPending } from './session-run-lock';
import {
  aliasDurableFingerprint, findDurableByFingerprint, fingerprintFor, markDurableResolved, saveDurablePending,
} from './pending-durable';

type Decision = 'allow' | 'always' | 'deny';

interface Pending {
  resolve: (d: Decision) => void;
  timer: ReturnType<typeof setTimeout>;
  sessionId: string; // owning session — so the resolve endpoint can verify ownership
}

const pending = new Map<string, Pending>();
// MUST stay below the agent's TOOL_HARD_TIMEOUT_MS (15 min). If a decision could
// arrive AFTER the tool call was already abandoned by the hard timeout, the
// approved mutation would execute invisibly in the background. Auto-denying first
// closes that race — a late click resolves an already-removed id (no-op).
// 14 min (raised with the hard timeout, owner max-out directive 2026-07-22) —
// an ask-mode user who stepped away gets a real window to come back and click.
const APPROVAL_TIMEOUT_MS = 14 * 60 * 1000;

let counter = 0;
export function newApprovalId(sessionId: string): string {
  counter = (counter + 1) % 1e9;
  return `${sessionId.slice(0, 8)}-${Date.now().toString(36)}-${counter}`;
}

/** Await a decision for approvalId (auto-deny after timeout). attentionSummary
 *  feeds the fleet supervisor's attention_needed hook event (slice B).
 *  fingerprintSeed (Phase 4) — a stable identity for the CALL (tool + args):
 *  a restarted run that re-asks an already-decided call resolves immediately
 *  with the recorded decision; a re-ask of a still-pending call aliases the
 *  fingerprint so a click on the OLD id resolves THIS wait. */
export function awaitApproval(approvalId: string, sessionId: string, attentionSummary?: string, fingerprintSeed?: string, tool?: string): Promise<Decision> {
  return new Promise<Decision>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(approvalId);
      void unpublishApprovalPending(approvalId); // the web endpoint must not see a stale pending
      void markDurableResolved('approval', approvalId, 'expired', 'deny');
      resolve('deny');
    }, APPROVAL_TIMEOUT_MS);
    pending.set(approvalId, { resolve, timer, sessionId });
    // Cross-process presence: the web resolve endpoint finds the owning session
    // via Redis and RPUSHes the decision into the session's resolution mailbox.
    void publishApprovalPending(approvalId, sessionId, attentionSummary);
    // Phase 4 — durable record + fingerprint replay/aliasing (fail-open).
    void (async () => {
      const fp = fingerprintSeed ? fingerprintFor('approval', fingerprintSeed) : null;
      if (fp) {
        const prior = await findDurableByFingerprint('approval', sessionId, fp);
        if (prior && (prior.status === 'answered' || prior.status === 'denied')
          && ['allow', 'always', 'deny'].includes(prior.resolution ?? '')) {
          // The human ALREADY decided this exact call before a restart —
          // resolve the re-asked wait with the recorded decision instead of
          // re-prompting. (A no-op if a live click resolved us first.)
          resolveApproval(approvalId, prior.resolution as Decision);
          return;
        }
        if (prior && prior.status === 'pending' && prior.id !== approvalId) {
          // Restarted BEFORE any answer: this new id becomes the fingerprint's
          // current one, so a click on the OLD id still resolves THIS wait.
          await aliasDurableFingerprint('approval', sessionId, fp, approvalId);
        }
      }
      await saveDurablePending({
        id: approvalId, kind: 'approval', sessionId, fingerprint: fp,
        detail: (attentionSummary ?? '').slice(0, 300), status: 'pending', createdAt: Date.now(),
        ...(tool ? { tool } : {}),
      });
    })();
  });
}

/** The session a pending approval belongs to (for an ownership check), or null. */
export function approvalSession(approvalId: string): string | null {
  return pending.get(approvalId)?.sessionId ?? null;
}

/** Resolve a pending approval. Returns false if unknown/expired. */
export function resolveApproval(approvalId: string, decision: Decision): boolean {
  const p = pending.get(approvalId);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(approvalId);
  void unpublishApprovalPending(approvalId); // pending key must not outlive the wait
  void markDurableResolved('approval', approvalId, decision === 'deny' ? 'denied' : 'answered', decision);
  p.resolve(decision);
  return true;
}

/**
 * Worker-side apply of a cross-process resolution — the run executor's mailbox
 * drain calls this (identical semantics to resolveApproval: unknown/expired id
 * → false, a no-op for a late click after the auto-deny).
 */
export const applyApprovalResolution = resolveApproval;

/** Deny every pending approval for a session — unblocks an approval-waiting run
 *  so Stop/shutdown finalization doesn't sit out the 14-min auto-deny. */
export function denyPendingForSession(sessionId: string): void {
  for (const [id, p] of pending) {
    if (p.sessionId !== sessionId) continue;
    clearTimeout(p.timer);
    pending.delete(id);
    void unpublishApprovalPending(id);
    // A stop is not a human decision → 'expired', never replayed on a re-ask.
    void markDurableResolved('approval', id, 'expired', 'deny');
    p.resolve('deny');
  }
}
