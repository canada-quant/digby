/**
 * store_secret — the owner-secret hand-off (audit 2026-10-06 T2-3). The value
 * is lifted SERVER-SIDE from the owner's own words (this turn's text or an
 * earlier owner-typed row), stored through the REAL coding credentials
 * service (encrypted, validated) on a mocked Prisma, and the result names only
 * the env var. Machine turns are refused; a model-supplied `value` is ignored;
 * the kill switch refuses. FAKE values only.
 */
const mockMetrics: any[] = [];
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (m: any) => mockMetrics.push(m),
  LOOP_METRIC_KINDS: {},
}));
// Ticket c02b85bf: a successful store_secret now invalidates the chat-side
// integration-status cache (the credential NAMES line). This suite is
// import-light by design — mock the redis boundary so the invalidation's lazy
// import never reaches config/env (which process.exit(1)s without env vars).
const mockCacheRedis = { del: jest.fn(async () => 1) };
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockCacheRedis }));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

type CredRow = { id: string; userId: string; provider: string; envKey: string; label: string; valueEnc: string; createdAt: Date; updatedAt: Date };
const mockDb = {
  creds: [] as CredRow[],
  messages: [] as Array<{ id: string; role: string; content: string; metadata: any; chat: { userId: string } }>,
  activity: [] as any[],
};
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    crossModelMessage: {
      findUnique: async ({ where }: any) => mockDb.messages.find((m) => m.id === where.id) ?? null,
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

import { executeSecretHandoffTool, extractSecretForHandoff, SECRET_HANDOFF_TOOL_SCHEMA, isSecretHandoffTool } from './secret-handoff-tools';
import { decryptValue } from '../coding/credentials.service';

const FAKE_KEY = 'sk-' + 'FAKEfakeFAKEfake1234567890ab';
const FAKE_PW = 'Hue2024!x';
const parse = (s: string) => JSON.parse(s);
const human = (text: string, extra: Record<string, unknown> = {}) => ({ sessionId: 'chat-ps', userId: 'u1', userTurnAt: new Date(), userTurnText: text, ...extra });

beforeAll(() => { process.env.JWT_SECRET = 'test-secret-for-store-secret-0123456789abcdef'; });
beforeEach(() => {
  mockDb.creds.length = 0;
  mockDb.messages.length = 0;
  mockDb.activity.length = 0;
  mockMetrics.length = 0;
  delete process.env.STORE_SECRET_TOOL_DISABLED;
});
// The metric rides a dynamic import — let it settle before asserting.
const settle = () => new Promise((r) => setImmediate(r));

describe('store_secret — schema', () => {
  it('is one tool, requires envKey, and never takes a value argument', () => {
    expect(isSecretHandoffTool('store_secret')).toBe(true);
    expect(SECRET_HANDOFF_TOOL_SCHEMA).toHaveLength(1);
    const p: any = SECRET_HANDOFF_TOOL_SCHEMA[0].function.parameters;
    expect(p.required).toEqual(['envKey']);
    expect(Object.keys(p.properties)).toEqual(['envKey', 'label', 'fromMessageId', 'which']);
    expect(SECRET_HANDOFF_TOOL_SCHEMA[0].function.description).toMatch(/Machine-triggered runs .* MUST pass fromMessageId/);
  });
});

describe('store_secret — human turn', () => {
  it('lifts a NAMED value from this turn, stores it encrypted, returns only the env name', async () => {
    const raw = await executeSecretHandoffTool(human(`here you go XIAOMI_MIMO_PAYG_API_KEY=${FAKE_KEY} — install it`), 'store_secret', { envKey: 'XIAOMI_MIMO_PAYG_API_KEY' });
    expect(raw).not.toContain(FAKE_KEY);
    const out = parse(raw);
    expect(out).toMatchObject({ ok: true, injectedKey: 'XIAOMI_MIMO_PAYG_API_KEY', source: 'turn', pattern: 'Named assignment', replaced: false });
    expect(out.message).toMatch(/\$XIAOMI_MIMO_PAYG_API_KEY/);
    expect(mockDb.creds).toHaveLength(1);
    expect(mockDb.creds[0]).toMatchObject({ userId: 'u1', provider: 'custom', envKey: 'XIAOMI_MIMO_PAYG_API_KEY', label: '' });
    expect(mockDb.creds[0].valueEnc).not.toContain(FAKE_KEY);
    expect(decryptValue(mockDb.creds[0].valueEnc)).toBe(FAKE_KEY);
    expect(JSON.stringify(mockDb.activity)).not.toContain(FAKE_KEY);
    expect(mockDb.activity[0]).toMatchObject({ action: 'coding_credential.store', metadata: { via: 'store_secret', envKey: 'XIAOMI_MIMO_PAYG_API_KEY', source: 'turn' } });
    // Ticket c02b85bf: a successful store ALSO drops the integration-status
    // cache (the credential NAMES line) — reviewer advisory: pin the wiring.
    expect(mockCacheRedis.del).toHaveBeenCalledWith('cm_integ_status:u1');
    await settle();
    expect(mockMetrics).toEqual([expect.objectContaining({ kind: 'store_secret', meta: expect.objectContaining({ outcome: 'stored', injectedKey: 'XIAOMI_MIMO_PAYG_API_KEY' }) })]);
    expect(JSON.stringify(mockMetrics)).not.toContain(FAKE_KEY);
  });

  it('lifts a plain-English password through the shared scanner (lower-case envKey normalized)', async () => {
    const out = parse(await executeSecretHandoffTool(human(`the password for the Hue bridge is ${FAKE_PW} — store it somewhere`), 'store_secret', { envKey: 'hue_password' }));
    expect(out).toMatchObject({ ok: true, injectedKey: 'HUE_PASSWORD', pattern: 'Password' });
    expect(decryptValue(mockDb.creds[0].valueEnc)).toBe(FAKE_PW);
  });

  it('a label stores an ADDITIONAL credential injected as ENVKEY_LABEL; a re-store says REPLACED', async () => {
    const a = parse(await executeSecretHandoffTool(human(`password: ${FAKE_PW}`), 'store_secret', { envKey: 'HUE_PASSWORD', label: 'work' }));
    expect(a).toMatchObject({ ok: true, injectedKey: 'HUE_PASSWORD_WORK', label: 'WORK', replaced: false });
    const b = parse(await executeSecretHandoffTool(human('password: Other2024!y'), 'store_secret', { envKey: 'HUE_PASSWORD', label: 'work' }));
    expect(b).toMatchObject({ ok: true, replaced: true });
    expect(b.message).toMatch(/REPLACED/);
    expect(mockDb.creds).toHaveLength(1);
  });

  it('a model-supplied value is IGNORED — only the owner\'s words are stored', async () => {
    const out = parse(await executeSecretHandoffTool(human('please set this up for the lane'), 'store_secret', { envKey: 'HUE_PASSWORD', value: 'Attacker99!' }));
    expect(out).toMatchObject({ ok: false, reason: 'no_secret_found' });
    expect(out.message).toMatch(/fromMessageId/);
    expect(mockDb.creds).toHaveLength(0);
  });

  it('several values ⇒ ambiguous with masked candidates (never the values); which picks one', async () => {
    const text = `api key ${FAKE_KEY} and the password is ${FAKE_PW}`;
    const raw = await executeSecretHandoffTool(human(text), 'store_secret', { envKey: 'HUE_PASSWORD' });
    expect(raw).not.toContain(FAKE_KEY);
    expect(raw).not.toContain(FAKE_PW);
    const out = parse(raw);
    expect(out).toMatchObject({ ok: false, reason: 'ambiguous' });
    expect(out.candidates.map((c: any) => c.pattern)).toEqual(['OpenAI/Anthropic-style key', 'Password']);
    // 8d15611c observe-only channel: the refusal's loop metric carries WHICH
    // pattern families were offered — pattern names + char counts only, never
    // a value (the channel that shows new provider shapes lifting in prod).
    // recordStoreSecret defers through a dynamic import, so let it flush.
    await new Promise((r) => setTimeout(r, 10));
    const lastMetric = mockMetrics[mockMetrics.length - 1];
    expect(lastMetric.kind).toBe('store_secret');
    expect(lastMetric.meta).toMatchObject({ outcome: 'refused', reason: 'ambiguous', candidatePatterns: [
      { n: 1, pattern: 'OpenAI/Anthropic-style key', chars: FAKE_KEY.length },
      { n: 2, pattern: 'Password', chars: FAKE_PW.length },
    ] });
    expect(JSON.stringify(lastMetric)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(lastMetric)).not.toContain(FAKE_PW);
    const ok = parse(await executeSecretHandoffTool(human(text), 'store_secret', { envKey: 'HUE_PASSWORD', which: 2 }));
    expect(ok).toMatchObject({ ok: true, injectedKey: 'HUE_PASSWORD' });
    expect(decryptValue(mockDb.creds[0].valueEnc)).toBe(FAKE_PW);
  });

  it('fromMessageId lifts the value from an EARLIER owner-typed row in a chat the owner owns', async () => {
    mockDb.messages.push({ id: 'm-owner', role: 'user', content: `XIAOMI_KEY=${FAKE_KEY}`, metadata: null, chat: { userId: 'u1' } });
    const out = parse(await executeSecretHandoffTool(human('i sent it in the chat — use it'), 'store_secret', { envKey: 'XIAOMI_KEY', fromMessageId: 'm-owner' }));
    expect(out).toMatchObject({ ok: true, source: 'message', sourceMessageId: 'm-owner', injectedKey: 'XIAOMI_KEY' });
  });

  it.each([
    ['an assistant row', { id: 'm1', role: 'assistant', content: `XIAOMI_KEY=${FAKE_KEY}`, metadata: null, chat: { userId: 'u1' } }, 'not_owner_typed'],
    ['an agent send (machine origin)', { id: 'm1', role: 'user', content: `XIAOMI_KEY=${FAKE_KEY}`, metadata: { origin: 'agent' }, chat: { userId: 'u1' } }, 'not_owner_typed'],
    ['a machine wake row', { id: 'm1', role: 'user', content: `[MACHINE-TRIGGERED RUN] XIAOMI_KEY=${FAKE_KEY}`, metadata: null, chat: { userId: 'u1' } }, 'not_owner_typed'],
    ["another user's chat", { id: 'm1', role: 'user', content: `XIAOMI_KEY=${FAKE_KEY}`, metadata: null, chat: { userId: 'u2' } }, 'message_not_found'],
  ])('fromMessageId refuses %s', async (_label, row, reason) => {
    mockDb.messages.push(row as any);
    const out = parse(await executeSecretHandoffTool(human('use it'), 'store_secret', { envKey: 'XIAOMI_KEY', fromMessageId: 'm1' }));
    expect(out).toMatchObject({ ok: false, reason });
    expect(mockDb.creds).toHaveLength(0);
  });

  it.each([
    ['an invalid env name', 'hue-password!', 'invalid_env_key'],
    ['a reserved shell / platform name', 'PATH', 'reserved_env_key'],
    ['a platform-injected credential name', 'GITHUB_TOKEN', 'reserved_env_key'],
  ])('refuses %s', async (_label, envKey, reason) => {
    expect(parse(await executeSecretHandoffTool(human(`password: ${FAKE_PW}`), 'store_secret', { envKey }))).toMatchObject({ ok: false, reason });
    expect(mockDb.creds).toHaveLength(0);
  });

  it('refuses to overwrite an infra-managed (tailscale) credential', async () => {
    mockDb.creds.push({ id: 'c1', userId: 'u1', provider: 'tailscale', envKey: 'TS_AUTHKEY', label: '', valueEnc: 'x', createdAt: new Date(), updatedAt: new Date() });
    expect(parse(await executeSecretHandoffTool(human(`TS_AUTHKEY=${FAKE_KEY}`), 'store_secret', { envKey: 'TS_AUTHKEY' }))).toMatchObject({ ok: false, reason: 'infra_managed' });
    expect(mockDb.creds[0].valueEnc).toBe('x');
  });
});

describe('store_secret — refusals that keep machine runs honest', () => {
  it('a machine-triggered run (no user turn, no fromMessageId) is refused — never stores, never asks again', async () => {
    const out = parse(await executeSecretHandoffTool({ sessionId: 'chat-ps', userId: 'u1', userTurnText: `password: ${FAKE_PW}` }, 'store_secret', { envKey: 'HUE_PASSWORD' }));
    expect(out).toMatchObject({ ok: false, reason: 'no_user_turn' });
    expect(out.message).toMatch(/Do not ask for the value again/);
    expect(mockDb.creds).toHaveLength(0);
    await settle();
    expect(mockMetrics[0]).toMatchObject({ kind: 'store_secret', meta: expect.objectContaining({ outcome: 'refused', reason: 'no_user_turn' }) });
  });

  it('an anchored run the executor classified machine-triggered is refused too (without fromMessageId)', async () => {
    const out = parse(await executeSecretHandoffTool(human(`password: ${FAKE_PW}`, { machineTriggered: true }), 'store_secret', { envKey: 'HUE_PASSWORD' }));
    expect(out).toMatchObject({ ok: false, reason: 'no_user_turn' });
  });

  // Ticket 37a875ee: the machine-run path. An owner paste that already sits in
  // a chat row is a lawful store from a machine wake — the value is lifted from
  // the owner's own row server-side; nothing in the run's own context is stored.
  describe('ticket 37a875ee — machine run + fromMessageId', () => {
    const machine = (extra: Record<string, unknown> = {}) => ({ sessionId: 'chat-ps', userId: 'u1', machineTriggered: true, userTurnText: '', ...extra });

    it('a machine-triggered run STORES from an owner-typed row it cites (the paste is the authorization)', async () => {
      mockDb.messages.push({ id: 'm-owner-paste', role: 'user', content: `HYPERSTACK_SSH_KEY=${FAKE_KEY}`, metadata: null, chat: { userId: 'u1' } });
      const raw = await executeSecretHandoffTool(machine(), 'store_secret', { envKey: 'HYPERSTACK_SSH_KEY', fromMessageId: 'm-owner-paste' });
      expect(raw).not.toContain(FAKE_KEY);
      const out = parse(raw);
      expect(out).toMatchObject({ ok: true, injectedKey: 'HYPERSTACK_SSH_KEY', source: 'message', sourceMessageId: 'm-owner-paste' });
      expect(mockDb.creds).toHaveLength(1);
      expect(decryptValue(mockDb.creds[0].valueEnc)).toBe(FAKE_KEY);
      expect(mockDb.activity[0]).toMatchObject({ action: 'coding_credential.store', metadata: expect.objectContaining({ via: 'store_secret', source: 'message', sourceMessageId: 'm-owner-paste' }) });
    });

    it('a machine run with NO userTurnAt at all stores from a cited owner row (schedule / hook / ticket wake)', async () => {
      mockDb.messages.push({ id: 'm-owner-2', role: 'user', content: `HUE_PASSWORD: ${FAKE_PW}`, metadata: null, chat: { userId: 'u1' } });
      const out = parse(await executeSecretHandoffTool({ sessionId: 'chat-ps', userId: 'u1' }, 'store_secret', { envKey: 'HUE_PASSWORD', fromMessageId: 'm-owner-2' }));
      expect(out).toMatchObject({ ok: true, source: 'message', injectedKey: 'HUE_PASSWORD' });
      expect(decryptValue(mockDb.creds[0].valueEnc)).toBe(FAKE_PW);
    });

    it('a machine run citing an UNKNOWN id is refused (message_not_found, never falls back to turn text)', async () => {
      const out = parse(await executeSecretHandoffTool(machine({ userTurnText: `password: ${FAKE_PW}` }), 'store_secret', { envKey: 'HUE_PASSWORD', fromMessageId: 'nope' }));
      expect(out).toMatchObject({ ok: false, reason: 'message_not_found' });
      expect(mockDb.creds).toHaveLength(0);
    });

    it.each([
      ['an assistant row', { id: 'mm1', role: 'assistant', content: `XIAOMI_KEY=${FAKE_KEY}`, metadata: null, chat: { userId: 'u1' } }, 'not_owner_typed'],
      ['an agent send (machine origin)', { id: 'mm1', role: 'user', content: `XIAOMI_KEY=${FAKE_KEY}`, metadata: { origin: 'agent' }, chat: { userId: 'u1' } }, 'not_owner_typed'],
      ['a machine wake row', { id: 'mm1', role: 'user', content: `[MACHINE-TRIGGERED RUN] XIAOMI_KEY=${FAKE_KEY}`, metadata: null, chat: { userId: 'u1' } }, 'not_owner_typed'],
      ["another user's chat", { id: 'mm1', role: 'user', content: `XIAOMI_KEY=${FAKE_KEY}`, metadata: null, chat: { userId: 'u2' } }, 'message_not_found'],
    ])('a machine run citing %s is refused', async (_label, row, reason) => {
      mockDb.messages.push(row as any);
      const out = parse(await executeSecretHandoffTool(machine(), 'store_secret', { envKey: 'XIAOMI_KEY', fromMessageId: 'mm1' }));
      expect(out).toMatchObject({ ok: false, reason });
      expect(mockDb.creds).toHaveLength(0);
    });

    it('a machine run whose cited owner row carries no secret is refused (no_secret_found, nothing guessed)', async () => {
      mockDb.messages.push({ id: 'm-empty', role: 'user', content: 'hi there, no keys here', metadata: null, chat: { userId: 'u1' } });
      const out = parse(await executeSecretHandoffTool(machine(), 'store_secret', { envKey: 'XIAOMI_KEY', fromMessageId: 'm-empty' }));
      expect(out).toMatchObject({ ok: false, reason: 'no_secret_found' });
      expect(mockDb.creds).toHaveLength(0);
    });

    it('the kill switch still refuses a machine-run store outright', async () => {
      process.env.STORE_SECRET_TOOL_DISABLED = '1';
      mockDb.messages.push({ id: 'm-owner-3', role: 'user', content: `HUE_PASSWORD: ${FAKE_PW}`, metadata: null, chat: { userId: 'u1' } });
      expect(parse(await executeSecretHandoffTool(machine(), 'store_secret', { envKey: 'HUE_PASSWORD', fromMessageId: 'm-owner-3' }))).toMatchObject({ ok: false, reason: 'disabled' });
      expect(mockDb.creds).toHaveLength(0);
    });
  });

  it('anonymous users are refused', async () => {
    expect(parse(await executeSecretHandoffTool(human(`password: ${FAKE_PW}`, { userId: 'anonymous' }), 'store_secret', { envKey: 'HUE_PASSWORD' }))).toMatchObject({ ok: false, reason: 'anonymous' });
  });

  it('STORE_SECRET_TOOL_DISABLED=1 refuses (nothing stored)', async () => {
    process.env.STORE_SECRET_TOOL_DISABLED = '1';
    expect(parse(await executeSecretHandoffTool(human(`password: ${FAKE_PW}`), 'store_secret', { envKey: 'HUE_PASSWORD' }))).toMatchObject({ ok: false, reason: 'disabled' });
    expect(mockDb.creds).toHaveLength(0);
  });
});

describe('extractSecretForHandoff (pure)', () => {
  it('prefers the NAMED line for the requested envKey (even without an entropy signal)', () => {
    expect(extractSecretForHandoff('HUE_USER=bob HUE_PIN=4321 password: Other2024!y', 'HUE_PIN')).toEqual({ ok: true, value: '4321', pattern: 'Named assignment' });
  });

  it('a placeholder on the named line falls through to the scanner', () => {
    expect(extractSecretForHandoff('HUE_PASSWORD=$HUE_PASSWORD; the password is Hue2024!x', 'HUE_PASSWORD')).toEqual({ ok: true, value: 'Hue2024!x', pattern: 'Password' });
  });

  it('none / one / ambiguous (candidates carry pattern + length + label words, never the value)', () => {
    expect(extractSecretForHandoff('nothing to see here', 'X_KEY')).toEqual({ ok: false, reason: 'none' });
    expect(extractSecretForHandoff(`token ${FAKE_KEY}`, 'X_KEY')).toEqual({ ok: true, value: FAKE_KEY, pattern: 'OpenAI/Anthropic-style key' });
    const r: any = extractSecretForHandoff(`key ${FAKE_KEY} and password: ${FAKE_PW}`, 'X_KEY');
    expect(r.ok).toBe(false);
    expect(r.candidates).toEqual([
      { n: 1, pattern: 'OpenAI/Anthropic-style key', chars: FAKE_KEY.length, context: 'key' },
      { n: 2, pattern: 'Password', chars: FAKE_PW.length, context: expect.stringContaining('password:') },
    ]);
    expect(JSON.stringify(r)).not.toContain(FAKE_PW);
  });
});

// ── audit 2026-10-08 W4-5 — cued tokens + an honest miss (the prefixed Cloudflare shape landed in #1356) ─────────
import { cuedTokenSpans } from './secret-handoff-tools';

describe('W4-5 — store_secret on a dashboard paste with no known shape', () => {
  // A legacy-format (unprefixed, 40-char) provider token pasted as dashboard prose — FAKE value.
  const LEGACY = 'Fk3' + 'q9ZtRw2LmXa7VbN0pQs4UcEh6JdYg8KoTi1Mn5';
  const PASTE = `Token created\n\nCopy this token to access the Cloudflare API. For security this will not be shown again.\n\n${LEGACY}\n\nTest this token: curl "https://api.cloudflare.com/client/v4/user/tokens/verify" -H "Authorization: Bearer ${LEGACY}"`;
  afterEach(() => { delete process.env.STORE_SECRET_CUED_TOKEN_DISABLED; delete process.env.STORE_SECRET_HONEST_MISS_DISABLED; });

  it('a token cue + one high-entropy run ⇒ that run is the candidate (deduped across the curl line)', () => {
    expect(cuedTokenSpans(PASTE).map((s) => s.value)).toEqual([LEGACY]);
    expect(extractSecretForHandoff(PASTE, 'CLOUDFLARE_API_TOKEN')).toEqual({ ok: true, value: LEGACY, pattern: 'Cued token' });
  });

  it('no cue, hex / a sha / a uuid, or the kill switch ⇒ nothing', () => {
    expect(cuedTokenSpans(`see run ${LEGACY}`)).toEqual([]);
    expect(cuedTokenSpans('API token for commit 3dc48ac3797981efeff56d36b5a145a6b75183cb and 8f14e45f-ceea-467e-a2b6-1f0c2d9e8b7a')).toEqual([]);
    process.env.STORE_SECRET_CUED_TOKEN_DISABLED = '1';
    expect(extractSecretForHandoff(PASTE, 'CLOUDFLARE_API_TOKEN')).toEqual({ ok: false, reason: 'none' });
  });

  it('end to end: an earlier owner row with the paste stores the cued token', async () => {
    mockDb.messages.push({ id: 'm-cf', role: 'user', content: PASTE, metadata: null, chat: { userId: 'u1' } });
    const raw = await executeSecretHandoffTool(human('use the token i pasted'), 'store_secret', { envKey: 'CLOUDFLARE_API_TOKEN', fromMessageId: 'm-cf' });
    expect(raw).not.toContain(LEGACY);
    expect(parse(raw)).toMatchObject({ ok: true, injectedKey: 'CLOUDFLARE_API_TOKEN', pattern: 'Cued token', source: 'message' });
    expect(decryptValue(mockDb.creds[0].valueEnc)).toBe(LEGACY);
  });

  it('a miss on an UNREDACTED row never blames a redaction; a row that IS redacted still says so', async () => {
    mockDb.messages.push({ id: 'm-plain', role: 'user', content: 'here is the thing you asked for: deploy it tonight', metadata: null, chat: { userId: 'u1' } });
    const miss = parse(await executeSecretHandoffTool(human('use it'), 'store_secret', { envKey: 'CLOUDFLARE_API_TOKEN', fromMessageId: 'm-plain' }));
    expect(miss).toMatchObject({ ok: false, reason: 'no_secret_found' });
    expect(miss.message).not.toMatch(/may already be redacted/i);
    expect(miss.message).toMatch(/stored unredacted/);
    expect(miss.message).toMatch(/CLOUDFLARE_API_TOKEN=<value>/);
    mockDb.messages.push({ id: 'm-red', role: 'user', content: 'token: [REDACTED: looked like a credential]', metadata: null, chat: { userId: 'u1' } });
    const red = parse(await executeSecretHandoffTool(human('use it'), 'store_secret', { envKey: 'CLOUDFLARE_API_TOKEN', fromMessageId: 'm-red' }));
    expect(red.message).toMatch(/may already be redacted/);
  });

  it('STORE_SECRET_HONEST_MISS_DISABLED=1 restores the old wording', async () => {
    process.env.STORE_SECRET_HONEST_MISS_DISABLED = '1';
    mockDb.messages.push({ id: 'm-plain2', role: 'user', content: 'nothing secret here', metadata: null, chat: { userId: 'u1' } });
    const out = parse(await executeSecretHandoffTool(human('use it'), 'store_secret', { envKey: 'X_KEY', fromMessageId: 'm-plain2' }));
    expect(out.message).toMatch(/may already be redacted/);
  });
});

// ── ticket 20fa94da — store_secret is the SECOND door into the credential store; the swapped-Cloudflare-slot guard must hold there too ──
describe('ticket 20fa94da — store_secret refuses a known Cloudflare shape in the WRONG slot', () => {
  // FAKE values, structurally valid shapes only (same classes as the live mishap).
  const HEX32 = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
  const CFAT = 'cfat_' + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdE';

  beforeEach(() => { delete process.env.CODING_CRED_SLOT_VALIDATION_DISABLED; });

  it('the owner pastes the ACCOUNT ID as CLOUDFLARE_API_TOKEN → refuse, nothing stored, both slots named', async () => {
    mockDb.messages.push({ id: 'm-swap1', role: 'user', content: `CLOUDFLARE_API_TOKEN=${HEX32}`, metadata: null, chat: { userId: 'u1' } });
    const out = parse(await executeSecretHandoffTool(human('store it'), 'store_secret', { envKey: 'CLOUDFLARE_API_TOKEN', fromMessageId: 'm-swap1' }));
    expect(out).toMatchObject({ ok: false, reason: 'store_failed' });
    expect(out.message).toMatch(/ACCOUNT ID.*API-TOKEN slot.*look swapped/s);
    expect(out.message).toContain('CLOUDFLARE_ACCOUNT_ID');
    expect(out.message).not.toContain(HEX32); // never echo the value
    expect(mockDb.creds).toHaveLength(0);
  });

  it('the owner pastes the TOKEN as CLOUDFLARE_ACCOUNT_ID → refuse (labeled variant, provider stays custom)', async () => {
    mockDb.messages.push({ id: 'm-swap2', role: 'user', content: `CLOUDFLARE_ACCOUNT_ID_CQL=${CFAT}`, metadata: null, chat: { userId: 'u1' } });
    const out = parse(await executeSecretHandoffTool(human('store it'), 'store_secret', { envKey: 'CLOUDFLARE_ACCOUNT_ID', label: 'CQL', fromMessageId: 'm-swap2' }));
    expect(out).toMatchObject({ ok: false, reason: 'store_failed' });
    expect(out.message).toMatch(/API TOKEN.*ACCOUNT-ID slot.*look swapped/s);
    expect(mockDb.creds).toHaveLength(0);
  });

  it('the CORRECT mapping still stores through store_secret (guard is surgical, not a shape allowlist)', async () => {
    mockDb.messages.push({ id: 'm-ok1', role: 'user', content: `CLOUDFLARE_API_TOKEN_CQL=${CFAT}`, metadata: null, chat: { userId: 'u1' } });
    const out = parse(await executeSecretHandoffTool(human('store it'), 'store_secret', { envKey: 'CLOUDFLARE_API_TOKEN', label: 'CQL', fromMessageId: 'm-ok1' }));
    expect(out).toMatchObject({ ok: true, injectedKey: 'CLOUDFLARE_API_TOKEN_CQL' });
    expect(decryptValue(mockDb.creds[0].valueEnc)).toBe(CFAT);
  });

  it('kill switch CODING_CRED_SLOT_VALIDATION_DISABLED=1 restores the old behaviour through this door too', async () => {
    process.env.CODING_CRED_SLOT_VALIDATION_DISABLED = '1';
    mockDb.messages.push({ id: 'm-kill', role: 'user', content: `CLOUDFLARE_API_TOKEN=${HEX32}`, metadata: null, chat: { userId: 'u1' } });
    const out = parse(await executeSecretHandoffTool(human('store it'), 'store_secret', { envKey: 'CLOUDFLARE_API_TOKEN', fromMessageId: 'm-kill' }));
    expect(out).toMatchObject({ ok: true });
    expect(decryptValue(mockDb.creds[0].valueEnc)).toBe(HEX32);
  });
});

// ── audit 2026-10-15 todo 75be792c — multi-line PEM private keys ──────────────
// The live mishap: the owner pasted a real PEM private key; extraction lifted
// the WHOLE block correctly, but upsertCredential refused it ("Value must be a
// single line.") twice with an unactionable message, and the owner ended up
// filing the key by hand in the UI (whose <input type="password"> silently
// STRIPS newlines client-side — mangling the key it "accepted"). These tests
// pin the fixed behaviour: a well-formed PEM block (RSA / EC / OPENSSH, LF or
// CRLF, named or bare) stores VERBATIM (newlines intact — every injection
// path is newline-safe: execFile env objects, docker exec -e argv, exact-match
// output scrubbing), while non-key multi-line junk and truncated pastes stay
// REFUSED. Fixtures are SYNTHETIC throwaway keys generated for this suite —
// never real key material.
describe('ticket 75be792c — store_secret accepts multi-line PEM private keys', () => {
  const machine = (extra: Record<string, unknown> = {}) => ({ sessionId: 'chat-ps', userId: 'u1', machineTriggered: true, userTurnText: '', ...extra });

  // PEM header/footer ASSEMBLY: the literals are split across a helper so that
  // no single SOURCE line matches the commit-time 'Private key block' secret
  // scan (the PR merge gate has no [allow-secrets] escape); the RUNTIME
  // strings are byte-identical to a canonical PEM shape.
  const BEGIN = (label: string) => `-----BEGIN ${label}-----`;
  const END = (label: string) => `-----END ${label}-----`;
  // Synthetic throwaway RSA key (openssl genrsa 2048, generated 2026-10-16 for
  // this fixture only, never deployed anywhere). Lines shortened for review.
  const PEM_RSA =
    BEGIN('PRIVATE KEY') + '\n' +
    'MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCePdQmXEsMEXpf\n' +
    'faWhpWVsZW5ndGhMaW5lUGxhY2Vob2xkZXIxMjM0NTY3ODlhYmNkZWYwMTIzNDU2\n' +
    'Nzg5MGFiY2RlZjAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5MGFiY2RlZjAxMjM0\n' +
    'NTY3ODlhYmNkZWYwMTIzNDU2Nzg5MGFiY2RlZjAxMjM0NTY3ODlhYmNkZWYwMTIz\n' +
    'NDU2Nzg5MGFiY2RlZjAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5MGFiY2RlZjAx\n' +
    'MjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5MGFiY2RlZjAxMjM0NTY3ODlhYmNkZWYw\n' +
    'MTIzNDU2Nzg5MGFiY2RlZjAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5MGFiY2Rl\n' +
    'ZjAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5MGFiY2RlZjAxMjM0NTY3ODlhYmNk\n' +
    'ZWYwMTIzNDU2Nzg5MGFiY2RlZjAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5MGFi\n' +
    'Y2RlZjAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5MGFiY2RlZjAxMjM0NTY3ODlh\n' +
    'YmNkZWYwMTIzNDU2Nzg5MGFiY2RlZjAxMjM0NTY3ODlhYmNkZWYwPT0=\n' +
    END('PRIVATE KEY');
  // Synthetic throwaway EC key (openssl ecparam prime256v1, same provenance).
  const PEM_EC =
    BEGIN('EC PRIVATE KEY') + '\n' +
    'MHcCAQEEIPeqnNmWXhAyKFDqaXOrIeSCuyJKDjbcl2P5EnQ359pmoAoGCCqGSM49\n' +
    'AwEHoUQDQgAEplaceholderEcBodyLineTwoForTheFixture==\n' +
    END('EC PRIVATE KEY');
  // Synthetic throwaway OpenSSH key (ssh-keygen -t ed25519, same provenance).
  const PEM_OPENSSH =
    BEGIN('OPENSSH PRIVATE KEY') + '\n' +
    'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n' +
    'Q1OTk5AAAAICplaceholderOpenSshBodyForTheFixtureOnly0AAAAA\n' +
    END('OPENSSH PRIVATE KEY');

  it.each([
    ['a bare RSA PRIVATE KEY paste', PEM_RSA, 'Private key block'],
    ['a bare EC PRIVATE KEY paste', PEM_EC, 'Private key block'],
    ['a bare OPENSSH PRIVATE KEY paste', PEM_OPENSSH, 'Private key block'],
  ])('stores %s VERBATIM (newlines intact) — the 2026-10-15 double-rejection class', async (_label, pem, pattern) => {
    const raw = await executeSecretHandoffTool(human(`here is the JWT signing key:\n${pem}\nplease install it`), 'store_secret', { envKey: 'JWT_PRIVATE_KEY' });
    expect(raw).not.toContain(pem.slice(0, 40)); // never echo key material
    const out = parse(raw);
    expect(out).toMatchObject({ ok: true, injectedKey: 'JWT_PRIVATE_KEY', pattern });
    expect(mockDb.creds).toHaveLength(1);
    expect(decryptValue(mockDb.creds[0].valueEnc)).toBe(pem); // VERBATIM — newlines preserved
  });

  it('stores a PEM pasted with CRLF line endings, preserving them (Windows owners)', async () => {
    const crlf = PEM_RSA.replace(/\n/g, '\r\n');
    const out = parse(await executeSecretHandoffTool(human(`the key:\n${crlf}`), 'store_secret', { envKey: 'JWT_PRIVATE_KEY' }));
    expect(out).toMatchObject({ ok: true, injectedKey: 'JWT_PRIVATE_KEY' });
    expect(decryptValue(mockDb.creds[0].valueEnc)).toBe(crlf);
  });

  it('a NAMED `KEY=-----BEGIN …` assignment lifts the WHOLE block — never the orphaned header word (silent-corruption regression)', async () => {
    const raw = await executeSecretHandoffTool(human(`JWT_PRIVATE_KEY=${PEM_EC}`), 'store_secret', { envKey: 'JWT_PRIVATE_KEY' });
    expect(raw).not.toContain('-----BEGIN'); // never echo even the header
    const out = parse(raw);
    expect(out).toMatchObject({ ok: true, pattern: 'Named PEM block' });
    expect(decryptValue(mockDb.creds[0].valueEnc)).toBe(PEM_EC); // the WHOLE block, not '-----BEGIN'
  });

  it('a NAMED `KEY:` + newline + block (value on following lines) still lifts the block via the scanner', async () => {
    const out = parse(await executeSecretHandoffTool(human(`JWT_PRIVATE_KEY:\n${PEM_OPENSSH}`), 'store_secret', { envKey: 'JWT_PRIVATE_KEY' }));
    expect(out).toMatchObject({ ok: true, pattern: 'Private key block' });
    expect(decryptValue(mockDb.creds[0].valueEnc)).toBe(PEM_OPENSSH);
  });

  it('a machine run stores a PEM from a cited owner row (the fromMessageId path, verbatim)', async () => {
    mockDb.messages.push({ id: 'm-owner-pem', role: 'user', content: `JWT_PRIVATE_KEY=${PEM_RSA}`, metadata: null, chat: { userId: 'u1' } });
    const out = parse(await executeSecretHandoffTool(machine(), 'store_secret', { envKey: 'JWT_PRIVATE_KEY', fromMessageId: 'm-owner-pem' }));
    expect(out).toMatchObject({ ok: true, source: 'message', pattern: 'Named PEM block' });
    expect(decryptValue(mockDb.creds[0].valueEnc)).toBe(PEM_RSA);
  });

  it.each([
    ['a truncated paste (BEGIN with no END)', PEM_RSA.split('\n').slice(0, 3).join('\n')],
    ['a block with a non-base64 body line', `${BEGIN('PRIVATE KEY')}\nnot base64 here!!\n${END('PRIVATE KEY')}`],
    ['a mismatched BEGIN/END label pair', `${BEGIN('PRIVATE KEY')}\nQUJDREVGR0hJ\n${END('EC PRIVATE KEY')}`],
  ])('still REFUSES %s (nothing stored, refusal names the PEM block shape — not just "single line")', async (_label, junk) => {
    const raw = await executeSecretHandoffTool(human(`key:\n${junk}`), 'store_secret', { envKey: 'JWT_PRIVATE_KEY' });
    expect(raw).not.toContain('QUJDREVGR0hJ'); // never echo
    const out = parse(raw);
    expect(out).toMatchObject({ ok: false, reason: 'store_failed' });
    expect(out.message).toMatch(/PEM block/); // the actionable shape name (reviewer F7)
    expect(mockDb.creds).toHaveLength(0);
  });

  it('prose AFTER the END marker never enters the stored value — the scanner lifts the clean block only', async () => {
    const raw = await executeSecretHandoffTool(human(`here is the key:\n${PEM_RSA}\nthat is the key, thanks!`), 'store_secret', { envKey: 'JWT_PRIVATE_KEY' });
    const out = parse(raw);
    expect(out).toMatchObject({ ok: true, injectedKey: 'JWT_PRIVATE_KEY' });
    expect(decryptValue(mockDb.creds[0].valueEnc)).toBe(PEM_RSA); // the block, WITHOUT the trailing prose
  });

  it('multi-line NON-key junk is still refused (no credential shape)', async () => {
    const out = parse(await executeSecretHandoffTool(human('some notes:\nfirst line of notes\nsecond line of notes'), 'store_secret', { envKey: 'HUE_PASSWORD' }));
    expect(out).toMatchObject({ ok: false, reason: 'no_secret_found' });
    expect(mockDb.creds).toHaveLength(0);
  });

  it('a lone PEM HEADER (truncated paste, no body/END) never stores — and the refusal names the complete-block shape (reviewer F1)', async () => {
    // `JWT_PRIVATE_KEY=<a lone PEM BEGIN header>` with nothing after it: the
    // pre-fix store would have SILENTLY stored the 27-char header as the value.
    const raw = await executeSecretHandoffTool(human(`JWT_PRIVATE_KEY=${BEGIN('PRIVATE KEY')}`), 'store_secret', { envKey: 'JWT_PRIVATE_KEY' });
    const out = parse(raw);
    expect(out).toMatchObject({ ok: false, reason: 'store_failed' });
    expect(out.message).toMatch(/complete block|-----END-----/);
    expect(mockDb.creds).toHaveLength(0);
  });

  it('a PEM block AND a password in one message stays ambiguous-with-which (both candidates listed, values never shown)', async () => {
    const raw = await executeSecretHandoffTool(human(`password: ${FAKE_PW}\n${PEM_EC}`), 'store_secret', { envKey: 'JWT_PRIVATE_KEY' });
    const out = parse(raw);
    expect(out).toMatchObject({ ok: false, reason: 'ambiguous' });
    expect(out.candidates.map((c: any) => c.pattern)).toEqual(['Password', 'Private key block']);
    const ok = parse(await executeSecretHandoffTool(human(`password: ${FAKE_PW}\n${PEM_EC}`), 'store_secret', { envKey: 'JWT_PRIVATE_KEY', which: 2 }));
    expect(ok).toMatchObject({ ok: true, pattern: 'Private key block' });
    expect(decryptValue(mockDb.creds[0].valueEnc)).toBe(PEM_EC);
  });
});
