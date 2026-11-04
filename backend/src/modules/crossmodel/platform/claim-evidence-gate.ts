/**
 * Action-verifier claim evidence — decision-gate purpose `claim_evidenced`
 * (N5, docs/DECISION_MODEL_ENHANCEMENTS_2026-09-25.md §5; shipped SHADOW).
 *
 * WHY: the phantom-claim verifier (platform/action-verifier.ts
 * computePhantomClaims) opens every audit with `extractActionClaims` — a 30 s
 * serial utilityChat over the final note (plus one per tracked tool-args
 * blob) on the PRE-DELIVERY path of every supervisor wake: 1–3 utility calls
 * (1.4–30 s) per wake, ≈30–90 min/day of aggregate pre-delivery latency. A
 * deterministic miner finds the id-bearing deed claims by regex; the gate
 * asks ONE noul per mined claim — "this claim is evidenced by the run's
 * receipts" — over a state the HARNESS computes (the executed pool: tool /
 * ok / staged / ids, with the id-match and kind-match facts pre-computed in
 * code) so the LLM extractor becomes the FALLBACK, not the opener.
 *
 * WHICH MINER (reachability fix 2026-09-26): the gate first shipped fed by
 * mineReceiptIdiomClaims — the first-person LLM-miss fallback ("I sent … to
 * <id>") — and recorded ZERO decision rows all-time: over the 60 most recent
 * prod supervisor notes that miner mined nothing (the fleet writes
 * "- send_chat_message → 7d1f3308 — …" and "… sent … — receipt 9cb2cebf",
 * never "I sent"), so `!claims.length ⇒ return null` held on every wake.
 * The gate is now fed by action-verifier's mineGateClaimCandidates (tool-name
 * receipt lines, receipt-anchored completed-action verbs in any person, and
 * the first-person rule without its person requirement); the fallback miner
 * itself is untouched because its claims can convict.
 *
 * MODES (decisionMode('claim_evidenced'); default shadow, NODE_ENV=test off):
 *   shadow — the gate runs CONCURRENTLY with the utilityChat extractor (E6
 *            pattern): started before the LLM call, NEVER awaited on the
 *            path, settled after the verifier's tier chain has judged the
 *            claims — zero added latency. Each claim's label is the
 *            VERIFIER'S OWN verdict for that (kind, id): convicted ⇒
 *            actual:false, exonerated ⇒ actual:true, a claim the verifier
 *            never surfaced ⇒ actual:null (paired, unlabelled). The note
 *            names which lane produced the judged claims (llm / miner / gate)
 *            and the verifier's disposition of the note.
 *   act    — DESIGNED, NOT ENABLED: awaited BEFORE the LLM extraction (≤ 4 s
 *            in place of a 1.4–30 s utility call); when EVERY mined claim's
 *            noul ≥ DECISION_GATE_THRESHOLD_CLAIM_EVIDENCED (default 0.9) the
 *            miner's claims stand as the note claims and the LLM lane is
 *            skipped. The tier chain (receipts, ledger, DB existence, cross-
 *            wake) STILL judges every claim — the gate only decides which
 *            claims need the LLM, never whether a claim is true (the
 *            verifier's verdicts stay observe-only since 2026-09-11 anyway).
 * Fail-open everywhere: a null gate answer, a timeout, a thrown anything ⇒
 * the verifier runs exactly as before. Kill switches: the gate-wide switches.
 *
 * LEAF: imports decision-gate only; the miner and the tier chain stay in
 * action-verifier.ts, which passes the mined claims + executed pool IN and the
 * computation OUT.
 */

import logger from '../../../utils/logger';
import {
  decide, decisionMode, decisionThreshold, recordDecisionOutcome,
  type DecideResult, type DecisionMode, type DecisionQuestion,
} from './decision-gate';
import type { ExecutedAction } from './executed-actions';

// ── Tunables ─────────────────────────────────────────────────────────────────

/** Acting confidence (DECISION_GATE_THRESHOLD_CLAIM_EVIDENCED overrides; the HIGH side acts). */
export const CLAIM_EVIDENCE_DEFAULT_THRESHOLD = 0.9;
/** Gate deadline. Shadow never waits on it; act awaits it in place of the 30 s LLM call. */
export const CLAIM_EVIDENCE_TIMEOUT_MS = 4000;
/** Per-request claim cap (env DECISION_GATE_CLAIM_EVIDENCE_MAX_CLAIMS, clamped 1..20 — the readout runs one prefill per noul). */
export const CLAIM_EVIDENCE_DEFAULT_MAX_CLAIMS = 8;
/** The doc's budgets: claim ≤ 300 chars, receipts ≤ 1.5k chars. */
export const CLAIM_EVIDENCE_CLAIM_HEAD_CHARS = 300;
export const CLAIM_EVIDENCE_RECEIPTS_CAP_CHARS = 1500;

