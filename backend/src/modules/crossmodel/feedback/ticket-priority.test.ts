/**
 * ticket-priority (9dacab1a) — the drain-time scoring + dependency leaf,
 * pinned PURE (no Prisma / Redis mocks: every input is a plain row shape).
 *
 * Pins:
 *  - the scoring model: priority dominates, occurrences/age accrue, reopened
 *    rows jump, multi-unblock rows jump harder;
 *  - starvation relief: an old default-priority row OUTRANKS fresh default
 *    rows but never a priority raise;
 *  - sortTicketsByScore: score desc, createdAt asc within a score, never
 *    mutates the input;
 *  - the kill switch reverts ordering byte-for-byte to the static key;
 *  - dependency reads: wait on open blockers, auto-unblock on every closed
 *    spelling, unknown blocker reads unblocked;
 *  - setTicketDependencies: self 400, unknown 404, cycle 409, cap 20,
 *    normalize (trim/dupe/drop-empty), null clears;
 *  - setTicketDependencies CANONICALIZATION (F2): a prefix input resolves
 *    through loadTicket to its CANONICAL full id before it is stored (the
 *    drain's blocker index keys on full ids), a prefix self-reference still
 *    400s, a prefix cycle still 409s, and an unknown/ambiguous prefix 404s.
 */

import {
  AGE_POINT_DAYS, AGE_POINTS_CAP, DEPENDENCY_WAIT_NOTE_PREFIX, OCCURRENCES_CAP, REOPEN_BONUS, UNBLOCK_POINTS_EACH,
  dependencyWaitNote, dispatchScoringDisabled, isClosedTicketRow, isPostDeployReopened,
  openDependencyBlockers, scoreTicketRow, setTicketDependencies, sortTicketsByScore,
  ticketAgePoints, ticketDependsOnIds, ticketOccurrences, ticketUnblockCount,
  type ScorableTicketRow,
} from './ticket-priority';

const DAY = 24 * 3600_000;
const NOW = Date.parse('2026-10-18T12:00:00Z');

function row(over: Partial<ScorableTicketRow> & { id: string }): ScorableTicketRow {
  return {
    priority: 0, status: 'open', createdAt: new Date(NOW - DAY),
    context: {}, ...over,
  };
}

