/**
 * Branch janitor (owner 2026-09-14, verbatim: "it seems the framework isnt
 * automatically deleting branches after they are merged" — and, reading the
 * GitHub branch list, "looking like session history"). Measured at 16:05Z:
 * 126 remote branches on the platform repo — 87 legacy per-session
 * digby/session-history/<id> mirrors, ~25 lane branches whose PR was already
 * MERGED (squash) or CLOSED, 10 fully-merged review branches. GitHub's
 * delete_branch_on_merge only fires for merges made through GitHub's own
 * merge API on a PR; lanes that land work otherwise, or re-push a branch
 * after its PR merged, leave branches behind. This hourly sweep deletes them.
 *
 * DETERMINISTIC — NO LLM, DB/API-only (never touches the coding volume, so it
 * is claimable on every worker incl. the 0-slot cron-only one). For every
 * GitHub repo a live project points at (crossmodel_projects.repoProvider
 * 'github', deduped by owner/repo), authenticated with the project owner's
 * connected GitHub token (github/token-manager getValidToken — the SAME auth
 * the coding tools + self-merge use), list the branches and DELETE one when
 *   (a) it is not the default branch and not protected, AND
 *   (b) it carries one of the framework's OWN prefixes (digby/, cursor/, codex/,
 *       claude/, fix/, feat/, feature/) — a user's develop/staging/release branch
 *       that momentarily equals main is NEVER the janitor's business (review
 *       2026-09-14) — AND EITHER compare <default>...<branch> reports
 *       ahead_by === 0 (fully merged),
 *       OR every PR with that head is MERGED/CLOSED and the branch tip is not
 *       newer than the last PR close (a squash-merged lane branch),
 *       OR it is a legacy digby/session-history/<id> mirror (superseded by the
 *       consolidated digby/session-history branch — only while the single-
 *       branch mode is on; framework prefix).
 * NEVER deleted: the default branch, protected branches, any branch that is
 * the head OR the BASE of an OPEN PR (deleting a stacked PR's base retargets
 * it to default and silently widens its diff), any branch whose tip commit is
 * < 2 h old (a lane may be mid-push — the guard reads the tip COMMIT date,
 * not push time), and any branch outside the framework's own prefixes.
 *
 * Bounds: ≤ 50 deletions per pass (across all repos — the remainder waits for
 * the next hour), ≤ 500 branches listed per repo, a 403/429 aborts that
 * repo's scan for this pass. Telemetry: ONE loop_metrics row kind
 * 'branch_janitor' per repo per pass — { repo, scanned, deleted, kept,
 * reasons } — so the cleanup rate is chartable and a dry-run week can be
 * reviewed before trusting it.
 *
 * Kill switches (read per call): BRANCH_JANITOR_DISABLED=1 stops the sweep
 * (the worker handler early-returns too); BRANCH_JANITOR_DRY_RUN=1 logs what
 * it WOULD delete and records the metric with deleted 0 + dryRun true.
 *
 * EXTENDED RULES (2026-10-21, lane-lifecycle audit LLC1021). Prod kept
 * branches forever for three reasons: `kept_repushed` (a lane pushed
 * docs-only learnings commits AFTER its PR closed, so the tip is newer than
 * the close), `kept_foreign_prefix` (fo/ state/ audit/ ops/ batch/ probe-*
 * branches sit outside the framework prefixes) and `kept_active`. A manual
 * sweep of the platform repo the same day found 58 of 68 branches deletable.
 *
 * SCOPE (review 2026-10-21). The new DELETE rules and the archive commit run
 * ONLY on the framework's OWN repo — the instance's SELF_REPO, which is the
 * platform repo on prod (`isFrameworkOwnedRepo`). The evidence came from
 * there, and names like ops/production, state/prod or audit/q3 on a user's
 * repo are not ours (the 2026-09-14 blocker again). A user repo gets the old
 * rules plus the two keeps below, and no write other than today's deletes.
 *
 * On the framework's own repo:
 *   - fo/ and state/ follow the digby/ rules (framework AND machine prefix),
 *     with a 48 h tip floor on every delete ('kept_young' when younger).
 *   - DOCS-ONLY REPUSH: a branch re-pushed after its last PR closed is deleted
 *     ('pr_closed_docs_repush') when compare <last PR head>...<branch> is
 *     'ahead' and every changed file is a doc (.digby/**, memory-bank/**,
 *     docs/**, *.md) and the tip is >= 48 h old (younger: 'kept_young'). A
 *     code repush still keeps ('kept_repushed').
 *   - CLAUDE-SESSION prefixes (audit/ ops/ batch/ and bare probe-): tip >= 48 h
 *     (else 'kept_young'); compare ahead_by 0 means 'merged'; otherwise every
 *     NON-doc file the branch changes must already be on default with the
 *     same blob ('ported'; a removed file must be gone, a rename's old path
 *     must be gone). Main's blobs come from ONE recursive tree read per repo
 *     pass; when that tree is truncated, the check falls back to per-file
 *     contents reads, at most BRANCH_JANITOR_PORT_CHECK_CALL_BUDGET per pass.
 *     A mismatch keeps the branch ('kept_unported'). An unreadable or
 *     too-large diff, or a spent budget, also keeps it ('kept_port_unverified').
 *     A branch that changed only docs has nothing to compare and counts as
 *     ported; the archive keeps its tip reachable.
 *   - ARCHIVE: the tips of a pass's deletes go into ONE commit whose parents
 *     are those tips (tree = default's tree, so a tag-triggered workflow builds
 *     nothing new), tagged ONCE as refs/tags/archive/<yyyy-mm-dd>/branch-janitor-<HHMM>Z
 *     — the manual sweep's shape. One tag per repo per pass, not one per
 *     branch: a tag created with a user token fires push/create workflows.
 *     The commit message lists every "<branch> <sha>"; the metric carries
 *     archivedTips. REQUIRED for a delete only the extended rules make (any
 *     fo/ state/ or Claude-session branch, 'merged' included, and every
 *     pr_closed_docs_repush / ported): no archive ⇒ 'kept_archive_failed'.
 *     BEST EFFORT for the old reasons (pr_merged / pr_closed whose tip is not
 *     on default): no archive ⇒ today's untagged delete, so a repo that
 *     refuses tags never regresses; the metric names it (archiveFailed).
 *     A 429 (or a 403 that says "rate limit") aborts the repo; any other
 *     refusal is a failed archive. 'merged' on the old machine prefixes and
 *     legacy_session_history are not archived (as before).
 *
 * On EVERY repo, kept before any compare: digby/session-history (the
 * consolidated history branch, 'kept_session_history') and a
 * digby/session-<id8> lane branch whose chat is unarchived with a
 * queued/running/interrupted run or an enabled schedule ('kept_live_lane';
 * a lookup error counts as live).
 * BRANCH_JANITOR_EXTENDED_RULES_DISABLED=1 restores the rules above it byte-for-byte
 * (same prefixes, no archive, no live-lane or session-history keeps, no new
 * metric keys).
 *
 * REVIEWED DELETES (2026-10-22, branch sweep follow-up). A lane whose work
 * landed through a squash merge, and whose files main has edited since, can
 * never be proven 'ported' byte-for-byte: it stays kept_active / kept_repushed /
 * kept_unported forever (33 of the manual sweep's 64 after the first prod pass).
 * On the framework's own repo the janitor reads ONE manifest per pass,
 * BRANCH_JANITOR_REVIEWED_DELETES_PATH on the default branch —
 * `{ "entries": [{ "branch", "sha", ...documentation }] }` written by a branch
 * review — and turns those four keeps into a 'reviewed' delete ONLY when an
 * entry names the branch at its CURRENT tip (full 40-hex sha; a branch pushed to
 * after the review is 'kept_review_stale'). Everything before the rule still
 * keeps first (default, protected, open PR head/base, session history, live
 * lane); everything after it still applies (2 h + 48 h floors, the cap, the
 * archive REQUIRED, the ref and open-PR re-reads right before the DELETE). An
 * absent manifest changes nothing; an unreadable one is logged and changes
 * nothing. BRANCH_JANITOR_REVIEWED_DELETES_DISABLED=1 never reads it.
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { killSwitchOn } from '../../../utils/kill-switch';
import { recordLoopMetric, LOOP_METRIC_KINDS } from '../platform/loop-metrics.service';
import { getValidToken } from '../github/token-manager';
import { sessionHistorySingleBranchEnabled, LEGACY_SESSION_HISTORY_PREFIX, SESSION_HISTORY_BRANCH } from '../coding/session-history-sync.service';
import { repoTargetAllowed, instanceKind, normalizeGithubRepoTarget, resolveInstanceOwnRepoSlug } from '../platform/instance-targets';

// ── Contract constants ───────────────────────────────────────────────────────

/** Cron cadence — mirrored by the CRON_JOBS entry in worker.ts. */
export const BRANCH_JANITOR_INTERVAL_SEC = 3600;
export const BRANCH_JANITOR_DISABLED_ENV = 'BRANCH_JANITOR_DISABLED';
export const BRANCH_JANITOR_DRY_RUN_ENV = 'BRANCH_JANITOR_DRY_RUN';
/** Deletions per pass, across ALL repos. */
export const BRANCH_JANITOR_MAX_DELETIONS_PER_PASS = 50;
/** A branch whose tip commit is younger than this is never touched. */
export const BRANCH_JANITOR_RECENT_MS = 2 * 60 * 60 * 1000;
/** The framework's own branch prefixes — the PR-closed rule applies only here. */
export const FRAMEWORK_BRANCH_PREFIXES: ReadonlyArray<string> = ['digby/', 'cursor/', 'codex/', 'claude/', 'fix/', 'feat/', 'feature/'];
/** MACHINE-authored prefixes — the ONLY branches the bare "fully merged"
 *  (ahead_by 0) rule may delete. fix/ feat/ feature/ are human conventions
 *  too, so a fully-merged one is deleted only when its PR was merged/closed
 *  (EOD review 2026-09-14). */
