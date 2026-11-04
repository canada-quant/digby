/**
 * PER-USER WORKSPACE SUBTREE — the volume layout (build 2026-10-08 ISO-1;
 * docs: the isolation.md deep dive, option A).
 *
 * Today every worktree, every project mirror and every per-session HOME sits in
 * ONE flat namespace on the coding volume:
 *     <root>/worktrees/<sessionId>            (legacy)
 *     <root>/repos/<projectId>.git            (legacy)
 *     <root>/worktrees/.sandbox-home/<sid>    (legacy)
 * so any shell that mounts the volume (the owner's dev container, a
 * whole-volume fallback container) sees every tenant. The per-user layout puts
 * a user's data under ONE directory that can be mounted on its own:
 *     <root>/<userKey>/worktrees/<sessionId>
 *     <root>/<userKey>/repos/<projectId>.git   (mirrors of projects the user OWNS)
 *     <root>/<userKey>/.sandbox-home/<sessionId>
 * where <userKey> is the first 12 characters of the user id (the same prefix
 * the dev container is named after) and the directory carries a marker file
 * holding the full user id.
 *
 * THIS MODULE IS A LEAF (path + sync fs only, no DB): the placement decision
 * that needs the DB lives in workspace-placement.ts.
 *
 * DUAL-READ IS ALWAYS ON (not a switch): `resolveWorktreePathSync` /
 * `resolveMirrorPathSync` return wherever the data physically IS — a legacy
 * real directory first (today's answer, byte-identical when nothing was ever
 * placed per-user), else a per-user directory found on disk, else the legacy
 * path. A migrated session leaves a relative compatibility symlink at its
 * legacy path; the resolvers follow it to the physical path. The switch
 * (CODING_WORKSPACE_PER_USER_SUBTREE) only decides where NEW data goes and how
 * containers mount it — turning it off never orphans data placed while it was
 * on (the migration script's --revert moves data back).
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

/** The single switch for the per-user layout (off | 1 | comma-list of user ids / ≥8-char id prefixes). */
export const PER_USER_SUBTREE_ENV = 'CODING_WORKSPACE_PER_USER_SUBTREE';
/** Marker file at the root of every per-user subtree — JSON { userId, createdAt }. */
export const SUBTREE_MARKER = '.digby-user-subtree';
/** Top-level names on the volume that are never a user key. */
const RESERVED_TOP = new Set(['repos', 'worktrees', 'devcontainers']);

/** The volume root — the SAME expression workspace.service uses (both evaluate at import). */
export const LAYOUT_ROOT: string = process.env.CODING_WORKSPACE_ROOT || '/app/coding-workspaces';

// ── The switch ───────────────────────────────────────────────────────────────

export type UserSwitchSetting = { mode: 'off' } | { mode: 'all' } | { mode: 'users'; ids: string[] };
export type PerUserSubtreeSetting = UserSwitchSetting;

/**
 * Parse a per-user canary switch (read per call so ops can flip it live):
 * unset / 0 / off → off; 1 / on / all → everyone; otherwise a comma / space
 * separated list of user ids or ≥8-char id prefixes (the canary). Pure.
 * Shared by CODING_WORKSPACE_PER_USER_SUBTREE and CODING_CREDENTIAL_PROXY.
 */
export function userSwitchSetting(envName: string, env: NodeJS.ProcessEnv = process.env): UserSwitchSetting {
  const raw = String(env[envName] ?? '').trim();
  if (!raw || ['0', 'false', 'off', 'no'].includes(raw.toLowerCase())) return { mode: 'off' };
  if (['1', 'true', 'on', 'yes', 'all'].includes(raw.toLowerCase())) return { mode: 'all' };
  const ids = raw.split(/[\s,]+/).map((s) => s.trim()).filter((s) => s.length >= 8);
  return ids.length ? { mode: 'users', ids } : { mode: 'off' };
}

/** Does a per-user canary switch apply to this user? (full id or a ≥8-char prefix). Pure. */
export function userSwitchAppliesTo(envName: string, userId: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!userId) return false;
  const s = userSwitchSetting(envName, env);
  if (s.mode === 'off') return false;
  if (s.mode === 'all') return true;
  return s.ids.some((id) => userId === id || userId.startsWith(id));
}

/** The per-user layout switch, parsed. */
export function perUserSubtreeSetting(env: NodeJS.ProcessEnv = process.env): PerUserSubtreeSetting {
  return userSwitchSetting(PER_USER_SUBTREE_ENV, env);
}

/** Does the per-user layout apply to NEW data of this user? */
export function perUserSubtreeAppliesTo(userId: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return userSwitchAppliesTo(PER_USER_SUBTREE_ENV, userId, env);
}

// ── Keys + paths ─────────────────────────────────────────────────────────────

