/**
 * Worktree snapshot store + publisher (feedback ticket 1c767622).
 *
 * WHY THIS EXISTS: the Files tab (worktree-files.ts) reads
 * ${CODING_WORKSPACE_ROOT}/worktrees/<chatId> from the ALB round-robined WEB
 * tier, but Docker named volumes are HOST-LOCAL. Live probe 2026-09-12:
 * box A = 104 worktrees, box B = 112, coding box C = 228, with only 40 shared
 * between A and B — and nginx access logs show the SAME chat served
 * `worktree/tree` 200 from A and 404 from B within one minute. A tree request
 * routed to the box without the chat's volume 404s ("No coding worktree on
 * disk"), and Retry re-rolls the ALB dice — exactly the reported "every
 * directory initially failing unless you click Retry".
 *
 * The one data plane every box shares is Redis (box A's
 * redis://…:7856 — A/B backends and C's worker all point at it). So the
 * process that owns the live worktree publishes a bounded snapshot after each
 * run (and at provision time); a web box whose local volume lacks the chat
 * falls back to that snapshot instead of 404ing. Disk ALWAYS wins when
 * present — the disk path is byte-identical to before; the snapshot only
 * fills the missing-box hole.
 *
 * DELIBERATELY SELF-CONTAINED: this module duplicates worktree-files' small
 * pure helpers (porcelain parse, badge mapping, binary sniff) instead of
 * importing them, because worktree-files imports THIS module for the fallback
 * lookup — a static cycle. Keep both copies in sync or accept small drift;
 * the shapes are pinned by tests on both sides.
 *
 * Bounds (Redis: 256MB maxmemory, ~2MB used, allkeys-lru — probed 2026-09-12):
 *   - MAX_ENTRIES      5000 whole-tree (the per-level disk cap is also 5000)
 *   - MAX_CONTENT_BUDGET 256KB of raw file content per session (≈343KB base64)
 *   - per-file content: UTF-8 text files ≤ 256KB only (mirrors the viewer's
 *     MAX_FILE_BYTES + 415-binary contract; larger/binary files still LIST,
 *     they just 404 honestly when opened from a snapshot)
 *
 * Everything is best-effort: a Redis hiccup degrades to the pre-fix 404
 * behavior, never a thrown error into a request.
 */

import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import logger from '../../../utils/logger';
import { worktreePath, WORKSPACE_ROOT } from './workspace.service';

/**
 * Lazy Redis handle — imported INSIDE each accessor, never at module load.
 * worktree-files.ts (which statically imports this module for its pure
 * helpers) is deliberately off the config/env chain (see its header: suites
 * like express5-req-query.test.ts import the controller WITHOUT a config/redis
 * boundary mock and would hit env.ts's import-time process.exit(1) — the
 * 2026-09-12 verify failure this lazy-load fixes). The dynamic import also
 * keeps this module cycle-safe.
 */
type RedisLike = {
  setEx(key: string, ttl: number, value: string): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
  /* Hygiene sweep (loop #14) — optional so a minimal mock still serves the publisher. */
  set?(key: string, value: string, opts: { NX?: boolean; EX?: number }): Promise<unknown>;
  scanIterator?(opts: { MATCH: string; COUNT: number }): AsyncIterable<string>;
  strLen?(key: string): Promise<number>;
  ttl?(key: string): Promise<number>;
  expire?(key: string, seconds: number): Promise<unknown>;
};
async function redis(): Promise<RedisLike> {
  const m = await import('../../../config/redis');
  return (m as any).default as RedisLike;
}

/** Key namespace — cm:* matches the platform's other Redis keys (cm:upload:…). */
const KEY = (sessionId: string) => `cm:wt-snap:${sessionId}`;
/** 7 days — the idle-reap horizon (run-reaper CHILD_IDLE_REAP_MS / the 7d
 *  resume window): a worktree nobody has run for a week is reaped anyway, and
 *  every terminal run + provision republishes. WAS 30 days until autonomy loop
 *  #14 (2026-09-21): 245 snapshots (up to 1.69 MB each, 238 MB total) sat in
 *  the shared 256 MB allkeys-lru Redis and evicted the session run LOCKS —
 *  one session ran three runs at once on one worktree. */
export const SNAPSHOT_TTL_SEC = 7 * 24 * 3600;
export const MAX_SNAPSHOT_ENTRIES = 5000;
/**
 * HARD ceiling on the SERIALIZED snapshot (bytes of the JSON that reaches
 * Redis). The content budget below bounds file bodies only — the tree JSON
 * itself (5000 entries × ~200 B with mtime/status) reached 1.3 MB live, which
 * is how snapshots grew to 1.69 MB. fitSnapshotToCeiling drops file bodies
 * largest-first, then cuts the DEEPEST entries (truncated:true) until the
 * JSON fits. Worst case 245 sessions × 384 KB ≈ 92 MB — inside the docblock's
 * original 115 MB design envelope. Override: WORKTREE_SNAPSHOT_MAX_BYTES
 * (min 16 KB).
 */
