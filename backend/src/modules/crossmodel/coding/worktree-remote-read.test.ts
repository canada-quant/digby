/**
 * Live cross-box worktree read over Redis pub/sub (owner 2026-09-17).
 *
 * Hermetic: an in-memory pub/sub bus stands in for Redis (both the requester's
 * reply subscription and the responder's request subscription ride it), and
 * the responder is pointed at a temp worktree via `resolveRoot`. Pins the
 * protocol (request → one reply matched by id), every disk guard the web
 * handler applies (400/404/413/415), the "not hosted here → silent" rule, the
 * zero-subscriber fast null, the timeout null, and the kill switch.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'digby-wt-remote-'));
process.env.CODING_WORKSPACE_ROOT = ROOT;
const ENV_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'digby-wt-remote-env-'));
process.env.CODING_ENV_ROOT = ENV_ROOT;

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: {} }));
jest.mock('./coding-data.service', () => ({ getSessionForUser: jest.fn() }));

import {
  createRemoteReader,
  startWorktreeReadResponder,
  requestRemoteWorktreeFile,
  readForReply,
  REMOTE_READ_REQUEST_CHANNEL,
  REMOTE_READ_REPLY_PREFIX,
  isDevcWire,
  type PubSubClient,
  type RemoteReadReply,
} from './worktree-remote-read';

type Listener = (message: string, channel: string) => void;

/** One process-wide fake bus: exact-channel subscribers + `prefix*` patterns. */
class FakeBus {
  subs = new Map<string, Set<Listener>>();
  pats = new Map<string, Set<Listener>>();
  publish(channel: string, message: string): number {
    let n = 0;
    for (const l of this.subs.get(channel) ?? []) { n++; setImmediate(() => l(message, channel)); }
    for (const [pat, ls] of this.pats) {
      const prefix = pat.endsWith('*') ? pat.slice(0, -1) : pat;
      if (!channel.startsWith(prefix)) continue;
      for (const l of ls) { n++; setImmediate(() => l(message, channel)); }
    }
    return n;
  }
}

class FakeClient implements PubSubClient {
  constructor(private readonly bus: FakeBus, public readonly log: string[] = []) {}
  duplicate() { return new FakeClient(this.bus, this.log); }
  async connect() { /* no-op */ }
  async quit() { /* no-op */ }
  on() { /* no-op */ }
  async publish(channel: string, message: string) {
    this.log.push(`publish ${channel}`);
    return this.bus.publish(channel, message);
  }
  async subscribe(channel: string, listener: Listener) {
    if (!this.bus.subs.has(channel)) this.bus.subs.set(channel, new Set());
    this.bus.subs.get(channel)!.add(listener);
  }
  async unsubscribe(channel: string) { this.bus.subs.delete(channel); }
  async pSubscribe(pattern: string, listener: Listener) {
    if (!this.bus.pats.has(pattern)) this.bus.pats.set(pattern, new Set());
    this.bus.pats.get(pattern)!.add(listener);
  }
  async pUnsubscribe(pattern: string) { this.bus.pats.delete(pattern); }
}

const SID = 'remote-read-session-1';
const WT = path.join(ROOT, 'worktrees', SID);

beforeAll(() => {
  fs.mkdirSync(path.join(WT, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(WT, 'docs', 'BACKUPS.md'), '# Backups\n\nnightly to S3\n');
  fs.writeFileSync(path.join(WT, 'big.txt'), Buffer.alloc(256 * 1024 + 1, 0x61));
  fs.writeFileSync(path.join(WT, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x10]));
  fs.mkdirSync(path.join(WT, '.git'), { recursive: true });
  fs.writeFileSync(path.join(WT, '.git', 'HEAD'), 'ref: refs/heads/main\n');
});

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(ENV_ROOT, { recursive: true, force: true });
});

afterEach(() => { delete process.env.WORKTREE_REMOTE_READ_DISABLED; });

