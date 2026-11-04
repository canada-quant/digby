/**
 * Digby Code — THREE-TIER memory (user → project → session).
 *
 * USER memory (tier 1, durable, spans ALL of a user's coding projects): the
 * developer's standing preferences — tooling, code style, commit conventions,
 * how they like the agent to behave. Learned once, applied everywhere.
 *
 * PROJECT memory (tier 2, durable, shared across all sessions of ONE project):
 * learned facts about the codebase — architecture, conventions, build/test
 * commands, gotchas. Grows slowly; injected into every session's system prompt.
 *
 * SESSION memory (tier 3, one session's rolling summary): what this session has
 * done so far, so long threads stay coherent without replaying every message.
 *
 * All persist via the Prisma-backed context store (memory/context-store.ts):
 *   [userId,    'coding-user']    / 'memory'  → UserCodingMemory
 *   [projectId, 'coding-project'] / 'memory'  → ProjectCodingMemory
 *   [sessionId, 'coding-session'] / 'memory'  → SessionCodingMemory
 *
 * Updated fire-and-forget after each agent turn by a cheap utility-LLM call
 * (never on the user's critical path). All failures are non-fatal.
 */

import prisma from '../../../config/database';
import { recordExtractionOutcome, parseModelJson, extractionDetailOf } from '../memory/memory-audit';
import { storeGet, storePut } from '../memory/context-store';
import { utilityChat } from '../../../utils/utility-llm';
import logger from '../../../utils/logger';
import { logHandled } from '../../../utils/log-level';
import { trackBackground } from '../../../utils/background-tasks';
import { parseLearningsDoc, normalizeEntry } from './learnings-index.service';
import { recordLoopMetric, LOOP_METRIC_KINDS } from '../platform/loop-metrics.service';
// N3 (2026-09-25): decision-gate purpose `coding_memory_fold` — one prefill of
// per-leg nouls before the legs; shadow by default (labels only), act skips a
// leg the gate is confident has nothing to fold. See coding-memory-fold-gate.ts.
import { codingMemoryFoldGateWaitsFirst, consultCodingMemoryFoldGate, labelCodingMemoryFold, memoryDocChanged } from './coding-memory-fold-gate';
// 2026-10-20 memory wave: the fold, the dream and the user-prefs leg answer with per-item CHANGES
// (memory/state-ops.ts) instead of re-emitting the whole stored object. MEMORY_STATE_OPS_DISABLED=1
// restores the whole-object prompts / budgets / parsing below byte-for-byte.
import {
  renderStateForOps, opsInstruction, parseStateOps, applyStateOps, describeOps, memoryStateOpsEnabled, maxOpsAnswerChars,
  type OpsSpec, type StateOps,
} from '../memory/state-ops';
// The near-dup clustering + LLM merge shared by the file dream (dreamLearnings) and the scheduled index
// dream (learnings-dream.ts runLearningsDreamCycle) — one implementation so the two cannot drift.
import { LEARNINGS_DREAM_MAX_DROP_RATIO, nearDuplicateClusters, mergeLearningGroups } from './learnings-dream';

// ── memory_shrunk telemetry (remediation P0) ─────────────────────────────────

/** A REPLACE shrinking the stored blob by MORE than this fraction is flagged. */
export const MEMORY_SHRINK_THRESHOLD = 0.3;

/** Pure: did a replace shrink stored bytes >30%? (0-byte "before" never flags.) */
export function memoryShrankOverThreshold(beforeBytes: number, afterBytes: number): boolean {
  if (!(beforeBytes > 0) || !(afterBytes >= 0)) return false;
  return afterBytes < beforeBytes * (1 - MEMORY_SHRINK_THRESHOLD);
}

/**
 * Observe one durable-memory REPLACE (the utility-LLM rewrite storePut'ing over
 * the existing blob): when the new blob is >30% smaller, record a
 * `memory_shrunk` loop_metrics row — possible memory loss, OBSERVED only (the
 * replace behavior itself is remediation Phase 8's; do not block/alter here).
 * Fire-and-forget, never throws.
 */
export function noteMemoryReplace(
  scope: 'user' | 'project' | 'session',
  sessionId: string | undefined,
  before: unknown,
  after: unknown,
): void {
  try {
    const beforeBytes = Buffer.byteLength(JSON.stringify(before ?? null), 'utf8');
    const afterBytes = Buffer.byteLength(JSON.stringify(after ?? null), 'utf8');
    if (!memoryShrankOverThreshold(beforeBytes, afterBytes)) return;
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.MEMORY_SHRUNK,
      sessionId,
      value: beforeBytes - afterBytes,
      unit: 'bytes',
      meta: { scope, beforeBytes, afterBytes },
    });
  } catch { /* telemetry must never break the memory path */ }
}

// ── Memory shrink guard (P6 — spark B22/G11) ─────────────────────────────────
// The per-turn project/user memory update is an LLM REPLACE: whatever JSON the
// utility model returns overwrites the stored lists wholesale. One bad turn
// (a distracted model returning only the latest exchange's facts) could
// silently destroy months of accumulated project knowledge. Guard: when the
// replacement is suspiciously smaller than the original — under
// MEMORY_SHRINK_MIN_RATIO of the chars AND dropping more than
// MEMORY_SHRINK_MAX_LINE_DROP entries — keep the OLD entries and APPEND the
// new ones instead (append-only fallback, wider caps), and emit the
// `memory_shrunk` loop metric so the rate is observable.
export const MEMORY_SHRINK_MIN_RATIO = 0.6;
export const MEMORY_SHRINK_MAX_LINE_DROP = 10;

/** True when a replacement text is a suspicious shrink of the original. */
export function memoryShrankSuspiciously(oldLines: string[], newLines: string[]): boolean {
  const oldChars = oldLines.join('\n').length;
  const newChars = newLines.join('\n').length;
  return newChars < oldChars * MEMORY_SHRINK_MIN_RATIO
    && oldLines.length - newLines.length > MEMORY_SHRINK_MAX_LINE_DROP;
}

/** Old entries first, then new entries not already present; bounded. */
function appendUnique(oldList: string[], newList: string[], cap: number): string[] {
  const seen = new Set(oldList.map(s => s.trim()));
  const out = [...oldList];
  for (const s of newList) {
    const t = s.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(s);
  }
  return out.slice(0, cap);
}

export interface UserCodingMemory {
  /** Standing developer preferences that apply across every project. */
  preferences: string[];
  /** Other durable, user-level notes worth remembering across projects. */
  notes: string[];
  updatedAt: string;
}

export interface ProjectCodingMemory {
  /** One-paragraph description of what the project is + its stack. */
  overview: string;
  /** Build/test/lint/run commands discovered to work. */
  commands: string[];
  /** Conventions, architecture notes, and gotchas worth remembering. */
  notes: string[];
  updatedAt: string;
}

export interface SessionCodingMemory {
  /** Rolling narrative of what this session has accomplished + current goal. */
  summary: string;
  updatedAt: string;
}

const EMPTY_PROJECT: ProjectCodingMemory = { overview: '', commands: [], notes: [], updatedAt: '' };
const EMPTY_USER: UserCodingMemory = { preferences: [], notes: [], updatedAt: '' };

export async function getUserCodingMemory(userId: string): Promise<UserCodingMemory> {
  try {
    const v = await storeGet<UserCodingMemory>([userId, 'coding-user'], 'memory');
    return v || { ...EMPTY_USER };
  } catch { return { ...EMPTY_USER }; }
}

export async function getProjectMemory(projectId: string): Promise<ProjectCodingMemory> {
  try {
    const v = await storeGet<ProjectCodingMemory>([projectId, 'coding-project'], 'memory');
    return v || { ...EMPTY_PROJECT };
  } catch { return { ...EMPTY_PROJECT }; }
}

export async function getSessionMemory(sessionId: string): Promise<SessionCodingMemory | null> {
  try {
    return await storeGet<SessionCodingMemory>([sessionId, 'coding-session'], 'memory');
  } catch { return null; }
}