/** Claims per request (clamped 1..20). */
export function claimEvidenceMaxClaims(): number {
  const raw = Number(process.env.DECISION_GATE_CLAIM_EVIDENCE_MAX_CLAIMS);
  const v = Number.isFinite(raw) ? Math.floor(raw) : CLAIM_EVIDENCE_DEFAULT_MAX_CLAIMS;
  return Math.min(20, Math.max(1, v));
}

/** The question key for the k-th mined claim (by POSITION, so questionsHash depends only on the count). */
export const claimQuestionKey = (k: number): string => `claim_${k}_evidenced`;

/** Minimal claim shape the gate reads (action-verifier's ExtractedClaim satisfies it). */
export interface MinedClaimLike { kind: string; detail: string; id?: string }

const clip = (v: unknown, max: number): string => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const idPrefix = (id: unknown): string => String(id ?? '').trim().toLowerCase().slice(0, 8);

/** Prefix-tolerant id equality (8 hex chars, the fleet's citation grain). Pure. */
export function claimIdMatches(a: unknown, b: unknown): boolean {
  const x = idPrefix(a); const y = idPrefix(b);
  return x.length >= 8 && y.length >= 8 && x === y;
}

// ── The state ────────────────────────────────────────────────────────────────

/**
 * The gate state — the run's executed pool (harness-written receipts + parsed
 * executions) compacted to ≤ CLAIM_EVIDENCE_RECEIPTS_CAP_CHARS, then the
 * mined claims with the two facts a small model would otherwise have to
 * derive: whether any receipt carries the cited id, and whether a successful
 * receipt of the claimed kind's tools exists at all. Pure.
 */
export function buildClaimEvidenceState(input: {
  claims: readonly MinedClaimLike[];
  executed: readonly ExecutedAction[];
  /** The claim kind → tool names table (action-verifier KIND_TOOLS). */
  kindTools: Readonly<Record<string, readonly string[]>>;
}): Record<string, unknown> {
  const receipts: Array<Record<string, unknown>> = [];
  let used = 0;
  for (const a of input.executed) {
    const ids = Object.values(a.ids ?? {}).map((v) => String(v).slice(0, 36)).slice(0, 4);
    const entry = { tool: a.tool, ok: a.ok === true, ...(a.staged ? { staged: true } : {}), ...(ids.length ? { ids } : {}) };
    const len = JSON.stringify(entry).length + 2;
    if (used + len > CLAIM_EVIDENCE_RECEIPTS_CAP_CHARS) break;
    used += len;
    receipts.push(entry);
  }
  const claims = input.claims.map((c, index) => {
    const tools = input.kindTools[c.kind] ?? [];
    const idMatch = !!c.id && input.executed.some((a) => Object.values(a.ids ?? {}).some((v) => claimIdMatches(v, c.id)));
    const kindOk = input.executed.some((a) => a.ok === true && tools.includes(a.tool));
    return {
      index,
      kind: c.kind,
      ...(c.id ? { cited_id: String(c.id).slice(0, 36) } : {}),
      cited_id_appears_in_a_receipt: idMatch,
      a_successful_receipt_of_this_kind_exists: kindOk,
      head: clip(c.detail, CLAIM_EVIDENCE_CLAIM_HEAD_CHARS),
    };
  });
  return {
    receipts_total: input.executed.length,
    receipts_ok: input.executed.filter((a) => a.ok === true).length,
    receipts_shown: receipts.length,
    receipts,
    claims,
  };
}

/** One noul per claim, by position. Pure. */
export function buildClaimEvidenceQuestions(n: number): Record<string, DecisionQuestion> {
  const out: Record<string, DecisionQuestion> = {};
  for (let k = 0; k < n; k++) {
    out[claimQuestionKey(k)] = {
      type: 'noul',
      instructions: `The action claim listed as claims[${k}] is evidenced by this run's receipts: a successful receipt exists whose tool matches the claim's kind and whose ids include the id the claim cites (or, for an id-less claim, at least one successful receipt of that kind).`,
      criteria: {
        true: 'a receipt with ok:true, a tool of the claimed kind, and the cited id (or no cited id) backs the claim',
        false: 'no receipt of that kind succeeded, the cited id appears in no receipt, or the only matching call was staged / failed',
      },
    };
  }
  return out;
}

// ── The gate handle ──────────────────────────────────────────────────────────

export type ClaimEvidenceLane = 'llm' | 'miner' | 'gate' | 'none';

export interface ClaimEvidenceGate {
  /** The claims the gate was asked about (the miner's, capped). */
  claims: MinedClaimLike[];
  /** The REQUESTED mode at start (the result's mode governs acting). */
  requestedMode: DecisionMode;
  /** Resolves to the decision (null on off / error / timeout). Never rejects. */
  decision: Promise<DecideResult | null>;
  sessionId: string;
}

