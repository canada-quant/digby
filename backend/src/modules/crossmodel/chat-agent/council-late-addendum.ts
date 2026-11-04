/**
 * Ticket c7d5f885 — late council findings dropped on degraded deep-research runs.
 *
 * DROP MECHANISM: the council's terminal straggler reports fire `onLateReport`
 * (chat-agent.service.ts) which pushes into `inbox.lead`. That inbox is drained
 * ONLY by the lead's live tool loop; when the run ends degraded (the lead
 * answers alone), the push lands in a dead inbox and the finding is silently
 * dropped — the pre-fix degraded-run footer even admitted it ("findings that
 * arrive afterward are dropped once the run ends"). This module mirrors the
 * late-crosscheck.ts `check_addendum` precedent: capture the late findings
 * always, decide later (only a run that BOTH went degraded AND shipped an
 * assistant row flushes them as ONE follow-up row after a grace window).
 *
 * DELIBERATE DECISION — NO frontend change: frontend depth-ux-seams.ts:180
 * filters ONLY `check_addendum` for special rendering; an unknown assistant
 * kind renders as a plain assistant message, so the late findings are visible
 * by default. Adding `council_addendum` to that filter WITHOUT a rendering
 * path would HIDE them — so we deliberately do NOT touch the frontend.
 *
 * Ordering-race safety (capture-always, decide-later): `onLateReport` can fire
 * BEFORE or AFTER the degraded notice executes, so `note()` never depends on
 * `enable()`/`bind()` having run, and `settle()` — the ONLY side-effecting
 * path — re-checks every precondition at flush time.
 *
 * NO FINDING DROPPED (deep research without a wall clock, 2026-10-20 — council-dispatch.ts researchNoWallClock): a
 * late report that reaches the lead's inbox AFTER its last drain used to land in a dead inbox on a NON-degraded run
 * too (the holder only flushed when every colleague failed). The chat-agent now enables the holder on every run that
 * dispatched, marks each drain (`markDelivered` — the lead read every note captured so far) and hands each straggler's
 * run promise to `track`; `settle()` waits the grace, flushes AT ONCE the notes the lead never read (review 2026-10-20:
 * a finding already in hand is never held for a slower — or hung — straggler, nor lost to the next deploy while it
 * waits), then posts each tracked straggler's later finding as one more follow-up row the moment it lands, for at
 * most `stragglerWaitMs` (council-dispatch.ts councilLateStragglerWaitMs) so settle() always ends. With no
 * markDelivered / track call (the RESEARCH_NO_WALL_CLOCK_DISABLED=1 path) the holder behaves exactly as before.
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { recordLoopMetric, LOOP_METRIC_KINDS, MetricStamp } from '../platform/loop-metrics.service';
import { CouncilTimer } from './council-dispatch';

/** The assistant-row metadata kind marking this harness-authored follow-up row. */
export const COUNCIL_ADDENDUM_KIND = 'council_addendum';

/** Grace window env (ms) — how long settle() keeps collecting stragglers before flushing. */
export const COUNCIL_ADDENDUM_GRACE_MS_ENV = 'COUNCIL_ADDENDUM_GRACE_MS';
export const DEFAULT_COUNCIL_ADDENDUM_GRACE_MS = 120_000;
/** How long settle() keeps posting tracked stragglers' findings after its first flush, when the caller sets no bound. */
export const DEFAULT_COUNCIL_STRAGGLER_WAIT_MS = 60 * 60_000;

const SOURCE = 'council-late-addendum';