describe('ticket-priority — scoring model (9dacab1a)', () => {
  it('a priority raise outweighs every accrual the row can pick up on its own', () => {
    // Widest possible SELF-accrual stack: occurrences at cap, age at cap,
    // post-deploy reopened — no unblock leverage (that is the one term
    // allowed to cross a band, pinned separately).
    const maxAccrual = OCCURRENCES_CAP + AGE_POINTS_CAP + REOPEN_BONUS; // 8 + 3 + 3 = 14
    const starved = scoreTicketRow(
      row({ id: 'a', priority: 0, status: 'reopened', createdAt: new Date(NOW - 400 * DAY), context: { occurrences: 99 } }),
      { now: NOW, unblockCount: 0 },
    );
    const raised = scoreTicketRow(row({ id: 'b', priority: 1, createdAt: new Date(NOW) }), { now: NOW });
    expect(starved).toBe(maxAccrual); // 0*15 + 8 + 3 + 3 = 14
    expect(raised).toBe(15 + 1); // 1*15 + 1(default occurrences) = 16
    expect(raised).toBeGreaterThan(starved); // 16 > 14 — one raise beats all self-accrual
  });

  it('occurrences accrue capped: 99 incidents score the same as OCCURRENCES_CAP', () => {
    const score99 = scoreTicketRow(row({ id: 'a', context: { occurrences: 99 } }), { now: NOW });
    const score8 = scoreTicketRow(row({ id: 'b', context: { occurrences: OCCURRENCES_CAP } }), { now: NOW });
    expect(score99).toBe(score8);
    expect(ticketOccurrences({ context: { occurrences: 3.7 } })).toBe(3); // floors
    expect(ticketOccurrences({ context: {} })).toBe(1); // a row with no bumps is ONE incident
    expect(ticketOccurrences({ context: { occurrences: 'lots' } })).toBe(1); // non-numeric reads default
  });

  it('age accrues one point per AGE_POINT_DAYS, capped at AGE_POINTS_CAP', () => {
    expect(ticketAgePoints(new Date(NOW - 1 * DAY), NOW)).toBe(0); // 1 day: no point
    expect(ticketAgePoints(new Date(NOW - AGE_POINT_DAYS * DAY), NOW)).toBe(1); // exactly 7 days
    expect(ticketAgePoints(new Date(NOW - 30 * DAY), NOW)).toBe(4 - 1 >= AGE_POINTS_CAP ? AGE_POINTS_CAP : 4 - 1); // 30d → floor(30/7)=4 → capped 3
    expect(ticketAgePoints(new Date(NOW - 400 * DAY), NOW)).toBe(AGE_POINTS_CAP);
    expect(ticketAgePoints(new Date(NOW + DAY), NOW)).toBe(0); // future createdAt never goes negative
    expect(ticketAgePoints(undefined, NOW)).toBe(0); // missing createdAt earns nothing
    expect(ticketAgePoints('not-a-date', NOW)).toBe(0);
  });

  it('a post-deploy-reopened row earns REOPEN_BONUS (status OR verification.lastVerdict)', () => {
    expect(isPostDeployReopened(row({ id: 'a', status: 'reopened' }))).toBe(true);
    expect(isPostDeployReopened(row({ id: 'b', context: { verification: { lastVerdict: 'reopened' } } }))).toBe(true);
    expect(isPostDeployReopened(row({ id: 'c', status: 'open', context: { verification: { lastVerdict: 'deployed_verified' } } }))).toBe(false);
    expect(isPostDeployReopened(row({ id: 'd', status: 'in_progress' }))).toBe(false);
    const base = scoreTicketRow(row({ id: 'e' }), { now: NOW });
    const reopened = scoreTicketRow(row({ id: 'f', status: 'reopened' }), { now: NOW });
    expect(reopened - base).toBe(REOPEN_BONUS);
  });

  it('unblock-count is leverage: each waiting dependent adds UNBLOCK_POINTS_EACH', () => {
    const rows = [
      row({ id: 'blocker' }),
      row({ id: 'd1', context: { dependsOnTicketIds: ['blocker'] } }),
      row({ id: 'd2', context: { dependsOnTicketIds: ['blocker'] } }),
      row({ id: 'd3', context: { dependsOnTicketIds: ['blocker'] } }),
      row({ id: 'unrelated' }),
    ];
    expect(ticketUnblockCount('blocker', rows)).toBe(3);
    expect(ticketUnblockCount('unrelated', rows)).toBe(0);
    const single = scoreTicketRow(row({ id: 'x' }), { now: NOW, unblockCount: 1 });
    const triple = scoreTicketRow(row({ id: 'y' }), { now: NOW, unblockCount: 3 });
    expect(triple - single).toBe(2 * UNBLOCK_POINTS_EACH);
    // A CLOSED dependent never counts (its unblock is moot)…
    expect(ticketUnblockCount('blocker', [
      row({ id: 'blocker' }),
      row({ id: 'closed-dep', status: 'done', context: { dependsOnTicketIds: ['blocker'] } }),
    ])).toBe(0);
    // …and neither does a self-reference.
    expect(ticketUnblockCount('blocker', [row({ id: 'blocker', context: { dependsOnTicketIds: ['blocker'] } })])).toBe(0);
  });

  it('STRAVATION RELIEF: an old default-priority row outranks fresh default rows', () => {
    // The exact shape the ticket names: a low-priority tail that the static
    // priority-first fetch never even scanned. Once IN the scan, scoring
    // lifts it above fresh default-priority work (age + occurrences).
    const fresh = row({ id: 'fresh', priority: 0, createdAt: new Date(NOW - 1 * DAY) });
    const starved = row({ id: 'starved', priority: 0, createdAt: new Date(NOW - 90 * DAY), context: { occurrences: 5 } });
    expect(scoreTicketRow(starved, { now: NOW })).toBeGreaterThan(scoreTicketRow(fresh, { now: NOW }));
    // …but a P2 row still outranks it (priority intent dominates).
    const p2 = row({ id: 'p2', priority: 2, createdAt: new Date(NOW - 1 * DAY) });
    expect(scoreTicketRow(p2, { now: NOW })).toBeGreaterThan(scoreTicketRow(starved, { now: NOW }));
  });

  it('sortTicketsByScore: score desc, createdAt asc within a score, input never mutated', () => {
    const input = [
      row({ id: 'older-same-score', createdAt: new Date(NOW - 10 * DAY) }),
      row({ id: 'p1', priority: 1, createdAt: new Date(NOW - 2 * DAY) }),
      row({ id: 'newer-same-score', createdAt: new Date(NOW - 1 * DAY) }),
    ];
    const before = input.map((r) => r.id).join(',');
    const sorted = sortTicketsByScore(input, { now: NOW });
    expect(sorted.map((r) => r.id)).toEqual(['p1', 'older-same-score', 'newer-same-score']);
    expect(input.map((r) => r.id).join(',')).toBe(before); // pure: input untouched
  });

  it('kill switch TICKET_DISPATCH_SCORING_DISABLED=1 reverts to the static order byte-for-byte', () => {
    expect(dispatchScoringDisabled({ TICKET_DISPATCH_SCORING_DISABLED: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(dispatchScoringDisabled({} as NodeJS.ProcessEnv)).toBe(false);
    // Static order: priority desc, then createdAt asc — regardless of
    // occurrences/age/reopened/unblock.
    const rows = [
      row({ id: 'p0-new', priority: 0, createdAt: new Date(NOW - 1 * DAY), context: { occurrences: 50 } }),
      row({ id: 'p0-old', priority: 0, createdAt: new Date(NOW - 90 * DAY) }),
      row({ id: 'p1-old', priority: 1, createdAt: new Date(NOW - 90 * DAY) }),
      row({ id: 'p1-new', priority: 1, createdAt: new Date(NOW) }),
    ];
    const sorted = sortTicketsByScore(rows, { now: NOW, scoringDisabled: true });
    expect(sorted.map((r) => r.id)).toEqual(['p1-old', 'p1-new', 'p0-old', 'p0-new']);
  });
});

describe('ticket-priority — dependency reads (the todo pattern mirrored)', () => {
  it('waits on OPEN blockers only; every closed spelling unblocks', () => {
    const t = { id: 't', context: { dependsOnTicketIds: ['open-1', 'done-1', 'legacy-1', 'gone-1'] } };
    const index = new Map<string, ScorableTicketRow>([      ['open-1', row({ id: 'open-1', status: 'in_progress' })],
      ['done-1', row({ id: 'done-1', status: 'done' })],
      ['legacy-1', row({ id: 'legacy-1', status: 'resolved' })], // legacy spelling
      // 'gone-1' deliberately NOT in the index — unknown reads unblocked
    ]);
    const blockers = openDependencyBlockers(t, index);
    expect(blockers.map((b) => b.id)).toEqual(['open-1']);
    // deployed_verified (the verifier's terminal state) unblocks too.
    const index2 = new Map<string, ScorableTicketRow>([
      ['open-1', row({ id: 'open-1', status: 'deployed_verified' })],
    ]);
    expect(openDependencyBlockers(t, index2)).toEqual([]);
  });

  it('isClosedTicketRow accepts every closed spelling, rejects open work', () => {
    for (const s of ['done', 'deployed_verified', 'resolved', 'closed', 'archived', 'rejected', 'duplicate', 'wontfix', ' Done ']) {
      expect(isClosedTicketRow({ status: s })).toBe(true);
    }
    for (const s of ['open', 'in_progress', 'queued', 'reopened', 'awaiting_verification', '', undefined, null]) {
      expect(isClosedTicketRow({ status: s as string | null | undefined })).toBe(false);
    }
  });

  it('ticketDependsOnIds normalizes: trims, drops empties/dupes/self/non-strings', () => {
    expect(ticketDependsOnIds({
      id: 't',
      context: { dependsOnTicketIds: [' a ', '', 'a', 't', 42, null, 'b'] },
    })).toEqual(['a', 'b']);
    expect(ticketDependsOnIds({ id: 't', context: {} })).toEqual([]);
    expect(ticketDependsOnIds({ id: 't', context: { dependsOnTicketIds: 'not-an-array' } })).toEqual([]);
    expect(ticketDependsOnIds({ id: 't', context: null })).toEqual([]);
  });

  it('the wait note names the blockers and matches the dispatcher-note prefix', () => {
    const note = dependencyWaitNote([{ id: 'aaaaaaaa-bbbb', status: 'open' }]);
    expect(note.startsWith(DEPENDENCY_WAIT_NOTE_PREFIX)).toBe(true);
    expect(note).toContain('aaaaaaaa');
    expect(dependencyWaitNote([{ id: 'x' }], '2026-10-18T12:00:00Z')).toContain('all blockers closed at 2026-10-18T12:00:00Z');
  });
});

describe('ticket-priority — setTicketDependencies (write side)', () => {
  const db = new Map<string, ScorableTicketRow>();
  const load = async (id: string) => db.get(id) ?? null;
  beforeEach(() => { db.clear(); });

  it('stores a normalized set and null/undefined clears', async () => {
    db.set('t', row({ id: 't' }));
    db.set('a', row({ id: 'a' }));
    db.set('b', row({ id: 'b' }));
    const v = await setTicketDependencies('t', [' a ', '', 'a', 'b'], load);
    expect(v).toEqual({ ok: true, dependsOnTicketIds: ['a', 'b'] });
    const cleared = await setTicketDependencies('t', null, load);
    expect(cleared).toEqual({ ok: true, dependsOnTicketIds: [] });
  });

  it('self-reference 400, unknown ticket 404, unknown blocker 404', async () => {
    db.set('t', row({ id: 't' }));
    expect(await setTicketDependencies('t', ['t'], load)).toMatchObject({ ok: false, status: 400 });
    expect(await setTicketDependencies('nope', ['a'], load)).toMatchObject({ ok: false, status: 404 });
    expect(await setTicketDependencies('t', ['ghost'], load)).toMatchObject({ ok: false, status: 404 });
  });

  it('cycle 409: A waits on B, B waiting on A is refused (direct and transitive)', async () => {
    db.set('a', row({ id: 'a', context: { dependsOnTicketIds: ['b'] } }));
    db.set('b', row({ id: 'b' }));
    db.set('c', row({ id: 'c' }));
    expect(await setTicketDependencies('b', ['a'], load)).toMatchObject({ ok: false, status: 409 });
    // transitive: c → a → b, so b depending on c is a cycle through a.
    db.set('c', row({ id: 'c', context: { dependsOnTicketIds: ['a'] } }));
    expect(await setTicketDependencies('b', ['c'], load)).toMatchObject({ ok: false, status: 409 });
    // A DAG is fine: c → a → b, and a NEW row depending on all three.
    db.set('d', row({ id: 'd' }));
    expect(await setTicketDependencies('d', ['a', 'b', 'c'], load)).toMatchObject({ ok: true });
  });

  it('caps the set at 20', async () => {
    db.set('t', row({ id: 't' }));
    for (let i = 0; i < 21; i++) db.set(`dep${i}`, row({ id: `dep${i}` }));
    expect(await setTicketDependencies('t', Array.from({ length: 21 }, (_, i) => `dep${i}`), load))
      .toMatchObject({ ok: false, status: 400 });
  });

  it('refuses non-array input', async () => {
    db.set('t', row({ id: 't' }));
    expect(await setTicketDependencies('t', 'a' as unknown as string[], load)).toMatchObject({ ok: false, status: 400 });
    expect(await setTicketDependencies('t', [42] as unknown as string[], load)).toMatchObject({ ok: false, status: 400 });
  });

  it('CANONICALIZATION (F2): a prefix input resolves to the CANONICAL full id before it is stored', async () => {
    // The stub mirrors getFeedbackTicketById: exact id, or a UNIQUE ≥8-char
    // prefix → the row; ambiguous / <8 chars / unknown → null. Realistic
    // full ids (36-char uuid shape) so the 8-char prefixes are unambiguous.
    const fullA = 'aaaaaaaa-0000-4000-8000-000000000001';
    const fullB = 'bbbbbbbb-0000-4000-8000-000000000002';
    const fullT = 'tttttttt-0000-4000-8000-000000000003';
    db.set(fullT, row({ id: fullT }));
    db.set(fullA, row({ id: fullA }));
    db.set(fullB, row({ id: fullB }));
    // The stub: the exact-id map lookup first, then the prefix tier.
    const prefixLoad = async (id: string) => {
      if (db.has(id)) return db.get(id) ?? null;
      if (id.trim().length < 8) return null; // same tier as GET_ID_PREFIX_MIN
      const hits = [...db.keys()].filter((k) => k.startsWith(id.trim()));
      return hits.length === 1 ? (db.get(hits[0]) ?? null) : null; // ambiguous → null (not a gate)
    };
    // Prefix IN → canonical OUT: the stored set holds the FULL ids, not the
    // raw 8-char prefixes (the drain's blocker index keys on full ids).
    const v = await setTicketDependencies(fullT, ['aaaaaaaa', 'bbbbbbbb'], prefixLoad);
    expect(v).toEqual({ ok: true, dependsOnTicketIds: [fullA, fullB] });
    // A mix of prefix + full id canonicalizes to the same deduped set.
    const mixed = await setTicketDependencies(fullT, ['aaaaaaaa', fullB], prefixLoad);
    expect(mixed).toEqual({ ok: true, dependsOnTicketIds: [fullA, fullB] });
    // A prefix for the ticket ITSELF still 400s (pre-F2 the raw prefix
    // bypassed the self-check: 'tttttttt' !== fullT).
    expect(await setTicketDependencies(fullT, ['tttttttt'], prefixLoad)).toMatchObject({ ok: false, status: 400 });
    // An unknown prefix 404s (names the offending raw input).
    const ghost = await setTicketDependencies(fullT, ['zzzzzzzz'], prefixLoad);
    expect(ghost).toMatchObject({ ok: false, status: 404 });
    expect(ghost).toMatchObject({ error: expect.stringContaining('zzzzzzzz') });
  });

  it('CANONICALIZATION (F2): a PREFIX cycle still 409s (the walk follows canonical ids)', async () => {
    const fullA = 'aaaaaaaa-0000-4000-8000-000000000011';
    const fullB = 'bbbbbbbb-0000-4000-8000-000000000012';
    // A already waits on B (stored canonical, as setTicketDependencies writes).
    db.set(fullA, row({ id: fullA, context: { dependsOnTicketIds: [fullB] } }));
    db.set(fullB, row({ id: fullB }));
    const prefixLoad = async (id: string) => {
      if (db.has(id)) return db.get(id) ?? null;
      if (id.trim().length < 8) return null;
      const hits = [...db.keys()].filter((k) => k.startsWith(id.trim()));
      return hits.length === 1 ? (db.get(hits[0]) ?? null) : null;
    };
    // B waits on A — named by PREFIX. The canonicalizer maps 'aaaaaaaa' →
    // fullA, the cycle walk sees fullA → fullB → back to the ticket, 409.
    // (Pre-F2 the raw prefix was stored and the walk keyed on full ids —
    // the cycle was invisible.)
    expect(await setTicketDependencies(fullB, ['aaaaaaaa'], prefixLoad)).toMatchObject({ ok: false, status: 409 });
    // The same shape via a DIRECT edge also 409s (the plain pin, kept for
    // contrast: the prefix adds nothing here, the canonicalizer is identity).
    expect(await setTicketDependencies(fullB, [fullA], prefixLoad)).toMatchObject({ ok: false, status: 409 });
  });

  it('CANONICALIZATION (F2): an AMBIGUOUS prefix 404s — never a wrong gate on a guessed row', async () => {
    const samePfx = 'cccccccc';
    const one = `${samePfx}-0000-4000-8000-000000000021`;
    const two = `${samePfx}-0000-4000-8000-000000000022`;
    const fullT = 'tttttttt-0000-4000-8000-000000000023';
    db.set(fullT, row({ id: fullT }));
    db.set(one, row({ id: one }));
    db.set(two, row({ id: two }));
    const prefixLoad = async (id: string) => {
      if (db.has(id)) return db.get(id) ?? null;
      if (id.trim().length < 8) return null;
      const hits = [...db.keys()].filter((k) => k.startsWith(id.trim()));
      return hits.length === 1 ? (db.get(hits[0]) ?? null) : null; // 2 hits → null
    };
    // Two rows share the prefix: the stub (like getFeedbackTicketById's
    // 'ambiguous' branch) resolves NOTHING, and setTicketDependencies 404s
    // rather than storing an ambiguous edge.
    expect(await setTicketDependencies(fullT, [samePfx], prefixLoad)).toMatchObject({ ok: false, status: 404 });
  });
});