/** Format all three tiers into a system-prompt block (empty string if nothing). */
export function formatCodingMemoryBlock(
  user: UserCodingMemory,
  project: ProjectCodingMemory,
  session: SessionCodingMemory | null,
): string {
  const parts: string[] = [];
  const u: string[] = [];
  if (user.preferences.length) u.push(`Preferences:\n${user.preferences.slice(0, 15).map(x => `  - ${x}`).join('\n')}`);
  if (user.notes.length) u.push(`Notes:\n${user.notes.slice(0, 10).map(x => `  - ${x}`).join('\n')}`);
  if (u.length) parts.push(`[USER PREFERENCES — how this developer likes to work, across all projects]\n${u.join('\n')}`);
  const p: string[] = [];
  if (project.overview) p.push(`Overview: ${project.overview}`);
  if (project.commands.length) p.push(`Known commands:\n${project.commands.map(c => `  - ${c}`).join('\n')}`);
  if (project.notes.length) p.push(`Notes:\n${project.notes.slice(0, 20).map(n => `  - ${n}`).join('\n')}`);
  if (p.length) parts.push(`[PROJECT MEMORY — learned from earlier work on this codebase]\n${p.join('\n')}`);
  if (session?.summary) parts.push(`[SESSION SO FAR]\n${session.summary}`);
  return parts.join('\n\n');
}

/**
 * Seed a new session's rolling summary from a prior session (same project), so a
 * fresh session that chained off earlier work also carries the narrative of what
 * was done. Best-effort; no-op if the source has no summary.
 */
export async function inheritSessionMemory(fromSessionId: string, toSessionId: string): Promise<void> {
  try {
    const prior = await getSessionMemory(fromSessionId);
    if (!prior?.summary) return;
    await storePut([toSessionId, 'coding-session'], 'memory', {
      summary: `[Continued from a previous session]\n${prior.summary}`,
      updatedAt: new Date().toISOString(),
    } satisfies SessionCodingMemory as any);
  } catch { /* non-fatal */ }
}

function parseJson<T>(text: string, fallback: T): T {
  try { return JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim()) as T; } catch { return fallback; }
}

// ── Project-level dream cycle ─────────────────────────────────────────────────
// Per-turn updates only ever APPEND to project memory. This nightly pass (run
// from the memory-maintenance dream scheduler, inside its cross-instance lock)
// consolidates each recently-active project's memory against its latest session
// summaries: merges duplicates, drops stale/contradicted notes, refreshes the
// overview. Anti-wipe guard: a consolidation that empties a non-empty memory is
// rejected wholesale.

const PROJECT_DREAM_ACTIVITY_MS = 48 * 60 * 60 * 1000; // only projects coded in recently
const PROJECT_DREAM_MIN_GAP_MS = 20 * 60 * 60 * 1000;  // at most ~one dream per project per day
const PROJECT_DREAM_CONCURRENCY = 3;
// Per-run project-fold output budget (firing-10b, 2026-09-23): the fold echoes
// the FULL current memory (overview ≤1000 chars + 12 commands + 12 notes,
// pretty-printed) and must return it updated — the largest legal answer is
// ~2000+ tokens, and a truncated JSON is indistinguishable from "no update"
// (the 2026-09-22 dream rule, re-proven on the fold at 1500).
// Firing 11 (2026-09-23): a FIXED budget can never fit an extractor that must
// ECHO its stored state — measured live, project states reached 8,941 B at the
// LEGAL 12+12 items (one note 1,068 chars; item LENGTH is the growth vector,
// the same lesson as the project-state extractor's 12.4 kB state). The budget
// now SCALES with the state actually shown (~0.5 output tokens per char of
// pretty-printed JSON + headroom for the new exchange), floor 3000 / ceiling
// 8000, and the save side clamps every item (below) so legal states stay
// under the ceiling. `budgetTokens` on every outcome row proves it live.
export const CODING_PROJECT_FOLD_BUDGET_TOKENS = 3000;
/** Output-token budget for the fold/dream echo of a stored project memory:
 *  scales with the chars actually embedded in the prompt. */
export function codingMemoryEchoBudget(stateChars: number): number {
  return Math.min(8000, Math.max(CODING_PROJECT_FOLD_BUDGET_TOKENS, Math.ceil((stateChars * 0.5 + 1200) / 100) * 100));
}
// ── Project-memory item clamp (firing 11, 2026-09-23) ────────────────────────
// The save-side bound that makes the echo budget sustainable: a note/command
// item may be arbitrarily long (1,068 chars measured) while counts are already
// capped at 12 — clamp each item to ≤240 chars (head+tail elision keeps the
// identifying start and the newest tail) at every successful fold/dream write.
const CODING_MEMORY_ITEM_CHAR_CAP = 240;
export function clampProjectMemoryItems<T extends { overview?: string; commands?: string[]; notes?: string[] }>(m: T): T {
  const clampOne = (s: unknown): unknown =>
    typeof s !== 'string' || s.length <= CODING_MEMORY_ITEM_CHAR_CAP ? s : `${s.slice(0, 170)} … ${s.slice(-50)}`;
  return {
    ...m,
    overview: (clampOne(m.overview) as string | undefined),
    commands: (m.commands ?? []).map(clampOne) as string[],
    notes: (m.notes ?? []).map(clampOne) as string[],
  } as T;
}

// ── Per-item ops (2026-10-20 memory wave) ─────────────────────────────────────
// The fold and the dream used to echo the WHOLE stored memory back, so their answer grew with the
// state (the 1500 → 3000 → scaled-to-8000 budget treadmill above — "a FIXED budget can never fit an
// extractor that must ECHO its stored state"). They now see the memory with an [id] per item and answer
// with only the changes (memory/state-ops.ts), so the answer is bounded by the CHANGE and the budget is
// fixed. Lists are newest-first: an add goes first and overflow evicts the oldest (logged).
// MEMORY_STATE_OPS_DISABLED=1 restores the whole-object prompts / budgets / parsing byte-for-byte.

/** Project memory as op-updated state. Overview ≤1000 chars, 12 + 12 items of ≤240 chars. */
export const PROJECT_MEMORY_OPS_SPEC: OpsSpec = {
  text: { overview: { cap: 1000 } },
  lists: {
    commands: { cap: 12, itemCap: 240, idPrefix: 'C' },
    notes: { cap: 12, itemCap: 240, idPrefix: 'N' },
  },
};
/** Cross-project developer preferences as op-updated state (the old 15 / 10 caps, items ≤240 chars). */
export const USER_CODING_MEMORY_OPS_SPEC: OpsSpec = {
  lists: {
    preferences: { cap: 15, itemCap: 240, idPrefix: 'P' },
    notes: { cap: 10, itemCap: 240, idPrefix: 'N' },
  },
};
/** Per-run fold: a run teaches a handful of facts — the answer is bounded by that, not the stored state. */
export const CODING_PROJECT_FOLD_OPS_BUDGET_TOKENS = 2500;
/** Nightly dream: may rewrite every item, so bounded by the SPEC's largest legal answer (~0.5 output
 *  tokens per char, the echo-budget ratio, + headroom for ids / JSON) — never by the stored state. */
export const CODING_PROJECT_DREAM_OPS_BUDGET_TOKENS = Math.ceil((maxOpsAnswerChars(PROJECT_MEMORY_OPS_SPEC) * 0.5 + 600) / 100) * 100;
/** User-prefs leg: the same 400 tokens as before — enough for several changes, no longer an echo. */
export const CODING_USER_FOLD_OPS_BUDGET_TOKENS = 400;
/**
 * The dream's removal guard (the learnings dream's ratio rule, sized for a ≤25-line memory where merging
 * pairs or retiring stale commands legitimately removes a larger share than in a 200-entry file): a
 * consolidation that removes MORE than this fraction of the stored lines is rejected and the memory kept.
 */
export const PROJECT_DREAM_MAX_REMOVE_RATIO = 0.5;

