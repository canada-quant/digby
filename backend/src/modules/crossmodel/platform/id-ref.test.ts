/**
 * audit 2026-10-08 W3-3 — the shared id HEAL tier (platform/id-ref.ts): prefix,
 * suffix and prefix+suffix splice, scoped by the caller's lookups.
 */
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({ recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a) }));

import { parseIdRef, healIdRef, describeIdRefMiss, type IdRefLookup } from './id-ref';

const lookupOver = (ids: string[]): IdRefLookup & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    byPrefix: async (p, take) => { calls.push(`prefix:${p}`); return ids.filter((id) => id.startsWith(p)).slice(0, take); },
    bySuffix: async (s, take) => { calls.push(`suffix:${s}`); return ids.filter((id) => id.endsWith(s)).slice(0, take); },
  };
};

const REAL = '0037460b-d239-474e-bd32-5fe3ec52d820';
const SIBLING = '0037460b-1111-4222-8333-944444444444';

afterEach(() => { delete process.env.ID_RESOLVER_HEAL_DISABLED; mockRecordLoopMetric.mockClear(); });

describe('parseIdRef', () => {
  it('strips quotes, ellipses and case; flags a typed suffix; rejects non-ids and < 8 hex', () => {
    expect(parseIdRef(' "…EC52D820" ')).toMatchObject({ cleaned: 'ec52d820', suffixIntent: true, valid: true });
    expect(parseIdRef('0037460b-…')).toMatchObject({ cleaned: '0037460b', suffixIntent: false, valid: true });
    expect(parseIdRef('...ec52d820')).toMatchObject({ cleaned: 'ec52d820', suffixIntent: true });
    expect(parseIdRef('ec52d8').valid).toBe(false);
    expect(parseIdRef('Restore Hue clip playback').valid).toBe(false);
    expect(parseIdRef('0037460b-zz').valid).toBe(false);
  });
});

describe('healIdRef', () => {
  it('prefix → suffix → splice, each unique-only', async () => {
    const ids = [REAL, SIBLING];
    expect(await healIdRef('0037460b-d239', lookupOver(ids), 'chat')).toMatchObject({ ok: true, id: REAL, via: 'prefix' });
    expect(await healIdRef('…ec52d820', lookupOver(ids), 'chat')).toMatchObject({ ok: true, id: REAL, via: 'suffix' });
    expect(await healIdRef('5fe3ec52d820', lookupOver(ids), 'chat')).toMatchObject({ ok: true, id: REAL, via: 'suffix' });
    expect(await healIdRef('0037460b-ec52d820', lookupOver(ids), 'chat')).toMatchObject({ ok: true, id: REAL, via: 'splice' });
    expect(await healIdRef('0037460b-b60b-456e-977f-a3127ec52d820', lookupOver(ids), 'chat')).toMatchObject({ ok: true, id: REAL, via: 'splice' });
  });

  it('a WELL-FORMED 36-char id is never spliced (the near-match tier owns typos — a head+tail match there could be another row)', async () => {
    const lk = lookupOver([REAL]);
    expect(await healIdRef('0037460b-aaaa-4bbb-8ccc-dddd5fe3ec52d820'.slice(0, 36), lk, 'chat')).toMatchObject({ ok: false });
    expect(await healIdRef('0037460b-9999-4964-baa4-4759ec52d820', lk, 'chat')).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('a typed suffix never runs the prefix tier (an 8-hex tail that is ALSO some id\'s prefix is not confused)', async () => {
    const lk = lookupOver([REAL, 'ec52d820-0000-4000-8000-000000000001']);
    expect(await healIdRef('…ec52d820', lk, 'chat')).toMatchObject({ ok: true, id: REAL, via: 'suffix' });
    expect(lk.calls).toEqual(['suffix:ec52d820']);
  });

  it('ambiguity lists the candidates (never a guess); nothing found lists the same-prefix rows', async () => {
    const amb = await healIdRef('0037460b', lookupOver([REAL, SIBLING]), 'chat');
    expect(amb).toMatchObject({ ok: false, reason: 'ambiguous', candidates: [REAL, SIBLING] });
    expect(describeIdRefMiss('chat', amb as any)).toBe(`"0037460b" matches 2 chats: ${REAL}, ${SIBLING} — pass one of these full ids.`);
    const miss = await healIdRef('0037460b-0000-0000-0000-00000000dead', lookupOver([REAL, SIBLING]), 'chat');
    expect(miss).toMatchObject({ ok: false, reason: 'not_found', candidates: [REAL, SIBLING] });
    expect(describeIdRefMiss('chat', miss as any)).toMatch(/^No chat matches .* chats sharing its first 8 characters: /);
  });

  it('scope is the lookup\'s: an id outside it never resolves', async () => {
    expect(await healIdRef('…ec52d820', lookupOver([SIBLING]), 'chat')).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('telemetry: one id_ref_heal row per heal (family + via | reason)', async () => {
    await healIdRef('0037460b-ec52d820', lookupOver([REAL]), 'schedule');
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'id_ref_heal', value: 1, meta: expect.objectContaining({ family: 'schedule', via: 'splice', resolved: '0037460b' }) }));
  });

  it('a throwing lookup is a not_found; not-an-id never queries; kill switch ID_RESOLVER_HEAL_DISABLED=1', async () => {
    const broken: IdRefLookup = { byPrefix: async () => { throw new Error('pg down'); }, bySuffix: async () => [] };
    expect(await healIdRef('0037460b-ec52d820', broken, 'chat')).toMatchObject({ ok: false, reason: 'not_found' });
    const lk = lookupOver([REAL]);
    expect(await healIdRef('Restore Hue', lk, 'chat')).toMatchObject({ ok: false, reason: 'not_an_id' });
    expect(lk.calls).toEqual([]);
    process.env.ID_RESOLVER_HEAL_DISABLED = '1';
    expect(await healIdRef('…ec52d820', lk, 'chat')).toMatchObject({ ok: false, reason: 'disabled' });
    expect(lk.calls).toEqual([]);
  });
});
