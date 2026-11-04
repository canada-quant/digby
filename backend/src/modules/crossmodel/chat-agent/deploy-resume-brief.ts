/**
 * deploy-resume-brief.ts — the deploy-interrupt SOFT CHECKPOINT (mishap ticket
 * 5ba5f03e — "Chat-runtime deploys interrupt in-flight runs; recovery re-runs
 * from scratch").
 *
 * THE MISHAP: the bounded blue-green drain (deploy-blue-green.sh polls the old
 * color's /drain-status up to DRAIN_MAX_SECONDS) covers turns that FINISH
 * inside the window — but a turn with >20 min of work remaining at the flip
 * (supervisor wakes, multi-hour generation lanes) is SIGTERM-killed and the
 * orphan-recovery re-fire re-ran the turn FROM SCRATCH. Every tool the dead
 * attempt already executed ran TWICE: wasted tokens/compute at best, DUPLICATED
 * SIDE EFFECTS at worst (the canlegal-bench lane's generation ledger had to be
 * hand-corrected 130→74 after its wake re-ran mid-generation).
 *
 * THE FIX (the ticket's option b — "resume from a mid-run checkpoint, partial
 * tool receipts preserved"): not loop-state serialization — a RECEIPT-BACKED
 * carry-forward. The SIGTERM ritual (shutdown-interrupt.ts) harvests the
 * interrupted run's consequential tool executions from the durable
 * run_tool_receipts store (agent.ts records them per execution, mid-run) into
 * this bounded brief, rides it on the requeue entry + the interrupt row's
 * metadata, and the re-fired run gets it rendered into its context by
 * runChatAgentTurn: "these actions ALREADY executed — do not repeat them".
 *
 * PRECISION RULE (why only receipts): a brief entry must mean "this verifiably
 * HAPPENED" — a wrong entry teaches the re-run to skip work that never ran
 * (lost work, worse than the duplicate the brief prevents). getRecentChatReceipts
 * is ok-only, so every listed action has a harness receipt; a tool call in
 * flight at SIGTERM (no receipt yet) is simply absent and gets redone — the
 * pre-fix behavior, never a regression.
 *
 * Pure leaf: type-only imports, no prisma/redis/env — unit-testable in
 * isolation (same discipline as run-receipts.ts / machine-wake.ts).
 */

import type { ToolReceipt } from '../coding/run-receipts';

/** One receipt-backed action the interrupted attempt verifiably executed. */
export interface ResumeBriefReceipt {
  tool: string;
  /** ISO wall-clock of the execution (the receipt's createdAt). */
  at: string;
  /** Canonical ids the execution returned, pruned to short citable strings. */
  ids: Record<string, string>;
}

/** The carried-forward checkpoint. Plain JSON — rides Redis + message metadata. */
export interface DeployResumeBrief {
  v: 1;
  /** ISO wall-clock of the harvest (≈ the interrupt instant). */
  harvestedAt: string;
  receipts: ResumeBriefReceipt[];
}

/** Freshest N executions kept — the note must stay scannable, and the newest
 *  actions are the ones whose repetition hurts (the final writes of a wake). */
export const RESUME_BRIEF_MAX_RECEIPTS = 12;
/** Ids kept per receipt (a receipt can carry a wide id bag — cite the first few). */
export const RESUME_BRIEF_MAX_IDS_PER_RECEIPT = 4;
/** One id value's max rendered length (full shas are 40 — they fit). */
export const RESUME_BRIEF_MAX_ID_VALUE_CHARS = 48;
/** Hard cap on the rendered note — bounded context cost per re-fired turn. */
export const RESUME_BRIEF_NOTE_MAX_CHARS = 1600;
/** Position-0 literal the rendered note starts with (tests + grep anchor). */
export const RESUME_BRIEF_PREFIX = '[DEPLOY-INTERRUPT RESUME';

/** Prune one receipt's id bag to short citable strings (numbers coerced). */
function pruneIds(ids: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!ids || typeof ids !== 'object') return out;
  for (const [k, v] of Object.entries(ids)) {
    if (Object.keys(out).length >= RESUME_BRIEF_MAX_IDS_PER_RECEIPT) break;
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    const s = String(v).trim();
    if (!s) continue;
    out[k] = s.slice(0, RESUME_BRIEF_MAX_ID_VALUE_CHARS);
  }
  return out;
}

