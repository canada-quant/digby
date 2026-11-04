/**
 * utils/logger.ts buildErrorLogContext (audit 2026-10-06 T8-6, crosscutting X6):
 * an UNDEFINED metadata value is skipped instead of stored as the literal
 * string "undefined" (every Fleet Supervisor tool-failure row carried
 * context.runId = "undefined", so `context->>'runId' IS NULL` missed them).
 * LOG_UNDEFINED_META_SKIP_DISABLED=1 restores the string.
 */
jest.mock('../config/env', () => ({ env: { NODE_ENV: 'test' } }));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildErrorLogContext } = require('./logger') as typeof import('./logger');

afterEach(() => { delete process.env.LOG_UNDEFINED_META_SKIP_DISABLED; });

describe('buildErrorLogContext (audit 2026-10-06 T8-6)', () => {
  it('skips undefined values; keeps null, strings, objects and Error summaries', () => {
    const err = new Error('boom');
    const ctx = buildErrorLogContext({ sessionId: 's1', runId: undefined, source: 'coding-agent', extra: null, nested: { a: 1, b: undefined }, err });
    expect(ctx).toEqual({ sessionId: 's1', source: 'coding-agent', extra: null, nested: { a: 1 }, err: { message: 'boom', stack: expect.any(String) } });
    expect('runId' in ctx).toBe(false);
  });

  it('an all-undefined metadata yields an empty context (the transport then stores none)', () => {
    expect(buildErrorLogContext({ runId: undefined })).toEqual({});
  });

  it('LOG_UNDEFINED_META_SKIP_DISABLED=1 stores the literal "undefined" (previous behaviour)', () => {
    process.env.LOG_UNDEFINED_META_SKIP_DISABLED = '1';
    expect(buildErrorLogContext({ runId: undefined })).toEqual({ runId: 'undefined' });
  });
});