/**
 * The subtree directory name for a user: the 12-char id prefix (uuid ids →
 * `83e4fbf9-e18`), or — for an id whose prefix is not a safe directory name or
 * collides with a reserved top-level name — `u` + 11 hex of sha1(id). Pure.
 */
export function userSubtreeKey(userId: string): string {
  const raw = String(userId || '').slice(0, 12);
  if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,11}$/.test(raw) && !RESERVED_TOP.has(raw.toLowerCase())) return raw;
  return `u${createHash('sha1').update(String(userId || '')).digest('hex').slice(0, 11)}`;
}

export const legacyWorktreePath = (sessionId: string, root = LAYOUT_ROOT): string => path.join(root, 'worktrees', sessionId);
export const legacyMirrorPath = (projectId: string, root = LAYOUT_ROOT): string => path.join(root, 'repos', `${projectId}.git`);
export const legacySandboxHome = (sessionId: string, root = LAYOUT_ROOT): string => path.join(root, 'worktrees', '.sandbox-home', sessionId);

export const subtreeRoot = (key: string, root = LAYOUT_ROOT): string => path.join(root, key);
export const subtreeWorktreePath = (key: string, sessionId: string, root = LAYOUT_ROOT): string => path.join(root, key, 'worktrees', sessionId);
export const subtreeMirrorPath = (key: string, projectId: string, root = LAYOUT_ROOT): string => path.join(root, key, 'repos', `${projectId}.git`);
export const subtreeSandboxHome = (key: string, sessionId: string, root = LAYOUT_ROOT): string => path.join(root, key, '.sandbox-home', sessionId);
export const subtreeSandboxHomesRoot = (key: string, root = LAYOUT_ROOT): string => path.join(root, key, '.sandbox-home');

/**
 * The volume-relative subpath of an absolute path under the root (for docker
 * `volume-subpath=`), or null when the path is not strictly below the root. Pure.
 */
export function volumeSubpathOf(abs: string, root = LAYOUT_ROOT): string | null {
  const rel = path.posix.relative(path.posix.normalize(root), path.posix.normalize(abs));
  if (!rel || rel.startsWith('..') || path.posix.isAbsolute(rel)) return null;
  return rel;
}

/**
 * The per-user key a path lives under (`<root>/<key>/…`), or null for a legacy
 * / reserved / dot path. Pure (no marker check) — pair with isSubtreeKeySync
 * when the answer must be backed by a real subtree.
 */
export function pathSubtreeKey(abs: string, root = LAYOUT_ROOT): string | null {
  const rel = volumeSubpathOf(abs, root);
  if (!rel) return null;
  const first = rel.split('/')[0];
  if (!first || first.startsWith('.') || RESERVED_TOP.has(first)) return null;
  return first;
}

// ── Sync fs helpers (never throw) ────────────────────────────────────────────

function lstatSafe(p: string): fs.Stats | null {
  try { return fs.lstatSync(p); } catch { return null; }
}
function isDirSync(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
function linkTargetSafe(p: string): string | null {
  try { return path.resolve(path.dirname(p), fs.readlinkSync(p)); } catch { return null; }
}

/** Is `<root>/<key>` a real per-user subtree (a directory carrying the marker)? */
export function isSubtreeKeySync(key: string, root = LAYOUT_ROOT): boolean {
  if (!key || key.startsWith('.') || RESERVED_TOP.has(key)) return false;
  try { return fs.statSync(path.join(root, key, SUBTREE_MARKER)).isFile(); } catch { return false; }
}

/** The user id recorded in a subtree's marker (null when unreadable). */
export function subtreeOwnerSync(key: string, root = LAYOUT_ROOT): string | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, key, SUBTREE_MARKER), 'utf8'));
    return typeof j?.userId === 'string' ? j.userId : null;
  } catch { return null; }
}

/** Every per-user subtree key on the volume (marker-backed). Uncached — one readdir. */
export function listSubtreeKeysSync(root = LAYOUT_ROOT): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || RESERVED_TOP.has(e.name)) continue;
    if (isSubtreeKeySync(e.name, root)) out.push(e.name);
  }
  return out.sort();
}

/**
 * Create (idempotently) the user's subtree root + marker. Throws when the key
 * is already taken by a DIFFERENT user (a 12-char prefix collision) — the
 * caller then keeps the legacy placement. Returns the key.
 */
export function ensureUserSubtreeSync(userId: string, root = LAYOUT_ROOT): string {
  const key = userSubtreeKey(userId);
  const dir = path.join(root, key);
  fs.mkdirSync(dir, { recursive: true });
  const marker = path.join(dir, SUBTREE_MARKER);
  const owner = subtreeOwnerSync(key, root);
  if (owner === null) {
    try {
      fs.writeFileSync(marker, `${JSON.stringify({ userId, createdAt: new Date().toISOString() })}\n`, { flag: 'wx' });
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
    }
  }
  const finalOwner = subtreeOwnerSync(key, root);
  if (finalOwner !== userId) {
    throw new Error(`workspace subtree ${key} belongs to another user — keeping the legacy layout`);
  }
  return key;
}

