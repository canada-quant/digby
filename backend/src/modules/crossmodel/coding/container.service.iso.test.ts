/**
 * build 2026-10-08 ISO — per-session containers under the per-user subtree
 * layout (container.service): docker create args derived from where the data
 * IS, the user-SUBTREE fallback (never the whole volume first), hardening for
 * canary sessions, the migrated-session legacy mount, the dev-container
 * coverage check, and the "scoped provision" telemetry. Legacy sessions keep
 * today's args byte-for-byte. Docker + prisma mocked; a real tmp volume root.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-ctr-'));
process.env.CODING_WORKSPACE_ROOT = ROOT;
process.env.CODING_ENV_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-ctr-env-'));
process.env.CODING_CONTAINER_MODE = '1';

jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockSession = jest.fn();
jest.mock('../../../config/database', () => ({ __esModule: true, default: { chatCodingState: { findUnique: (...a: any[]) => mockSession(...a) }, agentRun: { count: jest.fn(async () => 0) } } }));
const mockRecord = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: (...a: any[]) => mockRecord(...a), LOOP_METRIC_KINDS: { WORKSPACE_ISOLATION: 'workspace_isolation' } }));
const mockEnsureDev = jest.fn(async (): Promise<string | null> => null);
jest.mock('./dev-container.service', () => ({ __esModule: true, ensureUserDevContainer: (...a: any[]) => (mockEnsureDev as any)(...a), ensureSessionEgressGrant: jest.fn(async () => null) }));

const calls: string[][] = [];
let runFails: Array<(args: string[]) => boolean> = [];
let inspectMounts = '';
jest.mock('child_process', () => ({
  execFile: (_cmd: string, args: string[], _opts: any, cb: any) => {
    calls.push(args);
    let err: any = null;
    let stdout = '';
    if (args[0] === 'run' && runFails.some((f) => f(args))) err = Object.assign(new Error('docker: invalid mount config'), { stderr: 'invalid mount' });
    else if (args[0] === 'inspect') stdout = inspectMounts;
    process.nextTick(() => cb(err, { stdout, stderr: '' }));
  },
}));

import { ensureSessionContainer, workspaceExecExposure, stopSessionContainer, HARDENED_CREATE_ARGS, __resetDockerAvailabilityForTest } from './container.service';
import { ensureUserSubtreeSync, __resetLayoutMemoForTest } from './workspace-layout';

const U = '808aeb11-2222-4333-8444-555566667777';
const VOL = 'crossmodel_coding_workspaces';
let KEY = '';
const flush = () => new Promise((r) => setTimeout(r, 0));
const runArgs = () => calls.filter((c) => c[0] === 'run');
const rows = () => mockRecord.mock.calls.map((c) => c[0].meta);

function mkWorktree(dir: string, mirror: string, sid: string) {
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(mirror, 'worktrees', sid), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${mirror}/worktrees/${sid}\n`);
}

beforeAll(() => {
  KEY = ensureUserSubtreeSync(U, ROOT);
  mkWorktree(path.join(ROOT, KEY, 'worktrees', 'sp'), path.join(ROOT, 'repos', 'p1.git'), 'sp');      // per-user, legacy mirror
  mkWorktree(path.join(ROOT, 'worktrees', 'sl'), path.join(ROOT, 'repos', 'p1.git'), 'sl');           // legacy
  mkWorktree(path.join(ROOT, KEY, 'worktrees', 'sm'), path.join(ROOT, 'repos', 'p1.git'), 'sm');      // migrated (compat link)
  fs.symlinkSync(`../${KEY}/worktrees/sm`, path.join(ROOT, 'worktrees', 'sm'));
});
afterAll(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });
beforeEach(async () => {
  calls.length = 0; runFails = []; inspectMounts = '';
  mockRecord.mockClear(); mockEnsureDev.mockReset(); mockEnsureDev.mockResolvedValue(null);
  mockSession.mockImplementation(async (q: any) => ({ userId: U, projectId: 'p1', id: q.where.id }));
  __resetDockerAvailabilityForTest();
  __resetLayoutMemoForTest();
  delete process.env.CODING_WORKSPACE_PER_USER_SUBTREE;
  for (const s of ['sp', 'sl', 'sm']) await stopSessionContainer(s);
  calls.length = 0;
});

it('LEGACY session, switch off: today\'s scoped mounts byte-for-byte, no hardening, no telemetry', async () => {
  expect(await ensureSessionContainer('sl')).toBe(true);
  const run = runArgs()[0];
  expect(run).toEqual(expect.arrayContaining([
    `type=volume,source=${VOL},target=${ROOT}/worktrees/sl,volume-subpath=worktrees/sl`,
    `type=volume,source=${VOL},target=${ROOT}/repos/p1.git,volume-subpath=repos/p1.git`,
    `type=volume,source=${VOL},target=${ROOT}/worktrees/.sandbox-home/sl,volume-subpath=worktrees/.sandbox-home/sl`,
  ]));
  expect(run).not.toContain('--cap-drop');
  await flush();
  expect(mockRecord).not.toHaveBeenCalled();
});

it('PER-USER canary session: subpaths in the user subtree, hardened, -w the physical path, one scoped row', async () => {
  process.env.CODING_WORKSPACE_PER_USER_SUBTREE = U;
  expect(await ensureSessionContainer('sp')).toBe(true);
  const run = runArgs()[0];
  expect(run).toEqual(expect.arrayContaining([
    `type=volume,source=${VOL},target=${ROOT}/${KEY}/worktrees/sp,volume-subpath=${KEY}/worktrees/sp`,
    `type=volume,source=${VOL},target=${ROOT}/repos/p1.git,volume-subpath=repos/p1.git`,
    `type=volume,source=${VOL},target=${ROOT}/${KEY}/.sandbox-home/sp,volume-subpath=${KEY}/.sandbox-home/sp`,
    ...HARDENED_CREATE_ARGS,
  ]));
  expect(run[run.indexOf('-w') + 1]).toBe(`${ROOT}/${KEY}/worktrees/sp`);
  expect(run.some((a) => a === `${VOL}:${ROOT}`)).toBe(false);
  expect(workspaceExecExposure('sp')).toBeNull();
  await flush();
  expect(rows()).toEqual([expect.objectContaining({ phase: 'container', layout: 'per_user', mount: 'scoped', hardened: true })]);
});

it('scoped create fails → the USER SUBTREE fallback (never the whole volume first); exposure user_subtree', async () => {
  process.env.CODING_WORKSPACE_PER_USER_SUBTREE = '1';
  runFails = [(a) => a.some((x) => x.includes('volume-subpath=') && x.includes('/worktrees/sp,'))];
  expect(await ensureSessionContainer('sp')).toBe(true);
  const fallback = runArgs()[1];
  expect(fallback).toEqual(expect.arrayContaining([
    `type=volume,source=${VOL},target=${ROOT}/${KEY},volume-subpath=${KEY}`,
    `${ROOT}/${KEY}/.sandbox-home:rw,noexec,nosuid,size=64k`,
    `type=volume,source=${VOL},target=${ROOT}/repos/p1.git,volume-subpath=repos/p1.git`,
  ]));
  expect(fallback.some((a) => a === `${VOL}:${ROOT}`)).toBe(false);
  expect(workspaceExecExposure('sp')).toBe('user_subtree');
  await flush();
  expect(rows()).toEqual([expect.objectContaining({ mount: 'user_subtree', layout: 'per_user' })]);
});

it('both scoped and subtree creates fail → the legacy whole-volume fallback, counted as such', async () => {
  process.env.CODING_WORKSPACE_PER_USER_SUBTREE = '1';
  runFails = [(a) => a.some((x) => x.includes('volume-subpath='))];
  expect(await ensureSessionContainer('sp')).toBe(true);
  expect(runArgs()[2]).toContain(`${VOL}:${ROOT}`);
  expect(workspaceExecExposure('sp')).toBe('whole_volume');
  await flush();
  expect(rows()).toEqual([expect.objectContaining({ mount: 'whole_volume' })]);
});

it('a MIGRATED session also gets its worktree at the legacy absolute path (baked-in paths keep resolving)', async () => {
  expect(await ensureSessionContainer('sm')).toBe(true);
  expect(runArgs()[0]).toEqual(expect.arrayContaining([
    `type=volume,source=${VOL},target=${ROOT}/${KEY}/worktrees/sm,volume-subpath=${KEY}/worktrees/sm`,
    `type=volume,source=${VOL},target=${ROOT}/worktrees/sm,volume-subpath=${KEY}/worktrees/sm`,
  ]));
});

it('a SUBTREE-mounted dev container that cannot see the session → scoped per-session container instead (+ a dev_uncovered row)', async () => {
  mockEnsureDev.mockResolvedValue(`digby-dev-${U.slice(0, 12)}`);
  inspectMounts = `${ROOT}/${KEY}|/var/lib/digby-tailscale|`;
  expect(await ensureSessionContainer('sl')).toBe(true);           // legacy worktree: not under the mounted subtree
  expect(runArgs()).toHaveLength(1);
  expect(workspaceExecExposure('sl')).toBeNull();
  await flush();
  expect(rows()).toEqual(expect.arrayContaining([expect.objectContaining({ phase: 'dev_uncovered', worktreeLayout: 'legacy' })]));
});

it('a covered session runs in the subtree-mounted dev container with exposure user_subtree', async () => {
  mockEnsureDev.mockResolvedValue(`digby-dev-${U.slice(0, 12)}`);
  inspectMounts = `${ROOT}/${KEY}|${ROOT}/repos/p1.git|/var/lib/digby-tailscale|`;
  expect(await ensureSessionContainer('sp')).toBe(true);
  expect(runArgs()).toHaveLength(0);
  expect(workspaceExecExposure('sp')).toBe('user_subtree');
  inspectMounts = `${ROOT}|/var/lib/digby-tailscale|`;               // a whole-volume dev container covers everything (today)
  expect(await ensureSessionContainer('sl')).toBe(true);
  expect(workspaceExecExposure('sl')).toBe('dev_container');
});
