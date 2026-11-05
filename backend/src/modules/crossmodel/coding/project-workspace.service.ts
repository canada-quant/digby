/**
 * Project workspace service (One-Digby merge, Phase 1 Commit B).
 *
 * Every CrossModelProject can carry a lazily-provisioned git workspace:
 *   - 'github' | 'git' → mirror of the remote (ensureRepoMirror; A1-safe refspec)
 *   - 'local'          → a bare repo Digby owns (no remote)
 *   - 'blank'          → LEGACY Digby Code blank projects (session-chained
 *                        standalone repos; NEVER converted or provisioned here)
 *
 * Uploaded knowledge docs are committed into the repo as markdown (extracted
 * text + YAML front-matter) AND stay RAG-indexed exactly as before. Commits go
 * to `defaultBranch` for local repos and to the local-only `digby/knowledge`
 * branch for github/git (never auto-pushed; survives fetches thanks to A1).
 *
 * A per-project async mutex serializes knowledge commits (amendment E5 — two
 * concurrent uploads would race non-fast-forward on the same branch).
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import {
  git, ensureRepoMirror, repoMirrorPath, worktreePath, listSessionEnvSidecars, removeSessionEnv,
  isWorkspaceVolumeOwner, listWorktreeDirsOnDisk,
} from './workspace.service';
import { withProjectLock } from './project-lock';
import { placeNewMirror, recordIsolationMetric } from './workspace-placement';
import { listSandboxHomeRootsSync } from './workspace-layout';
import { scaffoldProjectDocs } from './scaffolding.service';
import { recordLoopMetric, LOOP_METRIC_KINDS } from '../platform/loop-metrics.service';
import { processSnapshot } from './process.service';

// ── SSRF guard (amendment E3) ────────────────────────────────────────────────
// repoUrl gets cloned/fetched FROM THE BACKEND HOST. https-only, no localhost /
// private / link-local ranges, no ports (git hosts serve on 443).
const PRIVATE_HOST_RE = /^(localhost|127\.|0\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|\[?::1\]?$|\[?f[cd])/i;

export function validateRepoUrl(repoUrl: string): string | null {
  let u: URL;
  try { u = new URL(repoUrl); } catch { return 'Invalid URL'; }
  if (u.protocol !== 'https:') return 'Only https git URLs are supported';
  if (u.port && u.port !== '443') return 'Custom ports are not supported';
  if (u.username || u.password) return 'Credentials in the URL are not supported';
  if (PRIVATE_HOST_RE.test(u.hostname)) return 'Private/loopback hosts are not allowed';
  return null;
}

// ── Per-project lock (E5, cross-process) ─────────────────────────────────────
// The lock implementation lives in ./project-lock (extracted for todo
// fed7731d so workspace.service can serialize ensureRepoMirror without an
// import cycle); it is imported above and used by commitKnowledgeFile.
// Re-exported for the colocated test suite only.
export { withProjectLock as __withProjectLockForTest };

// ── Workspace state ──────────────────────────────────────────────────────────

export interface WorkspaceInfo {
  provider: string | null;      // null = plain project (no workspace)
  repoUrl: string | null;
  defaultBranch: string;
  provisioned: boolean;         // exists on disk
  workspaceAt: Date | null;
  knowledgeBranch: string | null;
}

function knowledgeBranchFor(provider: string | null): string | null {
  if (provider === 'local') return null;   // commits land on defaultBranch directly
  if (provider === 'github' || provider === 'git') return 'digby/knowledge';
  return null;
}

export async function getWorkspace(projectId: string): Promise<WorkspaceInfo | null> {
  const p = await prisma.crossModelProject.findUnique({ where: { id: projectId } });
  if (!p) return null;
  const provisioned = !!p.workspaceAt && await pathExists(repoMirrorPath(p.id));
  return {
    provider: p.repoProvider,
    repoUrl: p.repoUrl,
    defaultBranch: p.defaultBranch,
    provisioned,
    workspaceAt: p.workspaceAt,
    knowledgeBranch: knowledgeBranchFor(p.repoProvider),
  };
}

/**
 * Configure a project's workspace. Idempotent for the same config; 409-style
 * error (thrown with .status) when it conflicts with an existing one. No args →
 * a Digby-owned 'local' bare repo. Legacy 'blank' projects are refused (their
 * session-chained semantics are preserved untouched).
 */
export async function configureWorkspace(
  projectId: string,
  userId: string,
  opts: { repoUrl?: string; provider?: 'github' | 'git' | 'local'; defaultBranch?: string; githubLabel?: string | null },
): Promise<WorkspaceInfo> {
  const p = await prisma.crossModelProject.findFirst({ where: { id: projectId, userId } });
  // Ticket 23f453de: a bare "Project not found" for a project that exists is
  // the misleading-refusal class — an owner-facing re-pin stalled ~1h on it
  // because the message named neither the id it looked up nor any recovery.
  // The controller and the configure_workspace tool BOTH call this with the
  // exact id, so the exact lookup stays; the message now names the id and the
  // reference forms the tool seam accepts (exact id, EXACT name, chat id in
  // the project, unique ≥8-char id prefix — resolved at the seam, not here).
  if (!p) throw Object.assign(
    new Error(`Project not found (projectId: "${projectId}"). No project you own matches that exact id — pass the id verbatim from list_projects; on the configure_workspace tool its EXACT name, a chat id inside the project, or a unique ≥8-char id prefix also resolves. Never reconstruct or abbreviate an id.`),
    { status: 404 },
  );
  if (p.repoProvider === 'blank') {
    throw Object.assign(new Error('Legacy blank coding projects keep their session-chained workspaces'), { status: 409 });
  }
  // Framework surface (ticket 9471d338): the platform's own project IS its
  // repo — re-pointing it would strip the identity every guard and the
  // Management tab resolve from. Re-pinning other projects is unchanged.
  const { isFrameworkProjectRow, instanceOwnRepoSlugSoft, frameworkGuardMessage } = await import('../platform/framework-project');
  if (isFrameworkProjectRow(p, instanceOwnRepoSlugSoft())) {
    throw Object.assign(new Error(frameworkGuardMessage('repoint')), { status: 403 });
  }

  const provider = opts.provider ?? (opts.repoUrl ? 'github' : 'local');
  const repoUrl = opts.repoUrl ?? null;
  if (repoUrl) {
    const bad = validateRepoUrl(repoUrl);
    if (bad) throw Object.assign(new Error(bad), { status: 400 });
  }
  if ((provider === 'github' || provider === 'git') && !repoUrl) {
    throw Object.assign(new Error('repoUrl is required for github/git workspaces'), { status: 400 });
  }

  if (p.repoProvider) {
    // Idempotent re-configure with the same target is fine; changing it is not.
    // A label-ONLY call (no repoUrl / provider / defaultBranch) always names
    // the same target — it exists to re-pin the GitHub account label, and must
    // not die on the provider derivation ('local' default → false 409 against
    // a 'github' project).
    const labelOnly = opts.repoUrl === undefined && opts.provider === undefined && opts.defaultBranch === undefined;
    if (labelOnly || (p.repoProvider === provider && (p.repoUrl ?? null) === repoUrl)) {
      // FO f121-hook (2026-10-12): a same-target re-configure carrying a
      // githubLabel must WRITE it. After a connector disconnect+reconnect
      // re-creates the token rows under NEW labels, re-pinning the project's
      // label is the only lane-side remedy for the label-pinned push outage
      // (getValidToken(userId, project.githubLabel) hard-misses → every
      // push/PR/merge refused fleet-wide with no log line). The bare
      // early-return SWALLOWED exactly that call — the crossmodel
      // supervisor's 08:38Z re-pin reported "provisioned" while the row kept
      // the dead label and git_push kept refusing. Only a real string writes:
      // BOTH call sites (the HTTP controller and the configure_workspace
      // tool) coerce an absent field to null, and an idempotent re-call must
      // never CLEAR the stored label.
      if (typeof opts.githubLabel === 'string' && opts.githubLabel !== (p.githubLabel ?? null)) {
        await prisma.crossModelProject.update({ where: { id: projectId }, data: { githubLabel: opts.githubLabel } });
        logger.info(`project workspace: githubLabel re-pinned to "${opts.githubLabel}" for ${projectId}`);
        await warnIfPinnedLabelMissing(userId, projectId);
      }
      return (await getWorkspace(projectId))!;
    }
    throw Object.assign(new Error(`Workspace already configured (${p.repoProvider})`), { status: 409 });
  }
  await prisma.crossModelProject.update({
    where: { id: projectId },
    data: {
      repoProvider: provider,
      repoUrl,
      defaultBranch: opts.defaultBranch || p.defaultBranch || 'main',
      githubLabel: opts.githubLabel ?? null,
    },
  });
  await warnIfPinnedLabelMissing(userId, projectId);
  return (await getWorkspace(projectId))!;
}