// ── Dual-read resolvers ──────────────────────────────────────────────────────

/** Physical path memo (validated on every hit). Keys `w:<sid>` / `m:<pid>`. */
const memo = new Map<string, string>();
/** Test seam. */
export function __resetLayoutMemoForTest(): void { memo.clear(); }
/** Record where a session's worktree / a project's mirror was just placed (same-process fast path). */
export function noteWorktreePlacement(sessionId: string, abs: string): void { memo.set(`w:${sessionId}`, abs); }
export function noteMirrorPlacement(projectId: string, abs: string): void { memo.set(`m:${projectId}`, abs); }
export function forgetPlacement(sessionId?: string, projectId?: string): void {
  if (sessionId) memo.delete(`w:${sessionId}`);
  if (projectId) memo.delete(`m:${projectId}`);
}

function resolveDualRead(memoKey: string, legacy: string, candidate: (key: string) => string, root: string): string {
  const hit = memo.get(memoKey);
  if (hit && isDirSync(hit)) return hit;
  if (hit) memo.delete(memoKey);
  const st = lstatSafe(legacy);
  if (st?.isDirectory()) return legacy; // today's answer
  if (st?.isSymbolicLink()) {
    // A migrated item's compatibility link → its physical per-user home.
    // Resolved lexically against the link's own dir (NOT realpath) so the
    // answer keeps the configured root prefix the volume-subpath math needs.
    const target = linkTargetSafe(legacy);
    if (target && pathSubtreeKey(target, root) && isDirSync(target)) { memo.set(memoKey, target); return target; }
    return legacy;
  }
  for (const key of listSubtreeKeysSync(root)) {
    const p = candidate(key);
    if (isDirSync(p)) { memo.set(memoKey, p); return p; }
  }
  return legacy;
}

/** Where a session's worktree physically is (legacy path when it exists nowhere). */
export function resolveWorktreePathSync(sessionId: string, root = LAYOUT_ROOT): string {
  return resolveDualRead(`w:${sessionId}`, legacyWorktreePath(sessionId, root), (k) => subtreeWorktreePath(k, sessionId, root), root);
}

/** Where a project's mirror physically is (legacy path when it exists nowhere). */
export function resolveMirrorPathSync(projectId: string, root = LAYOUT_ROOT): string {
  return resolveDualRead(`m:${projectId}`, legacyMirrorPath(projectId, root), (k) => subtreeMirrorPath(k, projectId, root), root);
}

/**
 * A session's durable sandbox HOME: in its worktree's subtree when the worktree
 * is placed per-user (or a per-user home already exists), else the legacy home.
 */
export function resolveSandboxHomeSync(sessionId: string, root = LAYOUT_ROOT): string {
  const wt = resolveWorktreePathSync(sessionId, root);
  const key = pathSubtreeKey(wt, root);
  if (key) return subtreeSandboxHome(key, sessionId, root);
  const legacy = legacySandboxHome(sessionId, root);
  if (isDirSync(legacy)) return legacy;
  for (const k of listSubtreeKeysSync(root)) {
    const p = subtreeSandboxHome(k, sessionId, root);
    if (isDirSync(p)) return p;
  }
  return legacy;
}

/** Is the legacy worktree path a compatibility symlink left by a migration? */
export function isMigratedCompatLinkSync(legacyAbs: string): boolean {
  return !!lstatSafe(legacyAbs)?.isSymbolicLink();
}

/**
 * The bare mirror a linked worktree points at (from its `.git` FILE —
 * `gitdir: <mirror>/worktrees/<name>`), or null (a standalone/blank repo, or
 * unreadable). Sync, never throws.
 */
export function mirrorOfWorktreeSync(wt: string): string | null {
  try {
    const st = fs.lstatSync(path.join(wt, '.git'));
    if (!st.isFile()) return null;
    const m = fs.readFileSync(path.join(wt, '.git'), 'utf8').match(/^gitdir:\s*(.+?)\s*$/m);
    if (!m) return null;
    const gitdir = m[1];
    const parts = gitdir.split('/');
    const i = parts.lastIndexOf('worktrees');
    if (i <= 0) return null;
    return parts.slice(0, i).join('/') || null;
  } catch { return null; }
}

// ── Census helpers ───────────────────────────────────────────────────────────

export interface PerUserWorktreeDir { sessionId: string; mtimeMs: number; key: string; path: string }

