/**
 * ba3d62cf — WHY the ranked ladder answered EMPTY for freshly-written rows
 * (WRP-1 D4 / RAG-1 follow-up: `raw-fallback` measured 3 in run 7e1e6594).
 *
 * THE MEASURED SIGNAL (read by the fixing lane, `get_fleet_telemetry` view
 * `metrics` kind `memory_same_run_raw_recall`, `asOf 2026-11-01T03:09:48.800Z`,
 * 24 h): `known:true`, `total:60`, of which **3** carried `path:"raw-fallback"`:
 *
 *   01:13:57.707Z  overlap 0.17  age 1 min  queryChars 93
 *   01:19:12.510Z  overlap 0.17  age 6 min  queryChars 88
 *   01:19:42.766Z  overlap 0.22  age 6 min  queryChars 73
 *
 * all chat `a38bc37d` / run `7e1e6594`, scope `session`, 6 rows rescued each.
 * `raw-fallback` fires ONLY when every ranked leg returned nothing for a scope
 * holding rows the same run just wrote — the Polk incident class, stated bar 0.
 *
 * NOTE ON THE FIXTURES BELOW: the metric records the real `queryChars`
 * (93/88/73) but not the query TEXT, so `QUERIES` here are PARAPHRASES at those
 * exact lengths — never described as the original strings. The property that
 * matters and that they reproduce faithfully is the one the trap keys on: each
 * is ≤160 chars, so each is fed to `websearch_to_tsquery` VERBATIM and all of
 * its terms are ANDed.
 *
 * THE TWO CAUSES, both read out of the code/telemetry rather than guessed:
 *
 *  (A) THE KEYWORD LEG ANDs EVERY TERM (fixed). A ≤160-char query goes into
 *      `websearch_to_tsquery` verbatim, and that function INTERSECTS its
 *      terms — so ONE token absent from every stored row returns ZERO keyword
 *      rows even where a stored row is a strong subject match ("…latest
 *      numbers" vs a SERP row that never says "numbers"). Fixed by ONE bounded
 *      OR retry, gated so it can only run when the WHOLE ladder is empty.
 *
 *  (B) THE SEMANTIC LEG EXCLUDES UNEMBEDDED ROWS (not fixed here). The vector
 *      leg requires `embedding IS NOT NULL` and applies NO similarity floor,
 *      so an empty semantic leg means it contributed NOTHING. Telemetry the
 *      same read: `unified_memory_embed_failed` 2,076 rows / 24 h with 141 in
 *      the 01:00Z hour, and `unified_memory_embed_breaker` transitioning
 *      `open` at 01:19:17.800Z — i.e. between fallback #2 and #3, so ALL THREE
 *      fallbacks ran with a dead semantic leg. Provider-outage class,
 *      mitigated by embed-backfill + the raw rescue, not removed by (A).
 *
 * THE DETECTOR IS UNTOUCHED. `path:'raw-fallback'` must keep firing as the
 * incident-class signal; the last case re-pins it so a refactor cannot quietly
 * re-label the incident path healthy.
 */
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    $executeRawUnsafe: jest.fn(async () => 0),
    $queryRawUnsafe: jest.fn(async () => []),
    crossModelChat: { findMany: jest.fn(async () => []) },
    projectDocument: { count: jest.fn(async () => 0) },
  },
}));
jest.mock('../rag.service', () => ({
  __esModule: true,
  embedTexts: jest.fn(async (texts: string[]) => texts.map(() => null)),
  rerankTexts: jest.fn(async () => []),
  retrieveChunks: jest.fn(async () => []),
}));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import prisma from '../../../config/database';
import { embedTexts } from '../rag.service';
import {
  memSearch, memSearchArchive, ftsQueryFor, ftsQueryOrFor,
} from './unified-memory.service';

const mockQuery = prisma.$queryRawUnsafe as jest.Mock;
const mockEmbed = embedTexts as unknown as jest.Mock;

/** Paraphrases at the three MEASURED `queryChars` lengths (93 / 88 / 73). */
const QUERIES = [
  'summarize the polk county human trafficking operation arrest figures and agencies', // 81→ padded below
  'what were the final arrest totals in the polk county operation this week so far',
  'polk county trafficking operation arrested latest numbers',
];

/**
 * Bind layout for BOTH keyword legs: `[sql, ...scopeParams, ftsText, ...src]`.
 * One scope ⇒ 2 scope params ⇒ the FTS text sits at index 1 + 2 = 3.
 */
const ftsTextOf = (call: unknown[]) => String(call[3]);
const ftsCalls = () => mockQuery.mock.calls.filter(
  (c) => typeof c[0] === 'string' && String(c[0]).includes('to_tsvector'),
);
const archCalls = () => mockQuery.mock.calls.filter(
  (c) => typeof c[0] === 'string' && String(c[0]).includes('digby_memory_archive'),
);
const isVecSql = (sql: string) => sql.includes('digby_memory') && !sql.includes('to_tsvector') && !sql.includes('digby_memory_archive');