describe('requester ↔ responder over the bus', () => {
  test('a hosted file round-trips with its content; the reply is matched by id', async () => {
    const bus = new FakeBus();
    const client = new FakeClient(bus);
    const responder = await startWorktreeReadResponder({ client, resolveRoot: (sid) => path.join(ROOT, 'worktrees', sid) });
    const reader = createRemoteReader(client);
    try {
      const reply = await reader.request(SID, 'docs/BACKUPS.md', 2_000);
      expect(reply).toEqual(expect.objectContaining({ ok: true, path: 'docs/BACKUPS.md', content: '# Backups\n\nnightly to S3\n' }));
      // One request → one publish on the request channel → one reply on the id-specific channel.
      expect(client.log.filter(l => l === `publish ${REMOTE_READ_REQUEST_CHANNEL}`)).toHaveLength(1);
      expect(client.log.filter(l => l.startsWith(`publish ${REMOTE_READ_REPLY_PREFIX}`))).toHaveLength(1);
    } finally {
      await reader.close();
      await responder.stop();
    }
  });

  test('the responder applies the web handler\'s guards: 404 missing, 413 too large, 415 binary, 400 dir / .git / escape', async () => {
    const bus = new FakeBus();
    const client = new FakeClient(bus);
    const responder = await startWorktreeReadResponder({ client, resolveRoot: (sid) => path.join(ROOT, 'worktrees', sid) });
    const reader = createRemoteReader(client);
    try {
      const status = async (rel: string) => {
        const r = (await reader.request(SID, rel, 2_000)) as RemoteReadReply | null;
        return r && !r.ok ? r.status : r?.ok ? 200 : null;
      };
      expect(await status('docs/nope.md')).toBe(404);
      expect(await status('big.txt')).toBe(413);
      expect(await status('blob.bin')).toBe(415);
      expect(await status('docs')).toBe(400);
      expect(await status('.git/HEAD')).toBe(400);
      expect(await status('../other/x.md')).toBe(400);
    } finally {
      await reader.close();
      await responder.stop();
    }
  });

  test('a responder that does not host the worktree stays silent → the requester times out to null', async () => {
    const bus = new FakeBus();
    const client = new FakeClient(bus);
    const responder = await startWorktreeReadResponder({ client, resolveRoot: () => path.join(ROOT, 'nowhere') });
    const reader = createRemoteReader(client);
    try {
      const t0 = Date.now();
      expect(await reader.request(SID, 'docs/BACKUPS.md', 80)).toBeNull();
      expect(Date.now() - t0).toBeGreaterThanOrEqual(60);
      // The request went out; nothing came back.
      expect(client.log.some(l => l.startsWith(`publish ${REMOTE_READ_REPLY_PREFIX}`))).toBe(false);
    } finally {
      await reader.close();
      await responder.stop();
    }
  });

  test('no responder anywhere (publish reaches nobody) → null at once, not after the timeout', async () => {
    const client = new FakeClient(new FakeBus());
    const reader = createRemoteReader(client);
    try {
      const t0 = Date.now();
      expect(await reader.request(SID, 'docs/BACKUPS.md', 5_000)).toBeNull();
      expect(Date.now() - t0).toBeLessThan(1_000);
    } finally {
      await reader.close();
    }
  });

  test('garbage and malformed requests on the channel are ignored (no throw, no reply)', async () => {
    const bus = new FakeBus();
    const client = new FakeClient(bus);
    const responder = await startWorktreeReadResponder({ client, resolveRoot: (sid) => path.join(ROOT, 'worktrees', sid) });
    try {
      await client.publish(REMOTE_READ_REQUEST_CHANNEL, 'not json');
      await client.publish(REMOTE_READ_REQUEST_CHANNEL, JSON.stringify({ id: 'x' }));
      await client.publish(REMOTE_READ_REQUEST_CHANNEL, JSON.stringify({ id: 'x', sessionId: '../../etc', rel: 'passwd', replyTo: `${REMOTE_READ_REPLY_PREFIX}x` }));
      await client.publish(REMOTE_READ_REQUEST_CHANNEL, JSON.stringify({ id: 'x', sessionId: SID, rel: 'docs/BACKUPS.md', replyTo: 'somewhere:else' }));
      await new Promise(r => setTimeout(r, 50));
      expect(client.log.some(l => l.startsWith(`publish ${REMOTE_READ_REPLY_PREFIX}`))).toBe(false);
    } finally {
      await responder.stop();
    }
  });

  test('bad session ids short-circuit to null without publishing', async () => {
    const client = new FakeClient(new FakeBus());
    const reader = createRemoteReader(client);
    try {
      expect(await reader.request('bad id!', 'docs/BACKUPS.md', 100)).toBeNull();
      expect(await reader.request('../../etc', 'passwd', 100)).toBeNull();
      expect(client.log).toHaveLength(0);
    } finally {
      await reader.close();
    }
  });

  test('the process-wide requester tolerates a client without pub/sub (returns null)', async () => {
    // config/redis is mocked as `{}` here — duplicate() is missing, so the
    // reply subscription cannot be set up; the web handler must get null and
    // fall through to its honest 404, never a thrown error.
    expect(await requestRemoteWorktreeFile(SID, 'docs/BACKUPS.md', 100)).toBeNull();
  });
});

