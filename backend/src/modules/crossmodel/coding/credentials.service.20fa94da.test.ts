/**
 * Ticket 20fa94da — REPLAY of the live mishap: the CQL Cloudflare pair was
 * stored SWAPPED (the 32-hex account id under the API-TOKEN slot, the working
 * cfat_ token under the ACCOUNT-ID slot), and because credential values are
 * write-only nothing could flag the mapping until lanes failed live CF calls
 * with 400/6111. The guard under test refuses a KNOWN Cloudflare shape that
 * lands in the WRONG slot at store time — through upsertCredential, the ONE
 * write choke point shared by the Account UI (REST PUT) and store_secret —
 * while every other shape/slot combination still stores untouched (the guard
 * is deliberately surgical: it never refuses a shape it does not know).
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

import { upsertCredential, valueSlotMismatch, listCredentials } from './credentials.service';

// FAKE fixtures — structurally valid shapes only, never real credentials.
// Same shape classes the live incident carried (ticket 20fa94da): a 32-hex
// account id and a 53-char scannable account API token.
const FAKE_ACCOUNT_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'; // 32 hex
const FAKE_CFAT = 'cfat_' + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdE'; // 48 alnum after prefix = 53 chars
const FAKE_CFUT = 'cfut_' + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCd';
const FAKE_CFK = 'cfk_' + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCd';
// A legacy 40-char token — a shape the guard does NOT know: it must pass on
// both slots (over-blocking a shape would be a worse failure than the mishap).
const FAKE_LEGACY_40 = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCd';

beforeEach(() => { db.length = 0; delete process.env.CODING_CRED_SLOT_VALIDATION_DISABLED; });

describe('ticket 20fa94da — provider-slot shape validation (the swapped CLOUDFLARE_CQL pair)', () => {
  it('REPLAY: refuses the 32-hex ACCOUNT ID stored into the API-TOKEN slot (the exact mishap, primary slot)', async () => {
    await expect(upsertCredential('u1', 'cloudflare', 'CLOUDFLARE_API_TOKEN', FAKE_ACCOUNT_ID))
      .rejects.toThrow(/ACCOUNT ID \(32 hex characters\).*CLOUDFLARE_API_TOKEN is the API-TOKEN slot/s);
    expect(db).toHaveLength(0); // refused ⇒ nothing stored, on BOTH doors (same choke point)
  });

  it('REPLAY: refuses the cfat_ TOKEN stored into the ACCOUNT-ID slot (the exact mishap, primary slot)', async () => {
    await expect(upsertCredential('u1', 'cloudflare', 'CLOUDFLARE_ACCOUNT_ID', FAKE_CFAT))
      .rejects.toThrow(/API TOKEN.*CLOUDFLARE_ACCOUNT_ID is the ACCOUNT-ID slot/s);
    expect(db).toHaveLength(0);
  });

  it('REPLAY: the mishap pair carried a LABEL (CQL) — labeled variants are covered on both slots', async () => {
    await expect(upsertCredential('u1', 'cloudflare', 'CLOUDFLARE_API_TOKEN', FAKE_ACCOUNT_ID, 'CQL'))
      .rejects.toThrow(/look swapped/);
    await expect(upsertCredential('u1', 'cloudflare', 'CLOUDFLARE_ACCOUNT_ID', FAKE_CFAT, 'CQL'))
      .rejects.toThrow(/look swapped/);
    expect(db).toHaveLength(0);
  });

  it('REPLAY: store_secret\'s door hits the same choke point — provider "custom" rows are guarded too', async () => {
    // store_secret stores NEW rows with provider 'custom' (secret-handoff-tools
    // passes existing?.provider ?? 'custom'), so the guard MUST key on envKey,
    // never on the provider field.
    await expect(upsertCredential('u1', 'custom', 'CLOUDFLARE_API_TOKEN', FAKE_ACCOUNT_ID, 'CQL'))
      .rejects.toThrow(/look swapped/);
    expect(db).toHaveLength(0);
  });

  it('the CORRECT mapping still stores: token in the token slot, account id in the id slot', async () => {
    await upsertCredential('u1', 'cloudflare', 'CLOUDFLARE_API_TOKEN', FAKE_CFAT, 'CQL');
    await upsertCredential('u1', 'cloudflare', 'CLOUDFLARE_ACCOUNT_ID', FAKE_ACCOUNT_ID, 'CQL');
    expect(db).toHaveLength(2);
    const rows = await listCredentials('u1');
    expect(rows.map(r => r.envKey).sort()).toEqual(['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']);
    expect(rows.every(r => r.readable)).toBe(true);
  });

  it('UNKNOWN shapes are never refused (surgical by design) — a legacy 40-char CF token stores on BOTH slots', async () => {
    await upsertCredential('u1', 'cloudflare', 'CLOUDFLARE_API_TOKEN', FAKE_LEGACY_40);
    await upsertCredential('u1', 'cloudflare', 'CLOUDFLARE_ACCOUNT_ID', FAKE_LEGACY_40);
    expect(db).toHaveLength(2);
  });

  it('the cfut_/cfk_ token families are refused in the account-id slot as well', async () => {
    await expect(upsertCredential('u1', 'cloudflare', 'CLOUDFLARE_ACCOUNT_ID', FAKE_CFUT))
      .rejects.toThrow(/look swapped/);
    await expect(upsertCredential('u1', 'cloudflare', 'CLOUDFLARE_ACCOUNT_ID', FAKE_CFK))
      .rejects.toThrow(/look swapped/);
    expect(db).toHaveLength(0);
  });

  it('a LOWERCASE 32-hex account id is still an account id (the dashboard serves lowercase)', async () => {
    await expect(upsertCredential('u1', 'cloudflare', 'CLOUDFLARE_API_TOKEN', FAKE_ACCOUNT_ID.toLowerCase()))
      .rejects.toThrow(/look swapped/);
  });

  it('kill switch CODING_CRED_SLOT_VALIDATION_DISABLED=1 restores the old accept-anything behaviour', async () => {
    process.env.CODING_CRED_SLOT_VALIDATION_DISABLED = '1';
    await upsertCredential('u1', 'cloudflare', 'CLOUDFLARE_API_TOKEN', FAKE_ACCOUNT_ID);
    expect(db).toHaveLength(1); // stored, warning-free, exactly as before the guard
  });

  it('the refusal message names BOTH correct slots so the owner can self-serve', () => {
    const msg = valueSlotMismatch('CLOUDFLARE_API_TOKEN_CQL', FAKE_ACCOUNT_ID);
    expect(msg).toContain('CLOUDFLARE_API_TOKEN_CQL');
    expect(msg).toContain('CLOUDFLARE_ACCOUNT_ID_CQL');
    expect(msg).not.toContain(FAKE_ACCOUNT_ID); // never echo the value
  });

  it('valueSlotMismatch is pure and total: unknown envKeys and empty values pass', () => {
    expect(valueSlotMismatch('AWS_ACCESS_KEY_ID', FAKE_ACCOUNT_ID)).toBeNull();
    expect(valueSlotMismatch('CLOUDFLARE_API_TOKEN', '')).toBeNull();
    expect(valueSlotMismatch('', FAKE_ACCOUNT_ID)).toBeNull();
    // 31 or 33 hex chars: NOT a CF account id — must not trip the guard.
    expect(valueSlotMismatch('CLOUDFLARE_API_TOKEN', FAKE_ACCOUNT_ID.slice(0, 31))).toBeNull();
    expect(valueSlotMismatch('CLOUDFLARE_API_TOKEN', FAKE_ACCOUNT_ID + 'e')).toBeNull();
  });
});
