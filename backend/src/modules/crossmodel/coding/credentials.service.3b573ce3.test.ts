/**
 * Ticket 3b573ce3 (2026-10-30) — STORE-DOOR half of "the vault concatenates
 * two credentials into one env var".
 *
 * The live incident: $CANLAW_CPT_S3_SECRET_ACCESS_KEY measured 60 chars with
 * an `AKIA` prefix, chars [0:20] byte-equal to the 20-char access key ID from
 * the same answer and chars [20:60] the real secret. The capture half is
 * fixed in secret-scan (pushCaptureSpan SPLITS a fused pair before it reaches
 * the vault — see secret-scan.3b573ce3.test.ts). This file covers the SECOND
 * door: upsertCredential is the ONE write choke point shared by the Account →
 * Coding form, store_secret and any direct API write, and its AWS pair rules
 * are ANCHORED — `/^(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}$/` is a key ID and
 * `/^[A-Za-z0-9+/]{40}$/` a secret, so a 60-char fused blob satisfied NEITHER
 * and stored unrefused on a *_SECRET_ACCESS_KEY slot.
 *
 * The guard must stay surgical: a genuine 40-char secret is still storable,
 * a bare key ID still lands on a KEY-ID slot untouched, and unknown shapes are
 * never refused.
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
      findMany: jest.fn(async ({ where }: any) => db.filter((r) => r.userId === where.userId)),
      findFirst: jest.fn(async ({ where }: any) =>
        db.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v))
          .sort((a, b) => +b.updatedAt - +a.updatedAt)[0] || null),
      findUnique: jest.fn(async ({ where }: any) => {
        const w = where.userId_envKey_label;
        return db.find((r) => r.userId === w.userId && r.envKey === w.envKey && (r.label ?? '') === w.label) || null;
      }),
      count: jest.fn(async ({ where }: any) => db.filter((r) => r.userId === where.userId).length),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const w = where.userId_envKey_label;
        const i = db.findIndex((r) => r.userId === w.userId && r.envKey === w.envKey && (r.label ?? '') === w.label);
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

import { upsertCredential, valueSlotMismatch } from './credentials.service';

// FAKE fixtures — structurally valid, never real key material.
const AKID = 'AKIA' + 'FAKEFAKEFAKEFAKE'; // 20: AKIA + 16 upper alnum
const SECRET = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/ab'; // 40: the AWS secret-key length
const FUSED = `${AKID}${SECRET}`; // 60 — the live corrupt shape

beforeEach(() => { db.length = 0; delete process.env.CODING_CRED_SLOT_VALIDATION_DISABLED; });

describe('ticket 3b573ce3 — store door refuses a FUSED AWS pair on a secret slot', () => {
  it('REPLAY: the fused 60-char blob is refused for a *_SECRET_ACCESS_KEY slot and nothing is stored', async () => {
    await expect(upsertCredential('u1', 'custom', 'CANLAW_CPT_S3_SECRET_ACCESS_KEY', FUSED))
      .rejects.toThrow(/TWO credentials CONCATENATED/);
    // The ticket's harm was that this STORED. It must not.
    expect(db).toHaveLength(0);
  });

  it('the refusal NAMES both halves and both slots, so the owner can redo it (never a bare "invalid")', () => {
    const msg = valueSlotMismatch('CANLAW_CPT_S3_SECRET_ACCESS_KEY', FUSED)!;
    expect(msg).toMatch(/TWO credentials CONCATENATED/);
    expect(msg).toMatch(/ACCESS KEY ID/);
    // The canonical AWS sibling the long-standing slot rules derive (the same
    // longest-first tail swap the swapped-pair refusal uses) — NOT the
    // owner's ad-hoc `…_S3_KEY` spelling, which no rule can know.
    expect(msg).toMatch(/CANLAW_CPT_S3_ACCESS_KEY_ID/);
    expect(msg).toMatch(/CANLAW_CPT_S3_SECRET_ACCESS_KEY/); // and the slot to redo the secret in
    expect(msg).toMatch(/without the ID/);                  // says WHAT to paste, not just "no"
  });

  it('the AWS-native spelling gets its own sibling: AWS_SECRET_ACCESS_KEY → AWS_ACCESS_KEY_ID', () => {
    const msg = valueSlotMismatch('AWS_SECRET_ACCESS_KEY', FUSED)!;
    expect(msg).toMatch(/AWS_ACCESS_KEY_ID/);
  });

  it('a labeled variant is covered on the same choke point (the incident pair carried a label)', async () => {
    await expect(upsertCredential('u1', 'custom', 'CANLAW_CPT_S3_SECRET_ACCESS_KEY', FUSED, 'CPT'))
      .rejects.toThrow(/TWO credentials CONCATENATED/);
    expect(db).toHaveLength(0);
  });
});

describe('ticket 3b573ce3 — the guard stays surgical (no new over-block)', () => {
  it('a genuine 40-char secret STILL stores on the secret slot', async () => {
    await upsertCredential('u1', 'custom', 'CANLAW_CPT_S3_SECRET_ACCESS_KEY', SECRET);
    expect(db).toHaveLength(1);
    expect(db[0].envKey).toBe('CANLAW_CPT_S3_SECRET_ACCESS_KEY');
  });

  it('a bare 20-char key ID still stores on a KEY-ID slot untouched', async () => {
    await upsertCredential('u1', 'custom', 'CANLAW_CPT_S3_KEY', AKID);
    expect(db).toHaveLength(1);
    expect(db[0].envKey).toBe('CANLAW_CPT_S3_KEY');
  });

  it('a fused blob on a NON-secret slot is not this guard\'s business (it only keys on secret slots)', () => {
    // The AWS rule never fired for key-ID slots and still does not: a value is
    // judged by the SLOT it lands in, and a fused blob in a key-ID slot is
    // refused by the pre-existing 40-char-secret rule only if it IS one.
    expect(valueSlotMismatch('SOME_RANDOM_KEY', FUSED)).toBeNull();
    expect(valueSlotMismatch('CLOUDFLARE_API_TOKEN', FUSED)).toBeNull();
  });

  it('the kill switch restores the pre-fix accept-anything behaviour', () => {
    process.env.CODING_CRED_SLOT_VALIDATION_DISABLED = '1';
    expect(valueSlotMismatch('CANLAW_CPT_S3_SECRET_ACCESS_KEY', FUSED)).toBeNull();
    delete process.env.CODING_CRED_SLOT_VALIDATION_DISABLED;
  });

  it('a 21-char value that merely starts with AKIA+16 (a genuine non-key) still trips the fused rule — documented boundary', () => {
    // Boundary recorded deliberately: the key-ID prefix is 20 chars and its
    // last 16 are ALL-CAPS alnum by definition, so a 21-char value leading
    // with that shape is the fused class, not a long secret. The secret this
    // matters for is 40 chars; a 21-char "secret" is not an AWS one.
    expect(valueSlotMismatch('CANLAW_CPT_S3_SECRET_ACCESS_KEY', FUSED.slice(0, 21))).toMatch(/CONCATENATED/);
  });
});