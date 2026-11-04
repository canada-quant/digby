/**
 * LEARNINGS DREAM — near-duplicate merging for `.digby/notes/learnings.md` entries (2026-10-20 memory wave).
 *
 * Two consumers share ONE clustering + merge (so the file dream and the index dream can never drift):
 *
 *   - coding-memory.service `dreamLearnings(markdown)` — the FILE dream: content in → content out, run by
 *     hand (`npm run dream:learnings`) or by a coding session that owns a worktree.
 *   - `runLearningsDreamCycle()` below — the SCHEDULED dream over the learnings INDEX. The cron worker
 *     (box A) has no worktree and no git, and project mirrors live only on the coding box, so nothing can
 *     rewrite a project's file on a schedule. Agents read learnings through the index anyway
 *     (learnings-index.service: one digby_memory row per file entry, project scope, source 'learning',
 *     content-addressed ref `learning:<sha1>`), so the scheduled dream works on the index, never the file:
 *
 *       near-dup cluster of entries ──LLM merge──▶ ONE row `learning-dream:<sha1(merged)>`
 *                                                  member rows deleted
 *                                                  state.merged[mergedRef] = memberRefs (original `learning:` refs)
 *
 *     Member refs STAY in state.refs, so the sync (which only adds refs it has not seen) never re-adds a
 *     member while its file entry exists. When the sync's sweep removes members (their entries left the
 *     file) and EVERY member of a group is gone, the sync deletes the merged row and drops the group
 *     (learnings-index.service syncLearningsIndex); while some members remain the merged row stays.
 *
 * Guards (the file dream's rules): absorb at most LEARNINGS_DREAM_MAX_DROP_RATIO of a project's entries per
 * pass, at most MAX_MERGE_CLUSTERS clusters of at most MAX_CLUSTER_SIZE entries, a merged entry must be at
 * least MIN_MERGED_CHARS and never longer than its members together; a member row is deleted only after its
 * merged row landed; an LLM failure changes nothing (dreamAt not stamped — the next cycle retries).
 *
 * Kill switch LEARNINGS_DREAM_DISABLED=1: runLearningsDreamCycle is a no-op. Merges already applied STAY
 * (their rows and state.merged are untouched). To get the raw entries back, force a re-index: clear the
 * project's `[projectId,'learnings-index']/state` refs (or bump GATE_VERSION) — the next sync re-adds every
 * file entry; delete the project's `learning-dream:*` rows as well, or they sit beside their members until
 * every member leaves the file.
 *
 * Known race (accepted, self-healing): the sync (coding box) and this dream (cron box) both write the index
 * state. The dream re-reads the state right before its write and touches only `merged` + `dreamAt`; the
 * sync carries both through its own write. A sync that read the state before the dream wrote it can drop
 * that pass's `merged` groups — the merged rows then stay until removed by hand (stale-but-searchable,
 * never a lost entry).
 */

import * as crypto from 'crypto';
import prisma from '../../../config/database';
import { storeGet, storePut } from '../memory/context-store';
import { memReplaceRef, type MemScope } from '../memory/unified-memory.service';
import { utilityChat } from '../../../utils/utility-llm';
import logger from '../../../utils/logger';
import { recordLoopMetric, LOOP_METRIC_KINDS } from '../platform/loop-metrics.service';
import { LEARNING_SOURCE, type LearningsIndexState } from './learnings-index.service';

// ── Shared rules (moved here from coding-memory.service — the file dream imports them) ──
export const LEARNINGS_DREAM_MAX_DROP_RATIO = 0.3; // anti-wipe: never drop >30% of entries
export const NEAR_DUP_JACCARD = 0.55;              // token-set similarity → near-dup candidates
export const MAX_MERGE_CLUSTERS = 8;               // bounded LLM work per pass
export const MAX_CLUSTER_SIZE = 4;
export const MIN_MERGED_CHARS = 30;                // a "merged" entry shorter than this is garbage — keep originals

// ── Index dream ──
/** A project's index is dreamt at most once per this many days. */
export const LEARNINGS_DREAM_MIN_GAP_DAYS = 7;
/** Ref prefix of a merged row (content-addressed like the sync's `learning:` refs). */
export const LEARNINGS_DREAM_REF_PREFIX = 'learning-dream:';
const LEARNINGS_DREAM_DEFAULT_MAX_PROJECTS = 20;
/** Bound on the rows read per project (the file holds ~200 entries; a runaway index must not be slurped). */
const LEARNINGS_DREAM_ROW_READ_CAP = 5000;
const INDEX_NS_SUFFIX = ':learnings-index';
const DAY_MS = 24 * 60 * 60 * 1000;