export const SNAPSHOT_MAX_BYTES_DEFAULT = 384 * 1024;
export function snapshotMaxBytes(): number {
  const n = Number(process.env.WORKTREE_SNAPSHOT_MAX_BYTES);
  return Number.isFinite(n) && n >= 16 * 1024 ? Math.floor(n) : SNAPSHOT_MAX_BYTES_DEFAULT;
}

export interface SnapshotFit {
  snapshot: WorktreeSnapshot;
  json: string;
  before: number;
  after: number;
  droppedFiles: number;
  cutEntries: number;
}

/**
 * Pure: shrink `snapshot` until JSON.stringify(snapshot).length <= maxBytes.
 * 1. file bodies go largest-first (the Files tab fetches a missing body live
 *    from the worker over Redis — worktree-remote-read.ts — so a dropped body
 *    costs one round trip, never a blank pane);
 * 2. then entries are cut deepest-first (stable within a depth) by binary
 *    search on the retained prefix, and `truncated` flips true — the shallow
 *    levels stay complete so the tree still browses top-down.
 */
export function fitSnapshotToCeiling(snapshot: WorktreeSnapshot, maxBytes: number): SnapshotFit {
  let json = JSON.stringify(snapshot);
  const before = json.length;
  if (before <= maxBytes) return { snapshot, json, before, after: before, droppedFiles: 0, cutEntries: 0 };

  let droppedFiles = 0;
  const files: Record<string, string> = { ...snapshot.files };
  const byLen = Object.entries(files).sort((a, b) => b[1].length - a[1].length);
  let cur: WorktreeSnapshot = { ...snapshot, files };
  for (const [p] of byLen) {
    if (json.length <= maxBytes) break;
    delete files[p];
    droppedFiles++;
    cur = { ...snapshot, files };
    json = JSON.stringify(cur);
  }
  if (json.length <= maxBytes) return { snapshot: cur, json, before, after: json.length, droppedFiles, cutEntries: 0 };

  // Entries: shallow first (stable), keep the longest prefix that fits.
  const depth = (e: WorktreeSnapshotEntry) => e.path.split('/').length;
  const ordered = snapshot.entries.map((e, i) => ({ e, i })).sort((a, b) => depth(a.e) - depth(b.e) || a.i - b.i).map((x) => x.e);
  let lo = 0;
  let hi = ordered.length;
  let bestJson = JSON.stringify({ ...snapshot, files: {}, entries: [], truncated: true });
  let bestN = 0;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = JSON.stringify({ ...snapshot, files: {}, entries: ordered.slice(0, mid), truncated: true });
    if (candidate.length <= maxBytes) { bestJson = candidate; bestN = mid; lo = mid; } else { hi = mid - 1; }
  }
  const fitted: WorktreeSnapshot = { ...snapshot, files: {}, entries: ordered.slice(0, bestN), truncated: true };
  return { snapshot: fitted, json: bestJson, before, after: bestJson.length, droppedFiles, cutEntries: ordered.length - bestN };
}
/**
 * Raw (pre-base64) byte budget for file contents in one snapshot. SIZED FOR
 * THE SHARED REDIS (256MB maxmemory, allkeys-lru — probed 2.05M used
 * 2026-09-12): ~230 live sessions × (tree JSON ~150KB + content ~343KB b64)
 * ≈ 115MB worst case, leaving headroom for the platform's other keys. A
 * budget blowout would evict confirm:pending / locks / uploads keys — never
 * acceptable — so this stays conservative. THAT BLOWOUT HAPPENED (loop #14,
 * 2026-09-20: 252.85 MB used, evicted_keys climbing, run locks gone) because
 * the tree JSON was unbounded — the serialized ceiling above is the real fence.
 */
export const MAX_CONTENT_BUDGET_BYTES = 256 * 1024;
/** Mirror of the viewer's MAX_FILE_BYTES — larger files list but don't carry content. */
const MAX_CONTENT_FILE_BYTES = 256 * 1024;
const SNIFF_BYTES = 8192;

export interface WorktreeSnapshotEntry {
  /** Canonical forward-slash worktree-relative path (the JSON key space). */
  path: string;
  name: string;
  type: 'file' | 'dir';
  size?: number;
  /** Last-modified time (epoch ms, lstat mtime) — files AND dirs (owner
   *  2026-09-17: the Files tab shows it and sorts most-recent first). */
  mtime?: number;
  status?: 'M' | 'A' | 'D' | '?';
  /** True when git check-ignore matched (served only under showIgnored=1). */
  ignored?: true;
}

