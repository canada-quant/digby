/**
 * utils/logger.ts `scrubCredentials` format (backlog audit T7, 2026-09-28) —
 * the LAST line of defence before the console + app_error_logs transports:
 * every record's message / stack / metadata string leaves lose URL-embedded
 * credentials and the winston Symbol keys survive (the record still reaches a
 * transport).
 * Built on a private winston logger + memory transport so the app's Prisma
 * transport is never touched. FAKE tokens only.
 */
import winston from 'winston';
import Transport from 'winston-transport';

// logger.ts reads the zod-validated env at import; the test process has none.
jest.mock('../config/env', () => ({ env: { NODE_ENV: 'test' } }));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { scrubCredentials } = require('./logger') as typeof import('./logger');

const FAKE_GHO = 'gho_' + 'FAKEfakeFAKEfakeFAKEfakeFAKEfake5678';
const AUTHED = `https://x-access-token:${FAKE_GHO}@github.com/canada-quant/repo.git`;

class MemoryTransport extends Transport {
  records: any[] = [];
  log(info: any, cb: () => void) {
    this.records.push(info);
    cb();
  }
}

function makeLogger() {
  const mem = new MemoryTransport({ level: 'warn' });
  const logger = winston.createLogger({
    level: 'debug',
    format: winston.format.combine(
      winston.format.errors({ stack: true }),
      scrubCredentials(),
      winston.format.json(),
    ),
    transports: [mem],
  });
  return { logger, mem };
}

describe('logger scrubCredentials format', () => {
  it('masks the token in the message and keeps the winston level symbol so the transport still fires', () => {
    const { logger, mem } = makeLogger();
    logger.warn(`coding workspace: mirror fetch failed for p1 (using cache): Command failed: git remote set-url origin ${AUTHED}\nerror: No such remote 'origin'`);
    expect(mem.records).toHaveLength(1);
    const rec = mem.records[0];
    expect(rec.message).not.toContain(FAKE_GHO);
    expect(rec.message).toContain('https://***@github.com/canada-quant/repo.git');
    expect(rec.message).toContain("No such remote 'origin'");
    expect(rec[Symbol.for('level')]).toBe('warn');
    expect(typeof rec[Symbol.for('message')]).toBe('string');
    expect(rec[Symbol.for('message')]).not.toContain(FAKE_GHO);
  });

  it('masks string leaves of the metadata and an Error stack', () => {
    const { logger, mem } = makeLogger();
    const err = new Error(`fatal: unable to access ${AUTHED}`);
    logger.error('mirror failed', { url: AUTHED, nested: { list: [AUTHED] }, err });
    const rec = mem.records[0];
    expect(rec.url).toBe('https://***@github.com/canada-quant/repo.git');
    expect(rec.nested.list[0]).not.toContain(FAKE_GHO);
    expect(JSON.stringify(rec)).not.toContain(FAKE_GHO);
  });

  it('a credential-free record is untouched', () => {
    const { logger, mem } = makeLogger();
    logger.warn('plain warning about https://github.com/canada-quant/repo.git', { a: 1 });
    expect(mem.records[0].message).toBe('plain warning about https://github.com/canada-quant/repo.git');
    expect(mem.records[0].a).toBe(1);
  });
});
