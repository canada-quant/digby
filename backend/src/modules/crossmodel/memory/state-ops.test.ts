/**
 * state-ops.test.ts — the per-item memory update engine (2026-10-20 memory wave).
 */
import {
  renderStateForOps, opsInstruction, parseStateOps, applyStateOps, maxOpsAnswerChars, memoryStateOpsEnabled, opId,
  type OpsSpec,
} from './state-ops';

const PROJECT: OpsSpec = {
  text: { summary: { cap: 120 } },
  lists: {
    recentDecisions: { cap: 3, itemCap: 60, idPrefix: 'D' },
    'entities.people': { cap: 5, itemCap: 40, idPrefix: 'P' },
  },
  maps: { confirmedFacts: { cap: 3, keyCap: 20, valueCap: 40, idPrefix: 'F' } },
};
const state = () => ({
  summary: 'A billing service rewrite.',
  recentDecisions: ['use Postgres', 'ship weekly'],
  entities: { people: ['Ana (PM)'], amounts: ['$5k'] },
  confirmedFacts: { db: 'Postgres', region: 'ca-central-1' },
  lastUpdated: 'x',
});

describe('renderStateForOps / opsInstruction', () => {
  it('shows every field with its limit and every item behind a stable id', () => {
    const text = renderStateForOps(state(), PROJECT);
    expect(text).toContain('summary (at most 120 characters): A billing service rewrite.');
    expect(text).toContain('  [D1] use Postgres');
    expect(text).toContain('  [D2] ship weekly');
    expect(text).toContain('  [P1] Ana (PM)');
    expect(text).toContain('  [F2] region: ca-central-1');
  });

  it('empty fields render as (empty) / (none)', () => {
    const text = renderStateForOps({}, PROJECT);
    expect(text).toContain('summary (at most 120 characters): (empty)');
    expect(text).toContain('  (none)');
  });

  it('the instruction names the spec fields and the {} no-change answer', () => {
    const line = opsInstruction(PROJECT);
    expect(line).toContain('summary');
    expect(line).toContain('recentDecisions, entities.people');
    expect(line).toContain('confirmedFacts');
    expect(line).toContain('Return {} when nothing should change');
  });
});

describe('parseStateOps', () => {
  it('reads the op groups and drops junk inside them', () => {
    const r = parseStateOps('{"set": {"summary": "s2", "bad": 3}, "add": {"recentDecisions": ["a", 4], "entities.people": "Bo"}, "update": {"D1": "x"}, "remove": ["P1", 7], "put": {"confirmedFacts": {"k": "v"}}}', PROJECT);
    expect(r?.legacyShape).toBe(false);
    expect(r?.ops).toEqual({
      set: { summary: 's2', bad: '3' },
      add: { recentDecisions: ['a'], 'entities.people': ['Bo'] },
      update: { D1: 'x' },
      remove: ['P1'],
      put: { confirmedFacts: { k: 'v' } },
    });
  });

  it('{} is a valid no-change answer', () => {
    expect(parseStateOps('{}', PROJECT)).toEqual({ ops: {}, legacyShape: false, salvaged: false });
    expect(parseStateOps('```json\n{}\n```', PROJECT)?.ops).toEqual({});
  });

  it('a whole-object answer (the old shape) is converted, not lost', () => {
    const r = parseStateOps(JSON.stringify(state()), PROJECT)!;
    expect(r.legacyShape).toBe(true);
    expect(r.ops.set).toEqual({ summary: 'A billing service rewrite.' });
    expect(r.ops.replaceLists).toEqual({ recentDecisions: ['use Postgres', 'ship weekly'], 'entities.people': ['Ana (PM)'] });
    expect(r.ops.replaceMaps).toEqual({ confirmedFacts: { db: 'Postgres', region: 'ca-central-1' } });
  });

  it('a truncated answer keeps its complete groups', () => {
    const r = parseStateOps('{"set": {"summary": "s2"}, "add": {"recentDecisions": ["a", "b', PROJECT)!;
    expect(r.salvaged).toBe(true);
    expect(r.ops).toEqual({ set: { summary: 's2' } });
  });

  it('prose with no JSON, or an object with no known field, is null', () => {
    expect(parseStateOps('I could not decide.', PROJECT)).toBeNull();
    expect(parseStateOps('{"notes": "x"}', PROJECT)).toBeNull();
    expect(parseStateOps('', PROJECT)).toBeNull();
  });
});

