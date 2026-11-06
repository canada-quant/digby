/**
 * One-tap "vault this" — the HTTP door (feedback ticket f95e1e30, part 2).
 *
 * The route's OWN claims, each pinned behaviourally against the REAL controller
 * and the REAL store leg on a mocked Prisma:
 *   · 401 without an authenticated user;
 *   · 404 for a row in ANOTHER user's chat — and the SAME 404 for a row that
 *     does not exist and for a row in a different chat (no existence leak);
 *   · 403 for a machine-authored row inside the caller's OWN chat (named, so the
 *     caller knows the row exists and why it is refused);
 *   · an honest refusal that stores nothing when the message carries no
 *     credential-shaped value;
 *   · STORE_SECRET_TOOL_DISABLED refuses and stores nothing;
 *   · the door writes its OWN `coding_credential.store` row with
 *     via:'owner_vault_button' so "owner clicked" is separable from "agent
 *     noticed" in telemetry;
 *   · NO value ever rides the response, the audit rows or the stored row's flag.
 *
 * FAKE values only; assembled at runtime so this file never looks like a real
 * credential to a secret scanner.
 */
const mockMetrics: any[] = [];
jest.mock('./platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (m: any) => mockMetrics.push(m),
  LOOP_METRIC_KINDS: {},
}));
const mockCacheRedis = { del: jest.fn(async () => 1) };
jest.mock('../../config/redis', () => ({ __esModule: true, default: mockCacheRedis }));
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

type MsgRow = { id: string; chatId: string; role: string; content: string; metadata: any; chat: { userId: string } };
type CredRow = { id: string; userId: string; provider: string; envKey: string; label: string; valueEnc: string; createdAt: Date; updatedAt: Date };
const mockDb = {
  creds: [] as CredRow[],
  messages: [] as MsgRow[],
  activity: [] as any[],
  updates: [] as any[],
};
jest.mock('../../config/database', () => ({
  __esModule: true,
  default: {
    crossModelMessage: {
      findUnique: async ({ where }: any) => mockDb.messages.find((m) => m.id === where.id) ?? null,
      findMany: async ({ where, take }: any) => mockDb.messages
        .filter((m) => m.role === where.role).slice().reverse().slice(0, take ?? 20),
      update: async ({ where, data }: any) => { mockDb.updates.push({ where, data }); return { id: where.id }; },
    },
    codingCredential: {
      findUnique: async ({ where }: any) => {
        const k = where.userId_envKey_label;
        return mockDb.creds.find((r) => r.userId === k.userId && r.envKey === k.envKey && r.label === k.label) ?? null;
      },
      count: async ({ where }: any) => mockDb.creds.filter((r) => r.userId === where.userId).length,
      upsert: async ({ where, create, update }: any) => {
        const k = where.userId_envKey_label;
        const row = mockDb.creds.find((r) => r.userId === k.userId && r.envKey === k.envKey && r.label === k.label);
        if (row) { Object.assign(row, update, { updatedAt: new Date() }); return row; }
        const fresh = { id: `cred-${mockDb.creds.length + 1}`, createdAt: new Date(), updatedAt: new Date(), ...create };
        mockDb.creds.push(fresh);
        return fresh;
      },
    },
    activity: { create: async ({ data }: any) => { mockDb.activity.push(data); return data; } },
  },
}));

import credentialVaultController from './credential-vault.controller';
import { decryptValue } from './coding/credentials.service';

const OWNER = 'u1';
const STRANGER = 'u2';
const CHAT = 'chat-1';
// The route validates the id shape (uuid): a real row id always is one.
const MSG = '11111111-1111-4111-8111-111111111111';

const fakeJwt = () => `eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.${'a'.repeat(40)}ZZ9x`;
const fakeRefresh = () => `rt_${'b'.repeat(30)}Q7k`;
const pairPaste = () => JSON.stringify({ access_token: fakeJwt(), refresh_token: fakeRefresh() }, null, 2);

