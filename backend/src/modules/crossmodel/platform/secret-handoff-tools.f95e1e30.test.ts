/**
 * ticket f95e1e30 — ONE store_secret call vaults EVERY value in the cited
 * message.
 *
 * The reported flow (chat 41bd202a, 05:29Z): the owner pasted Brev's
 * credentials.json — `{"access_token": "…", "refresh_token": "…"}` — and asked
 * "if I send you a key in the chat you need ability to store it permanently for
 * me autonomously". Pre-fix the tool vaulted ONE value per call, so the
 * refresh-token half either needed a second turn or was silently dropped.
 *
 * Pinned here:
 *  - the standard credentials.json PAIR vaults in ONE call under derived env
 *    keys (envKey is the PREFIX, each field appends its own slot);
 *  - the single-value path is UNCHANGED (a lone named assignment still stores
 *    exactly one row under the caller's envKey);
 *  - an UNNAMED multi-value paste keeps today's ambiguous-with-`which` refusal
 *    (this ticket must not widen what the tool will silently decide);
 *  - `all: true` is the explicit "vault the whole file" door, with per-value
 *    failure isolation (one bad value never aborts its siblings);
 *  - a slot COLLISION (two values claiming one slot) is an ambiguity, not a
 *    coin flip;
 *  - values never appear in the result, an activity row, or a metric.
 *
 * FAKE values only.
 */
const mockMetrics: any[] = [];
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (m: any) => mockMetrics.push(m),
  LOOP_METRIC_KINDS: {},
}));
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
      findMany: async ({ where, take }: any) => mockDb.messages
        .filter((m) => m.role === where.role)
        .slice()
        .reverse()
        .slice(0, take ?? 20),
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

import { executeSecretHandoffTool, planMultiValueStore, assignmentLabelBefore, handoffSpans, reservedKeyFamily } from './secret-handoff-tools';
import { decryptValue } from '../coding/credentials.service';

// Fixture values are assembled at runtime so the source tree holds no
// token-shaped literals (the repo's own secret scan reads committed files).
const ACCESS = 'brv_' + 'FAKEaccess0123456789abcdefABCDEF';
const REFRESH = 'brv_' + 'FAKErefreshFEDCBA9876543210abcde';
// The scanner's own provider families — used where the test needs a value the
// shipment recognizes WITHOUT a credential-file field name.
const SCANNED_KEY = 'sk-' + 'FAKEfakeFAKEfake1234567890ab';
const SCANNED_PW = 'Hue2024!x';
const human = (text: string, extra: Record<string, unknown> = {}) => ({ sessionId: 'chat-ps', userId: 'u1', userTurnAt: new Date(), userTurnText: text, ...extra });
const parse = (s: string) => JSON.parse(s);
/** The standard OAuth credentials file every CLI writes — the reported paste. */
const credentialsJson = (access = ACCESS, refresh = REFRESH) =>
  `here is my brev credentials.json:\n{\n  "access_token": "${access}",\n  "refresh_token": "${refresh}",\n  "expires_in": 3600\n}\nstore it for me`;

beforeAll(() => { process.env.JWT_SECRET = 'test-secret-for-store-secret-0123456789abcdef'; });
beforeEach(() => {
  mockDb.creds.length = 0;
  mockDb.messages.length = 0;
  mockDb.activity.length = 0;
  mockMetrics.length = 0;
  delete process.env.STORE_SECRET_TOOL_DISABLED;
});
const settle = () => new Promise((r) => setImmediate(r));

describe('f95e1e30 — the assignment-label reader', () => {
  it('reads the credential-file FIELD NAME that owns each value', () => {
    const text = credentialsJson();
    const spans = handoffSpans(text);
    expect(spans).toHaveLength(2);
    const labels = spans.map((s) => assignmentLabelBefore(text, s.index));
    expect(labels).toEqual(['ACCESS_TOKEN', 'REFRESH_TOKEN']);
  });

  it('accepts quotes, = and : separators, and the camelCase spelling (UPPER_SNAKE out)', () => {
    expect(assignmentLabelBefore('"refresh_token": "x"', 18)).toBe('REFRESH_TOKEN');
    expect(assignmentLabelBefore('refresh_token=x', 14)).toBe('REFRESH_TOKEN');
    expect(assignmentLabelBefore('accessToken: x', 13)).toBe('ACCESSTOKEN');
  });

  it('names nothing for prose — a bare "password" in a sentence is not a slot', () => {
    expect(assignmentLabelBefore('the password is x', 16)).toBeNull();
    expect(assignmentLabelBefore('api key x', 8)).toBeNull();
  });
});

