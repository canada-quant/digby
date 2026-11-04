/**
 * DEPENDENCY ADVISORIES — a known-vulnerability lookup on the project's
 * PRODUCTION npm dependencies, run by open_pull_request.
 *
 * Why (2026-10-12 credential incident; docs/FRAMEWORK_LESSONS.md): a project's
 * public web app ran a framework version with a public, actively exploited,
 * CVSS-10 remote-code-execution advisory for months. Agent lanes opened dozens
 * of PRs on that repo and redeployed it, and nothing in the loop ever looked at
 * the framework version — the app was the way into a host that held other
 * projects' credentials. A lane cannot be expected to remember every advisory;
 * the harness can look them up.
 *
 * What it does (fail-open, never throws, bounded by ADVISORY_DEADLINE_MS):
 *   1. finds the project's package.json manifests (root + two levels down,
 *      never node_modules / dot-dirs; ≤ MAX_MANIFESTS);
 *   2. resolves each PRODUCTION dependency (`dependencies`, not dev) to the
 *      version the lockfile actually installs (package-lock.json v2/v3 or
 *      pnpm-lock.yaml importers; an exact package.json pin as the fallback);
 *   3. asks OSV (api.osv.dev — the GitHub Advisory Database plus others) which
 *      advisories cover those name@versions, then reads each advisory's
 *      severity and fixed version;
 *   4. returns CRITICAL / HIGH findings that are not withdrawn.
 *
 * Observe-only by design (the 2026-09-11 gate flip): the PR still opens. The
 * finding rides the tool result (the lane sees it), the PR body (the owner sees
 * it on GitHub) and a loop_metrics `dependency_advisory` row.
 *
 * Kill switch DEPENDENCY_ADVISORY_CHECK_DISABLED=1 (read per call).
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { git as gitRunner } from './workspace.service';

export const OSV_API = 'https://api.osv.dev/v1';
export const ADVISORY_DEADLINE_MS = 12_000;
const MAX_MANIFESTS = 24;
const MAX_DETAIL_FETCHES = 30;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'target']);
const GIT_TREE_TIMEOUT_MS = 15_000;

export type AdvisorySeverity = 'CRITICAL' | 'HIGH';

export interface ResolvedDep {
  name: string;
  version: string;
  manifest: string; // repo-relative package.json path
}

export interface AdvisoryFinding {
  pkg: string;
  version: string;
  manifest: string;
  id: string;
  aliases: string[];
  severity: AdvisorySeverity;
  summary: string;
  fixed: string | null;
}

export interface AdvisoryReport {
  findings: AdvisoryFinding[];
  manifests: string[];
  packages: number;
  error?: string;
  /** Which dependency state was read: the git tree at the PR head ('pr-head')
   *  or the on-disk worktree ('worktree' — the fallback, and the only source
   *  before 4dbd09fa). The observability that would have caught the PR #1488
   *  false report at a glance. */
  source?: 'pr-head' | 'worktree';
}

export function dependencyAdvisoryCheckDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DEPENDENCY_ADVISORY_CHECK_DISABLED === '1';
}

// ── version helpers ───────────────────────────────────────────────────────────

