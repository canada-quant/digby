/**
 * Pins the deterministic closure manifest: at-most-once application via the
 * durable claim, only open-ish rows touched (a human reopen wins forever),
 * zero-row updates still claimed (sweep stays O(new entries)), failures retry
 * (claim only after update), never throws — plus the 2026-09-28 additions
 * (backlog audit DOI-27): EVIDENCE-GATED entries close only once fix-state
 * proves the fix live (pending entries stay unclaimed), the adminNote then
 * carries the parseable `[machine-close evidence: …]` block, a `duplicateOf`
 * entry stamps the row's context, the kill switch bypasses the gate, and
 * `dryRun` writes nothing.
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  contextStoreEntry: { findUnique: jest.fn(async () => null), create: jest.fn(async () => ({})) },
  userFeatureRequest: {
    updateMany: jest.fn(async () => ({ count: 1 })),
    findMany: jest.fn(async () => [{ id: 'row-1', userId: 'owner-1', context: { filedBy: 'x' } }]),
    count: jest.fn(async () => 1),
  },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockResolveFixState = jest.fn(async () => ({ fixLive: true, reason: 'merged + deployed (test)' }));
jest.mock('./fix-state', () => ({
  __esModule: true,
  ...jest.requireActual('./fix-state'),
  resolveFixStateFromEvidence: (...a: any[]) => (mockResolveFixState as any)(...a),
}));

import { applyClosureManifest, CLOSURE_MANIFEST, manifestClosePending, renderMachineCloseEvidence } from './closure-manifest';
import { parseClosureEvidenceNote } from './fix-state';

const OPEN_IN = { in: ['open', 'in_progress', 'queued'] };
const evidenceEntries = () => CLOSURE_MANIFEST.filter((e) => e.evidence);
const plainEntries = () => CLOSURE_MANIFEST.filter((e) => !e.evidence);

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.contextStoreEntry.findUnique.mockResolvedValue(null);
  mockPrisma.contextStoreEntry.create.mockResolvedValue({});
  mockPrisma.userFeatureRequest.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.userFeatureRequest.findMany.mockResolvedValue([{ id: 'row-1', userId: 'owner-1', context: { filedBy: 'x' } }]);
  mockPrisma.userFeatureRequest.count.mockResolvedValue(1);
  mockResolveFixState.mockResolvedValue({ fixLive: true, reason: 'merged + deployed (test)' });
});

describe('applyClosureManifest', () => {
  it('applies every unclaimed entry: done + evidence adminNote, open-ish rows only', async () => {
    const r = await applyClosureManifest();
    expect(r.applied).toBe(CLOSURE_MANIFEST.length);
    expect(r.pending).toEqual([]);
    const first = mockPrisma.userFeatureRequest.updateMany.mock.calls[0][0];
    expect(first.where.status).toEqual(OPEN_IN);
    expect(first.data.status).toBe('done');
    expect(first.data.adminNote).toContain('[closed by manifest, evidence-verified]');
    // claim taken per entry
    expect(mockPrisma.contextStoreEntry.create).toHaveBeenCalledTimes(CLOSURE_MANIFEST.length);
  });

  it('already-claimed entries are skipped entirely (at-most-once ever)', async () => {
    mockPrisma.contextStoreEntry.findUnique.mockResolvedValue({ key: 'x' });
    const r = await applyClosureManifest();
    expect(r.applied).toBe(0);
    expect(mockPrisma.userFeatureRequest.updateMany).not.toHaveBeenCalled();
    expect(mockResolveFixState).not.toHaveBeenCalled();
  });

  it('a zero-row update (already done / reopened later) is claimed but never re-closed', async () => {
    mockPrisma.userFeatureRequest.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([]); // no open row anywhere
    const r = await applyClosureManifest();
    expect(r.applied).toBe(0);
    expect(mockPrisma.contextStoreEntry.create).toHaveBeenCalledTimes(CLOSURE_MANIFEST.length);
  });

  it('a failed update leaves the entry UNCLAIMED so the next sweep retries; never throws', async () => {
    mockPrisma.userFeatureRequest.updateMany
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValue({ count: 1 });
    const r = await applyClosureManifest();
    expect(r.applied).toBe(CLOSURE_MANIFEST.length - 1);
    expect(mockPrisma.contextStoreEntry.create).toHaveBeenCalledTimes(CLOSURE_MANIFEST.length - 1);
  });

  it('manifest hygiene: unique 8+ char lowercase-hex prefixes, non-empty notes, well-formed evidence', () => {
    const seen = new Set<string>();
    for (const e of CLOSURE_MANIFEST) {
      expect(e.idPrefix).toMatch(/^[0-9a-f]{8,}$/);
      expect(seen.has(e.idPrefix)).toBe(false);
      seen.add(e.idPrefix);
      expect(e.adminNote.length).toBeGreaterThan(20);
      if (e.evidence) {
        expect(e.evidence.commitSha).toMatch(/^[0-9a-f]{7,40}$/);
        if (e.evidence.prUrl) expect(e.evidence.prUrl).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/);
        if (e.evidence.deployRunId) expect(e.evidence.deployRunId).toMatch(/^\d{4,20}$/);
      }
      if (e.duplicateOf) expect(e.duplicateOf).toMatch(/^[0-9a-f]{8,}$/);
    }
    // The DOI-27 pair is present and evidence-gated on the same fix.
    const pair = CLOSURE_MANIFEST.filter((e) => e.idPrefix === '7acaa7ba' || e.idPrefix === 'd6110694');
    expect(pair).toHaveLength(2);
    expect(pair.every((e) => e.evidence?.commitSha === 'e18c15c4' && e.evidence?.deployRunId === '36472901762')).toBe(true);
    expect(pair.find((e) => e.idPrefix === 'd6110694')?.duplicateOf).toBe('7acaa7ba');
  });
});

describe('applyClosureManifest — evidence-gated entries (audit DOI-27)', () => {
  it('a proven-live fix closes with the parseable machine-close evidence block; a duplicateOf entry stamps the context', async () => {
    const r = await applyClosureManifest();
    expect(r.applied).toBe(CLOSURE_MANIFEST.length);
    // The resolver was consulted once per open row of every evidence entry, with the entry's evidence.
    expect(mockResolveFixState).toHaveBeenCalledTimes(evidenceEntries().length);
    const [row, note] = (mockResolveFixState.mock.calls[0] as any[]);
    expect(row).toEqual({ id: 'row-1', userId: 'owner-1' });
    expect(note).toEqual({ commitSha: 'e18c15c4', prUrl: 'https://github.com/canada-quant/digby/pull/1123', deployRunId: '36472901762' });
    // The 7acaa7ba close: adminNote carries the block fix-state.ts parses back.
    const calls = mockPrisma.userFeatureRequest.updateMany.mock.calls.map((c: any[]) => c[0]);
    const seven = calls.find((c: any) => c.where.id?.startsWith === '7acaa7ba');
    expect(seven.data.status).toBe('done');
    expect(seven.data.adminNote).toContain('[closed by manifest, evidence-verified]');
    expect(parseClosureEvidenceNote(seven.data.adminNote)).toEqual({ commitSha: 'e18c15c4', prUrl: 'https://github.com/canada-quant/digby/pull/1123', deployRunId: '36472901762' });
    // The d6110694 close: per-row update (context merge), duplicateOf + autoDispatch:false, prior context kept.
    const dup = calls.find((c: any) => c.where.id === 'row-1' && c.data.context?.duplicateOf === '7acaa7ba');
    expect(dup).toBeDefined();
    expect(dup.where.status).toEqual(OPEN_IN);
    expect(dup.data.context).toEqual({ filedBy: 'x', duplicateOf: '7acaa7ba', autoDispatch: false });
    expect(parseClosureEvidenceNote(dup.data.adminNote)?.commitSha).toBe('e18c15c4');
  });

  it('a fix NOT proven live leaves the entry PENDING: no update, no claim, reason reported; plain entries still close', async () => {
    mockResolveFixState.mockResolvedValue({ fixLive: false, reason: 'commit e18c15c4 is NOT merged to origin/main (compare status diverged)' });
    const r = await applyClosureManifest();
    expect(r.applied).toBe(plainEntries().length);
    expect(r.pending).toEqual(evidenceEntries().map((e) => ({ idPrefix: e.idPrefix, reason: 'commit e18c15c4 is NOT merged to origin/main (compare status diverged)' })));
    expect(mockPrisma.contextStoreEntry.create).toHaveBeenCalledTimes(plainEntries().length);
    const claimed = mockPrisma.contextStoreEntry.create.mock.calls.map((c: any[]) => c[0]);
    expect(claimed.some((k: any) => JSON.stringify(k).includes('7acaa7ba'))).toBe(false);
    const touched = mockPrisma.userFeatureRequest.updateMany.mock.calls.map((c: any[]) => c[0].where.id?.startsWith ?? c[0].where.id);
    expect(touched).not.toContain('7acaa7ba');
    expect(touched).not.toContain('d6110694');
  });

  it('an evidence entry with NO open row left is claimed without consulting the resolver (nothing to prove)', async () => {
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([]);
    mockPrisma.userFeatureRequest.updateMany.mockResolvedValue({ count: 0 });
    const r = await applyClosureManifest();
    expect(r.pending).toEqual([]);
    expect(mockResolveFixState).not.toHaveBeenCalled();
    expect(mockPrisma.contextStoreEntry.create).toHaveBeenCalledTimes(CLOSURE_MANIFEST.length);
    expect(r.applied).toBe(0);
  });

  it('dryRun reports wouldClose + pending and writes NOTHING (no row update, no claim)', async () => {
    mockResolveFixState.mockResolvedValue({ fixLive: false, reason: 'deploy run 36472901762 not concluded yet' });
    const r = await applyClosureManifest({ dryRun: true });
    expect(r.applied).toBe(0);
    expect(r.wouldClose).toHaveLength(plainEntries().length); // count() = 1 open row per plain entry
    expect(r.wouldClose[0]).toEqual({ idPrefix: CLOSURE_MANIFEST[0].idPrefix, rows: 1 });
    expect(r.pending.map((p) => p.idPrefix)).toEqual(evidenceEntries().map((e) => e.idPrefix));
    expect(mockPrisma.userFeatureRequest.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.contextStoreEntry.create).not.toHaveBeenCalled();
  });

  it('renderMachineCloseEvidence round-trips through fix-state.ts parseClosureEvidenceNote (sha lowercased)', () => {
    const note = renderMachineCloseEvidence({ commitSha: 'E18C15C4', prUrl: 'https://github.com/canada-quant/digby/pull/1123', deployRunId: '36472901762' });
    expect(note).toBe('[machine-close evidence: commit e18c15c4; PR https://github.com/canada-quant/digby/pull/1123; deploy run 36472901762]');
    expect(parseClosureEvidenceNote(note)).toEqual({ commitSha: 'e18c15c4', prUrl: 'https://github.com/canada-quant/digby/pull/1123', deployRunId: '36472901762' });
    expect(parseClosureEvidenceNote(renderMachineCloseEvidence({ commitSha: 'abcdef1' }))).toEqual({ commitSha: 'abcdef1' });
    // Ticket cf5f9718 — the repo member round-trips (lowercased by the render,
    // parsed back by fix-state.ts) so the done-bar reads the scope from the
    // audit note itself.
    const noteWithRepo = renderMachineCloseEvidence({ commitSha: 'E18C15C4', repo: 'Acme-Corp/Widgets', prUrl: 'https://github.com/canada-quant/example-repo/pull/184', deployRunId: '36472901762' });
    expect(noteWithRepo).toBe('[machine-close evidence: commit e18c15c4; repo acme-corp/widgets; PR https://github.com/canada-quant/example-repo/pull/184; deploy run 36472901762]');
    expect(parseClosureEvidenceNote(noteWithRepo)).toEqual({ commitSha: 'e18c15c4', repo: 'acme-corp/widgets', prUrl: 'https://github.com/canada-quant/example-repo/pull/184', deployRunId: '36472901762' });
  });
});

describe('manifestClosePending — the fresh ticket-lane guard (2026-10-06)', () => {
  const prefix = CLOSURE_MANIFEST[CLOSURE_MANIFEST.length - 1].idPrefix;

  it('true while an UNAPPLIED entry names the ticket (its fix shipped — no lane), false once applied or with no entry', async () => {
    mockPrisma.contextStoreEntry.findUnique.mockResolvedValue(null);
    expect(await manifestClosePending(`${prefix}-rest-of-id`)).toBe(true);
    expect(mockPrisma.contextStoreEntry.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { namespacePath_key: { namespacePath: 'ticket-manifest:applied', key: prefix } },
    }));
    mockPrisma.contextStoreEntry.findUnique.mockResolvedValue({ key: prefix });
    expect(await manifestClosePending(`${prefix}-rest-of-id`)).toBe(false); // applied, then reopened: dispatchable
    expect(await manifestClosePending('ffffffff-not-in-the-manifest')).toBe(false);
  });

  it('a lookup failure fails SAFE (no lane this drain)', async () => {
    mockPrisma.contextStoreEntry.findUnique.mockRejectedValue(new Error('db down'));
    expect(await manifestClosePending(`${prefix}-rest-of-id`)).toBe(true);
  });
});
