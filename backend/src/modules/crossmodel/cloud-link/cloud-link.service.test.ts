/**
 * cloud-link.service — Digby Edge (Phase 3) edge-side link management.
 * Pins: sanitized status (NEVER tokenEnc), pair redeeming the code server-side
 * at the cloud's OPEN endpoint (cloud 401 surfaced as 401, unreachable → 502,
 * malformed success → 502), the singleton row replace on re-pair, token stored
 * AES-256-GCM (never plaintext), tunnel client (re)start on pair, and unlink
 * stopping the client + best-effort cloud self-revoke + row delete (a dead
 * cloud never blocks the local unlink). Prisma + axios + the tunnel client
 * singleton are mocked.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/env', () => ({ env: { NODE_ENV: 'test' } }));

const mockTunnel = {
  restart: jest.fn(async () => {}),
  stop: jest.fn(),
  start: jest.fn(async () => {}),
  startPendingPairing: jest.fn(async () => {}),
  isConnected: jest.fn(() => false),
};
jest.mock('../../../cloud-link/tunnel-client', () => ({
  cloudLinkTunnel: mockTunnel,
  startCloudLinkTunnelIfLinked: jest.fn(),
}));

const redisStore = new Map<string, string>();
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    setEx: jest.fn(async (k: string, _ttl: number, v: string) => { redisStore.set(k, v); return 'OK'; }),
    get: jest.fn(async (k: string) => redisStore.get(k) ?? null),
    getDel: jest.fn(async (k: string) => {
      const v = redisStore.get(k) ?? null;
      redisStore.delete(k);
      return v;
    }),
    del: jest.fn(async (k: string) => (redisStore.delete(k) ? 1 : 0)),
  },
}));

const db: any[] = [];
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    cloudLink: {
      findFirst: jest.fn(async () => db[db.length - 1] || null),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `l${db.length + 1}`, createdAt: new Date(), updatedAt: new Date(), ...data };
        db.push(row); return row;
      }),
      delete: jest.fn(async ({ where }: any) => {
        const i = db.findIndex(r => r.id === where.id);
        if (i < 0) throw new Error('not found');
        return db.splice(i, 1)[0];
      }),
      deleteMany: jest.fn(async () => {
        const count = db.length; db.length = 0; return { count };
      }),
    },
    $transaction: jest.fn(async (ops: Promise<any>[]) => Promise.all(ops)),
  },
}));

jest.mock('axios');
import axios from 'axios';
const mockedAxios = axios as jest.Mocked<typeof axios>;

import {
  getCloudLinkStatus, pairToCloud, unlinkFromCloud, normalizeCloudUrl,
  startEdgePairingCode,
} from './cloud-link.service';

beforeEach(() => {
  db.length = 0;
  redisStore.clear();
  jest.clearAllMocks();
  mockTunnel.isConnected.mockReturnValue(false);
});

describe('normalizeCloudUrl', () => {
  it('accepts full URLs, stripping trailing slashes and lowercasing scheme+host', async () => {
    expect(normalizeCloudUrl('https://digby.ai/')).toBe('https://digby.ai');
    expect(normalizeCloudUrl('HTTPS://DIGBY.AI')).toBe('https://digby.ai');
    expect(normalizeCloudUrl('http://192.168.1.10:8080/')).toBe('http://192.168.1.10:8080');
  });

  it('prepends https:// when no scheme was entered', async () => {
    expect(normalizeCloudUrl('digby.ai')).toBe('https://digby.ai');
    expect(normalizeCloudUrl('  digby.ai  ')).toBe('https://digby.ai');
    expect(normalizeCloudUrl('digby.ai:8443')).toBe('https://digby.ai:8443');
    expect(normalizeCloudUrl('localhost:4000')).toBe('https://localhost:4000');
  });

  it('rejects clearly: empty, non-http(s) schemes, unparseable input', async () => {
    expect(() => normalizeCloudUrl('')).toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(() => normalizeCloudUrl('   ')).toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(() => normalizeCloudUrl('ftp://h')).toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(() => normalizeCloudUrl('https://')).toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(() => normalizeCloudUrl('not a url')).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
});

describe('getCloudLinkStatus', () => {
  it('reports unlinked with no row and NEVER serializes tokenEnc', async () => {
    const s = await getCloudLinkStatus();
    expect(s).toEqual({ state: 'unlinked', cloudUrl: null, instanceName: null, connected: false, lastError: null });
  });

  it('reports the live socket flag from the tunnel client', async () => {
    db.push({
      id: 'l1', cloudUrl: 'https://digby.ai', tokenEnc: 'CIPHERTEXT',
      instanceName: 'home-lab', pairedByUserId: 'u1', state: 'linked',
      lastError: null, createdAt: new Date(), updatedAt: new Date(),
    });
    mockTunnel.isConnected.mockReturnValue(true);
    const s = await getCloudLinkStatus();
    expect(s).toMatchObject({ state: 'linked', cloudUrl: 'https://digby.ai', instanceName: 'home-lab', connected: true });
    expect(JSON.stringify(s)).not.toContain('tokenEnc');
    expect(JSON.stringify(s)).not.toContain('CIPHERTEXT');
  });
});

describe('pairToCloud', () => {
  const okResponse = { data: { success: true, data: { instanceId: 'i1', token: `dgi_${'b'.repeat(48)}` } } };

  it('redeems the code server-side, stores the token encrypted, starts the tunnel', async () => {
    mockedAxios.post.mockResolvedValueOnce(okResponse as any);
    const status = await pairToCloud('u1', 'https://digby.ai/', 'ABCD-2345', 'home-lab');

    const [url, body] = mockedAxios.post.mock.calls[0];
    expect(url).toBe('https://digby.ai/api/crossmodel/instances/pair/complete');
    expect(body).toMatchObject({ code: 'ABCD-2345', instanceName: 'home-lab', protocolVersion: 1 });

    expect(db).toHaveLength(1);
    expect(db[0].cloudUrl).toBe('https://digby.ai'); // trailing slash stripped
    expect(db[0].pairedByUserId).toBe('u1');
    expect(db[0].state).toBe('linked');
    expect(db[0].tokenEnc).toBeTruthy();
    expect(db[0].tokenEnc).not.toContain('dgi_'); // AES-256-GCM, not plaintext
    expect(mockTunnel.restart).toHaveBeenCalledTimes(1);
    expect(status.state).toBe('linked');
    expect(JSON.stringify(status)).not.toContain('dgi_');
  });

  it('singleton: re-pairing replaces any existing row', async () => {
    mockedAxios.post.mockResolvedValue(okResponse as any);
    await pairToCloud('u1', 'https://digby.ai', 'AAAA-1111');
    await pairToCloud('u1', 'https://cloud.example.com', 'BBBB-2222');
    expect(db).toHaveLength(1);
    expect(db[0].cloudUrl).toBe('https://cloud.example.com');
  });

  it('surfaces the cloud 401 verbatim-ish and stores nothing', async () => {
    mockedAxios.post.mockRejectedValueOnce({
      response: { status: 401, data: { success: false, error: 'Invalid or expired pairing code' } },
    });
    await expect(pairToCloud('u1', 'https://digby.ai', 'BAD-CODE'))
      .rejects.toMatchObject({ statusCode: 401, message: 'Invalid or expired pairing code' });
    expect(db).toHaveLength(0);
    expect(mockTunnel.restart).not.toHaveBeenCalled();
  });

  it('maps an unreachable cloud to 502', async () => {
    mockedAxios.post.mockRejectedValueOnce({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' });
    await expect(pairToCloud('u1', 'https://digby.ai', 'ABCD-2345'))
      .rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining('unreachable') });
  });

  it('rejects a malformed success payload (no dgi_ token) with 502', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { success: true, data: { instanceId: 'i1' } } } as any);
    await expect(pairToCloud('u1', 'https://digby.ai', 'ABCD-2345'))
      .rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining('malformed') });
    expect(db).toHaveLength(0);
  });

  it('400s on a missing code before ever calling the cloud', async () => {
    await expect(pairToCloud('u1', 'https://digby.ai', '  '))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });
});

describe('unlinkFromCloud', () => {
  it('stops the client, tells the cloud to self-revoke with the dgi_ token, deletes the row', async () => {
    // Seed a real pair so the stored ciphertext decrypts to a real dgi_ token.
    const token = `dgi_${'c'.repeat(48)}`;
    mockedAxios.post.mockResolvedValueOnce({ data: { success: true, data: { instanceId: 'i1', token } } } as any);
    await pairToCloud('u1', 'https://digby.ai', 'ABCD-2345');

    mockedAxios.delete.mockResolvedValueOnce({ data: { success: true } } as any);
    const status = await unlinkFromCloud();

    expect(mockTunnel.stop).toHaveBeenCalled();
    const [url, opts] = mockedAxios.delete.mock.calls[0];
    expect(url).toBe('https://digby.ai/api/crossmodel/instances/self');
    expect((opts as any).headers.Authorization).toBe(`Bearer ${token}`);
    expect(db).toHaveLength(0);
    expect(status.state).toBe('unlinked');
  });

  it('proceeds locally even when the cloud is unreachable', async () => {
    db.push({
      id: 'l1', cloudUrl: 'https://digby.ai', tokenEnc: 'not-decryptable',
      instanceName: 'x', pairedByUserId: 'u1', state: 'error',
      lastError: 'token rejected — re-pair', createdAt: new Date(), updatedAt: new Date(),
    });
    mockedAxios.delete.mockRejectedValueOnce(new Error('network down'));
    const status = await unlinkFromCloud();
    expect(mockTunnel.stop).toHaveBeenCalled();
    expect(db).toHaveLength(0);
    expect(status.state).toBe('unlinked');
  });

  it('is a no-op (besides stopping the client) when nothing is linked', async () => {
    const status = await unlinkFromCloud();
    expect(mockTunnel.stop).toHaveBeenCalled();
    expect(mockedAxios.delete).not.toHaveBeenCalled();
    expect(status.state).toBe('unlinked');
  });
});

describe('startEdgePairingCode (device activation — the edge mints the code)', () => {
  it('mints an XXXX-XXXX code, records sha256+metadata in Redis (10-min TTL), creates a pending row, starts the pending dial', async () => {
    const { code, expiresAt } = await startEdgePairingCode('u1', 'digby.ai', 'home-lab');
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 9 * 60 * 1000);

    // Local record: sha256 of the canonical dgp_ token, never the code itself.
    const keys = [...redisStore.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^edge:paircode:[0-9a-f]{64}$/);
    expect(JSON.stringify(redisStore.get(keys[0]))).not.toContain(code);
    expect(JSON.parse(redisStore.get(keys[0])!)).toMatchObject({
      cloudUrl: 'https://digby.ai', instanceName: 'home-lab', userId: 'u1',
    });

    expect(db).toHaveLength(1);
    expect(db[0]).toMatchObject({
      cloudUrl: 'https://digby.ai', // normalized: scheme prepended
      instanceName: 'home-lab',
      pairedByUserId: 'u1',
      state: 'pending',
      tokenEnc: '', // no token until the relay answers with a paired frame
    });

    // Pending-pair mode gets the RAW key (dashes stripped) + the TTL deadline.
    expect(mockTunnel.startPendingPairing).toHaveBeenCalledWith(code.replace('-', ''), expiresAt.getTime());
  });

  it('409s when already linked — unlink first', async () => {
    db.push({
      id: 'l1', cloudUrl: 'https://digby.ai', tokenEnc: 'CIPHERTEXT',
      instanceName: 'x', pairedByUserId: 'u1', state: 'linked',
      lastError: null, createdAt: new Date(), updatedAt: new Date(),
    });
    await expect(startEdgePairingCode('u1', 'https://digby.ai'))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(mockTunnel.startPendingPairing).not.toHaveBeenCalled();
    expect(db).toHaveLength(1);
    expect(db[0].state).toBe('linked');
  });

  it('replaces a stale pending/error row with a fresh code', async () => {
    db.push({
      id: 'l1', cloudUrl: 'https://old.example.com', tokenEnc: '',
      instanceName: 'x', pairedByUserId: 'u1', state: 'error',
      lastError: 'pairing code expired — generate a new one', createdAt: new Date(), updatedAt: new Date(),
    });
    await startEdgePairingCode('u1', 'https://digby.ai');
    expect(db).toHaveLength(1);
    expect(db[0].state).toBe('pending');
    expect(db[0].cloudUrl).toBe('https://digby.ai');
    expect(db[0].lastError).toBeNull();
  });

  it('400s on an invalid cloudUrl before minting anything', async () => {
    await expect(startEdgePairingCode('u1', 'ftp://nope'))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(db).toHaveLength(0);
    expect(redisStore.size).toBe(0);
    expect(mockTunnel.startPendingPairing).not.toHaveBeenCalled();
  });

  it('getCloudLinkStatus surfaces the pending state (UI polls it while waiting)', async () => {
    await startEdgePairingCode('u1', 'https://digby.ai', 'home-lab');
    const s = await getCloudLinkStatus();
    expect(s).toMatchObject({ state: 'pending', cloudUrl: 'https://digby.ai', instanceName: 'home-lab', connected: false });
  });
});