/**
 * Write-seam guard (log-signal family lane 65787dde, ticket e1cca01d,
 * 2026-10-19): a github/git project whose pinned githubLabel matches NO
 * connected GitHub account is a TIME BOMB — the bad pin lands silently at
 * configure/import time and only surfaces 5 h later at the first git op, when
 * the getValidToken label-miss fallback starts hot-looping its warn (the
 * 2026-10-18 canlegal-bench burst: imported 04:20Z with the dead "example-org"
 * pin, 73 warn rows 05:15–10:06Z). Non-blocking by design — the f121 fallback
 * keeps writes working whatever the pin says — but the mismatch is named AT
 * THE WRITE, with the recovery (re-pin or reconnect), so the next operator
 * reading logs sees the state the moment it is created instead of hours
 * later. A github/git provider with NO connected account at all is NOT
 * mismached (repo-less label reads and public clones still work) — only a
 * pinned label that misses while OTHER labels exist is the dead-pin shape.
 * Exported so the import_repo seam (coord-tools.ts) shares ONE copy — the
 * two seams must not drift (adversarial review finding 7).
 */
export async function warnIfPinnedLabelMissing(userId: string, projectId: string): Promise<void> {
  try {
    const p = await prisma.crossModelProject.findUnique({ where: { id: projectId }, select: { repoProvider: true, githubLabel: true, userId: true } });
    if (!p || !p.repoProvider || p.repoProvider === 'local') return;
    if (typeof p.githubLabel !== 'string' || p.githubLabel.length === 0) return;
    const rows = await (prisma as any).gitHubOAuthToken.findMany({
      where: { userId },
      select: { label: true },
    });
    if (!rows || rows.length === 0) return; // no accounts connected: not this class
    if (rows.some((r: { label: string | null }) => r.label === p.githubLabel)) return; // pin is live
    const live = rows.map((r: { label: string | null }) => r.label || 'Personal').join('", "');
    logger.warn(
      `project workspace: githubLabel "${logSafeLabel(p.githubLabel)}" pins no connected GitHub account for ${projectId} ` +
      `(connected: "${live}") — every git op on this project will use the first-connected fallback until the label is re-pinned ` +
      `(configure_workspace githubLabel) or the account is reconnected under "${logSafeLabel(p.githubLabel)}".`
    );
  } catch {
    /* observability only — never block the configure/re-pin on this check */
  }
}

/** Log-safe interpolation for user-authored labels (review finding 9): a
 *  label carrying \n must not forge log lines or split the sweep fingerprint. */
function logSafeLabel(s: unknown): string {
  return String(s ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 120) || 'unknown';
}

/**
 * Ensure the workspace exists on disk. github/git → mirror (A1-safe). local →
 * bare init + a seed commit carrying project scaffolding (AGENTS.md describing
 * the project + knowledge/README.md). Sets workspaceAt on first provision.
 */
export async function ensureProvisioned(
  projectId: string,
  getToken?: () => Promise<string | null>,
): Promise<string> {
  const p = await prisma.crossModelProject.findUnique({ where: { id: projectId } });
  if (!p || !p.repoProvider) throw Object.assign(new Error('No workspace configured'), { status: 400 });
  if (p.repoProvider === 'blank') throw Object.assign(new Error('Legacy blank projects are session-provisioned'), { status: 409 });

  let mirror = repoMirrorPath(p.id);
  if (p.repoProvider === 'github' || p.repoProvider === 'git') {
    const token = p.repoProvider === 'github' && getToken ? await getToken() : null;
    mirror = await ensureRepoMirror(p.id, p.repoUrl!, token);
  } else {
    // 'local' — a bare repo Digby owns.
    if (!(await pathExists(mirror))) {
      // build 2026-10-08 ISO: a NEW local repo goes under the project owner's
      // per-user subtree when the switch applies (else the legacy path).
      const placed = await placeNewMirror(p.id);
      mirror = placed.path;
      if (placed.reason !== 'switch_off') recordIsolationMetric('placement', { what: 'mirror', projectId: p.id, layout: placed.layout, reason: placed.reason });
      await fs.mkdir(mirror, { recursive: true });
      await git(['init', '--bare', '-b', p.defaultBranch || 'main'], mirror);
      await seedLocalRepo(p, mirror);
      logger.info(`project workspace: local bare repo provisioned for ${p.id}`);
    }
  }
  if (!p.workspaceAt) {
    await prisma.crossModelProject.update({ where: { id: p.id }, data: { workspaceAt: new Date() } }).catch(() => {});
  }
  return mirror;
}

