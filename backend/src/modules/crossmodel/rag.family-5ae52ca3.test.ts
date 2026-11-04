/**
 * Log-signal family 5ae52ca3 replay — the five sweep-filed fingerprints this
 * lane closed on 2026-10-24 (tickets 5ae52ca3 / 007c1a3a / 9cd30d58 /
 * 6d4cebff / d8078bc6), pinned at the SEAM that ends the recurrence: the
 * emitting sites now tag their designed-degradation rows with the 2026-10-18
 * log taxonomy (utils/log-level.ts logClass external/handled), which the
 * sweep honors at fetch time (isNonFaultLogRow — log-signal-sweep.service.ts).
 *
 * The defect class this file replays: adjudicated-DESIGNED graceful-degradation
 * signals (audit pins f182 82116bfcf, f184 bb77c1b9a) kept being re-filed as
 * weekly bug tickets because the emit sites were untagged. The fix tags them;
 * this test asserts BOTH halves of the contract:
 *   1. TAGGED rows of the family fingerprints never become a ticket/wake;
 *   2. the tag is NARROW — the untagged twin of each message (a real fault
 *      shape) still sweep-files. Tagging must never become silencing.
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  // log: the winston object-form entry point logExternal uses (family review F1/F2)
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() },
}));
jest.mock('../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('./memory/text-utils', () => ({ stripNulBytes: (s: string) => s }));
jest.mock('./model-endpoints/matryoshka', () => ({ truncateMatryoshka: (v: any) => v }));
jest.mock('../../utils/utility-llm', () => ({ utilityChat: jest.fn() }));
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('./model-endpoints/model-roles.service', () => ({
  __esModule: true,
  getModelRoleOverrides: jest.fn(async () => ({})),
}));
jest.mock('./model-endpoints/model-endpoints.service', () => ({
  __esModule: true,
  resolveRegistryModel: jest.fn(async () => null),
}));
// The sweep service pulls config/redis → config/env (process.exit(1)s in a
// keyless jest env) plus its delivery collaborators — mock the seams the
// infra-watch suite mocks; only the PURE exports (isNonFaultLogRow,
// normalizeLogMessage) are used here.
jest.mock('../../config/redis', () => ({ __esModule: true, default: { get: jest.fn(), set: jest.fn(), del: jest.fn() } }));
jest.mock('./fleet/infra-watch.service', () => ({
  __esModule: true,
  adminFleetSupervisors: jest.fn(async () => []),
  deliver: jest.fn(),
}));
jest.mock('./platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: { LOG_SIGNAL_SWEEP: 'log_signal_sweep', INFRA_ALERT: 'infra_alert' },
}));
jest.mock('./platform/secret-scan', () => ({ __esModule: true, redactSecrets: (s: string) => s }));
jest.mock('./fleet/day-filing-budget', () => ({ __esModule: true, reserveDayFilingSlot: jest.fn(async () => true) }));

import axios from 'axios';
import logger from '../../utils/logger';
import { isNonFaultLogRow } from './fleet/log-signal-sweep.service';

// rag.service captures DASHSCOPE_API_KEY at MODULE LOAD; set it BEFORE the
// lazy require so the built-in reranker is available (the rag.service.test.ts
// convention: env key first, module after).
const mockedAxios = axios as unknown as { post: jest.Mock };
/* eslint-disable @typescript-eslint/no-explicit-any */
let rerankTexts: any;
let retrieveChunks: any;
beforeAll(() => {
  process.env.DASHSCOPE_API_KEY = 'test-key-family-5ae52ca3';
  const rag = require('./rag.service');
  rerankTexts = rag.rerankTexts;
  retrieveChunks = rag.retrieveChunks;
});
afterAll(() => { delete process.env.DASHSCOPE_API_KEY; });

