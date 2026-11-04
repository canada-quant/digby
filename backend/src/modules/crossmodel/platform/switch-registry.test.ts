/**
 * Switch registry (build 2026-10-08 S-1) — the pure checks (a)–(d) over fixture scans. The CI
 * check over the REAL repo is backend/scripts/switch-registry.test.ts.
 */
import {
  SWITCHES, SWITCH_COUNT_LEDGER, NF_INERT, addDays, defaultKindFor, expiringSoon, isForwarded, staleForwards, switchRegistrySummary,
  switchRegistryViolations, type SwitchCountLine, type SwitchScanInput, type SwitchSpec,
} from './switch-registry';

const TODAY = '2026-10-08';

function scanOf(over: Partial<{ backend: Record<string, string[]>; frontend: Record<string, string[]>; compBackend: string[]; compWorker: string[]; feArgs: string[]; dockerArgs: string[] }> = {}): SwitchScanInput {
  return {
    backend: new Map(Object.entries(over.backend ?? {})),
    frontend: new Map(Object.entries(over.frontend ?? {})),
    compose: { backend: new Set(over.compBackend ?? []), worker: new Set(over.compWorker ?? []), frontendArgs: new Set(over.feArgs ?? []) },
    frontendDockerArgs: new Set(over.dockerArgs ?? []),
  };
}
const row = (over: Partial<SwitchSpec> & { name: string }): SwitchSpec => ({ area: 'coding', kind: 'release', added: '2026-10-01', expires: '2026-11-12', ...over });
const ledger = (count: number): SwitchCountLine[] => [{ on: TODAY, count, why: 'baseline' }];
const kinds = (v: { kind: string }[]) => v.map(x => x.kind).sort();