export const MACHINE_BRANCH_PREFIXES: ReadonlyArray<string> = ['digby/', 'cursor/', 'codex/', 'claude/'];
/** Machine-authored branch. fo/ and state/ count only on the framework's own
 *  repo under the extended rules (`frameworkOwnedRepo`; review 2026-10-21). */
export function isMachineBranch(name: string, frameworkOwnedRepo = false): boolean {
  return MACHINE_BRANCH_PREFIXES.some(p => name.startsWith(p))
    || (frameworkOwnedRepo && !branchJanitorExtendedRulesDisabled() && EXTENDED_FRAMEWORK_PREFIXES.some(p => name.startsWith(p)));
}
/** Listing bounds per repo per pass (100 per page). */
const MAX_BRANCH_PAGES = 5;
const MAX_PR_PAGES = 5;
/** Repos per pass (pathology guard). */
const MAX_REPOS_PER_PASS = 50;

/** Extended rules (2026-10-21): =1 restores the pre-2026-10-21 rule set byte-for-byte. */
export const BRANCH_JANITOR_EXTENDED_RULES_DISABLED_ENV = 'BRANCH_JANITOR_EXTENDED_RULES_DISABLED';
/** fo/ (Fleet-Operator firings) and state/ (state commits): machine-authored,
 *  judged by the digby/ rules on the framework's own repo only. Added to BOTH
 *  the framework and machine checks; the two exported prefix lists above stay
 *  as they were (pinned). */
export const EXTENDED_FRAMEWORK_PREFIXES: ReadonlyArray<string> = ['fo/', 'state/'];
/** Claude Code session prefixes (framework's own repo only): deleted only when merged or verifiably ported. */
export const CLAUDE_SESSION_PREFIXES: ReadonlyArray<string> = ['audit/', 'ops/', 'batch/'];
/** The bare (no slash) Claude Code probe prefix, e.g. probe-h-4f7263e4. */
export const CLAUDE_SESSION_BARE_PREFIX = 'probe-';
/** Docs-only repush, fo/ state/ and Claude-session branches: the tip must be at least this old. */
export const BRANCH_JANITOR_EXTENDED_MIN_AGE_MS = 48 * 60 * 60 * 1000;
/** Port check: at most this many NON-doc files per branch. */
export const MAX_PORT_CHECK_FILES = 40;
/** Port check: per-file contents fallback reads per PASS (across repos). */
export const BRANCH_JANITOR_PORT_CHECK_CALL_BUDGET = 300;
/** GitHub's compare API lists at most 300 files; a list that long may be cut. */
const COMPARE_FILES_CEILING = 300;

/** Reviewed deletes (2026-10-22): the manifest a branch review writes on the framework repo's default branch. */
export const BRANCH_JANITOR_REVIEWED_DELETES_PATH = '.digby/branch-janitor/reviewed-deletes.json';
/** =1 / true / on: the manifest is never read (the rules above decide alone). */
export const BRANCH_JANITOR_REVIEWED_DELETES_DISABLED_ENV = 'BRANCH_JANITOR_REVIEWED_DELETES_DISABLED';
/** Manifest bounds: entries read, and the file size accepted. */
export const MAX_REVIEWED_DELETE_ENTRIES = 1000;
const MAX_REVIEWED_DELETES_BYTES = 512 * 1024;

export type DeleteReason = 'merged' | 'pr_merged' | 'pr_closed' | 'legacy_session_history' | 'pr_closed_docs_repush' | 'ported' | 'reviewed';
export type KeepReason =
  | 'kept_default' | 'kept_protected' | 'kept_open_pr' | 'kept_open_pr_base' | 'kept_recent' | 'kept_active'
  | 'kept_foreign_prefix' | 'kept_repushed' | 'kept_cap' | 'kept_unknown_age' | 'kept_dry_run'
  | 'kept_session_history' | 'kept_live_lane' | 'kept_young' | 'kept_unported' | 'kept_port_unverified' | 'kept_archive_failed'
  // Third review (2026-10-22): a deferred delete whose ref moved after the listing (or could not be re-read).
  | 'kept_moved'
  // Reviewed deletes (2026-10-22): the manifest names the branch, but at another tip — it moved after the review.
  | 'kept_review_stale';

/** GitHub REST seam (injectable for tests). Every call resolves on ANY status. */
export interface JanitorGithubApi {
  get(url: string): Promise<{ status: number; data: any }>;
  delete(url: string): Promise<{ status: number; data: any }>;
  /** Archive-tag creation (extended rules only). */
  post(url: string, body: unknown): Promise<{ status: number; data: any }>;
}

