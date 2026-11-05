/**
 * Deliverable hand-off (cohesive chat wave, branch C — 2026-09-27).
 *
 * Owner ask: "when someone asks for a task or a subsession or long running
 * session is needed it does it automatically and returns results". The
 * finished work of a coding run used to live only in the sub-session's Files
 * tab (a deck under `deck/*.pdf` on a session branch with no remote) while the
 * parent chat merely NARRATED about it and the sub-session view showed a dry
 * status card with no deliverable.
 *
 * WHAT THIS DOES — deterministically, at run-executor finalize, for every
 * COMPLETED run:
 *   1. collects the run's deliverables:
 *      - FILES the run created or modified under the worktree that match the
 *        deliverable shapes (pdf, pptx, docx, xlsx, csv, png/jpg/svg, html, md,
 *        zip, json — each ≤ DELIVERABLE_MAX_BYTES, at most DELIVERABLE_MAX_FILES;
 *        never node_modules / build dirs / dot-dirs; scaffold files such as
 *        package.json or README.md are not deliverables) — "this run's" =
 *        mtime ≥ the run's start, minus files git says are tracked AND unchanged
 *        against the session's base branch (a rebase-touched README is not a
 *        deliverable; a gitignored PDF the run wrote still is);
 *      - PULL REQUESTS it opened (ok:true `open_pull_request` receipts);
 *      - CANVASES it created on the session chat (rows since the run start);
 *   2. copies the files into the TARGET chat as durable chat uploads (the
 *      existing ChatFile path — `persistChatUploads`, so the transcript renders
 *      `[name](/api/crossmodel/files/<id>/download)` as the file card the UI
 *      already knows), copies canvases onto the target chat, and
 *   3. posts ONE result message on the target chat: the child's final summary
 *      head + the artifacts list with links, stamped `metadata.kind =
 *      'deliverable_handoff'` with the artifacts and the shared TASK payload
 *      (status 'done'), and emits the `task` event with the same artifacts.
 *
 * TARGET = the session's parent chat (a child spawned by start_coding_session
 * from a chat, same owner) — or the session chat itself for a top-level session
 * (no parent ⇒ the result message with links lands on the session chat).
 * The child's own status card carries the same Result line (session-status
 * reads the stored record — `latestDeliverableHandoff`).
 *
 * WHERE IT RUNS: the executor finalize runs on the box that HOSTS the worktree
 * (the coding worker claims the run), so the walk + reads are local disk. When
 * the worktree is NOT on this box (a 0-slot worker finalizing a foreign row)
 * the walk is empty and the run hands off PRs / canvases only — the Redis
 * request/reply read (worktree-remote-read.ts) is text-only and 256 KB-capped,
 * so binaries could not ride it anyway; named honestly in the metric.
 *
 * IDEMPOTENT per run: an atomic store claim ([deliverable-handoff, sessionId] /
 * runId) guards the post — a re-finalize never double-posts; a failure BEFORE
 * the post releases the claim so a retry can post. FAIL OPEN: never throws
 * into finalize; bounded by HANDOFF_TIMEOUT_MS.
 *
 * WHEN IT POSTS — gated on LINEAGE, not on the firing origin (review fix,
 * same day): a session whose parent is a HUMAN-asked chat (not a Fleet /
 * Project Supervisor) hands off EVERY completed run that produced ≥ 1
 * artifact, whatever fired it — the deck finished in run 2+ by a
 * [HARNESS CONTINUATION] or a schedule firing is exactly the case the owner
 * asked for ("longer than a turn ⇒ continues in the background and the
 * result is posted"). A summary-only result (no artifacts) still reaches the
 * PARENT only for a human-typed run or the child's FIRST completed run (the
 * spawn prompt's run). A SUPERVISOR-parented lane (Fleet / Project Supervisor
 * spawned it) is SKIPPED by default: supervisors already receive the
 * run_completed hook, and a Result row + file copies per lane run would be a
 * new machine-lane surface on the supervisor chat (opt in with
 * DELIVERABLE_HANDOFF_SUPERVISOR_PARENTS=1). DELIVERABLE_HANDOFF_ORIGIN_GATE=1
 * restores the first cut's firing-origin gate (schedule / hook runs skipped
 * unless DELIVERABLE_HANDOFF_ALL_ORIGINS=1).
 *
 * WHAT IS A CHANGE, NOT A DELIVERABLE: a repo-text shape (md json html csv
 * svg) that EXISTED on the session's base branch and the run modified is a
 * code/docs change (a results log, a README section, an index.html) — it
 * ships as a PR, never as a file copy; only NEW files of those shapes are
 * deliverables. Binary / office shapes (pdf pptx docx xlsx zip png jpg) are
 * deliverables whether or not git knew them.
 *
 * MEMORY / VOLUME: files are read → persisted → released ONE AT A TIME (never
 * accumulated as base64), under a per-run total budget
 * DELIVERABLE_MAX_TOTAL_BYTES (50 MB default) on top of the per-file cap, and
 * the whole hand-off carries the finalize deadline as an AbortSignal — the
 * walk, the git calls, the reads and the per-file loop all stop when the
 * 20 s budget expires (a timed-out hand-off no longer keeps running in the
 * background holding buffers on a 32-slot worker).
 *
 * HOOK SEAM: when a hand-off posted, `handoffHookNote(result)` is appended to
 * the run_completed hook summary so the parent's child-result wake (and any
 * project-scope hook) knows the deliverables ALREADY landed as message
 * <resultMessageId> and acknowledges instead of re-posting / re-staging them.
 * The result row is stamped
 * `metadata.origin 'deliverable_handoff'` so history builders and the
 * frontend can group it as a harness row (it stays VISIBLE — the origin is
 * in no machine-noise set) rather than the model's own words.
 *
 * CONTENT DEDUPE + PER-CHAT BUDGET (hand-off polish 2026-09-28, audit CT-1 —
 * one top-level lane re-copied the SAME four untracked JSON files into its
 * own chat on every scheduled run: 11 identical copies, 185 MB of bytea in
 * 11 h, because "this run's" files are picked by mtime and the upload id was
 * keyed by RUN): the upload id is now keyed by CONTENT —
 * `dh_<sha1(rel:sha1(bytes))>` — so the (uploadId, chatId) ChatFile key
 * dedupes across runs; a file whose bytes already sit on the target is
 * LINKED (the existing row) instead of persisted again and the Result row
 * says "unchanged since the last hand-off"; a run whose every file is
 * unchanged with no PR / canvas on a top-level self-target posts NOTHING
 * (metric `skipped:'unchanged'`). A per-chat ledger (store
 * [deliverable-handoff, <targetChatId>] / ledger — rel → {sha1, uploadId,
 * runId, postedAt}) records what was handed off last, and a per-chat total
 * budget over every hand-off copy on the target (HANDOFF_CHAT_TOTAL_BYTES,
 * 200 MB) prunes the OLDEST copies that are not this run's (their older
 * Result-row links go dead; the row says how many were pruned).
 *
 * RESULT ROW (audit CT-3 / E17 / DOI-09): leads with the artifacts list,
 * then a ONE-PARAGRAPH summary with the child's absolute worktree paths
 * reduced to file names, markdown headings and "(absolute path)" /
 * "worktree" parentheticals dropped (`scrubSummary`).
 *
 * Caps DELIVERABLE_MAX_FILES /
 * DELIVERABLE_MAX_BYTES / DELIVERABLE_MAX_TOTAL_BYTES; telemetry loop_metrics
 * `deliverable_handoff` {runId, parentChatId, targetChatId, files, prs,
 * canvases, bytes, deduped, pruned, skipped, …}.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import logger from '../../../utils/logger';
import type { ToolReceipt } from './run-receipts';
import type { TaskArtifact, TaskEventPayload } from '../chat-agent/task-events';
import { taskIdForSession } from '../chat-agent/task-ids';
import type { LoadedUpload } from '../chat-files.service';
import { sniffMime } from './chat-images';

// ── Switches + caps ──────────────────────────────────────────────────────────

export const DELIVERABLE_HANDOFF_ALL_ORIGINS_ENV = 'DELIVERABLE_HANDOFF_ALL_ORIGINS';
/** =1 restores the first cut's FIRING-ORIGIN gate (schedule / hook runs skipped unless ALL_ORIGINS). Default: the lineage gate. */
export const DELIVERABLE_HANDOFF_ORIGIN_GATE_ENV = 'DELIVERABLE_HANDOFF_ORIGIN_GATE';
/** =1 also hands off into a Fleet / Project Supervisor parent (default: skipped — supervisors get the run_completed hook). */
export const DELIVERABLE_HANDOFF_SUPERVISOR_PARENTS_ENV = 'DELIVERABLE_HANDOFF_SUPERVISOR_PARENTS';
export const DELIVERABLE_MAX_FILES_ENV = 'DELIVERABLE_MAX_FILES';
export const DELIVERABLE_MAX_BYTES_ENV = 'DELIVERABLE_MAX_BYTES';
export const DELIVERABLE_MAX_TOTAL_BYTES_ENV = 'DELIVERABLE_MAX_TOTAL_BYTES';