/** True when a per-run ops answer drops more items than the shrink guard tolerates (MEMORY_SHRINK_MAX_LINE_DROP). */
export function opsFoldRemovalRefused(removed: number): boolean {
  return removed > MEMORY_SHRINK_MAX_LINE_DROP;
}

/** True when a dream would remove more than PROJECT_DREAM_MAX_REMOVE_RATIO of the stored lines. */
export function projectDreamRemovalRefused(removed: number, linesBefore: number): boolean {
  return linesBefore > 0 && removed > linesBefore * PROJECT_DREAM_MAX_REMOVE_RATIO;
}

/** Text fields the answer emptied (a non-empty overview set to ""). */
function clearedTextFields(before: unknown, after: unknown, spec: OpsSpec): number {
  let n = 0;
  for (const path of Object.keys(spec.text ?? {})) {
    const b = (before as Record<string, unknown> | null)?.[path];
    const a = (after as Record<string, unknown> | null)?.[path];
    if (typeof b === 'string' && b.trim() && !(typeof a === 'string' && a.trim())) n++;
  }
  return n;
}

/** Items of the stored lists whose text no longer appears after a WHOLE-OBJECT replacement (+ cleared text). */
function droppedByReplacement(before: unknown, after: unknown, spec: OpsSpec): number {
  let n = clearedTextFields(before, after, spec);
  for (const path of Object.keys(spec.lists ?? {})) {
    const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    const kept = new Set(strs((after as Record<string, unknown> | null)?.[path]).map(s => s.replace(/\s+/g, ' ').trim().toLowerCase()));
    n += strs((before as Record<string, unknown> | null)?.[path]).filter(s => !kept.has(s.replace(/\s+/g, ' ').trim().toLowerCase())).length;
  }
  return n;
}

/** The legacy whole-object fields an ops-path parse carries (a model answering in the OLD shape). */
function legacyFieldsOf(ops: StateOps): Record<string, unknown> {
  return { ...(ops.set ?? {}), ...(ops.replaceLists ?? {}) };
}

function logEvicted(what: string, id: string, evicted: Array<{ path: string; item: string }>): void {
  if (!evicted.length) return;
  logger.info(`coding-memory: ${what} for ${id} evicted ${evicted.length} oldest item(s) past the caps: ${evicted.map(e => `${e.path}: ${e.item.slice(0, 80)}`).join(' | ')}`);
}

export async function dreamCodingProjects(maxProjects = 15): Promise<number> {
  const since = new Date(Date.now() - PROJECT_DREAM_ACTIVITY_MS);
  const states: Array<{ projectId: string }> = await (prisma as any).chatCodingState.findMany({
    where: { updatedAt: { gte: since } },
    orderBy: { updatedAt: 'desc' },
    select: { projectId: true },
    take: 200,
  }).catch(() => []);
  const projectIds = [...new Set(states.map(s => s.projectId))].slice(0, maxProjects);
  if (!projectIds.length) return 0;

  let dreamed = 0;
  for (let i = 0; i < projectIds.length; i += PROJECT_DREAM_CONCURRENCY) {
    const batch = projectIds.slice(i, i + PROJECT_DREAM_CONCURRENCY);
    const results = await Promise.allSettled(batch.map(pid => dreamOneProject(pid)));
    dreamed += results.filter(r => r.status === 'fulfilled' && r.value).length;
  }
  return dreamed;
}

async function dreamOneProject(projectId: string): Promise<boolean> {
  const memory = await getProjectMemory(projectId);
  const hasContent = !!(memory.overview || memory.commands.length || memory.notes.length);
  const lastDream = (memory as any).dreamAt ? new Date((memory as any).dreamAt).getTime() : 0;
  if (Date.now() - lastDream < PROJECT_DREAM_MIN_GAP_MS) return false;

  // Newest session summaries feed the consolidation (what actually happened lately).
  const sessions: Array<{ id: string }> = await (prisma as any).chatCodingState.findMany({
    where: { projectId },
    orderBy: { updatedAt: 'desc' },
    select: { id: true },
    take: 6,
  }).catch(() => []);
  const summaries = (await Promise.all(sessions.map(s => getSessionMemory(s.id))))
    .map(m => m?.summary || '')
    .filter(Boolean);
  if (!hasContent && !summaries.length) return false;
  // 2026-10-20: per-item ops (see PROJECT_MEMORY_OPS_SPEC). Below = the whole-object dream, kept
  // byte-for-byte for MEMORY_STATE_OPS_DISABLED=1.
  if (memoryStateOpsEnabled()) return dreamOneProjectOps(projectId, memory, hasContent, summaries);

  const prompt = `You are the nightly consolidation ("dream") pass over DURABLE memory about one codebase, kept for an AI coding assistant.

Current project memory:
${JSON.stringify({ overview: memory.overview, commands: memory.commands, notes: memory.notes }, null, 2)}

Recent session summaries (newest first):
${summaries.map((s, i) => `${i + 1}. ${s.slice(0, 500)}`).join('\n') || '(none)'}

Consolidate: merge duplicate/overlapping notes and commands, remove entries contradicted or made stale by newer sessions, refresh the overview if the sessions show it drifted, and keep ONLY durable facts (architecture, conventions, working commands, gotchas) — never transient task state. Do NOT invent anything not present in the inputs.

Return ONLY valid JSON: {"overview": "...", "commands": ["..."], "notes": ["..."]}`;
  // 2026-09-22 audit: this ran at maxTokens 600 and the model pretty-printed a
  // 12-note JSON that the budget truncated — JSON.parse threw, `{}` came back and
  // EVERY project logged "returned empty — keeping existing memory" two nights
  // running (13 warns / 48 h). Replayed live: 600 tokens → truncated 2/2; with
  // reasoning on (16k floor) → clean JSON. Budget up, reasoning on (the same
  // judgment-task rule as the flat-fact extractor; kill switch shared), parse
  // tolerant, outcome telemetered.
  const dreamStartedAt = Date.now();
  // Firing 11 (2026-09-23): the dream echoes the SAME stored state the fold
  // does and ran at a FIXED 2000 — the identical echo-truncation class (it has
  // not fired yet only because nightly states were small; the fold measured
  // 8,941 B today). Same scaled budget as the fold.
  const dreamBudget = codingMemoryEchoBudget(JSON.stringify({ overview: memory.overview, commands: memory.commands, notes: memory.notes }).length);
  let raw = '';
  // Firing 13 (2026-09-24): the dream's outcome rows carried NO budgetTokens
  // (the audit's min_budget/max_budget read NULL on all 13 in-window rows)
  // and NO provider leg — 7555d2f6a threaded leg/finishReason through the
  // FOLD only, so a dream truncation was undiagnosable by row. Same wiring
  // as the fold: onMeta captures the leg, every row carries the budget used.
  let dreamMeta: { leg?: string; finishReason?: string } = {};
  try {
    raw = await utilityChat([{ role: 'user', content: prompt }], {
      maxTokens: dreamBudget, temperature: 0.2, timeout: 90000, retryNotFound: true,
      thinking: true,
      // JSON extractor (2026-09-24): a length-exhausted thinking call must NOT hand
      // back its reasoning as the "answer" (51k chars of chain-of-thought parsed
      // as JSON = parse_error); empty content falls to the non-reasoning fallback.
      contentOnly: true,
      onMeta: (m) => { dreamMeta = { leg: m.leg, finishReason: m.finishReason }; },
    });
  } catch (err: any) {
    recordExtractionOutcome({ userId: projectId, source: 'coding_project_dream', outcome: 'llm_error', ms: Date.now() - dreamStartedAt, budgetTokens: dreamBudget, detail: String(err?.message ?? err), ...dreamMeta });
    await storePut([projectId, 'coding-project'], 'memory', { ...memory, dreamAt: new Date().toISOString() } as any);
    return false;
  }
  const parsedDream = parseModelJson<Partial<ProjectCodingMemory>>(raw);
  if (!parsedDream) {
    recordExtractionOutcome({ userId: projectId, source: 'coding_project_dream', outcome: raw.trim() ? 'parse_error' : 'empty', ms: Date.now() - dreamStartedAt, budgetTokens: dreamBudget, detail: extractionDetailOf(raw), ...dreamMeta });
  }
  const updated: Partial<ProjectCodingMemory> = parsedDream ?? {};
  const next: ProjectCodingMemory & { dreamAt: string } = {
    overview: (updated.overview || '').slice(0, 1000),
    commands: (updated.commands || []).slice(0, 12),
    notes: (updated.notes || []).slice(0, 12),
    updatedAt: new Date().toISOString(),
    dreamAt: new Date().toISOString(),
  };
  // Anti-wipe: consolidation may prune, never erase a non-empty memory outright.
  const nextEmpty = !next.overview && !next.commands.length && !next.notes.length;
  if (hasContent && nextEmpty) {
    logger.warn(`coding-memory: project dream for ${projectId} returned empty — keeping existing memory`);
    await storePut([projectId, 'coding-project'], 'memory', { ...memory, dreamAt: next.dreamAt } as any);
    return false;
  }
  // Firing 11: same item clamp as the fold — the dream's consolidation output
  // gets the same length bound so a night of merges cannot grow items unboundedly.
  await storePut([projectId, 'coding-project'], 'memory', clampProjectMemoryItems(next) as any);
  recordExtractionOutcome({ userId: projectId, source: 'coding_project_dream', outcome: 'changed', ms: Date.now() - dreamStartedAt, budgetTokens: dreamBudget, detail: `${next.commands.length} cmds, ${next.notes.length} notes`, ...dreamMeta });
  logger.info(`coding-memory: project dream consolidated ${projectId} (${next.commands.length} cmds, ${next.notes.length} notes)`);
  return true;
}

