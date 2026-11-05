/**
 * LEARNINGS SEMANTIC INDEX (audit #11) — makes `.digby/notes/learnings.md`
 * REACHABLE. The file holds ~190 durable, hard-won conventions but agents only
 * ever saw a 4,000-char head slice (the ~10 OLDEST entries). This service
 * mirrors the code-index pattern (code-index.service.ts) over the same unified
 * digby_memory store:
 *
 *   scope:  { type: 'project', id: projectId }  (the repo scope code-index uses)
 *   source: 'learning'                          (one row per entry)
 *   ref:    'learning:<sha1(normalized entry)>' (content-addressed — an edited
 *           entry is a remove+add, so memReplaceRef keeps rows exact)
 *
 * Sync is incremental + throttled + fire-and-forget at run start (kicked right
 * beside kickCodeIndexSync in agent.ts). Retrieval surfaces:
 *   - buildLearningsBlock(): top matches for the user message, injected as a
 *     [RELEVANT LEARNINGS] system-prompt block beside the run journal.
 *   - createFailureLearningNudger(): on a failure-shaped tool result, requery
 *     the learnings with the error text and append the single best hit — the
 *     moment a recorded gotcha actually pays for itself. ≤3 requeries per run.
 *   - search_memory(scope:'project'|'all', source:'learning') via the widened
 *     tool (coding-retrieval.service.ts).
 *
 * Everything is best-effort — a learnings failure never touches the run.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { storeGet, storePut } from '../memory/context-store';
import { memReplaceRef, memSearch } from '../memory/unified-memory.service';
import logger from '../../../utils/logger';
import { recordLoopMetric, LOOP_METRIC_KINDS } from '../platform/loop-metrics.service';

export const LEARNING_SOURCE = 'learning';
export const LEARNINGS_REL_PATH = path.join('.digby', 'notes', 'learnings.md');

const SYNC_THROTTLE_MS = 10 * 60 * 1000; // at most one sync per project per 10 min (code-index pattern)
const MAX_ADDED_PER_SYNC = 60;           // embed at most N new entries per sync (rest next time)
const MIN_ENTRY_CHARS = 12;              // skip empty/noise bullets

// ── Parsing ──────────────────────────────────────────────────────────────────

export interface LearningsSegment { kind: 'entry' | 'other'; text: string; }
export interface LearningsDoc {
  /** Everything before the first entry (title + intro prose). */
  header: string;
  /** Ordered body segments: entries (bullets / heading blocks) + preserved other lines. */
  segments: LearningsSegment[];
}
export interface LearningEntry { ref: string; title: string; content: string; normalized: string; }

const ENTRY_START = /^(-\s+|#{2,6}\s+)/;

/**
 * Parse learnings.md into header + ordered segments. An ENTRY is a top-level
 * bullet (`- …`, with indented continuation lines) or a `##`+ heading block
 * (heading + following prose until a blank line / next entry). Everything else
 * (section labels, comments) is preserved as 'other' so a rewrite keeps it.
 */
export function parseLearningsDoc(md: string): LearningsDoc {
  const lines = (md || '').split('\n');
  const headerLines: string[] = [];
  const segments: LearningsSegment[] = [];
  let i = 0;
  while (i < lines.length && !ENTRY_START.test(lines[i])) { headerLines.push(lines[i]); i++; }
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; } // blank separators normalize away on rewrite
    if (ENTRY_START.test(line)) {
      const block = [line];
      i++;
      if (/^#{2,6}\s/.test(line)) {
        // Heading block: heading + following prose until blank line or next entry.
        while (i < lines.length && lines[i].trim() && !ENTRY_START.test(lines[i])) { block.push(lines[i]); i++; }
      } else {
        // Bullet: continuation lines are indented (nested bullets belong to the parent).
        while (i < lines.length && /^\s+\S/.test(lines[i])) { block.push(lines[i]); i++; }
      }
      segments.push({ kind: 'entry', text: block.join('\n') });
    } else {
      segments.push({ kind: 'other', text: line });
      i++;
    }
  }
  return { header: headerLines.join('\n').replace(/\s+$/, ''), segments };
}

