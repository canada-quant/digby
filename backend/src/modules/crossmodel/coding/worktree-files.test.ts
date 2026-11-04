/**
 * Tests for the Phase-1 worktree file tree + inline file viewer
 * (feedback ticket 999e3dbe).
 *
 * (a) resolveSafeWorktreePath — the path-escape guard, unit-tested against a
 *     real tmp dir: normal relative paths accepted; '..' escape, absolute
 *     paths, drive-letter/backslash tricks, NUL bytes, .git / node_modules
 *     smuggling, and SYMLINK escapes all rejected.
 * (b) The two handlers (getWorktreeTree / getWorktreeFile) against a REAL git
 *     repo provisioned in a tmp CODING_WORKSPACE_ROOT: committed / modified /
 *     untracked / ignored / deleted fixtures exercise the badge mapping, the
 *     default .gitignore filter + showIgnored=1, nested-dir listing, and the
 *     file endpoint's content / 400-dir / 413->256KB / 415-binary contract.
 * (c) The ownership + no-worktree 404 gates (getSessionForUser mocked).
 *
 * Idioms follow workspace-env.test.ts: real git via execFileSync in tmp dirs,
 * env roots set BEFORE the module-under-test is require()'d, logger mocked.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'digby-wt-files-'));
process.env.CODING_WORKSPACE_ROOT = ROOT;
// workspace.service's load-time guard refuses an env root INSIDE the workspace
// volume — sibling tmp dir, same as workspace-env.test.ts.
const ENV_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'digby-wt-files-env-'));
process.env.CODING_ENV_ROOT = ENV_ROOT;

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Ticket 1c767622: worktree-files now falls back to the Redis-published
// snapshot when the chat's worktree is not on THIS box's volume — mock the
// client (in-memory Map, instances.service.test.ts idiom) so the no-disk
// paths are hermetic.
const redisStore = new Map<string, string>();
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    setEx: jest.fn(async (k: string, _ttl: number, v: string) => { redisStore.set(k, v); return 'OK'; }),
    get: jest.fn(async (k: string) => redisStore.get(k) ?? null),
    del: jest.fn(async (k: string) => (redisStore.delete(k) ? 1 : 0)),
  },
}));

// Ownership seam — the same one coding-stream.controller's other routes use.
const mockGetSessionForUser: jest.Mock = jest.fn();
jest.mock('./coding-data.service', () => ({
  getSessionForUser: (...a: any[]) => mockGetSessionForUser(...a),
}));

const wf = require('./worktree-files') as typeof import('./worktree-files');

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  }).trim();

const CHAT = 'wtchat-phase1';
const WT = path.join(ROOT, 'worktrees', CHAT);

const SESSION: any = {
  id: CHAT, projectId: 'p1', userId: 'u1', title: 't', branch: 'digby/session-wtchat',
  baseBranch: 'main', worktreePath: WT, permissionMode: 'auto', model: 'glm-5.3',
  status: 'ready', errorMessage: null, createdAt: new Date(), updatedAt: new Date(),
};

/* ── req/res fakes (same shape as coding-stream.controller.test.ts) ── */
const mkReq = (over: any = {}): any => ({
  params: { chatId: CHAT },
  query: {},
  body: {},
  headers: {},
  user: { id: 'u1' },
  ...over,
});
const mkRes = (): any => {
  const res: any = {
    statusCode: 200,
    body: undefined as any,
    status: jest.fn((c: number) => { res.statusCode = c; return res; }),
    json: jest.fn((b: any) => { res.body = b; return res; }),
  };
  return res;
};