export interface WorktreeSnapshot {
  v: 1;
  /** WHO published this snapshot — the serve-order fence keys on it (no
   *  clocks): 'run' = the worker box that owns the live worktree, after a
   *  terminal run (authoritative); 'provision' = a web box at provision time
   *  (equals a fossil disk copy). Legacy/malformed payloads treat as 'run'. */
  origin?: 'run' | 'provision';
  branch?: string;
  publishedAt: string;
  entries: WorktreeSnapshotEntry[];
  /** path → base64 UTF-8 content (budgeted subset of the text files). */
  files: Record<string, string>;
  /** True when the collector hit MAX_SNAPSHOT_ENTRIES. */
  truncated: boolean;
}

/** Served-response marker so the UI can label snapshot data honestly. */
export interface SnapshotMeta {
  publishedAt: string;
  branch?: string;
}

interface GitOut { code: number; stdout: string }

/**
 * GIT_CEILING_DIRECTORIES must survive into the child.
 *
 * execGit deliberately runs git under a WHITELIST env (no inherited secrets,
 * no user/system config). That whitelist used to drop the ceiling that
 * jest.global-setup.js sets at the durable tmp root — so from a fixture dir
 * with no `.git` of its own, `git status` / `ls-tree` / `check-ignore` walked
 * UP and answered about the ENCLOSING checkout instead of failing with
 * "not a git repository". Proven on 2026-11-03: with this whitelist
 * `git rev-parse --show-toplevel` from a plain dir returned the outer repo
 * and `git status` reported the outer repo's own untracked files; with the
 * ceiling forwarded it returned `fatal: not a git repository` (exit 128).
 *
 * That is a containment defect in its own right — a git-less session worktree
 * could have foreign repo entries, ignore verdicts and deletions merged into
 * its snapshot — and it also made every publish from such a fixture pay for a
 * scan of the whole outer repo (~1 s cold once node_modules is installed).
 * Forwarding the ceiling restores the boundary the global setup intends.
 *
 * Absent GIT_CEILING_DIRECTORIES (production) this is a no-op: the key is
 * simply not set, and git's default discovery (stopping at the filesystem
 * root or $HOME) is unchanged.
 */
function gitChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/true',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'safe.directory',
    GIT_CONFIG_VALUE_0: '*',
  };
  // Containment + durability knobs, forwarded only when the host sets them.
  // GIT_CEILING_DIRECTORIES: stop discovery ascending out of a fixture root
  // (jest.global-setup.js sets it; see the docblock above). TMPDIR: keep git's
  // scratch files on the durable volume instead of the aggressively wiped /tmp.
  for (const key of ['GIT_CEILING_DIRECTORIES', 'TMPDIR'] as const) {
    const v = process.env[key];
    if (v !== undefined && v !== '') env[key] = v;
  }
  return env;
}

/** execFile('git', …) resolving on ANY exit code (check-ignore exits 1 when
 *  nothing matched; ls-tree exits 128 on unborn HEAD — data, not failures). */
function execGit(args: string[], cwd: string, input?: string): Promise<GitOut> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git', args,
      {
        cwd,
        env: gitChildEnv(),
        timeout: 20_000,
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error && (error as any).code === 'ENOENT') return reject(error);
        if (error && ((error as any).killed || (error as any).signal)) return reject(error);
        const code = typeof (error as any)?.code === 'number' ? (error as any).code : 0;
        resolve({ code, stdout: String(stdout) });
      },
    );
    if (input !== undefined && child.stdin) {
      // A child that exits BEFORE draining stdin makes this write throw EPIPE.
      // `git check-ignore -z --stdin` does exactly that when the cwd is not a
      // repository (exit 128, "fatal: not a git repository") — it never reads
      // the batch. Before the ceiling was forwarded the same call silently
      // ASCENDED into the enclosing checkout instead, so it always consumed
      // stdin and this path never fired. The batch is best-effort INPUT; the
      // child's exit code is the answer. Swallow the write failure and let the
      // callback resolve with that code (callers already treat 128 as "fail
      // open"). Without this, a publish from any non-repository worktree
      // rejects with an unhandled EPIPE instead of producing a snapshot.
      child.stdin.on('error', () => { /* EPIPE / premature close — see above */ });
      try {
        child.stdin.write(input);
        child.stdin.end();
      } catch { /* stdin already closed by the child — see above */ }
    }
  });
}

/* ── Pure helpers (duplicated from worktree-files.ts — see header note) ── */

