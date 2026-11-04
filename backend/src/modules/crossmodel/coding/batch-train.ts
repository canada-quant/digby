/**
 * batch-train.ts — the batch-train registry's pure leaf (T2c, todo 9c89ab21).
 *
 * The batch train (docs/BATCH_TRAIN.md, owner directive 2026-10-16): lanes
 * stop merging PRs straight to main — a train-runner cuts `batch/<ts>` from
 * main, merges each green conflict-clean PR onto it, runs FULL CI once on the
 * batch, fast-forwards main, deploys once. The failure this leaf exists to
 * prevent: a lane that never read BATCH_TRAIN.md merges straight to main
 * while a train is boarding — main moves under the batch, the FF is refused,
 * the whole batch re-boards. That race was operator discipline only (zero
 * backend batch-train awareness existed when T2c was scoped).
 *
 * The contract, in three pieces:
 *   1. DISCOVERY (batch-train.service.ts): the active train is AUTO-DISCOVERED
 *      from the repo — a `batch/<ts>` remote head that is NOT an ancestor of
 *      main is a boarding train; the moment the train lands (FF to main) the
 *      branch becomes an ancestor and the train reads as inactive. No
 *      registration step exists because trains are cut by ANY operator (Digby
 *      Code's box, the Fleet Supervisor, a human) — most of whom cannot write
 *      this platform's Redis or call its tools; the branch IS the state.
 *   2. THE GATE (self-merge.service.ts `batch_train`): while a train is
 *      boarding, a merge_pull_request into base=main is REFUSED unless the
 *      PR's diff is docs-only (`.md` family, `docs/**`, or `.digby/**`
 *      state-only — the todo's carve-out, verbatim: "docs-only .md/docs/**
 *      state-only may still go direct"). The refusal's suggestedFix redirects
 *      the lane to board onto the batch branch. The train's own landing is a
 *      raw `git push origin main` (fast-forward), not a PR merge — it never
 *      passes through this gate by design.
 *   3. THE NOTICE (buildBatchTrainNotice): an advisory block appended at the
 *      machine-wake seams (the infra-blocker doctrine: advisory only, never a
 *      skip; fail-open) so lanes know a train is boarding BEFORE they open a
 *      PR, and `list_batch_trains` for the live read.
 *
 * Docs-only definition (deliberate): the merge-relief set is the TODO's set —
 * `.md` / `.markdown` / `.mdx` anywhere, everything under `docs/`, and
 * everything under `.digby/` (harness state — the pr-diff-shape precedent
 * classifies state apart). It deliberately does NOT include tests or
 * memory-bank (the deploy-path filter's wider set): a test-only or
 * memory-bank change still rides the train, because the train's CI is the
 * thing that validates them. Fail-closed on an unreadable diff: a merge the
 * harness cannot classify is held, not waved through.
 *
 * Pure leaf (no imports) so it is unit-testable without the prisma/redis
 * graph — the store/discovery wiring lives in batch-train.service.ts. Same
 * discipline as infra-blockers.ts / terminal-stop.ts / machine-wake.ts.
 */

import type { GithubApi } from './self-merge.service';

/** Position-0 literal the injected notice starts with. */
export const BATCH_TRAIN_NOTICE_PREFIX = '[BATCH TRAIN ACTIVE';

/** Kill switch: `BATCH_TRAIN_GATE_DISABLED=1` disables the merge gate AND the
 *  notice (the whole mechanism — a misfiring discovery must be able to be
 *  turned off in one env, the DID_IT_WORK_DISABLED idiom). Read per call. */
export const BATCH_TRAIN_GATE_DISABLED_ENV = 'BATCH_TRAIN_GATE_DISABLED';

/** A branch name is a train branch ⇔ `batch/<UTC-ISO-ts>` (BATCH_TRAIN.md §1:
 *  `batch/$(date -u +%Y%m%dT%H%M%SZ)`). */
export const BATCH_BRANCH_RE = /^batch\/(\d{8}T\d{6}Z)$/;

