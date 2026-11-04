/**
 * Ticket 17d64418 finding (c) — the isAwsKeyIdSlot/isAwsSecretSlot EDGE cases
 * the adversarial review of PR #1877 named, unpinned until now:
 *
 *  1. S3_BUCKET_KEY / MY_AWS_KEY classified as KEY-ID slots under the old
 *     "any AWS/S3 word + any KEY/ACCESS_KEY tail" rule — a genuine 40-char
 *     non-AWS secret (a Cohere key, an HMAC secret) was REFUSED there with a
 *     nonsense sibling name, the same over-block class as review finding B1.
 *  2. S3_SECRET_KEY_2 measured family NULL (the SECRET_KEY$ anchor missed a
 *     numeric suffix) — a LABELED secret slot had no pair protection: a 20-char
 *     AKIA key ID stored under it unrefused.
 *
 * The tightened rule (17d64418 (c)): the KEY-ID direction requires an explicit
 * ACCESS_KEY_ID tail (label suffixes included), the legacy AWS_ACCESS_KEY
 * tail, or an S3-QUALIFIED S3_KEY/S3_ACCESS_KEY tail; the SECRET anchor
 * admits a trailing numeric suffix. Every corridor pin stays put
 * (CANLAW_CPT_S3_KEY stays key-id — the 7caf07ed A8/ADDENDUM D pins).
 *
 * Runs against the REAL credentials.service (the 20fa94da harness pattern:
 * config/database mocked, real secret-scan/derive logic).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const db: any[] = [];
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    codingCredential: {
      findMany: jest.fn(async ({ where }: any) => db.filter(r => r.userId === where.userId)),
      findFirst: jest.fn(async ({ where }: any) =>
        db.filter(r => Object.entries(where).every(([k, v]) => r[k] === v))
          .sort((a, b) => +b.updatedAt - +a.updatedAt)[0] || null),
      findUnique: jest.fn(async ({ where }: any) => {
        const w = where.userId_envKey_label;
        return db.find(r => r.userId === w.userId && r.envKey === w.envKey && (r.label ?? '') === w.label) || null;
      }),
      count: jest.fn(async ({ where }: any) => db.filter(r => r.userId === where.userId).length),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const w = where.userId_envKey_label;
        const i = db.findIndex(r => r.userId === w.userId && r.envKey === w.envKey && (r.label ?? '') === w.label);
        if (i >= 0) { db[i] = { ...db[i], ...update, updatedAt: new Date() }; return db[i]; }
        const row = { id: `c${db.length + 1}`, createdAt: new Date(), updatedAt: new Date(), ...create };
        db.push(row); return row;
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        const before = db.length;
        for (let i = db.length - 1; i >= 0; i--) if (db[i].id === where.id && db[i].userId === where.userId) db.splice(i, 1);
        return { count: before - db.length };
      }),
    },
  },
}));

import { upsertCredential, valueSlotMismatch, awsSlotFamily } from './credentials.service';

// FAKE fixtures — structurally valid shapes only, never real credentials.
const ACCESS_KEY_ID = ['AKIA', 'QWERTYUIOP123456'].join('');
// 40 base64 chars — the leading '/' is the corridor convention (a 40-char
// AWS secret shape; the 7caf07ed fixture uses the same leading-slash form).
const SECRET_VALUE = '/' + ['fLnGw229n89c5Ufq', 'Zvrx9xwDLyaVz328', 'LAqYLz9'].join('');

beforeEach(() => { db.length = 0; delete process.env.CODING_CRED_SLOT_VALIDATION_DISABLED; });

describe('ticket 17d64418 (c) — isAwsKeyIdSlot edges: no more key-ID classification for AWS-word + KEY-tail slots', () => {
  it('S3_BUCKET_KEY is NOT a key-ID slot — a genuine 40-char non-AWS secret stores unrefused (the review\'s exact edge)', async () => {
    // Pre-fix: isAwsKeyIdSlot fired (an `S3` word + a `_KEY` tail) and a real
    // 40-char HMAC/Cohere secret was refused with a nonsense sibling name.
    await upsertCredential('u1', 'custom', 'S3_BUCKET_KEY', SECRET_VALUE);
    expect(db).toHaveLength(1);
    expect(awsSlotFamily('S3_BUCKET_KEY')).toBeNull();
    expect(valueSlotMismatch('S3_BUCKET_KEY', SECRET_VALUE)).toBeNull();
  });

  it('MY_AWS_KEY is NOT a key-ID slot — a genuine 40-char secret stores unrefused (a bare AWS word is not the idiom)', async () => {
    await upsertCredential('u1', 'custom', 'MY_AWS_KEY', SECRET_VALUE);
    expect(db).toHaveLength(1);
    expect(awsSlotFamily('MY_AWS_KEY')).toBeNull();
  });

  it('generic *_KEY slots stay OUTSIDE the rule (OPENAI_API_KEY, COHERE_API_KEY, SSH_KEY, ENCRYPTION_KEY) — 40-char values store', async () => {
    for (const k of ['OPENAI_API_KEY', 'COHERE_API_KEY', 'SSH_KEY', 'ENCRYPTION_KEY', 'TURSO_DATABASE_KEY']) {
      expect(awsSlotFamily(k)).toBeNull();
      await upsertCredential('u1', 'custom', k, SECRET_VALUE);
    }
    expect(db).toHaveLength(5);
  });

  it('the corridor pin holds: CANLAW_CPT_S3_KEY stays a key-ID slot — a 40-char secret is refused with the sibling named', async () => {
    expect(awsSlotFamily('CANLAW_CPT_S3_KEY')).toBe('key-id');
    await expect(upsertCredential('u1', 'custom', 'CANLAW_CPT_S3_KEY', SECRET_VALUE))
      .rejects.toThrow(/SECRET ACCESS KEY.*CANLAW_CPT_S3_SECRET_ACCESS_KEY/s);
    expect(db).toHaveLength(0);
  });

  it('explicit ACCESS_KEY_ID tails stay key-ID slots — with AND without a trailing label suffix', async () => {
    expect(awsSlotFamily('AWS_ACCESS_KEY_ID')).toBe('key-id');
    expect(awsSlotFamily('AWS_ACCESS_KEY_ID_DIGBYOPERATOR')).toBe('key-id'); // family null before (c)
    expect(awsSlotFamily('CANLAW_CPT_S3_ACCESS_KEY_ID')).toBe('key-id');
    for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_ACCESS_KEY_ID_DIGBYOPERATOR', 'CANLAW_CPT_S3_ACCESS_KEY_ID']) {
      await expect(upsertCredential('u1', 'custom', k, SECRET_VALUE)).rejects.toThrow(/look swapped/);
    }
    expect(db).toHaveLength(0);
  });

  it('the legacy AWS_ACCESS_KEY tail stays a key-ID slot (minio-style) — a 40-char secret is refused', async () => {
    expect(awsSlotFamily('MINIO_AWS_ACCESS_KEY')).toBe('key-id');
    await expect(upsertCredential('u1', 'custom', 'MINIO_AWS_ACCESS_KEY', SECRET_VALUE))
      .rejects.toThrow(/look swapped/);
    expect(db).toHaveLength(0);
  });

  it('the S3_ACCESS_KEY tail stays a key-ID slot — a 40-char secret is refused', async () => {
    expect(awsSlotFamily('BACKUP_S3_ACCESS_KEY')).toBe('key-id');
    await expect(upsertCredential('u1', 'custom', 'BACKUP_S3_ACCESS_KEY', SECRET_VALUE))
      .rejects.toThrow(/look swapped/);
    expect(db).toHaveLength(0);
  });
});

describe('ticket 17d64418 (c) — isAwsSecretSlot edges: numeric-suffixed secret slots get pair protection', () => {
  it('S3_SECRET_KEY_2 is a SECRET slot — an AKIA key ID in it is REFUSED (family null before (c): no pair protection)', async () => {
    expect(awsSlotFamily('S3_SECRET_KEY_2')).toBe('secret'); // was null pre-fix
    await expect(upsertCredential('u1', 'custom', 'S3_SECRET_KEY_2', ACCESS_KEY_ID))
      .rejects.toThrow(/ACCESS KEY ID.*S3_ACCESS_KEY_ID_2/s);
    expect(db).toHaveLength(0);
  });

  it('the derived sibling preserves the suffix (S3_SECRET_KEY_2 → S3_ACCESS_KEY_ID_2) — and the secret-half still stores fine there', async () => {
    const msg = valueSlotMismatch('S3_SECRET_KEY_2', ACCESS_KEY_ID);
    expect(msg).toContain('S3_ACCESS_KEY_ID_2');
    // the byte-fidelity control: the SECRET half stores unrefused in its own slot
    await upsertCredential('u1', 'custom', 'S3_SECRET_KEY_2', SECRET_VALUE);
    expect(db).toHaveLength(1);
  });

  it('label-suffixed SECRET_ACCESS_KEY slots are secret slots with suffix-preserving siblings (AWS_SECRET_ACCESS_KEY_DIGBYOPERATOR)', async () => {
    expect(awsSlotFamily('AWS_SECRET_ACCESS_KEY_DIGBYOPERATOR')).toBe('secret');
    const msg = valueSlotMismatch('AWS_SECRET_ACCESS_KEY_DIGBYOPERATOR', ACCESS_KEY_ID);
    expect(msg).toContain('AWS_ACCESS_KEY_ID_DIGBYOPERATOR'); // suffix rides along
    await expect(upsertCredential('u1', 'custom', 'AWS_SECRET_ACCESS_KEY_DIGBYOPERATOR', ACCESS_KEY_ID))
      .rejects.toThrow(/look swapped/);
    await upsertCredential('u1', 'custom', 'AWS_SECRET_ACCESS_KEY_DIGBYOPERATOR', SECRET_VALUE);
    expect(db).toHaveLength(1);
  });

  it('WORD label suffixes also get pair protection (S3_SECRET_KEY_CQL — a labeled secret slot is still the secret half)', async () => {
    // The ticket's "a labeled slot has no pair protection" complaint covers
    // LABEL suffixes (CQL), not just ordinals (_2): any trailing _-segment
    // after SECRET/SECRET_KEY keeps the secret classification.
    expect(awsSlotFamily('S3_SECRET_KEY_CQL')).toBe('secret');
    expect(awsSlotFamily('S3_SECRET_KEY_2')).toBe('secret');
  });

  it('bare SECRET/SECRET_KEY endings stay secret slots (regression: the pre-(c) anchors)', async () => {
    expect(awsSlotFamily('MY_SECRET')).toBe('secret');
    expect(awsSlotFamily('DB_SECRET_KEY')).toBe('secret');
    expect(awsSlotFamily('AWS_SECRET_ACCESS_KEY')).toBe('secret');
    await expect(upsertCredential('u1', 'custom', 'MY_SECRET', ACCESS_KEY_ID))
      .rejects.toThrow(/look swapped/);
  });

  it('the sibling derivation: MY_SECRET derives MY_ACCESS_KEY_ID (suffix-preserving, better than the old generic advice)', async () => {
    const msg = valueSlotMismatch('MY_SECRET', ACCESS_KEY_ID);
    expect(msg).toContain('MY_ACCESS_KEY_ID'); // pre-(c): the generic "the *_ACCESS_KEY_ID slot"
    expect(msg).toContain('MY_SECRET');
  });

  it('the generic fallback survives only for pathological shapes (a SECRET_ACCESS_KEY substring inside a larger word): never a mangled name', () => {
    // MYSECRET_ACCESS_KEY contains the tail but has no _-anchored tail
    // segment — no sibling is derivable, so the refusal keeps the generic
    // advice rather than inventing a mangled slot name.
    expect(awsSlotFamily('MYSECRET_ACCESS_KEY')).toBe('secret');
    const msg = valueSlotMismatch('MYSECRET_ACCESS_KEY', ACCESS_KEY_ID);
    expect(msg).toContain('the *_ACCESS_KEY_ID slot');
    expect(msg).not.toMatch(/under [A-Z0-9_]*ACCESS_KEY_ID_[A-Z0-9_]+ and/); // no mangled specific name
  });

  it('kill switch still restores accept-anything (CODING_CRED_SLOT_VALIDATION_DISABLED=1)', async () => {
    process.env.CODING_CRED_SLOT_VALIDATION_DISABLED = '1';
    await upsertCredential('u1', 'custom', 'CANLAW_CPT_S3_KEY', SECRET_VALUE);
    await upsertCredential('u1', 'custom', 'S3_SECRET_KEY_2', ACCESS_KEY_ID);
    expect(db).toHaveLength(2);
  });
});

describe('ticket 17d64418 (c) — the router keeps the 7caf07ed pins (family classifier is shared)', () => {
  it('a secret-family label on a KEY-declared card is still an anti-signal in the vault router (awsSlotFamily unchanged where it was already correct)', () => {
    // The vault router's fitScore uses awsSlotFamily on both the declared slot
    // and the label family. The corridor shapes are pinned in the 7caf07ed
    // replay; here we pin the classifier's decision table directly.
    expect(awsSlotFamily('CANLAW_CPT_S3_SECRET_ACCESS_KEY')).toBe('secret');
    expect(awsSlotFamily('CANLAW_CPT_S3_KEY')).toBe('key-id');
    expect(awsSlotFamily('DB_PASSWORD')).toBeNull();
    expect(awsSlotFamily('')).toBeNull();
  });
});