function parsePorcelain(z: string): Array<{ xy: string; path: string }> {
  const out: Array<{ xy: string; path: string }> = [];
  const parts = z.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    const xy = rec.slice(0, 2);
    const p = rec.slice(3);
    if (!p) continue;
    out.push({ xy, path: p });
    if (xy[0] === 'R' || xy[0] === 'C') i++; // consume the rename source record
  }
  return out;
}

function badgeFor(xy: string): 'M' | 'A' | 'D' | '?' | undefined {
  if (xy === '??') return '?';
  const [x, y] = xy;
  if (x === 'A') return 'A';
  if (x === 'R') return 'M';
  if (x === 'D' || y === 'D') return 'D';
  if (x === 'M' || y === 'M' || x === 'T' || y === 'T') return 'M';
  if (x === 'C') return 'A';
  if (x === 'U' || y === 'U') return 'M';
  return undefined;
}

function isProbablyBinary(buf: Buffer): boolean {
  if (!buf.length) return false;
  let suspicious = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0) return true;
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c && b !== 0x08) suspicious++;
    else if (b === 0x7f) suspicious++;
  }
  return suspicious / buf.length > 0.1;
}

function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/**
 * Symlink-containment for the content-read and D-merge paths (review round 2,
 * BLOCKING finding 1 — empirically proven): `fs.lstat(p)` does NOT follow a
 * symlink in the FINAL component but DOES follow INTERMEDIATE ones, so a path
 * whose parent dir was swapped for a symlink (`rm -rf foo && ln -s /outside
 * foo` with `foo/passwd` tracked) resolves OUTSIDE the worktree and would
 * publish the target's bytes. This walks the CUMULATIVE prefixes shortest
 * first — each iteration's final component is checked UN-followed, and since
 * all earlier prefixes already passed as real dirs, any symlink at any depth
 * is caught at its own iteration. Mirrors resolveSafeWorktreePath's realpath
 * containment for the snapshot publisher.
 */
async function ancestorsSymlinkFree(root: string, relPath: string): Promise<boolean> {
  const segs = relPath.split('/');
  for (let i = 1; i < segs.length; i++) {
    const prefix = path.join(root, ...segs.slice(0, i));
    const st = await fs.lstat(prefix).catch(() => null);
    if (!st) return false; // missing ancestor — the read will ENOENT anyway
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
  }
  return true;
}

/* ── Publisher ─────────────────────────────────────────────────────────── */

/**
 * Publish (or refresh) the shared snapshot for a session's worktree.
 * Never throws — best-effort by contract (a Redis/git hiccup just leaves the
 * previous snapshot, or none). Safe to call from any box; boxes without the
 * worktree on disk no-op.
 *
 * SECURITY (review round 1, ticket 1c767622 — empirically proven findings):
 *   - The walk uses lstat semantics (readdir withFileTypes does NOT follow
 *     symlinks for the entry type) and SKIPS symlinks entirely. The disk
 *     viewer's threat model (resolveSafeWorktreePath: realpath containment
 *     + resolved-segment re-check, "this serves the user's real code —
 *     non-negotiable") must hold for the publisher too: an agent-planted
 *     `ln -s /opt/... leak` or `ln -s .git/config` must never get its
 *     TARGET published to shared Redis and served back (cross-session /
 *     host disclosure). Symlinks are simply not listed — the tree is still
 *     honest (git status shows them as untracked; the FILES they point at
 *     are not part of the snapshot's contract).
 *   - Content reads are gated on isFile() (a FIFO/socket/device would hang
 *     readFile forever — killing the fire-and-forget publish — or OOM the
 *     worker via a /dev/zero symlink; stat size is 0 for those, so a size
 *     gate alone passes them).
 */