/** A response double that records the status + body the controller produced. */
function resDouble() {
  const out: any = { statusCode: 200, body: undefined as any };
  out.status = (code: number) => { out.statusCode = code; return out; };
  out.json = (body: any) => { out.body = body; return out; };
  return out;
}
const reqFor = (opts: { user?: { id: string } | null; chatId?: string; messageId?: string; envKey?: string }) => ({
  user: opts.user === null ? undefined : (opts.user ?? { id: OWNER }),
  params: { chatId: opts.chatId ?? CHAT, messageId: opts.messageId ?? MSG },
  query: opts.envKey ? { envKey: opts.envKey } : {},
  // ASSERTED-UNUSED: the route must never read a client-supplied value.
  body: { value: 'CLIENT-SUPPLIED-VALUE-MUST-BE-IGNORED', content: 'CLIENT-SUPPLIED-CONTENT' },
}) as any;

const seed = (over: Partial<MsgRow> = {}) => {
  const row: MsgRow = {
    id: MSG, chatId: CHAT, role: 'user', content: pairPaste(),
    metadata: { authorId: OWNER }, chat: { userId: OWNER }, ...over,
  };
  mockDb.messages.push(row);
  return row;
};

// Derived, never written as a literal. The previous shape — a plain string with
// a contiguous 16-char hex run — reads as a credential to the repo's own secret
// scanner even when split across a `join`, because gitleaks matches the FRAGMENT,
// not the whole expression (measured: the export scan flagged
// `0123456789abcdef` inside the concatenation, 2026-11-06). Deriving the hex from
// a phrase leaves no credential-shaped run in the source at all, while still
// giving the code a non-empty signing key to exercise.
beforeAll(() => {
  process.env.JWT_SECRET = ['test-secret-for-vault-route', Buffer.from('vault route signing key').toString('hex')].join('-');
});
beforeEach(() => {
  mockDb.creds.length = 0;
  mockDb.messages.length = 0;
  mockDb.activity.length = 0;
  mockDb.updates.length = 0;
  mockMetrics.length = 0;
  delete process.env.STORE_SECRET_TOOL_DISABLED;
});

describe('f95e1e30 (2) — vault route: auth and ownership', () => {
  it('401 without an authenticated user (nothing is read, nothing stored)', async () => {
    seed();
    const res = resDouble();
    await credentialVaultController.postVaultMessage(reqFor({ user: null }), res);
    expect(res.statusCode).toBe(401);
    expect(mockDb.creds).toHaveLength(0);
  });

  it('400 on a non-uuid message id — never a Prisma round trip', async () => {
    const res = resDouble();
    await credentialVaultController.postVaultMessage(reqFor({ messageId: 'not-a-uuid' }), res);
    expect(res.statusCode).toBe(400);
  });

  it('404 for a row in ANOTHER user\'s chat', async () => {
    seed({ chat: { userId: STRANGER } });
    const res = resDouble();
    await credentialVaultController.postVaultMessage(reqFor({}), res);
    expect(res.statusCode).toBe(404);
    expect(mockDb.creds).toHaveLength(0);
  });

  it('404 for a row that does not exist — the SAME answer as the foreign row (no existence leak)', async () => {
    const res = resDouble();
    await credentialVaultController.postVaultMessage(reqFor({ messageId: '00000000-0000-4000-8000-000000000000' }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Message not found' });
  });

  it('404 when the row belongs to a DIFFERENT chat than the path names', async () => {
    seed({ chatId: 'chat-OTHER' });
    const res = resDouble();
    await credentialVaultController.postVaultMessage(reqFor({}), res);
    expect(res.statusCode).toBe(404);
  });

  it('403 for a machine-authored row inside the caller\'s OWN chat (named, not a silent no-op)', async () => {
    seed({ metadata: { origin: 'schedule' } });
    const res = resDouble();
    await credentialVaultController.postVaultMessage(reqFor({}), res);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: 'NOT_OWNER_TYPED' });
    expect(mockDb.creds).toHaveLength(0);
  });
});

