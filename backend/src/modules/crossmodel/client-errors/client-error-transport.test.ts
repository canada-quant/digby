/**
 * The logger→database hop and the sweep's own QUERY — driven for real (adversarial
 * review MAJOR 3, 2026-11-06).
 *
 * The sibling suite (client-error-sweep-integration.test.ts) hand-rebuilds the
 * app_error_logs row shape, so it would stay GREEN if `PrismaErrorTransport`
 * stopped letting `context.source` win (the exact class `utils/logger.ts` was
 * already fixed once for) or if the sweep's `where` stopped admitting the new
 * source. This file closes both gaps with the real code and no re-implementation:
 *
 *   1. import the REAL logger (NOT mocked) with only its Prisma client stubbed,
 *      call recordClientError(), and assert the arguments the real
 *      PrismaErrorTransport hands `prisma.appErrorLog.create` — source column,
 *      message prefix, newline-preserving stack, bounded context;
 *   2. run the REAL runLogSignalSweepOnce with its DEFAULT rows seam and assert
 *      the `where` clause it sends to prisma.appErrorLog.findMany still admits
 *      `source: 'client-error'` (and still keeps NULL sources — the documented
 *      7b2990fa shape).
 */
const created: Array<Record<string, any>> = [];
const findManyArgs: Array<Record<string, any>> = [];

jest.mock('../../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test', PORT: 3000 },
}));
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    appErrorLog: {
      create: jest.fn(async ({ data }: any) => { created.push(data); return data; }),
      findMany: jest.fn(async (args: any) => { findManyArgs.push(args); return []; }),
      count: jest.fn(async () => 0),
    },
  },
}));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => 'OK'),
    incr: jest.fn(async () => 1),
    expire: jest.fn(async () => 1),
    decr: jest.fn(async () => 1),
    del: jest.fn(async () => 1),
    eval: jest.fn(async () => 1),
  },
}));
jest.mock('../../../modules/crossmodel/fleet/infra-watch.service', () => ({
  __esModule: true,
  adminFleetSupervisors: jest.fn(async () => []),
  deliver: jest.fn(async () => undefined),
}));
jest.mock('../feedback/feedback.service', () => ({
  __esModule: true,
  fileFeedbackTicket: jest.fn(async () => ({ error: 'test', message: 'not filed here' })),
  normalizeFeedbackTitle: (t: string) => t,
  wouldExactTitleDedupBump: jest.fn(async () => false),
}));

import { recordClientError } from './client-error.controller';
import { runLogSignalSweepOnce, LOG_SIGNAL_SELF_EXCLUDE_SOURCES } from '../fleet/log-signal-sweep.service';

/** The transport writes fire-and-forget via setImmediate — let the microtask/macrotask queue drain. */
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

beforeEach(() => { created.length = 0; findManyArgs.length = 0; });

/** Assembled, never literal — a token-shaped literal is a gitleaks hit in the public mirror. */
const providerKey = ['sk', 'proj', 'abcdefghijklmnop'].join('-');

describe('client error → app_error_logs through the REAL winston transport', () => {
  it('writes source "client-error" and the client-error: prefix (context.source WINS)', async () => {
    recordClientError({
      message: "TypeError: Cannot read properties of undefined (reading 'id')",
      stack: 'TypeError: x\n    at ChatRow (https://digby.ai/app.js:1:2)',
      url: `https://digby.ai/chat/abc?token=${providerKey}`,
      route: '/chat/abc',
      source: 'error-boundary',
      buildSha: 'd9ae52784f',
    });
    await flush();
    expect(created).toHaveLength(1);
    const row = created[0];
    // The COLUMN the sweep filters on. A stack-derived source would be the file
    // path here — the transport's context.source-wins rule is what makes the
    // whole feature work, and it is now pinned by a real write.
    expect(row.source).toBe('client-error');
    expect(row.level).toBe('error');
    expect(row.message).toContain('client-error:');
    expect(row.message).toContain('Cannot read properties of undefined');
    // The stack lands as its own column WITH newlines (review MAJOR 2), not
    // welded into the message and not collapsed to one line.
    expect(row.stack).toContain('\n');
    expect(row.stack).toContain('at ChatRow');
    // Context is the bounded, credential-free shape.
    expect(row.context.signature).toBeDefined();
    expect(row.context.clientSource).toBe('error-boundary');
    expect(row.context.buildSha).toBe('d9ae52784f');
    expect(row.context.url).toBe('https://digby.ai/chat/abc');
    expect(JSON.stringify(row)).not.toContain(providerKey);
  });

  it('the persisted row carries no unquoted user sentence (BLOCKER 1, end of the real chain)', async () => {
    const typed = 'my daughter has a dentist appointment on Thursday at 3pm';
    recordClientError({ message: `Error: ${typed}`, source: 'onerror' });
    await flush();
    expect(created).toHaveLength(1);
    const persisted = JSON.stringify(created[0]);
    expect(persisted).not.toContain('dentist');
    expect(persisted).not.toContain('Thursday');
    expect(persisted).toContain('<text>');
  });

  it('caps the message at the column bound the transport enforces', async () => {
    recordClientError({ message: 'TypeError: ' + 'a'.repeat(20_000), source: 'onerror' });
    await flush();
    expect(created).toHaveLength(1);
    expect(String(created[0].message).length).toBeLessThanOrEqual(10_000);
  });
});

describe('the sweep QUERY admits source "client-error" (real where clause, no re-implementation)', () => {
  it('fetchWindowRows asks for it — the OR-that-keeps-NULLs shape still includes our source', async () => {
    // Default rows seam (deps.fetchRows omitted) ⇒ the real fetchWindowRows runs.
    await runLogSignalSweepOnce({ now: new Date(), fileTicket: async () => null, enqueueDirectWake: async () => undefined } as never);
    await flush();
    expect(findManyArgs.length).toBeGreaterThanOrEqual(1);
    const where = findManyArgs[0].where;
    expect(where.level).toEqual({ in: ['warn', 'error'] });
    // 7b2990fa's shape: NULL sources are KEPT via the OR branch.
    expect(Array.isArray(where.OR)).toBe(true);
    expect(where.OR[0]).toEqual({ source: null });
    const notIn = where.OR[1].source.notIn as string[];
    // The pin that matters: this new producer is sweepable…
    expect(notIn).not.toContain('client-error');
    expect(LOG_SIGNAL_SELF_EXCLUDE_SOURCES).toEqual(notIn);
    // …and the exclusion list is still only the sweep's own source.
    expect(notIn).toEqual(['log-signal-sweep']);
  });
});