export async function publishWorktreeSnapshot(sessionId: string, origin: 'run' | 'provision' = 'run'): Promise<void> {
  try {
    const root = worktreePath(sessionId);
    const st = await fs.stat(root).catch(() => null);
    if (!st || !st.isDirectory()) return; // nothing here to publish

    // Branch label (display only) — best-effort.
    const branch = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], root)
      .then(r => (r.code === 0 ? r.stdout.trim() : ''))
      .catch(() => '');

    // 1. Walk the disk (skip .git / node_modules at every level; SKIP
    //    symlinks — see the SECURITY note above).
    const byPath = new Map<string, WorktreeSnapshotEntry>();
    let truncated = false;
    const walk = async (abs: string, rel: string): Promise<void> => {
      if (byPath.size >= MAX_SNAPSHOT_ENTRIES) { truncated = true; return; }
      const dirents = await fs.readdir(abs, { withFileTypes: true });
      for (const d of dirents) {
        const low = d.name.toLowerCase();
        if (low === '.git' || low === 'node_modules') continue;
        if (byPath.size >= MAX_SNAPSHOT_ENTRIES) { truncated = true; return; }
        // withFileTypes Dirent: isDirectory()/isFile() are LSTAT results — a
        // symlink reports isSymbolicLink() and neither of those, so the two
        // checks below skip links without following them.
        if (d.isSymbolicLink()) continue; // never follow, never list (SECURITY)
        if (!d.isDirectory() && !d.isFile()) continue; // FIFOs, sockets, devices
        const relPath = joinRel(rel, d.name);
        const entry: WorktreeSnapshotEntry = {
          path: relPath,
          name: d.name,
          type: d.isDirectory() ? 'dir' : 'file',
        };
        const fst = await fs.lstat(path.join(abs, d.name)).catch(() => null);
        if (fst) {
          if (entry.type === 'file') entry.size = fst.size;
          entry.mtime = Math.round(fst.mtimeMs);
        }
        byPath.set(relPath, entry);
        if (entry.type === 'dir') await walk(path.join(abs, d.name), relPath);
      }
    };
    await walk(root, '');

    // 2. Whole-repo porcelain → badges (one call; per-path mapping is
    //    equivalent to the disk path's per-level mapping).
    const status = await execGit(['status', '--porcelain', '-z'], root).catch(() => null);
    const badges = new Map<string, 'M' | 'A' | 'D' | '?'>();
    if (status && status.code === 0) {
      for (const { xy, path: p } of parsePorcelain(status.stdout)) {
        const badge = badgeFor(xy);
        if (!badge) continue;
        if (p.endsWith('/')) {
          // Untracked-dir collapse — badges the dir entry itself.
          badges.set(p.slice(0, -1), badge);
        } else {
          badges.set(p, badge);
        }
      }
    }

    // 3. Tracked-but-deleted files: still listed with a D badge (the disk
    //    path's ls-tree merge), with missing ancestor dirs synthesized.
    const lsTree = await execGit(['ls-tree', '-r', '-z', '-l', 'HEAD'], root).catch(() => null);
    if (lsTree && lsTree.code === 0) {
      for (const rec of lsTree.stdout.split('\0')) {
        if (!rec) continue;
        const tab = rec.indexOf('\t');
        if (tab < 0) continue;
        const meta = rec.slice(0, tab).split(/\s+/);
        const p = rec.slice(tab + 1);
        if (!p || byPath.has(p)) continue;
        if (badges.get(p) !== 'D') continue; // absent for a non-deletion reason — leave out
        if (byPath.size >= MAX_SNAPSHOT_ENTRIES) { truncated = true; break; }
        const size = /^\d+$/.test(meta[3] ?? '') ? parseInt(meta[3], 10) : undefined;
        // Containment (review round-2 B1): a D-badged path whose PARENT was
        // swapped for a symlink must not be re-added from ls-tree — the walk
        // never saw it (it wasn't walked through the link), and reading it
        // would follow the link OUTSIDE the worktree.
        if (!(await ancestorsSymlinkFree(root, p))) continue;
        byPath.set(p, { path: p, name: p.split('/').pop()!, type: 'file', status: 'D', ...(size !== undefined ? { size } : {}) });
        // Synthesize ancestor dirs so the level filter can reach this entry.
        const segs = p.split('/');
        for (let i = 1; i < segs.length; i++) {
          const dirPath = segs.slice(0, i).join('/');
          if (!byPath.has(dirPath)) byPath.set(dirPath, { path: dirPath, name: segs[i - 1], type: 'dir' });
        }
      }
    }

    // 4. Attach badges to entries (direct path hit; nested changes do not
    //    badge a dir — same rule as the disk path).
    for (const [p, badge] of badges) {
      const e = byPath.get(p);
      if (e && !e.status) e.status = badge;
    }

    const entries = [...byPath.values()];

    // 5. Ignore flags — ONE batched check-ignore over candidate paths.
    if (entries.length) {
      const candidates = entries.map(e => e.path + (e.type === 'dir' ? '/' : ''));
      // check-ignore -z --stdin needs the whole batch; chunk to keep argv sane.
      for (let i = 0; i < candidates.length; i += 500) {
        const chunk = candidates.slice(i, i + 500);
        const input = chunk.map(p => p + '\0').join('');
        const ci = await execGit(['check-ignore', '-z', '--stdin'], root, input).catch(() => null);
        if (!ci || ci.code !== 0) continue; // 1 = none ignored; 128 = git error — fail open
        for (const p of ci.stdout.split('\0')) {
          if (!p) continue;
          const e = byPath.get(p.endsWith('/') ? p.slice(0, -1) : p);
          if (e) e.ignored = true;
        }
      }
    }

    // 6. File contents — UTF-8 text ≤256KB, within the byte budget.
    //    isFile-gated via lstat (FIFOs/sockets/devices must not reach
    //    readFile — review round-1 BLOCKING finding 2) AND ancestor-checked
    //    (a symlinked parent dir would resolve outside the worktree —
    //    review round-2 BLOCKING finding 1).
    const files: Record<string, string> = {};
    let budget = MAX_CONTENT_BUDGET_BYTES;
    for (const e of entries) {
      if (budget <= 0) break;
      if (e.type !== 'file' || (e.size ?? 0) > MAX_CONTENT_FILE_BYTES) continue;
      try {
        if (!(await ancestorsSymlinkFree(root, e.path))) continue; // symlinked ancestor — skip
        const fst = await fs.lstat(path.join(root, e.path)).catch(() => null);
        if (!fst || !fst.isFile() || fst.size > MAX_CONTENT_FILE_BYTES) continue;
        const buf = await fs.readFile(path.join(root, e.path));
        if (buf.length > MAX_CONTENT_FILE_BYTES) continue;
        if (isProbablyBinary(buf.subarray(0, SNIFF_BYTES))) continue;
        if (buf.toString('utf8').includes('�')) continue; // not really UTF-8
        if (buf.length > budget) continue;
        files[e.path] = buf.toString('base64');
        budget -= buf.length;
      } catch { /* unreadable file — list it, skip its content */ }
    }

    const snapshot: WorktreeSnapshot = {
      v: 1,
      origin,
      ...(branch ? { branch } : {}),
      publishedAt: new Date().toISOString(),
      entries,
      files,
      truncated,
    };
    const client = await redis().catch(() => null);
    if (!client) return; // Redis down — keep the previous snapshot (or none)
    const fit = fitSnapshotToCeiling(snapshot, snapshotMaxBytes());
    if (fit.droppedFiles || fit.cutEntries) {
      logger.info(`worktree-snapshot: ${sessionId} trimmed ${fit.before}→${fit.after} B (dropped ${fit.droppedFiles} file bodies, cut ${fit.cutEntries} entries) to fit the Redis ceiling`);
      void import('../platform/loop-metrics.service')
        .then((m) => m.recordLoopMetric({ kind: m.LOOP_METRIC_KINDS.WORKTREE_SNAPSHOT_TRIMMED, sessionId, value: fit.after, meta: { before: fit.before, after: fit.after, droppedFiles: fit.droppedFiles, cutEntries: fit.cutEntries, origin } }))
        .catch(() => {});
    }
    await client.setEx(KEY(sessionId), SNAPSHOT_TTL_SEC, fit.json).catch(() => {});
  } catch (err: any) {
    logger.debug(`worktree-snapshot: publish failed for ${sessionId}: ${err?.message ?? err}`);
  }
}