/** Canonical form of one entry: marker stripped, whitespace collapsed. */
export function normalizeEntry(text: string): string {
  return text.replace(/^(-|#{2,6})\s+/, '').replace(/\s+/g, ' ').trim();
}

/** Content-addressed ref for one normalized entry. */
export function learningRef(normalized: string): string {
  return `learning:${crypto.createHash('sha1').update(normalized).digest('hex')}`;
}

/** Extract the indexable entries, deduped (identical entries index once). */
export function learningEntries(md: string): LearningEntry[] {
  const seen = new Set<string>();
  const out: LearningEntry[] = [];
  for (const seg of parseLearningsDoc(md).segments) {
    if (seg.kind !== 'entry') continue;
    const normalized = normalizeEntry(seg.text);
    if (normalized.length < MIN_ENTRY_CHARS) continue;
    const ref = learningRef(normalized);
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push({ ref, title: normalized.slice(0, 120), content: normalized, normalized });
  }
  return out;
}

// ── Prompt slice (the cheap interim fix) ─────────────────────────────────────

/**
 * Recency-aware slice for direct prompt injection: the old `slice(0, 4000)`
 * showed only the ~10 OLDEST entries of a 90KB+ file. This keeps the file's
 * head (title + intro) and spends the rest of the budget on the TAIL — the
 * newest entries — with an explicit omission marker pointing at search_memory.
 */
export function sliceLearningsForInjection(md: string, budget = 4000): string {
  if (!md || md.length <= budget) return md;
  // Head = the file's HEADER only (title + intro, up to the first entry),
  // bounded — never the oldest entries themselves.
  const headBudget = Math.min(600, Math.floor(budget * 0.15));
  const firstEntry = md.search(/^(-|#{2,6})\s/m);
  let head = md.slice(0, firstEntry >= 0 ? Math.min(firstEntry, headBudget) : headBudget);
  const nl = head.lastIndexOf('\n');
  if (nl > 0) head = head.slice(0, nl);
  // Marker sized with a generous count placeholder so the final string stays ≤ budget.
  const markerFor = (omitted: number) =>
    `\n[… ${omitted} chars of older entries omitted — EVERY entry is searchable: search_memory(scope:'project', source:'learning') …]\n`;
  const tailBudget = Math.max(200, budget - head.length - markerFor(md.length).length);
  let tail = md.slice(md.length - tailBudget);
  const cut = tail.indexOf('\n- '); // align to an entry start so the first item isn't torn
  if (cut >= 0) tail = tail.slice(cut + 1);
  return `${head}${markerFor(md.length - head.length - tail.length)}${tail}`;
}

// ── Incremental sync (code-index pattern) ────────────────────────────────────

export interface LearningsIndexState {
  refs: Record<string, true>;
  /** Hash of the last FULLY indexed file content — absent while a sync is partial. */
  fileHash?: string;
  lastSyncAt?: string;
  /** Bumped when the store contract changes so old refs re-index once (see GATE_VERSION). */
  gateVersion?: number;
  /**
   * Learnings dream (learnings-dream.ts, 2026-10-20): merged row ref (`learning-dream:<sha1>`) → the
   * `learning:` refs it stands in for. Their rows are deleted; the refs STAY in `refs` so this sync never
   * re-adds them while their file entries exist. Written by the dream, maintained by the sweep below.
   */
  merged?: Record<string, string[]>;
  /** When the learnings dream last ran over this index (ISO). */
  dreamAt?: string;
}

/**
 * Store-contract version. v2 (owner 2026-09-04): entries store with skipGate —
 * worthEmbedding silently dropped short plain-prose conventions (25–199 chars,
 * no code-ish token) while the sync pinned their refs as indexed with ZERO rows
 * stored, making them permanently unsearchable. A state below this version
 * clears its refs so every entry re-indexes once (memReplaceRef is idempotent;
 * MAX_ADDED_PER_SYNC bounds each pass).
 */
const GATE_VERSION = 2;

const inFlightSyncs = new Set<string>(); // in-process guard: one sync per project at a time

// ── Canonical-source sweep gate (P6 — spark B23) ─────────────────────────────
// The index is PROJECT-scoped but each sync reads from whichever WORKTREE ran
// first — two concurrent sessions on divergent branches used to fight: A's sync
// swept the rows B's branch still carries, B's sync swept A's. ADDS stay
// worktree-fed (content-addressed + idempotent — an entry real on ANY branch is
// worth indexing); REMOVALS are gated on the project's CANONICAL content (the
// mirror's default branch): a ref is removed only when gone from BOTH the
// calling worktree AND the canonical file. When the canonical read fails or the
// file isn't on the default branch yet (learnings usually land via session-
// branch PRs first), removals are SUPPRESSED — stale rows at worst, never a
// cross-worktree wipe. Projects with NO mirror (legacy blank: one standalone
// repo lineage) keep the old worktree-only sweep.
export type CanonicalLearnings =
  | { kind: 'content'; refs: Set<string> }  // canonical file read → its entry refs
  | { kind: 'absent' }                       // mirror exists but file unreadable/missing → suppress removals
  | { kind: 'no-mirror' };                   // no mirror (blank/legacy) → worktree-only sweep as before

async function canonicalLearningRefs(projectId: string): Promise<CanonicalLearnings> {
  try {
    // Dynamic import: keeps this leaf module's static graph jest-friendly.
    const ws = await import('./workspace.service');
    const mirror = ws.repoMirrorPath(projectId);
    try { await fs.access(mirror); } catch { return { kind: 'no-mirror' }; }
    // The default branch comes from the MIRROR's own HEAD (clone --mirror,
    // seedEmptyMirrorBase, and 'local' bare init all point it at the project's
    // default branch) — no DB dependency in this leaf.
    const branch = (await ws.git(['symbolic-ref', '--short', 'HEAD'], mirror, 30_000)
      .then(r => r.stdout.trim()).catch(() => '')) || 'main';
    const rel = LEARNINGS_REL_PATH.split(path.sep).join('/');
    // A1-demoted mirrors track the remote under refs/remotes/origin/*; 'local'
    // bare repos hold the branch directly under refs/heads/*.
    for (const ref of [`refs/remotes/origin/${branch}`, branch]) {
      try {
        const { stdout } = await ws.git(['show', `${ref}:${rel}`], mirror, 30_000);
        return { kind: 'content', refs: new Set(learningEntries(stdout).map(e => e.ref)) };
      } catch { /* try the next ref */ }
    }
    return { kind: 'absent' };
  } catch {
    return { kind: 'absent' }; // uncertainty must never mass-remove rows
  }
}

/**
 * Incrementally sync a project's learnings index from the checkout on disk.
 * Content-addressed refs make the diff trivial: new refs are stored, vanished
 * refs are removed (an edited entry is remove+add). Returns counts; never throws.
 */
export async function syncLearningsIndex(
  projectId: string,
  repoRoot: string,
  opts?: { force?: boolean; canonicalForTest?: CanonicalLearnings; userId?: string },
): Promise<{ added: number; removed: number; skipped: boolean }> {
  if (inFlightSyncs.has(projectId)) return { added: 0, removed: 0, skipped: true };
  inFlightSyncs.add(projectId);
  try {
    const state = (await storeGet<LearningsIndexState>([projectId, 'learnings-index'], 'state')) || { refs: {} };
    if (!opts?.force && state.lastSyncAt && Date.now() - new Date(state.lastSyncAt).getTime() < SYNC_THROTTLE_MS) {
      return { added: 0, removed: 0, skipped: true };
    }
    if ((state.gateVersion ?? 1) < GATE_VERSION) {
      state.refs = {};           // re-index everything once under the new contract
      delete state.fileHash;
    }
    let md = '';
    try { md = await fs.readFile(path.join(repoRoot, LEARNINGS_REL_PATH), 'utf8'); }
    catch { return { added: 0, removed: 0, skipped: true }; } // no learnings file — do NOT sweep rows (a branch may simply lack it)
    // Stamp the throttle FIRST so a cross-process concurrent run-start won't double-sync.
    await storePut([projectId, 'learnings-index'], 'state', { ...state, lastSyncAt: new Date().toISOString() } as any);
    const fileHash = crypto.createHash('sha1').update(md).digest('hex');
    if (state.fileHash === fileHash) return { added: 0, removed: 0, skipped: true };

    const entries = learningEntries(md);
    const current = new Set(entries.map(e => e.ref));
    const scope = { type: 'project' as const, id: projectId };
    let added = 0;
    let brokeEarly = false;
    let attempted = 0;
    let failures = 0;
    for (const e of entries) {
      if (state.refs[e.ref]) continue;
      // ATTEMPTS bound the pass (not successes): under a store outage every
      // entry returns 0 rows — a success-counted budget would then hammer the
      // dead store once per entry per sync.
      if (attempted >= MAX_ADDED_PER_SYNC) { brokeEarly = true; break; }
      attempted++;
      // skipCap: the project scope is SHARED with the code index — memStore's
      // default 800-row cap sweep would evict code rows wholesale. Learnings
      // volume is bounded by the file itself, so no cap sweep here; the
      // code-index sync enforces its own SOURCE-scoped project cap regularly.
      // skipGate: entries are CURATED — the worthEmbedding gate exists for
      // conversational noise and silently dropped short plain-prose conventions.
      // userId = provenance stamp (memory unification 2026-09-14); reads are gated by project scope.
      const rows = await memReplaceRef(scope, LEARNING_SOURCE, e.ref, [{ title: e.title, content: e.content }], { skipCap: true, skipGate: true, ...(opts?.userId ? { userId: opts.userId } : {}) });
      // Belt-and-braces: never pin a ref that stored ZERO rows as indexed — that
      // was the silent-loss mechanism the gateVersion bump repairs.
      if (rows > 0) { state.refs[e.ref] = true; added++; }
      else failures++;
    }
    // Entries gone from the file (edited/deduped) — the parse always sees the
    // whole file, so the sweep is safe even after an add-budget early break.
    // P6 (spark B23): removals are gated on the project's CANONICAL content so
    // two worktrees on divergent branches stop sweeping each other's rows —
    // see canonicalLearningRefs above. The canonical read happens lazily (only
    // when something is actually a removal candidate).
    let removed = 0;
    let canonical: CanonicalLearnings | null = opts?.canonicalForTest ?? null;
    for (const ref of Object.keys(state.refs)) {
      if (current.has(ref)) continue;
      if (!canonical) canonical = await canonicalLearningRefs(projectId);
      if (canonical.kind === 'absent') continue;                                  // unreadable canon → keep (uncertainty)
      if (canonical.kind === 'content' && canonical.refs.has(ref)) continue;      // still canonical → another branch owns it
      await memReplaceRef(scope, LEARNING_SOURCE, ref, []);
      delete state.refs[ref];
      removed++;
    }
    // Learnings dream (learnings-dream.ts, 2026-10-20): a merged row stands in for its member entries
    // (their rows were deleted; their refs stayed in state.refs). Once the sweep has removed EVERY member
    // (each entry left the file), the merged row goes too; while some remain it stays. Only a pass that
    // swept something can retire a group (a GATE_VERSION reset re-adds members — it never removes).
    let mergedRemoved = 0;
    if (removed && state.merged) {
      for (const [mergedRef, members] of Object.entries(state.merged)) {
        if (!Array.isArray(members) || !members.length || members.some(m => state.refs[m])) continue;
        await memReplaceRef(scope, LEARNING_SOURCE, mergedRef, []);
        delete state.merged[mergedRef];
        mergedRemoved++;
      }
    }
    await storePut([projectId, 'learnings-index'], 'state', {
      refs: state.refs,
      // Partial (early break) OR lossy (store failures) pass → no fileHash, so
      // the next sync re-diffs and retries the unpinned entries.
      ...(brokeEarly || failures ? {} : { fileHash }),
      lastSyncAt: new Date().toISOString(),
      gateVersion: GATE_VERSION,
      // The dream's bookkeeping rides through (absent on an index never dreamt — the write is unchanged).
      ...(state.merged ? { merged: state.merged } : {}),
      ...(state.dreamAt ? { dreamAt: state.dreamAt } : {}),
    } as any);
    if (added || removed) {
      logger.info(`learnings-index: project ${projectId} synced (+${added} entries, -${removed}${mergedRemoved ? `, -${mergedRemoved} merged` : ''})`);
      // Telemetry (remediation P0): mirrors the code-index row — one per sync
      // pass that touched the index, value = rows swept out.
      recordLoopMetric({
        kind: LOOP_METRIC_KINDS.INDEX_SWEPT,
        value: removed,
        meta: { index: 'learnings', projectId, added, removed, ...(mergedRemoved ? { mergedRemoved } : {}) },
      });
    }
    return { added, removed, skipped: false };
  } catch (e: any) {
    logger.warn(`learnings-index: sync failed (non-fatal): ${e.message}`);
    return { added: 0, removed: 0, skipped: false };
  } finally {
    inFlightSyncs.delete(projectId);
  }
}

/** Fire-and-forget sync at run start (kicked beside kickCodeIndexSync). */
export function kickLearningsIndexSync(projectId: string | undefined, repoRoot: string | undefined, userId?: string): void {
  if (!projectId || !repoRoot) return;
  void syncLearningsIndex(projectId, repoRoot, userId ? { userId } : undefined).catch(() => {});
}

// ── Retrieval: run-start contextual injection ────────────────────────────────

const INJECT_HITS = 5;
const INJECT_CHAR_BUDGET = 1200;
const INJECT_ENTRY_CAP = 400;

/**
 * [RELEVANT LEARNINGS] block for the system prompt: the top learnings matched
 * to the user message, bounded to ~1,200 chars. Empty string when there's
 * nothing relevant — never throws.
 */
export async function buildLearningsBlock(
  projectId: string | undefined,
  query: string,
  k = INJECT_HITS,
  budget = INJECT_CHAR_BUDGET,
): Promise<string> {
  if (!projectId || !query?.trim()) return '';
  try {
    const hits = await memSearch([{ type: 'project', id: projectId }], query.slice(0, 2000), k, { sources: [LEARNING_SOURCE], purpose: 'learnings_inject' });
    if (!hits.length) return '';
    const header = `[RELEVANT LEARNINGS — durable conventions from .digby/notes/learnings.md matched to this task; find more via search_memory(scope:'project', source:'learning')]`;
    let block = header;
    for (const h of hits) {
      const line = `\n- ${h.content.slice(0, INJECT_ENTRY_CAP)}`;
      if (block.length + line.length > budget) {
        if (block === header) block += line.slice(0, Math.max(0, budget - block.length));
        break;
      }
      block += line;
    }
    return block === header ? '' : block;
  } catch {
    return '';
  }
}

// ── Retrieval: on-tool-failure requery ───────────────────────────────────────

// Conservative, harness-authored failure ENVELOPES only (a read_file result
// that merely CONTAINS the word "error" must not fire a nudge). Ticket
// 7c1e5b9f (2026-09-10): every marker must be ANCHORED to the position the
// harness actually writes it — the three previously-unanchored shapes
// ("FAILED — no schedule was created", "[exit: N]", "exceeded Ns and was
// aborted") matched their own literal source text in THIS file (and any
// docs/tests/logs quoting them), so a lane that read_file'd this module
// racked up a phantom 3× "failure" streak on SUCCESSFUL reads, tripped the
// derail breaker, and auto-filed a mishap whose failure texts were file
// excerpts.
const FAILURE_MARKERS: RegExp[] = [
  /^Tool \S+ failed:/,                    // executeCodingTool catch-all
  /^\{\s*"ok":\s*false/,                  // platform tools' structured refusal envelope (JSON.stringify …,null,1)
  /^Verify FAILED at/,                    // verify tool
  /^git commit failed:/,
  /^COMMIT BLOCKED/,
  /^Opening the PR failed:/,
  // tools.ts schedule_self rejection, authored `⚠️ schedule_self FAILED — …`;
  // .{0,3} tolerates the emoji+space prefix, ^ pins it to the envelope start.
  /^.{0,3}schedule_\w+ FAILED — no schedule was created/,
  /^Tool "[^"]+" exceeded \d+s and was aborted/,         // agent-loop hard-timeout backstop (agent.ts)
  // Document-tools existence refusals (tool-executor.ts: read_document /
  // update_document / fill_pdf_form) — harness-authored envelopes at result
  // position 0. Ticket 718a04a5 (2026-09-20): a kimi-k3 lane emitted ~210
  // update_document calls with fabricated placeholder ids ('placeholderNNN' —
  // VARYING, so the identical-call repeat breaker never fired; one call per
  // turn, so the batch cap never fired; a call EXECUTED every turn, so the
  // narrated-loop breaker never fired) and every one returned this refusal,
  // which matched NO failure marker — it read as SUCCESS to the derail
  // streak, resetting it, and burned ~213 steps across two auto-continues
  // with zero verified work. Count the refusal as the failure it is; a legit
  // lane recovers in one call (list_files → real id), never reaching 3.
  /^No generated file with id \S+ belongs to this user\./,
  /^No knowledge document with id \S+ belongs to this user\./,
  // edit_file's two TEXT-MISMATCH refusals (tools.ts: count === 0 / count > 1)
  // — harness-authored envelopes at result position 0, exactly like the
  // document-tools markers above. Ticket d2e6b0fb (2026-10-19, surfaced by the
  // 9050c226 adjudication): the refusal is the tool's own authored answer (no
  // "Tool … failed:" prefix, no JSON envelope), so it read as SUCCESS to the
  // breaker — the wild 9050c226 run's sixth edit returned it and reset the
  // fail streak. A looping lane emitting edit_file calls with VARYING
  // old_strings under narration that stays ALIGNED trips NO breaker leg at
  // all: the failure ladder sees success, the success-side leg sees alignment
  // (no mismatch), and the identical-call repeat breaker never fires on
  // varying strings. Same anchor discipline as 718a04a5/7c1e5b9f: ^ pins the
  // marker to the envelope start so a lane that read_file's this module (or a
  // doc/test QUOTING the refusal mid-string) never racks a phantom streak on
  // a successful read. Count the refusal as the failure it is; a legit lane
  // recovers in one call (the refusal text already says how — read the file,
  // ... match exactly / add surrounding context), never reaching 3. The path
  // class is `.+` (not the ticket's suggested `\S+`): with BOTH ends anchored
  // to the exact authored envelope the precision is identical, and a path
  // containing a space (a model-named "docs/my notes.md") still fires — `\S+`
  // would leave exactly the reported blind spot open for spaced paths.
  // Tandem update (tool-failure-streak CLASS fix, tickets efcdcbca + bb77c6ad,
  // 2026-10-22): the refusal now APPENDS a deterministic ` [edit_file hint: …]`
  // diagnostic tail (edit-file-hint.ts) — the markers admit exactly that
  // bracketed tail and nothing else, so a model's own trailing narration
  // ('— then I re-read it') still does NOT fire and a doc/test quoting the
  // refusal mid-string never racks a phantom streak. Both ends stay anchored.
  /^old_string not found in .+\. Read the file and match exactly\.( \[edit_file hint: [^\]\n]{0,320}\])?$/,
  /^old_string appears \d+× in .+ — it must be unique\. Add surrounding context\.( \[edit_file hint: [^\]\n]{0,320}\])?$/,
];

// run_command's non-zero exit marker is authored as the result's LAST line
// (a `\n[exit: N]` tail suffix — tools.ts / container.service.ts / agent.ts),
// so anchor it to the tail: content merely QUOTING an exit marker mid-string
// (a log excerpt, this file's own source) is never failure-shaped, and a
// >4000-char output's marker is still seen (the head slice below would miss it).
const EXIT_MARKER_TAIL_RE = /(?:^|\n)\[exit: (?!0[\]\s])[^\]\n]{0,40}\]\s*$/;