export function defaultJanitorApi(token: string): JanitorGithubApi {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
  return {
    async get(url) {
      const axios = (await import('axios')).default;
      const r = await axios.get(url, { headers, timeout: 20_000, validateStatus: () => true });
      return { status: r.status, data: r.data };
    },
    async delete(url) {
      const axios = (await import('axios')).default;
      const r = await axios.delete(url, { headers, timeout: 20_000, validateStatus: () => true });
      return { status: r.status, data: r.data };
    },
    async post(url, body) {
      const axios = (await import('axios')).default;
      const r = await axios.post(url, body, { headers, timeout: 20_000, validateStatus: () => true });
      return { status: r.status, data: r.data };
    },
  };
}

/**
 * Default live-lane probe for a digby/session-<id8> branch. True when an
 * unarchived chat whose id starts with id8 has a queued / running /
 * interrupted agent run or an enabled schedule. Any error counts as live, so a
 * failed lookup keeps the branch.
 */
export async function defaultLaneLive(id8: string): Promise<boolean> {
  try {
    const chats: Array<{ id: string }> = await prisma.crossModelChat.findMany({
      where: { id: { startsWith: id8 }, archivedAt: null },
      select: { id: true },
      take: 5,
    });
    if (chats.length === 0) return false;
    const ids = chats.map(c => c.id);
    const [runs, schedules] = await Promise.all([
      prisma.agentRun.count({ where: { sessionId: { in: ids }, status: { in: ['queued', 'running', 'interrupted'] } } }),
      prisma.codingSchedule.count({ where: { sessionId: { in: ids }, enabled: true } }),
    ]);
    return runs > 0 || schedules > 0;
  } catch {
    return true;
  }
}

export interface RepoJanitorResult {
  repo: string;
  scanned: number;
  deleted: number;
  /** Names actually deleted this pass (audit trail; the metric carries ≤50). */
  deletedBranches: string[];
  kept: number;
  failed: number;
  alreadyGone: number;
  reasons: Record<string, number>;
  dryRun: boolean;
  /** Set when the scan stopped early (rate limit / unreadable repo). */
  aborted?: string;
  /** Extended rules only: is this the framework's own repo (the new delete rules + archive ran)? */
  ownRepo?: boolean;
  /** Set when this pass needed an archive: the tag that holds the tips, or null when it failed. */
  archiveTag?: string | null;
  /** The tips the archive commit holds (branch + sha), when it landed. */
  archivedTips?: Array<{ branch: string; sha: string }>;
  /** Why the archive failed (best-effort deletes then went ahead untagged). */
  archiveFailed?: string;
  /** Reviewed deletes: the manifest's state when this pass read it ('absent' = no file; never read ⇒ unset). */
  reviewedManifest?: 'loaded' | 'absent' | 'unreadable';
  /** Reviewed deletes: valid entries in the manifest this pass read. */
  reviewedEntries?: number;
}

export interface BranchJanitorSweepResult {
  disabled: boolean;
  dryRun: boolean;
  repos: number;
  noToken: number;
  scanned: number;
  deleted: number;
  kept: number;
  failed: number;
  perRepo: RepoJanitorResult[];
}

// ── Pure helpers (exported for tests) ────────────────────────────────────────

export function branchJanitorDisabled(): boolean {
  return process.env[BRANCH_JANITOR_DISABLED_ENV] === '1';
}

export function branchJanitorDryRun(): boolean {
  return process.env[BRANCH_JANITOR_DRY_RUN_ENV] === '1';
}

export function branchJanitorExtendedRulesDisabled(): boolean {
  return killSwitchOn(process.env[BRANCH_JANITOR_EXTENDED_RULES_DISABLED_ENV]);
}

export function branchJanitorReviewedDeletesDisabled(): boolean {
  return killSwitchOn(process.env[BRANCH_JANITOR_REVIEWED_DELETES_DISABLED_ENV]);
}

/**
 * The reviewed-deletes manifest → branch name → the tip shas a review cleared.
 * Shape: `{ "entries": [{ "branch": "<name>", "sha": "<40-hex tip>", ... }] }`;
 * any other key (verdict, reviewedAt, evidence) is documentation. An entry
 * without a usable branch or a full lowercase 40-hex sha is skipped; at most
 * MAX_REVIEWED_DELETE_ENTRIES entries are read. Returns null when the document
 * has no `entries` array (an unreadable manifest, never "no entries").
 */
export function parseReviewedDeletes(raw: unknown): Map<string, Set<string>> | null {
  const entries = raw && typeof raw === 'object' ? (raw as { entries?: unknown }).entries : undefined;
  if (!Array.isArray(entries)) return null;
  const out = new Map<string, Set<string>>();
  for (const e of entries.slice(0, MAX_REVIEWED_DELETE_ENTRIES)) {
    const branch = e && typeof e === 'object' ? (e as { branch?: unknown }).branch : undefined;
    const sha = e && typeof e === 'object' ? (e as { sha?: unknown }).sha : undefined;
    if (typeof branch !== 'string' || !branch || branch !== branch.trim() || branch.length > 255) continue;
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) continue;
    const shas = out.get(branch) ?? new Set<string>();
    shas.add(sha);
    out.set(branch, shas);
  }
  return out;
}

/** A documentation path: .digby/**, memory-bank/**, docs/** or any *.md. */
export function isDocsPath(p: string): boolean {
  const path = String(p ?? '');
  if (!path) return false;
  return path.startsWith('.digby/') || path.startsWith('memory-bank/') || path.startsWith('docs/')
    || path.toLowerCase().endsWith('.md');
}

/** A compare-API file entry that only touches docs (both sides of a rename). */
function isDocsFile(f: any): boolean {
  if (!isDocsPath(String(f?.filename ?? ''))) return false;
  return !f?.previous_filename || isDocsPath(String(f.previous_filename));
}

/** True for the Claude Code session prefixes (audit/ ops/ batch/ and bare probe-). */
export function isClaudeSessionBranch(name: string): boolean {
  return CLAUDE_SESSION_PREFIXES.some(p => name.startsWith(p)) || name.startsWith(CLAUDE_SESSION_BARE_PREFIX);
}

/** The pass's ONE archive tag: archive/<yyyy-mm-dd UTC>/branch-janitor-<HHMM>Z. */
export function archiveTagName(date: Date): string {
  const iso = date.toISOString();
  return `archive/${iso.slice(0, 10)}/branch-janitor-${iso.slice(11, 13)}${iso.slice(14, 16)}Z`;
}

/** The archive commit's message: one "<branch> <sha> (<reason>)" line per tip, plus how to restore. */
export function archiveCommitMessage(tips: ReadonlyArray<{ name: string; sha: string; reason: string }>, date: Date): string {
  return [
    `branch-janitor archive ${date.toISOString().slice(0, 16)}Z: ${tips.length} branch tip(s)`,
    '',
    'Each parent of this commit is the tip of a branch the janitor deleted in this pass.',
    "The tree is the default branch's, so nothing new is built from it.",
    'Restore one: git push origin <sha>:refs/heads/<branch>',
    // Reviewed deletes (2026-10-22): the manifest entry outlives the delete, and a restore at the same tip matches it again.
    ...(tips.some(t => t.reason === 'reviewed')
      ? [`A (reviewed) tip: remove its entry from ${BRANCH_JANITOR_REVIEWED_DELETES_PATH} first, or the next pass deletes it again.`]
      : []),
    '',
    ...tips.map(t => `${t.name} ${t.sha} (${t.reason})`),
  ].join('\n');
}