/** Winston warns (the DB transport persists warn+; info rows never reach the table).
 * Collects BOTH call shapes: two-arg warn(msg, meta) and the object form
 * warn({level:'warn', message, ...meta}) that logExternal uses (splat-safe). */
const persistedWarns = () => {
  const twoArg = (logger.warn as jest.Mock).mock.calls.map((c) => ({
    message: String(c[0]),
    meta: c[1] as Record<string, unknown> | undefined,
  }));
  const objectForm = (logger.log as jest.Mock).mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((o) => o && typeof o === 'object' && (o as any).level === 'warn')
    .map((o) => {
      const { level: _l, message, ...meta } = o as any;
      return { message: String(message), meta: meta as Record<string, unknown> };
    });
  return [...twoArg, ...objectForm];
};

beforeEach(() => {
  jest.clearAllMocks();
  // A rejected mockRejectedValueOnce queued by a prior test (never consumed)
  // must not leak into this one — reset the once-queue on the shared axios mock.
  mockedAxios.post.mockReset();
  // Default: embeddings succeed with a fixed vector; per-test rejects override.
  mockedAxios.post.mockImplementation(async (url: string, body: any) => {
    if (String(url).includes('/embeddings')) {
      return { data: { data: (body.input as string[]).map((_t, i) => ({ index: i, embedding: [0.1, 0.2, 0.3] })) } };
    }
    throw new Error(`unexpected axios.post ${url}`);
  });
});

