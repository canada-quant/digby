/**
 * Email verification tests (Phase 2 Cloud, todo ea95fa0b leg 1 item 1).
 *
 * The security properties under test are the ones that would be invisible in
 * manual testing yet fatal in production:
 *  - the RAW token is never stored (a DB read cannot mint a link),
 *  - a token is single-use and short-lived,
 *  - a resend supersedes the earlier link,
 *  - enforcement is OFF by default so shipping this cannot lock out the entire
 *    pre-existing user base (every one of them has NULL emailVerifiedAt),
 *  - and a mail/URL failure never fails a signup that otherwise succeeded.
 *
 * Hermetic: prisma + logger + env + the mailer + instance-setup mocked.
 */

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    emailVerificationToken: { create: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn(), update: jest.fn() },
    user: { findUnique: jest.fn(), update: jest.fn() },
    systemSetting: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  },
}));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/env', () => ({ __esModule: true, env: {} }));

const mockSend = jest.fn();
jest.mock('../email/digby-email.service', () => ({
  __esModule: true,
  sendDigbyEmail: (...a: any[]) => mockSend(...a),
}));

let mockPublicUrl: string | null = 'https://digby.example';
jest.mock('../platform/instance-setup', () => ({
  __esModule: true,
  instancePublicUrl: () => mockPublicUrl,
}));

import { createHash } from 'crypto';
import prisma from '../../../config/database';
import { AppError } from '../../../middleware/app-error';
import {
  issueEmailVerification, consumeEmailVerification, resendEmailVerification,
  emailVerificationRequired, verificationLinkFor, VERIFICATION_TTL_MS,
  REQUIRE_VERIFICATION_SETTING, assertEmailVerifiedForSend, UNVERIFIED_SEND_MESSAGE,
  EmailVerificationRequiredError,
} from './email-verification.service';

const db = prisma as unknown as {
  emailVerificationToken: { create: jest.Mock; findUnique: jest.Mock; updateMany: jest.Mock; update: jest.Mock };
  user: { findUnique: jest.Mock; update: jest.Mock };
  systemSetting: { findUnique: jest.Mock };
  $transaction: jest.Mock;
};

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

beforeEach(() => {
  jest.clearAllMocks();
  mockPublicUrl = 'https://digby.example';
  db.emailVerificationToken.create.mockResolvedValue({});
  db.emailVerificationToken.updateMany.mockResolvedValue({ count: 0 });
  db.user.update.mockResolvedValue({});
  db.$transaction.mockResolvedValue([]);
  db.user.findUnique.mockResolvedValue({ email: 'paul@example.com', emailVerifiedAt: null, firstName: 'Paul' });
  mockSend.mockResolvedValue({ ok: true, messageId: 'm1', from: 'digby@digby.ai' });
});

describe('issueEmailVerification', () => {
  it('stores ONLY the sha256 of the token — never the raw value', async () => {
    await issueEmailVerification('user-1', 'paul@example.com');

    const stored = db.emailVerificationToken.create.mock.calls[0][0].data;
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    // The raw token exists only in the emailed link.
    const mailedBody: string = mockSend.mock.calls[0][0].text;
    const rawInLink = /token=([0-9a-f]+)/.exec(mailedBody)![1];
    expect(rawInLink).toHaveLength(64);
    expect(rawInLink).not.toBe(stored.tokenHash);
    // And its hash is what we stored — proving the pair without storing the raw.
    expect(sha256(rawInLink)).toBe(stored.tokenHash);
  });

  it('issues a 24-hour token', async () => {
    const before = Date.now();
    await issueEmailVerification('user-1', 'paul@example.com');
    const expires: Date = db.emailVerificationToken.create.mock.calls[0][0].data.expiresAt;
    expect(expires.getTime() - before).toBeGreaterThanOrEqual(VERIFICATION_TTL_MS - 5_000);
    expect(expires.getTime() - before).toBeLessThanOrEqual(VERIFICATION_TTL_MS + 5_000);
  });

  it('supersedes earlier live tokens so only the newest link works', async () => {
    await issueEmailVerification('user-1', 'paul@example.com');
    expect(db.emailVerificationToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1', consumedAt: null } }),
    );
  });

  it('emails a link built from the instance public URL', async () => {
    await issueEmailVerification('user-1', 'paul@example.com');
    expect(mockSend.mock.calls[0][0].to).toBe('paul@example.com');
    expect(mockSend.mock.calls[0][0].text).toContain('https://digby.example/verify-email?token=');
  });

  it('does not send a broken link when the instance has no public URL — and says so', async () => {
    mockPublicUrl = null;
    const r = await issueEmailVerification('user-1', 'paul@example.com');
    expect(r.mailed).toBe(false);
    expect(r.error).toContain('public URL');
    expect(mockSend).not.toHaveBeenCalled();
    // The token row still exists, so a later resend / manual path can work.
    expect(db.emailVerificationToken.create).toHaveBeenCalled();
  });

  it('never throws when the mailer fails — a signup must not fail on SMTP', async () => {
    mockSend.mockResolvedValue({ ok: false, error: 'smtp down' });
    const r = await issueEmailVerification('user-1', 'paul@example.com');
    expect(r.mailed).toBe(false);
    expect(r.error).toBe('smtp down');
  });
});