/** The 8-hex chat-id prefix of a digby/session-<id8> lane branch, else null. */
export function laneId8Of(name: string): string | null {
  const m = /^digby\/session-([0-9a-f]{8})$/.exec(name);
  return m ? m[1] : null;
}

/** Parse owner/repo from a GitHub https/ssh URL (the coding tools' shape). */
export function parseGithubSlug(repoUrl: string | null | undefined): { owner: string; repo: string } | null {
  const m = String(repoUrl ?? '').trim().match(/github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** True for the framework's own branch prefixes (plus fo/ and state/ on the
 *  framework's own repo under the extended rules). */
export function isFrameworkBranch(name: string, frameworkOwnedRepo = false): boolean {
  return FRAMEWORK_BRANCH_PREFIXES.some(p => name.startsWith(p))
    || (frameworkOwnedRepo && !branchJanitorExtendedRulesDisabled() && EXTENDED_FRAMEWORK_PREFIXES.some(p => name.startsWith(p)));
}

/** A prefix only the extended rules may delete: fo/ state/ or a Claude-session prefix. */
export function isExtendedPrefixBranch(name: string): boolean {
  return EXTENDED_FRAMEWORK_PREFIXES.some(p => name.startsWith(p)) || isClaudeSessionBranch(name);
}

/**
 * Is owner/repo the framework's OWN repo — the instance's SELF_REPO (the
 * platform repo on prod)? Only there do the extended delete rules and the
 * archive run (review 2026-10-21). A non-prod instance with no SELF_REPO, or
 * one pointed at the production repo, owns no repo here.
 */
export function isFrameworkOwnedRepo(slug: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const norm = normalizeGithubRepoTarget(slug);
  if (!norm) return false;
  let own = '';
  try { own = resolveInstanceOwnRepoSlug('SELF_REPO', env); } catch { return false; }
  return !!own && normalizeGithubRepoTarget(own) === norm;
}

/** A legacy per-session history mirror — only while the consolidated mode is on. */
export function isLegacySessionHistoryBranch(name: string): boolean {
  return sessionHistorySingleBranchEnabled()
    && name.startsWith(LEGACY_SESSION_HISTORY_PREFIX)
    && !name.slice(LEGACY_SESSION_HISTORY_PREFIX.length).includes('/')
    && name.length > LEGACY_SESSION_HISTORY_PREFIX.length;
}

/** URL-encode a ref name segment-wise (slashes stay literal — GitHub's path shape). */
export function encodeRef(name: string): string {
  return name.split('/').map(encodeURIComponent).join('/');
}

// ── Per-repo sweep ───────────────────────────────────────────────────────────

interface BranchRow { name: string; sha: string; protected: boolean }

class RateLimited extends Error {
  constructor(public readonly status: number) { super(`GitHub answered ${status} (rate limit / forbidden)`); }
}

async function getOrThrow(api: JanitorGithubApi, url: string): Promise<{ status: number; data: any }> {
  const r = await api.get(url);
  if (r.status === 403 || r.status === 429) throw new RateLimited(r.status);
  return r;
}

async function listBranches(api: JanitorGithubApi, base: string): Promise<BranchRow[]> {
  const out: BranchRow[] = [];
  for (let page = 1; page <= MAX_BRANCH_PAGES; page++) {
    const r = await getOrThrow(api, `${base}/branches?per_page=100&page=${page}`);
    if (r.status !== 200 || !Array.isArray(r.data)) throw new Error(`branches listing answered ${r.status}`);
    for (const b of r.data) {
      if (!b || typeof b.name !== 'string') continue;
      out.push({ name: b.name, sha: String(b.commit?.sha ?? ''), protected: b.protected === true });
    }
    if (r.data.length < 100) break;
  }
  return out;
}

async function listOpenPrHeads(api: JanitorGithubApi, base: string): Promise<{ heads: Set<string>; bases: Set<string> }> {
  const heads = new Set<string>();
  const bases = new Set<string>();
  for (let page = 1; page <= MAX_PR_PAGES; page++) {
    const r = await getOrThrow(api, `${base}/pulls?state=open&per_page=100&page=${page}`);
    if (r.status !== 200 || !Array.isArray(r.data)) throw new Error(`open PR listing answered ${r.status}`);
    for (const pr of r.data) {
      const ref = pr?.head?.ref;
      if (typeof ref === 'string' && ref) heads.add(ref);
      // A stacked PR's BASE branch is live too — deleting it retargets the PR
      // to default and silently widens its diff (review 2026-09-14).
      const baseRef = pr?.base?.ref;
      if (typeof baseRef === 'string' && baseRef) bases.add(baseRef);
    }
    if (r.data.length < 100) break;
  }
  return { heads, bases };
}

/** Tip commit timestamp (committer date) — null when unreadable. */
async function tipCommitDate(api: JanitorGithubApi, base: string, sha: string): Promise<Date | null> {
  if (!sha) return null;
  const r = await getOrThrow(api, `${base}/commits/${encodeURIComponent(sha)}`);
  if (r.status !== 200) return null;
  const raw = r.data?.commit?.committer?.date ?? r.data?.commit?.author?.date;
  const d = raw ? new Date(String(raw)) : null;
  return d && Number.isFinite(d.getTime()) ? d : null;
}

// ── Extended-rule helpers (2026-10-21) ───────────────────────────────────────

/** A WRITE answered with a rate limit: 429, or a 403 whose message names a
 *  rate limit (GitHub's primary and secondary limits both say so). Any other
 *  403 on a write is a permission or ruleset refusal: a failed archive, not a
 *  reason to stop the repo's scan (review 2026-10-21). */
function writeRateLimited(r: { status: number; data: any }): boolean {
  return r.status === 429 || (r.status === 403 && /rate limit/i.test(String(r.data?.message ?? '')));
}

/** One tag-ref create: 'ok' (201), 'same' (422 and the existing tag is on this
 *  sha), 'other' (422 and it is on another sha), else a short failure label.
 *  A rate-limited write throws RateLimited (the repo's scan aborts, as on a GET). */
async function createTagRef(api: JanitorGithubApi, base: string, tag: string, sha: string): Promise<string> {
  const r = await api.post(`${base}/git/refs`, { ref: `refs/tags/${tag}`, sha });
  if (writeRateLimited(r)) throw new RateLimited(r.status);
  if (r.status === 201) return 'ok';
  if (r.status !== 422) return `post_${r.status}`;
  const existing = await getOrThrow(api, `${base}/git/ref/tags/${encodeRef(tag)}`);
  if (existing.status !== 200) return `exists_unreadable_${existing.status}`;
  return String(existing.data?.object?.sha ?? '') === sha ? 'same' : 'other';
}

/** A delete waiting for the pass's archive commit. `required` = a delete only
 *  the extended rules make (no archive ⇒ kept); otherwise best effort (no
 *  archive ⇒ today's untagged delete). */
interface DeferredDelete { name: string; sha: string; reason: DeleteReason; required: boolean }

/**
 * Archive a pass's tips in ONE commit (parents = the tips, tree = default's)
 * and ONE tag on it — one GitHub event per repo per pass, however many
 * branches go. Returns the tag, or null with the failure label.
 */
async function archiveTips(
  api: JanitorGithubApi, base: string, encodedDefault: string, tips: ReadonlyArray<DeferredDelete>, now: Date,
): Promise<{ tag: string; commit: string } | { tag: null; why: string }> {
  const head = await getOrThrow(api, `${base}/commits/${encodedDefault}`);
  const tree = head.status === 200 ? String(head.data?.commit?.tree?.sha ?? '') : '';
  if (!tree) return { tag: null, why: `tree_unreadable_${head.status}` };
  const parents = [...new Set(tips.map(t => t.sha).filter(Boolean))];
  if (parents.length === 0) return { tag: null, why: 'no_sha' };
  const c = await api.post(`${base}/git/commits`, { message: archiveCommitMessage(tips, now), tree, parents });
  if (writeRateLimited(c)) throw new RateLimited(c.status);
  const commit = c.status === 201 && typeof c.data?.sha === 'string' ? c.data.sha : '';
  if (!commit) return { tag: null, why: `commit_${c.status}` };
  const primary = archiveTagName(now);
  const first = await createTagRef(api, base, primary, commit);
  if (first === 'ok' || first === 'same') return { tag: primary, commit };
  if (first !== 'other') return { tag: null, why: first };
  // The name is taken by another commit (a second pass inside the same
  // minute): ONE retry with the archive commit's sha7 suffix.
  const suffixed = `${primary}-${commit.slice(0, 7)}`;
  const second = await createTagRef(api, base, suffixed, commit);
  if (second === 'ok' || second === 'same') return { tag: suffixed, commit };
  return { tag: null, why: `retry_${second}` };
}

/**
 * Third review (2026-10-22): does refs/heads/<name> still point at `sha`? One
 * GET git/ref/heads/<name>: 200 with the same object sha ⇒ 'same', another sha
 * ⇒ 'moved', 404 ⇒ 'gone', anything else ⇒ 'unknown' (the caller keeps the
 * branch). Rate limits throw like every other janitor read.
 */
async function refStillAt(api: JanitorGithubApi, base: string, name: string, sha: string): Promise<'same' | 'moved' | 'gone' | 'unknown'> {
  const r = await getOrThrow(api, `${base}/git/ref/heads/${encodeRef(name)}`);
  if (r.status === 404) return 'gone';
  if (r.status !== 200) return 'unknown';
  const now = typeof r.data?.object?.sha === 'string' ? r.data.object.sha : '';
  if (!now) return 'unknown';
  return now === sha ? 'same' : 'moved';
}

/**
 * Fourth review (2026-10-22): is `name` the head or the base of an OPEN PR right
 * now? The open-PR sets come from ONE listing at the start of the repo pass,
 * and the own repo's deferred deletes run at its END — a PR opened or REOPENED
 * on a deferred branch meanwhile (a reopen needs no push, so the ref CAS sees
 * 'same') would be closed by the delete. Two filtered GETs (head=<owner>:<name>,
 * then base=<name>); a non-200 answer reads 'unknown' (the caller keeps the
 * branch). Rate limits throw like every other janitor read.
 */
async function openPrNow(api: JanitorGithubApi, base: string, owner: string, name: string): Promise<'head' | 'base' | 'none' | 'unknown'> {
  const h = await getOrThrow(api, `${base}/pulls?state=open&head=${encodeURIComponent(`${owner}:${name}`)}&per_page=1`);
  if (h.status !== 200 || !Array.isArray(h.data)) return 'unknown';
  if (h.data.length > 0) return 'head';
  const b = await getOrThrow(api, `${base}/pulls?state=open&base=${encodeURIComponent(name)}&per_page=1`);
  if (b.status !== 200 || !Array.isArray(b.data)) return 'unknown';
  return b.data.length > 0 ? 'base' : 'none';
}

/** Default's blob map from ONE recursive tree read (null when unreadable or truncated). */
async function fetchMainTree(api: JanitorGithubApi, base: string, encodedDefault: string): Promise<Map<string, string> | null> {
  const r = await getOrThrow(api, `${base}/git/trees/${encodedDefault}?recursive=1`);
  if (r.status !== 200 || r.data?.truncated === true || !Array.isArray(r.data?.tree)) return null;
  const map = new Map<string, string>();
  for (const e of r.data.tree) {
    if (e && typeof e.path === 'string' && e.type !== 'tree' && typeof e.sha === 'string') map.set(e.path, e.sha);
  }
  return map;
}

/**
 * The reviewed-deletes manifest on default (ONE contents read per repo pass):
 * 'absent' on 404, 'unreadable' on any other status, a non-base64 or oversized
 * body, bad JSON, or no `entries` array. Rate limits throw like every other
 * janitor read.
 */
async function fetchReviewedDeletes(
  api: JanitorGithubApi, base: string, defaultBranch: string,
): Promise<{ state: 'loaded'; map: Map<string, Set<string>> } | { state: 'absent' | 'unreadable' }> {
  const r = await getOrThrow(api, `${base}/contents/${encodeRef(BRANCH_JANITOR_REVIEWED_DELETES_PATH)}?ref=${encodeURIComponent(defaultBranch)}`);
  if (r.status === 404) return { state: 'absent' };
  if (r.status !== 200 || r.data?.encoding !== 'base64' || typeof r.data?.content !== 'string') return { state: 'unreadable' };
  const body = Buffer.from(r.data.content, 'base64'); // GitHub wraps the base64 every 60 chars; the decoder skips the newlines
  if (body.length > MAX_REVIEWED_DELETES_BYTES) return { state: 'unreadable' };
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString('utf8')); } catch { return { state: 'unreadable' }; }
  const map = parseReviewedDeletes(parsed);
  return map ? { state: 'loaded', map } : { state: 'unreadable' };
}