/* ── Redis hygiene sweep (autonomy loop #14, 2026-09-21) ─────────────────── */

/** One hygiene pass per 6 h across the fleet — whichever process wins the NX lock runs it. */
export const SNAPSHOT_HYGIENE_INTERVAL_SEC = 6 * 3600;
const HYGIENE_LOCK_KEY = 'cm:wtsnap-hygiene:lock'; // outside the cm:wt-snap:* pattern on purpose
const HYGIENE_MAX_KEYS = 2000;
const HYGIENE_BUDGET_MS = 60_000;

export interface SnapshotHygieneResult {
  scanned: number;
  oversized: number;
  refitted: number;
  ttlClamped: number;
  bytesFreed: number;
  unparseable: number;
  ms: number;
}

/**
 * Re-fit the EXISTING snapshot pile to today's rules. The ceiling + 7 d TTL
 * above apply only to snapshots published after the fix; live on 2026-09-21
 * Redis still held 244 uncapped snapshots (up to 1.65 MB, 22–29 days of TTL
 * left) at 252 MB of 256 MB — the eviction pressure that took the run locks
 * would have persisted for a month. Each pass: SCAN cm:wt-snap:*, and per key
 *   - STRLEN > ceiling  → GET, parse, fitSnapshotToCeiling, SETEX with
 *                         min(remaining TTL, SNAPSHOT_TTL_SEC);
 *   - TTL > SNAPSHOT_TTL_SEC (or none) → EXPIRE to SNAPSHOT_TTL_SEC.
 * Malformed payloads are left to expire (TTL clamped). Runs from the 5-min
 * agent-run reaper (rule (i)) behind a 6 h NX lock; never throws.
 */
