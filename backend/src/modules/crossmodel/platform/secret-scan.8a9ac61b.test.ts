/**
 * Acceptance replay — audit 2026-10-16 todo 8a9ac61b (framework audit,
 * owner directive 2026-10-16): the "store_secret enumeration still blind to
 * the 4 new key shapes" follow-up to 8d15611c — probe ≠ live path.
 *
 * THE INCIDENT (all receipt-verified): the LiteLLM gateway supervisor's
 * machine-wake store_secret {fromMessageId: 1c7e9a72} was refused 'ambiguous'
 * at 22:19:56Z (receipt 923e8da3) offering ONLY the 4 legacy batch-1 keys
 * (72/51/49/164 chars) — 32 min AFTER the pattern wave (036a0cc6, run
 * 38968566908) completed and on a build that CONTAINED it (ancestry
 * 036a0cc6 ∈ 253b40a3). A run started after the LAST wave of the churn
 * (67ae3673, completed 22:32:47Z) enumerated ALL 8 candidates including the
 * four new shapes (#1 Alibaba 114, #2 o1_ 129, #3 Alibaba 116, #8 xAI 84).
 * VERDICT: a draining worker served the pre-wave pattern set mid-deploy-churn
 * — the 37a875ee stale-process class, NOT a code gap (the live enumeration
 * path IS the shared registry: extractSecretForHandoff → findSecretSpans →
 * SECRET_PATTERNS; there is no second list).
 *
 * THE FIX THIS SUITE PINS (the class cost a full fleet round because a
 * refusal carried nothing that could distinguish "scanner too old" from
 * "shape unknown"): scannerStamp() — a djb2 digest of the pattern-registry
 * NAMES — now rides every store_secret refusal result (`scanner`) and every
 * store_secret loop-metric row (scannerPatterns / scannerStamp). Two
 * refusals of the same paste with different stamps = version skew (stale
 * worker: retry from a fresh run); the same stamp on a missing shape = a
 * REAL pattern gap (file the shape).
 *
 * Tests exercise the REAL handler path (executeSecretHandoffTool with a
 * machine-triggered ctx + fromMessageId — exactly how the gateway lane
 * calls it), not just the pure lifter. SYNTHETIC same-shape values only —
 * never the owner's real keys.
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
const mockMessages: Array<{ id: string; role: string; content: string; metadata: any; chat: { userId: string } }> = [];
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    crossModelMessage: { findUnique: async ({ where }: any) => mockMessages.find((m) => m.id === where.id) ?? null },
    codingCredential: {
      findUnique: async () => null,
      count: async () => 0,
      upsert: async () => ({}),
    },
    activity: { create: async ({ data }: any) => data },
  },
}));

import { executeSecretHandoffTool } from './secret-handoff-tools';
import { SECRET_PATTERNS, scannerStamp } from './secret-scan';

// Synthetic values mirroring the MEASURED structure of the 1c7e9a72 paste
// (structure-only probe, todo 8d15611c — never the real values).
const grow = (head: string, target: number): string => {
  const alphabet = 'Ab1Cd2Ef3gH4iJ5kL6mN7oP8qR9sT0uV';
  let out = head;
  let i = 0;
  while (out.length < target) out += alphabet[i++ % alphabet.length];
  return out.slice(0, target);
};
const ALI_CODING = grow('sk-sp-Qw7Ab2.gH5iJ6kL.oP9qR', 114);   // #1 Alibaba Model Studio key
const O1_PLAN = grow('o1_4Ns8aB-cD2eF4gH.iJ6kL8mN0pQ2rS.tU4vW6xY8zA0bC', 129); // #2 OpenAI token-plan id
const ALI_MAIN = grow('sk-ws-Za4Bc5.h7Ij8kL9.oPq1rS_tU3vW', 116); // #3 Alibaba Model Studio key
const KIMI_CODING = grow('sk-', 72);                             // #4 generic sk- (Kimi coding)
const KIMI_PAY = grow('sk-', 51);                                // #5 generic sk- (Kimi pay)
// 49 chars: 32-hex '.' 16-alnum (the Z.ai shape). Assembled from pieces so
// the SOURCE carries no contiguous credential-shaped literal (commit gate
// G4 — the raw 49-char form is a live pattern match).
const ZAI = ['0123456789', 'abcdef0123', '456789abcdef', '.', 'ABCDEFGHIJKLMNOP'].join('');
const OAI_LITELLM = grow('sk-', 164);                            // #7 generic sk- (openai-litellm)
// 'xai-' + 32 alnum, grown to 84 — same G4 note (the contiguous literal
// matches the xAI pattern; the pieces do not).
const XAI = grow(['xai-', 'Ab3cDe5fGh7iJk9', 'lMn1pQr3sTu5vWx7yZ'].join(''), 84); // #8 xAI API key
const ALL_SYNTHETIC = [ALI_CODING, O1_PLAN, ALI_MAIN, KIMI_CODING, KIMI_PAY, ZAI, OAI_LITELLM, XAI];

/** The 1c7e9a72 paste's SHAPE: 8 bare tokens (one inside a bailian curl
 *  line, one inside a bl config line — the exact structure that produced
 *  the live 8-candidate enumeration). */
