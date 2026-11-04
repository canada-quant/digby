/**
 * build 2026-10-08 ISO — workspace-layout.ts: the per-user subtree switch,
 * keys, the ALWAYS-ON dual-read resolvers (byte-identical answers while
 * nothing is placed per-user), and the guard's tenancy classifier (the
 * rollout's deciding metric "cross-tenant refs that reach real data = 0").
 * Real tmp dirs; no DB.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  perUserSubtreeSetting, perUserSubtreeAppliesTo, userSwitchAppliesTo, userSubtreeKey,
  resolveWorktreePathSync, resolveMirrorPathSync, resolveSandboxHomeSync, legacyWorktreePath, legacyMirrorPath,
  subtreeWorktreePath, subtreeMirrorPath, subtreeSandboxHome, ensureUserSubtreeSync, listSubtreeKeysSync,
  mirrorOfWorktreeSync, volumeSubpathOf, pathSubtreeKey, classifyRefTenancy, listPerUserWorktreeDirsSync,
  __resetLayoutMemoForTest, SUBTREE_MARKER,
} from './workspace-layout';

const OWNER = '83e4fbf9-e18c-42f1-9bf7-7a99caf9d9c4';
const OTHER = '808aeb11-2222-4333-8444-555566667777';
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-layout-'));
  __resetLayoutMemoForTest();
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('the switch (CODING_WORKSPACE_PER_USER_SUBTREE)', () => {
  it('is OFF by default and for 0 / false / off', () => {
    for (const v of [undefined, '', '0', 'false', 'off', 'OFF']) {
      const env = v === undefined ? {} : { CODING_WORKSPACE_PER_USER_SUBTREE: v };
      expect(perUserSubtreeSetting(env as any)).toEqual({ mode: 'off' });
      expect(perUserSubtreeAppliesTo(OWNER, env as any)).toBe(false);
    }
  });
  it('1 / all applies to everyone; a list is the canary (full id or ≥8-char prefix; short tokens ignored)', () => {
    expect(perUserSubtreeAppliesTo(OTHER, { CODING_WORKSPACE_PER_USER_SUBTREE: '1' } as any)).toBe(true);
    const canary = { CODING_WORKSPACE_PER_USER_SUBTREE: `808aeb11, ${OWNER.slice(0, 4)}` } as any;
    expect(perUserSubtreeAppliesTo(OTHER, canary)).toBe(true);
    expect(perUserSubtreeAppliesTo(OWNER, canary)).toBe(false); // a 4-char token is not a canary entry
    expect(perUserSubtreeAppliesTo(null, canary)).toBe(false);
    expect(userSwitchAppliesTo('CODING_CREDENTIAL_PROXY', OWNER, { CODING_CREDENTIAL_PROXY: OWNER } as any)).toBe(true);
  });
});

describe('keys + paths', () => {
  it('a uuid user keys on its 12-char prefix (the dev-container naming); unsafe / reserved prefixes hash', () => {
    expect(userSubtreeKey(OWNER)).toBe('83e4fbf9-e18');
    expect(userSubtreeKey('repos')).toMatch(/^u[0-9a-f]{11}$/);
    expect(userSubtreeKey('../evil/x')).toMatch(/^u[0-9a-f]{11}$/);
  });
  it('volumeSubpathOf / pathSubtreeKey are pure and refuse paths outside the root', () => {
    expect(volumeSubpathOf(`${root}/83e4fbf9-e18/worktrees/s1`, root)).toBe('83e4fbf9-e18/worktrees/s1');
    expect(volumeSubpathOf('/etc/passwd', root)).toBeNull();
    expect(volumeSubpathOf(root, root)).toBeNull();
    expect(pathSubtreeKey(`${root}/83e4fbf9-e18/worktrees/s1`, root)).toBe('83e4fbf9-e18');
    expect(pathSubtreeKey(`${root}/worktrees/s1`, root)).toBeNull();
    expect(pathSubtreeKey(`${root}/.snap-index-x`, root)).toBeNull();
  });
  it('ensureUserSubtreeSync writes the marker once and refuses a key held by another user', () => {
    const key = ensureUserSubtreeSync(OWNER, root);
    expect(JSON.parse(fs.readFileSync(path.join(root, key, SUBTREE_MARKER), 'utf8')).userId).toBe(OWNER);
    expect(ensureUserSubtreeSync(OWNER, root)).toBe(key); // idempotent
    expect(() => ensureUserSubtreeSync(`${OWNER.slice(0, 12)}-collides`, root)).toThrow(/another user/);
    expect(listSubtreeKeysSync(root)).toEqual([key]);
  });
});

describe('dual-read resolvers (always on)', () => {
  it('nothing on disk → the legacy path (today\'s answer, byte-identical)', () => {
    expect(resolveWorktreePathSync('s1', root)).toBe(path.join(root, 'worktrees', 's1'));
    expect(resolveMirrorPathSync('p1', root)).toBe(path.join(root, 'repos', 'p1.git'));
    expect(resolveSandboxHomeSync('s1', root)).toBe(path.join(root, 'worktrees', '.sandbox-home', 's1'));
  });
  it('a legacy real dir wins', () => {
    fs.mkdirSync(legacyWorktreePath('s1', root), { recursive: true });
    expect(resolveWorktreePathSync('s1', root)).toBe(legacyWorktreePath('s1', root));
  });
  it('a per-user dir (marker-backed subtree) is found; a dir in an UNMARKED top-level folder is not', () => {
    const key = ensureUserSubtreeSync(OWNER, root);
    fs.mkdirSync(subtreeWorktreePath(key, 's2', root), { recursive: true });
    fs.mkdirSync(subtreeMirrorPath(key, 'p2', root), { recursive: true });
    expect(resolveWorktreePathSync('s2', root)).toBe(subtreeWorktreePath(key, 's2', root));
    expect(resolveMirrorPathSync('p2', root)).toBe(subtreeMirrorPath(key, 'p2', root));
    expect(resolveSandboxHomeSync('s2', root)).toBe(subtreeSandboxHome(key, 's2', root));
    fs.mkdirSync(path.join(root, 'stray', 'worktrees', 's3'), { recursive: true });
    expect(resolveWorktreePathSync('s3', root)).toBe(legacyWorktreePath('s3', root));
    expect(listPerUserWorktreeDirsSync(root).map((d) => d.sessionId)).toEqual(['s2']);
  });
  it('a migration compatibility symlink at the legacy path resolves to the physical per-user dir', () => {
    const key = ensureUserSubtreeSync(OWNER, root);
    const phys = subtreeWorktreePath(key, 's4', root);
    fs.mkdirSync(phys, { recursive: true });
    fs.mkdirSync(path.join(root, 'worktrees'), { recursive: true });
    fs.symlinkSync(path.relative(path.join(root, 'worktrees'), phys), legacyWorktreePath('s4', root));
    expect(resolveWorktreePathSync('s4', root)).toBe(phys);
    fs.mkdirSync(path.join(root, 'repos'), { recursive: true });
    fs.mkdirSync(subtreeMirrorPath(key, 'p4', root), { recursive: true });
    fs.symlinkSync(path.relative(path.join(root, 'repos'), subtreeMirrorPath(key, 'p4', root)), legacyMirrorPath('p4', root));
    expect(resolveMirrorPathSync('p4', root)).toBe(subtreeMirrorPath(key, 'p4', root));
  });
  it('mirrorOfWorktreeSync reads the linked worktree .git file', () => {
    const wt = path.join(root, 'wt');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${root}/repos/p1.git/worktrees/wt\n`);
    expect(mirrorOfWorktreeSync(wt)).toBe(`${root}/repos/p1.git`);
    fs.rmSync(path.join(wt, '.git'));
    fs.mkdirSync(path.join(wt, '.git'));
    expect(mirrorOfWorktreeSync(wt)).toBeNull(); // a standalone (blank) repo
  });
});

describe('classifyRefTenancy — the deciding metric (incident replays)', () => {
  const own = { ownSessionIds: new Set(['mine']), ownProjectIds: new Set(['pmine']) };
  beforeEach(() => {
    fs.mkdirSync(path.join(root, 'worktrees', 'theirs'), { recursive: true });
    fs.mkdirSync(path.join(root, 'repos', 'ptheirs.git'), { recursive: true });
  });
  it('stanne.md #1 (`ls <root>/worktrees/`) from the WHOLE-VOLUME dev container reaches every tenant', () => {
    const r = classifyRefTenancy([`${root}/worktrees`], { exposure: 'dev_container', ownKey: userSubtreeKey(OWNER), ...own }, root);
    expect(r).toEqual({ crossTenant: 1, reachesData: 1 });
  });
  it('the same listing from a USER-SUBTREE shell reaches nothing (structure, not text)', () => {
    const r = classifyRefTenancy([`${root}/worktrees`, `${root}/worktrees/theirs/src`, `${root}/repos/ptheirs.git`], { exposure: 'user_subtree', ownKey: userSubtreeKey(OWNER), ...own }, root);
    expect(r).toEqual({ crossTenant: 3, reachesData: 0 });
  });
  it('another tenant\'s worktree that exists reaches data under whole_volume; own paths and masked homes never count', () => {
    const key = userSubtreeKey(OWNER);
    const r = classifyRefTenancy([
      `${root}/worktrees/theirs/README.md`, `${root}/worktrees/mine/x`, `${root}/repos/pmine.git`,
      `${root}/${key}/worktrees/s9`, `${root}/worktrees/.sandbox-home/theirs/.aws`, `${root}/worktrees/gone/x`,
    ], { exposure: 'whole_volume', ownKey: key, ...own }, root);
    expect(r).toEqual({ crossTenant: 3, reachesData: 1 }); // theirs (reaches), masked home (no), gone (no — not on disk)
  });
  it('an ancestor walk (`find /`) enters every tenant under whole_volume only', () => {
    expect(classifyRefTenancy(['/'], { exposure: 'whole_volume', ownKey: null, ...own }, root)).toEqual({ crossTenant: 1, reachesData: 1 });
    expect(classifyRefTenancy(['/'], { exposure: 'user_subtree', ownKey: null, ...own }, root)).toEqual({ crossTenant: 1, reachesData: 0 });
  });
  it('a glob ref is judged by its literal prefix dir', () => {
    expect(classifyRefTenancy([`${root}/worktrees/*/`], { exposure: 'dev_container', ownKey: null, ...own }, root)).toEqual({ crossTenant: 1, reachesData: 1 });
  });
});
