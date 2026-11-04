/**
 * Late cross-check × compute policy (branch cp/harness, 2026-09-26):
 *   - revision_material at the late reconcile — material ⇒ rewrite + check
 *     'updated' (changed[]); wording-only ⇒ NO rewrite + check 'checked';
 *   - the user moved on (conversation_moved) — a material change posts an
 *     ADDENDUM under the newer turn (never a rewrite of the older bubble);
 *     no verdict function = card only;
 *   - every terminal outcome persists metadata.check (interrupted on abandon /
 *     failure / no draft) and fires onOutcome once;
 *   - no decideRevision injected ⇒ today's byte rule (any change rewrites).
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockPrisma: any = {
  crossModelMessage: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(async (q: any) => q), create: jest.fn(async (q: any) => ({ id: 'addendum-1', ...q.data })) },
  crossModelChat: { update: jest.fn(async () => ({})) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('../platform/loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

import { runLateCrossCheck, abandonPendingLateCrossChecks, CHECK_ADDENDUM_HEADER } from './late-crosscheck';
import { CHECK_ADDENDUM_KIND } from './compute-policy-wiring';

const NOW = new Date('2026-09-26T20:36:15.000Z');
const ROW = {
  id: 'msg-1', chatId: 'chat-1',
  content: 'The fee is $30 per month.',
  metadata: { mode: 'thinking', engine: 'agent', models: {}, followUps: ['Compare plans'], pendingCrossCheck: true, check: { state: 'checking' } },
  parts: [{ type: 'text', text: 'The fee is $30 per month.' }],
};
const RECONCILED_MATERIAL = 'The fee is $35 per month.\n\n[FOLLOWUPS]\n- Compare plans\n[/FOLLOWUPS]';
const RECONCILED_WORDING = 'The fee is $30 a month.\n\n[FOLLOWUPS]\n- Compare plans\n[/FOLLOWUPS]';

function input(over: Partial<Parameters<typeof runLateCrossCheck>[0]> = {}) {
  return {
    chatId: 'chat-1', messageId: 'msg-1', question: 'what does it cost?', draft: ROW.content,
    model: 'kimi-k3', sessionId: 'chat-1', projectId: 'p1', userId: 'u1', userTurnAt: undefined,
    checkersPromise: Promise.resolve('--- Double Checker ---\nIt is $35.'),
    models: {}, cardKey: 'double_checker', startedAt: Date.now() - 1000,
    reconcile: jest.fn(async () => RECONCILED_MATERIAL),
    now: () => NOW,
    ...over,
  };
}
const material = jest.fn(async (prev: string, next: string) => (prev.includes('$30') && next.includes('$35')
  ? { material: true, changed: ['number: $30 → $35'], source: 'diff' as const, decisionId: 'rm-1' }
  : { material: false, changed: [], source: 'gate' as const, decisionId: 'rm-1' }));

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.crossModelMessage.findUnique.mockResolvedValue({ ...ROW });
  mockPrisma.crossModelMessage.findFirst.mockResolvedValue({ id: 'msg-1' });
});

describe('revision_material at the late reconcile', () => {
  it('MATERIAL ⇒ revised: content rewritten, revision.changed[], metadata.check updated with changed[], onOutcome fires once', async () => {
    const onOutcome = jest.fn();
    const out = await runLateCrossCheck(input({ decideRevision: material, onOutcome }));
    expect(out.outcome).toBe('revised');
    const upd = mockPrisma.crossModelMessage.update.mock.calls[0][0];
    expect(upd.data.content).toBe('The fee is $35 per month.');
    expect(upd.data.metadata.check).toMatchObject({ state: 'updated', changed: ['number: $30 → $35'], verdict: { material: true, source: 'diff', decisionId: 'rm-1' } });
    expect(upd.data.metadata.revision).toMatchObject({ reason: 'double_checker', changed: ['number: $30 → $35'], previousContent: ROW.content });
    expect(upd.data.metadata.pendingCrossCheck).toBe(false);
    expect(onOutcome).toHaveBeenCalledTimes(1);
    expect(onOutcome.mock.calls[0][0]).toMatchObject({ outcome: 'revised', check: { state: 'updated' }, verdict: { material: true } });
  });

  it('WORDING-ONLY ⇒ unchanged: NO rewrite, metadata.check checked, the delivered text stands', async () => {
    const onOutcome = jest.fn();
    const out = await runLateCrossCheck(input({ reconcile: jest.fn(async () => RECONCILED_WORDING), decideRevision: material, onOutcome }));
    expect(out.outcome).toBe('unchanged');
    expect(mockPrisma.crossModelMessage.update).toHaveBeenCalledTimes(1);
    const upd = mockPrisma.crossModelMessage.update.mock.calls[0][0];
    expect(upd.data.content).toBeUndefined();
    expect(upd.data.metadata.check).toMatchObject({ state: 'checked', verdict: { material: false, source: 'gate' } });
    expect(onOutcome.mock.calls[0][0]).toMatchObject({ outcome: 'unchanged', check: { state: 'checked' } });
  });

  it('cp/labels: a verdict that carries the gate\'s stash persists its COMPACT decision on metadata.check.verdict.decision (challengers dropped) so a later thumbs / tap can label revision_material; a diff verdict carries none', async () => {
    const stash = { id: 'rm-9', purpose: 'revision_material', mode: 'shadow', backend: 'TypeSafe Jev', answers: { material: { type: 'noul', noul: 0.2 } }, decidedAt: '2026-09-26T20:00:00Z', calibrated: true, challengers: [{ ok: true, answers: {} }] };
    const gateVerdict = jest.fn(async () => ({ material: false, changed: [], source: 'gate' as const, decisionId: 'rm-9', mode: 'shadow' as const, stash }));
    await runLateCrossCheck(input({ reconcile: jest.fn(async () => RECONCILED_WORDING), decideRevision: gateVerdict }));
    const upd = mockPrisma.crossModelMessage.update.mock.calls[0][0];
    expect(upd.data.metadata.check.verdict).toEqual({
      material: false, source: 'gate', decisionId: 'rm-9',
      decision: { id: 'rm-9', purpose: 'revision_material', mode: 'shadow', backend: 'TypeSafe Jev', answers: { material: { type: 'noul', noul: 0.2 } }, decidedAt: '2026-09-26T20:00:00Z', calibrated: true },
    });
    jest.clearAllMocks();
    mockPrisma.crossModelMessage.findUnique.mockResolvedValue({ ...ROW });
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue({ id: 'msg-1' });
    await runLateCrossCheck(input({ decideRevision: material }));
    expect(mockPrisma.crossModelMessage.update.mock.calls[0][0].data.metadata.check.verdict).toEqual({ material: true, source: 'diff', decisionId: 'rm-1' });
  });

  it('drafts_agree label semantics (2026-09-26): a diff verdict\'s `contradicts` rides the onOutcome verdict untouched (the label reads it; the rewrite still follows `material`)', async () => {
    const onOutcome = jest.fn();
    const additionsOnly = jest.fn(async () => ({ material: true, changed: ['number: +$20'], source: 'diff' as const, contradicts: false }));
    const out = await runLateCrossCheck(input({ decideRevision: additionsOnly, onOutcome }));
    expect(out.outcome).toBe('revised');
    expect(onOutcome.mock.calls[0][0]).toMatchObject({ outcome: 'revised', verdict: { material: true, source: 'diff', contradicts: false } });
    // Audit 2026-10-06 T6-2: the direction-aware flag is persisted on the row too (queryable additions-only reconciles).
    expect(mockPrisma.crossModelMessage.update.mock.calls[0][0].data.metadata.check.verdict).toEqual({ material: true, source: 'diff', contradicts: false });
    expect(mockRecordLoopMetric.mock.calls.find((c: any[]) => c[0]?.kind === 'crosscheck_late_reconcile')?.[0].meta).toMatchObject({ material: true, verdictSource: 'diff', contradicts: false });
  });

  it('audit gate-runtime-4: the crosscheck_late_reconcile row carries the verdict (material / verdictSource / decisionId) for one-query readouts; no verdict ⇒ no such keys', async () => {
    await runLateCrossCheck(input({ decideRevision: material }));
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'crosscheck_late_reconcile',
      meta: expect.objectContaining({ outcome: 'revised', material: true, verdictSource: 'diff', decisionId: 'rm-1' }),
    }));
    jest.clearAllMocks();
    mockPrisma.crossModelMessage.findUnique.mockResolvedValue({ ...ROW });
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue({ id: 'msg-1' });
    await runLateCrossCheck(input({ reconcile: jest.fn(async () => '') }));
    const meta = mockRecordLoopMetric.mock.calls[0][0].meta;
    expect(meta.outcome).toBe('reconcile_failed');
    expect(meta).not.toHaveProperty('material');
    expect(meta).not.toHaveProperty('verdictSource');
  });

  it('no decideRevision injected ⇒ today\'s byte rule: any change rewrites (fail-open to the pre-policy behaviour)', async () => {
    const out = await runLateCrossCheck(input({ reconcile: jest.fn(async () => RECONCILED_WORDING) }));
    expect(out.outcome).toBe('revised');
    expect(mockPrisma.crossModelMessage.update.mock.calls[0][0].data.content).toBe('The fee is $30 a month.');
  });

  it('a THROWING verdict falls back to material (rewrite) — never a lost draft', async () => {
    const out = await runLateCrossCheck(input({ decideRevision: jest.fn(async () => { throw new Error('gate down'); }) }));
    expect(out.outcome).toBe('revised');
  });
});

describe('the user moved on (conversation_moved)', () => {
  beforeEach(() => mockPrisma.crossModelMessage.findFirst.mockResolvedValue({ id: 'msg-9' })); // a newer row exists

  it('MATERIAL change ⇒ an ADDENDUM message under the newer turn; the older bubble is never rewritten; check updated on the original with addendumMessageId', async () => {
    const onOutcome = jest.fn();
    const out = await runLateCrossCheck(input({ decideRevision: material, onOutcome }));
    expect(out.outcome).toBe('addendum');
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    const created = mockPrisma.crossModelMessage.create.mock.calls[0][0].data;
    expect(created).toMatchObject({ chatId: 'chat-1', role: 'assistant' });
    expect(created.content.startsWith(CHECK_ADDENDUM_HEADER)).toBe(true);
    expect(created.content).toContain('The fee is $35 per month.');
    expect(created.metadata).toMatchObject({ kind: CHECK_ADDENDUM_KIND, addendumFor: 'msg-1', check: { state: 'updated', changed: ['number: $30 → $35'] } });
    // the original row: card-only update, content untouched, check updated + addendum link
    const upd = mockPrisma.crossModelMessage.update.mock.calls.find((c: any) => c[0].where.id === 'msg-1')[0];
    expect(upd.data.content).toBeUndefined();
    expect(upd.data.metadata.check).toMatchObject({ state: 'updated', addendumMessageId: 'addendum-1' });
    expect(onOutcome.mock.calls[0][0]).toMatchObject({ outcome: 'addendum', addendumMessageId: 'addendum-1' });
  });

  // Audit 2026-10-06 T6-2 (schooltime F2 / others.md F3): with the REAL verdict function, a reconcile that only
  // re-stamps UTC reads or adds detail posts NO "Update to an earlier answer" addendum; a changed claim still does.
  it('audit 2026-10-06: the real decideRevisionMaterial — stamp drift / additions-only ⇒ NO addendum ("Checked ✓"); a replaced number ⇒ addendum; the kill switch restores the addendum', async () => {
    const { decideRevisionMaterial } = jest.requireActual('../platform/compute-policy-gate');
    const real = (p: string, n: string) => decideRevisionMaterial(p, n);
    const supervisorRow = { ...ROW, content: 'All 3 lanes idle (read 00:29Z). VLAN up.', parts: [{ type: 'text', text: 'All 3 lanes idle (read 00:29Z). VLAN up.' }] };
    mockPrisma.crossModelMessage.findUnique.mockResolvedValue({ ...supervisorRow });
    const drift = 'All 3 lanes idle (read 00:31Z). VLAN up; MTU 9000 on 4 ports.';
    let out = await runLateCrossCheck(input({ draft: supervisorRow.content, reconcile: jest.fn(async () => drift), decideRevision: real }));
    expect(out.outcome).toBe('conversation_moved');
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.update.mock.calls[0][0].data.metadata.check).toMatchObject({ state: 'checked', verdict: { material: false, source: 'diff', contradicts: false } });
    jest.clearAllMocks();
    mockPrisma.crossModelMessage.findUnique.mockResolvedValue({ ...supervisorRow });
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue({ id: 'msg-9' });
    out = await runLateCrossCheck(input({ draft: supervisorRow.content, reconcile: jest.fn(async () => 'All 2 lanes idle (read 00:31Z). VLAN up.'), decideRevision: real }));
    expect(out.outcome).toBe('addendum');
    process.env.REVISION_MATERIAL_CONTRADICTS_ONLY_DISABLED = '1';
    try {
      jest.clearAllMocks();
      mockPrisma.crossModelMessage.findUnique.mockResolvedValue({ ...supervisorRow });
      mockPrisma.crossModelMessage.findFirst.mockResolvedValue({ id: 'msg-9' });
      out = await runLateCrossCheck(input({ draft: supervisorRow.content, reconcile: jest.fn(async () => drift), decideRevision: real }));
      expect(out.outcome).toBe('addendum');
    } finally { delete process.env.REVISION_MATERIAL_CONTRADICTS_ONLY_DISABLED; }
  });

  it('WORDING-ONLY change ⇒ no addendum, conversation_moved card-only, check checked', async () => {
    const out = await runLateCrossCheck(input({ reconcile: jest.fn(async () => RECONCILED_WORDING), decideRevision: material }));
    expect(out.outcome).toBe('conversation_moved');
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.update.mock.calls[0][0].data.metadata.check).toMatchObject({ state: 'checked' });
  });

  it('no verdict function ⇒ no reconcile pass, card only — and the pill reads INTERRUPTED, never "Checked ✓" (review M7)', async () => {
    const reconcile2 = jest.fn(async () => RECONCILED_MATERIAL);
    expect((await runLateCrossCheck(input({ reconcile: reconcile2 }))).outcome).toBe('conversation_moved');
    expect(reconcile2).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.update.mock.calls[0][0].data.metadata.check).toMatchObject({ state: 'interrupted' });
  });

  it('the reconcile resolving EMPTY after the user moved on ⇒ interrupted (with the reason on the card), not checked', async () => {
    const out = await runLateCrossCheck(input({ reconcile: jest.fn(async () => ''), decideRevision: material }));
    expect(out.outcome).toBe('conversation_moved');
    const meta = mockPrisma.crossModelMessage.update.mock.calls[0][0].data.metadata;
    expect(meta.check).toMatchObject({ state: 'interrupted' });
    expect(meta.crossCheck).toMatchObject({ outcome: 'conversation_moved', reason: 'reconcile resolved empty' });
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
  });

  it('a MATERIAL change whose addendum failed to persist ⇒ interrupted (the user never received the correction)', async () => {
    mockPrisma.crossModelMessage.create.mockRejectedValueOnce(new Error('db down'));
    const onOutcome = jest.fn();
    const out = await runLateCrossCheck(input({ decideRevision: material, onOutcome }));
    expect(out.outcome).toBe('conversation_moved');
    const meta = mockPrisma.crossModelMessage.update.mock.calls[0][0].data.metadata;
    expect(meta.check).toMatchObject({ state: 'interrupted', verdict: { material: true } });
    expect(meta.crossCheck).toMatchObject({ reason: 'addendum persist failed' });
    expect(onOutcome.mock.calls[0][0]).toMatchObject({ outcome: 'conversation_moved', check: { state: 'interrupted' } });
  });

  it('the reconcile returning the SAME answer after the user moved on ⇒ checked (the check completed with nothing to tell)', async () => {
    const same = jest.fn(async () => `${ROW.content}\n\n[FOLLOWUPS]\n- Compare plans\n[/FOLLOWUPS]`);
    const judge = jest.fn(material);
    const out = await runLateCrossCheck(input({ reconcile: same, decideRevision: judge }));
    expect(out.outcome).toBe('conversation_moved');
    expect(judge).not.toHaveBeenCalled(); // nothing changed — no verdict needed
    expect(mockPrisma.crossModelMessage.update.mock.calls[0][0].data.metadata.check).toMatchObject({ state: 'checked' });
  });
});

describe('interrupted states', () => {
  it('no draft / timeout / failed reconcile ⇒ metadata.check interrupted', async () => {
    const onOutcome = jest.fn();
    expect((await runLateCrossCheck(input({ checkersPromise: Promise.resolve(''), onOutcome }))).outcome).toBe('no_draft');
    expect(mockPrisma.crossModelMessage.update.mock.calls[0][0].data.metadata.check).toMatchObject({ state: 'interrupted' });
    expect(onOutcome.mock.calls[0][0]).toMatchObject({ outcome: 'no_draft', check: { state: 'interrupted' } });
    mockPrisma.crossModelMessage.update.mockClear();
    expect((await runLateCrossCheck(input({ reconcile: jest.fn(async () => '') }))).outcome).toBe('reconcile_failed');
    expect(mockPrisma.crossModelMessage.update.mock.calls[0][0].data.metadata.check).toMatchObject({ state: 'interrupted' });
  });

  it('a shutdown abandon stamps check interrupted beside crossCheck.outcome interrupted', async () => {
    let release!: (v: string) => void;
    const pending = new Promise<string>(r => { release = r; });
    const p = runLateCrossCheck(input({ checkersPromise: pending, maxWaitMs: 60_000 }));
    await new Promise(r => setTimeout(r, 5));
    const n = await abandonPendingLateCrossChecks('deploy');
    expect(n).toBe(1);
    const upd = mockPrisma.crossModelMessage.update.mock.calls[0][0];
    expect(upd.data.metadata).toMatchObject({ pendingCrossCheck: false, crossCheck: { outcome: 'interrupted', reason: 'deploy' }, check: { state: 'interrupted' } });
    release('');
    await p;
  });
});

describe('audit 2026-09-26 (telemetry-readiness-6 / gate-runtime-3 / tests-gaps-6): drafts_agree on the LATE path', () => {
  it('a draft that lands late is judged ONCE before the reconcile; shadow ⇒ the reconcile runs and the verdict rides onOutcome.draftsAgree', async () => {
    const decideAgree = jest.fn(async () => ({ act: false, agree: false, p: 0.2, mode: 'shadow', decisionId: 'da-1' }));
    const onOutcome = jest.fn();
    const reconcile = jest.fn(async () => RECONCILED_MATERIAL);
    const out = await runLateCrossCheck(input({ decideAgree, decideRevision: material, onOutcome, reconcile }));
    expect(out.outcome).toBe('revised');
    expect(decideAgree).toHaveBeenCalledTimes(1);
    expect(decideAgree).toHaveBeenCalledWith(ROW.content, '--- Double Checker ---\nIt is $35.');
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(onOutcome.mock.calls[0][0]).toMatchObject({ outcome: 'revised', draftsAgree: { act: false, p: 0.2, decisionId: 'da-1' } });
  });
  it('act ∧ agree ⇒ the reconcile pass is SKIPPED: outcome unchanged, pill checked, the delivered text stands', async () => {
    const decideAgree = jest.fn(async () => ({ act: true, agree: true, p: 0.95, mode: 'act', decisionId: 'da-2' }));
    const onOutcome = jest.fn();
    const reconcile = jest.fn(async () => RECONCILED_MATERIAL);
    const out = await runLateCrossCheck(input({ decideAgree, decideRevision: material, onOutcome, reconcile }));
    expect(out.outcome).toBe('unchanged');
    expect(reconcile).not.toHaveBeenCalled();
    const upd = mockPrisma.crossModelMessage.update.mock.calls[0][0];
    expect(upd.data.content).toBeUndefined();
    expect(upd.data.metadata.check).toMatchObject({ state: 'checked' });
    expect(onOutcome.mock.calls[0][0]).toMatchObject({ outcome: 'unchanged', draftsAgree: { act: true } });
  });
  it('never two decisions per draft: a pre-started inline reconcile means the inline site already asked — no late ask; no draft ⇒ no ask', async () => {
    const decideAgree = jest.fn(async () => ({ act: false, agree: null, p: null, mode: 'shadow' }));
    await runLateCrossCheck(input({ decideAgree, decideRevision: material, preStartedReconcile: Promise.resolve(RECONCILED_MATERIAL) }));
    expect(decideAgree).not.toHaveBeenCalled();
    await runLateCrossCheck(input({ decideAgree, decideRevision: material, checkersPromise: Promise.resolve('') }));
    expect(decideAgree).not.toHaveBeenCalled();
  });
  it('a throwing decideAgree falls open: the reconcile runs as today', async () => {
    const reconcile = jest.fn(async () => RECONCILED_MATERIAL);
    const out = await runLateCrossCheck(input({ decideAgree: jest.fn(async () => { throw new Error('gate down'); }), decideRevision: material, reconcile }));
    expect(out.outcome).toBe('revised');
    expect(reconcile).toHaveBeenCalledTimes(1);
  });
});