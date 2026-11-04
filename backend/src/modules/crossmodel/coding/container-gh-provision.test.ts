/**
 * Tests for gh CLI provisioning into session containers (ticket ad7a1c3c).
 * Docker/tar/fetch/fs are all mocked; no daemon, network, or DB required.
 * Each test uses a UNIQUE session id → unique container name, so the
 * module-level gh-provision memo never leaks between tests.
 */

process.env.CODING_CONTAINER_MODE = '1';


jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    chatCodingState: { findMany: jest.fn(), findUnique: jest.fn() },
    agentRun: { count: jest.fn() },
  },
}));
jest.mock('./dev-container.service', () => ({
  ensureUserDevContainer: jest.fn(),
  ensureSessionEgressGrant: jest.fn(),
}));
// Hermeticity (61d33af9 lane): these suites were written against an EMPTY
// workspace volume (the CI premise). A sandbox whose shared volume carries
// per-user subtree keys flips isoInPlay() on (workspace-layout reads the LIVE
// volume) and routes the shared-container resolution through docker-inspect
// paths the tests never mock. Pin the volume read to the empty-volume premise.
jest.mock('./workspace-layout', () => ({
  __esModule: true,
  ...jest.requireActual('./workspace-layout'),
  listSubtreeKeysSync: () => [],
}));

const fsAccessMock = jest.fn();
const fsMkdirMock = jest.fn();
const fsWriteFileMock = jest.fn();
const fsRenameMock = jest.fn();
const fsChmodMock = jest.fn();
const fsRmMock = jest.fn();
const fsStatMock = jest.fn();
jest.mock('fs/promises', () => ({
  __esModule: true,
  access: (...args: any[]) => fsAccessMock(...args),
  mkdir: (...args: any[]) => Promise.resolve(fsMkdirMock(...args)),
  writeFile: (...args: any[]) => Promise.resolve(fsWriteFileMock(...args)),
  rename: (...args: any[]) => Promise.resolve(fsRenameMock(...args)),
  chmod: (...args: any[]) => Promise.resolve(fsChmodMock(...args)),
  rm: (...args: any[]) => Promise.resolve(fsRmMock(...args)),
  stat: (...args: any[]) => fsStatMock(...args),
}));

const execFileMock = jest.fn();
jest.mock('child_process', () => ({ execFile: (...args: any[]) => execFileMock(...args) }));

const fetchMock = jest.fn();
(global as any).fetch = fetchMock;

import * as crypto from 'crypto';
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { ensureUserDevContainer, ensureSessionEgressGrant } from './dev-container.service';
import { ensureSessionContainer, stopSessionContainer, GH_SHA256 } from './container.service';

const mockedPrisma = prisma as unknown as {
  chatCodingState: { findMany: jest.Mock; findUnique: jest.Mock };
  agentRun: { count: jest.Mock };
};
const mockedDev = {
  ensureUserDevContainer: ensureUserDevContainer as jest.Mock,
  ensureSessionEgressGrant: ensureSessionEgressGrant as jest.Mock,
};
const mockedLogger = logger as unknown as { warn: jest.Mock; info: jest.Mock };

const EXPECTED_ARCH = process.arch === 'x64' ? 'amd64' : 'arm64';
const TGZ_CONTENT = 'fake-gh-tarball-bytes';
let realSha: Record<string, string> = {};

function sessionName(sessionId: string): string {
  return `digby-code-${sessionId.slice(0, 12)}`;
}

/** Route execFile(cmd,args,opts,cb) through a table; thrown route → cb(err). */
function execRoutes(handler: (cmd: string, args: string[]) => string) {
  execFileMock.mockImplementation((cmd: string, args: string[], _opts: any, cb: any) => {
    try { cb(null, { stdout: handler(cmd, args), stderr: '' }); }
    catch (err: any) { cb(err); }
  });
}

interface ContainerOpts {
  running?: boolean;   // docker ps finds the container (already-running path)
  ghPresent?: boolean; // `command -v gh` succeeds inside the container
}