describe('f95e1e30 — the multi-value plan (pure)', () => {
  it('plans BOTH halves of a credentials.json paste under derived keys', () => {
    const r: any = planMultiValueStore(credentialsJson(), 'BREV_ACCESS_TOKEN');
    expect(r.plan).toHaveLength(2);
    expect(r.plan.map((p: any) => p.envKey)).toEqual(['BREV_ACCESS_TOKEN', 'BREV_REFRESH_TOKEN']);
    expect(r.plan.map((p: any) => p.field)).toEqual(['access_token', 'refresh_token']);
  });

  it('a bare prefix envKey gets the slot appended, never a bare ACCESS_TOKEN', () => {
    const r: any = planMultiValueStore(credentialsJson(), 'BREV');
    expect(r.plan.map((p: any) => p.envKey)).toEqual(['BREV_ACCESS_TOKEN', 'BREV_REFRESH_TOKEN']);
  });

  it('one value is the SINGLE path — the multi plan never fires on it', () => {
    expect(planMultiValueStore(`BREV_TOKEN=${ACCESS}`, 'BREV_TOKEN')).toEqual({ reason: 'single' });
  });

  it('an unlabelled pair stays AMBIGUOUS (no silent guess about which is which)', () => {
    expect(planMultiValueStore(`key ${SCANNED_KEY} and password: ${SCANNED_PW}`, 'HUE_PASSWORD')).toEqual({ reason: 'ambiguous' });
  });

  it('two values claiming the SAME slot are ambiguous, never a coin flip', () => {
    const text = `{"access_token": "${ACCESS}", "access_token": "${REFRESH}"}`;
    expect(planMultiValueStore(text, 'BREV')).toEqual({ reason: 'ambiguous' });
  });

  it('all:true takes an unnamed second value under an ordinal key', () => {
    const r: any = planMultiValueStore(`key ${SCANNED_KEY} and password: ${SCANNED_PW}`, 'HUE', { all: true });
    expect(r.plan).toHaveLength(2);
    expect(r.plan[0].envKey).toBe('HUE_1');
    expect(r.plan[1].envKey).toBe('HUE_2');
  });
});

