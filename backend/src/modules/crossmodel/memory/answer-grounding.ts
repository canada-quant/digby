/**
 * Answer grounding for the memory pipeline (audit 2026-10-08 W4-2 — "memory stores ungrounded answers as confirmed
 * facts").
 *
 * THE BUG: the background extractors (langgraph/memory.graph.ts — the user-scope conversation distill, the flat-fact
 * proposer, the thread summary's `confirmedFacts`, the project decisions) read the assistant's answer as if it were
 * established truth. Two prod cases (2026-10-08, shapes only):
 *   - a zero-tool answer named an exact switch model the user never stated ("It's an NVIDIA Mellanox SN2010 …"); the
 *     distill filed "Resolution: The hardware is confirmed as an NVIDIA Mellanox SN2010" into user memory;
 *   - a chat that had only read its OWN memory (one search_memory call) said "Confirmed — no Cloudflare API token
 *     anywhere"; the project extractor filed "Cloudflare API access confirmed missing" as a project decision. Six
 *     minutes later a coding lane found the token.
 *
 * THE RULE: memory may only store facts the USER stated or that a tool result in THAT turn backs; nothing is
 * "confirmed" without a source. This leaf supplies the deterministic pieces:
 *   - answerGroundingFromParts — the turn's evidence-bearing tool results (memory reads, plan / meta tools and model
 *     opinions are NOT evidence: re-storing what memory said is circular, and another model's view is a claim);
 *   - the prompt label every extractor gets for an ungrounded answer;
 *   - neutralizeConfirmations / hasConfirmationClaim / ungroundedSpecifics — the backstops memory.graph.ts applies to
 *     an ungrounded turn's output (a "confirmed …" decision or a specific token — a model number, a version, an id —
 *     that appears only in the ungrounded answer is dropped; the distill's record is labelled unverified).
 * Pure (no imports beyond the shared tool vocabulary). Kill switch MEMORY_ANSWER_GROUNDING_DISABLED=1 (extraction
 * reads every answer as before). Telemetry: loop_metrics `memory_provenance` (memory.graph.ts).
 */
import { NON_EVIDENCE_TOOLS } from '../coding/evidence-tools';

export const MEMORY_PROVENANCE_METRIC = 'memory_provenance';

/** Tools whose result never grounds a memory write (beside the shared non-evidence set). */
export const MEMORY_NON_GROUNDING_TOOLS: ReadonlySet<string> = new Set([
  ...NON_EVIDENCE_TOOLS,
  // memory itself — a fact read back from memory and re-stored proves nothing new
  'list_memory', 'remember_fact', 'forget_fact',
  // another model's OPINION is a claim, not an observation
  'call_in', 'consult_frontier_council',
]);

export interface AnswerGrounding {
  /** At least one evidence-bearing tool returned a non-error result this turn. */
  toolBacked: boolean;
  /** Evidence-bearing tool results (or calls, when the transcript carries no result parts). */
  evidenceCalls: number;
  /** Distinct evidence tool names, first-seen order (≤ 8). */
  tools: string[];
}

export function memoryAnswerGroundingDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.MEMORY_ANSWER_GROUNDING_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