export const DELIVERABLE_MAX_FILES_DEFAULT = 12;
/** Per-file cap; the durable ChatFile row caps at 25 MB too (chat-files.service). */
export const DELIVERABLE_MAX_BYTES_DEFAULT = 25 * 1024 * 1024;
export const DELIVERABLE_MAX_BYTES_CEILING = 25 * 1024 * 1024;
/** Per-RUN total budget across every file copied (newest kept) — bounds worker memory + RDS bytea volume per finalize. */
export const DELIVERABLE_MAX_TOTAL_BYTES_DEFAULT = 50 * 1024 * 1024;
/** Whole hand-off budget (walk + reads + persists + post) — finalize waits at most this long, and the work STOPS at it. */
export const HANDOFF_TIMEOUT_MS = 20_000;
/** A file whose mtime is within this slack BEFORE the run start still counts (clock skew, write-before-claim). */
export const DELIVERABLE_MTIME_SLACK_MS = 5_000;
/** Walk bounds so a pathological worktree can't stall finalize. */
export const DELIVERABLE_WALK_MAX_ENTRIES = 20_000;
export const DELIVERABLE_WALK_MAX_DEPTH = 10;
/** Result message: how much of the child's final answer rides the head. */
export const RESULT_SUMMARY_MAX_CHARS = 700;
export const HANDOFF_STORE_NS = 'deliverable-handoff';
export const HANDOFF_LATEST_KEY = 'latest';
export const HANDOFF_MESSAGE_KIND = 'deliverable_handoff';
/** metadata.origin of the result row — a harness stamp in NO machine-noise set (the row stays visible). */
export const HANDOFF_MESSAGE_ORIGIN = 'deliverable_handoff';

export function deliverableHandoffAllOrigins(): boolean {
  return process.env[DELIVERABLE_HANDOFF_ALL_ORIGINS_ENV] === '1';
}

export function deliverableHandoffOriginGateArmed(): boolean {
  return process.env[DELIVERABLE_HANDOFF_ORIGIN_GATE_ENV] === '1';
}

export function deliverableHandoffSupervisorParents(): boolean {
  return process.env[DELIVERABLE_HANDOFF_SUPERVISOR_PARENTS_ENV] === '1';
}

// ── Hand-off polish (2026-09-28, audit CT-1 / CT-3) ─────────────────────────

/** Per-CHAT total budget over every hand-off copy on the target (the oldest not of this run are pruned past it). */
export const HANDOFF_CHAT_TOTAL_BYTES_ENV = 'HANDOFF_CHAT_TOTAL_BYTES';
export const HANDOFF_CHAT_TOTAL_BYTES_DEFAULT = 200 * 1024 * 1024;
/** Store key of the per-target ledger ([deliverable-handoff, <targetChatId>] / ledger). */
export const HANDOFF_LEDGER_KEY = 'ledger';

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function deliverableMaxFiles(): number {
  return positiveIntEnv(DELIVERABLE_MAX_FILES_ENV, DELIVERABLE_MAX_FILES_DEFAULT);
}

/** Never above the ChatFile persistence cap — a larger value would persist nothing. */
export function deliverableMaxBytes(): number {
  return Math.min(positiveIntEnv(DELIVERABLE_MAX_BYTES_ENV, DELIVERABLE_MAX_BYTES_DEFAULT), DELIVERABLE_MAX_BYTES_CEILING);
}

export function deliverableMaxTotalBytes(): number {
  return positiveIntEnv(DELIVERABLE_MAX_TOTAL_BYTES_ENV, DELIVERABLE_MAX_TOTAL_BYTES_DEFAULT);
}

export function handoffChatTotalBytes(): number {
  return positiveIntEnv(HANDOFF_CHAT_TOTAL_BYTES_ENV, HANDOFF_CHAT_TOTAL_BYTES_DEFAULT);
}

// ── Deliverable shapes (pure) ───────────────────────────────────────────────

/** Extension → served mime. The set IS the deliverable-shape allowlist. */
export const DELIVERABLE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.pdf': 'application/pdf',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.html': 'text/html',
  '.md': 'text/markdown',
  '.zip': 'application/zip',
  '.json': 'application/json',
};

/**
 * REPO-TEXT shapes: a file of this shape that existed on the session's base
 * branch and the run MODIFIED is a code / docs change (results log, README
 * section, index.html, a data csv) — it rides the PR, never a file copy. Only
 * NEW files of these shapes are deliverables. Binary / office shapes are
 * deliverables whether or not git knew them.
 */
export const DELIVERABLE_REPO_TEXT_EXTS: ReadonlySet<string> = new Set(['.md', '.json', '.html', '.csv', '.svg']);

/** Directories never walked (build output, dependencies, caches, VCS). Dot-directories are skipped too. */
export const DELIVERABLE_EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', 'target', 'vendor', 'tmp', 'temp',
  '__pycache__', 'venv', 'site-packages', 'bower_components', 'Pods', 'DerivedData',
]);

/** Scaffold / repo-plumbing basenames (lower-cased) that match a shape but are never a deliverable. */
export const DELIVERABLE_EXCLUDED_NAMES: ReadonlySet<string> = new Set([
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'composer.json', 'composer.lock',
  'readme.md', 'changelog.md', 'contributing.md', 'license.md', 'code_of_conduct.md', 'security.md',
  'claude.md', 'agents.md', 'pull_request_template.md', 'renovate.json', 'lerna.json', 'nx.json',
  '.eslintrc.json', '.prettierrc.json', 'jest.config.json', 'vercel.json', 'manifest.json',
]);
const SCAFFOLD_NAME_RE = /^(tsconfig(\..+)?\.json|tsconfig\.json|\.?babelrc(\.json)?|\.?eslintrc(\.json)?)$/i;

export interface WorktreeFileEntry {
  /** Worktree-relative POSIX path. */
  rel: string;
  bytes: number;
  mtimeMs: number;
}

export function deliverableExt(rel: string): string {
  const m = rel.match(/\.[A-Za-z0-9]+$/);
  return m ? m[0].toLowerCase() : '';
}

/** True iff `rel` has a deliverable shape and lives outside excluded / dot / scaffold territory. */
export function isDeliverablePath(rel: string): boolean {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || rel.includes('\\')) return false;
  const segs = rel.split('/').filter(Boolean);
  if (!segs.length || segs.some((s) => s === '.' || s === '..')) return false;
  const dirs = segs.slice(0, -1);
  if (dirs.some((d) => d.startsWith('.') || DELIVERABLE_EXCLUDED_DIRS.has(d))) return false;
  const base = segs[segs.length - 1];
  if (base.startsWith('.')) return false;
  const ext = deliverableExt(base);
  if (!ext || !DELIVERABLE_MIME_BY_EXT[ext]) return false;
  const lower = base.toLowerCase();
  if (DELIVERABLE_EXCLUDED_NAMES.has(lower) || SCAFFOLD_NAME_RE.test(base)) return false;
  return true;
}

export interface DeliverableSelection {
  files: WorktreeFileEntry[];
  /** Deliverable-shaped files changed this run but over the per-file cap. */
  skippedTooLarge: number;
  /** Deliverable-shaped files changed this run beyond the file cap (newest kept). */
  truncated: number;
  /** Deliverable-shaped files under the file cap that did not fit the per-run total budget (newest kept). */
  skippedOverBudget: number;
  /** Repo-text shapes (md json html csv svg) the run MODIFIED on a pre-existing path — a change, not a deliverable. */
  treatedAsChange: number;
  /** Deliverable-shaped files changed this run before caps. */
  candidates: number;
}

/**
 * Pick this run's deliverables from a worktree listing. Pure: mtime ≥ run start
 * (minus slack), not in `excludePaths` (git: tracked AND unchanged), not a
 * repo-text shape on a `preexistingPaths` path (git: existed on the base
 * branch — a modified README / results log / index.html is a change), shape +
 * location rules, per-file byte cap, then the NEWEST `maxFiles` kept, the
 * NEWEST that fit `maxTotalBytes` kept, returned in path order (stable display).
 */
