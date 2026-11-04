/**
 * Ticket 17d64418 finding (d) — the fail-OPEN-on-unreadable branch of
 * credentialLifted has NO test pin. It is the riskiest conditional introduced
 * by the PR #1877 review (finding 4): a row whose value cannot be decrypted
 * (a legacy row, a JWT_SECRET rotation, corrupt ciphertext) BYPASSES slot
 * validation and lifts the gate — deliberately, so a key rotation can never
 * wedge every credential gate shut. Unpinned, a future edit could flip it to
 * fail-closed (silently wedging every gate after a secret rotation) or widen
 * it to skip validation for READABLE rows too (re-opening the corrupt-row
 * lift the incident fixed).
 *
 * This suite pins the full credentialLifted decision table:
 *   receipt leg      → lifted via 'receipt' (checked first)
 *   readable + slot-mismatched → NOT lifted + the observability warn
 *   readable + fitting value    → lifted via 'store'
 *   UNREADABLE value            → lifted via 'store'  ← THE (d) PIN
 *   no row / query error        → fail-closed
 * Plus the 17d64418 (c) interplay: a label-suffixed key-ID slot
 * (AWS_ACCESS_KEY_ID_DIGBYOPERATOR — family null before (c)) now
 * slot-validates too, so a 40-char secret in it keeps the gate shut.
 *
 * Harness: credentialLifted takes prisma as an ARGUMENT (stub per test); the
 * dynamic import of ../coding/credentials.service inside it pulls
 * config/database — mocked here (the c97f78b3 config-boundary rule: every
 * requireActual/dynamic import into a non-pure leaf needs its config mocks
 * beside it or the worker dies before a test runs).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {},
}));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { credentialLifted } from './credential-gate';
import { encryptValue } from '../coding/credentials.service';
import logger from '../../../utils/logger';

/** Fake AWS pair — structurally valid shapes only, never real credentials
 *  (the 7caf07ed fixture convention: assembled from parts; the leading '/'
 *  makes the secret exactly 40 base64 chars). */
const ACCESS_KEY_ID = ['AKIA', 'QWERTYUIOP123456'].join('');
const SECRET_VALUE = '/' + ['fLnGw229n89c5Ufq', 'Zvrx9xwDLyaVz328', 'LAqYLz9'].join('');
/** Corrupt ciphertext — valid base64, not a real AES-GCM blob (auth tag
 *  check fails inside decryptValue): the "unreadable row" class. */
const CORRUPT_VALUE_ENC = Buffer.from('not-actual-ciphertext').toString('base64');

const row = (envKey: string, valueEnc: string) => ({
  id: `cred-${envKey}`, envKey, valueEnc, label: '', userId: 'u1', provider: 'custom',
});

const stubPrisma = (opts: { receipt?: unknown; stored?: unknown; storedThrows?: boolean } = {}) => ({
  runToolReceipt: { findFirst: async () => opts.receipt ?? null },
  codingCredential: { findFirst: async () => {
    if (opts.storedThrows) throw new Error('db down');
    return opts.stored ?? null;
  } },
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.CODING_CRED_SLOT_VALIDATION_DISABLED;
});