/**
 * Build the brief from the interrupted run's receipts (any window the caller
 * scoped — shutdown-interrupt.ts passes run-start → now). ok-only, freshest
 * RESUME_BRIEF_MAX_RECEIPTS kept (input is treated oldest-first and preserved).
 * Returns null when nothing verifiably executed — a brief with zero receipts
 * is noise, and its absence keeps the requeue entry/row byte-identical to the
 * pre-fix shape for turns that had done nothing consequential yet.
 */
export function buildResumeBrief(receipts: ToolReceipt[], now: Date = new Date()): DeployResumeBrief | null {
  const usable = (receipts ?? []).filter((r) => r && r.ok === true && typeof r.tool === 'string' && r.tool.trim());
  if (!usable.length) return null;
  const kept = usable.slice(-RESUME_BRIEF_MAX_RECEIPTS).map((r) => ({
    tool: r.tool,
    at: (r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt)).toISOString(),
    ids: pruneIds(r.ids),
  }));
  return { v: 1, harvestedAt: now.toISOString(), receipts: kept };
}

/**
 * Tolerant structural read of a JSON-round-tripped brief (Redis requeue entry
 * / message metadata.resume). Anything off-shape degrades to null — the
 * re-fire then runs exactly as before the fix (a missing brief is never fatal,
 * never blocks a turn).
 */
export function parseResumeBrief(raw: unknown): DeployResumeBrief | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  if (b.v !== 1 || typeof b.harvestedAt !== 'string' || !b.harvestedAt) return null;
  if (!Array.isArray(b.receipts)) return null;
  const receipts: ResumeBriefReceipt[] = [];
  for (const r of b.receipts.slice(0, RESUME_BRIEF_MAX_RECEIPTS)) {
    if (!r || typeof r !== 'object') continue;
    const rec = r as Record<string, unknown>;
    if (typeof rec.tool !== 'string' || !rec.tool.trim()) continue;
    if (typeof rec.at !== 'string' || !rec.at) continue;
    receipts.push({ tool: rec.tool, at: rec.at, ids: pruneIds(rec.ids as Record<string, unknown> | undefined) });
  }
  if (!receipts.length) return null;
  return { v: 1, harvestedAt: b.harvestedAt, receipts };
}

/** HH:MM:SS of an ISO stamp — compact per-line clock (ISO fallback on junk). */
function shortClock(iso: string): string {
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]}Z` : iso;
}

/**
 * Render the brief as the harness note spliced into the re-fired turn's
 * context (runChatAgentTurn's additionalContext seam — both the human and the
 * machine re-fire paths ride it). Wording contract: the listed actions are
 * harness ground truth and must NOT be repeated; anything unlisted is
 * unverified and must be re-checked at source. Bounded at
 * RESUME_BRIEF_NOTE_MAX_CHARS — oldest receipts drop first with an omitted
 * count (they are the least likely to be re-attempted anyway).
 */
export function renderResumeBriefNote(brief: DeployResumeBrief): string {
  const body = (kept: ResumeBriefReceipt[], omitted: number): string => [
    `${RESUME_BRIEF_PREFIX} — harness note, not part of the message]`,
    `This turn is an automatic re-run of a turn a deploy killed mid-run (interrupt at ${brief.harvestedAt}). ` +
      `The interrupted attempt ALREADY EXECUTED these receipt-backed actions — harness ground truth, do NOT repeat them ` +
      `(re-sending / re-writing / re-registering duplicates the side effect):`,
    ...kept.map((r) => {
      const ids = Object.entries(r.ids).map(([k, v]) => `${k} ${v}`).join(', ');
      return `- ${shortClock(r.at)} ${r.tool}${ids ? ` → ${ids}` : ''}`;
    }),
    ...(omitted > 0 ? [`… (+${omitted} earlier action(s) — same rule: already executed, do not repeat)`] : []),
    'Only consequential executions are listed — reads/probes are safe to redo. Anything NOT listed did not verifiably ' +
      'complete: verify its state at source before redoing it, then finish the turn normally.',
  ].join('\n');
  let kept = brief.receipts;
  let omitted = 0;
  let note = body(kept, omitted);
  while (note.length > RESUME_BRIEF_NOTE_MAX_CHARS && kept.length > 1) {
    kept = kept.slice(1);
    omitted += 1;
    note = body(kept, omitted);
  }
  // Pathological single long entry: hard-truncate the note rather than exceed budget.
  return note.length > RESUME_BRIEF_NOTE_MAX_CHARS ? `${note.slice(0, RESUME_BRIEF_NOTE_MAX_CHARS - 1)}…` : note;
}