/**
 * Start the gate CONCURRENTLY (never awaited by a shadow consumer). Returns
 * null when disabled, mode off, or there is nothing mined — no call is made.
 * Never throws.
 */
export function startClaimEvidenceGate(input: {
  chatId: string;
  claims: readonly MinedClaimLike[];
  executed: readonly ExecutedAction[];
  kindTools: Readonly<Record<string, readonly string[]>>;
}): ClaimEvidenceGate | null {
  try {
    if (!input.claims.length) return null;
    const requestedMode = decisionMode('claim_evidenced');
    if (requestedMode === 'off') return null;
    const claims = input.claims.slice(0, claimEvidenceMaxClaims()).map((c) => ({ kind: c.kind, detail: c.detail, ...(c.id ? { id: c.id } : {}) }));
    const state = buildClaimEvidenceState({ claims, executed: input.executed, kindTools: input.kindTools });
    const questions = buildClaimEvidenceQuestions(claims.length);
    const decision = decide(state, questions, { purpose: 'claim_evidenced', timeoutMs: CLAIM_EVIDENCE_TIMEOUT_MS, sessionId: input.chatId })
      .catch((err: any) => { logger.warn(`claim-evidence-gate: ${input.chatId.slice(0, 8)} failed open (${err?.message ?? err})`); return null; });
    return { claims, requestedMode, decision, sessionId: input.chatId };
  } catch { return null; }
}

/**
 * ACT contract: skip the LLM extraction ⇔ the RESULT's mode is act AND every
 * claim_<k>_evidenced noul ≥ τ. Pure.
 */
export function claimEvidenceWouldSkipLlm(decision: DecideResult | null | undefined, n: number, fallbackThreshold = CLAIM_EVIDENCE_DEFAULT_THRESHOLD): boolean {
  if (!decision || decision.mode !== 'act' || n <= 0) return false;
  const tau = decisionThreshold('claim_evidenced', fallbackThreshold);
  for (let k = 0; k < n; k++) {
    const a = decision.answers[claimQuestionKey(k)];
    if (!a || a.type !== 'noul' || a.noul < tau - 1e-9) return false;
  }
  return true;
}

export type ClaimVerdict = 'convicted' | 'exonerated' | 'unjudged';

/**
 * The verifier's own verdict for a mined claim, from the computation it
 * finished with: convicted ⇔ a phantom carries the same cited id (any lane —
 * the citation lanes convict by id too) or the same (kind, id); exonerated ⇔
 * the claim reached the tier chain (surfaced by any extraction lane) and was
 * not convicted; unjudged ⇔ no lane surfaced it. Pure.
 */
export function verifierVerdictFor(
  claim: MinedClaimLike,
  computation: { claims: readonly MinedClaimLike[]; phantoms: readonly MinedClaimLike[] },
): ClaimVerdict {
  const sameKey = (c: MinedClaimLike) => c.kind === claim.kind && claimIdMatches(c.id, claim.id);
  const convicted = computation.phantoms.some((p) => sameKey(p) || (!!claim.id && claimIdMatches(p.id, claim.id)));
  if (convicted) return 'convicted';
  const surfaced = computation.claims.some(sameKey);
  return surfaced ? 'exonerated' : 'unjudged';
}

/**
 * Settle the gate once the verifier has its verdicts: one outcome row per
 * mined claim, labelled from the verifier's own conviction list. Fire-and-
 * forget; never throws; a null gate is a no-op. `computation` null = the
 * verifier threw (paired, unlabelled rows).
 */
export function settleClaimEvidenceGate(
  gate: ClaimEvidenceGate | null | undefined,
  verdicts: { computation: { claims: readonly MinedClaimLike[]; phantoms: readonly MinedClaimLike[] } | null; lane: ClaimEvidenceLane; acted?: boolean; error?: string },
): void {
  if (!gate) return;
  void gate.decision.then((decision) => {
    if (!decision) return;
    try {
      const struck = verdicts.computation ? verdicts.computation.phantoms.length : null;
      gate.claims.forEach((claim, k) => {
        const verdict: ClaimVerdict | 'verifier_threw' = verdicts.computation ? verifierVerdictFor(claim, verdicts.computation) : 'verifier_threw';
        const actual = verdict === 'exonerated' ? true : verdict === 'convicted' ? false : null;
        recordDecisionOutcome(decision, 'claim_evidenced', {
          question: claimQuestionKey(k), actual, acted: verdicts.acted === true, sessionId: gate.sessionId,
          note: `verdict:${verdict}; lane:${verdicts.lane}; note:${struck === null ? 'unknown' : struck === 0 ? 'clean' : `struck ${struck}`}; label:verifier${verdicts.error ? `; error:${clip(verdicts.error, 60)}` : ''}`,
        });
      });
    } catch { /* telemetry never throws */ }
  }).catch(() => {});
}