describe('ticket 17d64418 (d) — credentialLifted decision table (the unpinned fail-open branch)', () => {
  it('(d) THE PIN (review N2-tightened, branch-shaped): an UNREADABLE value on a SECRET-FAMILY slot fail-OPENS — legibility alone lifts, on every slot family', async () => {
    // A corrupt/undecryptable row bypasses slot validation BY DESIGN (review
    // finding 4 of PR #1877): a JWT_SECRET rotation must never wedge every
    // credential gate shut. The slot is deliberately SECRET-family — the
    // paired control below (same slot, READABLE mismatched value) does NOT
    // lift, so legibility is the ONLY difference between the two rows: this
    // pin fails if the fail-open is ever conditioned on the slot family, or
    // flipped to fail-closed. (A family-null slot like SOME_API_KEY lifts on
    // ANY value, so it cannot distinguish the branch — review N2.)
    const r = await credentialLifted(stubPrisma({ stored: row('CANLAW_CPT_S3_SECRET_ACCESS_KEY', CORRUPT_VALUE_ENC) }), 'u1', 'CANLAW_CPT_S3_SECRET_ACCESS_KEY');
    expect(r).toEqual({ lifted: true, via: 'store' });
  });

  it('(d) same branch under a ROTATED secret: a row encrypted under the old JWT_SECRET still lifts (the documented rotation posture)', async () => {
    const oldSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'a-different-secret-rotation-32-chars!!';
    const valueEnc = encryptValue(SECRET_VALUE); // encrypted under the NEW secret
    process.env.JWT_SECRET = oldSecret; // ... read under the OLD one → undecryptable
    const r = await credentialLifted(stubPrisma({ stored: row('SOME_API_KEY', valueEnc) }), 'u1', 'SOME_API_KEY');
    expect(r).toEqual({ lifted: true, via: 'store' });
    expect(process.env.JWT_SECRET).toBe(oldSecret);
  });

  it('the fail-open does NOT extend to READABLE slot-mismatched rows: the corrupt-capture shape (AKIA id in a SECRET slot) keeps the gate SHUT and warns', async () => {
    // The exact 18:25Z incident shape — the pinned complement of (d): only
    // LEGIBILITY buys the open; a readable wrong-slot value never does.
    const r = await credentialLifted(stubPrisma({ stored: row('CANLAW_CPT_S3_SECRET_ACCESS_KEY', encryptValue(ACCESS_KEY_ID)) }), 'u1', 'CANLAW_CPT_S3_SECRET_ACCESS_KEY');
    expect(r).toEqual({ lifted: false, via: null });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('slot-mismatches its envKey'));
  });

  it('the healthy control: a readable, slot-fitting store row lifts via store', async () => {
    const r = await credentialLifted(stubPrisma({ stored: row('CANLAW_CPT_S3_SECRET_ACCESS_KEY', encryptValue(SECRET_VALUE)) }), 'u1', 'CANLAW_CPT_S3_SECRET_ACCESS_KEY');
    expect(r).toEqual({ lifted: true, via: 'store' });
  });

  it('(c) interplay: a label-suffixed key-ID slot (AWS_ACCESS_KEY_ID_DIGBYOPERATOR — family null before 17d64418 (c)) now slot-validates: a 40-char secret in it keeps the gate SHUT', async () => {
    const r = await credentialLifted(stubPrisma({ stored: row('AWS_ACCESS_KEY_ID_DIGBYOPERATOR', encryptValue(SECRET_VALUE)) }), 'u1', 'AWS_ACCESS_KEY_ID_DIGBYOPERATOR');
    expect(r).toEqual({ lifted: false, via: null });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('AWS_ACCESS_KEY_ID_DIGBYOPERATOR'));
  });

  it('the receipt leg wins and is checked first: an ok store_secret receipt lifts via receipt (no store query needed)', async () => {
    const prisma = {
      runToolReceipt: { findFirst: async () => ({ id: 'r1', createdAt: new Date() }) },
      codingCredential: { findFirst: async () => { throw new Error('must not be reached'); } },
    };
    const r = await credentialLifted(prisma, 'u1', 'SOME_API_KEY');
    expect(r).toEqual({ lifted: true, via: 'receipt' });
  });

  it('no receipt, no row → fail-closed (the documented read posture)', async () => {
    const r = await credentialLifted(stubPrisma(), 'u1', 'SOME_API_KEY');
    expect(r).toEqual({ lifted: false, via: null });
  });

  it('a store-query error fail-closes (a probe hiccup keeps the gate shut — the sweeper re-checks)', async () => {
    const r = await credentialLifted(stubPrisma({ storedThrows: true }), 'u1', 'SOME_API_KEY');
    expect(r).toEqual({ lifted: false, via: null });
  });

  it('empty inputs never lift', async () => {
    expect(await credentialLifted(stubPrisma(), 'u1', '')).toEqual({ lifted: false, via: null });
    expect(await credentialLifted(stubPrisma(), '', 'SOME_API_KEY')).toEqual({ lifted: false, via: null });
  });
});