describe('readForReply', () => {
  test('returns the worktree-relative path it resolved and the utf8 content', async () => {
    const r = await readForReply(WT, { id: 'r1', sessionId: SID, rel: './docs/BACKUPS.md', replyTo: `${REMOTE_READ_REPLY_PREFIX}r1` });
    expect(r).toEqual({ id: 'r1', ok: true, path: 'docs/BACKUPS.md', content: '# Backups\n\nnightly to S3\n' });
  });

  /* ═══ ticket 19fbd876: op 'raw' — the DOWNLOAD byte path ═══
   * The web box's /worktree/raw route asks the hosting box for real bytes
   * when the snapshot lacks them; the responder must skip the text guards
   * (binary sniff / 256 KB cap) the 'read' op applies, keep the path jail +
   * 16 MB cap, and answer base64. */
  test("op 'raw': binary bytes round-trip as base64 — no text guards", async () => {
    // blob.bin (beforeAll): NUL-laden binary that the 'read' op 415s on.
    const r = await readForReply(WT, { id: 'r2', sessionId: SID, rel: 'blob.bin', replyTo: `${REMOTE_READ_REPLY_PREFIX}r2`, op: 'raw' });
    expect(r).toEqual({ id: 'r2', ok: true, path: 'blob.bin', content: '', b64: Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x10]).toString('base64') });
    // And the same file under op 'read' still 415s (the viewer contract is untouched).
    const viewer = await readForReply(WT, { id: 'r3', sessionId: SID, rel: 'blob.bin', replyTo: `${REMOTE_READ_REPLY_PREFIX}r3` });
    expect(viewer).toMatchObject({ ok: false, status: 415 });
  });

  test("op 'raw': viewer-oversize under 16 MB downloads fine (cap is MAX_RAW_BYTES)", async () => {
    // big.txt (beforeAll): 256 KB + 1 — the viewer 413s, the raw path serves it.
    const r = await readForReply(WT, { id: 'r4', sessionId: SID, rel: 'big.txt', replyTo: `${REMOTE_READ_REPLY_PREFIX}r4`, op: 'raw' });
    expect(r.ok).toBe(true);
    if (r.ok && 'b64' in r) expect(Buffer.from(r.b64, 'base64').length).toBe(256 * 1024 + 1);
  });

  test("op 'raw' keeps the path jail: escape and .git reject, directory 400s", async () => {
    let r = await readForReply(WT, { id: 'r5', sessionId: SID, rel: '../escape', replyTo: `${REMOTE_READ_REPLY_PREFIX}r5`, op: 'raw' });
    expect(r).toMatchObject({ ok: false, status: 400 });

    r = await readForReply(WT, { id: 'r6', sessionId: SID, rel: '.git/HEAD', replyTo: `${REMOTE_READ_REPLY_PREFIX}r6`, op: 'raw' });
    expect(r).toMatchObject({ ok: false, status: 400 });

    r = await readForReply(WT, { id: 'r7', sessionId: SID, rel: 'docs', replyTo: `${REMOTE_READ_REPLY_PREFIX}r7`, op: 'raw' });
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  test("op 'raw' over the 16 MB cap rejects 413", async () => {
    fs.writeFileSync(path.join(WT, 'huge-raw.bin'), Buffer.alloc(16 * 1024 * 1024 + 1, 0x61));
    try {
      const r = await readForReply(WT, { id: 'r8', sessionId: SID, rel: 'huge-raw.bin', replyTo: `${REMOTE_READ_REPLY_PREFIX}r8`, op: 'raw' });
      expect(r).toMatchObject({ ok: false, status: 413 });
    } finally {
      fs.rmSync(path.join(WT, 'huge-raw.bin'), { force: true });
    }
  });

  test("requester op 'raw' round-trips through the bus (request → b64 reply)", async () => {
    const bus = new FakeBus();
    const handle = await startWorktreeReadResponder({ client: new FakeClient(bus), resolveRoot: () => WT });
    try {
      const reader = createRemoteReader(new FakeClient(bus));
      const r = await reader.request(SID, 'blob.bin', 2_000, 'raw');
      expect(r).toMatchObject({ ok: true, path: 'blob.bin' });
      if (r && r.ok && 'b64' in r) {
        expect(Buffer.from(r.b64, 'base64')).toEqual(Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x10]));
      } else {
        throw new Error('expected a b64 reply');
      }
      await reader.close();
    } finally {
      await handle.stop();
    }
  });
});