/** Session worktree dirs under every per-user subtree (dot-entries skipped). */
export function listPerUserWorktreeDirsSync(root = LAYOUT_ROOT): PerUserWorktreeDir[] {
  const out: PerUserWorktreeDir[] = [];
  for (const key of listSubtreeKeysSync(root)) {
    const dir = path.join(root, key, 'worktrees');
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      try { out.push({ sessionId: e.name, mtimeMs: fs.statSync(p).mtimeMs, key, path: p }); } catch { /* vanished */ }
    }
  }
  return out;
}

/** Every sandbox-homes root on the volume: the legacy one + one per subtree. */
export function listSandboxHomeRootsSync(root = LAYOUT_ROOT): string[] {
  return [path.join(root, 'worktrees', '.sandbox-home'), ...listSubtreeKeysSync(root).map((k) => subtreeSandboxHomesRoot(k, root))];
}

// ── Guard telemetry: does a refused reference reach ANOTHER tenant's data? ──

export interface RefTenancyInput {
  exposure: 'dev_container' | 'whole_volume' | 'user_subtree';
  /** the session owner's subtree key (whether or not it exists yet) */
  ownKey: string | null;
  ownSessionIds: ReadonlySet<string>;
  ownProjectIds: ReadonlySet<string>;
  /** extra paths this shell can see under a user_subtree exposure (its own mirror) */
  visibleExtra?: string[];
}

/**
 * build 2026-10-08 ISO — the deciding metric for the per-user subtree rollout
 * ("cross-tenant path references that REACH REAL DATA = 0"). For each path a
 * guard verdict named: is it another tenant's (or a listing that enumerates
 * every tenant), and could this exposure actually read it (mounted here AND on
 * disk)? Glob refs are judged by their literal prefix directory. Never throws.
 */
export function classifyRefTenancy(refs: string[], input: RefTenancyInput, root = LAYOUT_ROOT): { crossTenant: number; reachesData: number } {
  let crossTenant = 0;
  let reachesData = 0;
  const whole = input.exposure !== 'user_subtree';
  const ownRoot = input.ownKey ? path.join(root, input.ownKey) : null;
  const visible = (p: string): boolean => {
    if (whole) return true;
    if (ownRoot && (p === ownRoot || p.startsWith(`${ownRoot}/`))) return true;
    return (input.visibleExtra ?? []).some((v) => !!v && (p === v || p.startsWith(`${v}/`)));
  };
  const exists = (p: string): boolean => { try { fs.statSync(p); return true; } catch { return false; } };
  for (const raw of refs) {
    try {
      let ref = path.posix.normalize(String(raw || ''));
      const g = ref.search(/[*?[{]/);
      if (g >= 0) ref = ref.slice(0, ref.lastIndexOf('/', g)) || '/';
      if (ref.length > 1 && ref.endsWith('/')) ref = ref.slice(0, -1);
      const rel = volumeSubpathOf(ref, root);
      if (rel === null) {
        // The root itself or an ANCESTOR of it (find / …): a walk that enters every tenant.
        if (ref === root || root.startsWith(ref === '/' ? '/' : `${ref}/`)) { crossTenant++; if (whole) reachesData++; }
        continue;
      }
      const seg = rel.split('/');
      const first = seg[0];
      if (seg.length === 1 && (first === 'worktrees' || first === 'repos')) { crossTenant++; if (whole) reachesData++; continue; }
      if (first === 'worktrees') {
        if (seg[1] === '.sandbox-home') {
          // On-volume homes are tmpfs-masked in every whole-volume / dev shell — never readable there.
          if (seg[2] && !input.ownSessionIds.has(seg[2])) crossTenant++;
          continue;
        }
        if (input.ownSessionIds.has(seg[1])) continue;
        crossTenant++;
        // "Reaches data" = the TENANT's directory is on disk and mounted here
        // (the named file itself may not exist — the dir is still readable).
        const tenantDir = path.join(root, 'worktrees', seg[1]);
        if (visible(tenantDir) && exists(tenantDir)) reachesData++;
        continue;
      }
      if (first === 'repos') {
        const pid = (seg[1] || '').replace(/\.git$/, '');
        if (input.ownProjectIds.has(pid)) continue;
        crossTenant++;
        const tenantDir = path.join(root, 'repos', seg[1] || '');
        if (visible(tenantDir) && exists(tenantDir)) reachesData++;
        continue;
      }
      if (first === 'devcontainers') { crossTenant++; continue; } // root-owned tailnet state — never readable by uid 1001
      if (input.ownKey && first === input.ownKey) continue;
      if (first.startsWith('.')) continue; // harness scratch at the root (lock files, the add-ignore file)
      crossTenant++;
      const tenantDir = path.join(root, first);
      if (visible(tenantDir) && exists(tenantDir)) reachesData++;
    } catch { /* one bad ref never breaks the tally */ }
  }
  return { crossTenant, reachesData };
}