/** Strip pnpm's peer suffix ("15.3.1(@babel/core@7.29.0)…") and quotes. */
export function cleanVersion(v: string): string {
  return String(v || '').trim().replace(/^['"]|['"]$/g, '').replace(/\(.*$/, '').trim();
}

const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Numeric x.y.z compare; a prerelease sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core, pre] = cleanVersion(v).split('-', 2);
    return { nums: core.split('.').map(n => parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

// ── lockfile parsing (pure) ───────────────────────────────────────────────────

/** package-lock.json v2/v3: the version installed at node_modules/<name>. */
export function versionFromPackageLock(lockJson: unknown, name: string): string | null {
  const pkgs = (lockJson as any)?.packages;
  const v = pkgs?.[`node_modules/${name}`]?.version;
  if (typeof v === 'string' && v) return cleanVersion(v);
  const legacy = (lockJson as any)?.dependencies?.[name]?.version; // lockfile v1
  return typeof legacy === 'string' && legacy ? cleanVersion(legacy) : null;
}

/**
 * pnpm-lock.yaml (v6–v9): the `importers` entry for `importer` (".", or the
 * workspace-relative dir), its `dependencies:` map → name → version. A small
 * indentation-driven reader — enough for the shape pnpm writes; no YAML dep.
 */
export function pnpmImporterVersions(lockText: string, importer = '.'): Map<string, string> {
  const out = new Map<string, string>();
  const lines = String(lockText || '').split(/\r?\n/);
  const unq = (s: string) => s.trim().replace(/:$/, '').replace(/^['"]|['"]$/g, '');
  let i = lines.findIndex(l => /^importers:\s*$/.test(l));
  if (i < 0) return out;
  // find "  <importer>:" directly under importers
  for (i = i + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\S/.test(l)) return out; // left the importers block
    const m = /^ {2}(\S.*):\s*$/.exec(l);
    if (m && unq(m[1]) === importer) break;
  }
  if (i >= lines.length) return out;
  let inDeps = false;
  let current: string | null = null;
  for (i = i + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^ {0,2}\S/.test(l)) break; // next importer / top-level key
    const section = /^ {4}(\S[^:]*):\s*$/.exec(l);
    if (section) { inDeps = section[1].trim() === 'dependencies'; current = null; continue; }
    if (!inDeps) continue;
    const dep = /^ {6}(\S.*):\s*$/.exec(l);
    if (dep) { current = unq(dep[1]); continue; }
    const ver = /^ {8}version:\s*(.+)$/.exec(l);
    if (ver && current) { out.set(current, cleanVersion(ver[1])); current = null; continue; }
    const inline = /^ {6}(\S.*?):\s+(\S.*)$/.exec(l); // lockfile v5: "name: 1.2.3"
    if (inline) out.set(unq(inline[1]), cleanVersion(inline[2]));
  }
  return out;
}

// ── manifest discovery ────────────────────────────────────────────────────────

/**
 * Bounded tree-shape reads for GitTreeIO: the direct children of one tree dir,
 * and whether a dir holds a package.json. Never file contents.
 *
 * These run through the SHARED workspace.service git() runner — never a
 * hand-rolled execFile — for two load-bearing reasons (peer-review relay,
 * ticket 4dbd09fa): (1) gitEnv()'s subprocess-scoped
 * safe.directory='*' survives uid-drifted worktrees (the 2026-08-02 prod
 * class: "fatal: detected dubious ownership", 49 fails/48h) — a bespoke
 * runner would die there and the scan would silently fall back to the stale
 * DISK walk, resurrecting exactly the defect this fix kills; (2) git()
 * redacts credential-bearing errors (backlog audit T7). Never bypass it.
 */
async function treeDir(worktree: string, ref: string, dir: string): Promise<{ name: string; isDir: boolean }[]> {
  // No pathspec at the root — git rejects the empty string ("empty string is
  // not a valid pathspec"), which would kill the whole walk. `<dir>/` lists
  // that one level; the default format carries the object TYPE so plain files
  // are never "recursed" into.
  const args = dir ? ['ls-tree', '-z', ref, `${dir}/`] : ['ls-tree', '-z', ref];
  const { stdout } = await gitRunner(['-C', worktree, ...args], undefined, GIT_TREE_TIMEOUT_MS);
  const prefix = dir ? `${dir}/` : '';
  const out: { name: string; isDir: boolean }[] = [];
  for (const rec of String(stdout).split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const meta = rec.slice(0, tab).split(/\s+/);
    let p = rec.slice(tab + 1);
    if (prefix && p.startsWith(prefix)) p = p.slice(prefix.length);
    if (p) out.push({ name: p, isDir: meta[1] === 'tree' });
  }
  return out;
}

/** One file's bytes from the git tree at `ref` (null when git cannot produce it). */
export async function readGitFile(worktree: string, ref: string, file: string): Promise<string | null> {
  try {
    const { stdout } = await gitRunner(['-C', worktree, 'show', `${ref}:${file}`], undefined, GIT_TREE_TIMEOUT_MS);
    return stdout;
  } catch { return null; }
}

/** True when the git tree at `ref` has a package.json directly in `dir`. */
async function treeHasPkg(worktree: string, ref: string, dir: string): Promise<boolean> {
  const spec = dir ? `${dir}/package.json` : 'package.json';
  try {
    // -z, exact-bytes compare: the human-readable format C-quotes non-ASCII
    // paths (core.quotepath=1) and a `trim()` would eat a significant leading
    // space — both silently DROPPED the manifest from the head scan (adversarial
    // review of 4dbd09fa, end-to-end confirmed: a `décor/package.json` head-tree
    // advisory vanished while the disk walk saw it). -z emits paths verbatim,
    // NUL-separated, quoting disabled.
    const { stdout } = await gitRunner(['-C', worktree, 'ls-tree', '-z', '--name-only', ref, spec], undefined, GIT_TREE_TIMEOUT_MS);
    return String(stdout).split('\0').some(p => p === spec);
  } catch { return false; }
}

/** How resolveProductionDeps sees files. Default = the worktree disk; the open_pull_request path passes the pushed PR head's tree. */
export interface DepFileIO {
  /** Repo-relative paths of every directory that holds a package.json (root first). */
  findManifestDirs(): Promise<string[]>;
  /** A file's utf8 body (null = absent/unreadable). */
  read(rel: string): Promise<string | null>;
  /** Nearest package-lock.json / pnpm-lock.yaml at or above `rel`-dir, inside root. */
  nearestLockFor(dir: string): Promise<{ kind: 'npm' | 'pnpm'; rel: string; dir: string } | null>;
  /** 'disk' | 'git-tree' — for telemetry. */
  readonly source: 'disk' | 'git-tree';
}

/** DISK io (the historical behaviour, used by any caller that passes no io). */
class DiskIO implements DepFileIO {
  readonly source = 'disk' as const;
  constructor(private readonly root: string) {}
  async findManifestDirs(): Promise<string[]> { return (await findManifests(this.root)).map(d => path.relative(this.root, d) || '.'); }
  async read(rel: string): Promise<string | null> {
    const abs = path.resolve(this.root, rel);
    if (abs !== path.resolve(this.root) && !abs.startsWith(path.resolve(this.root) + path.sep)) return null; // jail
    try { return await fs.readFile(abs, 'utf8'); } catch { return null; }
  }
  async nearestLockFor(dir: string): Promise<{ kind: 'npm' | 'pnpm'; rel: string; dir: string } | null> {
    const lock = await nearestLock(this.root, path.resolve(this.root, dir));
    if (!lock) return null;
    return { kind: lock.kind, rel: path.relative(this.root, lock.file), dir: path.relative(this.root, lock.dir) || '.' };
  }
}

/**
 * GIT-TREE io — the fix for ticket 4dbd09fa. open_pull_request must describe the
 * dependency state OF THE PUSHED PR HEAD, and the lane's on-disk worktree can
 * be anything else entirely (on the explicit-head path it is by definition an
 * unrelated checkout; even on the session path a long-lived worktree can lag
 * the pushed head). Production evidence: PR #1488's body reported the exact
 * pre-#1453 axios/@modelcontextprotocol/sdk versions on a PR whose head tree
 * carried the fixed floors — the scan had read the lane's stale disk, whose
 * bytes matched 6f960571 (the commit before the bump), not 4eb3f3fe (the head).
 *
 * Reads are bounded by the same MAX_MANIFESTS / two-level / SKIP_DIRS rules as
 * the disk walk. Any git failure returns an empty shape (fail-open — the caller
 * keeps the old behaviour of reporting no manifests rather than throwing).
 */
export class GitTreeIO implements DepFileIO {
  readonly source = 'git-tree' as const;
  constructor(private readonly worktree: string, private readonly ref: string) {}
  async findManifestDirs(): Promise<string[]> {
    const dirs: string[] = [];
    const walk = async (dir: string, depth: number) => {
      if (dirs.length >= MAX_MANIFESTS) return;
      // '.' (not '') for the root — the same convention DiskIO returns, which
      // resolveProductionDeps keys its reads on.
      if (await treeHasPkg(this.worktree, this.ref, dir)) dirs.push(dir || '.');
      if (depth >= 2) return;
      let entries: { name: string; isDir: boolean }[] = [];
      try { entries = await treeDir(this.worktree, this.ref, dir); } catch { return; }
      for (const e of entries) {
        if (dirs.length >= MAX_MANIFESTS) return;
        if (!e.isDir || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
        await walk(dir ? `${dir}/${e.name}` : e.name, depth + 1);
      }
    };
    try { await walk('', 0); } catch { return dirs; }
    return dirs;
  }
  async read(rel: string): Promise<string | null> {
    if (!rel || rel.startsWith('/') || rel.split('/').some(seg => seg === '..' || seg === '.')) return null;
    return readGitFile(this.worktree, this.ref, rel);
  }
  async nearestLockFor(dir: string): Promise<{ kind: 'npm' | 'pnpm'; rel: string; dir: string } | null> {
    // Walk UP from the manifest dir to the root, exactly like the disk reader's
    // nearestLock — but over tree paths ("a/b" → "a" → "."). Never escapes the
    // root: "." is the last iteration.
    let cur = dir || '.';
    for (;;) {
      const base = cur === '.' ? '' : `${cur}/`;
      const npm = await this.read(`${base}package-lock.json`);
      if (npm !== null) return { kind: 'npm', rel: `${base}package-lock.json`, dir: cur };
      const pnpm = await this.read(`${base}pnpm-lock.yaml`);
      if (pnpm !== null) return { kind: 'pnpm', rel: `${base}pnpm-lock.yaml`, dir: cur };
      if (cur === '.') return null;
      cur = cur.includes('/') ? cur.slice(0, cur.lastIndexOf('/')) : '.';
    }
  }
}

async function findManifests(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (found.length >= MAX_MANIFESTS) return;
    let entries: import('fs').Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some(e => e.isFile() && e.name === 'package.json')) found.push(dir);
    if (depth >= 2) return;
    for (const e of entries) {
      if (found.length >= MAX_MANIFESTS) return;
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      await walk(path.join(dir, e.name), depth + 1);
    }
  };
  await walk(root, 0);
  return found;
}

async function readJson(file: string): Promise<any | null> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}

async function readText(file: string): Promise<string | null> {
  try { return await fs.readFile(file, 'utf8'); } catch { return null; }
}

/** Nearest lockfile at or above `dir` (inside root) — workspaces keep one at the root. */
async function nearestLock(root: string, dir: string): Promise<{ kind: 'npm' | 'pnpm'; file: string; dir: string } | null> {
  let cur = dir;
  for (;;) {
    const npm = path.join(cur, 'package-lock.json');
    const pnpm = path.join(cur, 'pnpm-lock.yaml');
    if (await fs.stat(npm).then(() => true, () => false)) return { kind: 'npm', file: npm, dir: cur };
    if (await fs.stat(pnpm).then(() => true, () => false)) return { kind: 'pnpm', file: pnpm, dir: cur };
    if (path.resolve(cur) === path.resolve(root)) return null;
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

/** Every production dependency of every manifest, resolved to its installed version.
 *  `io` picks the file source: the worktree DISK (default — the historical
 *  behaviour, still used by tests and any direct caller) or a GIT TREE via
 *  gitTreeIO() — what open_pull_request passes so the report describes the
 *  pushed PR head, not the lane's possibly-stale working directory. */
export async function resolveProductionDeps(root: string, io: DepFileIO = new DiskIO(root)): Promise<{ deps: ResolvedDep[]; manifests: string[] }> {
  const dirs = await io.findManifestDirs();
  const deps: ResolvedDep[] = [];
  const seen = new Set<string>();
  const manifests: string[] = [];
  const lockCache = new Map<string, any>();
  for (const dir of dirs) {
    const pkgText = await io.read(dir === '.' ? 'package.json' : `${dir}/package.json`);
    let pkg: any = null;
    try { pkg = pkgText === null ? null : JSON.parse(pkgText); } catch { pkg = null; }
    const wanted = pkg?.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies as Record<string, string> : null;
    if (!wanted) continue;
    const manifest = dir === '.' ? 'package.json' : `${dir}/package.json`;
    manifests.push(manifest);
    const lock = await io.nearestLockFor(dir);
    let pnpmMap: Map<string, string> | null = null;
    let npmLock: any = null;
    if (lock) {
      if (!lockCache.has(lock.rel)) {
        const content = await io.read(lock.rel);
        lockCache.set(lock.rel, lock.kind === 'npm' ? (content === null ? null : jsonOr(content)) : content);
      }
      const content = lockCache.get(lock.rel);
      if (lock.kind === 'npm') npmLock = content;
      else if (typeof content === 'string') {
        // importer = path from the lockfile's dir to THIS manifest's dir
        const relParts = lock.dir === '.' ? dir : (dir.startsWith(lock.dir + '/') ? dir.slice(lock.dir.length + 1) : '');
        pnpmMap = pnpmImporterVersions(content, relParts || '.');
      }
    }
    for (const [name, spec] of Object.entries(wanted)) {
      if (typeof spec !== 'string' || /^(file|link|workspace|git|github|http):/.test(spec)) continue;
      let version: string | null = null;
      if (npmLock) {
        // a nested workspace's own node_modules wins over the hoisted copy
        const rel = dir === lock!.dir ? '' : (lock!.dir === '.' ? dir : (dir.startsWith(lock!.dir + '/') ? dir.slice(lock!.dir.length + 1) : ''));
        const nested = rel ? npmLock?.packages?.[`${rel}/node_modules/${name}`]?.version : null;
        version = typeof nested === 'string' ? cleanVersion(nested) : versionFromPackageLock(npmLock, name);
      } else if (pnpmMap) {
        version = pnpmMap.get(name) ?? null;
      }
      if (!version && EXACT_SEMVER.test(spec.trim())) version = spec.trim();
      if (!version || !EXACT_SEMVER.test(version)) continue;
      const key = `${name}@${version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deps.push({ name, version, manifest });
    }
  }
  return { deps, manifests };
}

function jsonOr(text: string): any { try { return JSON.parse(text); } catch { return null; } }

// ── OSV lookup ────────────────────────────────────────────────────────────────

type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

interface CachedAdvisories { at: number; findings: Omit<AdvisoryFinding, 'manifest'>[] }
const advisoryCache = new Map<string, CachedAdvisories>();

/** Test hook. */
export function resetAdvisoryCache(): void { advisoryCache.clear(); }

function severityOf(vuln: any): AdvisorySeverity | null {
  const raw = String(vuln?.database_specific?.severity || '').toUpperCase();
  if (raw === 'CRITICAL' || raw === 'HIGH') return raw;
  return null;
}

/** The lowest `fixed` event above `version` for this npm package (null when none is published). */
export function fixedVersionFor(vuln: any, name: string, version: string): string | null {
  const fixes: string[] = [];
  for (const a of Array.isArray(vuln?.affected) ? vuln.affected : []) {
    if (a?.package?.ecosystem !== 'npm' || a?.package?.name !== name) continue;
    for (const r of Array.isArray(a?.ranges) ? a.ranges : []) {
      for (const ev of Array.isArray(r?.events) ? r.events : []) {
        if (typeof ev?.fixed === 'string' && compareVersions(ev.fixed, version) > 0) fixes.push(ev.fixed);
      }
    }
  }
  fixes.sort(compareVersions);
  return fixes[0] ?? null;
}

/**
 * The CRITICAL / HIGH advisories covering `deps`. Bounded by `deadlineMs`;
 * any network / parse failure returns what is known so far plus `error`.
 */
export async function lookupAdvisories(
  deps: ResolvedDep[],
  opts: { fetchImpl?: FetchLike; deadlineMs?: number; now?: () => number } = {},
): Promise<{ findings: AdvisoryFinding[]; error?: string }> {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init) as any);
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.deadlineMs ?? ADVISORY_DEADLINE_MS);
  const remaining = () => Math.max(1, deadline - now());
  const findings: AdvisoryFinding[] = [];
  const pending: ResolvedDep[] = [];
  for (const d of deps) {
    const hit = advisoryCache.get(`${d.name}@${d.version}`);
    if (hit && now() - hit.at < CACHE_TTL_MS) findings.push(...hit.findings.map(f => ({ ...f, manifest: d.manifest })));
    else pending.push(d);
  }
  if (!pending.length) return { findings };
  try {
    const res = await fetchImpl(`${OSV_API}/querybatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ queries: pending.map(d => ({ package: { ecosystem: 'npm', name: d.name }, version: d.version })) }),
      signal: AbortSignal.timeout(remaining()),
    });
    if (!res.ok) return { findings, error: `osv querybatch HTTP ${res.status}` };
    const body = await res.json();
    const results: any[] = Array.isArray(body?.results) ? body.results : [];
    const idsByDep = pending.map((_, i) => (Array.isArray(results[i]?.vulns) ? results[i].vulns : []).map((v: any) => String(v?.id || '')).filter(Boolean) as string[]);
    const uniqueIds = [...new Set(idsByDep.flat())].slice(0, MAX_DETAIL_FETCHES);
    const details = new Map<string, any>();
    await Promise.all(uniqueIds.map(async id => {
      try {
        const r = await fetchImpl(`${OSV_API}/vulns/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(remaining()) });
        if (r.ok) details.set(id, await r.json());
      } catch { /* one advisory missing never sinks the rest */ }
    }));
    pending.forEach((d, i) => {
      const depFindings: Omit<AdvisoryFinding, 'manifest'>[] = [];
      for (const id of idsByDep[i]) {
        const v = details.get(id);
        if (!v || v.withdrawn) continue;
        const severity = severityOf(v);
        if (!severity) continue;
        depFindings.push({
          pkg: d.name, version: d.version, id,
          aliases: (Array.isArray(v.aliases) ? v.aliases : []).filter((a: unknown) => typeof a === 'string').slice(0, 4),
          severity,
          summary: String(v.summary || v.details || '').replace(/\s+/g, ' ').trim().slice(0, 140),
          fixed: fixedVersionFor(v, d.name, d.version),
        });
      }
      // Cache only complete answers — a dep whose advisory details did not all arrive is re-asked next time.
      if (idsByDep[i].every(id => details.has(id))) advisoryCache.set(`${d.name}@${d.version}`, { at: now(), findings: depFindings });
      findings.push(...depFindings.map(f => ({ ...f, manifest: d.manifest })));
    });
    return { findings };
  } catch (err: any) {
    return { findings, error: `osv lookup failed: ${String(err?.name === 'TimeoutError' ? 'timeout' : err?.message || err).slice(0, 120)}` };
  }
}

/** Resolve + look up. Never throws.
 *  `headRef` (optional): resolve deps from THIS git tree (a commit sha or any
 *  rev) instead of the worktree disk — the open_pull_request fix (4dbd09fa):
 *  the advisory report must describe the PR being opened, and the lane's
 *  on-disk worktree can be stale or (explicit-head path) an entirely unrelated
 *  checkout. Fail-open: an UNRESOLVABLE rev (missing object, non-repo) falls
 *  back to the disk walk. A resolvable tree is authoritative — including one
 *  with ZERO manifests (a PR that deletes the JS app genuinely has no deps to
 *  scan; falling back to the stale disk there would resurrect the exact
 *  false-advisory defect this fix kills). */
export async function checkDependencyAdvisories(
  root: string,
  opts: { fetchImpl?: FetchLike; deadlineMs?: number; headRef?: string } = {},
): Promise<AdvisoryReport> {
  try {
    let io: DepFileIO = new DiskIO(root);
    if (opts.headRef) {
      // Resolve the rev ONCE (git rev-parse --verify --quiet: exit 1 + empty
      // stdout for a missing ref). The tree reads themselves stay bounded.
      let revResolves = false;
      try {
        const { stdout } = await gitRunner(['-C', root, 'rev-parse', '--verify', '--quiet', `${opts.headRef}^{commit}`], undefined, 10_000);
        revResolves = !!String(stdout).trim();
      } catch { revResolves = false; }
      if (revResolves) io = new GitTreeIO(root, opts.headRef);
    }
    const { deps, manifests } = await resolveProductionDeps(root, io);
    if (!deps.length) return { findings: [], manifests, packages: 0, source: io.source === 'git-tree' ? 'pr-head' : 'worktree' };
    const { findings, error } = await lookupAdvisories(deps, opts);
    findings.sort((a, b) => (a.severity === b.severity ? a.pkg.localeCompare(b.pkg) : a.severity === 'CRITICAL' ? -1 : 1));
    return { findings, manifests, packages: deps.length, source: io.source === 'git-tree' ? 'pr-head' : 'worktree', ...(error ? { error } : {}) };
  } catch (err: any) {
    return { findings: [], manifests: [], packages: 0, error: String(err?.message || err).slice(0, 120) };
  }
}

// ── rendering ─────────────────────────────────────────────────────────────────

const MAX_LINES = 6;

export interface AdvisoryGroup {
  pkg: string;
  version: string;
  manifest: string;
  severity: AdvisorySeverity; // the worst finding's
  critical: number;
  high: number;
  worst: AdvisoryFinding;      // the example named on the line
  criticalIds: string[];       // every critical advisory id (named on the line, ≤ 4)
  upgradeTo: string | null;    // the lowest version that clears every advisory with a published fix
  unfixed: number;             // advisories with no published fix
}

/** One group per installed package@version, worst first (critical count, then high count, then name). */
export function groupFindings(findings: AdvisoryFinding[]): AdvisoryGroup[] {
  const groups = new Map<string, AdvisoryGroup>();
  for (const f of findings) {
    const key = `${f.pkg}@${f.version}`;
    let g = groups.get(key);
    if (!g) {
      g = { pkg: f.pkg, version: f.version, manifest: f.manifest, severity: f.severity, critical: 0, high: 0, worst: f, criticalIds: [], upgradeTo: null, unfixed: 0 };
      groups.set(key, g);
    }
    if (f.severity === 'CRITICAL') { g.critical++; g.criticalIds.push(f.id); } else g.high++;
    if (f.severity === 'CRITICAL' && g.worst.severity !== 'CRITICAL') g.worst = f;
    if (f.severity === 'CRITICAL') g.severity = 'CRITICAL';
    if (f.fixed) { if (!g.upgradeTo || compareVersions(f.fixed, g.upgradeTo) > 0) g.upgradeTo = f.fixed; } else g.unfixed++;
  }
  return [...groups.values()].sort((a, b) => (b.critical - a.critical) || (b.high - a.high) || a.pkg.localeCompare(b.pkg));
}

function groupLine(g: AdvisoryGroup, withLink: boolean): string {
  const counts = [g.critical ? `${g.critical} critical` : '', g.high ? `${g.high} high` : ''].filter(Boolean).join(', ');
  const cve = g.worst.aliases.find(a => a.startsWith('CVE-'));
  const example = `${g.worst.id}${cve ? ` / ${cve}` : ''}${g.worst.summary ? ` (${g.worst.summary})` : ''}${withLink ? ` https://osv.dev/vulnerability/${encodeURIComponent(g.worst.id)}` : ''}`;
  const others = g.criticalIds.filter(id => id !== g.worst.id);
  const otherCriticals = others.length ? `; other critical: ${others.slice(0, 3).join(', ')}${others.length > 3 ? ', …' : ''}` : '';
  const fix = g.upgradeTo
    ? `upgrade to ≥ ${g.upgradeTo}${g.unfixed ? ` (${g.unfixed} more have no published fix)` : ' to clear all of them'}`
    : 'no fixed version published — replace or isolate it';
  return `${g.severity} ${g.pkg}@${g.version} (${g.manifest}): ${counts} — e.g. ${example}${otherCriticals} — ${fix}`;
}

/** The lane-facing notice appended to the open_pull_request result ('' when nothing to say). */
export function renderAdvisoryNotice(report: AdvisoryReport): string {
  if (!report.findings.length) return '';
  const groups = groupFindings(report.findings);
  const lines = groups.slice(0, MAX_LINES).map(g => `- ${groupLine(g, false)}`);
  const more = groups.length > MAX_LINES ? `\n- …and ${groups.length - MAX_LINES} more package(s)` : '';
  return `\n\n[SECURITY ADVISORY] known critical/high advisories in ${groups.length} production dependenc${groups.length === 1 ? 'y' : 'ies'} of this project (OSV lookup of the installed versions):\n${lines.join('\n')}${more}\nUpgrade these before this app is deployed or kept online — a public app on a version with a known critical advisory is how hosts get taken over. If you cannot upgrade in this run, say so in your final and add a plan step; never downgrade a dependency to dodge a build error without checking the target version's advisories.`;
}

/** The owner-facing section appended to the PR body ('' when nothing to say). */
export function renderAdvisoryPrBody(report: AdvisoryReport): string {
  if (!report.findings.length) return '';
  const groups = groupFindings(report.findings);
  const lines = groups.slice(0, MAX_LINES).map(g => `- ${groupLine(g, true)}`);
  const more = groups.length > MAX_LINES ? `\n- …and ${groups.length - MAX_LINES} more package(s)` : '';
  return `\n\n---\n⚠️ **Security advisories in production dependencies** (harness OSV lookup, not fixed by this PR):\n${lines.join('\n')}${more}`;
}