/**
 * The dream as per-item ops (2026-10-20): merge duplicates = update one item + remove the others; stale
 * items removed; the overview refreshed with `set`. Fixed budget (CODING_PROJECT_DREAM_OPS_BUDGET_TOKENS).
 * Guards: `{}` is a noop; the anti-wipe rule (a non-empty memory is never emptied) and a removal-ratio
 * rule (PROJECT_DREAM_MAX_REMOVE_RATIO) reject the answer and keep the memory. A whole-object answer
 * (the old shape) is honoured as a replacement of the fields it carries, under the same guards.
 * Every outcome row carries budgetTokens + leg + finishReason like the whole-object dream's.
 */
async function dreamOneProjectOps(projectId: string, memory: ProjectCodingMemory, hasContent: boolean, summaries: string[]): Promise<boolean> {
  const spec = PROJECT_MEMORY_OPS_SPEC;
  const prompt = `You are the nightly consolidation ("dream") pass over DURABLE memory about one codebase, kept for an AI coding assistant.

Current project memory (each list item carries its [id]):
${renderStateForOps(memory, spec)}

Recent session summaries (newest first):
${summaries.map((s, i) => `${i + 1}. ${s.slice(0, 500)}`).join('\n') || '(none)'}

Consolidate: merge duplicate/overlapping notes and commands (UPDATE one of them by its [id] with the merged text and REMOVE the others), remove entries contradicted or made stale by newer sessions, refresh the overview with "set" if the sessions show it drifted, and keep ONLY durable facts (architecture, conventions, working commands, gotchas) — never transient task state. Do NOT invent anything not present in the inputs.

${opsInstruction(spec)}`;
  const dreamStartedAt = Date.now();
  const dreamBudget = CODING_PROJECT_DREAM_OPS_BUDGET_TOKENS;
  let raw = '';
  let dreamMeta: { leg?: string; finishReason?: string } = {};
  try {
    raw = await utilityChat([{ role: 'user', content: prompt }], {
      maxTokens: dreamBudget, temperature: 0.2, timeout: 90000, retryNotFound: true,
      thinking: true,
      contentOnly: true, // JSON extractor — see the whole-object dream above (2026-09-24)
      onMeta: (m) => { dreamMeta = { leg: m.leg, finishReason: m.finishReason }; },
    });
  } catch (err: any) {
    recordExtractionOutcome({ userId: projectId, source: 'coding_project_dream', outcome: 'llm_error', ms: Date.now() - dreamStartedAt, budgetTokens: dreamBudget, detail: String(err?.message ?? err), ...dreamMeta });
    await storePut([projectId, 'coding-project'], 'memory', { ...memory, dreamAt: new Date().toISOString() } as any);
    return false;
  }
  const stamp = new Date().toISOString();
  const keep = async (outcome: 'noop' | 'parse_error' | 'empty', detail: string) => {
    recordExtractionOutcome({ userId: projectId, source: 'coding_project_dream', outcome, ms: Date.now() - dreamStartedAt, budgetTokens: dreamBudget, detail, ...dreamMeta });
    await storePut([projectId, 'coding-project'], 'memory', { ...memory, dreamAt: stamp } as any);
    return false;
  };
  const parsed = parseStateOps(raw, spec);
  if (!parsed) return keep(raw.trim() ? 'parse_error' : 'empty', extractionDetailOf(raw));
  const applied = applyStateOps(memory, parsed.ops, spec);
  const next: ProjectCodingMemory & { dreamAt: string } = {
    overview: applied.state.overview || '',
    commands: applied.state.commands || [],
    notes: applied.state.notes || [],
    updatedAt: stamp,
    dreamAt: stamp,
  };
  // Anti-wipe: consolidation may prune, never erase a non-empty memory outright.
  if (hasContent && !next.overview && !next.commands.length && !next.notes.length) {
    logger.warn(`coding-memory: project dream for ${projectId} would empty the memory — keeping existing memory`);
    return keep('noop', `anti-wipe: the answer would empty a non-empty memory; ${describeOps(parsed, applied)}`);
  }
  // Removal ratio: ops count their explicit removals; a whole-object answer counts what it left out.
  const removed = parsed.legacyShape
    ? droppedByReplacement(memory, next, spec)
    : applied.counts.removed + clearedTextFields(memory, next, spec);
  const linesBefore = [memory.overview, ...memory.commands, ...memory.notes].filter(Boolean).length;
  if (projectDreamRemovalRefused(removed, linesBefore)) {
    // Ticket 585e2688 (log-signal family, 2026-10-30): this guard REFUSING an
    // over-aggressive dream is the guard WORKING, not a fault — the memory is
    // kept and the refusal is already recorded durably and per-project as an
    // extraction_outcome row (source 'coding_project_dream', outcome 'noop',
    // detail 'removal guard: N/M lines; <ops>'). It fired at UNTAGGED warn on
    // every nightly dream of a small (≤25-line) memory, so the sweep filed it
    // as a standing defect in perpetuity (24 rows / 13 hours). Same taxonomy
    // rule as log-level.ts's own header: "a guard that refused a dangerous
    // command is handled (the refusal is the product)". logClass:'handled' at
    // info; message text UNCHANGED so greps and audit pins keep matching.
    logHandled(`coding-memory: project dream for ${projectId} would remove ${removed}/${linesBefore} lines (>${Math.round(PROJECT_DREAM_MAX_REMOVE_RATIO * 100)}%) — keeping existing memory`);
    return keep('noop', `removal guard: ${removed}/${linesBefore} lines; ${describeOps(parsed, applied)}`);
  }
  if (!applied.changed) return keep('noop', describeOps(parsed, applied));
  logEvicted('project dream', projectId, applied.evicted);
  await storePut([projectId, 'coding-project'], 'memory', next as any);
  recordExtractionOutcome({ userId: projectId, source: 'coding_project_dream', outcome: 'changed', ms: Date.now() - dreamStartedAt, budgetTokens: dreamBudget, detail: `${next.commands.length} cmds, ${next.notes.length} notes; ${describeOps(parsed, applied)}`, ...dreamMeta });
  logger.info(`coding-memory: project dream consolidated ${projectId} (${next.commands.length} cmds, ${next.notes.length} notes; ${describeOps(parsed, applied)})`);
  return true;
}