export function selectDeliverables(
  entries: readonly WorktreeFileEntry[],
  opts: {
    runStartedMs: number; maxFiles?: number; maxBytes?: number; maxTotalBytes?: number;
    excludePaths?: ReadonlySet<string>; preexistingPaths?: ReadonlySet<string>;
  },
): DeliverableSelection {
  const maxFiles = Math.max(1, Math.floor(opts.maxFiles ?? deliverableMaxFiles()));
  const maxBytes = Math.max(1, Math.floor(opts.maxBytes ?? deliverableMaxBytes()));
  const maxTotalBytes = Math.max(1, Math.floor(opts.maxTotalBytes ?? deliverableMaxTotalBytes()));
  const floor = opts.runStartedMs - DELIVERABLE_MTIME_SLACK_MS;
  const candidates: WorktreeFileEntry[] = [];
  let skippedTooLarge = 0;
  let treatedAsChange = 0;
  for (const e of entries) {
    if (!e || typeof e.rel !== 'string') continue;
    if (!Number.isFinite(e.mtimeMs) || e.mtimeMs < floor) continue;
    if (opts.excludePaths?.has(e.rel)) continue;
    if (!isDeliverablePath(e.rel)) continue;
    if (opts.preexistingPaths?.has(e.rel) && DELIVERABLE_REPO_TEXT_EXTS.has(deliverableExt(e.rel))) { treatedAsChange++; continue; }
    if (!Number.isFinite(e.bytes) || e.bytes <= 0) continue;
    if (e.bytes > maxBytes) { skippedTooLarge++; continue; }
    candidates.push(e);
  }
  const newestFirst = candidates.slice().sort((a, b) => b.mtimeMs - a.mtimeMs || a.rel.localeCompare(b.rel));
  const underFileCap = newestFirst.slice(0, maxFiles);
  const fit: WorktreeFileEntry[] = [];
  let total = 0;
  let skippedOverBudget = 0;
  for (const e of underFileCap) {
    if (total + e.bytes > maxTotalBytes) { skippedOverBudget++; continue; }
    total += e.bytes;
    fit.push(e);
  }
  const kept = fit.sort((a, b) => a.rel.localeCompare(b.rel));
  return {
    files: kept, skippedTooLarge, skippedOverBudget, treatedAsChange,
    truncated: Math.max(0, candidates.length - underFileCap.length), candidates: candidates.length,
  };
}

/** ok:true open_pull_request receipts → {prNumber, url}, deduped by number, in receipt order. */
export function prsFromReceipts(receipts: readonly ToolReceipt[] | null | undefined): Array<{ prNumber: number; url: string }> {
  const out: Array<{ prNumber: number; url: string }> = [];
  const seen = new Set<number>();
  for (const r of receipts ?? []) {
    if (!r || r.tool !== 'open_pull_request' || !r.ok) continue;
    const n = Number((r.ids as any)?.prNumber);
    const url = String((r.ids as any)?.url ?? '');
    if (!Number.isFinite(n) || n <= 0 || seen.has(n)) continue;
    seen.add(n);
    out.push({ prNumber: n, url });
  }
  return out;
}

/** Served mime for a deliverable: magic bytes for binaries, else the extension. */
export function deliverableMime(rel: string, buf: Buffer | null): string {
  const byExt = DELIVERABLE_MIME_BY_EXT[deliverableExt(rel)];
  if (buf && buf.length) {
    const sniffed = sniffMime(buf.subarray(0, 16));
    // The zip magic covers pptx/docx/xlsx too — keep the richer extension type.
    if (sniffed && !/zip/i.test(sniffed)) return sniffed;
  }
  return byExt || 'application/octet-stream';
}

/** sha1 hex of a file's bytes — the content identity behind the dedupe. */
export function contentSha1(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}

/**
 * CONTENT-keyed upload id for (path, bytes): the same file with the same bytes
 * on the same target chat is ONE ChatFile row whatever run wrote it (the
 * (uploadId, chatId) unique key). Same `dh_` prefix as the original run-keyed
 * id so every audit that counts hand-off uploads by prefix keeps working.
 */
export function deliverableContentUploadId(rel: string, sha1: string): string {
  return `dh_${createHash('sha1').update(`${rel}:${sha1}`).digest('hex').slice(0, 32)}`;
}

export function chatFileDownloadUrl(fileId: string): string {
  return `/api/crossmodel/files/${fileId}/download`;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The child's final answer head: first RESULT_SUMMARY_MAX_CHARS, whitespace-normalised, cut on a sentence when possible. */
export function summaryHead(finalText: string | null | undefined, max = RESULT_SUMMARY_MAX_CHARS): string {
  const text = String(finalText ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) return '';
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastBreak = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
  return `${(lastBreak > max * 0.5 ? cut.slice(0, lastBreak + 1) : cut).trimEnd()} …`;
}

/** Container / box roots a child names in its final — never meaningful to the chat that asked. */
const INTERNAL_PATH_ROOT_RE = /\/(?:app|opt|home|tmp|var|srv|workspace|workspaces|mnt|Users)\/[^\s`'")\]]*/g;
/** "(absolute path)", "(worktree path)", "(in the worktree)" … — parentheticals that only make sense beside a container path. */
const PATH_PARENTHETICAL_RE = /\s*\((?:[^()]*\b(?:absolute path|worktree|work tree|container path|on disk|local path)\b[^()]*)\)/gi;

/**
 * Hand-off polish (2026-09-28, audit CT-3): the child's final often LEADS
 * with `/app/coding-workspaces/worktrees/<id>/deck.pdf (absolute path)` under
 * a `## Result` heading — noise to a plain-chat user whose Deliverables list
 * already carries the download link. Pure: drops markdown heading lines,
 * reduces every absolute path under the worktree root (or a container /
 * box root) to its basename, deletes the path parentheticals, unwraps the
 * leftover empty code spans, collapses whitespace into ONE paragraph.
 * '' in ⇒ '' out; never throws.
 */
export function scrubSummary(text: string | null | undefined, opts: { worktreeRoot?: string | null } = {}): string {
  let s = String(text ?? '').replace(/\r\n/g, '\n');
  if (!s.trim()) return '';
  // headings + horizontal rules go (the summary is one paragraph under a title of its own)
  s = s.split('\n').filter((line) => !/^\s*(#{1,6}\s|-{3,}\s*$|\*{3,}\s*$)/.test(line)).join('\n');
  const root = String(opts.worktreeRoot ?? '').replace(/\/+$/, '');
  const basename = (p: string): string => {
    const clean = p.replace(/[.,;:!?]+$/, '');
    const trail = p.slice(clean.length);
    const base = clean.split('/').filter(Boolean).pop() ?? '';
    return `${base}${trail}`;
  };
  if (root) {
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp(`${escaped}(?:/[^\\s\`'")\\]]*)?`, 'g'), (m) => (m === root ? 'the session workspace' : basename(m)));
  }
  s = s.replace(INTERNAL_PATH_ROOT_RE, (m) => basename(m));
  s = s.replace(PATH_PARENTHETICAL_RE, '');
  // "**PDF (absolute path):**" style labels lose their parenthetical above; drop a now-empty bold label "****"
  s = s.replace(/\*\*\s*\*\*/g, '');
  s = s.replace(/``/g, '');
  return s.replace(/\s+/g, ' ').trim();
}

// ── Result message (pure) ───────────────────────────────────────────────────

export interface ResultMessageInput {
  sessionTitle: string;
  sessionId: string;
  runId: string;
  summary: string;
  artifacts: readonly TaskArtifact[];
  /** True when the message lands on the PARENT chat (the "from session" footer appears). */
  targetIsParent: boolean;
  skippedTooLarge?: number;
  truncated?: number;
  skippedOverBudget?: number;
  /** File artifact names whose bytes were ALREADY on the target (linked, not re-copied) — "unchanged since the last hand-off". */
  unchanged?: readonly string[];
  /** Older hand-off copies deleted from the target to stay under the per-chat budget. */
  pruned?: number;
}

/** Deliverables first, then the scrubbed one-paragraph summary. */
export function buildResultMessage(input: ResultMessageInput): string {
  const title = String(input.sessionTitle || 'Task').replace(/\s+/g, ' ').trim().slice(0, 120);
  const lines: string[] = [`**Result: ${title}**`];
  const files = input.artifacts.filter((a) => a.kind === 'file');
  const prs = input.artifacts.filter((a) => a.kind === 'pr');
  const canvases = input.artifacts.filter((a) => a.kind === 'canvas');
  const unchanged = new Set(input.unchanged ?? []);
  if (input.artifacts.length) {
    lines.push('', '**Deliverables**');
    for (const f of files) lines.push(`- [${f.name}](${f.url ?? ''}) (${formatBytes(f.bytes ?? 0)})${unchanged.has(f.name) ? ' — unchanged since the last hand-off' : ''}`);
    for (const p of prs) lines.push(p.url ? `- [${p.name}](${p.url})` : `- ${p.name}`);
    for (const c of canvases) lines.push(`- Canvas "${c.name}" — open it from this chat's canvas panel`);
  } else {
    lines.push('', '_This run produced no files, pull requests or canvases._');
  }
  if (input.summary) lines.push('', input.summary);
  const notes: string[] = [];
  if (input.skippedTooLarge) notes.push(`${input.skippedTooLarge} file${input.skippedTooLarge === 1 ? '' : 's'} over the size cap stayed in the session's Files tab`);
  if (input.skippedOverBudget) notes.push(`${input.skippedOverBudget} file${input.skippedOverBudget === 1 ? '' : 's'} over this run's total budget stayed in the session's Files tab`);
  if (input.truncated) notes.push(`${input.truncated} more changed file${input.truncated === 1 ? '' : 's'} in the session's Files tab`);
  if (input.pruned) notes.push(`${input.pruned} older hand-off cop${input.pruned === 1 ? 'y was' : 'ies were'} removed to stay under this chat's hand-off budget (their earlier links no longer download)`);
  if (notes.length) lines.push('', `_${notes.join('; ')}._`);
  if (input.targetIsParent) lines.push('', `_From session ${input.sessionId.slice(0, 8)} · run ${input.runId.slice(0, 8)}_`);
  return lines.join('\n');
}

// ── Disk walk + git exclusion (default deps) ────────────────────────────────

/** Bounded, symlink-free walk of a worktree → {rel, bytes, mtimeMs} for regular files. Never throws; stops at `signal`. */
export async function walkWorktree(root: string, opts?: { maxEntries?: number; maxDepth?: number; signal?: AbortSignal }): Promise<WorktreeFileEntry[]> {
  const maxEntries = opts?.maxEntries ?? DELIVERABLE_WALK_MAX_ENTRIES;
  const maxDepth = opts?.maxDepth ?? DELIVERABLE_WALK_MAX_DEPTH;
  const signal = opts?.signal;
  const out: WorktreeFileEntry[] = [];
  let seen = 0;
  const visit = async (dirRel: string, depth: number): Promise<void> => {
    if (depth > maxDepth || seen >= maxEntries || signal?.aborted) return;
    let dirents: import('fs').Dirent[];
    try { dirents = await fs.readdir(path.join(root, dirRel), { withFileTypes: true }); } catch { return; }
    for (const d of dirents) {
      if (seen++ >= maxEntries || signal?.aborted) return;
      const name = d.name;
      const rel = dirRel ? `${dirRel}/${name}` : name;
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) {
        if (name.startsWith('.') || DELIVERABLE_EXCLUDED_DIRS.has(name)) continue;
        await visit(rel, depth + 1);
        continue;
      }
      if (!d.isFile()) continue;
      if (!isDeliverablePath(rel)) continue; // stat only what can matter
      try {
        const st = await fs.stat(path.join(root, rel));
        if (st.isFile()) out.push({ rel, bytes: st.size, mtimeMs: st.mtimeMs });
      } catch { /* vanished mid-walk */ }
    }
  };
  try {
    const st = await fs.stat(root);
    if (!st.isDirectory()) return [];
  } catch { return []; }
  await visit('', 0);
  return out;
}

const GIT_TIMEOUT_MS = 15_000;
function git(root: string, args: string[], signal?: AbortSignal): Promise<string | null> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(null); return; }
    try {
      execFile('git', ['-C', root, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, ...(signal ? { signal } : {}) }, (err, stdout) => {
        resolve(err ? null : String(stdout ?? ''));
      });
    } catch { resolve(null); }
  });
}

