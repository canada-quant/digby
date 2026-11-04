/**
 * P4 Auto router — "Auto is a router, not a level" (unification plan, design
 * question (d), rollout step (ii)).
 *
 * When a message arrives with mode='auto', this PURE, zero-latency heuristic
 * (no model call, no I/O) picks the concrete patience level the run will use:
 *   L1 'single_thinking' — short, simple, single-part factual lookups.
 *   L2 'thinking'        — the default; the signature ensemble mode.
 *   L3 'deep_research'   — ONLY when research intent is explicit, or the brief
 *                          is very long AND multi-part. Never by length alone.
 * It also flags `suggestCode` (repo/code intent + the chat sits in a workspace
 * folder) so the UI can nudge the Code chip — a suggestion, never a silent
 * reroute (coding stays a user capability, plan (c)).
 *
 * Guardrail: bias cheap. Every rule below prefers the LESS expensive level
 * when the signal is ambiguous.
 */

import type { RoutableLevel } from '../types';

export interface AutoRouteInput {
  content: string;
  /** The chat's folder (or nearest ancestor) owns a repo workspace. */
  hasWorkspace: boolean;
}

/**
 * Code-selected reason for the heuristic's pick (patience plan 2026-09-25
 * §3.7): the frontend maps it to plain English; `reason` stays the free-text
 * admin detail. Never model-authored.
 */
export type HeuristicReasonKey = 'simple_lookup' | 'default_ensemble' | 'research_requested' | 'long_brief';

export interface AutoRouteDecision {
  level: RoutableLevel;
  reasonKey: HeuristicReasonKey;
  suggestCode: boolean;
  /**
   * Code/repo intent present in the message (User Space §4a) — the send-time
   * router's attach trigger. Unlike suggestCode it does NOT require a
   * resolvable folder workspace: the send seams consume it to attach the
   * satellite on demand (capability = attachable), never to pick a level.
   */
  needsWorkspace: boolean;
  reason: string;
}

/** Explicit research intent — the ONLY word-level signal that unlocks L3. */
const RESEARCH_INTENT: Array<{ re: RegExp; label: string }> = [
  { re: /\bdeep[\s-]?dive\b/i, label: 'deep dive' },
  { re: /\bcompare and contrast\b/i, label: 'compare and contrast' },
  { re: /\bliterature review\b/i, label: 'literature' },
  { re: /\bcomprehensive (analysis|report|guide|overview|review|breakdown)\b/i, label: 'comprehensive analysis' },
  { re: /\bin[\s-]?depth (analysis|look|review|report|breakdown)\b/i, label: 'in-depth analysis' },
  { re: /\bwhite\s?paper\b/i, label: 'white paper' },
  { re: /\bmarket (analysis|research|sizing|landscape)\b/i, label: 'market analysis' },
  // A research REQUEST, not the word: "Research X…", "can you research…", "do some research on…", "deep research".
  { re: /^(?:(?:please|pls|hey digby|digby)[,\s]+)?(?:(?:can|could|would|will) you\s+(?:please\s+)?)?research\b/i, label: 'research' },
  { re: /\b(?:do|run|conduct|need)\s+(?:some|a bit of|more|thorough|deep|proper|real)\s+research\b/i, label: 'research' },
  { re: /\bdeep research\b/i, label: 'research' },
  { re: /\b(write|produce|draft)\s+(a\s+)?(full|detailed|comprehensive)\s+(report|analysis|brief)\b/i, label: 'full report' },
];

/**
 * WEAK research cues (audit 2026-10-03): words that appear in ordinary
 * questions — "what is the SOURCE of the Nile?", "an open SOURCE alternative
 * to Photoshop", "what does the RESEARCH say", "the LATEST NEWS about the
 * Fed", "can you CITE the line" — and used to send each of them to a
 * 20-minute council plus a quota slot. They no longer unlock L3 on their own
 * (the Ensemble / Quick rules decide); AUTO_ROUTE_RESEARCH_CUE_SPLIT_DISABLED=1
 * restores the old rule (any cue ⇒ L3).
 */
const WEAK_RESEARCH_INTENT: Array<{ re: RegExp; label: string }> = [
  { re: /\bliterature\b/i, label: 'literature' },
  { re: /\blatest (news|developments|updates|research)\b/i, label: 'latest news' },
  { re: /\b(research|researched|researching)\b/i, label: 'research' },
  { re: /\b(cite|citation|citations|sources?)\b/i, label: 'cite/sources' },
];

export function researchCueSplitDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const s = String(env.AUTO_ROUTE_RESEARCH_CUE_SPLIT_DISABLED ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
}

/** Simple-question openers for L1 ("what/who/when/where/define…"). */
const SIMPLE_OPENER = /^(what|who|whom|whose|when|where|which|define|meaning of|how much|how many|how old)\b/i;

/**
 * Read-only views of the two shift-metric regex sets (patience plan
 * docs/PATIENCE_AUTO_ONLY_DEPRECATION_PLAN_2026-09-25.md §4.1 "Distribution
 * shift"): the replay probe (scripts/framework-audit/backtest-auto-route.js)
 * prefers these over its dated copy so the shift metric never drifts from the
 * router. Never consulted by the router itself; never mutate.
 */