type MainEntry = { present: boolean; sha: string | null } | 'unknown';
type PortVerdict = 'ported' | 'unported' | 'unverified';

/**
 * Is every NON-doc change on a branch already on default? `files` is the
 * compare default...branch file list; `lookup` reads one path on default.
 * Stops at the first mismatch ('unported') or unreadable path ('unverified').
 */
async function portVerdict(files: unknown, lookup: (path: string) => Promise<MainEntry>): Promise<PortVerdict> {
  if (!Array.isArray(files) || files.length >= COMPARE_FILES_CEILING) return 'unverified';
  const code = files.filter(f => !isDocsFile(f));
  if (code.length > MAX_PORT_CHECK_FILES) return 'unverified';
  for (const f of code) {
    const filename = String(f?.filename ?? '');
    const removed = f?.status === 'removed';
    const headSha = typeof f?.sha === 'string' ? f.sha : '';
    if (!filename || (!removed && !headSha)) return 'unverified';
    const e = await lookup(filename);
    if (e === 'unknown') return 'unverified';
    if (removed) {
      if (e.present) return 'unported';
      continue;
    }
    if (!e.present || e.sha !== headSha) return 'unported';
    if (f?.status === 'renamed' && f?.previous_filename) {
      const prev = await lookup(String(f.previous_filename));
      if (prev === 'unknown') return 'unverified';
      if (prev.present) return 'unported';
    }
  }
  return 'ported';
}

/**
 * Sweep ONE repo. `budget.remaining` is the pass-wide deletion allowance
 * (decremented in place). Never throws — an aborting error is recorded on the
 * result (`aborted`) and the metric still lands.
 */