const OWNER_PASTE_REPLICA = [
  'Litellm',
  '',
  'Alibaba coding key',
  ALI_CODING,
  `curl -fsSL 'https://bailian.aliyun.com/token-plan.ap-southeast-1.sh' | bash -s -- '${O1_PLAN}'`,
  `bl config agent --agent qwen-code --region ap-southeast-1 --key ${ALI_MAIN} --model qwen3.8-max`,
  'Main alibaba',
  ALI_MAIN,
  'Kimi coding pla',
  KIMI_CODING,
  `Kimi pay ${KIMI_PAY}`,
  'z.ai',
  ZAI,
  'openai - lite llm',
  OAI_LITELLM,
  XAI,
].join('\n');

beforeAll(() => { process.env.JWT_SECRET = 'test-secret-for-store-secret-0123456789abcdef'; });
beforeEach(() => { mockMessages.length = 0; mockMetrics.length = 0; delete process.env.STORE_SECRET_TOOL_DISABLED; });
const settle = () => new Promise((r) => setImmediate(r));
const parse = (s: string) => JSON.parse(s);
// The LIVE-path ctx: a machine-triggered run citing the owner's paste —
// exactly how the LiteLLM gateway lane called it at 22:19:56Z.
const machineWake = () => ({ sessionId: 'chat-gw', userId: 'u1', machineTriggered: true, userTurnText: '' });
const pushOwnerPaste = (id = 'm-paste') => {
  mockMessages.push({ id, role: 'user', content: OWNER_PASTE_REPLICA, metadata: null, chat: { userId: 'u1' } });
  return id;
};

describe('8a9ac61b — scannerStamp (the self-diagnosing registry digest)', () => {
  it('is an 8-hex digest of the registry names, deterministic, and counts the patterns', () => {
    const a = scannerStamp();
    const b = scannerStamp();
    expect(a).toEqual(b);
    expect(a.patterns).toBe(SECRET_PATTERNS.length);
    expect(a.stamp).toMatch(/^[0-9a-f]{8}$/);
    // The stamp is a function of the NAMES (registry content drives it): the
    // same djb2 over the names computes to the same digest — a registry edit
    // (a new shape, a rename) changes the stamp, which is the whole point.
    let h = 5381;
    for (const p of SECRET_PATTERNS) for (let i = 0; i < p.name.length; i++) h = (h * 33 + p.name.charCodeAt(i)) >>> 0;
    expect(a.stamp).toBe(h.toString(16).padStart(8, '0'));
  });

  it('the four new-shape pattern names are in the registry the stamp covers (8d15611c shapes live)', () => {
    const names = SECRET_PATTERNS.map((p) => p.name);
    for (const n of ['Alibaba Model Studio key', 'xAI API key', 'OpenAI token-plan id']) expect(names).toContain(n);
    // containment order still pinned by the 8d15611c suite; the stamp counts
    // them all, so a future pattern removal changes it.
  });
});