/** What git says about the worktree's paths — see `gitPathClasses`. */
export interface GitPathClasses {
  /** TRACKED and UNCHANGED (not in the base…HEAD diff, not modified / untracked in the working tree). */
  unchanged: ReadonlySet<string>;
  /**
   * Paths that EXISTED before this session's work: on the merge-base with the
   * base branch when one is known, else tracked paths the working tree
   * modified. A repo-text shape here is a change, not a deliverable.
   */
  preexisting: ReadonlySet<string>;
  /** The ref the diff / merge-base were taken against (audit 2026-10-06 T7-3): `origin/<base>` when it resolves, else the bare base. */
  baseRef?: string | null;
}

/** HANDOFF_CARD_FACTS_DISABLED=1 — the task card's pre-T7-4 title (run-start) + steps 0/0. Read per call. */
export function handoffCardFactsDisabled(): boolean {
  const v = String(process.env.HANDOFF_CARD_FACTS_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/** Stock titles a session carries before its real one is generated (never a card title). */
const PLACEHOLDER_TITLE_RE = /^\s*(?:new (?:chat|session|coding session)|untitled(?: chat| session)?|task)\s*$/i;

/** The task card / Result row title: the run-start title unless it is a stock placeholder, then the fresh chat title, else "Task". Pure. */
export function handoffTitle(runStartTitle: string | null | undefined, freshChatTitle: string | null | undefined): string {
  for (const t of [runStartTitle, freshChatTitle]) {
    const v = String(t ?? '').trim();
    if (v && !PLACEHOLDER_TITLE_RE.test(v)) return v;
  }
  return 'Task';
}

/** DELIVERABLE_ORIGIN_BASE_DISABLED=1 — diff against the mirror's LOCAL base branch again (pre-T7-3). Read per call. */
export function deliverableOriginBaseDisabled(): boolean {
  const v = String(process.env.DELIVERABLE_ORIGIN_BASE_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/**
 * Paths git knows are TRACKED and UNCHANGED (not in the base…HEAD diff, not
 * modified/untracked in the working tree) — those are never this run's
 * deliverables even when a checkout/rebase refreshed their mtime — plus the
 * paths that PRE-EXISTED the session (on the merge-base with the base branch).
 * null when git is unavailable (then the mtime rule alone decides). Never
 * throws; every call stops at `signal`.
 */
export async function gitPathClasses(root: string, baseBranch: string | null | undefined, signal?: AbortSignal): Promise<GitPathClasses | null> {
  const tracked = await git(root, ['ls-files', '-z'], signal);
  if (tracked === null) return null;
  const changed = new Set<string>();
  const modified = new Set<string>();
  const status = await git(root, ['status', '--porcelain', '-z', '--untracked-files=all'], signal);
  if (status === null) return null;
  for (const line of status.split('\0')) {
    if (line.length < 4) continue;
    // "XY path" (renames carry "XY new\0old" — the next \0 field is the old path; both count as changed)
    const p = line.slice(3);
    changed.add(p);
    // M in either column = a tracked file the working tree modified (never an added / untracked one)
    if (line[0] === 'M' || line[1] === 'M') modified.add(p);
  }
  const preexisting = new Set<string>();
  let baseRef: string | null = null;
  if (baseBranch) {
    // audit 2026-10-06 T7-3 (spark.md #1): worktrees branch from
    // `origin/<base>` (workspace.service), but fetches only ever move
    // origin/<base> — the bare mirror's LOCAL <base> stays at clone time, so
    // `<base>...HEAD` counted every commit landed on origin since the clone as
    // this run's change (~250 untouched docs posted as "Deliverables"). Diff
    // against the ref the worktree actually branched from; the bare name only
    // when origin/<base> does not resolve (a local-provider mirror has no
    // remote). Kill switch DELIVERABLE_ORIGIN_BASE_DISABLED=1.
    baseRef = baseBranch;
    if (!deliverableOriginBaseDisabled()) {
      const originRef = `origin/${baseBranch}`;
      const ok = await git(root, ['rev-parse', '--verify', '--quiet', `${originRef}^{commit}`], signal);
      if (ok !== null && ok.trim()) baseRef = originRef;
    }
    const diff = await git(root, ['diff', '--name-only', '-z', `${baseRef}...HEAD`], signal);
    if (diff !== null) for (const p of diff.split('\0')) if (p) changed.add(p);
    const mergeBase = (await git(root, ['merge-base', baseRef, 'HEAD'], signal))?.trim() || baseRef;
    const atBase = await git(root, ['ls-tree', '-r', '--name-only', '-z', mergeBase], signal);
    if (atBase !== null) for (const p of atBase.split('\0')) if (p) preexisting.add(p);
  }
  const trackedSet = new Set<string>();
  for (const p of tracked.split('\0')) if (p) trackedSet.add(p);
  if (!baseBranch) for (const p of modified) if (trackedSet.has(p)) preexisting.add(p);
  const unchanged = new Set<string>();
  for (const p of trackedSet) if (!changed.has(p)) unchanged.add(p);
  return { unchanged, preexisting, baseRef };
}

/** Back-compat: the TRACKED-and-UNCHANGED set alone (see `gitPathClasses`). */
export async function gitTrackedUnchangedPaths(root: string, baseBranch: string | null | undefined, signal?: AbortSignal): Promise<ReadonlySet<string> | null> {
  const classes = await gitPathClasses(root, baseBranch, signal);
  return classes ? classes.unchanged : null;
}

// ── Orchestration ───────────────────────────────────────────────────────────

export interface HandoffInput {
  runId: string;
  sessionId: string;
  userId: string;
  worktreeRoot: string | null | undefined;
  baseBranch?: string | null;
  runStartedAt: Date;
  /** The ACCEPTED final answer (post evidence guard) — its head rides the result message. */
  finalText: string | null | undefined;
  sessionTitle: string | null | undefined;
  triggerKind: 'user' | 'schedule' | 'hook' | 'machine';
  /** Whole-session spend if the caller knows it (rides the task payload). */
  spendUsd?: number | null;
  /** audit 2026-10-06 T7-4: the run's plan progress (completed / total steps) for the task card; absent = 0/0 (pre-fix). */
  steps?: { done: number; total: number } | null;
  /** Lazy variant of `steps` — called only when the hand-off posts (no plan read for a run that posts nothing). */
  loadSteps?: () => Promise<{ done: number; total: number } | null>;
  now?: Date;
  /** The finalize deadline: the walk, git calls, reads and the per-file loop stop when it fires. */
  signal?: AbortSignal;
}

export interface HandoffCanvas { id: string; title: string; type: string; language: string | null; content: string }

export interface HandoffChat {
  id: string;
  userId: string;
  parentChatId: string | null;
  title: string;
  /** The owner's Fleet Supervisor chat. */
  isSupervisor?: boolean;
  /** A project's dedicated supervisor chat. */
  isProjectSupervisor?: boolean;
}

export function isSupervisorClassChat(chat: Pick<HandoffChat, 'isSupervisor' | 'isProjectSupervisor'> | null | undefined): boolean {
  return !!chat && (chat.isSupervisor === true || chat.isProjectSupervisor === true);
}

export interface HandoffDeps {
  findChat(id: string): Promise<HandoffChat | null>;
  countCompletedRuns(sessionId: string): Promise<number>;
  getRunReceipts(runId: string): Promise<ToolReceipt[]>;
  listWorktree(root: string, signal?: AbortSignal): Promise<WorktreeFileEntry[]>;
  gitClasses(root: string, baseBranch: string | null | undefined, signal?: AbortSignal): Promise<GitPathClasses | null>;
  readFile(root: string, rel: string, signal?: AbortSignal): Promise<Buffer | null>;
  listCanvases(chatId: string, since: Date): Promise<HandoffCanvas[]>;
  copyCanvas(targetChatId: string, userId: string, canvas: HandoffCanvas): Promise<{ id: string } | null>;
  persistFiles(targetChatId: string, userId: string, loaded: LoadedUpload[]): Promise<void>;
  findChatFiles(targetChatId: string, uploadIds: string[]): Promise<Array<{ id: string; uploadId: string | null; sizeBytes: number }>>;
  appendMessage(targetChatId: string, content: string, metadata: Record<string, unknown>): Promise<{ id: string } | null>;
  claim(sessionId: string, runId: string): Promise<boolean>;
  releaseClaim(sessionId: string, runId: string): Promise<void>;
  saveRecord(sessionId: string, record: HandoffRecord): Promise<void>;
  emitTask(chatId: string, payload: TaskEventPayload): void;
  persistTaskCard(chatId: string, payload: TaskEventPayload, opts?: { messageId?: string; preferCarrier?: boolean }): Promise<unknown>;
  recordMetric(input: { kind: string; sessionId?: string; runId?: string; value?: number; meta?: Record<string, unknown> }): void;
  // ── Hand-off polish (CT-1) — OPTIONAL: absent ⇒ dedupe rides findChatFiles alone, no ledger, no pruning. ──
  /** The per-target ledger (rel → last hand-off of that path); null when none. */
  loadLedger?(targetChatId: string): Promise<HandoffLedger | null>;
  saveLedger?(targetChatId: string, ledger: HandoffLedger): Promise<void>;
  /** Every hand-off copy (uploadId dh_…) on the target, OLDEST first. */
  listHandoffFiles?(targetChatId: string): Promise<Array<{ id: string; uploadId: string | null; sizeBytes: number; createdAt: Date }>>;
  deleteChatFiles?(targetChatId: string, fileIds: string[]): Promise<number>;
}

/** What the target chat was last handed for each path (store [deliverable-handoff, <targetChatId>] / ledger). */
export interface HandoffLedgerEntry {
  sha1: string;
  uploadId: string;
  bytes: number;
  runId: string;
  sessionId: string;
  postedAt: string;
}

export interface HandoffLedger {
  version: 1;
  files: Record<string, HandoffLedgerEntry>;
}

/** Keep the ledger bounded: at most this many paths (the oldest postedAt dropped past it). */
export const HANDOFF_LEDGER_MAX_PATHS = 200;

/** What the status card and a later reader see (store [deliverable-handoff, sessionId] / latest + runId). */
export interface HandoffRecord {
  runId: string;
  sessionId: string;
  targetChatId: string;
  parentChatId: string | null;
  postedAt: string;
  resultMessageId: string | null;
  artifacts: TaskArtifact[];
  files: number;
  prs: number;
  canvases: number;
  bytes: number;
  skippedTooLarge: number;
  truncated: number;
  skippedOverBudget?: number;
  treatedAsChange?: number;
  /** Files whose bytes were already on the target (linked, not re-copied). */
  deduped?: number;
  /** Older hand-off copies deleted from the target under the per-chat budget. */
  pruned?: number;
}

export interface HandoffResult {
  skipped?: 'origin' | 'no_chat' | 'supervisor_parent' | 'nothing' | 'already' | 'timeout' | 'error' | 'unchanged';
  posted: boolean;
  targetChatId: string | null;
  parentChatId: string | null;
  resultMessageId: string | null;
  artifacts: TaskArtifact[];
  files: number;
  prs: number;
  canvases: number;
  bytes: number;
  skippedTooLarge: number;
  truncated: number;
  skippedOverBudget: number;
  treatedAsChange: number;
  worktreeLocal: boolean;
  /** Hand-off polish (CT-1): files linked to an existing copy instead of re-persisted. */
  deduped: number;
  /** Hand-off polish (CT-1): older hand-off copies pruned from the target under the per-chat budget. */
  pruned: number;
}

const emptyResult = (skipped: HandoffResult['skipped'], extra?: Partial<HandoffResult>): HandoffResult => ({
  skipped, posted: false, targetChatId: null, parentChatId: null, resultMessageId: null,
  artifacts: [], files: 0, prs: 0, canvases: 0, bytes: 0, skippedTooLarge: 0, truncated: 0, skippedOverBudget: 0, treatedAsChange: 0, worktreeLocal: false,
  deduped: 0, pruned: 0,
  ...extra,
});

class HandoffAbortedError extends Error {
  constructor(where: string) { super(`hand-off deadline reached during ${where}`); this.name = 'HandoffAbortedError'; }
}

/**
 * The line appended to the run_completed HOOK summary when a hand-off posted,
 * so the parent's child-result wake (and any project-scope hook) learns the
 * deliverables ALREADY landed and acknowledges instead of re-posting them.
 * '' when nothing posted.
 */
export function handoffHookNote(result: HandoffResult | null | undefined): string {
  if (!result?.posted) return '';
  const names = result.artifacts.map((a) => a.name).slice(0, 8);
  const more = result.artifacts.length > names.length ? `, +${result.artifacts.length - names.length} more` : '';
  const what = names.length ? `${names.join(', ')}${more}` : 'the result summary';
  const where = result.targetChatId ? ` on chat ${result.targetChatId}` : '';
  const msg = result.resultMessageId ? ` (message ${result.resultMessageId})` : '';
  return `\n\n[DELIVERABLES ALREADY POSTED${where}${msg}: ${what}. The harness handed them back with download links — acknowledge that message; do not re-post, re-stage or re-narrate these files, and never send the user to the session's Files tab.]`;
}

/** ONE taskId per sub-session — the spawn-time running card (chat-agent) and this done card share it. */
export { taskIdForSession } from '../chat-agent/task-ids';

/**
 * The hand-off proper. Throws only on a programming error inside `deps`; the
 * finalize seam calls `runDeliverableHandoffSafe`, which never throws.
 */
export async function runDeliverableHandoff(input: HandoffInput, deps: HandoffDeps): Promise<HandoffResult> {
  const signal = input.signal;
  if (signal?.aborted) return emptyResult('timeout');
  // The first cut's FIRING-ORIGIN gate, opt-in only: by default the gate is
  // LINEAGE (below) — a continuation / schedule firing on a human-asked child
  // is exactly the run that finishes long work.
  if (deliverableHandoffOriginGateArmed()) {
    const originOk = input.triggerKind === 'user' || input.triggerKind === 'machine' || deliverableHandoffAllOrigins();
    if (!originOk) return emptyResult('origin');
  }

  const chat = await deps.findChat(input.sessionId).catch(() => null);
  if (!chat) return emptyResult('no_chat');
  let parentChatId: string | null = null;
  let parent: HandoffChat | null = null;
  if (chat.parentChatId && chat.parentChatId !== chat.id) {
    parent = await deps.findChat(chat.parentChatId).catch(() => null);
    // Owner-scoped: a parent held by another account never receives files.
    if (parent && parent.userId === chat.userId) parentChatId = parent.id;
    else parent = null;
  }
  // LINEAGE gate: a supervisor-class target (the session itself, or the
  // Fleet / Project Supervisor that spawned it) is skipped — supervisors get
  // the run_completed hook; a Result row + file copies per lane run would be
  // a new machine-lane surface on the supervisor chat.
  if (!deliverableHandoffSupervisorParents() && (isSupervisorClassChat(chat) || (parent && isSupervisorClassChat(parent)))) {
    deps.recordMetric({
      kind: 'deliverable_handoff', sessionId: chat.id, runId: input.runId, value: 0,
      meta: { runId: input.runId, parentChatId, targetChatId: parentChatId ?? chat.id, posted: false, skipped: 'supervisor_parent', trigger: input.triggerKind },
    });
    return emptyResult('supervisor_parent', { parentChatId, targetChatId: parentChatId ?? chat.id });
  }
  const targetChatId = parentChatId ?? chat.id;
  const targetIsParent = parentChatId !== null;
  const now = input.now ?? new Date();
  const runStartedMs = input.runStartedAt.getTime();

  // ── Collect ──
  const root = input.worktreeRoot ? String(input.worktreeRoot) : '';
  const [entries, classes, receipts, canvases] = await Promise.all([
    root ? deps.listWorktree(root, signal).catch(() => [] as WorktreeFileEntry[]) : Promise.resolve([] as WorktreeFileEntry[]),
    root ? deps.gitClasses(root, input.baseBranch, signal).catch(() => null) : Promise.resolve(null),
    deps.getRunReceipts(input.runId).catch(() => [] as ToolReceipt[]),
    deps.listCanvases(chat.id, new Date(runStartedMs - DELIVERABLE_MTIME_SLACK_MS)).catch(() => [] as HandoffCanvas[]),
  ]);
  if (signal?.aborted) return emptyResult('timeout', { parentChatId, targetChatId });
  const worktreeLocal = entries.length > 0;
  const selection = selectDeliverables(entries, {
    runStartedMs, excludePaths: classes?.unchanged ?? undefined, preexistingPaths: classes?.preexisting ?? undefined,
  });
  const prs = prsFromReceipts(receipts);
  // Hand-off polish (CT-3): the child's absolute worktree paths / headings never
  // lead the row — scrub first, then cut the head on a sentence.
  const summary = summaryHead(scrubSummary(input.finalText, { worktreeRoot: root || null }));
  const hasArtifacts = selection.files.length > 0 || prs.length > 0 || canvases.length > 0;

  if (!hasArtifacts) {
    // Summary-only results reach the PARENT for a human-typed run or the
    // child's first completed run; a top-level session's own transcript
    // already shows its final answer, so nothing is posted there.
    if (!targetIsParent) return emptyResult('nothing', { targetChatId, parentChatId, worktreeLocal });
    if (input.triggerKind !== 'user') {
      const completed = await deps.countCompletedRuns(chat.id).catch(() => 2);
      if (completed > 1) return emptyResult('nothing', { targetChatId, parentChatId, worktreeLocal });
    }
    if (!summary) return emptyResult('nothing', { targetChatId, parentChatId, worktreeLocal });
  }

  // ── Idempotence: one post per run ──
  const claimed = await deps.claim(chat.id, input.runId);
  if (!claimed) return emptyResult('already', { targetChatId, parentChatId, worktreeLocal });

  try {
    // ── Files → durable chat uploads on the target, ONE AT A TIME ──
    // read → persist → release: no `loaded[]` of base64 strings (12 × 25 MB
    // would be ~700 MB of Buffers + strings per finalize on a 32-slot worker);
    // the per-run total budget already bounded the selection. The deadline
    // stops the loop between files — a timed-out hand-off never keeps
    // reading in the background.
    // Hand-off polish (CT-1): CONTENT-keyed upload ids + the per-target
    // ledger — a file whose bytes already sit on the target is LINKED, never
    // persisted again.
    const ledger: HandoffLedger = (deps.loadLedger ? await deps.loadLedger(targetChatId).catch(() => null) : null) ?? { version: 1, files: {} };
    const persisted: Array<{ uploadId: string; rel: string; bytes: number; sha1: string; reused: boolean }> = [];
    for (const f of selection.files) {
      if (signal?.aborted) throw new HandoffAbortedError('file copy');
      const buf = await deps.readFile(root, f.rel, signal).catch(() => null);
      if (!buf || !buf.length) continue;
      const sha1 = contentSha1(buf);
      const uploadId = deliverableContentUploadId(f.rel, sha1);
      const existing = await deps.findChatFiles(targetChatId, [uploadId]).catch(() => []);
      if (existing.some((r) => r.uploadId === uploadId)) {
        persisted.push({ uploadId, rel: f.rel, bytes: buf.length, sha1, reused: true });
        continue;
      }
      const mimeType = deliverableMime(f.rel, buf);
      const isImage = /^image\/(png|jpe?g|gif|webp)$/i.test(mimeType);
      const isPdf = mimeType === 'application/pdf';
      const one: LoadedUpload = {
        id: uploadId,
        attachment: {
          type: isImage ? 'image' : isPdf ? 'pdf' : 'document',
          filename: path.posix.basename(f.rel),
          mimeType,
          base64: buf.toString('base64'),
          uploadId,
          ownerUserId: input.userId,
        },
      };
      await deps.persistFiles(targetChatId, input.userId, [one]);
      persisted.push({ uploadId, rel: f.rel, bytes: buf.length, sha1, reused: false });
    }
    const deduped = persisted.filter((p) => p.reused).length;
    const newFiles = persisted.length - deduped;
    // NOTHING NEW on a top-level self-target (the lane re-wrote identical
    // files; no PR, no canvas): post nothing — the chat already holds every
    // byte and every link. The claim stays (the run is handled). A PARENT
    // target still gets its row: the run's completion is the news there.
    if (!targetIsParent && persisted.length > 0 && newFiles === 0 && prs.length === 0 && canvases.length === 0) {
      deps.recordMetric({
        kind: 'deliverable_handoff', sessionId: chat.id, runId: input.runId, value: 0,
        meta: {
          runId: input.runId, parentChatId, targetChatId, files: 0, prs: 0, canvases: 0, bytes: 0, deduped, pruned: 0,
          candidates: selection.candidates, worktreeLocal, trigger: input.triggerKind, posted: false, skipped: 'unchanged',
        },
      });
      return emptyResult('unchanged', { targetChatId, parentChatId, worktreeLocal, deduped });
    }
    const rows = persisted.length ? await deps.findChatFiles(targetChatId, persisted.map((p) => p.uploadId)).catch(() => []) : [];
    const artifacts: TaskArtifact[] = [];
    const unchangedNames: string[] = [];
    let bytes = 0;
    const nowIso = now.toISOString();
    // Path order (the selection's order) — rows come back in DB order.
    for (const p of persisted) {
      const row = rows.find((r) => r.uploadId === p.uploadId);
      if (!row) continue;
      artifacts.push({ name: p.rel, bytes: row.sizeBytes || p.bytes, url: chatFileDownloadUrl(row.id), kind: 'file' });
      bytes += row.sizeBytes || p.bytes;
      if (p.reused) unchangedNames.push(p.rel);
      const prior = ledger.files[p.rel];
      ledger.files[p.rel] = p.reused && prior && prior.sha1 === p.sha1
        ? prior // the first hand-off of these bytes stays the record ("unchanged since …")
        : { sha1: p.sha1, uploadId: p.uploadId, bytes: p.bytes, runId: input.runId, sessionId: chat.id, postedAt: nowIso };
    }
    // Per-chat budget: the OLDEST hand-off copies that are not this run's go
    // past HANDOFF_CHAT_TOTAL_BYTES (their earlier Result-row links go dead —
    // the row says so). Never a user upload (dh_ prefix only), never a file
    // this run links. Fail-open: a listing / delete failure prunes nothing.
    let pruned = 0;
    if (deps.listHandoffFiles && deps.deleteChatFiles && persisted.length > 0) {
      try {
        const budget = handoffChatTotalBytes();
        const keep = new Set(rows.map((r) => r.id));
        const all = (await deps.listHandoffFiles(targetChatId))
          .filter((r) => typeof r.uploadId === 'string' && r.uploadId.startsWith('dh_'))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        let total = all.reduce((n, r) => n + (r.sizeBytes || 0), 0);
        const victims: typeof all = [];
        for (const r of all) {
          if (total <= budget) break;
          if (keep.has(r.id)) continue;
          victims.push(r);
          total -= r.sizeBytes || 0;
        }
        if (victims.length) {
          pruned = await deps.deleteChatFiles(targetChatId, victims.map((v) => v.id));
          const gone = new Set(victims.map((v) => v.uploadId));
          for (const [rel, e] of Object.entries(ledger.files)) if (gone.has(e.uploadId)) delete ledger.files[rel];
        }
      } catch (err: any) {
        logger.warn(`deliverable-handoff: per-chat prune on ${targetChatId.slice(0, 8)} failed (non-fatal): ${err?.message ?? err}`);
      }
    }
    if (deps.saveLedger) {
      const entries = Object.entries(ledger.files).sort((a, b) => b[1].postedAt.localeCompare(a[1].postedAt)).slice(0, HANDOFF_LEDGER_MAX_PATHS);
      await deps.saveLedger(targetChatId, { version: 1, files: Object.fromEntries(entries) }).catch(() => {});
    }
    for (const p of prs) artifacts.push({ name: `PR #${p.prNumber}`, bytes: 0, url: p.url, kind: 'pr' });
    // ── Canvases → a copy on the parent (a top-level session already owns them) ──
    for (const c of canvases) {
      let id = c.id;
      if (targetIsParent) {
        const copy = await deps.copyCanvas(targetChatId, input.userId, c).catch(() => null);
        if (!copy) continue;
        id = copy.id;
      }
      artifacts.push({ name: c.title, bytes: Buffer.byteLength(c.content ?? '', 'utf8'), url: `canvas:${id}`, kind: 'canvas' });
    }

    // ── Post ONE result message ──
    // audit 2026-10-06 T7-4 (spark.md #12): the run-start title is often the
    // stock "New chat" placeholder (the title is generated DURING the run) —
    // the fresh chat row read above wins over a placeholder; never "Result: New chat".
    const title = handoffCardFactsDisabled()
      ? String(input.sessionTitle || chat.title || 'Task')
      : handoffTitle(input.sessionTitle, chat.title);
    const content = buildResultMessage({
      sessionTitle: title, sessionId: chat.id, runId: input.runId, summary, artifacts, targetIsParent,
      skippedTooLarge: selection.skippedTooLarge, truncated: selection.truncated, skippedOverBudget: selection.skippedOverBudget,
      unchanged: unchangedNames, pruned,
    });
    const startedIso = input.runStartedAt.toISOString();
    const steps = handoffCardFactsDisabled() ? null
      : (input.steps ?? (input.loadSteps ? await input.loadSteps().catch(() => null) : null));
    const taskBase: Omit<TaskEventPayload, 'resultMessageId'> = {
      taskId: taskIdForSession(chat.id),
      chatId: targetChatId,
      ...(targetIsParent ? { childChatId: chat.id } : {}),
      kind: 'session',
      status: 'done',
      title,
      steps: steps && Number.isFinite(steps.done) && Number.isFinite(steps.total)
        ? { done: Math.max(0, Math.floor(steps.done)), total: Math.max(0, Math.floor(steps.total)) }
        : { done: 0, total: 0 },
      receipts: { ok: receipts.filter((r) => r.ok).length, total: receipts.length },
      spendUsd: typeof input.spendUsd === 'number' && Number.isFinite(input.spendUsd) ? input.spendUsd : 0,
      startedAt: startedIso,
      updatedAt: now.toISOString(),
      artifacts,
      ...(selection.skippedTooLarge || selection.truncated || selection.skippedOverBudget
        ? { note: `${selection.skippedTooLarge} over the size cap, ${selection.skippedOverBudget} over the run budget, ${selection.truncated} beyond the file cap — see the session's Files tab` }
        : {}),
    };
    const metadata = {
      kind: HANDOFF_MESSAGE_KIND,
      // A harness row, never the model's own words — history builders and the
      // frontend group on this stamp; it is in NO machine-noise set, so the
      // row stays a VISIBLE assistant bubble.
      origin: HANDOFF_MESSAGE_ORIGIN,
      harness: true,
      runId: input.runId,
      childChatId: chat.id,
      sourceChatId: chat.id,
      artifacts,
      task: taskBase,
    };
    const row = await deps.appendMessage(targetChatId, content, metadata);
    const resultMessageId = row?.id ?? null;
    const payload: TaskEventPayload = { ...taskBase, ...(resultMessageId ? { resultMessageId } : {}) };
    deps.emitTask(targetChatId, payload);
    // ONE card per sub-session: the row that already carries the spawn-time
    // running card (the parent's answer row) flips to done; a session that was
    // never carded (a confirmed-card spawn, a top-level session) anchors the
    // done card on the result row itself — never an invented row.
    await deps.persistTaskCard(targetChatId, payload, { preferCarrier: true, ...(resultMessageId ? { messageId: resultMessageId } : {}) }).catch(() => null);

    const record: HandoffRecord = {
      runId: input.runId, sessionId: chat.id, targetChatId, parentChatId, postedAt: now.toISOString(), resultMessageId,
      artifacts, files: artifacts.filter((a) => a.kind === 'file').length, prs: prs.length,
      canvases: artifacts.filter((a) => a.kind === 'canvas').length, bytes,
      skippedTooLarge: selection.skippedTooLarge, truncated: selection.truncated,
      skippedOverBudget: selection.skippedOverBudget, treatedAsChange: selection.treatedAsChange,
      deduped, pruned,
    };
    await deps.saveRecord(chat.id, record).catch(() => {});
    deps.recordMetric({
      kind: 'deliverable_handoff', sessionId: chat.id, runId: input.runId, value: record.files,
      meta: {
        runId: input.runId, parentChatId, targetChatId, files: record.files, prs: record.prs, canvases: record.canvases, bytes,
        skippedTooLarge: selection.skippedTooLarge, truncated: selection.truncated, candidates: selection.candidates,
        skippedOverBudget: selection.skippedOverBudget, treatedAsChange: selection.treatedAsChange,
        worktreeLocal, trigger: input.triggerKind, posted: true, resultMessageId, deduped, pruned,
        baseRef: classes?.baseRef ?? null,
      },
    });
    return {
      posted: true, targetChatId, parentChatId, resultMessageId, artifacts,
      files: record.files, prs: record.prs, canvases: record.canvases, bytes,
      skippedTooLarge: selection.skippedTooLarge, truncated: selection.truncated,
      skippedOverBudget: selection.skippedOverBudget, treatedAsChange: selection.treatedAsChange, worktreeLocal,
      deduped, pruned,
    };
  } catch (err: any) {
    // Nothing was posted (the append is the last write before the record) —
    // release the claim so a re-finalize can post. A failure AFTER the append
    // keeps the claim (the row exists; never double-post). A deadline abort
    // lands here too (the file loop throws HandoffAbortedError) — the claim
    // is released and the work STOPS.
    const aborted = err instanceof HandoffAbortedError || err?.name === 'AbortError';
    logger.warn(`deliverable-handoff: run ${input.runId} on session ${input.sessionId} ${aborted ? 'stopped at the deadline' : 'failed'} before posting — ${err?.message ?? err}`);
    await deps.releaseClaim(chat.id, input.runId).catch(() => {});
    deps.recordMetric({
      kind: 'deliverable_handoff', sessionId: chat.id, runId: input.runId, value: 0,
      meta: { runId: input.runId, parentChatId, targetChatId, files: 0, prs: prs.length, canvases: 0, bytes: 0, posted: false, ...(aborted ? { skipped: 'timeout' } : {}), error: String(err?.message ?? err).slice(0, 200) },
    });
    return emptyResult(aborted ? 'timeout' : 'error', { targetChatId, parentChatId, worktreeLocal });
  }
}

// ── Default deps (real modules; lazily imported so the leaf stays hermetic) ──

export function defaultHandoffDeps(): HandoffDeps {
  const db = () => import('../../../config/database').then((m) => m.default);
  return {
    async findChat(id) {
      const prisma = await db();
      return prisma.crossModelChat.findUnique({ where: { id }, select: { id: true, userId: true, parentChatId: true, title: true, isSupervisor: true, isProjectSupervisor: true } });
    },
    async countCompletedRuns(sessionId) {
      const prisma = await db();
      return prisma.agentRun.count({ where: { sessionId, status: 'completed' } });
    },
    async getRunReceipts(runId) {
      const m = await import('./run-receipts.service');
      return m.getRunReceipts(runId);
    },
    listWorktree: (root, signal) => walkWorktree(root, { signal }),
    gitClasses: (root, baseBranch, signal) => gitPathClasses(root, baseBranch, signal),
    async readFile(root, rel, signal) {
      // rel came from our own walk (no '..', no absolute) — the safe resolver re-checks anyway.
      const wf = await import('./worktree-files');
      const { abs } = await wf.resolveSafeWorktreePath(root, rel);
      return fs.readFile(abs, signal ? { signal } : undefined);
    },
    async listCanvases(chatId, since) {
      const prisma = await db();
      const rows = await prisma.canvasDocument.findMany({
        where: { chatId, createdAt: { gte: since } },
        orderBy: { createdAt: 'asc' },
        take: 12,
        select: { id: true, title: true, type: true, language: true, content: true },
      });
      return rows.map((r) => ({ id: r.id, title: r.title, type: r.type, language: r.language ?? null, content: r.content }));
    },
    async copyCanvas(targetChatId, userId, canvas) {
      const prisma = await db();
      return prisma.canvasDocument.create({
        data: { chatId: targetChatId, userId, title: canvas.title, type: canvas.type, language: canvas.language, content: canvas.content, version: 1 },
        select: { id: true },
      });
    },
    async persistFiles(targetChatId, userId, loaded) {
      const m = await import('../chat-files.service');
      await m.persistChatUploads({ chatId: targetChatId, userId, loaded });
    },
    async findChatFiles(targetChatId, uploadIds) {
      const prisma = await db();
      return prisma.chatFile.findMany({ where: { chatId: targetChatId, uploadId: { in: uploadIds } }, select: { id: true, uploadId: true, sizeBytes: true } });
    },
    async appendMessage(targetChatId, content, metadata) {
      const prisma = await db();
      // Route by what the TARGET is (cohesive chat live fixes 2026-09-28): the
      // coding transcript ONLY when the target chat IS a coding session — a
      // PLAIN parent chat has no coding_sessions row, and the first cut's
      // unconditional write-through-coding-path failed on it with
      // `coding_messages_sessionId_fkey` (prod parent b9ee9c20, 05:27:36Z:
      // posted:false, no result row, the card stuck on "running"). A plain
      // chat gets the chat row only. Since MERGE-1 completed the coding path
      // also writes crossmodel_messages, so the routing is now about the
      // metadata/strip treatment, not about which table is written.
      const data = await import('./coding-data.service');
      const codingTarget = !!(await prisma.chatCodingState.findUnique({ where: { id: targetChatId }, select: { id: true } }).catch(() => null));
      if (codingTarget) {
        const row = await data.appendCodingMessage({ chatId: targetChatId, role: 'assistant', content, metadata });
        await data.touchChat(targetChatId).catch(() => {});
        return { id: row.id };
      }
      const row = await prisma.crossModelMessage.create({ data: { chatId: targetChatId, role: 'assistant', content, metadata: metadata as any }, select: { id: true } });
      await data.touchChat(targetChatId).catch(() => {});
      return { id: row.id };
    },
    async claim(sessionId, runId) {
      const store = await import('../memory/context-store');
      return store.storeCreate([HANDOFF_STORE_NS, sessionId], runId, { claimedAt: new Date().toISOString() });
    },
    async releaseClaim(sessionId, runId) {
      const store = await import('../memory/context-store');
      await store.storeDelete([HANDOFF_STORE_NS, sessionId], runId);
    },
    async saveRecord(sessionId, record) {
      const store = await import('../memory/context-store');
      const value = record as unknown as Record<string, unknown>;
      await store.storePut([HANDOFF_STORE_NS, sessionId], record.runId, value);
      await store.storePut([HANDOFF_STORE_NS, sessionId], HANDOFF_LATEST_KEY, value);
    },
    emitTask(chatId, payload) {
      void import('../chat-agent/task-events').then((m) => m.emitTaskEvent(chatId, payload)).catch(() => {});
    },
    async persistTaskCard(chatId, payload, opts) {
      const m = await import('../chat-agent/task-events');
      return m.persistTaskCard(chatId, payload, opts);
    },
    recordMetric(input) {
      void import('../platform/loop-metrics.service').then((m) => m.recordLoopMetric(input)).catch(() => {});
    },
    async loadLedger(targetChatId) {
      const store = await import('../memory/context-store');
      const rec = await store.storeGet<HandoffLedger>([HANDOFF_STORE_NS, targetChatId], HANDOFF_LEDGER_KEY);
      return rec && typeof rec === 'object' && rec.files && typeof rec.files === 'object' ? rec : null;
    },
    async saveLedger(targetChatId, ledger) {
      const store = await import('../memory/context-store');
      await store.storePut([HANDOFF_STORE_NS, targetChatId], HANDOFF_LEDGER_KEY, ledger as unknown as Record<string, unknown>);
    },
    async listHandoffFiles(targetChatId) {
      const prisma = await db();
      return prisma.chatFile.findMany({
        where: { chatId: targetChatId, uploadId: { startsWith: 'dh_' } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, uploadId: true, sizeBytes: true, createdAt: true },
      });
    },
    async deleteChatFiles(targetChatId, fileIds) {
      const prisma = await db();
      // Owner-scoped by chat AND by the hand-off prefix — never a user's own upload.
      const res = await prisma.chatFile.deleteMany({ where: { chatId: targetChatId, id: { in: fileIds }, uploadId: { startsWith: 'dh_' } } });
      return res.count;
    },
  };
}

/**
 * The finalize seam: bounded by HANDOFF_TIMEOUT_MS, never throws, null on a
 * timeout / any failure. The executor AWAITS this (≤ 20 s)
 * so the parent's child-result wake can already see the result row. The
 * deadline is an AbortSignal handed to the hand-off: at the timeout the
 * walk, the git calls, the reads and the per-file loop STOP (the claim is
 * released) — nothing keeps running in the background holding buffers.
 */
export async function runDeliverableHandoffSafe(input: HandoffInput, deps?: HandoffDeps, timeoutMs = HANDOFF_TIMEOUT_MS): Promise<HandoffResult | null> {
  let timer: NodeJS.Timeout | null = null;
  const controller = new AbortController();
  try {
    const d = deps ?? defaultHandoffDeps();
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs);
    });
    const work = runDeliverableHandoff({ ...input, signal: controller.signal }, d);
    work.catch(() => null); // a late settle of the stopped work is never an unhandled rejection
    const result = await Promise.race([work, timeout]);
    if (result === null) logger.warn(`deliverable-handoff: run ${input.runId} on session ${input.sessionId} timed out after ${timeoutMs} ms — the work was stopped (claim released; a re-finalize can post)`);
    return result;
  } catch (err: any) {
    logger.warn(`deliverable-handoff: run ${input.runId} on session ${input.sessionId} failed — ${err?.message ?? err}`);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The newest hand-off record for a session (the status card's Result line). Never throws. */
export async function latestDeliverableHandoff(sessionId: string): Promise<HandoffRecord | null> {
  try {
    const store = await import('../memory/context-store');
    const rec = await store.storeGet<HandoffRecord>([HANDOFF_STORE_NS, sessionId], HANDOFF_LATEST_KEY);
    return rec && typeof rec === 'object' && typeof rec.runId === 'string' ? rec : null;
  } catch {
    return null;
  }
}

/** "Delivered 3 files and 1 pull request to the parent chat: deck/a.pdf, deck/a.pptx, …" — the status-card line. */
export function describeHandoff(record: HandoffRecord): string {
  const parts: string[] = [];
  if (record.files > 0) parts.push(`${record.files} file${record.files === 1 ? '' : 's'}`);
  if (record.prs > 0) parts.push(`${record.prs} pull request${record.prs === 1 ? '' : 's'}`);
  if (record.canvases > 0) parts.push(`${record.canvases} canvas${record.canvases === 1 ? '' : 'es'}`);
  const what = parts.length ? parts.join(', ').replace(/, ([^,]*)$/, ' and $1') : 'the result';
  const where = record.parentChatId ? 'the parent chat' : 'this chat';
  const names = record.artifacts.filter((a) => a.kind === 'file').map((a) => a.name).slice(0, 4);
  const more = record.files > names.length ? `, … (+${record.files - names.length})` : '';
  return `Delivered ${what} to ${where}${names.length ? `: ${names.join(', ')}${more}` : ''}`;
}