export async function janitorRepo(opts: {
  api: JanitorGithubApi;
  owner: string;
  repo: string;
  fallbackDefaultBranch?: string | null;
  now?: Date;
  dryRun?: boolean;
  /** `remaining` = pass-wide deletions; `portCalls` = pass-wide port-check
   *  contents reads (extended rules; set on first use when absent). */
  budget: { remaining: number; portCalls?: number };
  /** Extended rules: is the digby/session-<id8> lane live? (default: prisma). */
  laneLive?: (id8: string) => Promise<boolean>;
  /** Extended rules: the framework's own repo? (default: isFrameworkOwnedRepo(owner/repo)). */
  frameworkOwned?: boolean;
}): Promise<RepoJanitorResult> {
  const { api, owner, repo, budget } = opts;
  const slug = `${owner}/${repo}`;
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun ?? branchJanitorDryRun();
  const extended = !branchJanitorExtendedRulesDisabled();
  // The new delete rules and the archive run on the framework's own repo only;
  // on a user repo the extended rules add keeps, nothing else (review 2026-10-21).
  const ownRepo = extended && (opts.frameworkOwned ?? isFrameworkOwnedRepo(slug));
  const laneLive = opts.laneLive ?? defaultLaneLive;
  const result: RepoJanitorResult = { repo: slug, scanned: 0, deleted: 0, deletedBranches: [], kept: 0, failed: 0, alreadyGone: 0, reasons: {}, dryRun };
  if (extended) result.ownRepo = ownRepo;
  if (ownRepo && budget.portCalls === undefined) budget.portCalls = BRANCH_JANITOR_PORT_CHECK_CALL_BUDGET;
  const bump = (k: DeleteReason | KeepReason) => { result.reasons[k] = (result.reasons[k] ?? 0) + 1; };
  const keep = (k: KeepReason) => { result.kept++; bump(k); };
  const deleteBranch = async (name: string, reason: DeleteReason) => {
    const del = await api.delete(`${base}/git/refs/heads/${encodeRef(name)}`);
    if (del.status === 204) {
      result.deleted++;
      result.deletedBranches.push(name); // audit trail rides the metric — container logs die with the next deploy
      budget.remaining--;
      bump(reason);
      logger.info(`branch-janitor: deleted ${slug}:${name} (${reason})`);
    } else if (del.status === 404 || del.status === 422) {
      result.alreadyGone++; // GitHub (delete_branch_on_merge) or a lane got there first
    } else {
      result.failed++;
      logger.warn(`branch-janitor: delete ${slug}:${name} answered ${del.status}: ${String(del.data?.message ?? '').slice(0, 120)}`);
    }
  };
  // Deletes that wait for the pass's ONE archive commit (own repo only). They
  // hold their share of the deletion cap until they are acted on.
  const deferred: DeferredDelete[] = [];

  try {
    const info = await getOrThrow(api, base);
    if (info.status !== 200) {
      result.aborted = `repo unreadable (${info.status})`;
      return result;
    }
    const defaultBranch = String(info.data?.default_branch || opts.fallbackDefaultBranch || 'main');
    const branches = await listBranches(api, base);
    const { heads: openHeads, bases: openBases } = await listOpenPrHeads(api, base);
    const encodedDefault = encodeRef(defaultBranch);

    // Port check: default's blobs, read lazily ONCE per repo pass (undefined =
    // not read yet, null = unreadable / truncated ⇒ per-file contents reads).
    let mainTree: Map<string, string> | null | undefined;
    const mainLookup = async (path: string): Promise<MainEntry> => {
      if (mainTree === undefined) mainTree = await fetchMainTree(api, base, encodedDefault);
      if (mainTree) return mainTree.has(path) ? { present: true, sha: mainTree.get(path) ?? null } : { present: false, sha: null };
      if ((budget.portCalls ?? 0) <= 0) return 'unknown';
      budget.portCalls = (budget.portCalls ?? 0) - 1;
      const r = await getOrThrow(api, `${base}/contents/${encodeRef(path)}?ref=${encodeURIComponent(defaultBranch)}`);
      if (r.status === 404) return { present: false, sha: null };
      if (r.status !== 200) return 'unknown';
      if (Array.isArray(r.data)) return { present: true, sha: null }; // a directory, never a blob match
      return { present: true, sha: typeof r.data?.sha === 'string' ? r.data.sha : null };
    };

    // Reviewed deletes (2026-10-22): a branch the rules can only KEEP (unported,
    // unverified, active, re-pushed) is deleted when the manifest on default names
    // it at its CURRENT tip — a review found its work on default, superseded or
    // scratch. Own repo only; read lazily, ONCE per pass. Every guard after the
    // rule still runs (2 h and 48 h floors, cap, archive REQUIRED, the ref and
    // open-PR re-reads right before the DELETE).
    let reviewed: Map<string, Set<string>> | null | undefined;
    const reviewedOn = ownRepo && !branchJanitorReviewedDeletesDisabled();
    const viaReview = async (b: BranchRow, fallback: KeepReason): Promise<boolean> => {
      if (reviewedOn && reviewed === undefined) {
        const m = await fetchReviewedDeletes(api, base, defaultBranch);
        reviewed = m.state === 'loaded' ? m.map : null;
        result.reviewedManifest = m.state;
        if (m.state === 'loaded') result.reviewedEntries = [...m.map.values()].reduce((n, s) => n + s.size, 0);
        if (m.state === 'unreadable') logger.warn(`branch-janitor: ${slug} ${BRANCH_JANITOR_REVIEWED_DELETES_PATH} is unreadable — no reviewed deletes this pass`);
      }
      const shas = reviewedOn ? reviewed?.get(b.name) : undefined;
      if (shas && b.sha && shas.has(b.sha)) return true;
      keep(shas ? 'kept_review_stale' : fallback);
      return false;
    };

    for (const b of branches) {
      result.scanned++;
      const name = b.name;
      if (name === defaultBranch || name === 'main' || name === 'master') { keep('kept_default'); continue; }
      if (b.protected) { keep('kept_protected'); continue; }
      if (openHeads.has(name)) { keep('kept_open_pr'); continue; }
      if (openBases.has(name)) { keep('kept_open_pr_base'); continue; }

      if (extended) {
        // The consolidated history branch is live history, never a lane branch.
        if (name === SESSION_HISTORY_BRANCH) { keep('kept_session_history'); continue; }
        // A lane still working (or scheduled) may push again: its branch stays,
        // whatever the rules below would say. A failed lookup counts as live.
        const id8 = laneId8Of(name);
        if (id8) {
          let live = true;
          try { live = await laneLive(id8); } catch { live = true; }
          if (live) { keep('kept_live_lane'); continue; }
        }
      }

      const framework = isFrameworkBranch(name, ownRepo);
      let reason: DeleteReason | null = null;
      let tipDate: Date | null | undefined; // undefined = not fetched yet
      // compare <default>...<branch> answered 200 with ahead_by 0: the tip is
      // on default already, so an old-rule delete needs no archive.
      let aheadZero = false;

      if (isLegacySessionHistoryBranch(name)) {
        reason = 'legacy_session_history';
      } else if (ownRepo && isClaudeSessionBranch(name)) {
        // Claude Code session branches (audit/ ops/ batch/ probe-): merged, or
        // every code change verifiably already on default.
        tipDate = await tipCommitDate(api, base, b.sha);
        if (!tipDate) { keep('kept_unknown_age'); continue; }
        if (now.getTime() - tipDate.getTime() < BRANCH_JANITOR_EXTENDED_MIN_AGE_MS) { keep('kept_young'); continue; }
        const cmp = await getOrThrow(api, `${base}/compare/${encodedDefault}...${encodeRef(name)}`);
        if (cmp.status === 200 && Number(cmp.data?.ahead_by) === 0) {
          aheadZero = true;
          reason = 'merged';
        } else {
          const port: PortVerdict = cmp.status === 200 ? await portVerdict(cmp.data?.files, mainLookup) : 'unverified';
          if (port === 'ported') {
            reason = 'ported';
          } else {
            if (!(await viaReview(b, port === 'unported' ? 'kept_unported' : 'kept_port_unverified'))) continue;
            reason = 'reviewed';
          }
        }
      } else if (!framework) {
        // Review 2026-09-14 BLOCKER: a user's develop/staging/production branch
        // that momentarily equals main (right after a sync) is NOT ours to
        // delete — foreign prefixes are kept before any compare call is spent.
        keep('kept_foreign_prefix');
        continue;
      } else {
        const cmp = await getOrThrow(api, `${base}/compare/${encodedDefault}...${encodeRef(name)}`);
        aheadZero = cmp.status === 200 && Number(cmp.data?.ahead_by) === 0;
        if (aheadZero && isMachineBranch(name, ownRepo)) {
          reason = 'merged';
        } else {
          // Squash-merged / closed PR lanes: every PR with this head is closed
          // and the branch was not re-pushed after the last close.
          const prs = await getOrThrow(api, `${base}/pulls?state=closed&head=${encodeURIComponent(`${owner}:${name}`)}&per_page=20`);
          const rows: any[] = prs.status === 200 && Array.isArray(prs.data) ? prs.data : [];
          if (rows.length === 0) {
            if (!(await viaReview(b, 'kept_active'))) continue;
            reason = 'reviewed';
          } else {
            let lastClose = 0;
            let anyMerged = false;
            let lastPrHeadSha = ''; // head.sha of the PR with the latest close (docs-repush rule)
            for (const pr of rows) {
              const t = new Date(String(pr?.merged_at ?? pr?.closed_at ?? '')).getTime();
              if (Number.isFinite(t)) {
                if (t >= lastClose) lastPrHeadSha = typeof pr?.head?.sha === 'string' ? pr.head.sha : '';
                lastClose = Math.max(lastClose, t);
              }
              if (pr?.merged_at) anyMerged = true;
            }
            tipDate = await tipCommitDate(api, base, b.sha);
            if (!tipDate) { keep('kept_unknown_age'); continue; }
            if (!lastClose || tipDate.getTime() > lastClose) {
              // Re-pushed after the last close. Extended rules, own repo: a repush
              // of ONLY docs (a lane banking its learnings) does not keep the branch.
              if (!ownRepo || !lastClose || !lastPrHeadSha) {
                if (!(await viaReview(b, 'kept_repushed'))) continue;
                reason = 'reviewed';
              } else {
                const since = await getOrThrow(api, `${base}/compare/${encodeURIComponent(lastPrHeadSha)}...${encodeRef(name)}`);
                const files: any[] = since.status === 200 && Array.isArray(since.data?.files) ? since.data.files : [];
                const docsOnly = since.status === 200 && since.data?.status === 'ahead'
                  && files.length > 0 && files.length < COMPARE_FILES_CEILING && files.every(isDocsFile);
                if (!docsOnly) {
                  if (!(await viaReview(b, 'kept_repushed'))) continue;
                  reason = 'reviewed';
                } else {
                  if (now.getTime() - tipDate.getTime() < BRANCH_JANITOR_EXTENDED_MIN_AGE_MS) { keep('kept_young'); continue; }
                  reason = 'pr_closed_docs_repush';
                }
              }
            } else {
              reason = anyMerged ? 'pr_merged' : 'pr_closed';
            }
          }
        }
      }

      // Recency guard on EVERY deletion — a lane may be mid-push.
      if (tipDate === undefined) tipDate = await tipCommitDate(api, base, b.sha);
      if (!tipDate) { keep('kept_unknown_age'); continue; }
      if (now.getTime() - tipDate.getTime() < BRANCH_JANITOR_RECENT_MS) { keep('kept_recent'); continue; }
      // fo/ state/ (and the Claude-session prefixes, already checked above) get
      // the 48 h floor too: a fresh branch cut from default is ahead 0 (review 2026-10-21).
      const extendedPrefix = ownRepo && isExtendedPrefixBranch(name);
      // A reviewed delete gets the 48 h floor on every prefix (the review saw an old tip).
      if ((extendedPrefix || reason === 'reviewed') && now.getTime() - tipDate.getTime() < BRANCH_JANITOR_EXTENDED_MIN_AGE_MS) { keep('kept_young'); continue; }
      if (budget.remaining - deferred.length <= 0) { keep('kept_cap'); continue; }

      // Own repo: a delete only the extended rules make MUST be archived; an
      // old-rule delete whose tip may not be on default is archived if it can be.
      const archive: 'required' | 'best_effort' | null = !ownRepo || reason === 'legacy_session_history' ? null
        : extendedPrefix || reason === 'pr_closed_docs_repush' || reason === 'ported' || reason === 'reviewed' ? 'required'
          : (reason === 'pr_merged' || reason === 'pr_closed') && !aheadZero ? 'best_effort'
            : null;

      if (dryRun) {
        bump(reason);
        keep('kept_dry_run');
        if (archive) logger.info(`branch-janitor[dry-run]: would archive ${slug}:${name}@${b.sha.slice(0, 7)} in ${archiveTagName(now)} (${archive})`);
        logger.info(`branch-janitor[dry-run]: would delete ${slug}:${name} (${reason})`);
        continue;
      }
      if (archive) { deferred.push({ name, sha: b.sha, reason, required: archive === 'required' }); continue; }
      await deleteBranch(name, reason);
    }

    // ONE archive commit + ONE tag for the whole pass, then the deferred deletes.
    if (deferred.length > 0) {
      const archived = await archiveTips(api, base, encodedDefault, deferred, now);
      const landed = archived.tag !== null;
      if (archived.tag !== null) {
        result.archiveTag = archived.tag;
        result.archivedTips = deferred.map(d => ({ branch: d.name, sha: d.sha }));
      } else {
        result.archiveTag = null;
        result.archiveFailed = archived.why;
        const kept = deferred.filter(d => d.required).length;
        logger.warn(`branch-janitor: archive for ${slug} failed (${archived.why}) — ${kept} branch(es) kept, ${deferred.length - kept} old-rule delete(s) go ahead untagged`);
      }
      for (const d of deferred) {
        if (!landed && d.required) { keep('kept_archive_failed'); continue; }
        // Third review (2026-10-22): COMPARE-AND-SWAP. GitHub's delete-ref takes
        // no expected sha, and the archive holds the tip from the LISTING — a lane
        // that pushed to this branch during the pass would lose those commits
        // (in neither the branch nor the tag). Re-read the ref right before the
        // delete: another sha, or a failed read, keeps the branch (next pass
        // re-judges it); a ref already gone counts as alreadyGone.
        const cas = await refStillAt(api, base, d.name, d.sha);
        if (cas === 'gone') { result.alreadyGone++; continue; }
        if (cas !== 'same') {
          keep('kept_moved');
          logger.info(`branch-janitor: ${slug}:${d.name} kept — ref ${cas === 'moved' ? 'moved past' : 'unreadable after'} the archived tip ${d.sha.slice(0, 7)} (compare-and-swap)`);
          continue;
        }
        // Fourth review (2026-10-22): the open-PR sets are as old as the pass —
        // re-read them for THIS branch (a PR opened / reopened on it during the
        // pass, push-free, would be closed by the delete). A hit, or an unreadable
        // answer, keeps the branch; the next pass re-judges it.
        const pr = await openPrNow(api, base, owner, d.name);
        if (pr !== 'none') {
          keep(pr === 'base' ? 'kept_open_pr_base' : 'kept_open_pr');
          logger.info(`branch-janitor: ${slug}:${d.name} kept — ${pr === 'unknown' ? 'its open-PR state could not be re-read' : `an open PR ${pr === 'head' ? 'from' : 'onto'} it appeared during the pass`} (compare-and-swap)`);
          continue;
        }
        await deleteBranch(d.name, d.reason);
      }
    }
  } catch (err: any) {
    result.aborted = err instanceof RateLimited ? `rate_limited_${err.status}` : String(err?.message ?? err).slice(0, 160);
    logger.warn(`branch-janitor: ${slug} scan stopped early (${result.aborted}); ${result.deleted} deleted so far — next pass resumes`);
  }

  recordLoopMetric({
    kind: LOOP_METRIC_KINDS.BRANCH_JANITOR,
    value: result.deleted,
    unit: 'branches',
    meta: {
      repo: slug,
      scanned: result.scanned,
      deleted: result.deleted,
      deletedBranches: result.deletedBranches.slice(0, 50),
      kept: result.kept,
      reasons: result.reasons,
      dryRun,
      failed: result.failed,
      alreadyGone: result.alreadyGone,
      // Extended rules: which rule set ran, and the restore trail (≤50, like deletedBranches).
      ...(result.ownRepo !== undefined ? { ownRepo: result.ownRepo } : {}),
      ...(result.archiveTag !== undefined ? { archiveTag: result.archiveTag } : {}),
      ...(result.archivedTips ? { archivedTips: result.archivedTips.slice(0, 50) } : {}),
      ...(result.archiveFailed ? { archiveFailed: result.archiveFailed } : {}),
      ...(result.reviewedManifest !== undefined ? { reviewedManifest: result.reviewedManifest } : {}),
      ...(result.reviewedEntries !== undefined ? { reviewedEntries: result.reviewedEntries } : {}),
      ...(result.aborted ? { aborted: result.aborted } : {}),
    },
  });
  return result;
}