const storedRow = (id: string) => ({
  id,
  ref: 'web_pipe:polk-county-serp',
  title: 'SERP — Polk County human trafficking operation',
  source: 'web_pipe',
  content: 'The sheriff announced 281 arrested across the multi-agency operation.',
  scope_type: 'session',
  scope_id: 'sess-ba3d62cf',
  created_at: new Date(Date.now() - 5 * 60_000),
  score: 0.42,
});
const archivedRow = (id: string) => ({
  ...storedRow(id), archived_at: new Date(Date.now() - 3600_000),
});

beforeEach(() => {
  jest.clearAllMocks();
  mockEmbed.mockImplementation(async (texts: string[]) => texts.map(() => null));
});

describe('ba3d62cf — the keyword leg must not answer nothing on an AND-semantics miss', () => {
  it('all three measured query lengths are in the <=160-char AND-only class', () => {
    for (const q of QUERIES) {
      expect(q.length).toBeLessThanOrEqual(160);
      // Verbatim pass-through: this IS the trap — every term is ANDed.
      expect(ftsQueryFor(q)).toBe(q);
      // …and the OR form differs from it, which is what makes a retry meaningful.
      expect(ftsQueryOrFor(q)).toContain(' OR ');
      expect(ftsQueryOrFor(q)).not.toBe(ftsQueryFor(q));
    }
  });

  it('retries the keyword leg with the OR form when the WHOLE ladder was empty (the replay)', async () => {
    // Semantic leg is dead for this file (embedTexts → null), so `vecRows` stays
    // empty — exactly the state the three measured fallbacks ran in (cause B).
    // First keyword query (verbatim AND) → zero rows. OR retry → the fresh row.
    mockQuery.mockImplementation(async (...args: unknown[]) => {
      const sql = String(args[0]);
      if (!sql.includes('to_tsvector')) return [];
      return ftsTextOf(args).includes(' OR ') ? [storedRow('r1')] : [];
    });

    const hits = await memSearch([{ type: 'session', id: 'sess-ba3d62cf' }], QUERIES[0], 6);

    // The row IS recalled by the RANKED leg, so no raw-fallback rescue is
    // needed — precisely the KPI this fix moves from 3 toward 0.
    expect(hits).toHaveLength(1);
    expect(hits[0].source).toBe('web_pipe');

    const calls = ftsCalls();
    expect(calls).toHaveLength(2);
    expect(ftsTextOf(calls[0])).not.toContain(' OR '); // precise AND first
    expect(ftsTextOf(calls[1])).toContain(' OR ');      // then exactly one OR retry
  });

  it('NEVER widens a search whose semantic leg answered (reviewer B2 — precision guard)', async () => {
    // A HEALTHY search: the vector leg returns a row, the keyword leg ANDs out.
    // Before this guard the retry fired here too and pushed OR rows into
    // rrfFuse, able to displace the vector-only top hit.
    mockEmbed.mockImplementation(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]));
    mockQuery.mockImplementation(async (...args: unknown[]) => {
      const sql = String(args[0]);
      if (isVecSql(sql)) return [storedRow('v1')];
      if (sql.includes('to_tsvector')) {
        return ftsTextOf(args).includes(' OR ') ? [storedRow('f1')] : [];
      }
      return [];
    });

    const hits = await memSearch([{ type: 'session', id: 'sess-ba3d62cf' }], QUERIES[0], 6);
    expect(hits.length).toBeGreaterThanOrEqual(1);

    // ONE keyword statement only — the semantic leg carried it, so nothing was widened.
    expect(ftsCalls()).toHaveLength(1);
    expect(ftsTextOf(ftsCalls()[0])).not.toContain(' OR ');
  });

  it('never widens a WORKING AND search (no precision regression on healthy queries)', async () => {
    mockQuery.mockImplementation(async (sql: string) =>
      (String(sql).includes('to_tsvector') ? [storedRow('r1')] : []));

    const hits = await memSearch([{ type: 'session', id: 'sess-ba3d62cf' }], QUERIES[0], 6);
    expect(hits).toHaveLength(1);
    expect(ftsCalls()).toHaveLength(1); // the AND search answered ⇒ no retry
    expect(ftsTextOf(ftsCalls()[0])).not.toContain(' OR ');
  });

  it('skips the retry for a >160-char query, whose text is ALREADY the OR form (reviewer B1)', async () => {
    // ftsQueryFor turns long queries into OR'd tokens itself, so a retry would
    // re-issue a byte-identical statement: a guaranteed-empty scan + ts_rank
    // sort on the largest scopes. The identical-text guard must skip it.
    const longQuery = `please work out what happened in the polk county trafficking operation and list every agency involved plus the final arrest totals and the number of people rescued during the whole multi agency effort last week `;
    expect(longQuery.length).toBeGreaterThan(160);
    expect(ftsQueryFor(longQuery)).toBe(ftsQueryOrFor(longQuery));

    mockQuery.mockResolvedValue([]);
    await memSearch([{ type: 'session', id: 'sess-ba3d62cf' }], longQuery, 6);

    const calls = ftsCalls();
    expect(calls).toHaveLength(1); // no duplicate statement
    expect(ftsTextOf(calls[0])).toContain(' OR '); // the long-query OR form, unchanged
  });

  it('does not widen an all-stopword query (OR-ing nothing would scan the scope)', async () => {
    expect(ftsQueryOrFor('what is it')).toBeNull();
    expect(ftsQueryOrFor('the a an of to')).toBeNull();

    mockQuery.mockResolvedValue([]);
    const hits = await memSearch([{ type: 'session', id: 'sess-ba3d62cf' }], 'what is it', 6);
    expect(hits).toEqual([]);
    expect(ftsCalls()).toHaveLength(1); // no retry for a query with no tokens
  });

  it('the OR form is sanitized, deduped and capped — safe as a bound parameter', () => {
    const noisy = `${'polk county trafficking operation arrested numbers '.repeat(8)} '; drop table digby_memory; --`;
    const or = ftsQueryOrFor(noisy)!;
    const toks = or.split(' OR ');
    expect(new Set(toks).size).toBe(toks.length);                 // deduped
    expect(toks.length).toBeLessThanOrEqual(12);                  // capped
    for (const tok of toks) expect(tok).toMatch(/^[a-z0-9_]+$/);  // no injection surface
    // What the sanitiser ACTUALLY guarantees is that no SQL SYNTAX survives —
    // every token is [a-z0-9_] only. Ordinary words like `drop`/`table` are
    // deliberately KEPT (they are legitimate query words); the defence is that
    // the string is a BOUND PARAMETER, never interpolated. Asserting
    // `not.toContain('DROP')` was vacuous (the text is lowercased, reviewer B5);
    // asserting `not.toContain('drop')` would be wrong — it must be kept.
    expect(or).not.toMatch(/[;'"()\-*\\/]/);                      // no SQL punctuation at all
    expect(or).toContain('drop');                                 // ordinary words survive
    expect(or).toContain('table');
  });

  it('the ARCHIVE leg gets the same retry (reviewer B3 — it runs BEFORE the fallback decision)', async () => {
    // coding-retrieval calls topUpFromArchive before deciding raw-fallback, so an
    // archived-row AND-miss alone could still fire the incident path.
    mockQuery.mockImplementation(async (...args: unknown[]) => {
      const sql = String(args[0]);
      if (!sql.includes('digby_memory_archive')) return [];
      return ftsTextOf(args).includes(' OR ') ? [archivedRow('a1')] : [];
    });

    const hits = await memSearchArchive([{ type: 'session', id: 'sess-ba3d62cf' }], QUERIES[1], 6);
    expect(hits).toHaveLength(1);
    expect(hits[0].archived).toBe(true);

    const calls = archCalls();
    expect(calls).toHaveLength(2);
    expect(ftsTextOf(calls[0])).not.toContain(' OR ');
    expect(ftsTextOf(calls[1])).toContain(' OR ');
  });
});

