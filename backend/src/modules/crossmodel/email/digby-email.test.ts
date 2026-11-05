/**
 * Email as Digby (ticket 54f237bf) — email/digby-email.service.ts.
 *
 * Covers, per the ticket brief:
 *   - notConfigured (no env) → {ok:false} naming DIGBY_SMTP_USER/PASS, never throws
 *   - validation: garbage to / bad cc rejected, empty subject/text rejected,
 *     oversize subject rejected — garbage never reaches the transport
 *   - happy path with mocked nodemailer: from = DIGBY_SMTP_FROM, payload
 *     shape, messageId returned, loop metric recorded with the recipient
 *     PREFIX (never the full address, never the body)
 *   - rate limit: cap exceeded → clean error, no transport call
 *   - send failure → ok:false envelope, never a throw
 *   - tool registration pin: send_email_as_digby is in the agent tool lists
 *     (PLATFORM_TOOL_SCHEMA + CODING_TOOL_SCHEMA) + doctrine mentions it
 *
 * Mock boundaries: nodemailer (transport), loop-metrics (telemetry). The
 * service reads process.env lazily, so each case sets/clears the vars.
 */

const sendMail = jest.fn();
const closeFn = jest.fn();
jest.mock('nodemailer', () => ({
  __esModule: true,
  createTransport: jest.fn(() => ({ sendMail, close: closeFn })),
}));

const mockRecordLoopMetric = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { DIGBY_EMAIL_SENT: 'digby_email_sent' },
}));

// The service lazy-loads utils/logger (which pulls config/env → process.exit
// without env vars); mock the boundary, exactly like account-tools.test.ts.
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  sendDigbyEmail, isConfigured, digbyEmailConfig, isValidEmailAddress,
  DIGBY_EMAIL_HOURLY_CAP, __resetDigbyEmailRateLimitForTest,
} from './digby-email.service';

// ── Tool registration pin (ticket brief: "source-level assert like other tool
//    tests use"). Imported registry objects would drag platform-tools →
//    platform.service → config/env (process.exit without env vars) into this
//    suite's graph — the import-graph landmine account-tools.ts's header
//    documents — so the registration is pinned at the SOURCE level here; the
//    through-the-registry pins (PLATFORM_TOOL_SCHEMA + CODING_TOOL_SCHEMA +
//    tier membership) live in account-tools.test.ts, which has the scaffolding.
import { readFileSync } from 'fs';
import { join } from 'path';

function src(rel: string): string {
  return readFileSync(join(__dirname, rel), 'utf8');
}

const ENV_KEYS = ['DIGBY_SMTP_HOST', 'DIGBY_SMTP_PORT', 'DIGBY_SMTP_USER', 'DIGBY_SMTP_PASS', 'DIGBY_SMTP_FROM'] as const;

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}
function configureEnv(overrides: Record<string, string> = {}) {
  clearEnv();
  process.env.DIGBY_SMTP_USER = 'digby@digby.ai';
  process.env.DIGBY_SMTP_PASS = 'app-password-secret';
  Object.assign(process.env, overrides);
}

beforeEach(() => {
  jest.clearAllMocks();
  clearEnv();
  __resetDigbyEmailRateLimitForTest();
});

afterAll(clearEnv);

describe('digby-email.service — configuration', () => {
  it('no env → isConfigured false; digbyEmailConfig null', () => {
    expect(isConfigured()).toBe(false);
    expect(digbyEmailConfig()).toBeNull();
  });

  it('user set but pass missing (or vice versa) is still NOT configured', () => {
    process.env.DIGBY_SMTP_USER = 'digby@digby.ai';
    expect(isConfigured()).toBe(false);
    clearEnv();
    process.env.DIGBY_SMTP_PASS = 'x';
    expect(isConfigured()).toBe(false);
  });

  it('defaults: host smtp.gmail.com, port 587, from digby@digby.ai; env overrides win', () => {
    configureEnv();
    const cfg = digbyEmailConfig()!;
    expect(cfg).toMatchObject({ host: 'smtp.gmail.com', port: 587, user: 'digby@digby.ai', from: 'digby@digby.ai' });
    expect(cfg.pass).toBe('app-password-secret');

    configureEnv({ DIGBY_SMTP_HOST: 'smtp.example.com', DIGBY_SMTP_PORT: '465', DIGBY_SMTP_FROM: 'bot@digby.ai' });
    expect(digbyEmailConfig()).toMatchObject({ host: 'smtp.example.com', port: 465, from: 'bot@digby.ai' });
  });

  it('a garbage port falls back to 587, never NaN', () => {
    configureEnv({ DIGBY_SMTP_PORT: 'not-a-number' });
    expect(digbyEmailConfig()!.port).toBe(587);
  });
});

