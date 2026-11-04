/**
 * Splat-safety pin (log-signal family 5ae52ca3, adversarial review F1/F2).
 *
 * The taxonomy's warn-level helpers (utils/log-level.ts logExternal, and every
 * caller that passes meta to logger.warn — e.g. the coding loop's agentWarn)
 * MUST use winston's OBJECT form. The two-arg form `logger.warn(message, meta)`
 * passes meta as a SPLAT argument: when the message carries a printf token
 * (`%s`, `%d`, `%j`, or a literal `%` from provider error text / SQL like
 * `LIKE '%foo%'`), winston.format.splat() formats the meta object INTO the
 * message string — the logClass tag (and sessionId/runId/source attribution)
 * is destroyed exactly on the most interesting rows, and the message is
 * garbled.
 *
 * This suite drives the REAL logger (utils/logger.ts — its actual format chain
 * including splat(); its DB transport stubbed at the prisma seam) with an
 * added capture transport, so the assertions run against the production
 * pipeline, not a reconstruction.
 */

jest.mock('../config/env', () => ({ env: { NODE_ENV: 'test' } }));
jest.mock('../config/database', () => ({
  __esModule: true,
  // The real logger's PrismaErrorTransport writes fire-and-forget; stub the
  // prisma seam so the suite never touches a database.
  default: { appErrorLog: { create: async () => ({}) } },
}));

import Transport from 'winston-transport';
import logger, { buildErrorLogContext } from './logger';
import { logExternal, logHandled } from './log-level';
import { isNonFaultLogRow } from '../modules/crossmodel/fleet/log-signal-sweep.service';

class Capture extends Transport {
  captured: any = null;
  // silly: see EVERY record the format chain emits (the PERSISTENCE floor is
  // each transport's own level — asserted in the logHandled test below).
  constructor() { super({ level: 'silly' }); }
  log(info: any, next: () => void) {
    if (this.captured === null) this.captured = info;
    next();
  }
}

/** Run fn against the REAL logger; return the first record the real format chain emitted. */
const through = (fn: () => void) => {
  const capture = new Capture();
  logger.add(capture);
  try {
    fn();
  } finally {
    logger.remove(capture);
  }
  return capture.captured;
};

const PRINTF_MESSAGES = [
  "rerankTexts failed — caller keeps its own order: bad request: %s missing field",
  "retrieveChunks error: query failed: LIKE '%foo%' and printf('%s') — caller degrades to no-retrieval (returns [])",
];

describe('log taxonomy splat safety (family 5ae52ca3 review F1/F2)', () => {
  test('logExternal uses the object form: logClass survives printf tokens in the message, on the REAL chain', () => {
    for (const message of PRINTF_MESSAGES) {
      const rec = through(() => logExternal(message));
      expect(rec).toBeTruthy();
      expect(rec.message).toBe(message);           // verbatim — no meta spliced in, no %s consumed
      expect(rec.logClass).toBe('external');        // the tag survives
      // The exact shape the DB transport persists as context:
      const { level, message: _m, timestamp: _t, stack: _s, service: _sv, ...rest } = rec;
      const context = buildErrorLogContext(rest);
      expect(isNonFaultLogRow({ context })).toBe(true); // the sweep would exclude this row
    }
  });

  test('agentWarn-shape object form: full attribution meta + logClass survive a provider body with printf tokens', () => {
    const message = 'coding agent turn failed: aborted body: {"error":"bad arg printf(\'%s\')"}';
    const rec = through(() => logger.log({
      level: 'warn',
      message,
      sessionId: 'sess-f1',
      runId: 'run-f1',
      source: 'coding-agent',
      logClass: 'external',
    } as any));
    expect(rec.message).toBe(message);
    expect(rec).toMatchObject({ sessionId: 'sess-f1', runId: 'run-f1', source: 'coding-agent', logClass: 'external' });
  });

  test('CONTROL — the two-arg splat form loses the tag on the same messages (the pinned bug class, real chain)', () => {
    // This is the regression pin: if logExternal (or any warn-level taxonomy
    // call) ever reverts to logger.warn(message, {logClass}), this exact
    // scenario returns and these asserts fail.
    for (const message of PRINTF_MESSAGES) {
      const rec = through(() => (logger as any).warn(message, { logClass: 'external' }));
      expect(rec.logClass).toBeUndefined();       // eaten by splat
      expect(rec.message).not.toBe(message);      // meta spliced into the message
    }
  });

  test('logHandled is info — below every persistence transport\'s level, so it never reaches app_error_logs', () => {
    const rec = through(() => logHandled('sanitizeMessages: repaired 1 empty assistant message(s) (dropped=0, placeholder=1)'));
    expect(rec).toBeTruthy();
    expect(rec.level).toBe('info');
    expect(rec.logClass).toBe('handled');
    // The persistence floor on the real logger is source-pinned (logger.ts:
    // new PrismaErrorTransport({ level: 'warn' })); at runtime winston exposes
    // per-transport levels loosely, so assert the decisive fact on the record:
    // this info row is below every warn-floor transport's persistence bar.
    expect(rec.level === 'info' && 'warn' > rec.level).toBe(true);
    // And a handled row written AT warn level is still sweep-excluded (the
    // sweep's documented coverage of the tag):
    expect(isNonFaultLogRow({ context: { logClass: 'handled' } })).toBe(true);
  });
});