// ── Learnings-file dream cycle (audit #11) ────────────────────────────────────
// `.digby/notes/learnings.md` accumulates one bullet per durable discovery and
// gets union-merged across sessions, so verbatim duplicates and near-duplicate
// restatements pile up (7 confirmed verbatim pairs as of 2026-09). dreamLearnings
// extends the nightly dream pattern beside dreamCodingProjects: mechanical
// dedupe of identical entries, then a bounded utility-LLM merge of near-duplicate
// clusters — with the same anti-wipe guard style as dreamOneProject: NEVER drop
// >30% of entries; on a guard trip the original content is returned untouched
// plus a warning.
//
// WIRE-ME (repo-write channel): the nightly dream scheduler
// (memory-maintenance.service.ts) runs in the web/worker process with NO
// worktree — dreamCodingProjects persists to the context store, not to files,
// so there is no channel from that lane to rewrite a repo-committed file.
// dreamLearnings is therefore pure content-in → content-out: the nightly
// self-improvement CODING session (which owns a worktree + git) should
// read_file learnings.md, run this, write_file the result when `changed`,
// and commit it.
// 2026-10-20: the SCHEDULED dream works on the learnings INDEX instead (what
// agents actually read) — learnings-dream.ts runLearningsDreamCycle, same
// clustering + merge, wired to a worker cron.

// The dream's rules (LEARNINGS_DREAM_MAX_DROP_RATIO 0.3, NEAR_DUP_JACCARD 0.55, MAX_MERGE_CLUSTERS 8,
// MAX_CLUSTER_SIZE 4, MIN_MERGED_CHARS 30) live in learnings-dream.ts since 2026-10-20 — the scheduled
// INDEX dream applies the same clustering + merge to the learnings index (the cron box has no worktree).

export interface DreamLearningsResult {
  /** The rewrite candidate (== the input when changed is false). */
  content: string;
  changed: boolean;
  entriesBefore: number;
  entriesAfter: number;
  /** Entries dropped as byte-identical (normalized) duplicates. */
  removedVerbatim: number;
  /** Entries absorbed into LLM-merged near-duplicate clusters. */
  mergedNearDupes: number;
  guardTripped: boolean;
  warning?: string;
}

/**
 * Dedupe/merge pass over the learnings.md CONTENT. Pure with respect to the
 * repo (see WIRE-ME above): never reads or writes files. Best-effort — an LLM
 * failure degrades to mechanical dedupe only; a guard trip returns the input.
 */
export async function dreamLearnings(markdown: string): Promise<DreamLearningsResult> {
  const unchanged = (warning?: string, guardTripped = false, before = 0): DreamLearningsResult => ({
    content: markdown, changed: false, entriesBefore: before, entriesAfter: before,
    removedVerbatim: 0, mergedNearDupes: 0, guardTripped, warning,
  });
  const doc = parseLearningsDoc(markdown || '');
  const entryIdx = doc.segments.map((s, i) => ({ ...s, i })).filter(s => s.kind === 'entry');
  const entriesBefore = entryIdx.length;
  if (!entriesBefore) return unchanged();

  // ── 1. Mechanical dedupe: identical (normalized) entries keep the FIRST copy ──
  const drop = new Set<number>(); // segment indexes to remove
  const firstByNorm = new Map<string, number>();
  let removedVerbatim = 0;
  for (const e of entryIdx) {
    const norm = normalizeEntry(e.text);
    if (firstByNorm.has(norm)) { drop.add(e.i); removedVerbatim++; }
    else firstByNorm.set(norm, e.i);
  }

  // ── 2. Near-duplicate clusters among the survivors (bounded union-find —
  //      learnings-dream.ts nearDuplicateClusters, shared with the index dream) ──
  const survivors = entryIdx.filter(e => !drop.has(e.i));
  const clusters = nearDuplicateClusters(survivors.map(s => s.text)).map(c => c.map(k => survivors[k].i));

  // ── 3. Utility-LLM merge of each cluster into ONE entry (best-effort;
  //      learnings-dream.ts mergeLearningGroups — garbage merges come back null) ──
  const merged = new Map<number, string>(); // first-member segment index → merged text
  let mergedNearDupes = 0;
  if (clusters.length) {
    try {
      const textOf = (i: number) => normalizeEntry(doc.segments[i].text);
      const outs = await mergeLearningGroups(clusters.map(c => ({
        texts: c.map(textOf),
        maxLen: c.reduce((n, i) => n + doc.segments[i].text.length, 0),
      })));
      clusters.forEach((c, gi) => {
        const text = outs[gi];
        if (!text) return; // garbage merge → keep originals
        merged.set(c[0], text);
        for (const i of c.slice(1)) drop.add(i);
        mergedNearDupes += c.length - 1;
      });
    } catch (err: any) {
      logger.warn(`coding-memory: learnings dream LLM merge failed (mechanical dedupe still applies): ${err.message}`);
    }
  }

  // ── 4. Anti-wipe guard: a dedupe may prune, never gut the file ──
  const droppedTotal = removedVerbatim + mergedNearDupes;
  if (droppedTotal === 0) return unchanged(undefined, false, entriesBefore);
  if (droppedTotal > entriesBefore * LEARNINGS_DREAM_MAX_DROP_RATIO) {
    const warning = `learnings dream would drop ${droppedTotal}/${entriesBefore} entries (>${Math.round(LEARNINGS_DREAM_MAX_DROP_RATIO * 100)}%) — keeping the original file`;
    logger.warn(`coding-memory: ${warning}`);
    return { ...unchanged(warning, true, entriesBefore) };
  }

  // ── 5. Rebuild: header + surviving segments in order (merged text replaces
  //      its cluster's first member; blank-line runs normalize to one entry/line) ──
  const body = doc.segments
    .map((s, i) => {
      if (s.kind !== 'entry') return s.text;
      if (drop.has(i)) return null;
      const m = merged.get(i);
      return m ? `- ${m}` : s.text;
    })
    .filter((t): t is string => t !== null)
    .join('\n');
  const content = `${doc.header}\n\n${body}\n`;
  logger.info(`coding-memory: learnings dream deduped ${removedVerbatim} verbatim + merged ${mergedNearDupes} near-dup entries (${entriesBefore} → ${entriesBefore - droppedTotal})`);
  return {
    content, changed: true,
    entriesBefore, entriesAfter: entriesBefore - droppedTotal,
    removedVerbatim, mergedNearDupes, guardTripped: false,
  };
}

/**
 * Fire-and-forget update of project + session memory after a turn.
 * `transcript` is a compact string of the user message + what the agent did.
 */