export function learningsDreamDisabled(): boolean {
  return process.env.LEARNINGS_DREAM_DISABLED === '1';
}

// ── Clustering (shared) ───────────────────────────────────────────────────────

export function distinctiveTokens(s: string): Set<string> {
  return new Set(s.toLowerCase().match(/[a-z0-9_./-]{4,}/g) || []);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Near-duplicate clusters among `texts` (bounded union-find over token-set Jaccard ≥ NEAR_DUP_JACCARD).
 * Returns clusters as ascending indexes into `texts`, ordered by their first member, each cut to
 * MAX_CLUSTER_SIZE, at most MAX_MERGE_CLUSTERS of them. Pure.
 */
export function nearDuplicateClusters(texts: string[]): number[][] {
  const toks = texts.map(distinctiveTokens);
  const parent = new Map<number, number>();
  const find = (x: number): number => { let r = x; while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!; return r; };
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (let i = 0; i < texts.length; i++) parent.set(i, i);
  for (let a = 0; a < texts.length; a++) {
    for (let b = a + 1; b < texts.length; b++) {
      if (jaccard(toks[a], toks[b]) >= NEAR_DUP_JACCARD) union(a, b);
    }
  }
  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < texts.length; i++) {
    const r = find(i);
    byRoot.set(r, [...(byRoot.get(r) || []), i]);
  }
  return [...byRoot.values()]
    .filter(c => c.length >= 2)
    .map(c => c.sort((x, y) => x - y).slice(0, MAX_CLUSTER_SIZE))
    .slice(0, MAX_MERGE_CLUSTERS);
}

function parseJson<T>(text: string, fallback: T): T {
  try { return JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim()) as T; } catch { return fallback; }
}

export interface LearningMergeGroup {
  /** The members' texts, oldest first (the newest wins a conflict). */
  texts: string[];
  /** A merged entry longer than this is garbage (the members' combined length). */
  maxLen: number;
}

/**
 * ONE utility-LLM call merging each group into one entry. Returns, per group, the merged text — or null
 * when the answer for it is missing or garbage (shorter than MIN_MERGED_CHARS, longer than `maxLen`).
 * Throws when the call itself fails (callers keep their originals).
 */
export async function mergeLearningGroups(groups: LearningMergeGroup[]): Promise<Array<string | null>> {
  if (!groups.length) return [];
  const prompt = `You are the nightly dedupe ("dream") pass over an append-only "learned conventions" file kept for an AI coding assistant. Each GROUP below contains near-duplicate entries recorded by different sessions. Merge each group into ONE entry that preserves EVERY distinct fact; where entries conflict, prefer the LAST entry in the group (it is the newest). Do NOT invent anything not present in the inputs, and do NOT summarize away specifics (paths, commands, ids, error strings).

${groups.map((g, gi) => `GROUP ${gi + 1}:\n${g.texts.map(t => `  - ${t}`).join('\n')}`).join('\n\n')}

Return ONLY valid JSON: {"merged": ["<one merged entry per group, in order, no leading bullet marker>"]}`;
  const raw = await utilityChat([{ role: 'user', content: prompt }], {
    maxTokens: 2000, temperature: 0.2, timeout: 60000, retryNotFound: true, contentOnly: true,
  });
  const parsed = parseJson<{ merged?: string[] }>(raw, {});
  const outs = Array.isArray(parsed.merged) ? parsed.merged : [];
  return groups.map((g, gi) => {
    const text = String(outs[gi] ?? '').replace(/^-\s+/, '').replace(/\s+/g, ' ').trim();
    if (text.length < MIN_MERGED_CHARS || text.length > g.maxLen) return null; // garbage merge → keep originals
    return text;
  });
}

// ── Index dream (scheduled) ───────────────────────────────────────────────────

export interface LearningsDreamCycleResult {
  /** Projects whose index was dreamt this cycle (dreamAt stamped). */
  projects: number;
  /** Clusters merged into one row. */
  clusters: number;
  /** Entries absorbed (a cluster of n entries absorbs n − 1). */
  absorbed: number;
}

function dreamAtMs(state: Partial<LearningsIndexState> | null | undefined): number {
  const t = state?.dreamAt ? Date.parse(state.dreamAt) : NaN;
  return Number.isFinite(t) ? t : 0;
}

/** True when the index has never been dreamt or its last dream is ≥ LEARNINGS_DREAM_MIN_GAP_DAYS old. */
export function learningsDreamDue(state: Partial<LearningsIndexState> | null | undefined, nowMs: number): boolean {
  return nowMs - dreamAtMs(state) >= LEARNINGS_DREAM_MIN_GAP_DAYS * DAY_MS;
}