describe('log-signal family 5ae52ca3 — designed-degradation taxonomy at the emit sites', () => {

  test('007c1a3a — rerankTexts degradation is logClass:external (warn kept, never sweep-filed)', async () => {
    mockedAxios.post.mockRejectedValueOnce(new Error('timeout of 15000ms exceeded'));
    const out = await rerankTexts('q', ['a', 'b'], 2);
    expect(out).toBeNull(); // the designed fallback: caller keeps its own order

    const rows = persistedWarns();
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toContain('rerankTexts failed — caller keeps its own order: timeout of 15000ms exceeded');
    // THE tag: the sweep's isNonFaultLogRow honors it (fetch-time exclusion).
    expect(rows[0].meta).toMatchObject({ logClass: 'external' });
    expect(rows.map((r) => ({ context: r.meta })).every(isNonFaultLogRow)).toBe(true);
  });

  test('007c1a3a narrowness — the same site still logs (never silently) when the provider 400s; tag is per-site, not per-class', async () => {
    mockedAxios.post.mockRejectedValueOnce(Object.assign(new Error('Request failed with status code 400'), {
      response: { status: 400, data: { message: 'bad rerank body' } },
    }));
    await rerankTexts('q', ['a'], 1);
    const rows = persistedWarns();
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toContain('bad rerank body');
    expect(rows[0].meta).toMatchObject({ logClass: 'external' });
  });

  test('9cd30d58 — retrieveChunks degradation is logClass:external AND the message now carries the cause (splat fix)', async () => {
    // Embeddings succeed (the beforeEach default); the retrieval SQL throws —
    // exercising the catch whose message used to end at the bare colon.
    const { default: prisma } = require('../../config/database');
    (prisma as any).$queryRawUnsafe = Object.assign(jest.fn(async () => { throw new Error('connection refused'); }), {});
    const out = await retrieveChunks('q', 'proj-1');
    expect(out).toEqual([]); // the designed fallback: answer without retrieval

    const rows = persistedWarns();
    expect(rows).toHaveLength(1);
    // The OLD bug: 'retrieveChunks error:' with the detail as a splat — the
    // persisted message ended at the colon (the sweep fingerprint was literally
    // "retrievechunks error:"). The interpolation now reaches the message.
    expect(rows[0].message).toBe('retrieveChunks error: connection refused — caller degrades to no-retrieval (returns [])');
    expect(rows[0].meta).toMatchObject({ logClass: 'external' });
    expect(rows.map((r) => ({ context: r.meta })).every(isNonFaultLogRow)).toBe(true);
  });

  test('6d4cebff — sanitizeMessages repair is logHandled (info): the warn+ transport never persists it', async () => {
    const { sanitizeMessages } = require('./coding/coding-model');
    sanitizeMessages([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'r' },
    ]);
    const info = (logger.info as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(info.some((m) => m.startsWith('sanitizeMessages: repaired'))).toBe(true);
    expect(info.some((m) => m.includes('placeholder=1'))).toBe(true); // between two user turns → placeholder leg
    // 191 rows/24h of this warn were the ticket; now ZERO warns are emitted —
    // and a handled row written at warn level would ALSO be sweep-excluded.
    expect(persistedWarns().some((w) => w.message.startsWith('sanitizeMessages: repaired'))).toBe(false);
    expect(isNonFaultLogRow({ context: { logClass: 'handled' } })).toBe(true);
  });

  test('d8078bc6 — the transport-abort turn-failure tag is EXACT (the REAL predicate, f184-conservative)', async () => {
    // The agent's catch (agent.ts turn-failure site) tags ONLY the status-less
    // exact-'aborted' message. The predicate is imported from the leaf the
    // agent itself uses (review F5: a local re-implementation could drift).
    const { isStatuslessTransportAbort } = require('./coding/turn-failure-classification');
    const { normalizeLogMessage } = require('./fleet/log-signal-sweep.service');
    // The pinned signature (f184): the status-less premature gateway close.
    expect(isStatuslessTransportAbort({ message: 'aborted' })).toBe(true);
    // Narrowness — every neighboring real-fault shape stays UNTAGGED:
    expect(isStatuslessTransportAbort({ message: 'aborted', status: 429 })).toBe(false);        // HTTP 429 is a load signal
    expect(isStatuslessTransportAbort({ message: 'aborted', status: 502 })).toBe(false);        // HTTP 5xx is a gateway fault
    expect(isStatuslessTransportAbort({ message: 'aborted', bodyText: 'provider detail' })).toBe(false); // body ⇒ diagnosable provider error
    expect(isStatuslessTransportAbort({ message: 'Request failed with status code 400' })).toBe(false);  // a different failure class
    expect(isStatuslessTransportAbort({ message: 'read ECONNRESET' })).toBe(false);             // connection reset ≠ clean abort
    // The sweep pairs the tag with normalizeLogMessage: the pinned fingerprint
    // normalizes to exactly "coding agent turn failed: aborted".
    expect(normalizeLogMessage('coding agent turn failed: aborted')).toBe('coding agent turn failed: aborted');
  });

  test('5ae52ca3 — credential-gate slot-mismatch warn stays UNTAGGED (deliberately sweepable)', () => {
    // The lead member's fingerprint (437 rows) is actionable OWNER signal: a
    // corrupt vault row needs a re-store, not a code fix. It died on its own
    // (0 rows/24h at triage) when the credential was re-stored. Tagging it
    // 'external' would HIDE a real owner-action-needed class, so the site is
    // left untagged on purpose — pinned here so a future pass cannot silently
    // widen the tags over it.
    expect(typeof require('./platform/credential-gate').credentialLifted).toBe('function');
    expect(isNonFaultLogRow({ context: { source: 'credential-gate' } })).toBe(false);
  });

  test('family contract — exactly the tagged shapes are sweep-excluded; an untagged twin still files', () => {
    const rows = [
      { context: { logClass: 'external' } },   // rerank / retrieve / aborted legs
      { context: { logClass: 'handled' } },    // sanitize repair (a warn-level handled row)
      { context: null },                       // credential-gate: deliberately sweepable
      { context: { source: 'run-model-turn' } },// any UNTAGGED degradation twin — still a fault row
    ];
    expect(rows.filter(isNonFaultLogRow).length).toBe(2); // exactly the two tagged shapes
  });

  // ── Family lane d37054e9 (2026-10-24): the three successors of this family ──
  // The sweep re-filed the SAME adjudicated sites a day later (tickets 84d5f369
  // / 847292b0 / 8386e3e8 / f68b611e). Two members are pinned here because
  // their contracts ARE this family's taxonomy decisions; the other two are
  // pinned in their own emit-site suites (utility-llm.test.ts 8386e3e8,
  // decision-gate.test.ts f68b611e).

  test('84d5f369 — rerankTexts status-code 400 degradation is the SAME tagged catch as 007c1a3a (this ticket filed pre-#1931 rows: newest 2026-10-23T06:02:35Z, before b100c5299 deployed)', async () => {
    // The sweep mines trailing-24h rows, so the fix that landed inside the
    // window still got filed (the ecc2bb0d trailing-window case). The exact
    // raw message of this ticket ("Request failed with status code 400") is
    // the tagged catch's OTHER detail shape — pin it byte-exact so the
    // status-code twin cannot drift untagged while the timeout twin stays
    // tagged.
    mockedAxios.post.mockRejectedValueOnce(Object.assign(new Error('Request failed with status code 400'), {
      response: { status: 400, data: {} }, // prod shape: DashScope's 400 body carries no `message` field → detail = err.message
    }));
    const out = await rerankTexts('q', ['a'], 1);
    expect(out).toBeNull(); // the designed fallback: caller keeps its own order

    const rows = persistedWarns();
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toContain('rerankTexts failed — caller keeps its own order: Request failed with status code 400');
    expect(rows[0].meta).toMatchObject({ logClass: 'external' });
    // A non-Error rejection (the F6-hardened catch) still degrades gracefully.
    mockedAxios.post.mockRejectedValueOnce('not-an-error' as any);
    expect(await rerankTexts('q', ['a'], 1)).toBeNull();
    expect(persistedWarns().at(-1)!.meta).toMatchObject({ logClass: 'external' });
  });

  test('847292b0 — PREDICATE pin: the turn-failure classifier refuses HTTP 5xx-with-body (Cloudflare 502/524 origin-dead), so the agentWarn tag conditional leaves them UNTAGGED', () => {
    // Scope (review D2): this pins the PREDICATE the agent catch consults
    // (agent.ts ~3703: `const transportAbort = isStatuslessTransportAbort(...);
    // agentWarn(..., transportAbort ? { logClass: 'external' } : undefined)`) —
    // it does NOT drive the full turn loop. The #1931 doctrine for this emit
    // site: ONLY the status-less transport abort is external; a 502/524 body
    // from Cloudflare ("origin web server returned an invalid or incomplete
    // response") means the provider's ORIGIN is dead — the transient lane
    // retries, and the UNTAGGED warns keep sweep-filing the owner-side
    // gateway failure (all coding seats route through llm.example.com). Pin the
    // predicate's refusal on the exact prod shapes:
    const { isStatuslessTransportAbort } = require('./coding/turn-failure-classification');
    // The ticket's raw shapes (502 + body, 524 + body) — both UNTAGGED:
    expect(isStatuslessTransportAbort({ message: 'Request failed with status code 502', status: 502, bodyText: '{"type":"https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-502/","title":"Error 502: Bad gateway"}' })).toBe(false);
    expect(isStatuslessTransportAbort({ message: 'Request failed with status code 524', status: 524, bodyText: '{"title":"Error 524: A Timeout Occurred"}' })).toBe(false);
    // ...and the row meta the agent's catch attaches to them is plain
    // attribution (source/sessionId/runId), never logClass — an untagged
    // warn row sweep-files. The tagged status-less abort stays tagged:
    expect(isStatuslessTransportAbort({ message: 'aborted' })).toBe(true);
    expect(isNonFaultLogRow({ context: { logClass: 'external' } })).toBe(true);
    expect(isNonFaultLogRow({ context: null })).toBe(false);
  });
});