/** Seed a fresh 'local' bare repo via a temp worktree: scaffolding + knowledge dir. */
async function seedLocalRepo(project: any, mirror: string): Promise<void> {
  await withTempWorktree(mirror, project.defaultBranch || 'main', async wt => {
    // Project-type-aware scaffold: for non-code projects AGENTS.md describes the
    // project from its name/description/systemPrompt (empty verify chain).
    await scaffoldProjectDocs(wt, { projectName: project.name, defaultBranch: project.defaultBranch || 'main', commit: false, repoHygiene: true }).catch(() => {});
    const knowledgeDir = path.join(wt, 'knowledge');
    await fs.mkdir(knowledgeDir, { recursive: true });
    await fs.writeFile(path.join(knowledgeDir, 'README.md'),
      `# Knowledge\n\nDocuments uploaded to the "${project.name}" project land here as markdown (extracted text + front-matter). They are also RAG-indexed for chat.\n`, 'utf8');
    if (project.description || project.systemPrompt) {
      const desc = [`# ${project.name}`, '', project.description || '', project.systemPrompt ? `\n## Instructions\n\n${project.systemPrompt}` : ''].join('\n');
      await fs.writeFile(path.join(wt, 'PROJECT.md'), desc, 'utf8');
    }
    await git(['add', '-A'], wt);
    await git(['commit', '-m', 'chore: initialize Digby project workspace'], wt);
    await git(['push', 'origin', `HEAD:refs/heads/${project.defaultBranch || 'main'}`], wt);
  });
}