export function updateCodingMemoryAsync(input: {
  userId: string;
  projectId: string;
  sessionId: string;
  userMessage: string;
  assistantSummary: string;
  toolsUsed: string[];
}): void {
  // audit 2026-10-08 W3-1: tracked so a draining worker awaits it before exit.
  void trackBackground((async () => {
    try {
      const [user, project, session] = await Promise.all([
        getUserCodingMemory(input.userId),
        getProjectMemory(input.projectId),
        getSessionMemory(input.sessionId),
      ]);

      // N3 (2026-09-25): the fold gate — ONE prefill over the three legs'
      // nouls, STARTED before the legs. Shadow: it rides alongside (never
      // awaited before a leg — timing byte-identical to the pre-gate path;
      // each leg's label lands via the promise). Act: the answer is needed
      // before a leg can be skipped, so the legs wait (≤ 3 s, background
      // path). Fail-open: a null gate ⇒ every leg runs exactly as before.
      // Acting keys on the RESULT's mode inside the gate module (E2).
      const gateP = consultCodingMemoryFoldGate({
        legs: ['session', 'project', 'user'],
        userMessage: input.userMessage, assistantSummary: input.assistantSummary, toolsUsed: input.toolsUsed,
        sessionId: input.sessionId,
        existing: {
          sessionSummary: session?.summary ?? null, projectCommands: project.commands, projectNotes: project.notes, userPreferences: user.preferences,
          // backlog E14 (2026-09-28): last-fold ages ride the gate state (codingMemoryFoldStateFacts).
          sessionUpdatedAt: session?.updatedAt ?? null, projectUpdatedAt: project.updatedAt || null, userUpdatedAt: user.updatedAt || null,
        },
      });
      const skip = codingMemoryFoldGateWaitsFirst() ? (await gateP).skip : { session: false, project: false, user: false, journal: false };

      // ── Session summary (always) ──
      if (skip.session) labelCodingMemoryFold(gateP, 'session', 'skipped', input.sessionId);
      const sessPrompt = `You maintain a rolling summary of an AI coding session. Keep it to 4-6 sentences covering what has been built/changed and the current goal.

Previous summary:
${session?.summary || '(none yet)'}

Latest exchange:
User: ${input.userMessage.slice(0, 800)}
Assistant did: ${input.assistantSummary.slice(0, 800)}
Tools used: ${input.toolsUsed.join(', ') || 'none'}

Return ONLY the updated summary text (no preamble).`;
      const newSummary = skip.session ? '' : (await utilityChat([{ role: 'user', content: sessPrompt }], {
        maxTokens: 300, temperature: 0.3, timeout: 30000, retryNotFound: true,
      })).trim();
      if (newSummary) {
        await storePut([input.sessionId, 'coding-session'], 'memory', {
          summary: newSummary, updatedAt: new Date().toISOString(),
        } satisfies SessionCodingMemory as any);
      }
      // N3 label: the summary text actually moved (a paraphrase nearly always does — see the gate module's caveat).
      if (!skip.session) {
        labelCodingMemoryFold(gateP, 'session', newSummary ? (newSummary !== (session?.summary ?? '').trim() ? 'changed' : 'noop') : 'failed', input.sessionId);
      }

      // ── Project memory (only when there's something durable to learn) + user memory (tier 1:
      //    only durable, CROSS-PROJECT developer prefs). 2026-10-20 memory wave: both answer with
      //    per-item CHANGES (memory/state-ops.ts); MEMORY_STATE_OPS_DISABLED=1 runs the whole-object
      //    legs — today's code, moved below unchanged.
      if (memoryStateOpsEnabled()) {
        await foldProjectMemoryOps(input, project, gateP, skip.project);
        await foldUserMemoryOps(input, user, gateP, skip.user);
      } else {
        await foldProjectMemoryWholeObject(input, project, gateP, skip.project);
        await foldUserMemoryWholeObject(input, user, gateP, skip.user);
      }
    } catch (err: any) {
      logger.debug(`coding-memory: update failed (non-fatal): ${err.message}`);
    }
  })(), 'coding-memory-fold');
}

type CodingMemoryFoldInput = Parameters<typeof updateCodingMemoryAsync>[0];
type CodingMemoryFoldGate = ReturnType<typeof consultCodingMemoryFoldGate>;

// ── Whole-object legs (pre-2026-10-20; MEMORY_STATE_OPS_DISABLED=1) ──────────
// Moved out of updateCodingMemoryAsync unchanged: same prompts, budgets, parsing, guards, rows, labels.

async function foldProjectMemoryWholeObject(input: CodingMemoryFoldInput, project: ProjectCodingMemory, gateP: CodingMemoryFoldGate, skipLeg: boolean): Promise<void> {
  // The prompt embeds the CURRENT state and the model echoes it back
  // updated, so the output budget scales with the state shown (firing 11 —
  // the firing-10b fixed 3000 truncated a 5,098 B CQL state mid-string;
  // see codingMemoryEchoBudget).
  const shownProjectState = JSON.stringify({ overview: project.overview, commands: project.commands, notes: project.notes });
  const foldBudget = codingMemoryEchoBudget(shownProjectState.length);
  const projPrompt = `You maintain DURABLE memory about a codebase for an AI coding assistant. Update it with only project-agnostic, long-lived facts learned in the latest exchange: architecture, conventions, working build/test/lint/run commands, and gotchas. Do NOT store transient task state.

Current memory:
${shownProjectState}

Latest exchange:
User: ${input.userMessage.slice(0, 600)}
Assistant did: ${input.assistantSummary.slice(0, 800)}
Tools used: ${input.toolsUsed.join(', ') || 'none'}

Return ONLY valid JSON:
{"overview": "...", "commands": ["cmd"], "notes": ["note"]}
Keep commands + notes deduped, most useful first, max 12 each, each entry under 200 chars. Preserve still-valid existing entries.`;
  // 500 tokens truncated a 12+12-entry JSON the same way as the dream
  // (2026-09-22) — a silent "no update" every run. 1500 + tolerant parse
  // was STILL truncating on large states (FO firing-10b audit 2026-09-23:
  // coding_project_fold parse_error 2/2, cut mid-string, budget column
  // NULL): fa945d380 raised the budget but skipped the dream's proven
  // cure — reasoning on. Same rule as the dream now: reasoning (shared
  // kill switch), a budget that fits the LARGEST legal answer (the fold
  // echoes a ~1000-char overview + 12 commands + 12 notes pretty-printed),
  // and the budget lands in the outcome row so the live-audit column can
  // prove it (firing-8 threaded the field but this caller never sent it).
  const foldStartedAt = Date.now();
  let foldMeta: { leg?: string; finishReason?: string } = {};
  // N3: a gate-skipped fold makes NO utility call and records no
  // memory_extraction row (nothing ran) — only the gate's own outcome row.
  const raw = skipLeg ? '' : await utilityChat([{ role: 'user', content: projPrompt }], {
    maxTokens: foldBudget, temperature: 0.3, timeout: 60000, retryNotFound: true,
    thinking: true,
    contentOnly: true, // JSON extractor — see the dream call above (2026-09-24)
    onMeta: (m) => { foldMeta = { leg: m.leg, finishReason: m.finishReason }; },
  });
  const parsedFold = skipLeg ? null : parseModelJson<Partial<ProjectCodingMemory>>(raw);
  /** N3 label input: the doc as actually stored by this fold (null = nothing written). */
  let projectStored: ProjectCodingMemory | null = null;
  if (skipLeg) {
    labelCodingMemoryFold(gateP, 'project', 'skipped', input.sessionId);
  } else if (!parsedFold) {
    recordExtractionOutcome({ userId: input.projectId, source: 'coding_project_fold', outcome: raw.trim() ? 'parse_error' : 'empty', ms: Date.now() - foldStartedAt, budgetTokens: foldBudget, detail: extractionDetailOf(raw), ...foldMeta });
  } else {
    // A healthy fold is no longer silent (absence of a parse_error row was
    // the exact shape that hid the dream breakage for two nights).
    recordExtractionOutcome({ userId: input.projectId, source: 'coding_project_fold', outcome: (parsedFold.overview || parsedFold.commands || parsedFold.notes) ? 'changed' : 'noop', ms: Date.now() - foldStartedAt, budgetTokens: foldBudget, ...foldMeta });
  }
  const updated: Partial<ProjectCodingMemory> = parsedFold ?? {};
  if (updated && (updated.overview || updated.commands || updated.notes)) {
    const next = mergeProjectFoldReplace(input, project, updated);
    await storePut([input.projectId, 'coding-project'], 'memory', next as any);
    projectStored = next;
  }
  // N3 label: did the fold actually change the stored project doc (content diff, updatedAt excluded)?
  if (!skipLeg) {
    labelCodingMemoryFold(gateP, 'project', !parsedFold ? 'failed' : projectStored && memoryDocChanged(project, projectStored) ? 'changed' : 'noop', input.sessionId, `budget=${foldBudget}`);
  }
}

/**
 * The whole-object fold's REPLACE: the fields the answer carries replace the stored ones, under the
 * P6 shrink guard, then the firing-11 item clamp. Also serves an ops-path answer that came back in
 * the old whole-object shape (state-ops `legacyShape`).
 */