export async function sweepSnapshotHygiene(opts?: { force?: boolean }): Promise<SnapshotHygieneResult | null> {
  const t0 = Date.now();
  const client = await redis().catch(() => null);
  if (!client || !client.scanIterator || !client.strLen || !client.ttl || !client.expire || !client.set) return null;
  if (!opts?.force) {
    const got = await client.set(HYGIENE_LOCK_KEY, String(process.pid), { NX: true, EX: SNAPSHOT_HYGIENE_INTERVAL_SEC }).catch(() => null);
    if (got !== 'OK') return null; // another process ran it within the interval
  }
  const r: SnapshotHygieneResult = { scanned: 0, oversized: 0, refitted: 0, ttlClamped: 0, bytesFreed: 0, unparseable: 0, ms: 0 };
  const ceiling = snapshotMaxBytes();
  try {
    for await (const key of client.scanIterator({ MATCH: 'cm:wt-snap:*', COUNT: 100 })) {
      if (r.scanned >= HYGIENE_MAX_KEYS || Date.now() - t0 > HYGIENE_BUDGET_MS) break;
      r.scanned++;
      const [len, ttl] = await Promise.all([client.strLen(key).catch(() => 0), client.ttl(key).catch(() => -2)]);
      if (ttl === -2) continue; // vanished between SCAN and here
      const keepTtl = ttl > 0 ? Math.min(ttl, SNAPSHOT_TTL_SEC) : SNAPSHOT_TTL_SEC;
      if (len > ceiling) {
        r.oversized++;
        const raw = await client.get(key).catch(() => null);
        if (!raw) continue;
        let snap: WorktreeSnapshot | null = null;
        try {
          const parsed = JSON.parse(raw);
          if (parsed && parsed.v === 1 && Array.isArray(parsed.entries) && parsed.files && typeof parsed.files === 'object') snap = parsed as WorktreeSnapshot;
        } catch { /* fall through */ }
        if (!snap) {
          r.unparseable++;
          if (keepTtl !== ttl) { await client.expire(key, keepTtl).catch(() => {}); r.ttlClamped++; }
          continue;
        }
        const fit = fitSnapshotToCeiling(snap, ceiling);
        await client.setEx(key, keepTtl, fit.json).catch(() => {});
        r.refitted++;
        r.bytesFreed += Math.max(0, raw.length - fit.json.length);
        if (keepTtl !== ttl) r.ttlClamped++;
      } else if (keepTtl !== ttl) {
        await client.expire(key, keepTtl).catch(() => {});
        r.ttlClamped++;
      }
    }
  } catch (err: any) {
    logger.warn(`worktree-snapshot: hygiene sweep aborted after ${r.scanned} keys: ${err?.message ?? err}`);
  }
  r.ms = Date.now() - t0;
  if (r.refitted || r.ttlClamped) {
    logger.info(`worktree-snapshot: hygiene — scanned ${r.scanned}, oversized ${r.oversized}, refitted ${r.refitted} (freed ${Math.round(r.bytesFreed / 1024)} KB), ttl clamped ${r.ttlClamped}, unparseable ${r.unparseable}, ${r.ms} ms`);
  }
  return r;
}

/* ── Disk lock-litter sweep (Framework Operator firing 3, 2026-09-22) ───── */

export interface SnapshotLockLitterResult {
  scanned: number;
  removed: number;
  ms: number;
}

/**
 * WHY: checkpoint `git add -A` runs against a throwaway GIT_INDEX_FILE
 * (`.snap-index-<session>-<pid>-<ts>-<rand>` in WORKSPACE_ROOT). A git KILLED
 * mid-add (SIGKILL — the worker box's OOM killer) dies before git's own lock
 * cleanup, so `<tmpIndex>.lock` survives. Before firing 3 nothing ever
 * removed those locks: the snapshot path unlinked only the index, and the
 * litter piled up — 12+ zero-byte `.snap-index-*.lock` strays observed live
 * on box C's worker container (Aug 3 → Sep 18, including `.stash.<pid>.lock`
 * shapes leaked by `git stash create`). The reseed fix removes them on the
 * spot for NEW failures; THIS sweep is the safety net for the years of
 * backlog and any future leak shape (e.g. `stash create` killed after the
 * add succeeded — its lock is not covered by the reseed hook).
 *
 * SAFE BY CONSTRUCTION: zero-byte `.lock` files older than
 * SNAP_LOCK_SWEEP_MIN_AGE_MIN (60 min) are inert — a live git process holds
 * its lock for seconds; anything an hour old is abandoned. Non-empty files
 * are left alone (git locks are always 0 bytes; a non-empty stray is not
 * ours to judge). Never touches anything outside `/^\.snap-index-/` in
 * WORKSPACE_ROOT, and never the repos/ or worktrees/ subtrees.
 */
export const SNAP_LOCK_SWEEP_MAX_FILES = 500;
export const SNAP_LOCK_SWEEP_MIN_AGE_MIN = 60;
const SNAP_LOCK_RE = /^\.snap-index-/;

