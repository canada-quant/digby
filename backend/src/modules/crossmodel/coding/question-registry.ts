/**
 * Digby Code — in-memory human-question registry (ask_user tool).
 *
 * When the ORCHESTRATOR decides it needs direction / is unsure of the goal, it
 * calls the ask_user tool. That emits an `ask_user` SSE event and awaits a typed
 * answer here; the client resolves it via POST /coding/questions/:questionId
 * { answer }. Unlike the approval registry (auto-DENY under the 4-min tool hard
 * timeout), ask_user is EXEMPT from that hard timeout (see agent.ts), so a human
 * gets a real window to reply. On timeout we resolve to null and the tool tells
 * the agent no answer arrived (it can proceed on best judgment or schedule_self
 * to resume later). The registry itself stays PROCESS-LOCAL (the worker awaits
 * the promise), but cross-process transport rides Redis (Phase 2 LEG 2c):
 * awaitAnswer publishes a pending-presence key the WEB resolve endpoint uses
 * for its ownership check, and the answer comes back via the session's
 * resolution mailbox, which the run executor drains into
 * applyQuestionResolution. The pending key is unpublished on BOTH exits
 * (resolve + timeout) so the endpoint can't see a stale pending.
 *
 * Phase 4 (pending-durable.ts): every wait also writes a DURABLE Redis record
 * keyed by id + a per-session fingerprint pointer (question text + options),
 * so an answer survives a worker restart — see pending-durable.ts for the
 * three flows (replay / alias / endpoint fallback).
 */

import { publishQuestionPending, refreshQuestionPending, unpublishQuestionPending } from './session-run-lock';
import {
  aliasDurableFingerprint, findDurableByFingerprint, fingerprintFor, markDurableResolved, saveDurablePending,
} from './pending-durable';

interface Pending {
  resolve: (answer: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
  sessionId: string;
}

const pending = new Map<string, Pending>();
// Generous but bounded — long enough for a human to actually answer, short enough
// that a forgotten question doesn't pin a run's resources indefinitely.
export const QUESTION_TIMEOUT_MS = 60 * 60 * 1000; // raised 20→60 min (owner max-out directive 2026-07-22): a blocked run waits a real human hour before self-answering
/**
 * SOFT deadline (QUESTION_TIMEOUT_MS, published to clients as expiresAt) vs HARD
 * stop (timeout + grace). The grace window exists for exactly one race: the user
 * taps an answer at T-1s and the POST lands at T+1s — or a backgrounded mobile
 * client's throttled timers wake late. During grace the question stays resolvable
 * (registry entry + Redis pending key retained) so those in-flight answers still
 * land; the agent simply waits up to 2 extra minutes after an unanswered hour.
 * Grace is invisible to clients — the displayed deadline remains authoritative.
 */
export const QUESTION_GRACE_MS = 2 * 60 * 1000;

let counter = 0;
export function newQuestionId(sessionId: string): string {
  counter = (counter + 1) % 1e9;
  return `q-${sessionId.slice(0, 8)}-${Date.now().toString(36)}-${counter}`;
}

/** Await a typed answer for questionId (resolves null after timeout).
 *  attentionSummary feeds the fleet supervisor's attention_needed hook event.
 *  fingerprintSeed (Phase 4) — a stable identity for the QUESTION (text +
 *  options): a restarted run that re-asks an already-answered question
 *  resolves immediately with the recorded answer; a re-ask of a still-pending
 *  question aliases the fingerprint so an answer to the OLD id lands HERE. */
export function awaitAnswer(questionId: string, sessionId: string, attentionSummary?: string, fingerprintSeed?: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => {
      // Soft deadline passed — enter GRACE instead of resolving null outright.
      // The question remains resolvable (an in-flight answer still lands), and
      // the Redis pending key is refreshed so cross-process resolve + the
      // sidebar indicator stay truthful through the window.
      const p = pending.get(questionId);
      if (!p) return; // resolved in the same tick — nothing to grace
      void refreshQuestionPending(questionId, Math.ceil(QUESTION_GRACE_MS / 1000) + 30);
      p.timer = setTimeout(() => {
        pending.delete(questionId);
        void unpublishQuestionPending(questionId); // the web endpoint must not see a stale pending
        void markDurableResolved('question', questionId, 'expired');
        resolve(null);
      }, QUESTION_GRACE_MS);
    }, QUESTION_TIMEOUT_MS);
    pending.set(questionId, { resolve, timer, sessionId });
    // Cross-process presence: the web resolve endpoint finds the owning session
    // via Redis and RPUSHes the answer into the session's resolution mailbox.
    void publishQuestionPending(questionId, sessionId, attentionSummary);
    // Phase 4 — durable record + fingerprint replay/aliasing (fail-open).
    void (async () => {
      const fp = fingerprintSeed ? fingerprintFor('question', fingerprintSeed) : null;
      if (fp) {
        const prior = await findDurableByFingerprint('question', sessionId, fp);
        if (prior && prior.status === 'answered' && typeof prior.resolution === 'string') {
          // The human ALREADY answered this exact question before a restart —
          // resolve the re-asked wait with the recorded answer instead of
          // re-prompting. (A no-op if a live answer resolved us first.)
          resolveAnswer(questionId, prior.resolution);
          return;
        }
        if (prior && prior.status === 'pending' && prior.id !== questionId) {
          // Restarted BEFORE any answer: this new id becomes the fingerprint's
          // current one, so an answer to the OLD id still resolves THIS wait.
          await aliasDurableFingerprint('question', sessionId, fp, questionId);
        }
      }
      await saveDurablePending({
        id: questionId, kind: 'question', sessionId, fingerprint: fp,
        detail: (attentionSummary ?? '').slice(0, 300), status: 'pending', createdAt: Date.now(),
      });
    })();
  });
}

/** The session a pending question belongs to (for an ownership check), or null. */
export function questionSession(questionId: string): string | null {
  return pending.get(questionId)?.sessionId ?? null;
}

/** Resolve a pending question with the human's answer. Returns false if unknown/expired. */
export function resolveAnswer(questionId: string, answer: string): boolean {
  const p = pending.get(questionId);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(questionId);
  void unpublishQuestionPending(questionId); // pending key must not outlive the wait
  void markDurableResolved('question', questionId, 'answered', answer);
  p.resolve(answer);
  return true;
}

/**
 * Worker-side apply of a cross-process resolution — the run executor's mailbox
 * drain calls this (identical semantics to resolveAnswer: unknown/expired id
 * → false, a no-op for a late answer after the timeout).
 */
export const applyQuestionResolution = resolveAnswer;

/**
 * Resolve (with null) EVERY pending question for a session — called when the run
 * is Stopped, so a run blocked inside ask_user unblocks immediately instead of
 * hanging the session in 'running' for up to the 60-min window. Returns how many
 * were released.
 */
export function resolvePendingForSession(sessionId: string): number {
  let n = 0;
  for (const [qid, p] of pending) {
    if (p.sessionId !== sessionId) continue;
    clearTimeout(p.timer);
    pending.delete(qid);
    void unpublishQuestionPending(qid);
    // A stop is not a human answer → 'expired', never replayed on a re-ask.
    void markDurableResolved('question', qid, 'expired');
    p.resolve(null);
    n++;
  }
  return n;
}