beforeAll(() => {
  // A REAL repo at the chatId-keyed worktree path:
  //   README.md   committed, then modified   → badge M
  //   src/index.ts committed (nested dir)
  //   gone.txt    committed, then deleted    → badge D (still listed, from ls-tree)
  //   notes.txt   untracked                  → badge ?
  //   secret.log  untracked + .gitignore'd   → hidden by default, shown with showIgnored=1
  //   .gitignore  committed (itself a normal file — NOT guard-blocked)
  fs.mkdirSync(WT, { recursive: true });
  git(['init', '-b', 'main'], WT);
  fs.mkdirSync(path.join(WT, 'src'), { recursive: true });
  fs.writeFileSync(path.join(WT, 'README.md'), 'hello\n');
  fs.writeFileSync(path.join(WT, 'src', 'index.ts'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(WT, 'gone.txt'), 'gone\n');
  fs.writeFileSync(path.join(WT, '.gitignore'), 'secret.log\n');
  git(['add', '-A'], WT);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init'], WT);
  fs.appendFileSync(path.join(WT, 'README.md'), 'changed\n');       // M
  fs.rmSync(path.join(WT, 'gone.txt'));                              // D
  fs.writeFileSync(path.join(WT, 'notes.txt'), 'untracked\n');       // ?
  fs.writeFileSync(path.join(WT, 'secret.log'), 'ignored\n');        // ignored
}, 30_000);

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(ENV_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSessionForUser.mockResolvedValue(SESSION);
});