/** The projects due for a dream, never-dreamt / oldest dream first. Throws on a store failure. */
async function dueProjects(nowMs: number, max: number): Promise<string[]> {
  const rows: Array<{ namespacePath: string; value: unknown }> = await (prisma as any).contextStoreEntry.findMany({
    where: { key: 'state', namespacePath: { endsWith: INDEX_NS_SUFFIX } },
    select: { namespacePath: true, value: true },
  });
  return (Array.isArray(rows) ? rows : [])
    .map(r => ({ projectId: String(r.namespacePath ?? '').slice(0, -INDEX_NS_SUFFIX.length), state: r.value as Partial<LearningsIndexState> | null }))
    .filter(x => x.projectId && x.state && typeof x.state === 'object'
      && x.state.refs && typeof x.state.refs === 'object' && Object.keys(x.state.refs).length >= 2
      && learningsDreamDue(x.state, nowMs))
    .sort((a, b) => dreamAtMs(a.state) - dreamAtMs(b.state))
    .slice(0, Math.max(0, max))
    .map(x => x.projectId);
}

interface IndexEntry { ref: string; text: string; rows: number }

/**
 * The project's 'learning' rows grouped by ref, oldest first. Read-only SQL. null when unreadable
 * (the caller must not read "no rows" into an unreadable store).
 */
async function readLearningEntries(projectId: string): Promise<IndexEntry[] | null> {
  try {
    const rows: Array<{ ref: string | null; content: string | null }> = await (prisma as any).$queryRawUnsafe(
      `SELECT ref, content FROM digby_memory WHERE scope_type = 'project' AND scope_id = $1 AND source = $2 ORDER BY created_at ASC, ref ASC LIMIT ${LEARNINGS_DREAM_ROW_READ_CAP}`,
      projectId, LEARNING_SOURCE,
    );
    const byRef = new Map<string, IndexEntry>();
    for (const r of Array.isArray(rows) ? rows : []) {
      const ref = String(r?.ref ?? '');
      if (!ref) continue;
      const e = byRef.get(ref);
      if (e) { e.rows++; continue; }
      byRef.set(ref, { ref, text: String(r?.content ?? ''), rows: 1 });
    }
    return [...byRef.values()];
  } catch {
    return null;
  }
}

const sha1 = (s: string) => crypto.createHash('sha1').update(s).digest('hex');

interface ProjectDreamOutcome {
  dreamt: boolean;
  clusters: number;
  absorbed: number;
}