/** Short-lived temp worktree cloned from the mirror; always cleaned up. */
async function withTempWorktree<T>(mirror: string, branch: string, fn: (wt: string) => Promise<T>): Promise<T> {
  const wt = await fs.mkdtemp(path.join(os.tmpdir(), 'digby-kw-'));
  try {
    await git(['clone', '--no-hardlinks', mirror, wt], undefined, 120_000);
    await git(['config', 'user.name', 'Digby'], wt);
    await git(['config', 'user.email', 'digby@digby.ai'], wt);
    // Check out (or create) the target branch.
    const hasBranch = await git(['rev-parse', '--verify', `origin/${branch}`], wt).then(() => true).catch(() =>
      git(['rev-parse', '--verify', branch], wt).then(() => true).catch(() => false));
    if (hasBranch) await git(['checkout', branch], wt).catch(() => git(['checkout', '-b', branch, `origin/${branch}`], wt));
    else await git(['checkout', '-b', branch], wt);
    return await fn(wt);
  } finally {
    await fs.rm(wt, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Knowledge commits ────────────────────────────────────────────────────────

/**
 * Commit one knowledge document into the project repo (fire-and-forget from the
 * upload path; only when the workspace is already provisioned). Serialized per
 * project (E5). Local → defaultBranch; github/git → digby/knowledge (local-only).
 */
export async function commitKnowledgeFile(
  projectId: string,
  doc: { name: string; mimeType: string; sourceUrl?: string | null; text: string },
): Promise<boolean> {
  return withProjectLock(projectId, async () => {
    const p = await prisma.crossModelProject.findUnique({ where: { id: projectId } });
    if (!p?.repoProvider || p.repoProvider === 'blank') return false;
    const mirror = repoMirrorPath(p.id);
    if (!(await pathExists(mirror))) return false; // not provisioned — syncKnowledgeToRepo catches up later

    const branch = knowledgeBranchFor(p.repoProvider) ?? (p.defaultBranch || 'main');
    const fname = doc.name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'document';
    const front = [
      '---',
      `title: ${JSON.stringify(doc.name)}`,
      `source: ${JSON.stringify(doc.sourceUrl || doc.mimeType)}`,
      `imported: ${new Date().toISOString()}`,
      '---',
      '',
    ].join('\n');

    try {
      await withTempWorktree(mirror, branch, async wt => {
        const dir = path.join(wt, 'knowledge');
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, `${fname}.md`), front + doc.text, 'utf8');
        await git(['add', '-A'], wt);
        await git(['commit', '-m', `docs(knowledge): ${doc.name}`], wt);
        await git(['push', 'origin', `HEAD:refs/heads/${branch}`], wt);
      });
      logger.info(`project workspace: knowledge commit "${doc.name}" → ${projectId}@${branch}`);
      return true;
    } catch (err: any) {
      logger.warn(`project workspace: knowledge commit failed for ${projectId}: ${err.message}`);
      return false;
    }
  });
}

/** Commit all project docs not yet in the repo (deferred catch-up). */
export async function syncKnowledgeToRepo(projectId: string): Promise<{ committed: number; skipped: number }> {
  const docs = await prisma.projectDocument.findMany({
    where: { projectId, status: 'ready' },
    select: { id: true, name: true, mimeType: true, sourceUrl: true },
  });
  let committed = 0, skipped = 0;
  for (const d of docs) {
    // Rebuild text from the RAG chunks (raw upload bytes are never persisted).
    const chunks = await prisma.$queryRawUnsafe<Array<{ content: string }>>(
      `SELECT "content" FROM "project_chunks" WHERE "documentId" = $1 ORDER BY "chunkIndex" ASC`, d.id,
    ).catch(() => [] as Array<{ content: string }>);
    const text = chunks.map(c => c.content).join('\n\n');
    if (!text) { skipped++; continue; }
    const ok = await commitKnowledgeFile(projectId, { name: d.name, mimeType: d.mimeType, sourceUrl: d.sourceUrl, text });
    if (ok) committed++; else skipped++;
  }
  return { committed, skipped };
}

// ── Worktree reaper (amendments A3 + disk cap) ───────────────────────────────

const REAP_IDLE_MS = 7 * 24 * 3600 * 1000;   // ready + idle > 7d
const DISK_SOFT_CAP = 0.80;                   // >80% → escalate (see below)
/** Under disk pressure the idle bar drops and the batch grows (2026-08-19: the
 *  prod volume reached 52GB of worktrees while the soft cap only ever LOGGED). */
const PRESSURE_IDLE_MS = 48 * 3600 * 1000;
const PRESSURE_TAKE = 100;
const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
/** After a pass, usage still above this is an error (feeds the log-signal sweep).
 *  Distinct from container.service PRE_EXEC_DISK_SOFT_CAP (same 0.85 number): that
 *  one defers a verify; this one alarms that the reaper did not free enough. */
const POST_PASS_ALARM = 0.85;

/** `WORKTREE_DISK_ADAPTIVE_DISABLED=1` restores the pre-2026-10-18 behaviour:
 *  7d idle, 6h cron, batch 25/50, pressure only above 80%. */
function worktreeDiskAdaptiveDisabled(): boolean {
  return process.env.WORKTREE_DISK_ADAPTIVE_DISABLED === '1';
}

/** Artifact prune idle. Adaptive default is 6h (sessions reinstall on the next
 *  install/verify). The function's own default argument stays the 7d constant so
 *  callers that omit idleMs keep the old bar; only the reaper pass passes this. */
function artifactPruneIdleMs(): number {
  if (worktreeDiskAdaptiveDisabled()) return 7 * DAY_MS;
  const raw = Number(process.env.ARTIFACT_PRUNE_IDLE_MS);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 6 * HOUR_MS;
}

/** Durable cron + in-process timer. Kill switch restores 21600 (6h). */
export function worktreeReapIntervalSec(): number {
  if (worktreeDiskAdaptiveDisabled()) return 21600;
  const raw = Number(process.env.WORKTREE_REAP_INTERVAL_SEC);
  if (Number.isFinite(raw) && raw >= 60) return Math.floor(raw);
  return 3600;
}

/** Full-reap idle bar. <60% (or unknown) → 7d, <70% → 3d, ≥70% → 48h.
 *  Kill switch always returns 7d (the pressure pass still uses 48h above 80%). */
export function reapIdleMsForUsage(usage: number | null): number {
  if (worktreeDiskAdaptiveDisabled()) return 7 * DAY_MS;
  if (usage == null || usage < 0.60) return 7 * DAY_MS;
  if (usage < 0.70) return 3 * DAY_MS;
  return 48 * HOUR_MS;
}

/** Pure idle-prune selection. A live run or an enabled schedule is never pruned.
 *  Otherwise idle when the row OR the on-disk dir is older than the cutoff. */
export function shouldPruneWorktreeArtifacts(opts: {
  updatedAt: number;
  mtimeMs: number | null;
  cutoff: number;
  hasLiveRun: boolean;
  scheduled: boolean;
}): boolean {
  if (opts.hasLiveRun || opts.scheduled) return false;
  if (opts.updatedAt < opts.cutoff) return true;
  return opts.mtimeMs != null && opts.mtimeMs < opts.cutoff;
}

function diskPressure(usage: number | null): boolean {
  if (usage == null) return false;
  if (worktreeDiskAdaptiveDisabled()) return usage > DISK_SOFT_CAP;
  const raw = Number(process.env.WORKTREE_DISK_PRESSURE);
  const cap = Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : 0.70;
  return usage >= cap;
}

/**
 * Reap idle coding-chat worktrees: WIP-snapshot uncommitted work (A3 — the
 * branch survives in the mirror thanks to A1), stop the container, remove the
 * worktree, null worktreePath. Legacy 'blank' sessions are SKIPPED — their
 * standalone repo IS the worktree (removal would destroy the only copy);
 * they get artifact pruning instead (pruneReinstallableArtifacts). Archived
 * sessions reap on the same terms as ready ones — an archived session's
 * worktree used to survive FOREVER (2026-08-19 census).
 * Re-provisioning happens on demand in the worker's run-executor (ensureRunnable).
 *
 * Review 2026-09-13 issue 8 — census by DIRECTORY, not by DB path: the
 * candidate set is every ready/archived row past the idle bar whose path is
 * non-null OR whose session dir exists ON DISK (a null path with a dir on the
 * volume is exactly the orphan the box-A mis-claim manufactured), plus dirs
 * with NO row at all, idle by mtime. Only the volume OWNER nulls the DB path
 * or stops containers; a non-owner box (stale copy) removes its local copy and
 * leaves the shared row alone — nulling it from there is what orphaned 177 dirs.
 */
/**
 * Save-before-delete for the reaper. 'clean' = nothing uncommitted; 'saved' =
 * a WIP commit landed and the tree is now clean; 'unsaved' = there is
 * uncommitted work and the commit did not take it; 'unknown' = `git status`
 * itself failed. Callers never delete on 'unsaved' (and, for a session with a
 * row, not on 'unknown' either). The commit carries an explicit identity and
 * --no-verify so a missing git identity or a repo hook cannot fail it. Never
 * throws.
 */
export async function snapshotBeforeReap(wt: string, message: string): Promise<'clean' | 'saved' | 'unsaved' | 'unknown'> {
  const status = async (): Promise<string | null> =>
    git(['status', '--porcelain=v1'], wt).then(r => r.stdout.trim()).catch(() => null);
  const before = await status();
  if (before === null) return 'unknown';
  if (!before) return 'clean';
  await git(['add', '-A'], wt).catch(() => {});
  await git(['-c', 'user.name=Digby', '-c', 'user.email=digby@digby.ai', 'commit', '--no-verify', '-m', message], wt).catch(() => {});
  const after = await status();
  return after === '' ? 'saved' : 'unsaved';
}

/** One warn per session per process — a worktree that cannot be snapshotted
 *  is skipped every pass, and an hourly repeat of the same line is noise. */
const reapSkipWarned = new Set<string>();
function warnReapSkippedOnce(sessionId: string, why: 'unsaved' | 'unknown'): void {
  if (reapSkipWarned.has(sessionId)) return;
  if (reapSkipWarned.size > 5000) reapSkipWarned.clear();
  reapSkipWarned.add(sessionId);
  logger.warn(`worktree reaper: kept session ${sessionId} — ${why === 'unsaved' ? 'uncommitted work could not be snapshotted' : 'git status failed, cannot tell whether it holds unsaved work'}; not deleting`);
}

/** Per-pass counts of worktrees the reaper KEPT, for the worktree_reap_pass
 *  row: a dir kept because git status failed ('unknown') or its WIP snapshot
 *  did not land ('unsaved') stays forever by design (it may hold the only
 *  copy of work) — the count makes that pile-up visible instead. */
export interface ReapPassStats { keptUnknown: number; keptUnsaved: number; keptLive: number }

/**
 * Liveness RE-CHECK for ONE session, immediately before a destructive step
 * (WIP commit + delete, or an artifact prune) — the candidate lists are built
 * up to hundreds of sessions earlier and a run can be queued / started in
 * between (2026-10-20 review of #1768). Busy = a queued/running agent run
 * (DB) or a background process this worker still tracks as running (the
 * in-memory registry — the reaper cron is volume-bound, so it runs in the
 * coding box's worker that owns those handles). A lookup error is 'unknown'
 * and the caller skips (fail closed). WORKTREE_REAP_LIVE_RECHECK_DISABLED=1
 * restores the batch-only checks.
 */
export async function sessionBusyForReap(sessionId: string): Promise<'idle' | 'live_run' | 'bg_process' | 'unknown'> {
  if (process.env.WORKTREE_REAP_LIVE_RECHECK_DISABLED === '1') return 'idle';
  if (processSnapshot(sessionId).some(p => p.status === 'running')) return 'bg_process';
  try {
    const rows = await prisma.agentRun.findMany({
      where: { sessionId, status: { in: ['queued', 'running'] } },
      select: { sessionId: true },
      take: 1,
    });
    return rows.length ? 'live_run' : 'idle';
  } catch {
    return 'unknown';
  }
}

export async function reapIdleWorktrees(opts?: { idleMs?: number; take?: number; reason?: 'idle' | 'disk_pressure'; exemptScheduled?: boolean; stats?: ReapPassStats }): Promise<number> {
  const cutoff = new Date(Date.now() - (opts?.idleMs ?? REAP_IDLE_MS));
  const take = opts?.take ?? 25;
  const reason = opts?.reason ?? 'idle';
  const volumeOwner = isWorkspaceVolumeOwner();
  // Review 2026-09-13 issue 8: what is actually on this box's disk. null =
  // root unreadable → DB-path candidates only (never reap on uncertainty).
  const onDisk = (await listWorktreeDirsOnDisk()) ?? [];
  const diskIds = onDisk.map(d => d.sessionId);
  const idleWhere = { status: { in: ['ready', 'archived'] }, updatedAt: { lt: cutoff } };
  let candidates = await prisma.chatCodingState.findMany({
    where: diskIds.length
      ? { ...idleWhere, OR: [{ worktreePath: { not: null } }, { id: { in: diskIds } }] }
      : { ...idleWhere, worktreePath: { not: null } },
    orderBy: { updatedAt: 'asc' },
    take,
    include: { project: { select: { id: true, repoProvider: true } } },
  });
  // P6 (spark B24 / CanLaw B12): under the 48h disk-pressure bar, sessions with
  // an ENABLED schedule are LIVE lanes — a long-interval monitor would be reaped
  // between firings and pay a cold re-provision (fresh HOME, gone deps, lost
  // background state) on every wake. Exempt them from the pressure pass; the
  // default 7d bar is untouched. Fail-SAFE: a lookup error exempts everything
  // (uncertainty must not reap a live lane; disk gets the next pass).
  if (opts?.exemptScheduled && candidates.length) {
    const scheduled = await prisma.chatSchedule
      .findMany({ where: { sessionId: { in: candidates.map(c => c.id) }, enabled: true }, select: { sessionId: true } })
      .catch((err: any) => {
        logger.warn(`worktree reaper: schedule-exemption lookup failed (${err.message}) — skipping this pressure batch`);
        return null;
      });
    if (scheduled === null) return 0;
    const live = new Set(scheduled.map(r => r.sessionId));
    candidates = candidates.filter(c => !live.has(c.id));
  }
  let reaped = 0;
  for (const s of candidates) {
    const provider = (s as any).project?.repoProvider;
    if (provider === 'blank' || !provider) continue; // only copy — never reap
    try {
      const wt = worktreePath(s.id);
      const onDiskHere = await pathExists(wt);
      // A null-path row is a candidate ONLY because its dir was in the census;
      // if it vanished since, there is nothing to reap (no phantom row/metric).
      if (s.worktreePath === null && !onDiskHere) continue;
      // Re-check liveness for THIS session right before the WIP commit +
      // delete: a run may have been queued since the candidate query.
      const busy = await sessionBusyForReap(s.id);
      if (busy !== 'idle') {
        if (opts?.stats) opts.stats.keptLive++;
        logger.info(`worktree reaper: kept session ${s.id} — ${busy === 'unknown' ? 'live-run lookup failed' : busy === 'live_run' ? 'a run was queued/started mid-pass' : 'a background process is still running'}`);
        continue;
      }
      if (onDiskHere) {
        // A3: snapshot uncommitted changes so nothing is lost. A snapshot that
        // did not land (commit failed, status unreadable) SKIPS the reap — the
        // worktree is the only copy of that work (2026-10-19: the old code
        // swallowed both failures and rm -rf'd the dir anyway).
        const snap = await snapshotBeforeReap(wt, 'wip: auto-snapshot before worktree reap');
        if (snap === 'unsaved' || snap === 'unknown') {
          if (opts?.stats) { if (snap === 'unknown') opts.stats.keptUnknown++; else opts.stats.keptUnsaved++; }
          warnReapSkippedOnce(s.id, snap);
          continue;
        }
      }
      const { stopSessionContainer, removeSandboxHome } = await import('./container.service');
      if (!volumeOwner) {
        // Review 2026-09-13 issue 8: this box holds only a COPY of the volume.
        // Free the local copy, but never touch the shared DB row (nulling it
        // orphans the owner's real dir) and never the containers (DOCKER_HOST
        // here points at the owner's daemon — that would stop the REAL one).
        if (!onDiskHere) continue; // nothing local to free; not a reap
        await fs.rm(wt, { recursive: true, force: true }).catch(() => {});
        await removeSandboxHome(s.id);
        reaped++;
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.WORKTREE_REAPED,
          sessionId: s.id,
          meta: { chatId: s.id, reason, provider, volumeOwner: false, dbNulled: false, pathWasNull: s.worktreePath === null },
        });
        logger.info(`worktree reaper: removed LOCAL COPY of session ${s.id} worktree (not the volume owner — DB path untouched)`);
        continue;
      }
      await stopSessionContainer(s.id).catch(() => {});
      const { removeWorktree, persistSessionEnv } = await import('./workspace.service');
      // The WIP commit above can never carry .digby/session/env.sh (git-ignored)
      // — sidecar the session's env seed before the worktree dies (2026-08-20
      // canlaw wipe: reaps destroyed keys that lived only in $DIGBY_ENV).
      await persistSessionEnv(wt, s.id).catch(() => {});
      await removeWorktree(s.projectId, s.id).catch(() => {});
      // The session's durable sandbox HOME (e267b760) dies with its worktree —
      // a re-provisioned session gets a fresh one on next container create.
      await removeSandboxHome(s.id);
      await prisma.chatCodingState.update({ where: { id: s.id }, data: { worktreePath: null } });
      reaped++;
      // Telemetry (remediation P0): one row per reaped worktree so reap volume
      // and pressure reaps are chartable next to disk incidents. Review
      // 2026-09-13 issue 8 adds the census provenance (pathWasNull = a dir the
      // old non-null-path query could not see).
      recordLoopMetric({
        kind: LOOP_METRIC_KINDS.WORKTREE_REAPED,
        sessionId: s.id,
        meta: { chatId: s.id, reason, provider, volumeOwner: true, dbNulled: true, pathWasNull: s.worktreePath === null, onDisk: onDiskHere },
      });
      logger.info(`worktree reaper: reaped session ${s.id} (idle since ${s.updatedAt.toISOString()}${provider ? `, ${provider}` : ''}${s.worktreePath === null ? ', DB path was already null' : ''})`);
    } catch (err: any) {
      logger.warn(`worktree reaper: failed for ${s.id}: ${err.message}`);
    }
  }
  reaped += await reapOrphanWorktreeDirs(onDisk, cutoff, Math.max(0, take - reaped), reason, volumeOwner, opts?.stats);
  return reaped;
}