function mergeProjectFoldReplace(input: CodingMemoryFoldInput, project: ProjectCodingMemory, updated: Partial<ProjectCodingMemory>): ProjectCodingMemory {
  let next: ProjectCodingMemory = {
    overview: (updated.overview || project.overview || '').slice(0, 1000),
    commands: (updated.commands || project.commands || []).slice(0, 12),
    notes: (updated.notes || project.notes || []).slice(0, 12),
    updatedAt: new Date().toISOString(),
  };
  // (P0's noteMemoryReplace observation is superseded here by the P6
  // shrink GUARD below — one memory_shrunk row per event, and the guard
  // additionally PREVENTS the loss. noteMemoryReplace stays exported for
  // other replace sites.)
  // Shrink guard (P6 — B22/G11): a suspiciously smaller REPLACE keeps the
  // old entries and appends the new under a dated overview marker instead.
  const oldLines = [project.overview, ...project.commands, ...project.notes].filter(Boolean);
  const newLines = [next.overview, ...next.commands, ...next.notes].filter(Boolean);
  if (memoryShrankSuspiciously(oldLines, newLines)) {
    const day = new Date().toISOString().slice(0, 10);
    next = {
      overview: next.overview && next.overview !== project.overview
        ? `${project.overview}\n[${day} — shrink-guarded update] ${next.overview}`.slice(0, 2000)
        : (project.overview || next.overview),
      commands: appendUnique(project.commands || [], updated.commands || [], 24),
      notes: appendUnique(project.notes || [], updated.notes || [], 24),
      updatedAt: next.updatedAt,
    };
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.MEMORY_SHRUNK,
      sessionId: input.sessionId,
      meta: { store: 'project', oldLines: oldLines.length, newLines: newLines.length, oldChars: oldLines.join('\n').length, newChars: newLines.join('\n').length },
    });
    logger.warn(`coding-memory: project memory REPLACE for ${input.projectId} shrank suspiciously (${oldLines.length}→${newLines.length} lines) — kept old entries, appended new`);
  }
  // Firing 11: every successful fold write clamps item length (≤240 chars,
  // head+tail elision) so a legal 12+12 state can never outgrow the echo
  // budget — item LENGTH is the growth vector (1,068-char note measured).
  return clampProjectMemoryItems(next);
}

async function foldUserMemoryWholeObject(input: CodingMemoryFoldInput, user: UserCodingMemory, gateP: CodingMemoryFoldGate, skipLeg: boolean): Promise<void> {
  const userPrompt = `You maintain durable, CROSS-PROJECT preferences for a developer using an AI coding assistant. Capture only standing, project-agnostic preferences revealed in the latest exchange — tooling choices (package manager, test runner), code style, commit/PR conventions, and how they want the assistant to behave. Do NOT store anything specific to one codebase or one task.

Current preferences:
${JSON.stringify(user, null, 2)}

Latest exchange:
User: ${input.userMessage.slice(0, 600)}
Assistant did: ${input.assistantSummary.slice(0, 600)}

Return ONLY valid JSON: {"preferences": ["..."], "notes": ["..."]}
Deduped, most useful first, max 15 preferences / 10 notes. Preserve still-valid existing entries. If nothing durable and cross-project was revealed, return the current lists unchanged.`;
  if (skipLeg) labelCodingMemoryFold(gateP, 'user', 'skipped', input.sessionId);
  const rawUser = skipLeg ? '' : await utilityChat([{ role: 'user', content: userPrompt }], {
    maxTokens: 400, temperature: 0.3, timeout: 30000, retryNotFound: true, contentOnly: true,
  });
  const updatedUser = skipLeg ? null : parseJson<Partial<UserCodingMemory>>(rawUser, {});
  /** N3 label input: the doc as actually stored by this rewrite (null = nothing written). */
  let userStored: UserCodingMemory | null = null;
  if (updatedUser && (updatedUser.preferences || updatedUser.notes)) {
    const nextUser = mergeUserFoldReplace(input, user, updatedUser);
    await storePut([input.userId, 'coding-user'], 'memory', nextUser as any);
    userStored = nextUser;
  }
  // N3 label: an empty raw answer is an LLM failure (parseJson's {} fallback
  // cannot tell it from garbage, so raw is the tell); a parsed answer with no
  // lists / an identical doc is a noop; a stored doc that differs is changed.
  if (!skipLeg) {
    labelCodingMemoryFold(gateP, 'user', !rawUser.trim() ? 'failed' : userStored && memoryDocChanged(user, userStored) ? 'changed' : 'noop', input.sessionId);
  }
}

/** The whole-object user-prefs REPLACE under the P6 shrink guard (also serves old-shape ops answers). */
function mergeUserFoldReplace(input: CodingMemoryFoldInput, user: UserCodingMemory, updatedUser: Partial<UserCodingMemory>): UserCodingMemory {
  let nextUser: UserCodingMemory = {
    preferences: (updatedUser.preferences || user.preferences || []).slice(0, 15),
    notes: (updatedUser.notes || user.notes || []).slice(0, 10),
    updatedAt: new Date().toISOString(),
  };
  // Same shrink guard as project memory (P6 — B22/G11); its emission
  // supersedes P0's noteMemoryReplace observation at this site.
  const oldULines = [...user.preferences, ...user.notes].filter(Boolean);
  const newULines = [...nextUser.preferences, ...nextUser.notes].filter(Boolean);
  if (memoryShrankSuspiciously(oldULines, newULines)) {
    nextUser = {
      preferences: appendUnique(user.preferences || [], updatedUser.preferences || [], 30),
      notes: appendUnique(user.notes || [], updatedUser.notes || [], 20),
      updatedAt: nextUser.updatedAt,
    };
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.MEMORY_SHRUNK,
      sessionId: input.sessionId,
      meta: { store: 'user', oldLines: oldULines.length, newLines: newULines.length, oldChars: oldULines.join('\n').length, newChars: newULines.join('\n').length },
    });
    logger.warn(`coding-memory: user memory REPLACE for ${input.userId.slice(0, 8)} shrank suspiciously (${oldULines.length}→${newULines.length} lines) — kept old entries, appended new`);
  }
  return nextUser;
}

// ── Per-item ops legs (2026-10-20 memory wave) ───────────────────────────────

/**
 * The per-run project fold as ops: the memory is shown with an [id] per item, the model answers with
 * only what this run taught (`{}` most runs), the budget is FIXED (CODING_PROJECT_FOLD_OPS_BUDGET_TOKENS)
 * because the answer is bounded by the change. Same reasoning + JSON-extractor call shape, same outcome
 * rows (budgetTokens + leg + finishReason), same N3 labels as the whole-object fold. Shrink guard for
 * ops: an answer removing more than MEMORY_SHRINK_MAX_LINE_DROP items is REFUSED (nothing written,
 * memory_shrunk row); `{}` is a noop, never a shrink. List overflow evicts the oldest items (logged).
 */