/** A train branch older than this that never landed is treated as ABANDONED
 *  (discovery returns it as stale, and the gate does not hold merges for it).
 *  The longest healthy train (cut → board → CI → FF → deploy) is hours; the
 *  first real train landed in ~6 minutes. 72h leaves generous slack for a
 *  weekend-stuck bisect while never holding the fleet for a dead branch. */
export const ABANDONED_TRAIN_HOURS = 72;

/** Redis cache TTL for the discovery result (the matching-refs + compare
 *  calls are two GitHub round-trips; the merge gate and every firing must
 *  not pay them each time). Short enough that a freshly-cut train is seen
 *  within a minute of its push. */
export const DISCOVERY_CACHE_TTL_MS = 60_000;
export const DISCOVERY_CACHE_KEY = 'coding:batch:trains:active';

/** Max branches the discovery inspects (defensive — a repo with hundreds of
 *  stale batch branches would fan out one compare per branch). */
export const MAX_TRAIN_BRANCHES = 10;

export function batchTrainGateDisabled(): boolean {
  return process.env[BATCH_TRAIN_GATE_DISABLED_ENV] === '1';
}

/** Parse `batch/20261017T015348Z` → Date (null when the name is malformed). */
export function parseBatchBranchTs(branch: string): Date | null {
  const m = BATCH_BRANCH_RE.exec(String(branch || '').trim());
  if (!m) return null;
  const raw = m[1];
  // 20261017T015348Z → 2026-10-17T01:53:48Z
  const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(9, 11)}:${raw.slice(11, 13)}:${raw.slice(13, 15)}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Strip a full ref (`refs/heads/batch/x`) to its short branch name. */
export function shortBranchName(refOrBranch: string): string {
  const s = String(refOrBranch || '').trim();
  return s.startsWith('refs/heads/') ? s.slice('refs/heads/'.length) : s;
}

export type TrainActivity =
  | 'boarding'   // not an ancestor of main → the train is assembling/CI-ing; HOLDS non-docs merges to main
  | 'landed'     // an ancestor of main (or identical to main) → inactive, kept only as history
  | 'abandoned'; // still unmerged but past ABANDONED_TRAIN_HOURS → inactive (stale, not holding anything)

export interface ActiveBatchTrain {
  /** Short branch name (`batch/20261017T015348Z`). */
  branch: string;
  /** Head sha of the branch (evidence for the notice). */
  sha: string;
  /** `boarding` when this train is live and holding main merges. */
  activity: TrainActivity;
  /** Cut time parsed from the branch name (null when unparseable — treated as boarding, not crashed). */
  cutAt: string | null;
  /** How the activity was determined (`compare`, `name-age`, `cache`) — the audit line. */
  determinedBy: string;
  /** Discovery time (ISO) — cache freshness. */
  checkedAt: string;
}

/** An abandoned train (unmerged past the age bound) is NOT a live train. */
export function isLiveTrain(t: ActiveBatchTrain): boolean {
  return t?.activity === 'boarding';
}

// ── Docs-only classification (the merge-relief carve-out) ────────────────────

/** A path counts as docs/state relief: `.md`/`.markdown`/`.mdx` anywhere,
 *  everything under `docs/`, everything under `.digby/`. Verbatim from the
 *  todo: "docs-only .md/docs/** state-only may still go direct". */
export function isTrainDocsPath(file: string): boolean {
  const p = String(file || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!p) return false;
  if (p === 'docs' || p.startsWith('docs/')) return true;
  if (p === '.digby' || p.startsWith('.digby/')) return true;
  return /\.(md|markdown|mdx)$/i.test(p);
}

export interface TrainDocsOnlyVerdict {
  /** true only when files is non-empty AND every file is a docs/state path. */
  docsOnly: boolean;
  files: string[];
  nonDocs: string[];
}

export function classifyTrainDocsOnly(files: string[]): TrainDocsOnlyVerdict {
  const uniq = [...new Set((files || []).map((f) => String(f || '').trim()).filter(Boolean))];
  const nonDocs = uniq.filter((f) => !isTrainDocsPath(f));
  return { docsOnly: uniq.length > 0 && nonDocs.length === 0, files: uniq, nonDocs };
}

