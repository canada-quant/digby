/**
 * xero/token-manager — multi-account helpers (ticket 64a25e8d).
 *
 * Pins: accountMatchesLabel fuzzy matching (bare label / org name /
 * "Label (Org name)" composite, case-insensitive), xeroAccountDisplayName,
 * and the DETERMINISTIC default account (orderBy createdAt asc) that
 * getValidToken falls back to when no label is given (Google parity).
 */

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    xeroOAuthToken: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  },
}));
jest.mock('axios');
jest.mock('../google/crypto', () => ({ encrypt: jest.fn((s: string) => `enc:${s}`), decrypt: jest.fn((s: string) => s.replace(/^enc:/, '')) }));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import prisma from '../../../config/database';
import { getValidToken, accountMatchesLabel, xeroAccountDisplayName, listXeroAccounts } from './token-manager';

const db = (prisma as any).xeroOAuthToken;

describe('accountMatchesLabel (ticket 64a25e8d)', () => {
  const row = { label: 'Work', orgName: 'Acme Ltd' };

  it('matches the bare label, the org name, and the "Label (Org name)" composite — case-insensitively', () => {
    expect(accountMatchesLabel(row, 'Work')).toBe(true);
    expect(accountMatchesLabel(row, 'work')).toBe(true);
    expect(accountMatchesLabel(row, 'ACME LTD')).toBe(true);
    expect(accountMatchesLabel(row, 'Work (Acme Ltd)')).toBe(true);
    expect(accountMatchesLabel(row, 'work (acme ltd)')).toBe(true);
    expect(accountMatchesLabel(row, '  Work  ')).toBe(true); // trims
  });

  it('does not match other strings, partial org names, or empty input', () => {
    expect(accountMatchesLabel(row, 'Personal')).toBe(false);
    expect(accountMatchesLabel(row, 'Acme')).toBe(false);
    expect(accountMatchesLabel(row, 'Work (Other)')).toBe(false);
    expect(accountMatchesLabel(row, '')).toBe(false);
    expect(accountMatchesLabel(row, '   ')).toBe(false);
  });

  it('matches only the label when the account has no org name', () => {
    const bare = { label: 'Default', orgName: null };
    expect(accountMatchesLabel(bare, 'default')).toBe(true);
    expect(accountMatchesLabel(bare, 'Default (Acme)')).toBe(false);
  });
});

describe('xeroAccountDisplayName', () => {
  it('renders "Label (Org name)" when an org name exists, else the bare label', () => {
    expect(xeroAccountDisplayName({ label: 'Work', orgName: 'Acme Ltd' })).toBe('Work (Acme Ltd)');
    expect(xeroAccountDisplayName({ label: 'Default', orgName: null })).toBe('Default');
  });
});

describe('getValidToken default-account determinism (ticket 64a25e8d)', () => {
  beforeEach(() => jest.clearAllMocks());

  const validRow = {
    id: 'row1', userId: 'u1', label: 'Default', tenantId: 't1',
    accessToken: 'enc:tok', refreshToken: 'enc:ref', orgName: 'Acme',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000), // valid for an hour
  };

  it('without a label picks the first-connected account (findFirst orderBy createdAt asc)', async () => {
    db.findFirst.mockResolvedValue(validRow);
    const result = await getValidToken('u1');
    expect(db.findFirst).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      orderBy: { createdAt: 'asc' },
    });
    expect(db.findUnique).not.toHaveBeenCalled();
    expect(result).toEqual({ accessToken: 'tok', tenantId: 't1', orgName: 'Acme' });
  });

  it('with a label resolves that exact account via the userId_label unique key', async () => {
    db.findUnique.mockResolvedValue({ ...validRow, label: 'Work' });
    const result = await getValidToken('u1', 'Work');
    expect(db.findUnique).toHaveBeenCalledWith({ where: { userId_label: { userId: 'u1', label: 'Work' } } });
    expect(result?.accessToken).toBe('tok');
  });

  it('returns null when no account exists', async () => {
    db.findFirst.mockResolvedValue(null);
    expect(await getValidToken('u1')).toBeNull();
  });
});

describe('listXeroAccounts', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns accounts first-connected first and degrades to [] on failure', async () => {
    const rows = [{ id: 'a', label: 'Default' }, { id: 'b', label: 'Work' }];
    db.findMany.mockResolvedValue(rows);
    await expect(listXeroAccounts('u1')).resolves.toBe(rows);
    expect(db.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'u1' },
      orderBy: { createdAt: 'asc' },
    }));

    db.findMany.mockRejectedValue(new Error('db down'));
    await expect(listXeroAccounts('u1')).resolves.toEqual([]);
  });
});