async function dreamOneLearningsIndex(projectId: string, nowMs: number): Promise<ProjectDreamOutcome> {
  const none: ProjectDreamOutcome = { dreamt: false, clusters: 0, absorbed: 0 };
  const ns = [projectId, 'learnings-index'];
  const state = await storeGet<LearningsIndexState>(ns, 'state');
  if (!state?.refs || !learningsDreamDue(state, nowMs)) return none;
  const all = await readLearningEntries(projectId);
  if (!all) return none; // unreadable — retry next cycle, nothing stamped

  const merged: Record<string, string[]> = { ...(state.merged ?? {}) };
  // Only rows this index owns: a file entry the sync indexed, or a merged row of an earlier pass.
  const entries = all.filter(e => state.refs[e.ref] || merged[e.ref]);
  // A multi-row (chunked, > 3.5k chars) entry cannot be rebuilt reliably (chunks share created_at,
  // ids are random) — it never joins a cluster, but it still counts toward the 30 % base.
  const candidates = entries.filter(e => e.rows === 1 && e.text.trim());
  const maxAbsorb = Math.floor(entries.length * LEARNINGS_DREAM_MAX_DROP_RATIO);
  const clusters = nearDuplicateClusters(candidates.map(c => c.text));

  const meta = { index: 'learnings_dream', projectId, entries: entries.length, candidates: candidates.length, clusters: clusters.length, merged: 0, absorbed: 0, garbage: 0, guardSkipped: 0, storeFailed: 0, outcome: 'no_clusters' as string };
  const addedGroups: Record<string, string[]> = {};
  const removedGroups = new Set<string>();

  if (clusters.length) {
    let outs: Array<string | null>;
    try {
      outs = await mergeLearningGroups(clusters.map(c => ({
        texts: c.map(k => candidates[k].text),
        maxLen: c.reduce((n, k) => n + candidates[k].text.length, 0),
      })));
    } catch (err: any) {
      logger.warn(`learnings-dream: LLM merge failed for project ${projectId} — index unchanged: ${err?.message ?? err}`);
      recordLoopMetric({ kind: LOOP_METRIC_KINDS.INDEX_SWEPT, value: 0, meta: { ...meta, outcome: 'llm_error' } });
      return none;
    }
    const scope: MemScope = { type: 'project', id: projectId };
    for (let gi = 0; gi < clusters.length; gi++) {
      const text = outs[gi];
      if (!text) { meta.garbage++; continue; }
      const c = clusters[gi];
      if (meta.absorbed + (c.length - 1) > maxAbsorb) { meta.guardSkipped++; continue; }
      const memberRefs = c.map(k => candidates[k].ref);
      // Groups stay FLAT: a merged row joining a new cluster hands over its own members.
      const originals = [...new Set(memberRefs.flatMap(r => merged[r] ?? [r]))];
      const mergedRef = `${LEARNINGS_DREAM_REF_PREFIX}${sha1(text)}`;
      const stored = await memReplaceRef(scope, LEARNING_SOURCE, mergedRef, [{ title: text.slice(0, 120), content: text }], { skipCap: true, skipGate: true });
      if (!(stored > 0)) { meta.storeFailed++; continue; } // never delete members unless their merged row landed
      for (const r of memberRefs) {
        if (r === mergedRef) continue; // the model returned an existing merged row verbatim — it IS the new row
        await memReplaceRef(scope, LEARNING_SOURCE, r, []);
        if (merged[r]) { delete merged[r]; removedGroups.add(r); delete addedGroups[r]; }
      }
      merged[mergedRef] = [...new Set([...(merged[mergedRef] ?? []), ...originals])];
      addedGroups[mergedRef] = merged[mergedRef];
      removedGroups.delete(mergedRef);
      meta.merged++;
      meta.absorbed += c.length - 1;
    }
    meta.outcome = meta.merged ? 'merged' : 'unchanged';
  }

  // Write only what this pass owns (merged + dreamAt) onto the state as it is NOW — a sync may have
  // written refs / fileHash while the LLM call ran.
  const fresh = (await storeGet<LearningsIndexState>(ns, 'state')) ?? state;
  const finalMerged: Record<string, string[]> = { ...(fresh.merged ?? {}) };
  for (const r of removedGroups) delete finalMerged[r];
  Object.assign(finalMerged, addedGroups);
  await storePut(ns, 'state', {
    ...fresh,
    ...(fresh.merged || Object.keys(finalMerged).length ? { merged: finalMerged } : {}),
    dreamAt: new Date(nowMs).toISOString(),
  } as any);
  recordLoopMetric({ kind: LOOP_METRIC_KINDS.INDEX_SWEPT, value: meta.absorbed, meta });
  if (meta.merged) logger.info(`learnings-dream: project ${projectId} merged ${meta.merged} near-duplicate cluster(s), ${meta.absorbed} entr${meta.absorbed === 1 ? 'y' : 'ies'} absorbed (${entries.length} indexed)`);
  return { dreamt: true, clusters: meta.merged, absorbed: meta.absorbed };
}

/**
 * The scheduled learnings dream (wired to a worker cron by the caller): for each project whose
 * learnings index exists and whose last dream is ≥ LEARNINGS_DREAM_MIN_GAP_DAYS old, merge near-duplicate
 * entries in the INDEX (never the file). Sequential, one LLM call per project. Never throws.
 */
export async function runLearningsDreamCycle(opts?: { maxProjects?: number; now?: number | Date }): Promise<LearningsDreamCycleResult> {
  const result: LearningsDreamCycleResult = { projects: 0, clusters: 0, absorbed: 0 };
  if (learningsDreamDisabled()) return result;
  try {
    const nowMs = opts?.now instanceof Date ? opts.now.getTime() : typeof opts?.now === 'number' ? opts.now : Date.now();
    const projectIds = await dueProjects(nowMs, opts?.maxProjects ?? LEARNINGS_DREAM_DEFAULT_MAX_PROJECTS);
    for (const projectId of projectIds) {
      try {
        const r = await dreamOneLearningsIndex(projectId, nowMs);
        if (!r.dreamt) continue;
        result.projects++;
        result.clusters += r.clusters;
        result.absorbed += r.absorbed;
      } catch (err: any) {
        logger.warn(`learnings-dream: project ${projectId} failed (non-fatal): ${err?.message ?? err}`);
      }
    }
  } catch (err: any) {
    logger.warn(`learnings-dream: cycle failed (non-fatal): ${err?.message ?? err}`);
  }
  return result;
}