function graceMsFromEnv(): number {
  const raw = parseInt(process.env[COUNCIL_ADDENDUM_GRACE_MS_ENV] ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_COUNCIL_ADDENDUM_GRACE_MS;
}

/** Run meta captured at bind() — mirrors the shipped assistant row's metadata block. */
export interface CouncilAddendumMeta {
  models: Record<string, any>;
  modelLabels: Record<string, string>;
  mode: string;
}

export interface LateCouncilAddendumHolder {
  /** Capture a straggler finding (fires before OR after enable/bind — order-independent). */
  note(persona: string, text: string): void;
  /** Mark this run as degraded; only enabled holders flush. */
  enable(): void;
  /** Record the shipped assistant row id + run meta the addendum row will point back to. */
  bind(rowId: string | null, meta: CouncilAddendumMeta): void;
  /** The live lead just drained its inbox: every note captured so far reached it — settle() flushes only later ones. */
  markDelivered(): void;
  /** A straggler's run promise — settle() posts the finding it brings when it lands (never rejects through). */
  track(p: Promise<unknown>): void;
  /** The ONLY side-effecting path: waits the grace, then persists ONE follow-up row (+ one per later tracked straggler
   *  finding, bounded by stragglerWaitMs). Never rejects. */
  settle(): Promise<void>;
}

export function armLateCouncilAddendum(deps: {
  /** Null on chatless runs — a null chatId holder no-ops at settle (never flushes). */
  chatId?: string | null;
  sessionId?: string;
  /** Lazy stamp resolver — chatMetricStamp is built AFTER the arm site (the
   *  turnSpendStamp precedent, chat-agent.service.ts:1922): read at settle time. */
  stamp?: () => MetricStamp | undefined;
  timer?: CouncilTimer;
  graceMs?: number;
  /** After the first flush, how long settle() keeps posting tracked stragglers' findings (default 60 min). */
  stragglerWaitMs?: number;
  now?: () => Date;
  prisma?: typeof prisma;
  recordMetric?: typeof recordLoopMetric;
  logger?: Pick<typeof logger, 'warn'>;
}): LateCouncilAddendumHolder {
  const chatId = deps.chatId ?? null;
  const { sessionId } = deps;
  const stampOf = deps.stamp;
  const timer = deps.timer;
  const graceMs = deps.graceMs ?? graceMsFromEnv();
  const stragglerWaitMs = typeof deps.stragglerWaitMs === 'number' && deps.stragglerWaitMs >= 0 ? deps.stragglerWaitMs : DEFAULT_COUNCIL_STRAGGLER_WAIT_MS;
  const now = deps.now ?? (() => new Date());
  const p = deps.prisma ?? prisma;
  const recordMetric = deps.recordMetric ?? recordLoopMetric;
  const log = deps.logger ?? logger;

  // Holder state (capture-always, decide-later):
  const notes: Array<{ persona: string; text: string }> = [];
  let enabled = false;
  let boundRowId: string | null = null;
  let boundMeta: CouncilAddendumMeta | undefined;
  /** notes[0..deliveredIdx) reached the live lead (markDelivered) or were already posted — never flushed again. */
  let deliveredIdx = 0;
  /** Tracked stragglers; `done` flips once the run promise settled (its onLateReport note — if any — is captured by then). */
  const tracked: Array<{ p: Promise<void>; done: boolean }> = [];
  /** Follow-up rows posted so far (the first keeps today's exact metric meta; later ones add `part`). */
  let posts = 0;

  const live = (): boolean => !!enabled && !!chatId && !!boundRowId;
  const flushable = (): boolean => live() && notes.length > deliveredIdx;

  /** Persist the notes nobody read yet as ONE follow-up row. Never rejects. */
  const flushNow = async (): Promise<void> => {
    if (!flushable()) return;
    const rowId = boundRowId as string;
    const targetChatId = chatId as string;
    const undelivered = notes.slice(deliveredIdx);
    deliveredIdx = notes.length; // claimed synchronously — a straggler landing during the write is the NEXT row
    posts += 1;
    const part = posts;
    const n = undelivered.length;
    const content =
      `\n\n**Late council findings** — the deep-research council finished after this answer shipped; their reports follow.` +
      undelivered.map(nt => `\n\n[LATE FINDING from ${nt.persona}]\n${nt.text}`).join('');
    await p.crossModelMessage.create({
      data: {
        chatId: targetChatId,
        role: 'assistant',
        content,
        metadata: {
          kind: COUNCIL_ADDENDUM_KIND, addendumFor: rowId, engine: 'agent', mode: boundMeta?.mode,
          models: boundMeta?.models, modelLabels: boundMeta?.modelLabels,
          council: { reports: n, at: now().toISOString(), ...(part > 1 ? { part } : {}) },
        } as object,
      },
    }).then(async () => {
      // Bump the chat's updatedAt (catch-swallowed) so the follow-up surfaces.
      await p.crossModelChat.update({ where: { id: targetChatId }, data: { updatedAt: now() } }).catch(() => {});
      recordMetric({ kind: LOOP_METRIC_KINDS.COUNCIL_LATE_ADDENDUM, sessionId, stamp: stampOf?.(), meta: { chatId: targetChatId, reports: n, graceMs, ...(part > 1 ? { part } : {}) } });
    }).catch((err: any) => {
      log.warn(`${SOURCE}: persist failed for ${rowId.slice(0, 8)}: ${err?.message ?? err}`, { source: SOURCE });
      recordMetric({ kind: LOOP_METRIC_KINDS.COUNCIL_LATE_ADDENDUM, sessionId, stamp: stampOf?.(), meta: { chatId, reports: n, graceMs, persisted: false, ...(part > 1 ? { part } : {}) } });
    });
  };

  return {
    note(persona: string, text: string) {
      notes.push({ persona, text: String(text).slice(0, 4000) });
    },
    enable() {
      enabled = true;
    },
    bind(rowId: string | null, meta: CouncilAddendumMeta) {
      boundRowId = rowId;
      boundMeta = meta;
    },
    markDelivered() {
      deliveredIdx = notes.length;
    },
    track(p: Promise<unknown>) {
      const entry: { p: Promise<void>; done: boolean } = { p: Promise.resolve(), done: false };
      entry.p = Promise.resolve(p).then(() => { entry.done = true; }, () => { entry.done = true; });
      tracked.push(entry);
    },
    async settle(): Promise<void> {
      try {
        // A tracked straggler may still bring a note: nothing in hand yet is no reason to stop.
        const open = () => tracked.filter(t => !t.done);
        if (!flushable() && !(live() && open().length > 0)) return;
        // Grace window: keep collecting stragglers that fire while we wait.
        if (graceMs > 0) {
          await new Promise<void>(resolve => {
            if (timer) timer.set(resolve, graceMs);
            else setTimeout(resolve, graceMs);
          });
        }
        // Re-check after the wait — enable/bind can land DURING the grace. What is in hand is posted NOW.
        await flushNow();
        if (tracked.length === 0) return;
        // Stragglers still running (no-wall-clock runs only): post each later finding the moment its straggler lands,
        // bounded so settle() always ends (a hung straggler's finding — if it ever comes — is not waited for).
        let bounded = false;
        let boundHandle: unknown;
        const bound = new Promise<void>(resolve => {
          const fire = () => { bounded = true; resolve(); };
          if (timer) boundHandle = timer.set(fire, stragglerWaitMs);
          else { const h = setTimeout(fire, stragglerWaitMs); (h as any)?.unref?.(); boundHandle = h; }
        });
        try {
          while (!bounded && live()) {
            const waiting = open();
            if (!waiting.length) break;
            await Promise.race([bound, ...waiting.map(t => t.p)]);
            if (bounded) break;
            await flushNow();
          }
        } finally {
          if (timer) timer.clear(boundHandle);
          else clearTimeout(boundHandle as any);
        }
      } catch (err: any) {
        // NEVER throw into the caller — the addendum is best-effort garnish on
        // a run that already answered; a failure here must not fail the run.
        try { log.warn(`${SOURCE}: settle failed: ${err?.message ?? err}`, { source: SOURCE }); } catch { /* unreachable */ }
      }
    },
  };
}