// ── Sweep ────────────────────────────────────────────────────────────────────

/**
 * ONE janitor pass over every GitHub repo the platform manages. Never throws.
 * `apiFactory` is the test seam for the GitHub REST client.
 */
export async function sweepBranches(opts: {
  now?: Date;
  apiFactory?: (token: string) => JanitorGithubApi;
  /** Extended rules: live-lane probe (default: prisma — defaultLaneLive). */
  laneLive?: (id8: string) => Promise<boolean>;
} = {}): Promise<BranchJanitorSweepResult> {
  const result: BranchJanitorSweepResult = {
    disabled: false, dryRun: branchJanitorDryRun(), repos: 0, noToken: 0, scanned: 0, deleted: 0, kept: 0, failed: 0, perRepo: [],
  };
  if (branchJanitorDisabled()) { result.disabled = true; return result; }
  const apiFactory = opts.apiFactory ?? defaultJanitorApi;

  let projects: Array<{ id: string; userId: string; repoUrl: string | null; defaultBranch: string }> = [];
  try {
    projects = (await prisma.crossModelProject.findMany({
      where: { repoProvider: 'github', repoUrl: { not: null }, archivedAt: null },
      select: { id: true, userId: true, repoUrl: true, defaultBranch: true },
      orderBy: { createdAt: 'asc' },
    })) as any;
  } catch (err: any) {
    logger.warn(`branch-janitor: project discovery failed (sweep skipped): ${err?.message ?? err}`);
    return result;
  }

  // Dedupe by slug; remember every owner whose token could authenticate it.
  // Isolation boundary (ticket c75b5f34, review F2): a NON-prod instance
  // never sweeps (deletes branches on) the PRODUCTION repo — the guard uses
  // the normalized target, so every prod spelling (trailing slash, .git,
  // URL) is caught. Counted as failed, never skipped silently. Prod no-op.
  const repos = new Map<string, { owner: string; repo: string; userIds: string[]; defaultBranch: string }>();
  let boundaryRefused = 0;
  for (const p of projects) {
    const slug = parseGithubSlug(p.repoUrl);
    if (!slug) continue;
    const key = `${slug.owner}/${slug.repo}`.toLowerCase();
    if (!repoTargetAllowed(p.repoUrl ?? '')) { boundaryRefused++; continue; }
    const cur = repos.get(key);
    if (cur) { if (!cur.userIds.includes(p.userId)) cur.userIds.push(p.userId); }
    else repos.set(key, { owner: slug.owner, repo: slug.repo, userIds: [p.userId], defaultBranch: p.defaultBranch });
    if (repos.size >= MAX_REPOS_PER_PASS) break;
  }
  if (boundaryRefused) {
    logger.warn(`branch-janitor: isolation boundary — skipped ${boundaryRefused} project repo(s) pointing at the PRODUCTION repo (DIGBY_INSTANCE=${instanceKind()}); fix or remove those project rows`);
  }

  const budget: { remaining: number; portCalls?: number } = { remaining: BRANCH_JANITOR_MAX_DELETIONS_PER_PASS };
  for (const r of repos.values()) {
    let token: string | null = null;
    for (const userId of r.userIds) {
      token = await getValidToken(userId).catch(() => null);
      if (token) break;
    }
    if (!token) { result.noToken++; continue; }
    result.repos++;
    const rr = await janitorRepo({
      api: apiFactory(token), owner: r.owner, repo: r.repo, fallbackDefaultBranch: r.defaultBranch,
      now: opts.now, dryRun: result.dryRun, budget, laneLive: opts.laneLive,
    });
    result.perRepo.push(rr);
    result.scanned += rr.scanned;
    result.deleted += rr.deleted;
    result.kept += rr.kept;
    result.failed += rr.failed;
  }
  return result;
}

/** Cron entry (worker.ts 'branch-janitor'): one sweep + a ≤200-char summary. Never throws. */
export async function runBranchJanitorOnce(opts: {
  now?: Date;
  apiFactory?: (token: string) => JanitorGithubApi;
  laneLive?: (id8: string) => Promise<boolean>;
} = {}): Promise<string> {
  try {
    const r = await sweepBranches(opts);
    if (r.disabled) return 'disabled';
    const summary = `repos ${r.repos}, scanned ${r.scanned}, deleted ${r.deleted}, kept ${r.kept}`
      + (r.failed ? `, failed ${r.failed}` : '')
      + (r.noToken ? `, no token ${r.noToken}` : '')
      + (r.dryRun ? ' (dry-run)' : '');
    logger.info(`branch-janitor: ${summary}`);
    return summary.slice(0, 200);
  } catch (err: any) {
    logger.warn(`branch-janitor: sweep failed (non-fatal): ${err?.message ?? err}`);
    return `sweep failed: ${String(err?.message ?? err)}`.slice(0, 200);
  }
}