async function foldProjectMemoryOps(input: CodingMemoryFoldInput, project: ProjectCodingMemory, gateP: CodingMemoryFoldGate, skipLeg: boolean): Promise<void> {
  if (skipLeg) {
    labelCodingMemoryFold(gateP, 'project', 'skipped', input.sessionId);
    return;
  }
  const spec = PROJECT_MEMORY_OPS_SPEC;
  const foldBudget = CODING_PROJECT_FOLD_OPS_BUDGET_TOKENS;
  const projPrompt = `You maintain DURABLE memory about a codebase for an AI coding assistant. Update it with only project-agnostic, long-lived facts learned in the latest exchange: architecture, conventions, working build/test/lint/run commands, and gotchas. Do NOT store transient task state.

Current memory (each list item carries its [id]):
${renderStateForOps(project, spec)}

Latest exchange:
User: ${input.userMessage.slice(0, 600)}
Assistant did: ${input.assistantSummary.slice(0, 800)}
Tools used: ${input.toolsUsed.join(', ') || 'none'}

${opsInstruction(spec)}
Add a command only when this exchange showed it working. Keep every item under 200 characters, and never add an item that is already there (update it instead). Remove an item only when this exchange proved it wrong or obsolete. Most exchanges teach nothing durable — then return {}.`;
  const foldStartedAt = Date.now();
  let foldMeta: { leg?: string; finishReason?: string } = {};
  const raw = await utilityChat([{ role: 'user', content: projPrompt }], {
    maxTokens: foldBudget, temperature: 0.3, timeout: 60000, retryNotFound: true,
    thinking: true,
    contentOnly: true, // JSON extractor — see the dream call above (2026-09-24)
    onMeta: (m) => { foldMeta = { leg: m.leg, finishReason: m.finishReason }; },
  });
  const outcome = (o: 'changed' | 'noop' | 'parse_error' | 'empty', detail?: string) =>
    recordExtractionOutcome({ userId: input.projectId, source: 'coding_project_fold', outcome: o, ms: Date.now() - foldStartedAt, budgetTokens: foldBudget, ...(detail ? { detail } : {}), ...foldMeta });
  const parsed = parseStateOps(raw, spec);
  /** N3 label input: the doc as actually stored by this fold (null = nothing written). */
  let projectStored: ProjectCodingMemory | null = null;
  if (!parsed) {
    outcome(raw.trim() ? 'parse_error' : 'empty', extractionDetailOf(raw));
  } else if (parsed.legacyShape) {
    // The model answered in the OLD whole-object shape: honour it with the whole-object REPLACE
    // semantics (P6 shrink guard + item clamp) — never a silent loss of the answer.
    const updated = legacyFieldsOf(parsed.ops) as Partial<ProjectCodingMemory>;
    const carries = !!(updated.overview || updated.commands || updated.notes);
    outcome(carries ? 'changed' : 'noop', `ops legacy-shape (whole-object replace)${parsed.salvaged ? ' salvaged' : ''}`);
    if (carries) {
      const next = mergeProjectFoldReplace(input, project, updated);
      await storePut([input.projectId, 'coding-project'], 'memory', next as any);
      projectStored = next;
    }
  } else {
    const applied = applyStateOps(project, parsed.ops, spec);
    const removed = applied.counts.removed + clearedTextFields(project, applied.state, spec);
    if (opsFoldRemovalRefused(removed)) {
      const oldLines = [project.overview, ...project.commands, ...project.notes].filter(Boolean).length;
      recordLoopMetric({
        kind: LOOP_METRIC_KINDS.MEMORY_SHRUNK,
        sessionId: input.sessionId,
        meta: { store: 'project', mode: 'ops', refused: true, removed, oldLines },
      });
      // Ticket 585e2688 sibling (adversarial review PR #2103 S1): the SAME
      // doctrine as the dream removal guard below — a guard that REFUSED a
      // dangerous shrink is the guard working, not a fault, and it is already
      // recorded durably on the memory_shrunk loop_metrics row above
      // (meta.refused true) plus the 'noop' outcome. Emitting it at untagged
      // warn put a designed refusal into the log-signal sweep's rule-1 class
      // every time. logHandled (info); message text unchanged.
      logHandled(`coding-memory: project fold for ${input.projectId} would remove ${removed} items (> ${MEMORY_SHRINK_MAX_LINE_DROP}) in one run — answer refused, memory kept`);
      outcome('noop', `shrink guard refused (${removed} removals); ${describeOps(parsed, applied)}`);
    } else {
      if (applied.unknown.length) logger.debug(`coding-memory: project fold for ${input.projectId} named unknown ids/fields (ignored): ${applied.unknown.slice(0, 8).join(', ')}`);
      if (applied.changed) {
        logEvicted('project fold', input.projectId, applied.evicted);
        const next: ProjectCodingMemory = {
          overview: applied.state.overview || '',
          commands: applied.state.commands || [],
          notes: applied.state.notes || [],
          updatedAt: new Date().toISOString(),
        };
        await storePut([input.projectId, 'coding-project'], 'memory', next as any);
        projectStored = next;
      }
      outcome(applied.changed ? 'changed' : 'noop', describeOps(parsed, applied));
    }
  }
  // N3 label: did the fold actually change the stored project doc (content diff, updatedAt excluded)?
  labelCodingMemoryFold(gateP, 'project', !parsed ? 'failed' : projectStored && memoryDocChanged(project, projectStored) ? 'changed' : 'noop', input.sessionId, `budget=${foldBudget}`);
}

/**
 * The user-prefs leg as ops (it re-emitted two lists at 400 tokens — the same echo class): same budget,
 * same call shape, same N3 label rule; ops shrink guard as the project fold; an old-shape answer is
 * honoured with the whole-object REPLACE (P6 guard).
 */
async function foldUserMemoryOps(input: CodingMemoryFoldInput, user: UserCodingMemory, gateP: CodingMemoryFoldGate, skipLeg: boolean): Promise<void> {
  if (skipLeg) {
    labelCodingMemoryFold(gateP, 'user', 'skipped', input.sessionId);
    return;
  }
  const spec = USER_CODING_MEMORY_OPS_SPEC;
  const userPrompt = `You maintain durable, CROSS-PROJECT preferences for a developer using an AI coding assistant. Capture only standing, project-agnostic preferences revealed in the latest exchange — tooling choices (package manager, test runner), code style, commit/PR conventions, and how they want the assistant to behave. Do NOT store anything specific to one codebase or one task.

Current preferences (each item carries its [id]):
${renderStateForOps(user, spec)}

Latest exchange:
User: ${input.userMessage.slice(0, 600)}
Assistant did: ${input.assistantSummary.slice(0, 600)}

${opsInstruction(spec)}
Never add an item that is already there (update it instead); remove one only when the developer contradicted it. If nothing durable and cross-project was revealed, return {}.`;
  const rawUser = await utilityChat([{ role: 'user', content: userPrompt }], {
    maxTokens: CODING_USER_FOLD_OPS_BUDGET_TOKENS, temperature: 0.3, timeout: 30000, retryNotFound: true, contentOnly: true,
  });
  const parsed = parseStateOps(rawUser, spec);
  /** N3 label input: the doc as actually stored by this rewrite (null = nothing written). */
  let userStored: UserCodingMemory | null = null;
  if (parsed?.legacyShape) {
    const updatedUser = legacyFieldsOf(parsed.ops) as Partial<UserCodingMemory>;
    if (updatedUser.preferences || updatedUser.notes) {
      const nextUser = mergeUserFoldReplace(input, user, updatedUser);
      await storePut([input.userId, 'coding-user'], 'memory', nextUser as any);
      userStored = nextUser;
    }
  } else if (parsed) {
    const applied = applyStateOps(user, parsed.ops, spec);
    if (opsFoldRemovalRefused(applied.counts.removed)) {
      recordLoopMetric({
        kind: LOOP_METRIC_KINDS.MEMORY_SHRUNK,
        sessionId: input.sessionId,
        meta: { store: 'user', mode: 'ops', refused: true, removed: applied.counts.removed, oldLines: [...user.preferences, ...user.notes].filter(Boolean).length },
      });
      // Same doctrine as the project-fold guard above (PR #2103 S1): a refused
      // shrink is the guard working, already durable on the memory_shrunk row.
      logHandled(`coding-memory: user memory fold for ${input.userId.slice(0, 8)} would remove ${applied.counts.removed} items in one run — answer refused, memory kept`);
    } else if (applied.changed) {
      logEvicted('user memory fold', input.userId.slice(0, 8), applied.evicted);
      const nextUser: UserCodingMemory = {
        preferences: applied.state.preferences || [],
        notes: applied.state.notes || [],
        updatedAt: new Date().toISOString(),
      };
      await storePut([input.userId, 'coding-user'], 'memory', nextUser as any);
      userStored = nextUser;
    }
  }
  // N3 label: same rule as the whole-object leg — an empty raw answer is an LLM failure.
  labelCodingMemoryFold(gateP, 'user', !rawUser.trim() ? 'failed' : userStored && memoryDocChanged(user, userStored) ? 'changed' : 'noop', input.sessionId);
}