export async function sweepSnapshotLockLitter(opts?: { force?: boolean }): Promise<SnapshotLockLitterResult | null> {
  const t0 = Date.now();
  const r: SnapshotLockLitterResult = { scanned: 0, removed: 0, ms: 0 };
  try {
    const entries = await fs.readdir(WORKSPACE_ROOT, { withFileTypes: true }).catch(() => null);
    if (!entries) return r;
    const cutoff = Date.now() - SNAP_LOCK_SWEEP_MIN_AGE_MIN * 60_000;
    for (const e of entries) {
      if (r.scanned >= SNAP_LOCK_SWEEP_MAX_FILES) break;
      if (!e.isFile() || !SNAP_LOCK_RE.test(e.name)) continue;
      r.scanned++;
      const full = path.join(WORKSPACE_ROOT, e.name);
      const st = await fs.stat(full).catch(() => null);
      if (!st || st.size !== 0 || st.mtimeMs >= cutoff) continue;
      await fs.unlink(full).catch(() => null);
      r.removed++;
    }
  } catch (err: any) {
    logger.warn(`worktree-snapshot: lock-litter sweep aborted: ${err?.message ?? err}`);
  }
  r.ms = Date.now() - t0;
  if (r.removed) {
    logger.info(`worktree-snapshot: lock litter — scanned ${r.scanned}, removed ${r.removed} stale .snap-index-* lock strays (${r.ms} ms)`);
  }
  return r;
}

export async function getWorktreeSnapshot(sessionId: string): Promise<WorktreeSnapshot | null> {
  try {
    const client = await import('../../../config/redis').then(m => (m as any).default as RedisLike).catch(() => null);
    if (!client) return null;
    const raw = await client.get(KEY(sessionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WorktreeSnapshot;
    if (parsed?.v !== 1 || !Array.isArray(parsed.entries)) return null;
    return parsed;
  } catch {
    return null; // corrupt payload or Redis hiccup — degrade to no snapshot
  }
}

export function snapshotMeta(s: WorktreeSnapshot): SnapshotMeta {
  return { publishedAt: s.publishedAt, ...(s.branch ? { branch: s.branch } : {}) };
}

/** Hygiene hook for worktree removal (reap / session delete) — best-effort. */
export async function deleteWorktreeSnapshot(sessionId: string): Promise<void> {
  try {
    const client = await import('../../../config/redis').then(m => (m as any).default as RedisLike).catch(() => null);
    if (!client) return;
    await client.del(KEY(sessionId)).catch(() => {});
  } catch { /* TTL is the backstop */ }
}

/* ── Serving helpers (used by worktree-files' fallback path) ───────────── */

/**
 * Lexical-only validation + normalization of a request path against the
 * snapshot's canonical forward-slash key space. Mirrors resolveSafeWorktreePath's
 * request-side guards (no realpath possible — there is no disk here; a JSON key
 * lookup cannot traverse, so lexical equality is the whole attack surface).
 */
export function normalizeSnapshotPath(relPath: string): string {
  const rel0 = relPath ?? '';
  if (typeof rel0 !== 'string') throw new Error('path must be a string');
  if (rel0.includes('\0') || rel0.includes('\\')) throw new Error('Invalid path');
  if (path.posix.isAbsolute(rel0) || /^[a-zA-Z]:/.test(rel0)) throw new Error('Absolute paths are not allowed');
  if (rel0.split('/').some(s => s === '..')) throw new Error('Path escapes the worktree');
  const normSegments = path.posix.normalize(rel0).split('/').filter(s => s && s !== '.');
  for (const seg of normSegments) {
    const low = seg.toLowerCase();
    if (low === '.git' || low === 'node_modules') throw new Error(`Access to ${low === '.git' ? '.git' : 'node_modules'} is not allowed`);
  }
  return normSegments.join('/');
}

/**
 * One directory level out of the snapshot: direct children of `rel` ('' = root),
 * dirs before files (codepoint order — identical to listDirLevel's sort), with
 * the ignore filter applied unless showIgnored.
 */
export function snapshotLevel(
  snap: WorktreeSnapshot,
  rel: string,
  showIgnored: boolean,
): { entries: WorktreeSnapshotEntry[]; truncated: boolean } {
  const prefix = rel ? `${rel}/` : '';
  const level: WorktreeSnapshotEntry[] = [];
  for (const e of snap.entries) {
    if (!prefix) {
      if (e.path.includes('/')) continue;
    } else {
      if (!e.path.startsWith(prefix)) continue;
      if (e.path.slice(prefix.length).includes('/')) continue;
    }
    if (!showIgnored && e.ignored) continue;
    level.push(e);
  }
  level.sort((a, b) => (a.type === b.type
    ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    : a.type === 'dir' ? -1 : 1));
  return { entries: level, truncated: !!snap.truncated && rel === '' };
}