/**
 * Extract the changed file paths from a unified diff (the `+++ b/<path>`
 * headers — the same text the secret-scan gate already fetched). Renames
 * surface as the NEW path plus the old in `--- a/`; both are real changes, so
 * both are classified. Returns [] when nothing parses (the caller
 * fail-closes: an unclassifiable merge is held, not waved through).
 */
export function filesFromUnifiedDiff(diffText: string): string[] {
  const out: string[] = [];
  for (const line of String(diffText || '').split('\n')) {
    if (line.startsWith('+++ b/')) {
      const p = line.slice(6).trim();
      if (p && p !== '/dev/null') out.push(p);
    } else if (line.startsWith('--- a/')) {
      const p = line.slice(6).trim();
      if (p && p !== '/dev/null') out.push(p);
    }
  }
  return [...new Set(out)];
}

// ── Notice rendering (bracket-safe, deterministic) ───────────────────────────

function safe(text: unknown, max: number): string {
  if (typeof text !== 'string') return '';
  return text.replace(/[\r\n\]"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Render the advisory [BATCH TRAIN ACTIVE] block for the machine-wake seams.
 * Advisory only (never a skip — the infra-blocker doctrine), but explicit
 * about the ONE hard edge: the merge_pull_request gate will refuse a
 * non-docs-only PR into main while a train is boarding, so the lane boards
 * instead of learning that by refusal.
 */
export function buildBatchTrainNotice(trains: ActiveBatchTrain[], now: Date): string {
  const live = trains.filter(isLiveTrain);
  if (!live.length) return '';
  const items = live.slice(0, MAX_LISTED_TRAINS).map((t) => {
    const bits: string[] = [`${safe(t.branch, 80)} @ ${safe(t.sha, 40).slice(0, 12)}`];
    if (t.cutAt) bits.push(`cut ${safe(t.cutAt, 30)}`);
    return `- ${bits.join(' · ')}`;
  });
  const more = live.length > MAX_LISTED_TRAINS ? `\n- …and ${live.length - MAX_LISTED_TRAINS} more (list_batch_trains shows all)` : '';
  return (
    `${BATCH_TRAIN_NOTICE_PREFIX} — harness-checked at fire time ${now.toISOString()}] ` +
    `${live.length} batch train${live.length === 1 ? ' is' : 's are'} BOARDING — the fleet's PRs land as ONE tested wave, not one merge per PR:\n` +
    items.join('\n') + more + `\n` +
    `While a train is boarding: (a) do NOT merge a code PR straight into main — the merge_pull_request gate will refuse it (gate 'batch_train'); ` +
    `(b) open your PR as usual, then either re-target it to the batch branch above (open_pull_request baseBranch:"<batch branch>" or gh pr edit <n> --base <batch branch>) so the train-runner's merge carries it, or leave it targeting main and let the train-runner board it; ` +
    `(c) docs-only / state-only changes (.md, docs/**, .digby/**) may STILL merge straight to main — the carve-out is intact. ` +
    `The train lands by fast-forwarding main (a raw push, not a PR merge) and its own wave deploys it. ` +
    `Advisory only, never a skip: your other open criteria still run. ` +
    `(list_batch_trains re-verifies live; a branch that becomes an ancestor of main the moment the train lands reads as inactive automatically.)`
  );
}

/** Notice cap, the MAX_LISTED_BLOCKERS idiom. */
export const MAX_LISTED_TRAINS = 3;

// ── Discovery (the GitHub round-trips — injectable for tests) ────────────────

export interface BatchTrainDiscoveryApi {
  /** GET .../git/matching-refs/heads/batch/ → { data: [{ ref, object: { sha } }] } */
  listBatchRefs(): Promise<any>;
  /** GET .../compare/main...<branch> → { data: { status, ahead_by, behind_by } } */
  compareWithMain(branch: string): Promise<any>;
}

/** Build the discovery API adapter over a GET-only API surface (the adapter
 *  never writes — matching-refs + compare are reads; self-merge's GithubApi
 *  structurally satisfies it, as does batch-train.service's lightweight
 *  batchTrainGithubApi). */
export function discoveryApiFromGithub(api: Pick<GithubApi, 'get'>, owner: string, repo: string): BatchTrainDiscoveryApi {
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  return {
    async listBatchRefs() {
      const r = await api.get(`${base}/git/matching-refs/heads/batch/`, 'application/vnd.github+json');
      return r;
    },
    async compareWithMain(branch: string) {
      const r = await api.get(`${base}/compare/main...${encodeURIComponent(branch)}`, 'application/vnd.github+json');
      return r;
    },
  };
}

export interface DiscoveryOutcome {
  trains: ActiveBatchTrain[];
  /** non-empty when discovery failed — the caller fail-opens (no hold). */
  error?: string;
}

/**
 * Auto-discover the train branches' activity. Deterministic rules:
 *   - `matching-refs/heads/batch/` lists every train branch (capped at
 *     MAX_TRAIN_BRANCHES, newest-name-first — branch names sort by cut time).
 *   - compare(main...branch): `behind_by`>0 or `identical` ⇒ LANDED (an
 *     ancestor of main — the FF happened); `ahead_by`>0 with behind=0 ⇒
 *     BOARDING; `diverged` ⇒ BOARDING (main moved under the train — exactly
 *     the state whose cost this gate exists to prevent).
 *   - a BOARDING branch whose name-ts is older than ABANDONED_TRAIN_HOURS is
 *     relabeled ABANDONED (stale, not live; surfaced so an operator can see
 *     and delete it).
 * Any single branch's compare error degrades THAT branch to error-outcome —
 * the whole discovery never throws (fail-open posture).
 */
export async function discoverBatchTrains(
  api: BatchTrainDiscoveryApi,
  now: Date = new Date(),
): Promise<DiscoveryOutcome> {
  let refs: any[] = [];
  try {
    const r = await api.listBatchRefs();
    refs = Array.isArray(r?.data) ? r.data : [];
  } catch (err: any) {
    return { trains: [], error: `matching-refs failed: ${String(err?.message ?? err).slice(0, 160)}` };
  }
  const entries = refs
    .map((r) => ({ branch: shortBranchName(String(r?.ref ?? '')), sha: String(r?.object?.sha ?? '') }))
    .filter((e) => BATCH_BRANCH_RE.test(e.branch));
  if (!entries.length) return { trains: [] };
  // Newest name first (names sort by cut time); cap the fan-out.
  entries.sort((a, b) => b.branch.localeCompare(a.branch));
  const capped = entries.slice(0, MAX_TRAIN_BRANCHES);
  const trains: ActiveBatchTrain[] = [];
  const nowMs = now.getTime();
  for (const e of capped) {
    const cut = parseBatchBranchTs(e.branch);
    let status = '';
    try {
      const r = await api.compareWithMain(e.branch);
      status = String(r?.data?.status ?? '');
    } catch (err: any) {
      // Read failure on ONE branch never fails the whole discovery: the
      // branch is reported with the error marker and NOT treated as live
      // (fail-open — a flaky API must not hold the whole fleet's merges).
      trains.push({
        branch: e.branch, sha: e.sha, activity: 'landed',
        cutAt: cut ? cut.toISOString() : null,
        determinedBy: `compare-error:${String(err?.message ?? err).slice(0, 60)}`,
        checkedAt: now.toISOString(),
      });
      continue;
    }
    let activity: TrainActivity;
    let determinedBy = `compare:${status}`;
    if (status === 'behind' || status === 'identical') {
      activity = 'landed'; // ancestor of (or equal to) main — the train landed
    } else {
      // ahead | diverged → unmerged; age-bound it.
      const ageMs = cut ? nowMs - cut.getTime() : 0;
      if (cut && ageMs > ABANDONED_TRAIN_HOURS * 3_600_000) {
        activity = 'abandoned';
        determinedBy = `compare:${status};name-age>${ABANDONED_TRAIN_HOURS}h`;
      } else {
        activity = 'boarding';
      }
    }
    trains.push({
      branch: e.branch, sha: e.sha, activity,
      cutAt: cut ? cut.toISOString() : null,
      determinedBy, checkedAt: now.toISOString(),
    });
  }
  return { trains };
}
