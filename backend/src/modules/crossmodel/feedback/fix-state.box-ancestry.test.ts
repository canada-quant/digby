/**
 * fix-state box ancestry (2026-10-06 ticket catch-up): a deployed fix was never proven live on a busy main —
 * the box_health fallback accepted only a box running the fix sha itself or origin/main head, and other
 * sessions' pushes kept main's head one wave ahead of every box. A box whose running sha DESCENDS from the
 * fix (GitHub compare `<fix>...<boxSha>` = ahead / identical) now proves it. Kill switch
 * FIX_STATE_BOX_ANCESTRY_DISABLED=1.
 */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() } }));

const mockPrisma: any = { loopMetric: { findMany: jest.fn() } };
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockGetValidToken = jest.fn();
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: mockGetValidToken }));

import { resolveFixStateFromEvidence } from './fix-state';

const FIX = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555';
const BOX = '9d94558b00000000000000000000000000000000';
const HEAD = 'ead4fad300000000000000000000000000000000';

/** Fake GitHub: fix merged into main; main head = HEAD; compare FIX...<box> per the map. */
function fakeGithub(boxCompare: Record<string, string | number>) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(String(url));
    const json = (status: number, body: any) => ({ status, ok: status < 400, json: async () => body }) as any;
    if (url.endsWith(`/compare/${FIX}...main`)) return json(200, { status: 'ahead' }); // main is ahead of the fix ⇒ merged
    if (url.endsWith('/commits/main')) return json(200, { sha: HEAD });
    const m = /\/compare\/[0-9a-f]+\.\.\.([0-9a-f]+)$/.exec(url);
    if (m) {
      const v = boxCompare[m[1]];
      return typeof v === 'number' ? json(v, {}) : json(200, { status: v ?? 'diverged' });
    }
    return json(404, {});
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const boxRows = (...shas: string[]) => shas.map((sha, i) => ({ createdAt: new Date(), meta: { host: `box-${i}`, process: 'backend', sha } }));

describe('fix-state — a box on a DESCENDANT of the fix proves it live', () => {
  const OLD = process.env.FIX_STATE_BOX_ANCESTRY_DISABLED;
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.FIX_STATE_BOX_ANCESTRY_DISABLED;
    mockGetValidToken.mockResolvedValue('tok');
  });
  afterAll(() => { if (OLD === undefined) delete process.env.FIX_STATE_BOX_ANCESTRY_DISABLED; else process.env.FIX_STATE_BOX_ANCESTRY_DISABLED = OLD; });

  it('main head moved on, a box runs a wave that carries the fix ⇒ live', async () => {
    mockPrisma.loopMetric.findMany.mockResolvedValue(boxRows(BOX.slice(0, 8), BOX.slice(0, 8)));
    const gh = fakeGithub({ [BOX.slice(0, 8)]: 'ahead' });
    const st = await resolveFixStateFromEvidence({ id: 't1', userId: 'u1' }, { commitSha: FIX }, { fetchImpl: gh.impl });
    expect(st.fixLive).toBe(true);
    expect(st.reason).toContain('carries the fix');
    // one compare per DISTINCT box sha
    expect(gh.calls.filter(u => u.includes(`/compare/${FIX}...${BOX.slice(0, 8)}`))).toHaveLength(1);
  });

  it('a box on a sha that does NOT descend from the fix stays unproven', async () => {
    mockPrisma.loopMetric.findMany.mockResolvedValue(boxRows('19b12363'));
    const gh = fakeGithub({ '19b12363': 'behind' });
    const st = await resolveFixStateFromEvidence({ id: 't1', userId: 'u1' }, { commitSha: FIX }, { fetchImpl: gh.impl });
    expect(st.fixLive).toBe(false);
    expect(st.reason).toContain('a descendant of the fix');
  });

  it('a compare error is not proof', async () => {
    mockPrisma.loopMetric.findMany.mockResolvedValue(boxRows(BOX.slice(0, 8)));
    const gh = fakeGithub({ [BOX.slice(0, 8)]: 502 });
    const st = await resolveFixStateFromEvidence({ id: 't1', userId: 'u1' }, { commitSha: FIX }, { fetchImpl: gh.impl });
    expect(st.fixLive).toBe(false);
  });

  it('compares at most 4 distinct box shas', async () => {
    mockPrisma.loopMetric.findMany.mockResolvedValue(boxRows('11111111', '22222222', '33333333', '44444444', '55555555', '66666666'));
    const gh = fakeGithub({});
    await resolveFixStateFromEvidence({ id: 't1', userId: 'u1' }, { commitSha: FIX }, { fetchImpl: gh.impl });
    expect(gh.calls.filter(u => /\/compare\/[0-9a-f]+\.\.\.[0-9a-f]{8}$/.test(u))).toHaveLength(4);
  });

  it('FIX_STATE_BOX_ANCESTRY_DISABLED=1 restores the exact-sha / main-head rule', async () => {
    process.env.FIX_STATE_BOX_ANCESTRY_DISABLED = '1';
    mockPrisma.loopMetric.findMany.mockResolvedValue(boxRows(BOX.slice(0, 8)));
    const gh = fakeGithub({ [BOX.slice(0, 8)]: 'ahead' });
    const st = await resolveFixStateFromEvidence({ id: 't1', userId: 'u1' }, { commitSha: FIX }, { fetchImpl: gh.impl });
    expect(st.fixLive).toBe(false);
    expect(gh.calls.some(u => u.includes(`...${BOX.slice(0, 8)}`))).toBe(false);
  });
});