const TOOL_ERROR_RE = /^\s*(?:error\b|tool \S+ failed|\[?command failed|\{\s*"ok"\s*:\s*false)/i;

/** The turn's grounding from the agent loop's transcript parts (tool_call / tool_result). Pure; bad input ⇒ ungrounded. */
export function answerGroundingFromParts(parts: unknown): AnswerGrounding {
  const list = Array.isArray(parts) ? parts as Array<Record<string, unknown>> : [];
  const results = list.filter((p) => p && p.type === 'tool_result' && typeof p.name === 'string');
  const source = results.length ? results : list.filter((p) => p && p.type === 'tool_call' && typeof p.name === 'string');
  const tools: string[] = [];
  let evidenceCalls = 0;
  for (const p of source) {
    const name = String(p.name);
    if (MEMORY_NON_GROUNDING_TOOLS.has(name)) continue;
    if (p.type === 'tool_result' && TOOL_ERROR_RE.test(String(p.result ?? ''))) continue;
    evidenceCalls += 1;
    if (!tools.includes(name) && tools.length < 8) tools.push(name);
  }
  return { toolBacked: evidenceCalls > 0, evidenceCalls, tools };
}

/** An answer the extractors must treat as UNVERIFIED (grounding known, no evidence, switch on). */
export function isUngroundedAnswer(g: AnswerGrounding | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return !!g && !g.toolBacked && !memoryAnswerGroundingDisabled(env);
}

/** The label the extractors see in place of "Assistant:" for an ungrounded answer. */
export const UNGROUNDED_ASSISTANT_LABEL = 'Assistant (UNVERIFIED — this answer used NO tool or source this turn; its factual claims are NOT established: never record one as a fact, decision or confirmation — only what the USER stated)';

/** One extra instruction line every extractor prompt carries for an ungrounded answer. */
export const UNGROUNDED_EXTRACTION_RULE = 'PROVENANCE RULE: the assistant\'s answer above is UNVERIFIED (no tool or source backed it). Record ONLY what the USER stated. Never store the assistant\'s claims (models, numbers, names, availability, "X is missing / present") as facts or decisions, and never write "confirmed" or "verified" for anything from this exchange.';

const CONFIRMATION_RE = /\b(?:confirm(?:ed|s|ing)?|verif(?:ied|ies|y|ying)|validated|double-checked)\b/i;
/** The USER confirming something is a user statement, not an assistant claim ("the user confirmed they want X"). */
const USER_CONFIRMS_RE = /\b(?:the\s+)?(?:user|owner|customer|client|they|he|she|i)\s+(?:has\s+|have\s+|had\s+|just\s+|explicitly\s+)?(?:confirm|verif|validat)\w*/gi;

/** Does the text claim a confirmation / verification the USER did not make? Pure. */
export function hasConfirmationClaim(text: unknown): boolean {
  return CONFIRMATION_RE.test(String(text ?? '').replace(USER_CONFIRMS_RE, ' '));
}

/** "confirmed" / "verified" → "stated" (an unverified record never reads as checked). Pure; case kept on the first letter. */
export function neutralizeConfirmations(text: string): string {
  return String(text ?? '').replace(/\b(confirm(?:ed|s)?|verif(?:ied|ies)|validated|double-checked)\b/gi, (w) => {
    const lower = w.toLowerCase();
    const rep = lower === 'confirms' || lower === 'verifies' ? 'states' : (lower === 'confirm' ? 'state' : 'stated');
    return w[0] === w[0].toUpperCase() ? rep[0].toUpperCase() + rep.slice(1) : rep;
  });
}

/** High-specificity tokens: anything with a digit (a model number, a version, an amount, an id) or an ALL-CAPS ≥ 3-letter word. */
const SPECIFIC_TOKEN_RE = /[A-Za-z0-9][A-Za-z0-9._/-]*\d[A-Za-z0-9._/-]*|\b[A-Z]{3,}\b/g;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * The specific tokens of `value` that occur in the ungrounded ANSWER but in none of the grounded inputs (the user's
 * message, prior stored state) — i.e. details only the unverified answer asserted. Pure.
 */
export function ungroundedSpecifics(value: unknown, answer: string, grounded: readonly string[]): string[] {
  const text = String(value ?? '');
  const answerNorm = norm(answer);
  const groundNorm = grounded.map((g) => norm(String(g ?? ''))).join(' ');
  const out: string[] = [];
  for (const m of text.match(SPECIFIC_TOKEN_RE) ?? []) {
    const t = norm(m);
    if (t.length < 3 || out.includes(m)) continue;
    if (answerNorm.includes(t) && !groundNorm.includes(t)) out.push(m);
  }
  return out;
}

/**
 * Should an item an extractor produced from an UNGROUNDED turn be dropped? A confirmation claim ("… confirmed
 * missing") or a specific detail only the unverified answer asserted. Pure.
 */
export function dropUngroundedItem(item: unknown, answer: string, grounded: readonly string[]): { drop: boolean; why?: string } {
  const text = typeof item === 'string' ? item : JSON.stringify(item ?? '');
  if (hasConfirmationClaim(text)) return { drop: true, why: 'confirmation claim with no source' };
  const spec = ungroundedSpecifics(text, answer, grounded);
  if (spec.length) return { drop: true, why: `only the unverified answer states ${spec.slice(0, 3).join(', ')}` };
  return { drop: false };
}