describe('8a9ac61b — the LIVE machine-run path enumerates all four shapes (probe ≠ live path, resolved)', () => {
  it('a machine-wake store_secret citing the owner paste enumerates 8 candidates INCLUDING the 4 new shapes', async () => {
    const id = pushOwnerPaste();
    const raw = await executeSecretHandoffTool(machineWake(), 'store_secret', { envKey: 'ALIBABA_CODING_API_KEY', fromMessageId: id });
    for (const v of ALL_SYNTHETIC) expect(raw).not.toContain(v); // values never leak
    const out = parse(raw);
    expect(out).toMatchObject({ ok: false, reason: 'ambiguous' });
    // The exact live enumeration (the 22:19:56Z stale-worker refusal saw ONLY
    // #4/#5/#6/#7 — the legacy shapes — with these same char counts).
    expect(out.candidates.map((c: any) => `${c.pattern}:${c.chars}`)).toEqual([
      'Alibaba Model Studio key:114',
      'OpenAI token-plan id:129',
      'Alibaba Model Studio key:116',
      'OpenAI/Anthropic-style key:72',
      'OpenAI/Anthropic-style key:51',
      'Z.ai API key:49',
      'OpenAI/Anthropic-style key:164',
      'xAI API key:84',
    ]);
    expect(mockMessages).toHaveLength(1); // nothing was mutated
  });

  it('every ambiguous refusal carries the scanner stamp on the RESULT (version-skew self-diagnosis)', async () => {
    const id = pushOwnerPaste();
    const out = parse(await executeSecretHandoffTool(machineWake(), 'store_secret', { envKey: 'XAI_API_KEY', fromMessageId: id }));
    const stamp = scannerStamp();
    expect(out.scanner).toEqual(stamp);
  });

  it('the ambiguous refusal METRIC row carries scannerPatterns + scannerStamp, and never a value', async () => {
    const id = pushOwnerPaste();
    await executeSecretHandoffTool(machineWake(), 'store_secret', { envKey: 'ALIBABA_API_KEY', fromMessageId: id });
    await settle();
    const last = mockMetrics[mockMetrics.length - 1];
    expect(last.kind).toBe('store_secret');
    const stamp = scannerStamp();
    expect(last.meta).toMatchObject({ outcome: 'refused', reason: 'ambiguous', scannerPatterns: stamp.patterns, scannerStamp: stamp.stamp });
    expect(last.meta.candidatePatterns.map((c: any) => c.pattern)).toEqual(expect.arrayContaining(['Alibaba Model Studio key', 'xAI API key', 'OpenAI token-plan id']));
    for (const v of ALL_SYNTHETIC) expect(JSON.stringify(last)).not.toContain(v);
  });

  it('a no_secret_found refusal carries the stamp too (old scanner vs unknown shape)', async () => {
    mockMessages.push({ id: 'm-clean', role: 'user', content: 'here are the notes, nothing sensitive', metadata: null, chat: { userId: 'u1' } });
    const out = parse(await executeSecretHandoffTool(machineWake(), 'store_secret', { envKey: 'XAI_API_KEY', fromMessageId: 'm-clean' }));
    expect(out).toMatchObject({ ok: false, reason: 'no_secret_found' });
    expect(out.scanner).toEqual(scannerStamp());
    await settle();
    expect(mockMetrics[mockMetrics.length - 1].meta).toMatchObject({ reason: 'no_secret_found', scannerPatterns: scannerStamp().patterns, scannerStamp: scannerStamp().stamp });
  });

  it('which picks through the live path store the four target shapes (the 4 lifts the gateway lane re-attempts)', async () => {
    // Four one-key stores, exactly the gateway lane's re-attempt plan — each
    // returns the pattern name it lifted; the value lands encrypted (creds
    // upsert is called) and never appears in the result.
    for (const [envKey, which, pattern] of [
      ['ALIBABA_CODING_API_KEY', 1, 'Alibaba Model Studio key'],
      ['ALIBABA_TOKEN_PLAN_KEY', 2, 'OpenAI token-plan id'], // the bailian o1_ id — plan/bootstrap plumbing, NOT a bearer (field-verified: the sk-sp key is the token-plan bearer; see the secret-scan.ts provenance note)
      ['ALIBABA_API_KEY', 3, 'Alibaba Model Studio key'],
      ['XAI_API_KEY', 8, 'xAI API key'],
    ] as const) {
      const id = pushOwnerPaste();
      const raw = await executeSecretHandoffTool(machineWake(), 'store_secret', { envKey, fromMessageId: id, which });
      const out = parse(raw);
      expect(out).toMatchObject({ ok: true, envKey, pattern, source: 'message' });
      for (const v of ALL_SYNTHETIC) expect(raw).not.toContain(v);
    }
  });
});