describe('applyStateOps', () => {
  it('set / update / remove / add / put, with the original snapshot untouched', () => {
    const before = state();
    const r = applyStateOps(before, {
      set: { summary: 'Billing rewrite, phase 2.' },
      update: { '[d2]': 'ship every Friday' },
      remove: ['P1', 'F1'],
      add: { 'entities.people': ['Raj (eng)'] },
      put: { confirmedFacts: { owner: 'Ana' } },
    }, PROJECT);
    expect(r.state.summary).toBe('Billing rewrite, phase 2.');
    expect(r.state.recentDecisions).toEqual(['use Postgres', 'ship every Friday']);
    expect(r.state.entities.people).toEqual(['Raj (eng)']);
    expect(r.state.entities.amounts).toEqual(['$5k']); // a path the spec does not name is left alone
    expect(r.state.confirmedFacts).toEqual({ region: 'ca-central-1', owner: 'Ana' });
    expect(r.state.lastUpdated).toBe('x');
    expect(r.changed).toBe(true);
    expect(r.counts).toEqual({ set: 1, added: 1, updated: 1, removed: 2, put: 1, evicted: 0 });
    expect(before).toEqual(state()); // not mutated
  });

  it('adds go first, duplicates are skipped, overflow evicts the oldest and reports it', () => {
    const r = applyStateOps(state(), { add: { recentDecisions: ['adopt Kafka', 'USE POSTGRES', 'drop cron'] } }, PROJECT);
    expect(r.state.recentDecisions).toEqual(['adopt Kafka', 'drop cron', 'use Postgres']);
    expect(r.evicted).toEqual([{ path: 'recentDecisions', item: 'ship weekly' }]);
    expect(r.counts.added).toBe(2);
  });

  it('every value is clamped to its cap', () => {
    const r = applyStateOps<any>({}, { set: { summary: 'word '.repeat(80) }, add: { recentDecisions: ['x'.repeat(200)] }, put: { confirmedFacts: { k: 'v'.repeat(200) } } }, PROJECT);
    expect(r.state.summary.length).toBeLessThanOrEqual(120);
    expect(r.state.recentDecisions[0].length).toBeLessThanOrEqual(60);
    expect(r.state.confirmedFacts.k.length).toBeLessThanOrEqual(40);
  });

  it('an oversized stored state is clamped even by an empty answer', () => {
    const big = { ...state(), summary: 'long '.repeat(100), recentDecisions: ['a', 'b', 'c', 'd', 'e'] };
    const r = applyStateOps(big, {}, PROJECT);
    expect(r.state.summary.length).toBeLessThanOrEqual(120);
    expect(r.state.recentDecisions).toEqual(['a', 'b', 'c']);
    expect(r.changed).toBe(true); // content moved — the heal is a real change
  });

  it('{} on a state within its caps changes nothing', () => {
    const r = applyStateOps(state(), {}, PROJECT);
    expect(r.changed).toBe(false);
    expect(r.state.recentDecisions).toEqual(['use Postgres', 'ship weekly']);
  });

  it('unknown ids and paths are ignored and reported', () => {
    const r = applyStateOps(state(), { update: { D9: 'x' }, remove: ['Z1'], set: { nope: 'x' }, add: { other: ['y'] } }, PROJECT);
    expect(r.unknown.sort()).toEqual(['D9', 'Z1', 'nope', 'other']);
    expect(r.changed).toBe(false);
  });

  it('an update to an empty string removes the item', () => {
    const r = applyStateOps(state(), { update: { D1: '  ' } }, PROJECT);
    expect(r.state.recentDecisions).toEqual(['ship weekly']);
    expect(r.counts.removed).toBe(1);
  });

  it('legacy replacements land clamped', () => {
    const r = applyStateOps(state(), { replaceLists: { recentDecisions: ['a', 'b', 'c', 'd'] }, replaceMaps: { confirmedFacts: { a: '1' } } }, PROJECT);
    expect(r.state.recentDecisions).toEqual(['a', 'b', 'c']);
    expect(r.state.confirmedFacts).toEqual({ a: '1' });
  });

  it('a map past its cap keeps the newest entries', () => {
    const r = applyStateOps(state(), { put: { confirmedFacts: { a: '1', b: '2' } } }, PROJECT);
    expect(Object.keys(r.state.confirmedFacts)).toEqual(['region', 'a', 'b']);
    expect(r.counts.evicted).toBe(1);
  });
});

describe('bounds + switch', () => {
  it('the largest possible answer is bounded by the spec, not by the stored state', () => {
    expect(maxOpsAnswerChars(PROJECT)).toBe(120 + 3 * 60 + 5 * 40 + 3 * (20 + 40));
  });

  it('ids are 1-based per prefix', () => {
    expect(opId('T', 0)).toBe('T1');
  });

  it('MEMORY_STATE_OPS_DISABLED=1 turns ops off', () => {
    expect(memoryStateOpsEnabled()).toBe(true);
    process.env.MEMORY_STATE_OPS_DISABLED = '1';
    expect(memoryStateOpsEnabled()).toBe(false);
    delete process.env.MEMORY_STATE_OPS_DISABLED;
  });
});
