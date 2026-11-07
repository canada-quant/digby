/**
 * Terms of Service / Acceptable Use acceptance tests (Phase 2 Cloud leg 1
 * item 5, todo ea95fa0b).
 *
 * The behaviour that matters is the FAIL-SAFE shape, not the happy path:
 *  - enforcement OFF (the default) must never refuse a signup, because every
 *    pre-existing account has termsAcceptedAt = NULL and a hard requirement
 *    would lock the entire back catalogue out;
 *  - an acceptance we did not receive must never be FABRICATED — no timestamp
 *    is invented when the client did not tick the box;
 *  - a policy-read failure must fall back to OFF (availability), never ON.
 *
 * Hermetic: prisma + logger mocked (the org.service.test pattern). No DB.
 */

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    systemSetting: { findUnique: jest.fn() },
    user: { update: jest.fn() },
  },
}));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/env', () => ({ __esModule: true, env: {} }));

import prisma from '../../../config/database';
import {
  TERMS_VERSION,
  REQUIRE_TERMS_SETTING,
  termsAcceptanceRequired,
  evaluateTermsAcceptance,
  recordTermsAcceptance,
} from './terms.service';

const db = prisma as unknown as {
  systemSetting: { findUnique: jest.Mock };
  user: { update: jest.Mock };
};

function policy(value: string | null) {
  db.systemSetting.findUnique.mockResolvedValue(value === null ? null : { key: REQUIRE_TERMS_SETTING, value });
}

beforeEach(() => {
  jest.clearAllMocks();
  db.user.update.mockResolvedValue({});
});

describe('TERMS_VERSION', () => {
  it('is a stable date string, not a floating value', () => {
    // Stored as evidence on every acceptance row: it must be a literal that a
    // reviewer can diff against the /terms page, never a computed date.
    expect(TERMS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('termsAcceptanceRequired (the enforcement switch)', () => {
  it('defaults OFF when the setting row is absent', async () => {
    policy(null);
    await expect(termsAcceptanceRequired()).resolves.toBe(false);
  });

  it.each(['true', '1'])('treats %s as ON', async (value) => {
    policy(value);
    await expect(termsAcceptanceRequired()).resolves.toBe(true);
  });

  it.each(['false', '0', 'yes', ''])('treats %s as OFF', async (value) => {
    policy(value);
    await expect(termsAcceptanceRequired()).resolves.toBe(false);
  });

  it('falls back to OFF when the policy read throws (availability over enforcement)', async () => {
    // The failure mode of ON during a DB blip is refusing every new signup;
    // refusing to enforce for one request is the cheaper mistake.
    db.systemSetting.findUnique.mockRejectedValue(new Error('db down'));
    await expect(termsAcceptanceRequired()).resolves.toBe(false);
  });
});

describe('evaluateTermsAcceptance', () => {
  it('records an acceptance even while enforcement is OFF', async () => {
    // Evidence must exist before the owner flips the switch, otherwise the
    // first enforced day has no history behind it.
    policy(null);
    const decision = await evaluateTermsAcceptance(true);
    expect(decision).toMatchObject({ allowed: true, recorded: true, version: TERMS_VERSION });
  });

  it('ALLOWS a signup with no acceptance when enforcement is OFF (legacy posture)', async () => {
    policy(null);
    const decision = await evaluateTermsAcceptance(undefined);
    expect(decision.allowed).toBe(true);
    expect(decision.recorded).toBe(false);
    expect(decision.version).toBeNull();
  });

  it('REFUSES a signup with no acceptance when enforcement is ON', async () => {
    policy('true');
    const decision = await evaluateTermsAcceptance(undefined);
    expect(decision.allowed).toBe(false);
    expect(decision.recorded).toBe(false);
    expect(decision.message).toMatch(/Terms of Service/i);
  });

  it('refuses an explicit false under enforcement (ticking then unticking)', async () => {
    policy('true');
    await expect(evaluateTermsAcceptance(false)).resolves.toMatchObject({ allowed: false, recorded: false });
  });

  it('never fabricates acceptance: no-acceptance yields no version', async () => {
    policy('true');
    const decision = await evaluateTermsAcceptance(undefined);
    expect(decision.version).toBeNull();
  });
});

describe('recordTermsAcceptance', () => {
  it('stamps the timestamp AND the accepted version', async () => {
    await expect(recordTermsAcceptance('user-1', TERMS_VERSION)).resolves.toBe(true);
    const arg = db.user.update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 'user-1' });
    expect(arg.data.termsVersion).toBe(TERMS_VERSION);
    expect(arg.data.termsAcceptedAt).toBeInstanceOf(Date);
  });

  it('never throws — a bookkeeping failure must not fail a registration', async () => {
    db.user.update.mockRejectedValue(new Error('write failed'));
    await expect(recordTermsAcceptance('user-1', TERMS_VERSION)).resolves.toBe(false);
  });
});