/**
 * Review 2026-09-13 issue 8: dirs under worktrees/ with NO chatCodingState row
 * at all (59 of the 223 in the census — deleted chats whose teardown never
 * reached the disk, or reaps interrupted mid-way). Idle by directory mtime
 * (the only signal left); the WIP snapshot is still attempted (a linked
 * worktree's commit lands in the mirror's object store, on the session
 * branch) and the mirror's worktree admin entry is pruned when the `.git`
 * file names it. FAIL-SAFE: a failed row lookup skips the whole pass — a DB
 * hiccup must never make every dir look orphaned. Never touches the DB.
 */
async function reapOrphanWorktreeDirs(
  onDisk: Array<{ sessionId: string; mtimeMs: number }>,
  cutoff: Date,
  budget: number,
  reason: 'idle' | 'disk_pressure',
  volumeOwner: boolean,
  stats?: ReapPassStats,
): Promise<number> {
  if (!onDisk.length || budget <= 0) return 0;
  const ids = onDisk.map(d => d.sessionId);
  const rows = await prisma.chatCodingState
    .findMany({ where: { id: { in: ids } }, select: { id: true } })
    .catch((err: any) => {
      logger.warn(`worktree reaper: orphan-dir row lookup failed (${err.message}) — skipping the orphan pass`);
      return null;
    });
  if (!rows) return 0;
  const known = new Set(rows.map(r => r.id));
  const orphans = onDisk
    .filter(d => !known.has(d.sessionId) && d.mtimeMs < cutoff.getTime())
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .slice(0, budget);
  let reaped = 0;
  for (const d of orphans) {
    const wt = worktreePath(d.sessionId);
    try {
      // An orphan has no session row (its chat was deleted); a dir that is not
      // a git worktree at all ('unknown') carries nothing to snapshot. Dirty
      // work whose snapshot failed is kept.
      const snap = await snapshotBeforeReap(wt, 'wip: auto-snapshot before orphan worktree reap');
      if (snap === 'unsaved') {
        if (stats) stats.keptUnsaved++;
        warnReapSkippedOnce(d.sessionId, snap);
        continue;
      }
      // A linked worktree's `.git` is a FILE: "gitdir: <mirror>/worktrees/<id>".
      const gitdir = await fs.readFile(path.join(wt, '.git'), 'utf8')
        .then(t => t.trim().replace(/^gitdir:\s*/, ''))
        .catch(() => '');
      await fs.rm(wt, { recursive: true, force: true });
      if (gitdir && /[\\/]worktrees[\\/][^\\/]+$/.test(gitdir)) {
        await git(['worktree', 'prune'], path.dirname(path.dirname(gitdir))).catch(() => {});
      }
      reaped++;
      recordLoopMetric({
        kind: LOOP_METRIC_KINDS.WORKTREE_REAPED,
        sessionId: d.sessionId,
        meta: { chatId: d.sessionId, reason, provider: null, orphan: true, volumeOwner, dbNulled: false },
      });
      logger.info(`worktree reaper: removed orphan worktree dir ${d.sessionId} (no session row; dir mtime ${new Date(d.mtimeMs).toISOString()})`);
    } catch (err: any) {
      logger.warn(`worktree reaper: orphan dir ${d.sessionId} failed: ${err.message}`);
    }
  }
  return reaped;
}