describe('switch registry — pure checks', () => {
  it('a clean registry: read, forwarded (backend OR worker), dated, counted → no violations', () => {
    const reg = [row({ name: 'A_DISABLED' }), row({ name: 'B_ENFORCE', kind: 'opt-in', expires: undefined }), row({ name: 'C_DISABLED', kind: 'ops', expires: undefined })];
    const scan = scanOf({ backend: { A_DISABLED: ['x.ts'], B_ENFORCE: ['y.ts'], C_DISABLED: ['z.ts'] }, compBackend: ['A_DISABLED', 'C_DISABLED'], compWorker: ['B_ENFORCE'] });
    expect(switchRegistryViolations(scan, TODAY, reg, ledger(3))).toEqual([]);
  });

  it('(a) a switch the code reads with no row → unregistered; a row nothing reads → unread', () => {
    const scan = scanOf({ backend: { NEW_THING_DISABLED: ['coding/agent.ts'] }, compBackend: ['NEW_THING_DISABLED'] });
    const v = switchRegistryViolations(scan, TODAY, [row({ name: 'GONE_DISABLED', notForwarded: NF_INERT })], ledger(1));
    expect(kinds(v)).toEqual(['unread', 'unregistered']);
    expect(v.find(x => x.kind === 'unregistered')!.message).toMatch(/npm run switches:sync/);
  });

  it('(b) unforwarded without a reason fails; a stale notForwarded on a forwarded switch fails', () => {
    const reg = [row({ name: 'A_DISABLED' }), row({ name: 'B_DISABLED', notForwarded: NF_INERT })];
    const scan = scanOf({ backend: { A_DISABLED: ['x.ts'], B_DISABLED: ['x.ts'] }, compWorker: ['B_DISABLED'] });
    const v = switchRegistryViolations(scan, TODAY, reg, ledger(2));
    expect(kinds(v)).toEqual(['forwarded_marked', 'not_forwarded']);
    expect(v.find(x => x.kind === 'not_forwarded')!.name).toBe('A_DISABLED');
  });

  it('(b) a NEXT_PUBLIC switch needs the compose build arg AND the Dockerfile ARG', () => {
    const reg = [row({ name: 'NEXT_PUBLIC_X_DISABLED', side: 'frontend', area: 'frontend' })];
    const read = { frontend: { NEXT_PUBLIC_X_DISABLED: ['frontend/lib/x.ts'] } };
    expect(kinds(switchRegistryViolations(scanOf({ ...read, feArgs: ['NEXT_PUBLIC_X_DISABLED'] }), TODAY, reg, ledger(1)))).toEqual(['half_forwarded']);
    expect(kinds(switchRegistryViolations(scanOf({ ...read }), TODAY, reg, ledger(1)))).toEqual(['not_forwarded']);
    expect(switchRegistryViolations(scanOf({ ...read, feArgs: ['NEXT_PUBLIC_X_DISABLED'], dockerArgs: ['NEXT_PUBLIC_X_DISABLED'] }), TODAY, reg, ledger(1))).toEqual([]);
    // a backend service listing a NEXT_PUBLIC name does not forward a build-time switch
    expect(isForwarded(reg[0], scanOf({ compBackend: ['NEXT_PUBLIC_X_DISABLED'] }))).toBe(false);
  });

  it('(c) a release switch past expires fails with the delete-or-extend fix; ops never expire; release without expires fails', () => {
    const scan = scanOf({ backend: { A_DISABLED: ['x.ts'], B_DISABLED: ['x.ts'], C_DISABLED: ['x.ts'] }, compBackend: ['A_DISABLED', 'B_DISABLED', 'C_DISABLED'] });
    const reg = [row({ name: 'A_DISABLED', expires: '2026-10-07' }), row({ name: 'B_DISABLED', kind: 'ops', expires: undefined }), row({ name: 'C_DISABLED', expires: undefined })];
    const v = switchRegistryViolations(scan, TODAY, reg, ledger(3));
    expect(kinds(v)).toEqual(['expired', 'missing_expiry']);
    expect(v.find(x => x.kind === 'expired')!.message).toMatch(/inline its default.*extend `expires`/s);
    // the expiry day itself is still valid
    expect(switchRegistryViolations(scan, '2026-10-07', [reg[0], reg[1], row({ name: 'C_DISABLED' })], ledger(3))).toEqual([]);
  });

  it('(d) a silent raise fails; a justified raise passes; a removal must lower the ledger', () => {
    const scan = scanOf({ backend: { A_DISABLED: ['x.ts'], B_DISABLED: ['x.ts'] }, compBackend: ['A_DISABLED', 'B_DISABLED'] });
    const reg = [row({ name: 'A_DISABLED' }), row({ name: 'B_DISABLED' })];
    expect(kinds(switchRegistryViolations(scan, TODAY, reg, ledger(1)))).toEqual(['count_mismatch']);
    const silent: SwitchCountLine[] = [{ on: TODAY, count: 1, why: 'baseline' }, { on: TODAY, count: 2, why: 'more' }];
    expect(kinds(switchRegistryViolations(scan, TODAY, reg, silent))).toEqual(['raise_unjustified']);
    const justified: SwitchCountLine[] = [{ on: TODAY, count: 1, why: 'baseline' }, { on: TODAY, count: 2, why: 'B_DISABLED: an external provider kill switch the owner asked for' }];
    expect(switchRegistryViolations(scan, TODAY, reg, justified)).toEqual([]);
    const removal: SwitchCountLine[] = [{ on: TODAY, count: 3, why: 'baseline' }, { on: TODAY, count: 2, why: 'removed C' }];
    expect(switchRegistryViolations(scan, TODAY, reg, removal)).toEqual([]);
    expect(kinds(switchRegistryViolations(scan, TODAY, reg, []))).toEqual(['ledger_malformed']);
  });

  it('format: duplicates, order, suffix, kind, dates, ops-with-expiry, frontend side', () => {
    const scan = scanOf({ backend: { B_DISABLED: ['x.ts'] }, compBackend: ['B_DISABLED'] });
    const reg = [row({ name: 'B_DISABLED' }), row({ name: 'B_DISABLED' }), row({ name: 'A_DISABLED', kind: 'ops' as const, notForwarded: 'short' }), row({ name: 'NOT_A_SWITCH', added: '10/08' })];
    const v = switchRegistryViolations(scan, TODAY, reg, ledger(4));
    expect(v.filter(x => x.kind === 'duplicate')).toHaveLength(1);
    expect(v.filter(x => x.kind === 'unsorted').length).toBeGreaterThan(0);
    const malformed = v.filter(x => x.kind === 'malformed').map(x => x.message).join(' | ');
    expect(malformed).toMatch(/never expires/);
    expect(malformed).toMatch(/notForwarded must say why/);
    expect(malformed).toMatch(/must end _DISABLED/);
    expect(malformed).toMatch(/added '10\/08'/);
  });

  it('staleForwards: compose lines for switches no code reads (backend/worker env + frontend args), never other env', () => {
    const scan = scanOf({ backend: { LIVE_DISABLED: ['x.ts'] }, frontend: { NEXT_PUBLIC_LIVE_DISABLED: ['f.ts'] },
      compBackend: ['LIVE_DISABLED', 'GONE_DISABLED', 'DATABASE_URL'], compWorker: ['GONE_ENFORCE'], feArgs: ['NEXT_PUBLIC_LIVE_DISABLED', 'NEXT_PUBLIC_GONE_DISABLED', 'NEXT_PUBLIC_API_URL'] });
    expect(staleForwards(scan)).toEqual(['GONE_DISABLED', 'GONE_ENFORCE', 'NEXT_PUBLIC_GONE_DISABLED']);
  });

  it('helpers: addDays, defaultKindFor, expiringSoon, summary', () => {
    expect(addDays('2026-10-08', 21)).toBe('2026-10-29');
    expect(addDays('2026-12-25', 10)).toBe('2027-01-04');
    expect(defaultKindFor('X_ENFORCE')).toBe('opt-in');
    expect(defaultKindFor('X_ENABLED')).toBe('opt-in');
    expect(defaultKindFor('X_DISABLED')).toBe('release');
    const reg = [row({ name: 'A_DISABLED', expires: '2026-10-10' }), row({ name: 'B_DISABLED', expires: '2026-12-01' }), row({ name: 'C_DISABLED', kind: 'ops', expires: undefined })];
    expect(expiringSoon(TODAY, 14, reg).map(s => s.name)).toEqual(['A_DISABLED']);
    expect(switchRegistrySummary(reg)).toEqual({ total: 3, byKind: { release: 2, ops: 1, 'opt-in': 0 }, notForwarded: 0, frontend: 0 });
  });
});