/** Standard docker route for a per-session container lifecycle. */
function dockerRouter(name: string, opts: ContainerOpts) {
  return (cmd: string, args: string[]): string => {
    if (cmd === 'tar') return '';
    const key = args.join(' ');
    if (args[0] === 'info') return '27.1.1';
    if (args[0] === 'ps') return opts.running && args[1] !== '-a' ? `${name}\n` : '';
    if (args[0] === 'run') return 'new-container-id';
    // Hermeticity (4f7263e4 follow-up, 2026-10-10): isoInPlay() reads the REAL volume at
    // CODING_WORKSPACE_ROOT — on a prod-co-located dev container it holds the ISO canary's
    // per-user subtree, so ensureSessionContainer takes the ISO branch here and asks
    // containerMountDestinations(shared) whether the dev container covers the worktree.
    // Answer as a WHOLE-VOLUME mount (what these tests always meant: the shared dev
    // container sees everything ⇒ covered ⇒ gh is provisioned into `shared`, not into a
    // scoped per-session container). CI is green only because ITS volume is empty.
    if (args[0] === 'inspect') return `${process.env.CODING_WORKSPACE_ROOT || '/app/coding-workspaces'}|`;
    if (args[0] === 'start' || args[0] === 'cp' || args[0] === 'rm') return '';
    if (args[0] === 'exec') {
      if (key.includes('command -v gh')) {
        if (opts.ghPresent) return '/usr/local/bin/gh';
        throw Object.assign(new Error('exit 1'), { code: 1 });
      }
      if (args.includes('version') && key.includes('gh')) return `gh version 2.100.0 (2026-09-01)\n`;
      return ''; // git config --system, git rev-parse HEAD, …
    }
    return '';
  };
}

function mockGhFetchOk() {
  const bytes = new TextEncoder().encode(TGZ_CONTENT);
  fetchMock.mockResolvedValue({
    ok: true, status: 200,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });
}

function ghProbeCount(): number {
  return execFileMock.mock.calls.filter((c) => String(c[1]?.join(' ')).includes('command -v gh')).length;
}
function ghCpCalls(): any[][] {
  return execFileMock.mock.calls.filter((c) => c[1]?.[0] === 'cp').map((c) => c[1].slice(1));
}

beforeEach(() => {
  jest.clearAllMocks();
  // The production code sha256-pins the REAL release; point the pin at our
  // fake tarball's digest so the verification path is genuinely exercised.
  realSha = { ...GH_SHA256 };
  const digest = crypto.createHash('sha256').update(TGZ_CONTENT).digest('hex');
  GH_SHA256.amd64 = digest;
  GH_SHA256.arm64 = digest;
  // Default fs routing: the workspace worktree exists; the gh tmp-cache misses.
  fsAccessMock.mockImplementation((p: any) =>
    String(p).includes('digby-gh-cache') ? Promise.reject(new Error('cache miss')) : Promise.resolve());
  fsStatMock.mockResolvedValue({ size: 40_000_000 });
  mockedPrisma.chatCodingState.findUnique.mockResolvedValue({ userId: null, projectId: null });
  mockedDev.ensureUserDevContainer.mockResolvedValue(null);
  mockedDev.ensureSessionEgressGrant.mockResolvedValue(null);
});

afterEach(() => {
  GH_SHA256.amd64 = realSha.amd64;
  GH_SHA256.arm64 = realSha.arm64;
});

