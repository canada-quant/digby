/**
 * instances.service — Digby Edge (Phase 3) cloud-side pairing.
 * Pins: code issue (10-min TTL, shown once), single-use ATOMIC consume
 * (getDel — a second complete with the same code fails), expiry/unknown-code
 * uniform null (controller → uniform 401), `dgi_` token shape with ONLY the
 * sha256 hash stored, owner-scoped list (never tokenHash, Redis presence
 * online flag), owner-scoped revoke, and token self-revoke.
 * Prisma + Redis mocked in the established in-memory style.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// error-handler.ts (AppError) pulls config/env, which exits the jest worker at
// import — stand it in (same boundary the other crossmodel tests use).
jest.mock('../../../config/env', () => ({ env: { NODE_ENV: 'test' } }));

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
let nextId = 1;
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    connectedInstance: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `i${nextId++}`, createdAt: new Date(), lastSeenAt: null, revokedAt: null, ...data };
        db.push(row); return row;
      }),
      findUnique: jest.fn(async ({ where }: any) =>
        db.find(r => (where.id && r.id === where.id) || (where.tokenHash && r.tokenHash === where.tokenHash)) || null),
      findFirst: jest.fn(async ({ where }: any) =>
        db.find(r => (!where.id || r.id === where.id) && (!where.ownerUserId || r.ownerUserId === where.ownerUserId)) || null),
      findMany: jest.fn(async ({ where }: any) =>
        db.filter(r => r.ownerUserId === where.ownerUserId
            && (where.status?.not === undefined || r.status !== where.status.not))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())),
      update: jest.fn(async ({ where, data }: any) => {
        const i = db.findIndex(r => r.id === where.id);
        if (i < 0) throw new Error('not found');
        db[i] = { ...db[i], ...data };
        return db[i];
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const r of db) {
          if (r.id === where.id && r.ownerUserId === where.ownerUserId && r.status !== where.status?.not) {
            Object.assign(r, data); count++;
          }
        }
        return { count };
      }),
    },
  },
}));

import {
  startPairing, completePairing, resolveInstanceByToken, listInstances,
  revokeInstance, revokeByToken, hashInstanceToken, redeemPairingCode,
  mintInstanceFromPairClaim, canonicalPairToken, generatePairingCode,
  INSTANCE_PAIR_PATH_RE, PAIR_CLAIM_KEY_PREFIX,
} from './instances.service';
import redisClient from '../../../config/redis';

beforeEach(() => {
  db.length = 0;
  redisStore.clear();
  nextId = 1;
  jest.clearAllMocks();
});

describe('startPairing', () => {
  it('issues an XXXX-XXXX code stored in Redis with a 10-min TTL', async () => {
    const { code, expiresAt } = await startPairing('admin-1');
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(redisClient.setEx).toHaveBeenCalledWith(
      expect.stringMatching(/^inst_pair:/), 600, 'admin-1');
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 9 * 60 * 1000);
  });
});

describe('completePairing', () => {
  it('redeems a code ONCE: dgi_ token returned, only the sha256 hash stored', async () => {
    const { code } = await startPairing('admin-1');
    const result = await completePairing(code, 'home-lab', 1);
    expect(result).not.toBeNull();
    expect(result!.token).toMatch(/^dgi_[0-9a-f]{48}$/);
    expect(db).toHaveLength(1);
    expect(db[0].ownerUserId).toBe('admin-1');
    expect(db[0].name).toBe('home-lab');
    expect(db[0].status).toBe('pending');
    expect(db[0].tokenHash).toBe(hashInstanceToken(result!.token));
    expect(JSON.stringify(db[0])).not.toContain(result!.token);

    // Single-use: the same code fails the second time (uniform null → 401).
    expect(await completePairing(code, 'home-lab', 1)).toBeNull();
    expect(db).toHaveLength(1);
  });

  it('tolerates dashes/case in the entered code', async () => {
    const { code } = await startPairing('admin-1');
    const mangled = code.toLowerCase().replace('-', ' - ');
    expect(await completePairing(mangled, 'edge', 1)).not.toBeNull();
  });

  it('returns null for unknown/expired codes (uniform 401 at the controller)', async () => {
    expect(await completePairing('NOPE-1234', 'edge', 1)).toBeNull();
    expect(db).toHaveLength(0);
  });

  it('clamps an unsupported protocolVersion and defaults the name', async () => {
    const { code } = await startPairing('admin-1');
    const result = await completePairing(code, '  ', 99);
    expect(result).not.toBeNull();
    expect(db[0].protocolVersion).toBe(1);
    expect(db[0].name).toBe('unnamed edge');
  });
});

describe('resolveInstanceByToken', () => {
  it('resolves a paired token by hash and rejects anything else', async () => {
    const { code } = await startPairing('admin-1');
    const { token, instanceId } = (await completePairing(code, 'edge', 1))!;
    const row = await resolveInstanceByToken(token);
    expect(row?.id).toBe(instanceId);
    expect(await resolveInstanceByToken('dgi_wrong')).toBeNull();
    expect(await resolveInstanceByToken('')).toBeNull();
  });
});

describe('listInstances', () => {
  it('is owner-scoped, never carries tokenHash, and flags online from Redis presence', async () => {
    const a = await startPairing('admin-1');
    const mine = (await completePairing(a.code, 'mine', 1))!;
    const b = await startPairing('admin-2');
    await completePairing(b.code, 'someone-elses', 1);
    redisStore.set(`inst:presence:${mine.instanceId}`, String(Date.now()));

    const rows = await listInstances('admin-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('mine');
    expect(rows[0].online).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('tokenHash');
    expect(JSON.stringify(rows)).not.toContain(mine.token);

    expect(await listInstances('admin-2')).toHaveLength(1);
    expect((await listInstances('admin-2'))[0].online).toBe(false);
  });

  it('excludes revoked rows by default; includeRevoked opts back in', async () => {
    const a = await startPairing('admin-1');
    const keep = (await completePairing(a.code, 'keep', 1))!;
    const b = await startPairing('admin-1');
    const gone = (await completePairing(b.code, 'gone', 1))!;
    await revokeInstance(gone.instanceId, 'admin-1');

    const def = await listInstances('admin-1');
    expect(def.map(r => r.id)).toEqual([keep.instanceId]);

    const all = await listInstances('admin-1', { includeRevoked: true });
    expect(all.map(r => r.id).sort()).toEqual([keep.instanceId, gone.instanceId].sort());
    expect(all.find(r => r.id === gone.instanceId)?.status).toBe('revoked');
  });
});

describe('revokeInstance', () => {
  it('revokes owner-scoped (sets status + revokedAt, drops presence)', async () => {
    const { code } = await startPairing('admin-1');
    const { instanceId } = (await completePairing(code, 'mine', 1))!;
    redisStore.set(`inst:presence:${instanceId}`, '1');

    expect(await revokeInstance(instanceId, 'admin-1')).toBe(true);
    expect(db[0].status).toBe('revoked');
    expect(db[0].revokedAt).toBeInstanceOf(Date);
    expect(redisStore.has(`inst:presence:${instanceId}`)).toBe(false);

    // Idempotent for the owner; 404-worthy (false) for anyone else.
    expect(await revokeInstance(instanceId, 'admin-1')).toBe(true);
    expect(await revokeInstance(instanceId, 'admin-2')).toBe(false);
    expect(await revokeInstance('nope', 'admin-1')).toBe(false);
  });
});

describe('revokeByToken', () => {
  it('revokes the row behind a valid dgi_ token and rejects bad tokens', async () => {
    const { code } = await startPairing('admin-1');
    const { token } = (await completePairing(code, 'mine', 1))!;
    expect(await revokeByToken(token)).toBe(true);
    expect(db[0].status).toBe('revoked');
    expect(await revokeByToken('dgi_garbage')).toBe(false);
  });
});

// ── Device-activation pairing (edge mints the code, cloud redeems) ──────────

describe('redeemPairingCode (cloud side)', () => {
  it('parks a Redis claim under inst:pairclaim:<sha256(dgp_<KEY>)> with a 10-min TTL', async () => {
    const result = await redeemPairingCode('ABCD-2345', 'admin-1');
    expect(result?.pending).toBe(true);
    expect(result!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 9 * 60 * 1000);

    const key = `${PAIR_CLAIM_KEY_PREFIX}${hashInstanceToken('dgp_ABCD2345')}`;
    expect(redisClient.setEx).toHaveBeenCalledWith(key, 600, JSON.stringify({ cloudUserId: 'admin-1' }));
    expect(redisStore.get(key)).toBe(JSON.stringify({ cloudUserId: 'admin-1' }));
  });

  it('tolerates dashes/case/whitespace like the complete flow does', async () => {
    await redeemPairingCode(' abcd - 2345 ', 'admin-1');
    expect(redisStore.get(`${PAIR_CLAIM_KEY_PREFIX}${hashInstanceToken('dgp_ABCD2345')}`)).toBeTruthy();
  });

  it('returns null for malformed codes (controller → 400)', async () => {
    expect(await redeemPairingCode('SHORT', 'admin-1')).toBeNull();
    expect(await redeemPairingCode('WAYTOOLONGCODE123', 'admin-1')).toBeNull();
    expect(await redeemPairingCode('', 'admin-1')).toBeNull();
    expect(redisClient.setEx).not.toHaveBeenCalled();
  });
});

describe('mintInstanceFromPairClaim (relay side)', () => {
  it('consumes the claim ONCE and mints the row for the redeeming admin', async () => {
    await redeemPairingCode('WXYZ-6789', 'admin-1');
    const minted = await mintInstanceFromPairClaim('dgp_WXYZ6789', 'kitchen edge');
    expect(minted).not.toBeNull();
    expect(minted!.token).toMatch(/^dgi_[0-9a-f]{48}$/);
    expect(db).toHaveLength(1);
    expect(db[0].ownerUserId).toBe('admin-1');
    expect(db[0].name).toBe('kitchen edge');
    expect(db[0].status).toBe('pending');
    expect(db[0].tokenHash).toBe(hashInstanceToken(minted!.token));

    // One-time consumption: the second dial with the same code gets null
    // (the relay's uniform 401), exactly like a revoked dgi_ token.
    expect(await mintInstanceFromPairClaim('dgp_WXYZ6789', 'kitchen edge')).toBeNull();
    expect(db).toHaveLength(1);
  });

  it('accepts the token in any dash/case form the edge might send', async () => {
    await redeemPairingCode('WXYZ-6789', 'admin-1');
    expect(await mintInstanceFromPairClaim('dgp_wxyz-6789', 'edge')).not.toBeNull();
  });

  it('returns null for unknown/expired claims and never mints a row', async () => {
    expect(await mintInstanceFromPairClaim('dgp_GONE1234')).toBeNull();
    expect(await mintInstanceFromPairClaim('dgi_not-a-code')).toBeNull();
    expect(db).toHaveLength(0);
  });

  it('sanitizes the edge-supplied name (control chars stripped, ≤60 chars, default)', async () => {
    await redeemPairingCode('AAAA-2222', 'admin-1');
    const long = `${'x'.repeat(80)}\n\u0007`;
    const minted = await mintInstanceFromPairClaim('dgp_AAAA2222', long);
    expect(minted!.instance.name).toBe('x'.repeat(60));

    await redeemPairingCode('BBBB-3333', 'admin-1');
    const unnamed = await mintInstanceFromPairClaim('dgp_BBBB3333', '   ');
    expect(unnamed!.instance.name).toBe('unnamed edge');
  });
});

describe('canonicalPairToken + generatePairingCode', () => {
  it('canonicalizes to dgp_<KEY> regardless of prefix/dashes/case', async () => {
    expect(canonicalPairToken('dgp_abcd-2345')).toBe('dgp_ABCD2345');
    expect(canonicalPairToken('ABCD-2345')).toBe('dgp_ABCD2345');
    expect(canonicalPairToken('dgp_ABCD2345')).toBe('dgp_ABCD2345');
  });

  it('the generated key matches the XXXX-XXXX display form', async () => {
    const { display, key } = generatePairingCode();
    expect(display).toBe(`${key.slice(0, 4)}-${key.slice(4)}`);
    expect(display).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });
});

describe('INSTANCE_PAIR_PATH_RE (app.ts rate-limiter coverage)', () => {
  it('matches BOTH pairing endpoints (complete + redeem), not other paths', async () => {
    expect(INSTANCE_PAIR_PATH_RE.test('/instances/pair/complete')).toBe(true);
    expect(INSTANCE_PAIR_PATH_RE.test('/instances/pair/redeem')).toBe(true);
    expect(INSTANCE_PAIR_PATH_RE.test('/instances/pair/complete/')).toBe(true);
    expect(INSTANCE_PAIR_PATH_RE.test('/instances/pair/start')).toBe(false);
    expect(INSTANCE_PAIR_PATH_RE.test('/instances')).toBe(false);
    expect(INSTANCE_PAIR_PATH_RE.test('/instances/abc')).toBe(false);
  });
});