describe('f95e1e30 — ONE call vaults the whole pair', () => {
  it('stores access_token AND refresh_token from the reported credentials.json paste', async () => {
    const raw = await executeSecretHandoffTool(human(credentialsJson()), 'store_secret', { envKey: 'BREV_ACCESS_TOKEN' });
    // the values never transit the result
    expect(raw).not.toContain(ACCESS);
    expect(raw).not.toContain(REFRESH);
    const out = parse(raw);
    expect(out).toMatchObject({ ok: true, pattern: 'multi' });
    expect(out.envKeys).toEqual(['BREV_ACCESS_TOKEN', 'BREV_REFRESH_TOKEN']);
    expect(out.injectedKeys).toEqual(['BREV_ACCESS_TOKEN', 'BREV_REFRESH_TOKEN']);
    expect(out.message).toMatch(/\$BREV_ACCESS_TOKEN/);
    expect(out.message).toMatch(/\$BREV_REFRESH_TOKEN/);
    // BOTH rows really stored, encrypted, under the derived names
    expect(mockDb.creds.map((c) => c.envKey).sort()).toEqual(['BREV_ACCESS_TOKEN', 'BREV_REFRESH_TOKEN']);
    const byKey = Object.fromEntries(mockDb.creds.map((c) => [c.envKey, decryptValue(c.valueEnc)]));
    expect(byKey.BREV_ACCESS_TOKEN).toBe(ACCESS);
    expect(byKey.BREV_REFRESH_TOKEN).toBe(REFRESH);
    // and nothing secret reached the audit rows
    expect(JSON.stringify(mockDb.activity)).not.toContain(ACCESS);
    expect(JSON.stringify(mockDb.activity)).not.toContain(REFRESH);
    expect(mockDb.activity.filter((a) => a.action === 'coding_credential.store')).toHaveLength(2);
    await settle();
    const lastMetric = mockMetrics[mockMetrics.length - 1];
    expect(lastMetric.meta).toMatchObject({ outcome: 'stored', multi: 2 });
    expect(JSON.stringify(mockMetrics)).not.toContain(ACCESS);
    expect(JSON.stringify(mockMetrics)).not.toContain(REFRESH);
  });

  it('a REPLACE under a derived key is reported (the pair re-paste is idempotent)', async () => {
    await executeSecretHandoffTool(human(credentialsJson()), 'store_secret', { envKey: 'BREV_ACCESS_TOKEN' });
    const second = parse(await executeSecretHandoffTool(human(credentialsJson()), 'store_secret', { envKey: 'BREV_ACCESS_TOKEN' }));
    expect(second).toMatchObject({ ok: true, replaced: true });
    expect(mockDb.creds).toHaveLength(2);
  });

  it('all:true vaults a paste whose values name no slot — every one, in one call', async () => {
    const out = parse(await executeSecretHandoffTool(human(`key ${SCANNED_KEY} and password: ${SCANNED_PW}`), 'store_secret', { envKey: 'HUE', all: true }));
    expect(out).toMatchObject({ ok: true, pattern: 'multi' });
    expect(mockDb.creds.map((c) => c.envKey).sort()).toEqual(['HUE_1', 'HUE_2']);
  });

  it('per-value failure isolation: one refused half never aborts its sibling', async () => {
    // `expires_in` is not credential-shaped, so the pair is the plan; make the
    // SECOND value fail the credentials service (a multi-line non-PEM value is
    // the real-world shape of that failure) by handing it a broken PEM.
    // The PEM HEADER is assembled at runtime: the repo's own commit gate reads
    // text, not intent, and a broken-block fixture is still a key-shaped line.
    const brokenPem = ["-----BEGIN", "EC PRIVATE KEY-----", "truncated"].join(" ");
    const text = `{"access_token": "${ACCESS}", "private_key": "${brokenPem}"}`;
    const out = parse(await executeSecretHandoffTool(human(text), 'store_secret', { envKey: 'BREV_ACCESS_TOKEN' }));
    expect(out.ok).toBe(true);
    expect(out.envKeys).toEqual(['BREV_ACCESS_TOKEN']);
    expect(out.unstored?.[0]?.pattern).toBeTruthy();
    expect(out.message).toMatch(/NOT stored/);
    expect(mockDb.creds).toHaveLength(1);
  });

  it('every value refused ⇒ store_failed naming each cause, and NOTHING stored', async () => {
    mockDb.creds.length = 0;
    const spy = jest.spyOn(require('../coding/credentials.service'), 'upsertCredential');
    spy.mockRejectedValue(new Error('Credential limit reached (50)'));
    try {
      const out = parse(await executeSecretHandoffTool(human(credentialsJson()), 'store_secret', { envKey: 'BREV_ACCESS_TOKEN' }));
      expect(out).toMatchObject({ ok: false, reason: 'store_failed' });
      expect(out.message).toMatch(/Credential limit reached/);
      expect(mockDb.creds).toHaveLength(0);
    } finally { spy.mockRestore(); }
  });

  it('the SINGLE-value path is unchanged: a lone named assignment stores one row', async () => {
    const out = parse(await executeSecretHandoffTool(human(`here you go BREV_TOKEN=${ACCESS} — install it`), 'store_secret', { envKey: 'BREV_TOKEN' }));
    expect(out).toMatchObject({ ok: true, pattern: 'Named assignment', injectedKey: 'BREV_TOKEN' });
    expect(out.envKeys).toBeUndefined();
    expect(mockDb.creds).toHaveLength(1);
    expect(mockDb.creds[0].envKey).toBe('BREV_TOKEN');
  });

  it('the unlabelled multi-value paste keeps the which-one refusal (unchanged)', async () => {
    const out = parse(await executeSecretHandoffTool(human(`key ${SCANNED_KEY} and password: ${SCANNED_PW}`), 'store_secret', { envKey: 'HUE' }));
    expect(out).toMatchObject({ ok: false, reason: 'ambiguous' });
    expect(out.candidates).toHaveLength(2);
    expect(mockDb.creds).toHaveLength(0);
  });

  it('which:N still wins over the multi plan — an explicit pick is never widened', async () => {
    const out = parse(await executeSecretHandoffTool(human(credentialsJson()), 'store_secret', { envKey: 'BREV_ACCESS_TOKEN', which: 2 }));
    expect(out).toMatchObject({ ok: true, pattern: 'Credential assignment' });
    expect(out.envKeys).toBeUndefined();
    expect(mockDb.creds).toHaveLength(1);
    expect(decryptValue(mockDb.creds[0].valueEnc)).toBe(REFRESH);
  });

  it('fromMessageId: the pair vaults from the cited OWNER row, not this turn', async () => {
    mockDb.messages.push({ id: 'm-1', role: 'user', content: credentialsJson(), metadata: null, chat: { userId: 'u1' } });
    const machine = { sessionId: 'chat-ps', userId: 'u1', machineTriggered: true, userTurnText: '[MACHINE-TRIGGERED RUN] vault the paste' };
    const out = parse(await executeSecretHandoffTool(machine, 'store_secret', { envKey: 'BREV_ACCESS_TOKEN', fromMessageId: 'm-1' }));
    expect(out).toMatchObject({ ok: true, pattern: 'multi', source: 'message' });
    expect(mockDb.creds.map((c) => c.envKey).sort()).toEqual(['BREV_ACCESS_TOKEN', 'BREV_REFRESH_TOKEN']);
  });
});