describe('switch registry — dynamic families', () => {
  const fam = [{ pattern: 'X_<*>_DISABLED', area: 'p', kind: 'release' as const, added: '2026-10-01', expires: '2026-11-12', notForwarded: NF_INERT }];
  it('a built family needs a row; a row must still be built; release needs expires; past expiry fails', () => {
    const base = scanOf();
    expect(switchRegistryViolations({ ...base, families: new Map([['X_<*>_DISABLED', ['f.ts']]]) }, TODAY, [], ledger(0), fam)).toEqual([]);
    expect(kinds(switchRegistryViolations({ ...base, families: new Map([['Y_<*>_ENABLED', ['f.ts']]]) }, TODAY, [], ledger(0), fam))).toEqual(['unread', 'unregistered']);
    expect(kinds(switchRegistryViolations({ ...base, families: new Map([['X_<*>_DISABLED', ['f.ts']]]) }, '2026-11-13', [], ledger(0), fam))).toEqual(['expired']);
    expect(kinds(switchRegistryViolations({ ...base, families: new Map([['X_<*>_DISABLED', ['f.ts']]]) }, TODAY, [], ledger(0), [{ ...fam[0], expires: undefined }]))).toEqual(['missing_expiry']);
  });
});

describe('switch registry — the shipped table', () => {
  it('is sorted, unique, every row well-formed, and the ledger ends at the row count', () => {
    const names = SWITCHES.map(s => s.name);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual(names);
    expect(SWITCH_COUNT_LEDGER[SWITCH_COUNT_LEDGER.length - 1].count).toBe(SWITCHES.length);
    // Run the format checks only (empty scan ⇒ every row reads 'unread'; ignore those).
    const v = switchRegistryViolations(scanOf(), TODAY).filter(x => !['unread', 'count_mismatch', 'expired'].includes(x.kind));
    expect(v).toEqual([]);
  });

  it('every release switch carries an expiry; no ops switch does', () => {
    for (const s of SWITCHES) {
      if (s.kind === 'release') expect(s.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (s.kind === 'ops') expect(s.expires).toBeUndefined();
    }
  });
});