export const RESEARCH_INTENT_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = RESEARCH_INTENT;
/** The weak cues (no longer an L3 trigger on their own since 2026-10-03) — read-only, for the replay probe. */
export const WEAK_RESEARCH_INTENT_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = WEAK_RESEARCH_INTENT;
export const SIMPLE_OPENER_PATTERN: RegExp = SIMPLE_OPENER;

/** Multi-part signals that disqualify L1 (a "simple lookup" is ONE question). */
const MULTI_PART = /\b(and also|as well as|along with|additionally|moreover|furthermore|compare|compared|versus|vs\.?|pros and cons)\b/i;

/** Repo/code intent for the suggestCode nudge. */
const CODE_INTENT: Array<{ re: RegExp; label: string }> = [
  // file names with code/config extensions, or repo-ish paths (src/..., packages/…)
  { re: /\b[\w\-./]+\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|c|cc|cpp|h|hpp|cs|swift|kt|kts|sql|sh|bash|zsh|yml|yaml|json|toml|ini|lock|css|scss|less|html|vue|svelte|mdx?)\b/i, label: 'file mention' },
  { re: /(?:^|\s)(src|app|lib|server|client|backend|frontend|tests?|spec|packages?|components?)\/[\w\-./]+/i, label: 'repo path' },
  { re: /\bpull request\b/i, label: 'pull request' },
  { re: /\bPR\b/, label: 'PR' }, // case-sensitive: the acronym, not "pr"
  { re: /\b(bug|bugfix|hotfix|fix|fixes|implement|refactor|commit|branch|merge|code review|unit test|failing test|stack trace|exception|regression|build error|type error|compile error)\b/i, label: 'code intent' },
];

const L1_MAX_LEN = 160;        // "short" lookup ceiling
const L3_LONG_BRIEF_LEN = 1200; // a brief must be BOTH this long AND multi-part for L3

/** Count question marks outside of code-ish content (good enough for a heuristic). */
function questionCount(text: string): number {
  return (text.match(/\?/g) || []).length;
}

/** True when the text reads as more than one question/request. */
function isMultiPart(text: string): boolean {
  if (questionCount(text) > 1) return true;
  if (MULTI_PART.test(text)) return true;
  // Enumerated asks: "1) … 2) …" or multiple bulleted lines
  const bullets = text.match(/(?:^|\n)\s*(?:\d+[.)]|[-*•])\s+\S/g);
  return !!bullets && bullets.length >= 2;
}

/** Code-intent signal for the Code-chip nudge (independent of the level pick). */
export function detectCodeIntent(content: string): string | null {
  for (const { re, label } of CODE_INTENT) {
    if (re.test(content)) return label;
  }
  return null;
}

/**
 * Route one 'auto' message to a concrete patience level. Pure + synchronous:
 * the whole decision is regexes over the message — no model call, no latency.
 */
export function routeMessageHeuristic(input: AutoRouteInput): AutoRouteDecision {
  const raw = String(input.content || '');
  const text = raw.replace(/\s+/g, ' ').trim();
  const codeLabel = detectCodeIntent(text);
  const suggestCode = !!codeLabel && !!input.hasWorkspace;
  // User Space §4a: bare code/repo intent (no workspace precondition) — the
  // attach trigger the two send seams evaluate BEFORE the satellite branch.
  const needsWorkspace = !!codeLabel;
  const codeReason = suggestCode ? `; code intent (${codeLabel}) + workspace → suggest Code` : '';
  // Multi-part is evaluated on the RAW text: collapsing whitespace first would
  // destroy the \n-anchored enumeration/bullet detection (a pasted brief's
  // "1) … 2) …" structure) — the exact signal the long-brief L3 rule needs.
  const multiPart = isMultiPart(raw);

  // ── L3: explicit research intent, or a very long multi-part brief. ────────
  const l3Cues = researchCueSplitDisabled() ? [...RESEARCH_INTENT, ...WEAK_RESEARCH_INTENT] : RESEARCH_INTENT;
  for (const { re, label } of l3Cues) {
    if (re.test(text)) {
      return { level: 'deep_research', reasonKey: 'research_requested', suggestCode, needsWorkspace, reason: `explicit research intent ("${label}")${codeReason}` };
    }
  }
  if (text.length >= L3_LONG_BRIEF_LEN && multiPart) {
    return { level: 'deep_research', reasonKey: 'long_brief', suggestCode, needsWorkspace, reason: `very long multi-part brief${codeReason}` };
  }

  // ── L1: short AND simple single-part question shape. ──────────────────────
  if (text && text.length <= L1_MAX_LEN && SIMPLE_OPENER.test(text) && !multiPart) {
    return { level: 'single_thinking', reasonKey: 'simple_lookup', suggestCode, needsWorkspace, reason: `short single-part lookup${codeReason}` };
  }

  // ── L2: the default (bias cheap; ensemble covers everything else). ────────
  const reason = !text
    ? 'default (empty message)'
    : text.length < L1_MAX_LEN
      ? 'default ensemble (not a simple lookup)'
      : 'default ensemble';
  return { level: 'thinking', reasonKey: 'default_ensemble', suggestCode, needsWorkspace, reason: `${reason}${codeReason}` };
}