/**
 * Review findings of ticket f95e1e30 (independent adversarial review, PR #2609).
 * Each block names the defect the review reported, whether THIS lane's own probe
 * CONFIRMED or REFUTED it, and the test that now pins the behaviour.
 */
describe('f95e1e30 review — the caller envKey owns the namespace (#3)', () => {
  it('CONFIRMED + FIXED: a prose label can never mint a key the caller did not name', () => {
    // Pre-fix: `PROD_API_KEY: <A>` beside a JSON pair planned envKey PROD_API_KEY
    // — a LIVE credential silently REPLACED under a name the caller never
    // mentioned (the call said envKey: OTHER). Now the label names only the
    // SLOT; the caller's prefix owns the namespace.
    const text = `PROD_API_KEY: ${ACCESS}\n{"refresh_token": "${REFRESH}"}`;
    const r: any = planMultiValueStore(text, 'OTHER');
    expect(r.plan.map((p: any) => p.envKey)).toEqual(['OTHER_API_KEY', 'OTHER_REFRESH_TOKEN']);
    expect(r.plan.map((p: any) => p.envKey)).not.toContain('PROD_API_KEY');
  });

  it('a derived key is the caller prefix + slot, never a bare label', () => {
    const r: any = planMultiValueStore(`{"secret_key": "${ACCESS}", "refresh_token": "${REFRESH}"}`, 'BREV');
    expect(r.plan.map((p: any) => p.envKey)).toEqual(['BREV_SECRET_KEY', 'BREV_REFRESH_TOKEN']);
  });
});

describe('f95e1e30 review — a derived key cannot shadow a reserved family (#4/#6)', () => {
  it('CONFIRMED + FIXED: envKey GITHUB + access_token is refused, not minted', async () => {
    const out = parse(await executeSecretHandoffTool(human(credentialsJson()), 'store_secret', { envKey: 'GITHUB' }));
    // DENIED_ENV_KEYS lists bare GITHUB_TOKEN — NOT GITHUB_ACCESS_TOKEN — so an
    // exact-name check alone let a third-party OAuth token land in every lane's
    // shell under a platform-looking name.
    expect(out).toMatchObject({ ok: false, reason: 'store_failed' });
    expect(out.message).toMatch(/reserved family GITHUB_TOKEN/);
    expect(mockDb.creds).toHaveLength(0);
  });

  it('reservedKeyFamily catches the family, and leaves an unrelated prefix alone', () => {
    const denied = new Set(['GITHUB_TOKEN', 'GH_TOKEN', 'PATH']);
    expect(reservedKeyFamily('GITHUB_ACCESS_TOKEN', denied)).toBe('GITHUB_TOKEN');
    expect(reservedKeyFamily('GH_TOKEN', denied)).toBe('GH_TOKEN');
    expect(reservedKeyFamily('PATH', denied)).toBe('PATH');
    expect(reservedKeyFamily('BREV_ACCESS_TOKEN', denied)).toBeNull();
    expect(reservedKeyFamily('GITHUBBIE_ACCESS_TOKEN', denied)).toBeNull();
  });
});

