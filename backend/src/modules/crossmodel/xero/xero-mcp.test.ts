/**
 * xero-mcp — multi-account label resolution (ticket 64a25e8d).
 *
 * Pins the model-facing contract: a tool call naming an UNKNOWN account label
 * returns a discovery message listing the valid labels (Google parity with
 * resolveGoogleAccount's label_not_found) WITHOUT hitting the Xero API; a
 * valid label (bare label, org name, or composite) routes the call to that
 * account's token/tenant; no label uses the deterministic first-connected
 * account. Non-label failures still degrade to ''.
 */

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    xeroOAuthToken: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
  },
}));
jest.mock('axios');
jest.mock('../google/crypto', () => ({ encrypt: jest.fn((s: string) => `enc:${s}`), decrypt: jest.fn((s: string) => s.replace(/^enc:/, '')) }));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import axios from 'axios';
import prisma from '../../../config/database';
import { getOrganisation, getContacts } from './xero-mcp';

const db = (prisma as any).xeroOAuthToken;

const ACCTS = [
  { id: 'a1', label: 'Default', orgName: 'Acme Ltd', tenantId: 'tenant-acme', scopes: [], expiresAt: new Date(Date.now() + 3600_000), createdAt: new Date('2026-01-01'), accessToken: 'enc:tok-acme', refreshToken: 'enc:r1', userId: 'u1' },
  { id: 'a2', label: 'Work', orgName: 'Globex', tenantId: 'tenant-globex', scopes: [], expiresAt: new Date(Date.now() + 3600_000), createdAt: new Date('2026-02-01'), accessToken: 'enc:tok-globex', refreshToken: 'enc:r2', userId: 'u1' },
];

function mockOrgApi(name: string) {
  (axios.get as jest.Mock).mockResolvedValue({ data: { Organisations: [{ Name: name }] } });
}

describe('xero-mcp label resolution (ticket 64a25e8d)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.findMany.mockResolvedValue(ACCTS);
    db.findUnique.mockImplementation(({ where }: any) =>
      Promise.resolve(ACCTS.find(a => a.label === where.userId_label.label) || null));
    db.findFirst.mockResolvedValue(ACCTS[0]); // deterministic default = first-connected
  });

  it('an unknown label returns the discovery message listing valid accounts — and never calls the Xero API', async () => {
    const out = await getOrganisation('u1', 'Nonexistent');
    expect(out).toContain('Xero account "Nonexistent" not found');
    expect(out).toContain('Default (Acme Ltd)');
    expect(out).toContain('Work (Globex)');
    expect(axios.get).not.toHaveBeenCalled();
    expect(db.findUnique).not.toHaveBeenCalled();
  });

  it('a bare label routes to that account (token + tenant header)', async () => {
    mockOrgApi('Globex');
    const out = await getOrganisation('u1', 'Work');
    expect(db.findUnique).toHaveBeenCalledWith({ where: { userId_label: { userId: 'u1', label: 'Work' } } });
    const config = (axios.get as jest.Mock).mock.calls[0][1];
    expect(config.headers['Authorization']).toBe('Bearer tok-globex');
    expect(config.headers['xero-tenant-id']).toBe('tenant-globex');
    expect(out).toContain('Organisation: Globex');
  });

  it('an org name and the "Label (Org name)" composite match too (case-insensitive)', async () => {
    mockOrgApi('Acme Ltd');
    await getOrganisation('u1', 'acme ltd');
    expect(db.findUnique).toHaveBeenCalledWith({ where: { userId_label: { userId: 'u1', label: 'Default' } } });

    jest.clearAllMocks();
    db.findMany.mockResolvedValue(ACCTS);
    db.findUnique.mockImplementation(({ where }: any) =>
      Promise.resolve(ACCTS.find(a => a.label === where.userId_label.label) || null));
    mockOrgApi('Globex');
    await getOrganisation('u1', 'work (globex)');
    expect(db.findUnique).toHaveBeenCalledWith({ where: { userId_label: { userId: 'u1', label: 'Work' } } });
  });

  it('no label uses the first-connected (default) account — listAccounts is not consulted', async () => {
    mockOrgApi('Acme Ltd');
    const out = await getOrganisation('u1');
    expect(db.findFirst).toHaveBeenCalledWith({ where: { userId: 'u1' }, orderBy: { createdAt: 'asc' } });
    expect(db.findMany).not.toHaveBeenCalled();
    expect(out).toContain('Organisation: Acme Ltd');
  });

  it('label errors surface from list tools too; an API failure now SURFACES its reason (2026-10-04) — XERO_ERROR_SURFACE_DISABLED=1 restores the empty string', async () => {
    const out = await getContacts('u1', 'nope', undefined, 'Nope');
    expect(out).toContain('Xero account "Nope" not found');

    (axios.get as jest.Mock).mockRejectedValue(new Error('xero down'));
    const surfaced = await getContacts('u1', 'acme', undefined, 'Work');
    expect(surfaced).toMatch(/^Xero Contacts could not reach Xero \(network error: xero down\)/);

    process.env.XERO_ERROR_SURFACE_DISABLED = '1';
    try {
      expect(await getContacts('u1', 'acme', undefined, 'Work')).toBe('');
    } finally {
      delete process.env.XERO_ERROR_SURFACE_DISABLED;
    }
  });

  it('a 401 / 403 tells the model to have the user reconnect Xero; 429 / 5xx say so (owner run 2026-10-04: 19 silent failures)', async () => {
    (axios.get as jest.Mock).mockRejectedValue(Object.assign(new Error('Request failed with status code 401'), { response: { status: 401, data: { Message: 'AuthenticationUnsuccessful' } } }));
    expect(await getOrganisation('u1')).toMatch(/^Xero Organisation was rejected by Xero \(HTTP 401: AuthenticationUnsuccessful\) — the Xero connection needs re-authorizing: Account → Integrations → Xero → reconnect\.$/);
    (axios.get as jest.Mock).mockRejectedValue(Object.assign(new Error('x'), { response: { status: 429 } }));
    expect(await getOrganisation('u1')).toMatch(/rate-limited by Xero \(HTTP 429\)/);
    (axios.get as jest.Mock).mockRejectedValue(Object.assign(new Error('x'), { response: { status: 503 } }));
    expect(await getOrganisation('u1')).toMatch(/failed on Xero's side \(HTTP 503\)/);
  });
});