/**
 * Prune REINSTALLABLE build artifacts inside idle worktrees — the safe reclaim
 * that applies to EVERY session, including blank/legacy ones whose worktree is
 * the only copy of the user's work (source files are never touched; these dirs
 * are regenerated by the next npm/pnpm install or build). 2026-08-19 census:
 * 52GB of worktrees, dominated by exactly these directories. 2026-09-18 (ticket
 * 09d84d7d): .npm + .cache join the set — a worktree doubles as the session's
 * sandbox HOME, so npm's cache alone held ~0.5 GB per worktree (~75 GB of the
 * 111 GB that blocked every deploy on box A).
 */
// `tmp` is NOT here (2026-10-19 review of #1768): a session's tmp/ holds the
// user's own scratch outputs, not something an install regenerates.
const REINSTALLABLE_DIRS = new Set(['node_modules', '.next', '.turbo', '.pnpm-store', '__pycache__', '.npm', '.cache']);
const ARTIFACT_PRUNE_IDLE_MS = 7 * 24 * 3600 * 1000;
/** Ticket 09d84d7d: a row written within this window is a LIVE lane and its
 *  worktree's top-dir mtime says nothing (quiet runs churn only deep files, so
 *  the top dir can look ancient mid-life) — the dir-mtime co-signal below only
 *  applies to rows older than this floor. */
const ARTIFACT_PRUNE_ROW_FLOOR_MS = 6 * 3600 * 1000;

