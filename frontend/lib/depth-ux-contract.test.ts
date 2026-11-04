/**
 * Depth UX seam contract — the CLIENT half (compute policy, 2026-09-26;
 * review MEDIUM #5). Every name the client reads off the wire or a persisted
 * row comes from lib/depth-ux-contract.json, and this suite proves the client
 * code honours exactly those names by CALLING it with fixture-named fields
 * (never string pins). Module B's jest suite imports the SAME fixture and
 * proves the harness writes them — so a rename on either side fails CI.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api-client', () => ({ ensureFreshAuthCookie: vi.fn(async () => {}) }));

import contract from './depth-ux-contract.json';
import {
  ESCALATE_LABEL, PROGRESS_KEY_TEXT, countSpentEscalations, escalationChipFor, parseCheckState, parseChips,
} from './depth-ux';
import { MACHINE_STAMP_ORIGINS } from './machine-wake';
import { buildPlainMeta, buildPlainStreamUrl, makeLegacyNormalizer, mapPlainMessages, plainRevisionPending } from '@/app/crossmodel/plain-session';

const MSG = '11111111-1111-4111-8111-111111111111';
const { sse, request, assistantMetadata, userMetadata, pollWhile, machineOrigins } = contract;

describe('SSE — check_state', () => {
  it('the event type + every state name normalize; the field names are the fixture\'s', () => {
    const n = makeLegacyNormalizer();
    for (const state of sse.checkStates) {
      const out = n(sse.checkStateEvent, { [sse.checkStateFields.state]: state });
      expect(out?.type).toBe('check_state');
      expect(out?.data?.state).toBe(state);
    }
    const parsed = parseCheckState({
      [sse.checkStateFields.state]: 'updated',
      [sse.checkStateFields.changed]: ['price 12 → 14'],
      [sse.checkStateFields.revisionId]: 'r1',
    });
    expect(parsed).toEqual({ state: 'updated', changed: ['price 12 → 14'], revisionId: 'r1' });
    expect(parseCheckState({ [sse.checkStateFields.state]: 'not-a-state' })).toBeNull();
  });
});

describe('SSE — progress keys', () => {
  it('the client lookup table has exactly the fixture\'s keys and reads them off the fixture\'s field', () => {
    expect(Object.keys(PROGRESS_KEY_TEXT).sort()).toEqual([...sse.progressKeys].sort());
    const n = makeLegacyNormalizer();
    for (const key of sse.progressKeys) {
      const out = n(sse.progressEvent, { [sse.progressKeyField]: key, message: 'MODEL PROSE' });
      expect(out?.type).toBe('progress');
      expect(out?.data?.key).toBe(key);
      expect(out?.data?.message).toBe(PROGRESS_KEY_TEXT[key as keyof typeof PROGRESS_KEY_TEXT]);
    }
  });
});

describe('SSE — chips', () => {
  const escalate = (rung: string) => ({
    [sse.escalateChipFields.kind]: 'escalate',
    [sse.escalateChipFields.escalationOf]: MSG,
    [sse.escalateChipFields.nextRung]: rung,
    [sse.escalateChipFields.etaText]: 'about 2 minutes',
    [sse.escalateChipFields.label]: ESCALATE_LABEL,
  });

  it('every carrier event delivers the chips field into complete; every chip kind and rung parses', () => {
    for (const carrier of sse.chipsCarriers) {
      const n = makeLegacyNormalizer();
      if (carrier === 'complete') {
        const c = n('complete', { [sse.chipsField]: [escalate('verify')] });
        expect(c?.data?.chips?.[0]).toMatchObject({ kind: 'escalate', escalationOf: MSG, nextRung: 'verify' });
      } else {
        expect(n(carrier, { [sse.chipsField]: [escalate('verify')] })).toBeNull();
        const c = n('complete', {});
        expect(c?.data?.chips?.[0]).toMatchObject({ kind: 'escalate', escalationOf: MSG, nextRung: 'verify' });
      }
    }
    for (const rung of sse.nextRungs) expect(parseChips([escalate(rung)])[0]).toMatchObject({ nextRung: rung });
    expect(parseChips([escalate('moon')])).toEqual([]);
    const kinds = parseChips(sse.chipKinds.map((kind) => (kind === 'escalate' ? escalate('verify') : { kind }))).map((c) => c.kind);
    expect(kinds.sort()).toEqual([...sse.chipKinds].sort());
  });
});

describe('SSE — depth on complete (audit sse-ui-restore-14)', () => {
  it('the complete payload\'s depth rides under the fixture\'s field into the just-answered meta, and the ladder walks it after a spent rung', () => {
    expect(sse.depthCarriers).toEqual(['complete']);
    const n = makeLegacyNormalizer();
    n('chunk', { content: 'answer' });
    const c = n('complete', { [sse.depthField]: { plan: { preset: 'single_thinking', spawnChecker: false, council: 'none', source: 'preset' } }, [sse.chipsField]: [{ kind: 'escalate', escalationOf: MSG, nextRung: 'verify' }] });
    const meta = buildPlainMeta(c?.data, 'auto');
    expect(meta?.depth?.plan?.preset).toBe('single_thinking');
    // one rung spent this session (the echo) ⇒ the persisted plan yields the NEXT rung without a reload
    expect(escalationChipFor({ chips: meta?.chips, depth: meta?.depth, messageId: MSG, guest: false, spent: 1, isLast: true, running: false }))
      .toMatchObject({ kind: 'escalate', escalationOf: MSG, nextRung: 'research' });
    // the DEFECT shape (no depth on the wire): the ladder cannot walk
    const bare = buildPlainMeta(makeLegacyNormalizer()('complete', { [sse.chipsField]: [{ kind: 'escalate', escalationOf: MSG, nextRung: 'verify' }] })?.data, 'auto');
    expect(bare?.depth).toBeUndefined();
    expect(escalationChipFor({ chips: bare?.chips, depth: bare?.depth, messageId: MSG, guest: false, spent: 1, isLast: true, running: false })).toBeNull();
  });
});

describe('request — the escalation param', () => {
  it('buildPlainStreamUrl sends the fixture-named query param', async () => {
    const url = await buildPlainStreamUrl({ chatId: 'c1', message: ESCALATE_LABEL, mode: 'auto', webSearch: true, escalationOf: MSG });
    expect(new URL(url).searchParams.get(request.escalationParam)).toBe(MSG);
  });
});

describe('persisted metadata — assistant rows', () => {
  it('buildPlainMeta and mapPlainMessages read check / depth / chips / origin under the fixture\'s keys', () => {
    const wire = {
      [assistantMetadata.check]: { state: 'checking' },
      [assistantMetadata.depth]: { plan: { preset: 'single_thinking', spawnChecker: true, source: 'gate_act' } },
      [assistantMetadata.chips]: [{ kind: 'escalate', escalationOf: MSG, nextRung: 'verify' }],
    };
    const meta = buildPlainMeta(wire, 'auto');
    expect(meta?.check).toEqual({ state: 'checking' });
    expect(meta?.depth?.plan?.preset).toBe('single_thinking');
    expect(meta?.chips?.[0]).toMatchObject({ kind: 'escalate', escalationOf: MSG });

    const [row] = mapPlainMessages({ messages: [{ id: MSG, role: 'assistant', content: 'x', metadata: { ...wire, [assistantMetadata.origin]: 'user' } }] });
    expect(row.plainMeta?.check).toEqual({ state: 'checking' });
    expect(row.plainMeta?.depth?.plan?.preset).toBe('single_thinking');
    expect(row.plainMeta?.chips?.[0]).toMatchObject({ kind: 'escalate' });
    expect(row.plainMeta?.origin).toBe('user');
    // the chip renders from the persisted row's chips — the fail-closed source
    expect(escalationChipFor({ chips: row.plainMeta?.chips, origin: row.plainMeta?.origin, messageId: row.id, guest: false, isLast: true, running: false }))
      .toMatchObject({ kind: 'escalate', escalationOf: MSG });
  });

  it('the machine-origin set the chip refuses is the fixture\'s (and the shared MACHINE_STAMP_ORIGINS)', () => {
    expect([...MACHINE_STAMP_ORIGINS].sort()).toEqual([...machineOrigins].sort());
    const chips = parseChips([{ kind: 'escalate', escalationOf: MSG, nextRung: 'verify' }]);
    for (const origin of machineOrigins) {
      expect(escalationChipFor({ chips, origin, messageId: MSG, guest: false, isLast: true, running: false })).toBeNull();
    }
  });
});

describe('persisted metadata — user rows', () => {
  it('a persisted escalation echo carries escalationOf under the fixture\'s key and counts as a spent rung after reload', () => {
    const rows = mapPlainMessages({ messages: [
      { id: MSG, role: 'assistant', content: 'answer', metadata: {} },
      { id: 'u2', role: 'user', content: ESCALATE_LABEL, metadata: { [userMetadata.escalationOf]: MSG } },
    ] });
    expect(countSpentEscalations(rows.map((r) => ({ role: r.role, escalationOf: r.plainMeta?.escalationOf })), MSG)).toBe(1);
  });
});

describe('the completion poll', () => {
  it('keeps polling on the legacy flag or the fixture\'s checking state, and stops on anything else', () => {
    expect(plainRevisionPending({ [pollWhile.legacyFlag]: true } as any)).toBe(true);
    expect(plainRevisionPending({ check: { state: pollWhile.checkState as 'checking' } })).toBe(true);
    for (const state of sse.checkStates.filter((s) => s !== pollWhile.checkState)) {
      expect(plainRevisionPending({ check: { state: state as 'checked' } })).toBe(false);
    }
    expect(plainRevisionPending({})).toBe(false);
  });
});

describe('fixture hygiene', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => { (globalThis as any).fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })); });
  afterEach(() => { (globalThis as any).fetch = originalFetch; });

  it('the fixture is versioned and its name sets are non-empty and unique', () => {
    expect(contract.version).toBe(1);
    for (const list of [sse.checkStates, sse.progressKeys, sse.chipsCarriers, sse.chipKinds, sse.nextRungs, machineOrigins]) {
      expect(list.length).toBeGreaterThan(0);
      expect(new Set(list).size).toBe(list.length);
    }
  });
});