/** True when a tool result is one of the harness's failure shapes. */
export function looksLikeToolFailure(result: string): boolean {
  const text = (result || '').slice(0, 4000);
  // Ticket 1ab1a52b (2026-09-10): the confirmation gate's STAGING envelope
  // ({ "ok": false, "needsConfirmation": true, … } — platform-tools.ts) is a
  // PENDING USER ACTION, not a failure. Counting it fed the derail-breaker
  // streak: a machine lane that re-staged cancel_schedule 3× tripped the
  // breaker, got the tool withheld, and auto-filed a phantom "tool-failure"
  // mishap whose "failure texts" were the gate working as designed. Exempt the
  // shape for BOTH consumers here (breaker + learning nudger); a model that
  // truly loops identical staging calls is still caught by the repeat-breaker.
  if (/^\{\s*"ok":\s*false/.test(text) && /"needsConfirmation":\s*true/.test(text.slice(0, 400))) return false;
  // FAMILY tool-failure-streak (2026-11-03, 9 auto-filed mishaps): an INFRA
  // death is not a model failure. Tools anchor a transport-death result with
  // `[INFRA]` (the session shell/container died before the command ran — see
  // isExecTransportFailure in container.service.ts). Counting those convicted
  // the MODEL for a dead BOX: each lane obeyed the "narrow the scope/path"
  // advice, changed a perfectly valid pattern, racked the 3× streak, had the
  // tool withheld for a model round, and auto-filed a model-blaming mishap.
  // The breaker must never be fed by infrastructure (the same principle as the
  // confirmation-gate exemption above). A lane that truly loops is still caught
  // by the repeat-breaker, which counts identical calls regardless of result.
  if (/^\[INFRA\]/.test(text)) return false;
  if (FAILURE_MARKERS.some(re => re.test(text))) return true;
  return EXIT_MARKER_TAIL_RE.test((result || '').slice(-500));
}

/** Shared distinctive tokens (≥4 chars, stopwords out) — the cheap relevance
 *  threshold for the failure nudge (memSearch returns no numeric score). */
const OVERLAP_STOPWORDS = new Set([
  'this', 'that', 'with', 'from', 'have', 'were', 'been', 'when', 'then', 'than',
  'tool', 'failed', 'error', 'errors', 'command', 'file', 'files', 'your', 'never',
  'always', 'because', 'which', 'would', 'should', 'could', 'into', 'only', 'over',
]);
export function lexicalOverlap(a: string, b: string): number {
  const toks = (s: string) => new Set((s.toLowerCase().match(/[a-z0-9_./-]{4,}/g) || []).filter(t => !OVERLAP_STOPWORDS.has(t)));
  const ta = toks(a);
  const tb = toks(b);
  let n = 0;
  for (const t of ta) if (tb.has(t)) n++;
  return n;
}

const MAX_FAILURE_NUDGES_PER_RUN = 3;
const MAX_FAILURE_REQUERIES_PER_RUN = 8;
const NUDGE_MIN_OVERLAP = 3;
const NUDGE_CHAR_BUDGET = 400;

/**
 * Per-run nudger: on a failure-shaped tool result, memSearch the learnings with
 * the error text and return a `[POSSIBLY RELEVANT LEARNING] …` note (~400 chars)
 * for appending to the tool result — or '' when nothing clears the overlap
 * threshold. Two bounds (owner 2026-09-04 — the nudge budget used to burn on
 * requeries that DELIVERED nothing, so three early weak failures exhausted it
 * before a genuine match): ≤3 DELIVERED nudges per run, ≤8 requeries per run
 * (the embed-cost bound). Best-effort; never throws.
 */
export function createFailureLearningNudger(
  projectId: string | undefined,
  maxNudges = MAX_FAILURE_NUDGES_PER_RUN,
  maxRequeries = MAX_FAILURE_REQUERIES_PER_RUN,
): (toolName: string, result: string) => Promise<string> {
  let delivered = 0;
  let requeries = 0;
  return async (toolName: string, result: string): Promise<string> => {
    if (!projectId || delivered >= maxNudges || requeries >= maxRequeries || !looksLikeToolFailure(result)) return '';
    requeries += 1;
    try {
      const hits = await memSearch(
        [{ type: 'project', id: projectId }],
        `${toolName} ${result.slice(0, 500)}`,
        1,
        { sources: [LEARNING_SOURCE], purpose: 'learnings_nudge' },
      );
      const hit = hits[0];
      if (!hit || lexicalOverlap(result.slice(0, 800), `${hit.title} ${hit.content}`) < NUDGE_MIN_OVERLAP) return '';
      delivered += 1;
      return `[POSSIBLY RELEVANT LEARNING — from .digby/notes/learnings.md] ${hit.content}`.slice(0, NUDGE_CHAR_BUDGET);
    } catch {
      return '';
    }
  };
}