describe('digby-email.service — validation (never reaches the transport)', () => {
  it('garbage "to" is rejected without a transport call', async () => {
    configureEnv();
    for (const to of ['', 'not-an-email', 'a b@c.d', 'a@b', 'x@y,z', 'a@b.c,d@e.f', 'user@@digby.ai']) {
      const r = await sendDigbyEmail({ to, subject: 's', text: 'body' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/invalid recipient/i);
    }
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('a comma-separated recipient LIST is rejected — exactly one address per call', async () => {
    configureEnv();
    const r = await sendDigbyEmail({ to: 'a@b.c, d@e.f', subject: 's', text: 't' });
    expect(r.ok).toBe(false);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('bad cc is rejected', async () => {
    configureEnv();
    const r = await sendDigbyEmail({ to: 'a@b.c', cc: 'garbage', subject: 's', text: 't' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/invalid cc/i);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('empty subject / empty text / whitespace-only text are rejected', async () => {
    configureEnv();
    for (const input of [
      { to: 'a@b.c', subject: '', text: 't' },
      { to: 'a@b.c', subject: '   ', text: 't' },
      { to: 'a@b.c', subject: 's', text: '' },
      { to: 'a@b.c', subject: 's', text: '   ' },
    ]) {
      const r = await sendDigbyEmail(input);
      expect(r.ok).toBe(false);
      expect(sendMail).not.toHaveBeenCalled();
    }
  });

  it('oversize subject (201 chars) is rejected; the 200-char boundary passes validation', async () => {
    configureEnv();
    const r = await sendDigbyEmail({ to: 'a@b.c', subject: 'x'.repeat(201), text: 't' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/subject too long: 201/);
    expect(sendMail).not.toHaveBeenCalled();
    // boundary passes validation and reaches the (mocked) transport
    const ok = await sendDigbyEmail({ to: 'a@b.c', subject: 'x'.repeat(200), text: 't' });
    expect(ok.ok).toBe(true);
  });

  it('oversize text body (100_001 chars) is rejected', async () => {
    configureEnv();
    const r = await sendDigbyEmail({ to: 'a@b.c', subject: 's', text: 'x'.repeat(100_001) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/body too long: 100001/);
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe('digby-email.service — notConfigured path', () => {
  it('no env → clean ok:false naming BOTH env vars; nothing thrown, nothing sent', async () => {
    const r = await sendDigbyEmail({ to: 'a@b.c', subject: 's', text: 't' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('DIGBY_SMTP_USER');
      expect(r.error).toContain('DIGBY_SMTP_PASS');
      expect(r.error).toMatch(/not configured/i);
      expect(r.error).not.toMatch(/crash|throw/i);
    }
    expect(sendMail).not.toHaveBeenCalled();
    // telemetry recorded even on the unconfigured path
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'digby_email_sent',
      meta: expect.objectContaining({ outcome: 'not_configured' }),
    }));
  });

  it('isValidEmailAddress: true for real shapes, false for garbage', () => {
    expect(isValidEmailAddress('digby@digby.ai')).toBe(true);
    expect(isValidEmailAddress('first.last+tag@sub.example.co')).toBe(true);
    expect(isValidEmailAddress('nope')).toBe(false);
    expect(isValidEmailAddress('a@nodot')).toBe(false);
    expect(isValidEmailAddress('')).toBe(false);
    expect(isValidEmailAddress('a b@c.d')).toBe(false);
  });
});

describe('digby-email.service — happy path (mocked nodemailer)', () => {
  it('sends from DIGBY_SMTP_FROM with reply-to = DIGBY_SMTP_USER; returns the messageId', async () => {
    configureEnv({ DIGBY_SMTP_FROM: 'Digby <digby@digby.ai>' });
    sendMail.mockResolvedValueOnce({ messageId: '<abc-123@digby.ai>' });

    const r = await sendDigbyEmail(
      { to: 'owner@example.com', subject: 'Nightly report', text: 'All green.', cc: 'teammate@example.org' },
      { sessionId: 'sess-1' },
    );

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.messageId).toBe('<abc-123@digby.ai>');
      expect(r.from).toBe('Digby <digby@digby.ai>');
    }
    expect(sendMail).toHaveBeenCalledTimes(1);
    const payload = sendMail.mock.calls[0][0];
    expect(payload).toMatchObject({
      from: 'Digby <digby@digby.ai>',
      replyTo: 'digby@digby.ai',
      to: 'owner@example.com',
      cc: 'teammate@example.org',
      subject: 'Nightly report',
      text: 'All green.',
    });
    // telemetry: outcome sent + recipient PREFIX only (local part capped, domain kept)
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'digby_email_sent',
      sessionId: 'sess-1',
      meta: expect.objectContaining({
        outcome: 'sent',
        to: 'owner@example.com',
        cc: 'teammate@example.org',
        messageId: '<abc-123@digby.ai>',
        subjectChars: 14, // "Nightly report"
        textChars: 10,
      }),
    }));
  });

  it('long local parts are truncated to the 12-char prefix in telemetry (recipient privacy)', async () => {
    configureEnv();
    sendMail.mockResolvedValueOnce({ messageId: '<m-1@digby.ai>' });
    const long = 'averyveryverylonglocalpart'.repeat(2); // 54 chars before @
    await sendDigbyEmail({ to: `${long}@example.com`, subject: 's', text: 't' });
    const call = mockRecordLoopMetric.mock.calls.find((c) => c[0]?.meta?.outcome === 'sent')!;
    expect(call[0].meta.to).toBe(`${long.slice(0, 12)}@example.com`);
    expect(call[0].meta.to).not.toContain(long);
  });

  it('the body text NEVER appears in telemetry', async () => {
    configureEnv();
    sendMail.mockResolvedValueOnce({ messageId: '<m-2@digby.ai>' });
    const secret = 'TOPSECRETBODYCONTENT';
    await sendDigbyEmail({ to: 'a@b.c', subject: 's', text: secret });
    const recorded = JSON.stringify(mockRecordLoopMetric.mock.calls);
    expect(recorded).not.toContain(secret);
  });

  it('a transport failure becomes an ok:false envelope, never a throw', async () => {
    configureEnv();
    sendMail.mockRejectedValueOnce(new Error('550 mailbox unavailable'));
    const r = await sendDigbyEmail({ to: 'a@b.c', subject: 's', text: 't' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('550 mailbox unavailable');
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ outcome: 'send_failed' }),
    }));
  });
});

describe('digby-email.service — rate limit', () => {
  it(`${DIGBY_EMAIL_HOURLY_CAP} sends admitted, the ${DIGBY_EMAIL_HOURLY_CAP + 1}th → clean rate_limited error, no transport call`, async () => {
    configureEnv();
    sendMail.mockResolvedValue({ messageId: '<m@digby.ai>' });
    for (let i = 0; i < DIGBY_EMAIL_HOURLY_CAP; i++) {
      const r = await sendDigbyEmail({ to: 'a@b.c', subject: `s${i}`, text: 't' });
      expect(r.ok).toBe(true);
    }
    expect(sendMail).toHaveBeenCalledTimes(DIGBY_EMAIL_HOURLY_CAP);

    const blocked = await sendDigbyEmail({ to: 'a@b.c', subject: 'one too many', text: 't' });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.error).toMatch(/rate limit/i);
      expect(blocked.error).toContain(`${DIGBY_EMAIL_HOURLY_CAP}/hour`);
    }
    // the cap held: still exactly CAP transport calls
    expect(sendMail).toHaveBeenCalledTimes(DIGBY_EMAIL_HOURLY_CAP);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ outcome: 'rate_limited', cap: DIGBY_EMAIL_HOURLY_CAP }),
    }));
  });

  it('validation failures do NOT consume rate slots (garbage never eats the budget)', async () => {
    configureEnv();
    for (let i = 0; i < 5; i++) {
      await sendDigbyEmail({ to: 'garbage', subject: 's', text: 't' });
    }
    sendMail.mockResolvedValue({ messageId: '<m@digby.ai>' });
    const r = await sendDigbyEmail({ to: 'a@b.c', subject: 's', text: 't' });
    expect(r.ok).toBe(true); // still admitted — the 5 garbage calls took no slot
  });
});