describe('consumeEmailVerification', () => {
  const liveToken = (raw: string, over: Record<string, unknown> = {}) => ({
    id: 'tok-1', userId: 'user-1', expiresAt: new Date(Date.now() + 60_000), consumedAt: null, tokenHash: sha256(raw), ...over,
  });

  it('marks the user verified and burns the token in ONE transaction', async () => {
    db.emailVerificationToken.findUnique.mockResolvedValue(liveToken('abc123'));

    const r = await consumeEmailVerification('abc123');

    expect(r).toEqual({ userId: 'user-1', alreadyVerified: false });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    // The token is marked consumed AND the user stamped — atomic with each other.
    expect(db.emailVerificationToken.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { consumedAt: expect.any(Date) } }),
    );
    expect(db.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { emailVerifiedAt: expect.any(Date) } }),
    );
  });

  it('looks the token up BY HASH (the raw value is never a query key)', async () => {
    db.emailVerificationToken.findUnique.mockResolvedValue(liveToken('abc123'));
    await consumeEmailVerification('abc123');
    expect(db.emailVerificationToken.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: sha256('abc123') } }),
    );
  });

  it('refuses an unknown token', async () => {
    db.emailVerificationToken.findUnique.mockResolvedValue(null);
    await expect(consumeEmailVerification('nope')).rejects.toThrow(/not valid/);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('refuses an EXPIRED token', async () => {
    db.emailVerificationToken.findUnique.mockResolvedValue(liveToken('abc123', { expiresAt: new Date(Date.now() - 1_000) }));
    await expect(consumeEmailVerification('abc123')).rejects.toThrow(/expired/);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('refuses a token already used while the account is still unverified', async () => {
    db.emailVerificationToken.findUnique.mockResolvedValue(liveToken('abc123', { consumedAt: new Date() }));
    await expect(consumeEmailVerification('abc123')).rejects.toThrow(/already been used/);
  });

  it('treats a repeat use as success once the account IS verified (idempotent, not confusing)', async () => {
    db.emailVerificationToken.findUnique.mockResolvedValue(liveToken('abc123', { consumedAt: new Date() }));
    db.user.findUnique.mockResolvedValue({ email: 'paul@example.com', emailVerifiedAt: new Date() });

    const r = await consumeEmailVerification('abc123');

    expect(r).toEqual({ userId: 'user-1', alreadyVerified: true });
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('rejects a blank token before touching the database', async () => {
    await expect(consumeEmailVerification('   ')).rejects.toThrow(/required/);
    expect(db.emailVerificationToken.findUnique).not.toHaveBeenCalled();
  });
});

describe('emailVerificationRequired (the enforcement policy)', () => {
  it('defaults to OFF when the setting is absent — this is what protects every existing account', async () => {
    db.systemSetting.findUnique.mockResolvedValue(null);
    await expect(emailVerificationRequired()).resolves.toBe(false);
  });

  it('is ON only for an explicit true/1', async () => {
    db.systemSetting.findUnique.mockResolvedValue({ key: REQUIRE_VERIFICATION_SETTING, value: 'true' });
    await expect(emailVerificationRequired()).resolves.toBe(true);
    db.systemSetting.findUnique.mockResolvedValue({ key: REQUIRE_VERIFICATION_SETTING, value: '1' });
    await expect(emailVerificationRequired()).resolves.toBe(true);
  });

  it('falls back to OFF (never lock everyone out) when the policy cannot be read', async () => {
    db.systemSetting.findUnique.mockRejectedValue(new Error('db down'));
    await expect(emailVerificationRequired()).resolves.toBe(false);
  });
});

/**
 * THE GATE IS GONE (owner directive 2026-11-07T06:40Z: "we dont want to limit
 * usage by email verfication at all … people need to freely use digby.ai logged
 * in or not").
 *
 * The block that used to live here asserted a 403 for an unverified account under
 * policy ON. That behaviour is deliberately REMOVED, so these tests now assert the
 * opposite property in the strongest available form: the call reads NOTHING (no
 * policy row, no user row) and never throws — whatever the setting says, whichever
 * way the user row is shaped, and even when the database is down. A regression
 * that quietly restores the read fails on every one of them.
 */
describe('assertEmailVerifiedForSend — PERMANENT NO-OP (owner 2026-11-07T06:40Z)', () => {
  it('never reads the policy row or the user row', async () => {
    await expect(assertEmailVerifiedForSend('user-1')).resolves.toBeUndefined();
    expect(db.systemSetting.findUnique).not.toHaveBeenCalled();
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it('still allows the send when the setting says ON and the account is UNVERIFIED (the exact case that used to 403)', async () => {
    db.systemSetting.findUnique.mockResolvedValue({ key: REQUIRE_VERIFICATION_SETTING, value: 'true' });
    db.user.findUnique.mockResolvedValue({ emailVerifiedAt: null });

    await expect(assertEmailVerifiedForSend('user-1')).resolves.toBeUndefined();

    // Nothing was consulted, so no setting row can revive the gate.
    expect(db.systemSetting.findUnique).not.toHaveBeenCalled();
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it('allows a MISSING user row and an unreadable database alike (it cannot throw)', async () => {
    db.user.findUnique.mockResolvedValue(null);
    db.systemSetting.findUnique.mockRejectedValue(new Error('db down'));
    await expect(assertEmailVerifiedForSend('ghost')).resolves.toBeUndefined();
  });

  it('the typed error still exists and is recognizable, but nothing throws it any more', async () => {
    // Kept exported for compatibility (chat-agent.service.ts matches it by name;
    // existing callers import it). Pinned so a "delete the dead class" refactor
    // does not break those imports — and pinned NO-OP in the same breath.
    const err = new EmailVerificationRequiredError();
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(EmailVerificationRequiredError);
    expect(err.name).toBe('EmailVerificationRequiredError');
    expect(err.statusCode).toBe(403);
    expect(err.message).toBe(UNVERIFIED_SEND_MESSAGE);

    db.systemSetting.findUnique.mockResolvedValue({ key: REQUIRE_VERIFICATION_SETTING, value: 'true' });
    db.user.findUnique.mockResolvedValue({ emailVerifiedAt: null });
    await expect(assertEmailVerifiedForSend('user-1')).resolves.toBeUndefined();
  });
});

describe('resendEmailVerification', () => {
  it('re-issues for an unverified user', async () => {
    const r = await resendEmailVerification('user-1');
    expect(r.mailed).toBe(true);
    expect(mockSend).toHaveBeenCalled();
  });

  it('refuses when the address is already verified', async () => {
    db.user.findUnique.mockResolvedValue({ email: 'paul@example.com', emailVerifiedAt: new Date() });
    await expect(resendEmailVerification('user-1')).rejects.toThrow(/already verified/);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('verificationLinkFor', () => {
  it('encodes the token into the frontend route', () => {
    expect(verificationLinkFor('a b')).toBe('https://digby.example/verify-email?token=a%20b');
  });
  it('returns null without a public URL rather than a relative/broken link', () => {
    mockPublicUrl = null;
    expect(verificationLinkFor('x')).toBeNull();
  });
});