// op 'devc' (2026-10-13): Account → Coding → Dev container operations ride the
// same channel to the worker that has Docker.
describe("op 'devc' — dev-container operations over the same channel", () => {
  const UID = '83e4fbf9-e18a-4c1d-9b2e-000000000001';

  test('round-trips {userId, action} to the handler and returns its JSON result', async () => {
    const bus = new FakeBus();
    const seen: any[] = [];
    const handle = await startWorktreeReadResponder({
      client: new FakeClient(bus), resolveRoot: () => WT,
      handleDevc: async (devc, requestId) => { seen.push({ devc, requestId }); return { status: { container: 'digby-dev-x', running: true } }; },
    });
    try {
      const reader = createRemoteReader(new FakeClient(bus));
      const r = await reader.request('', '', 2_000, 'devc', { userId: UID, action: 'status' });
      expect(r).toMatchObject({ ok: true, devc: { status: { container: 'digby-dev-x', running: true } } });
      expect(seen).toHaveLength(1);
      expect(seen[0].devc).toEqual({ userId: UID, action: 'status' });
      expect(typeof seen[0].requestId).toBe('string');
      await reader.close();
    } finally {
      await handle.stop();
    }
  });

  test('a responder whose handler returns null (no Docker here) stays SILENT — the requester times out to null', async () => {
    const bus = new FakeBus();
    const handle = await startWorktreeReadResponder({ client: new FakeClient(bus), resolveRoot: () => WT, handleDevc: async () => null });
    try {
      const reader = createRemoteReader(new FakeClient(bus));
      const t0 = Date.now();
      const r = await reader.request('', '', 300, 'devc', { userId: UID, action: 'status' });
      expect(r).toBeNull();
      expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
      await reader.close();
    } finally {
      await handle.stop();
    }
  });

  test('a devc request never reaches the file-read path (no worktree lookup)', async () => {
    const bus = new FakeBus();
    const roots: string[] = [];
    const handle = await startWorktreeReadResponder({
      client: new FakeClient(bus), resolveRoot: (sid) => { roots.push(sid); return WT; },
      handleDevc: async () => ({ pushed: true }),
    });
    try {
      const reader = createRemoteReader(new FakeClient(bus));
      const r = await reader.request('', '', 2_000, 'devc', { userId: UID, action: 'egress_push' });
      expect(r).toMatchObject({ ok: true, devc: { pushed: true } });
      expect(roots).toEqual([]);
      await reader.close();
    } finally {
      await handle.stop();
    }
  });

  test('the requester refuses a malformed devc payload without publishing', async () => {
    const bus = new FakeBus();
    const client = new FakeClient(bus);
    const reader = createRemoteReader(client);
    expect(await reader.request('', '', 200, 'devc', { userId: 'x', action: 'status' })).toBeNull();
    expect(await reader.request('', '', 200, 'devc', { userId: UID, action: 'Rm -rf' })).toBeNull();
    expect(client.log.filter((l) => l.startsWith(`publish ${REMOTE_READ_REQUEST_CHANNEL}`))).toHaveLength(0);
    await reader.close();
  });

  test('isDevcWire: only a safe userId, a lowercase action and short string args pass', () => {
    expect(isDevcWire({ userId: UID, action: 'tailnet_reconnect' })).toBe(true);
    expect(isDevcWire({ userId: UID, action: 'session_egress_refresh', args: { sessionId: 'abc-123456' } })).toBe(true);
    expect(isDevcWire({ userId: '../etc', action: 'status' })).toBe(false);
    expect(isDevcWire({ userId: UID, action: 'status; rm' })).toBe(false);
    expect(isDevcWire({ userId: UID, action: 'status', args: { sessionId: 'x'.repeat(101) } })).toBe(false);
    expect(isDevcWire({ userId: UID, action: 'status', args: { 'bad key': 'v' } })).toBe(false);
    expect(isDevcWire({ userId: UID, action: 'status', args: ['a'] })).toBe(false);
    expect(isDevcWire(null)).toBe(false);
  });
});