// ── Tool registration pin (source-level: the tool is on BOTH agent surfaces
//    and the doctrine names it — the ticket's registration acceptance) ────────

describe('send_email_as_digby — registration (source-level pins)', () => {
  it('the tool name is registered in the account-tool names AND the platform names leaf (both agent surfaces)', () => {
    const accountTools = src('../platform/account-tools.ts');
    expect(accountTools).toContain("'send_email_as_digby'");
    const namesLeaf = src('../platform/platform-tool-names.ts');
    expect(namesLeaf).toContain("'send_email_as_digby'");
  });

  it('the schema entry exists with required to/subject/text and the anti-bulk doctrine', () => {
    const accountTools = src('../platform/account-tools.ts');
    expect(accountTools).toContain("name: 'send_email_as_digby'");
    expect(accountTools).toMatch(/never for mass\/bulk sends/);
    expect(accountTools).toMatch(/required: \['to', 'subject', 'text'\]/);
  });

  it('the capability doctrine names it next to the notify_user trigger row', () => {
    const doctrine = src('../chat-agent/capability-doctrine.ts');
    expect(doctrine).toContain('send_email_as_digby');
    // the trigger row sits in the same trigger table as notify_user
    expect(doctrine).toMatch(/email me when[\s\S]*send_email_as_digby/);
  });
});