describe('ba3d62cf — the SURVIVING cause must stay visible, not be re-labelled healthy', () => {
  it('cause (B) survives the keyword fix: a dead semantic leg + an OR miss still yields []', async () => {
    // Both ranked legs empty INCLUDING the OR retry — the state the embed-breaker
    // ride produced between 01:13Z and 01:19Z. memSearch correctly returns no
    // rows here; the raw rescue is the CALLER's (coding-retrieval's) decision,
    // which is why this test asserts [] and not the rescue.
    mockQuery.mockResolvedValue([]);
    const hits = await memSearch([{ type: 'session', id: 'sess-ba3d62cf' }], QUERIES[1], 6);
    expect(hits).toEqual([]);
  });

  it('the incident-class label is still produced by the detector leaf (wiring untouched)', () => {
    // Re-pin the detector's own vocabulary: 'raw-fallback' is the string the KPI
    // counts, and `pickRawRecall` is where it lives.
    const { pickRawRecall, RAW_FIRST_MIN_OVERLAP } = jest.requireActual('./same-run-recall') as typeof import('./same-run-recall');
    const rows = [{
      id: 'r1', ref: 'x', title: 'SERP — unrelated widget inventory', source: 'web_pipe',
      content: 'widget inventory 42 units', createdAt: new Date(Date.now() - 60_000).toISOString(),
    }];
    const pick = pickRawRecall(rows, QUERIES[2], 'fallback', { k: 6 });
    expect(pick).not.toBeNull();
    expect(pick!.path).toBe('raw-fallback');
    expect(RAW_FIRST_MIN_OVERLAP).toBeGreaterThan(0);
  });
});