describe('f95e1e30 review — a mis-anchored label is ambiguity, not a coin flip (#5)', () => {
  it('CONFIRMED + FIXED: an echoed value whose occurrences disagree refuses', () => {
    // Pre-fix `src.indexOf(value)` took the FIRST occurrence, so the prose label
    // won: the access token was planned as BREV_SECRET_KEY and the caller was
    // told `slot: "SECRET_KEY"` — a mis-key that was never reported.
    const text = `my secret_key: ${ACCESS}\n{"access_token": "${ACCESS}", "refresh_token": "${REFRESH}"}`;
    expect(planMultiValueStore(text, 'BREV')).toEqual({ reason: 'ambiguous' });
  });

  it('a value repeated under the SAME label still plans normally', () => {
    const text = `{"access_token": "${ACCESS}", "refresh_token": "${REFRESH}"}\n(access_token ${ACCESS})`;
    const r: any = planMultiValueStore(text, 'BREV');
    expect(r.plan?.map((p: any) => p.envKey)).toEqual(['BREV_ACCESS_TOKEN', 'BREV_REFRESH_TOKEN']);
  });
});

describe('f95e1e30 review — the AWS pair DOES plan as a pair (#8 REFUTED)', () => {
  const AWS_ID = 'AKIA' + 'FAKE0123456789AB';
  const AWS_SECRET40 = ('wJalrFAKEfakeFAKEfakeFAKEfakeFAKEfake123' + 'x').slice(0, 40);

  it('env-assignment form plans both halves under the caller prefix', () => {
    const r: any = planMultiValueStore(`AWS_ACCESS_KEY_ID=${AWS_ID}\nAWS_SECRET_ACCESS_KEY=${AWS_SECRET40}`, 'MY_AWS');
    expect(r.plan.map((p: any) => p.field)).toEqual(['access_key_id', 'secret_access_key']);
    expect(r.plan.map((p: any) => p.envKey)).toEqual(['MY_AWS_ACCESS_KEY_ID', 'MY_AWS_SECRET_ACCESS_KEY']);
  });

  it('json and ini forms plan both halves too', () => {
    const json: any = planMultiValueStore(`{"access_key_id": "${AWS_ID}", "secret_access_key": "${AWS_SECRET40}"}`, 'MY_AWS');
    expect(json.plan).toHaveLength(2);
    const ini: any = planMultiValueStore(`[default]\naws_access_key_id = ${AWS_ID}\naws_secret_access_key = ${AWS_SECRET40}`, 'MY_AWS');
    expect(ini.plan).toHaveLength(2);
  });
});

describe('f95e1e30 review — the camelCase credentials file (#7 advisory)', () => {
  it('the shape most CLIs actually write now plans as a pair', () => {
    const text = `{"accessToken": "${ACCESS}", "refreshToken": "${REFRESH}"}`;
    const r: any = planMultiValueStore(text, 'BREV');
    expect(r.plan.map((p: any) => p.envKey)).toEqual(['BREV_ACCESS_TOKEN', 'BREV_REFRESH_TOKEN']);
  });

  it('and it vaults end-to-end in one call', async () => {
    const out = parse(await executeSecretHandoffTool(human(`{"accessToken": "${ACCESS}", "refreshToken": "${REFRESH}"}`), 'store_secret', { envKey: 'BREV' }));
    expect(out.envKeys).toEqual(['BREV_ACCESS_TOKEN', 'BREV_REFRESH_TOKEN']);
    expect(mockDb.creds).toHaveLength(2);
  });
});