export async function pruneReinstallableArtifacts(opts?: { idleMs?: number; take?: number; exemptScheduled?: boolean; stats?: ReapPassStats }): Promise<number> {
  const cutoffMs = Date.now() - (opts?.idleMs ?? ARTIFACT_PRUNE_IDLE_MS);
  const rowFloorMs = Date.now() - ARTIFACT_PRUNE_ROW_FLOOR_MS;
  // Review 2026-09-13 issue 8: same census widening as the reaper — a null
  // DB path with a dir on disk (76 GB of node_modules lived in exactly those)
  // is a prune candidate too.
  const onDisk = (await listWorktreeDirsOnDisk()) ?? [];
  const mtimeById = new Map(onDisk.map(d => [d.sessionId, d.mtimeMs]));
  const diskIds = onDisk.map(d => d.sessionId);
  // Ticket 09d84d7d (the disk-starvation loop that blocked every deploy on box
  // A): judging idleness by updatedAt ALONE left ~110 GB of ancient worktrees
  // untouchable — housekeeping writers (idle-chat-archiver batches,
  // provisioning ready-flips after each mass reap, orphan sweeps) bump
  // updatedAt without touching the worktree, so the whole fleet's idle clock
  // resets after every fleet-wide event while the disk refills within hours
  // (2026-09-18: only 41 of 149 ancient dirs were eligible even at a 6h bar).
  // The on-disk dir mtime is the co-signal: a worktree whose top dir has not
  // churned since the cutoff is idle even when its row was housekeeping-touched.
  const candidates = await prisma.chatCodingState.findMany({
    where: {
      status: { in: ['ready', 'archived'] },
      updatedAt: { lt: new Date(rowFloorMs) },
      ...(diskIds.length
        ? { OR: [{ worktreePath: { not: null } }, { id: { in: diskIds } }] }
        : { worktreePath: { not: null } }),
    },
    orderBy: { updatedAt: 'asc' },
    take: 1000, // the co-signal cohort sorts LAST under updatedAt asc — fetch deep, cap the PRUNE batch after filtering
    select: { id: true, updatedAt: true },
  });
  // shouldPruneWorktreeArtifacts is THE predicate (2026-10-20: it was dead
  // code beside an inline copy). First pass: the idle clock alone (the live /
  // scheduled lookups below are scoped to these ids); final pass: the same
  // predicate with the real live-run + schedule answers.
  const predicate = (s: { id: string; updatedAt: Date }, flags: { hasLiveRun: boolean; scheduled: boolean }) =>
    shouldPruneWorktreeArtifacts({
      updatedAt: s.updatedAt.getTime(),
      mtimeMs: mtimeById.get(s.id) ?? null,
      cutoff: cutoffMs,
      ...flags,
    });
  let idle = candidates.filter(s => predicate(s, { hasLiveRun: false, scheduled: false }));
  let scheduledIds = new Set<string>();
  // P6 mirror (pressure call sites): an enabled schedule means the lane fires
  // again — skip it rather than bill it a cold reinstall every pass. Fail-SAFE:
  // a lookup error skips the batch (uncertainty must not touch a live lane).
  if (opts?.exemptScheduled && idle.length) {
    const scheduled = await prisma.chatSchedule.findMany({
      where: { sessionId: { in: idle.map(c => c.id) }, enabled: true },
      select: { sessionId: true },
    }).catch((err: any) => {
      logger.warn(`artifact prune: schedule-exemption lookup failed (${err.message}) — skipping this batch`);
      return null;
    });
    if (scheduled === null) return 0;
    scheduledIds = new Set(scheduled.map(r => r.sessionId));
  }
  // A live or queued run owns its worktree — fail closed (skip the batch) on
  // a lookup error, same posture as the schedule exemption.
  if (idle.length) {
    let liveRunIds: Set<string>;
    try {
      const running = await prisma.agentRun.findMany({
        where: { sessionId: { in: idle.map(c => c.id) }, status: { in: ['queued', 'running'] } },
        select: { sessionId: true },
      });
      liveRunIds = new Set(running.map(r => r.sessionId));
    } catch (err: any) {
      logger.warn(`artifact prune: live-run lookup failed (${err?.message}) — skipping this batch`);
      return 0;
    }
    idle = idle.filter(c => predicate(c, { hasLiveRun: liveRunIds.has(c.id), scheduled: scheduledIds.has(c.id) }));
  }
  idle = idle.slice(0, opts?.take ?? 50);
  let pruned = 0;
  for (const s of idle) {
    try {
      const wt = worktreePath(s.id);
      if (!(await pathExists(wt))) continue;
      // Re-check THIS session right before deleting (a run queued since the
      // batch lookup, or a dev server still running from its node_modules).
      if ((await sessionBusyForReap(s.id)) !== 'idle') {
        if (opts?.stats) opts.stats.keptLive++;
        continue;
      }
      if (await prunePathArtifacts(wt, 0)) pruned++;
    } catch (err: any) {
      logger.warn(`artifact prune: failed for ${s.id}: ${err.message}`);
    }
  }
  if (pruned > 0) logger.info(`artifact prune: cleared reinstallable dirs in ${pruned} idle worktree(s)`);
  return pruned;
}

/** Walk a worktree (bounded depth), rm -rf any REINSTALLABLE dir. Never
 *  descends INTO a matched dir, never follows symlinks, skips .git. */
async function prunePathArtifacts(dir: string, depth: number): Promise<boolean> {
  if (depth > 3) return false;
  let hit = false;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory() || e.isSymbolicLink() || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (REINSTALLABLE_DIRS.has(e.name)) {
      await fs.rm(p, { recursive: true, force: true }).catch(() => {});
      hit = true;
    } else if (await prunePathArtifacts(p, depth + 1)) {
      hit = true;
    }
  }
  return hit;
}

/** Disk snapshot at the workspace root: usage fraction (0..1) + free bytes, or null. */
async function workspaceDiskSnapshot(): Promise<{ usage: number; freeBytes: number } | null> {
  try {
    const st = await (fs as any).statfs(path.dirname(repoMirrorPath('x')));
    if (!st?.blocks) return null;
    const bsize = st.bsize || st.frsize || 0;
    return { usage: 1 - st.bavail / st.blocks, freeBytes: st.bavail * bsize };
  } catch { return null; }
}

/** Disk pressure check: fraction used at the workspace root (0..1), or null. */
export async function workspaceDiskUsage(): Promise<number | null> {
  const snap = await workspaceDiskSnapshot();
  return snap ? snap.usage : null;
}

let reaperTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Orphan env-seed sweep (review 2026-08-20): adminDeleteUser relies on FK
 * cascade and never touches the filesystem, so a deleted user's sessions can
 * leave session-env sidecars (which may hold secrets) on the volume forever.
 * Any sidecar whose session has no chatCodingState row is unlinked. Rides the
 * reaper cadence.
 */
export async function pruneOrphanSessionEnv(): Promise<number> {
  const ids = await listSessionEnvSidecars();
  if (!ids.length) return 0;
  // FAIL-SAFE (review round 2): a failed session lookup must SKIP the sweep,
  // never delete on uncertainty — for already-reaped sessions the sidecar is
  // the ONLY copy of the env seed, so a transient DB error here would
  // mass-delete exactly what this mechanism exists to protect.
  const rows = await prisma.chatCodingState.findMany({
    where: { id: { in: ids } }, select: { id: true },
  }).catch((err: any) => {
    logger.warn(`session-env orphan sweep: session lookup failed (${err.message}) — skipping this pass`);
    return null;
  });
  if (!rows) return 0;
  const live = new Set(rows.map(r => r.id));
  let pruned = 0;
  for (const id of ids) {
    if (live.has(id)) continue;
    await removeSessionEnv(id);
    pruned++;
  }
  if (pruned > 0) logger.info(`session-env orphan sweep: removed ${pruned} sidecar(s) with no live session`);
  return pruned;
}

/**
 * Remove sandbox-home dirs whose owning session row is GONE — the backstop
 * for teardown paths that don't call removeSandboxHome (adminDeleteUser's raw
 * FK cascade) or raced it (PR #359 review F1). Live-set = every
 * chatCodingState id regardless of status: idle/archived sessions keep their
 * durable HOME until the reaper's per-session removal takes it. Runs on the
 * same 6h cadence as the reaper.
 */