/* ═══ (a) the path-escape guard ═══ */
describe('resolveSafeWorktreePath (ticket 999e3dbe)', () => {
  test('accepts normal relative paths and the worktree root', async () => {
    const root = await wf.resolveSafeWorktreePath(WT, '');
    expect(root.rel).toBe('');
    expect(root.abs).toBe(fs.realpathSync(WT));

    const f = await wf.resolveSafeWorktreePath(WT, 'src/index.ts');
    expect(f.rel).toBe('src/index.ts');
    expect(f.abs).toBe(fs.realpathSync(path.join(WT, 'src', 'index.ts')));

    // Redundant-but-safe spellings normalize to the same in-root target.
    const d = await wf.resolveSafeWorktreePath(WT, './src/');
    expect(d.rel).toBe('src');
  });

  test('accepts .gitignore — the first-segment block is segment-EXACT', async () => {
    const f = await wf.resolveSafeWorktreePath(WT, '.gitignore');
    expect(f.rel).toBe('.gitignore');
  });

  test('rejects a .. escape (even one that lands back inside)', async () => {
    await expect(wf.resolveSafeWorktreePath(WT, '../../etc/passwd'))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(wf.resolveSafeWorktreePath(WT, 'src/../README.md'))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  test('rejects absolute paths and drive-letter/backslash tricks', async () => {
    await expect(wf.resolveSafeWorktreePath(WT, '/etc/passwd'))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(wf.resolveSafeWorktreePath(WT, 'C:\\Windows\\system32'))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(wf.resolveSafeWorktreePath(WT, 'src\\..\\..\\etc'))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  test('rejects NUL bytes', async () => {
    await expect(wf.resolveSafeWorktreePath(WT, 'src/\0index.ts'))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  test('rejects .git and node_modules smuggling at any depth', async () => {
    await expect(wf.resolveSafeWorktreePath(WT, '.git/config'))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(wf.resolveSafeWorktreePath(WT, '.git'))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(wf.resolveSafeWorktreePath(WT, 'node_modules/lodash/index.js'))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(wf.resolveSafeWorktreePath(WT, 'src/.git/hooks/x'))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(wf.resolveSafeWorktreePath(WT, 'src/node_modules/y'))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  test('rejects a SYMLINK escape (realpath containment)', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'digby-wt-outside-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret\n');
    fs.symlinkSync(outside, path.join(WT, 'link-out'));
    try {
      await expect(wf.resolveSafeWorktreePath(WT, 'link-out'))
        .rejects.toMatchObject({ statusCode: 400 });
      await expect(wf.resolveSafeWorktreePath(WT, 'link-out/secret.txt'))
        .rejects.toMatchObject({ statusCode: 400 });
    } finally {
      fs.rmSync(path.join(WT, 'link-out'), { force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('a symlink that resolves INSIDE the worktree is allowed', async () => {
    fs.symlinkSync(path.join(WT, 'src'), path.join(WT, 'link-in'));
    try {
      const r = await wf.resolveSafeWorktreePath(WT, 'link-in/index.ts');
      expect(r.rel).toBe('src/index.ts');
    } finally {
      fs.rmSync(path.join(WT, 'link-in'), { force: true });
    }
  });

  test('rejects a symlink that resolves INTO .git — review finding F1 (ticket 999e3dbe)', async () => {
    // An in-worktree symlink pointing AT .git passes the pre-realpath segment
    // ban (its NAME is innocuous) and resolves inside the root (containment
    // passes) — only the RESOLVED-path segment re-check catches it. WT is the
    // file-SHARED real git repo (file-level beforeAll), so .git/config already
    // exists — create/remove ONLY the symlink here; never touch the shared
    // .git (deleting it pollutes every later git-dependent test in the file).
    fs.symlinkSync(path.join(WT, '.git'), path.join(WT, 'link-git'));
    try {
      await expect(wf.resolveSafeWorktreePath(WT, 'link-git'))
        .rejects.toMatchObject({ statusCode: 400 });
      await expect(wf.resolveSafeWorktreePath(WT, 'link-git/config'))
        .rejects.toMatchObject({ statusCode: 400 });
    } finally {
      fs.rmSync(path.join(WT, 'link-git'), { force: true });
    }
  });

  test('a missing in-root path is a 404, not a 400', async () => {
    await expect(wf.resolveSafeWorktreePath(WT, 'no/such/file.txt'))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});

/* ═══ (b) handlers over a real git worktree ═══ */
describe('GET …/worktree/tree (ticket 999e3dbe)', () => {
  test('root lists one level with correct badges, dirs first', async () => {
    const res = mkRes();
    await wf.getWorktreeTree(mkReq({ query: {} }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.path).toBe('');
    const names = res.body.entries.map((e: any) => e.name);
    // .git / node_modules never listed; secret.log ignored by default;
    // gone.txt still listed (tracked in HEAD) with its D badge.
    expect(names).toEqual(['src', '.gitignore', 'README.md', 'gone.txt', 'notes.txt']);
    const byName = Object.fromEntries(res.body.entries.map((e: any) => [e.name, e]));
    expect(byName['src']).toMatchObject({ type: 'dir', path: 'src' });
    expect(byName['src'].status).toBeUndefined();
    expect(byName['README.md']).toMatchObject({ type: 'file', path: 'README.md', status: 'M' });
    expect(byName['README.md'].size).toBeGreaterThan(0);
    expect(byName['gone.txt']).toMatchObject({ type: 'file', status: 'D' });
    expect(byName['notes.txt']).toMatchObject({ type: 'file', status: '?' });
    expect(byName['.gitignore'].status).toBeUndefined();
  });

  test('showIgnored=1 surfaces the .gitignore-d file', async () => {
    const res = mkRes();
    await wf.getWorktreeTree(mkReq({ query: { showIgnored: '1' } }), res);
    expect(res.statusCode).toBe(200);
    const names = res.body.entries.map((e: any) => e.name);
    expect(names).toContain('secret.log');
    // Ignored files carry no porcelain row — no badge, but present.
    const secret = res.body.entries.find((e: any) => e.name === 'secret.log');
    expect(secret.type).toBe('file');
  });

  test('a nested dir fetch lists that level with repo-relative paths', async () => {
    const res = mkRes();
    await wf.getWorktreeTree(mkReq({ query: { path: 'src' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.path).toBe('src');
    expect(res.body.entries).toEqual([
      { name: 'index.ts', path: 'src/index.ts', type: 'file', size: 20, mtime: expect.any(Number) },
    ]);
  });

  test('a file path is a 400 on the tree endpoint', async () => {
    const res = mkRes();
    await wf.getWorktreeTree(mkReq({ query: { path: 'README.md' } }), res);
    expect(res.statusCode).toBe(400);
  });

  test('guard violations and missing dirs map to 400 / 404', async () => {
    let res = mkRes();
    await wf.getWorktreeTree(mkReq({ query: { path: '../..' } }), res);
    expect(res.statusCode).toBe(400);

    res = mkRes();
    await wf.getWorktreeTree(mkReq({ query: { path: '.git' } }), res);
    expect(res.statusCode).toBe(400);

    res = mkRes();
    await wf.getWorktreeTree(mkReq({ query: { path: 'no/such/dir' } }), res);
    expect(res.statusCode).toBe(404);
  });
});

describe('GET …/worktree/file (ticket 999e3dbe)', () => {
  test('returns UTF-8 content for a normal file', async () => {
    const res = mkRes();
    await wf.getWorktreeFile(mkReq({ query: { path: 'src/index.ts' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      path: 'src/index.ts',
      content: 'export const x = 1;\n',
      truncated: false,
    });
  });

  test('untracked and deleted-file reads follow the disk (present / 404)', async () => {
    let res = mkRes();
    await wf.getWorktreeFile(mkReq({ query: { path: 'notes.txt' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.content).toBe('untracked\n');

    res = mkRes();
    await wf.getWorktreeFile(mkReq({ query: { path: 'gone.txt' } }), res);
    expect(res.statusCode).toBe(404);
  });

  test('rejects a directory (400)', async () => {
    const res = mkRes();
    await wf.getWorktreeFile(mkReq({ query: { path: 'src' } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/directory/i);
  });

  test('rejects files over 256KB (413)', async () => {
    fs.writeFileSync(path.join(WT, 'big.txt'), 'a'.repeat(257 * 1024));
    try {
      const res = mkRes();
      await wf.getWorktreeFile(mkReq({ query: { path: 'big.txt' } }), res);
      expect(res.statusCode).toBe(413);
      expect(res.body.error).toMatch(/too large/i);
    } finally {
      fs.rmSync(path.join(WT, 'big.txt'), { force: true });
    }
  });

  test('rejects binary files (415)', async () => {
    const bin = Buffer.alloc(1024);
    for (let i = 0; i < bin.length; i++) bin[i] = i % 256; // plenty of NULs + control bytes
    fs.writeFileSync(path.join(WT, 'bin.dat'), bin);
    try {
      const res = mkRes();
      await wf.getWorktreeFile(mkReq({ query: { path: 'bin.dat' } }), res);
      expect(res.statusCode).toBe(415);
      expect(res.body.error).toMatch(/binary/i);
    } finally {
      fs.rmSync(path.join(WT, 'bin.dat'), { force: true });
    }
  });

  test('rejects .git reads and escapes via the guard (400), missing path (400/404)', async () => {
    let res = mkRes();
    await wf.getWorktreeFile(mkReq({ query: { path: '.git/config' } }), res);
    expect(res.statusCode).toBe(400);

    res = mkRes();
    await wf.getWorktreeFile(mkReq({ query: { path: '../../etc/passwd' } }), res);
    expect(res.statusCode).toBe(400);

    res = mkRes();
    await wf.getWorktreeFile(mkReq({ query: {} }), res);
    expect(res.statusCode).toBe(400);

    res = mkRes();
    await wf.getWorktreeFile(mkReq({ query: { path: 'no/such.txt' } }), res);
    expect(res.statusCode).toBe(404);
  });
});

/* ═══ (b2) ticket 19fbd876: the DOWNLOAD byte route ═══
 *
 * The incident: a binary worktree file (a real PDF, 58,993 bytes) previewed
 * as the 415 notice text in the Files tab, and the download button blobbed
 * THAT TEXT out as a mislabeled `.txt` — there was no byte route at all. This
 * block pins the new contract: real bytes (binary fine), octet-stream +
 * Content-Disposition with the basename, the 16 MB download cap (NOT the
 * viewer's 256 KB), and the same path-jail / ownership gates as /file.
 */
describe('GET …/worktree/raw (ticket 19fbd876)', () => {
  /** res fake with the header capture the raw route needs. */
  const mkRawRes = (): any => {
    const res: any = {
      statusCode: 200,
      body: undefined as any,
      headers: {} as Record<string, string>,
      status: jest.fn((c: number) => { res.statusCode = c; return res; }),
      json: jest.fn((b: any) => { res.body = b; return res; }),
      setHeader: jest.fn((k: string, v: string) => { res.headers[k.toLowerCase()] = String(v); return res; }),
      send: jest.fn((b: any) => { res.body = b; return res; }),
    };
    return res;
  };

  test('serves a BINARY file\'s real bytes with octet-stream + basename disposition', async () => {
    // The incident shape: a small binary with NUL bytes (415 on the viewer).
    const bin = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x00, 0xff, 0x10, 0x0a, 0x25]);
    fs.writeFileSync(path.join(WT, 'deck.pdf'), bin);
    try {
      const res = mkRawRes();
      await wf.getWorktreeRaw(mkReq({ query: { path: 'deck.pdf' } }), res);
      expect(res.statusCode).toBe(200);
      expect(Buffer.isBuffer(res.body)).toBe(true);
      expect((res.body as Buffer).equals(bin)).toBe(true); // exact bytes, not notice text
      expect(res.headers['content-type']).toBe('application/octet-stream');
      expect(res.headers['content-disposition']).toBe('attachment; filename="deck.pdf"; filename*=UTF-8\'\'deck.pdf');
      expect(res.headers['content-length']).toBe(String(bin.length));
    } finally {
      fs.rmSync(path.join(WT, 'deck.pdf'), { force: true });
    }
  });

  test('nested paths keep the basename only in the disposition header', async () => {
    fs.writeFileSync(path.join(WT, 'src', 'deep.bin'), Buffer.from([0x00, 0x01, 0x02]));
    try {
      const res = mkRawRes();
      await wf.getWorktreeRaw(mkReq({ query: { path: 'src/deep.bin' } }), res);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-disposition']).toBe('attachment; filename="deep.bin"; filename*=UTF-8\'\'deep.bin');
    } finally {
      fs.rmSync(path.join(WT, 'src', 'deep.bin'), { force: true });
    }
  });

  test('review B2 (ticket 19fbd876): a quote in the basename cannot break the header; non-ASCII rides filename*', async () => {
    // A file named foo".pdf must not ship a malformed header (the raw template
    // literal did), and a non-latin1 basename must not 500 the response.
    fs.writeFileSync(path.join(WT, 'foo".pdf'), Buffer.from([0x00, 0x01]));
    fs.writeFileSync(path.join(WT, 'café.pdf'), Buffer.from([0x00, 0x02]));
    try {
      let res = mkRawRes();
      await wf.getWorktreeRaw(mkReq({ query: { path: 'foo".pdf' } }), res);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-disposition']).toBe('attachment; filename="foo_.pdf"; filename*=UTF-8\'\'foo%22.pdf');

      res = mkRawRes();
      await wf.getWorktreeRaw(mkReq({ query: { path: 'café.pdf' } }), res);
      expect(res.statusCode).toBe(200);
      // The ASCII fallback underscores the é; the filename* form carries it.
      expect(res.headers['content-disposition']).toBe('attachment; filename="caf_.pdf"; filename*=UTF-8\'\'caf%C3%A9.pdf');
    } finally {
      fs.rmSync(path.join(WT, 'foo".pdf'), { force: true });
      fs.rmSync(path.join(WT, 'café.pdf'), { force: true });
    }
  });

  test('text files download as bytes too (a download is not a preview)', async () => {
    const res = mkRawRes();
    await wf.getWorktreeRaw(mkReq({ query: { path: 'src/index.ts' } }), res);
    expect(res.statusCode).toBe(200);
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect((res.body as Buffer).toString('utf8')).toBe('export const x = 1;\n');
  });

  test('viewer-oversize files UNDER 16 MB download fine (cap is MAX_RAW_BYTES, not 256 KB)', async () => {
    // 300 KB: over the viewer's 256 KB, under the download's 16 MB.
    fs.writeFileSync(path.join(WT, 'mid.pdf'), Buffer.alloc(300 * 1024, 0x61));
    try {
      const res = mkRawRes();
      await wf.getWorktreeRaw(mkReq({ query: { path: 'mid.pdf' } }), res);
      expect(res.statusCode).toBe(200);
      expect((res.body as Buffer).length).toBe(300 * 1024);
    } finally {
      fs.rmSync(path.join(WT, 'mid.pdf'), { force: true });
    }
  });

  test('rejects files over 16 MB (413)', async () => {
    fs.writeFileSync(path.join(WT, 'huge.bin'), Buffer.alloc(16 * 1024 * 1024 + 1, 0x61));
    try {
      const res = mkRawRes();
      await wf.getWorktreeRaw(mkReq({ query: { path: 'huge.bin' } }), res);
      expect(res.statusCode).toBe(413);
      expect(res.body.error).toMatch(/too large/i);
    } finally {
      fs.rmSync(path.join(WT, 'huge.bin'), { force: true });
    }
  });

  test('same gates as the viewer: directory 400, .git 400, escape 400, missing 404, no-path 400', async () => {
    let res = mkRawRes();
    await wf.getWorktreeRaw(mkReq({ query: { path: 'src' } }), res);
    expect(res.statusCode).toBe(400);

    res = mkRawRes();
    await wf.getWorktreeRaw(mkReq({ query: { path: '.git/config' } }), res);
    expect(res.statusCode).toBe(400);

    res = mkRawRes();
    await wf.getWorktreeRaw(mkReq({ query: { path: '../../etc/passwd' } }), res);
    expect(res.statusCode).toBe(400);

    res = mkRawRes();
    await wf.getWorktreeRaw(mkReq({ query: { path: 'no/such.bin' } }), res);
    expect(res.statusCode).toBe(404);

    res = mkRawRes();
    await wf.getWorktreeRaw(mkReq({ query: {} }), res);
    expect(res.statusCode).toBe(400);
  });

  test('snapshot fallback: no disk + snapshot bytes → base64-decoded real bytes', async () => {
    // The 1c767622 idiom: a chat whose worktree is NOT on this box's volume
    // serves from the Redis-published snapshot. Binary bytes are normally
    // excluded at publish, but when present they are exact.
    const snapChat = 'wtchat-raw-snap';
    const bin = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    redisStore.set('cm:wt-snap:' + snapChat, JSON.stringify({
      v: 1,
      branch: 'digby/session-' + snapChat,
      publishedAt: '2026-09-28T00:00:00.000Z',
      truncated: false,
      entries: [{ path: 'deck.pdf', name: 'deck.pdf', type: 'file', size: bin.length }],
      files: { 'deck.pdf': bin.toString('base64') },
    }));
    mockGetSessionForUser.mockResolvedValueOnce({ ...SESSION, id: snapChat });
    try {
      const res = mkRawRes();
      await wf.getWorktreeRaw(mkReq({ params: { chatId: snapChat }, query: { path: 'deck.pdf' } }), res);
      expect(res.statusCode).toBe(200);
      expect((res.body as Buffer).equals(bin)).toBe(true);
    } finally {
      redisStore.delete('cm:wt-snap:' + snapChat);
    }
  });
});

/* ═══ (c) ownership + worktree-existence gates ═══ */
describe('ownership + worktree gates (ticket 999e3dbe)', () => {
  test('401 when unauthenticated', async () => {
    const res = mkRes();
    await wf.getWorktreeTree(mkReq({ user: undefined }), res);
    expect(res.statusCode).toBe(401);
    expect(mockGetSessionForUser).not.toHaveBeenCalled();
  });

  test('404 (no existence leak) when the chat is not the caller\'s', async () => {
    mockGetSessionForUser.mockResolvedValue(null);
    for (const handler of [wf.getWorktreeTree, wf.getWorktreeFile]) {
      const res = mkRes();
      await handler(mkReq({ query: { path: '' } }), res);
      expect(res.statusCode).toBe(404);
      expect(res.body.error).toBe('Session not found');
    }
    expect(mockGetSessionForUser).toHaveBeenCalledWith(CHAT, 'u1', 'owner');
  });

  test('404 "no worktree" when the chat has no worktree dir on disk', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, id: 'wtchat-missing' });
    for (const handler of [wf.getWorktreeTree, wf.getWorktreeFile]) {
      const res = mkRes();
      await handler(mkReq({ params: { chatId: 'wtchat-missing' }, query: { path: '' } }), res);
      expect(res.statusCode).toBe(404);
      expect(res.body.error).toMatch(/no coding worktree/i);
    }
  });
});

/* ═══ (d) ticket 1c767622: snapshot fallback when this box lacks the volume ═══ */
describe('snapshot fallback (ticket 1c767622)', () => {
  const SNAP_CHAT = 'wtchat-remote';
  const SNAP: any = {
    v: 1,
    branch: 'digby/session-wtchat-remote',
    publishedAt: '2026-09-12T12:00:00.000Z',
    truncated: false,
    entries: [
      { path: 'src', name: 'src', type: 'dir' },
      { path: 'src/app.ts', name: 'app.ts', type: 'file', size: 12, status: 'M' },
      { path: 'notes.md', name: 'notes.md', type: 'file', size: 5, ignored: true },
    ],
    files: { 'src/app.ts': Buffer.from('hello world\n').toString('base64') },
  };

  beforeEach(() => {
    redisStore.clear();
    redisStore.set('cm:wt-snap:wtchat-remote', JSON.stringify(SNAP));
  });

  test('tree: no disk + snapshot → serves the snapshot level (not 404)', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, id: SNAP_CHAT });
    const res = mkRes();
    await wf.getWorktreeTree(mkReq({ params: { chatId: SNAP_CHAT }, query: { path: '' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.path).toBe('');
    expect(Array.isArray(res.body.entries)).toBe(true);
    expect(res.body.entries.map((e: any) => e.path)).toEqual(['src']);
    expect(res.body.snapshot).toEqual({ publishedAt: SNAP.publishedAt, branch: SNAP.branch });
  });

  test('tree: showIgnored filter applies over the snapshot', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, id: SNAP_CHAT });
    let res = mkRes();
    await wf.getWorktreeTree(mkReq({ params: { chatId: SNAP_CHAT }, query: { path: '', showIgnored: '0' } }), res);
    expect(res.body.entries.map((e: any) => e.path)).toEqual(['src']);
    res = mkRes();
    await wf.getWorktreeTree(mkReq({ params: { chatId: SNAP_CHAT }, query: { path: '', showIgnored: '1' } }), res);
    expect(res.body.entries.map((e: any) => e.path)).toEqual(['src', 'notes.md']);
  });

  test('tree: nested snapshot level', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, id: SNAP_CHAT });
    const res = mkRes();
    await wf.getWorktreeTree(mkReq({ params: { chatId: SNAP_CHAT }, query: { path: 'src' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.path).toBe('src');
    expect(res.body.entries.map((e: any) => e.path)).toEqual(['src/app.ts']);
  });

  test('file: no disk + snapshot → serves base64-decoded content', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, id: SNAP_CHAT });
    const res = mkRes();
    await wf.getWorktreeFile(mkReq({ params: { chatId: SNAP_CHAT }, query: { path: 'src/app.ts' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.content).toBe('hello world\n');
    expect(res.body.truncated).toBe(false);
    expect(res.body.snapshot).toBeDefined();
  });

  test('file: listed but content over budget → honest 404, not a crash', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, id: SNAP_CHAT });
    const res = mkRes();
    await wf.getWorktreeFile(mkReq({ params: { chatId: SNAP_CHAT }, query: { path: 'notes.md' } }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/shared snapshot/i);
  });

  test('file: unknown path → 404', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, id: SNAP_CHAT });
    const res = mkRes();
    await wf.getWorktreeFile(mkReq({ params: { chatId: SNAP_CHAT }, query: { path: 'nope.ts' } }), res);
    expect(res.statusCode).toBe(404);
  });

  test('tree: escape attempts still 400 on the snapshot path', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, id: SNAP_CHAT });
    for (const bad of ['..', '/abs', '.git/config']) {
      const res = mkRes();
      await wf.getWorktreeTree(mkReq({ params: { chatId: SNAP_CHAT }, query: { path: bad } }), res);
      expect(res.statusCode).toBe(400);
    }
  });

  test('disk still wins when the snapshot is provision-origin (same generation, full fidelity beats budgeted snapshot)', async () => {
    // CHAT has a real worktree on disk in this test ROOT. A provision-origin
    // snapshot NEVER overrides a local disk copy (origin fence).
    redisStore.set(`cm:wt-snap:${CHAT}`, JSON.stringify({
      v: 1, origin: 'provision', publishedAt: new Date().toISOString(), entries: [{ path: 'ONLY-IN-SNAPSHOT', name: 'ONLY-IN-SNAPSHOT', type: 'file' }], files: {}, truncated: false,
    }));
    mockGetSessionForUser.mockResolvedValue(SESSION);
    const res = mkRes();
    await wf.getWorktreeTree(mkReq({ query: { path: '' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.snapshot).toBeUndefined();
    expect(res.body.entries.map((e: any) => e.path)).not.toContain('ONLY-IN-SNAPSHOT');
  });

  test('a run-origin snapshot beats a fossil disk copy (web box that provisioned but never ran)', async () => {
    // The worker box published after a terminal run (origin:'run') — that is
    // the LIVE copy; a web box's provision-time fossil must not serve.
    redisStore.set(`cm:wt-snap:${CHAT}`, JSON.stringify({
      v: 1, origin: 'run', publishedAt: new Date().toISOString(),
      entries: [{ path: 'FROM-SNAPSHOT.md', name: 'FROM-SNAPSHOT.md', type: 'file' }], files: {}, truncated: false,
    }));
    mockGetSessionForUser.mockResolvedValue(SESSION);
    const res = mkRes();
    await wf.getWorktreeTree(mkReq({ query: { path: '' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.snapshot).toBeDefined();
    expect(res.body.entries.map((e: any) => e.path)).toEqual(['FROM-SNAPSHOT.md']);
  });

  test('an origin-less snapshot never overrides disk (fail-safe for malformed payloads)', async () => {
    redisStore.set(`cm:wt-snap:${CHAT}`, JSON.stringify({
      v: 1, publishedAt: new Date().toISOString(), entries: [{ path: 'ONLY-IN-SNAPSHOT', name: 'ONLY-IN-SNAPSHOT', type: 'file' }], files: {}, truncated: false,
    }));
    mockGetSessionForUser.mockResolvedValue(SESSION);
    const res = mkRes();
    await wf.getWorktreeTree(mkReq({ query: { path: '' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.snapshot).toBeUndefined();
    expect(res.body.entries.map((e: any) => e.path)).not.toContain('ONLY-IN-SNAPSHOT');
  });

  test('no disk + no snapshot → the original 404 message survives', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, id: 'wtchat-neither' });
    const res = mkRes();
    await wf.getWorktreeTree(mkReq({ params: { chatId: 'wtchat-neither' }, query: { path: '' } }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/no coding worktree/i);
  });
});

describe('mtime + live cross-box read (owner 2026-09-17)', () => {
  test('tree entries carry an epoch-ms mtime for files AND dirs; a deleted-from-disk row has none', async () => {
    mockGetSessionForUser.mockResolvedValue(SESSION);
    const res = mkRes();
    await wf.getWorktreeTree(mkReq({ query: {} }), res);
    expect(res.statusCode).toBe(200);
    const byName = Object.fromEntries(res.body.entries.map((e: any) => [e.name, e]));
    expect(typeof byName['src'].mtime).toBe('number');
    expect(typeof byName['README.md'].mtime).toBe('number');
    expect(byName['README.md'].mtime).toBeGreaterThan(Date.now() - 24 * 3600_000);
    expect(byName['gone.txt'].mtime).toBeUndefined();
  });

  test('snapshot-only box, content missing, no responder → the honest 404 names the snapshot AND the unanswered live read', async () => {
    const chat = 'wtchat-snaponly';
    redisStore.set(`cm:wt-snap:${chat}`, JSON.stringify({
      v: 1, origin: 'run', publishedAt: new Date().toISOString(),
      entries: [{ path: 'docs', name: 'docs', type: 'dir' }, { path: 'docs/BACKUPS.md', name: 'BACKUPS.md', type: 'file', size: 300_000 }],
      files: {}, truncated: false,
    }));
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, id: chat });
    let res = mkRes();
    await wf.getWorktreeFile(mkReq({ params: { chatId: chat }, query: { path: 'docs/BACKUPS.md' } }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/shared snapshot/);
    expect(res.body.error).toMatch(/didn't answer/);
    // A path the snapshot never listed (written after the last run, say) is
    // also offered to the live read first; with nobody answering it is a plain 404.
    res = mkRes();
    await wf.getWorktreeFile(mkReq({ params: { chatId: chat }, query: { path: 'docs/NEW.md' } }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});