describe('gh CLI provisioning (ticket ad7a1c3c)', () => {
  test('provisions a pinned, sha256-verified gh into a freshly created per-session container', async () => {
    const sid = 'aa000001-0000-4000-8000-000000000001';
    const name = sessionName(sid);
    execRoutes(dockerRouter(name, {}));
    mockGhFetchOk();

    await expect(ensureSessionContainer(sid)).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      `https://github.com/cli/cli/releases/download/v2.100.0/gh_2.100.0_linux_${EXPECTED_ARCH}.tar.gz`,
      expect.anything(),
    );
    // sha256 verification ran (the fake digest matched), then the binary was
    // extracted (tar), and docker-cp'd into the ready container.
    expect(execFileMock.mock.calls.some((c) => c[0] === 'tar')).toBe(true);
    expect(ghCpCalls()).toEqual([
      [expect.stringContaining(`gh-2.100.0-${EXPECTED_ARCH}`), `${name}:/usr/local/bin/gh`],
    ]);
    // …and the copy was proven runnable inside the container.
    expect(execFileMock.mock.calls.some((c) => String(c[1]?.join(' ')) === `exec ${name} gh version`)).toBe(true);
  });

  test('no download or copy when gh is already present in the running container', async () => {
    const sid = 'aa000002-0000-4000-8000-000000000002';
    const name = sessionName(sid);
    execRoutes(dockerRouter(name, { running: true, ghPresent: true }));

    await expect(ensureSessionContainer(sid)).resolves.toBe(true);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(ghCpCalls()).toEqual([]);
  });

  test('best-effort: a gh download failure never blocks container readiness', async () => {
    const sid = 'aa000003-0000-4000-8000-000000000003';
    const name = sessionName(sid);
    execRoutes(dockerRouter(name, {}));
    fetchMock.mockResolvedValue({ ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) });

    await expect(ensureSessionContainer(sid)).resolves.toBe(true);

    expect(ghCpCalls()).toEqual([]);
    expect(mockedLogger.warn.mock.calls.some((c) => String(c[0]).includes('gh download failed'))).toBe(true);
  });

  test('refuses a tarball whose sha256 does not match the pin', async () => {
    const sid = 'aa000004-0000-4000-8000-000000000004';
    const name = sessionName(sid);
    execRoutes(dockerRouter(name, {}));
    GH_SHA256[EXPECTED_ARCH] = '0'.repeat(64); // corrupt the pin → mismatch
    mockGhFetchOk();

    await expect(ensureSessionContainer(sid)).resolves.toBe(true); // still ready

    expect(ghCpCalls()).toEqual([]);
    expect(mockedLogger.warn.mock.calls.some((c) => String(c[0]).includes('sha256 mismatch'))).toBe(true);
  });

  test('memoizes the gh probe per container within the TTL (no per-exec overhead)', async () => {
    const sid = 'aa000005-0000-4000-8000-000000000005';
    const name = sessionName(sid);
    execRoutes(dockerRouter(name, { running: true, ghPresent: true }));

    await expect(ensureSessionContainer(sid)).resolves.toBe(true);
    await expect(ensureSessionContainer(sid)).resolves.toBe(true);
    await expect(ensureSessionContainer(sid)).resolves.toBe(true);

    expect(ghProbeCount()).toBe(1);
  });

  test('stopSessionContainer invalidates the memo — a recreated container is re-probed', async () => {
    const sid = 'aa000006-0000-4000-8000-000000000006';
    const name = sessionName(sid);
    execRoutes(dockerRouter(name, { running: true, ghPresent: true }));

    await expect(ensureSessionContainer(sid)).resolves.toBe(true);
    expect(ghProbeCount()).toBe(1);

    await stopSessionContainer(sid); // docker rm -f → memo entry dropped
    await expect(ensureSessionContainer(sid)).resolves.toBe(true);
    expect(ghProbeCount()).toBe(2);
  });

  test('provisions gh into the SHARED dev container when the session resolves it', async () => {
    const sid = 'aa000007-0000-4000-8000-000000000007';
    const shared = 'digby-dev-shared-abc';
    mockedPrisma.chatCodingState.findUnique.mockResolvedValue({ userId: 'user-1', projectId: null });
    mockedDev.ensureUserDevContainer.mockResolvedValue(shared);
    execRoutes(dockerRouter(shared, { ghPresent: false }));
    mockGhFetchOk();

    await expect(ensureSessionContainer(sid)).resolves.toBe(true);

    expect(ghCpCalls()).toEqual([
      [expect.stringContaining(`gh-2.100.0-${EXPECTED_ARCH}`), `${shared}:/usr/local/bin/gh`],
    ]);
  });

  test('serves a second container from the tmp cache without re-downloading', async () => {
    const sidA = 'aa000008-0000-4000-8000-000000000008';
    const sidB = 'aa000009-0000-4000-8000-000000000009';
    execRoutes(dockerRouter(sessionName(sidA), {}));
    mockGhFetchOk();
    // First container: cache miss → one download. After it, the cache hits.
    let cachePrimed = false;
    fsAccessMock.mockImplementation((p: any) => {
      if (String(p).includes('digby-gh-cache')) {
        return cachePrimed ? Promise.resolve() : Promise.reject(new Error('cache miss'));
      }
      return Promise.resolve();
    });
    fsRenameMock.mockImplementation(() => { cachePrimed = true; }); // download completed

    await expect(ensureSessionContainer(sidA)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    execRoutes(dockerRouter(sessionName(sidB), {}));
    await expect(ensureSessionContainer(sidB)).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1); // still one — second cp came from cache
    expect(ghCpCalls().length).toBe(2);
  });
});