export async function pruneOrphanSandboxHomes(): Promise<number> {
  // build 2026-10-08 ISO: the legacy homes root (worktrees/.sandbox-home) plus
  // one per per-user subtree (<key>/.sandbox-home) — the legacy one first, so
  // a volume with no subtrees sweeps exactly as before.
  const legacyRoot = path.join(path.dirname(worktreePath('x')), '.sandbox-home');
  const roots = Array.from(new Set([legacyRoot, ...listSandboxHomeRootsSync()]));
  let pruned = 0;
  for (const root of roots) {
    let ids: string[];
    try {
      ids = (await fs.readdir(root)).filter(n => !n.startsWith('.'));
    } catch { continue; } // no sandbox-home root yet — nothing to sweep
    if (!ids.length) continue;
    const rows = await prisma.chatCodingState.findMany({ where: { id: { in: ids } }, select: { id: true } });
    const live = new Set(rows.map(r => r.id));
    for (const id of ids) {
      if (live.has(id)) continue;
      await fs.rm(path.join(root, id), { recursive: true, force: true }).catch(() => {});
      pruned++;
    }
  }
  if (pruned > 0) logger.info(`sandbox-home orphan sweep: removed ${pruned} home(s) with no live session`);
  return pruned;
}

/**
 * Durable cron: ONE worktree-reaper pass. Adaptive (default): hourly, idle bar
 * shortens with usage, artifact prune at ~6h. Kill switch
 * WORKTREE_DISK_ADAPTIVE_DISABLED=1 restores 7d / 6h / batch 25 / pressure
 * only above 80%. Errors propagate to the caller (the worker's cron loop
 * records them); the legacy in-process startWorktreeReaper catches.
 */
export async function runWorktreeReapOnce(): Promise<void> {
  const before = await workspaceDiskSnapshot();
  const usage = before ? before.usage : null;
  const adaptive = !worktreeDiskAdaptiveDisabled();
  const idle = adaptive ? reapIdleMsForUsage(usage) : REAP_IDLE_MS;
  const exemptShort = adaptive && idle < 7 * DAY_MS;
  const stats: ReapPassStats = { keptUnknown: 0, keptUnsaved: 0, keptLive: 0 };
  const reaped = await reapIdleWorktrees({
    idleMs: idle,
    take: adaptive ? 100 : 25,
    exemptScheduled: exemptShort,
    stats,
  });
  const pruned = await pruneReinstallableArtifacts({
    idleMs: adaptive ? artifactPruneIdleMs() : ARTIFACT_PRUNE_IDLE_MS,
    take: adaptive ? 200 : 50,
    exemptScheduled: adaptive,
    stats,
  });
  await pruneOrphanSessionEnv();
  await pruneOrphanSandboxHomes();
  let pressureReaped = 0;
  let pressurePruned = 0;
  if (diskPressure(usage)) {
    // Under pressure: lower the idle bar (→ 48h), grow the batch, and prune
    // artifacts at 24h idle (dir-mtime co-signal — scheduled lanes exempt).
    pressureReaped = await reapIdleWorktrees({
      idleMs: PRESSURE_IDLE_MS,
      take: adaptive ? 200 : PRESSURE_TAKE,
      reason: 'disk_pressure',
      exemptScheduled: true,
      stats,
    });
    pressurePruned = await pruneReinstallableArtifacts({
      idleMs: 24 * HOUR_MS,
      take: adaptive ? 400 : 200,
      exemptScheduled: true,
      stats,
    });
    const cap = adaptive ? (Number(process.env.WORKTREE_DISK_PRESSURE) > 0 && Number(process.env.WORKTREE_DISK_PRESSURE) < 1
      ? Number(process.env.WORKTREE_DISK_PRESSURE) : 0.70) : DISK_SOFT_CAP;
    logger.warn(
      `worktree reaper: disk at ${((usage ?? 0) * 100).toFixed(0)}% (pressure ${(cap * 100).toFixed(0)}%) — ` +
      `reaped ${reaped}+${pressureReaped} worktrees, artifact-pruned ${pruned}+${pressurePruned} under pressure` +
      (isWorkspaceVolumeOwner() ? '' : ' (NOT the volume owner: local copies only, DB paths untouched)') // Review 2026-09-13 issue 8
    );
  }
  const after = await workspaceDiskSnapshot();
  const bytesFreed = before && after ? Math.max(0, after.freeBytes - before.freeBytes) : 0;
  const worktrees = (await listWorktreeDirsOnDisk().catch(() => null))?.length ?? 0;
  const usageAfter = after ? after.usage : usage;
  try {
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.WORKTREE_REAP_PASS,
      value: bytesFreed,
      meta: {
        worktrees,
        bytesFreed,
        usagePct: usageAfter == null ? null : Math.round(usageAfter * 1000) / 10,
        pruned: pruned + pressurePruned,
        reaped: reaped + pressureReaped,
        adaptive,
        // 2026-10-20: dirs KEPT this pass. keptUnknown/keptUnsaved are never
        // auto-deleted (they may hold the only copy of work) — a rising count
        // here is the signal to inspect them by hand. keptLive = skipped by
        // the per-session live re-check (run queued mid-pass / bg process).
        keptUnknown: stats.keptUnknown,
        keptUnsaved: stats.keptUnsaved,
        keptLive: stats.keptLive,
      },
    });
  } catch { /* telemetry never fails the pass */ }
  if (usageAfter != null && usageAfter > POST_PASS_ALARM) {
    logger.error(
      `worktree reaper: volume still at ${(usageAfter * 100).toFixed(0)}% after a pass ` +
      `(${worktrees} worktrees, ${bytesFreed} bytes freed, reaped ${reaped + pressureReaped}, ` +
      `artifact-pruned ${pruned + pressurePruned}) — above the ${POST_PASS_ALARM * 100}% alarm`
    );
  }
}

/** Start the worktree reaper. Interval is worktreeReapIntervalSec() (default 1h;
 *  WORKTREE_DISK_ADAPTIVE_DISABLED=1 restores 6h). */
export function startWorktreeReaper(): void {
  if (reaperTimer) return;
  const tick = async () => {
    try {
      await runWorktreeReapOnce();
    } catch (err: any) {
      logger.warn(`worktree reaper tick failed: ${err.message}`);
    }
  };
  const intervalSec = worktreeReapIntervalSec();
  reaperTimer = setInterval(tick, intervalSec * 1000);
  reaperTimer.unref?.();
  setTimeout(tick, 5 * 60 * 1000).unref?.();        // first pass 5 min after boot
  logger.info(
    `worktree reaper started (${intervalSec}s interval, ` +
    `${worktreeDiskAdaptiveDisabled() ? '7d idle TTL' : 'disk-adaptive idle'}, blank projects exempt)`
  );
}

async function pathExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}