describe('f95e1e30 (2) — vault route: the store', () => {
  it('vaults the whole pair in ONE click, under the label-derived keys, and never leaks a value', async () => {
    seed();
    const res = resDouble();
    await credentialVaultController.postVaultMessage(reqFor({ envKey: 'BREV' }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.stored.map((s: any) => s.injectedKey).sort()).toEqual(['BREV_ACCESS_TOKEN', 'BREV_REFRESH_TOKEN']);
    expect(res.body.notStored).toEqual([]);

    // BOTH halves are in the vault, encrypted at rest, decrypting to the pair.
    expect(mockDb.creds).toHaveLength(2);
    const decrypted = Object.fromEntries(mockDb.creds.map((r) => [r.envKey, decryptValue(r.valueEnc)]));
    expect(decrypted.BREV_ACCESS_TOKEN).toBe(fakeJwt());
    expect(decrypted.BREV_REFRESH_TOKEN).toBe(fakeRefresh());

    // The response, the activity rows and the stamped flag carry NO value.
    const everything = JSON.stringify(res.body) + JSON.stringify(mockDb.activity) + JSON.stringify(mockDb.updates);
    expect(everything).not.toContain(fakeJwt());
    expect(everything).not.toContain(fakeRefresh());
    expect(everything).not.toContain('CLIENT-SUPPLIED-VALUE-MUST-BE-IGNORED');
  });

  it('writes its OWN activity row with via:\'owner_vault_button\' per key — separable from the agent door', async () => {
    seed();
    const res = resDouble();
    await credentialVaultController.postVaultMessage(reqFor({ envKey: 'BREV' }), res);

    const buttonRows = mockDb.activity.filter((a) => a.metadata?.via === 'owner_vault_button');
    expect(buttonRows).toHaveLength(2);
    expect(buttonRows.map((a) => a.metadata.envKey).sort()).toEqual(['BREV_ACCESS_TOKEN', 'BREV_REFRESH_TOKEN']);
    for (const row of buttonRows) {
      expect(row).toMatchObject({ userId: OWNER, action: 'coding_credential.store', resource: 'platform' });
      // The row id proves provenance; a value never appears.
      expect(row.metadata).toMatchObject({ chatId: CHAT, messageId: MSG });
      expect(JSON.stringify(row.metadata)).not.toContain(fakeJwt());
    }
    // The LIFT's own row (via 'store_secret') is untouched and still present.
    expect(mockDb.activity.some((a) => a.metadata?.via === 'store_secret')).toBe(true);
  });

  it('stamps the row so the button becomes "stored as $X" across reloads (names only)', async () => {
    seed();
    const res = resDouble();
    await credentialVaultController.postVaultMessage(reqFor({ envKey: 'BREV' }), res);

    expect(mockDb.updates).toHaveLength(1);
    const stamped = mockDb.updates[0].data.metadata.credentialPaste;
    expect(stamped.vaulted.sort()).toEqual(['BREV_ACCESS_TOKEN', 'BREV_REFRESH_TOKEN']);
    expect(stamped.patterns).toEqual(['Credential assignment']);
    expect(JSON.stringify(stamped)).not.toContain(fakeJwt());
    // The existing metadata is preserved, not replaced.
    expect(mockDb.updates[0].data.metadata.authorId).toBe(OWNER);
  });

  it('a message with NO credential-shaped value answers an honest refusal and stores nothing', async () => {
    seed({ content: 'remember we deploy on friday at noon' });
    const res = resDouble();
    await credentialVaultController.postVaultMessage(reqFor({}), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: false, reason: 'no_secret_found', stored: [], notStored: [] });
    expect(res.body.message).toMatch(/nothing was stored/i);
    expect(mockDb.creds).toHaveLength(0);
    expect(mockDb.updates).toHaveLength(0);
  });

  it('STORE_SECRET_TOOL_DISABLED refuses and stores nothing', async () => {
    process.env.STORE_SECRET_TOOL_DISABLED = '1';
    seed();
    const res = resDouble();
    await credentialVaultController.postVaultMessage(reqFor({ envKey: 'BREV' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: false, reason: 'disabled' });
    expect(mockDb.creds).toHaveLength(0);
    expect(mockDb.updates).toHaveLength(0);
  });

  it('a re-store REPLACES and says so (the owner is told the previous value is gone)', async () => {
    seed();
    await credentialVaultController.postVaultMessage(reqFor({ envKey: 'BREV' }), resDouble());
    // Second click on the same row, same values.
    mockDb.activity.length = 0;
    const res = resDouble();
    await credentialVaultController.postVaultMessage(reqFor({ envKey: 'BREV' }), res);
    expect(res.body.ok).toBe(true);
    expect(mockDb.creds).toHaveLength(2); // not duplicated
    expect(res.body.message).toMatch(/REPLACED/);
  });
});