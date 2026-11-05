/**
 * Tests for unified-memory.service — focused on the NUL-byte store guard.
 *
 * Production telemetry (2026-07): `unified-memory: store failed (non-fatal):
 * Raw query failed. Code: 22021. Message: ERROR: invalid byte sequence for
 * encoding "UTF8": 0x00` — 18 lost memory writes / 7d. Postgres `text` columns
 * reject NUL bytes, and one bad row poisoned the whole multi-row INSERT in
 * memStore (scraped pages, tool output, and indexed files can carry stray
 * NULs). memStore now strips NUL bytes at the write boundary.
 */

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    $executeRawUnsafe: jest.fn(async () => 0),
    $queryRawUnsafe: jest.fn(async () => []),
  },
}));
jest.mock('../rag.service', () => ({
  __esModule: true,
  // Skip the embedding leg — tests take the NULL-embedding INSERT branch.
  embedTexts: jest.fn(async (texts: string[]) => texts.map(() => null)),
  rerankTexts: jest.fn(async () => []),
}));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import prisma from '../../../config/database';
import { memStore, stripNulBytes, memSearch, isFactRetrievalQuery, sourcePrior, ftsQueryFor, enforceScopeCap, memInventory, memQueryText, MEM_QUERY_MAX_CHARS } from './unified-memory.service';
import { rerankTexts, embedTexts } from '../rag.service';

describe('memQueryText — the embed/rerank query bound (2026-09-19 audit: a 19.6k-char machine wake took 27 s to embed + rerank)', () => {
  it('leaves a query at or under the cap untouched (trimmed)', () => {
    expect(memQueryText('  what blocked the run?  ')).toBe('what blocked the run?');
    const exact = 'x'.repeat(MEM_QUERY_MAX_CHARS);
    expect(memQueryText(exact)).toBe(exact);
  });

  it('keeps the TAIL of a long query — the machine preamble is the head, the event body is the tail', () => {
    const preamble = '[MACHINE-TRIGGERED RUN — no user is on this turn. '.padEnd(15_000, 'boilerplate ');
    const body = 'HOOK run_completed from lane node-a: gpqa-40 row truncated, waiter still queued.';
    const out = memQueryText(preamble + body);
    expect(out.length).toBe(MEM_QUERY_MAX_CHARS);
    expect(out.endsWith(body)).toBe(true);
  });

  it('memSearch embeds and reranks the bounded text, never the raw 19k-char message', async () => {
    (prisma.$queryRawUnsafe as jest.Mock).mockResolvedValue([]);
    const long = 'p'.repeat(19_000) + ' the actual question';
    await memSearch([{ type: 'project', id: 'proj-1' }], long, 4);
    const embedArg = (embedTexts as jest.Mock).mock.calls.at(-1)?.[0]?.[0] as string;
    expect(embedArg.length).toBe(MEM_QUERY_MAX_CHARS);
    expect(embedArg.endsWith(' the actual question')).toBe(true);
  });
});

const NUL = String.fromCharCode(0);
const mockExec = prisma.$executeRawUnsafe as jest.Mock;

// A body of text long enough to pass the worthEmbedding() quality gate.
const BODY = `Indexed tool output from a shell session: exit code 127, path /usr/local/bin/tool, ` +
  `stack frame module_loader.ts:412, error EPIPE while piping 4096 bytes to stdout. `.repeat(3);

describe('stripNulBytes', () => {
  it('removes NUL bytes from a string', () => {
    expect(stripNulBytes(`ab${NUL}cd${NUL}${NUL}ef`)).toBe('abcdef');
  });

  it('returns clean strings unchanged', () => {
    expect(stripNulBytes('plain text 123')).toBe('plain text 123');
  });

  it('handles empty and undefined-ish inputs', () => {
    expect(stripNulBytes('')).toBe('');
    expect(stripNulBytes(NUL)).toBe('');
  });

  it('preserves other control characters (\\n \\t \\r are legal in PG text)', () => {
    expect(stripNulBytes('a\nb\tc\rd')).toBe('a\nb\tc\rd');
  });
});

describe('memStore NUL-byte guard', () => {
  beforeEach(() => mockExec.mockClear());

  function insertCall(): { sql: string; params: any[] } {
    const call = mockExec.mock.calls.find(([sql]: [string]) =>
      typeof sql === 'string' && sql.startsWith('INSERT INTO digby_memory'));
    if (!call) throw new Error('no INSERT INTO digby_memory call captured');
    return { sql: call[0], params: call.slice(1) };
  }

  it('strips NUL bytes from content, title, and ref before the INSERT', async () => {
    const written = await memStore(
      { type: 'session', id: 'sess-nul-test' },
      'worker',
      [{
        ref: `src/mod${NUL}ule.ts`,
        title: `Read file with${NUL} stray nul`,
        content: `${BODY}${NUL}`,
      }],
    );

    expect(written).toBe(1);
    const { params } = insertCall();
    const stringParams = params.filter((p) => typeof p === 'string') as string[];
    expect(stringParams.length).toBeGreaterThan(0);
    for (const p of stringParams) {
      expect(p).not.toContain(NUL);
    }
    expect(params).toContain('src/module.ts');
    expect(params).toContain('Read file with stray nul');
    expect(params).toContain(BODY);
  });

  it('passes NUL-free content through untouched', async () => {
    const written = await memStore(
      { type: 'session', id: 'sess-clean-test' },
      'web_pipe',
      [{ ref: 'https://example.com/page', title: 'A clean page', content: BODY }],
    );

    expect(written).toBe(1);
    const { params } = insertCall();
    expect(params).toContain(BODY);
    expect(params).toContain('https://example.com/page');
    expect(params).toContain('A clean page');
  });
});

// Owner 2026-09-04 ("doesn't read memory or embeds very often") — the curated-
// content gate bypass: worthEmbedding silently dropped short plain-prose
// learnings while the sync pinned them as indexed with zero rows stored.
describe('memStore skipGate (curated content)', () => {
  beforeEach(() => mockExec.mockClear());
  const SHORT_PROSE = 'Prefer American spelling in every doc'; // 25-199 chars, no code-signal token

  it('without skipGate, short plain prose is gated out (the conversational-noise default)', async () => {
    expect(await memStore({ type: 'project', id: 'p1' }, 'learning', [{ content: SHORT_PROSE }])).toBe(0);
  });

  it('with skipGate, the same content stores', async () => {
    const written = await memStore({ type: 'project', id: 'p1' }, 'learning', [{ content: SHORT_PROSE }], { skipGate: true, skipCap: true });
    expect(written).toBe(1);
    const call = mockExec.mock.calls.find(([sql]: [string]) => typeof sql === 'string' && sql.startsWith('INSERT INTO digby_memory'));
    expect(call).toBeDefined();
    expect(call!.slice(1)).toContain(SHORT_PROSE);
  });
});

// Owner 2026-09-04 — the project scope is SHARED (code index + learnings): a
// source-blind oldest-first sweep evicts the content-addressed, rarely-rewritten
// learnings rows first. The code-index sync passes source 'code'.
describe('enforceScopeCap source scoping', () => {
  beforeEach(() => mockExec.mockClear());

  // 2026-10-20: the sweep MOVES rows into digby_memory_archive (one CTE
  // statement); its trailing bind param is the archive_reason.
  const sweep = () => mockExec.mock.calls.find(([sql]: [string]) => typeof sql === 'string' && sql.startsWith('WITH moved AS (DELETE FROM digby_memory WHERE'));

  it('scopes the DELETE to one source when given', async () => {
    await enforceScopeCap({ type: 'project', id: 'p1' }, 100, 'code');
    const call = sweep();
    expect(call).toBeDefined();
    expect(String(call![0])).toContain('AND source = $3');
    expect(call!.slice(1)).toEqual(['project', 'p1', 'code', 'source_cap']);
  });

  it('sweeps the whole scope when no source is given (unchanged default)', async () => {
    await enforceScopeCap({ type: 'session', id: 's1' }, 100);
    const call = sweep();
    expect(String(call![0])).not.toContain('AND source =');
    expect(call!.slice(1)).toEqual(['session', 's1', 'scope_cap']);
  });
});

// Owner 2026-09-04 — plainto/websearch tsquery AND every word together, so the
// FTS leg was effectively DEAD for the long queries the injection callers pass
// (a whole user message; toolName + 500 chars of error text). Long queries
// reduce to distinctive tokens OR-ed for websearch_to_tsquery.
describe('ftsQueryFor', () => {
  it('passes short queries through untouched (AND precision is right there)', () => {
    expect(ftsQueryFor('auth token refresh logic')).toBe('auth token refresh logic');
  });

  it('reduces long queries to OR-ed distinctive tokens', () => {
    const long = `Please investigate why the provisioning retry throttle in backend/src/modules/provisioning.service.ts keeps hitting the rate limiter when the container pool is exhausted — this only happens because the scheduler enqueues duplicate jobs. `.repeat(3);
    const q = ftsQueryFor(long);
    expect(q).toContain(' OR ');
    expect(q.split(' OR ').length).toBeLessThanOrEqual(12);
    expect(q).toMatch(/provisioning/);
    // stopwords + short words are excluded
    expect(q.split(' OR ')).not.toContain('this');
    expect(q.split(' OR ')).not.toContain('the');
    // sanitized to plain word tokens — safe as a bound websearch_to_tsquery input
    for (const tok of q.split(' OR ')) expect(tok).toMatch(/^[a-z0-9_]+$/);
  });

  it('deduplicates repeated tokens', () => {
    const q = ftsQueryFor(`${'provisioning retry throttle limiter scheduler '.repeat(10)}`);
    const toks = q.split(' OR ');
    expect(new Set(toks).size).toBe(toks.length);
  });
});

describe('memInventory', () => {
  it('maps GROUP BY rows to a source→count record', async () => {
    (prisma.$queryRawUnsafe as jest.Mock).mockResolvedValueOnce([
      { source: 'web_pipe', n: BigInt(12) }, { source: 'compaction', n: 3 },
    ]);
    expect(await memInventory({ type: 'session', id: 's1' })).toEqual({ web_pipe: 12, compaction: 3 });
  });

  it('returns {} on failure (best-effort)', async () => {
    (prisma.$queryRawUnsafe as jest.Mock).mockRejectedValueOnce(new Error('down'));
    expect(await memInventory({ type: 'session', id: 's1' })).toEqual({});
  });
});

// Ticket 7852814c: for fact-retrieval queries, verbatim source chunks
// (web_pipe & co.) must outrank distilled 'compaction' summaries — otherwise
// search_memory hands agents meta-summaries instead of the ground truth.
describe('memSearch source prior (7852814c)', () => {
  const mockQuery = prisma.$queryRawUnsafe as jest.Mock;
  const mockRerank = rerankTexts as jest.Mock;
  const row = (id: string, source: string, content: string) => ({
    id, ref: `ref-${id}`, title: '', source, content,
    scope_type: 'session', scope_id: 'sess-prior', created_at: new Date(Date.now() - 3_600_000), score: 0.5,
  });
  // The vector leg never runs (embedTexts is mocked to nulls, so the query
  // embedding is null and the leg throws before querying); the ONLY SQL that
  // returns rows is the FTS leg.
  const ftsReturns = (rows: any[]) => mockQuery.mockImplementation(async (sql: string) =>
    typeof sql === 'string' && sql.includes('to_tsvector') ? rows : []);

  beforeEach(() => {
    mockQuery.mockReset();
    mockRerank.mockReset();
    mockRerank.mockResolvedValue([]); // default: reranker declines → fused order
  });

  it('isFactRetrievalQuery: specific-token signals only', () => {
    expect(isFactRetrievalQuery('what does web-pipe.ts export')).toBe(true);   // file.ext
    expect(isFactRetrievalQuery('why did deploy fail with error 502')).toBe(true); // error + number
    expect(isFactRetrievalQuery('the url https://example.com/x')).toBe(true);  // URL
    expect(isFactRetrievalQuery('port 443 config')).toBe(true);                // number
    expect(isFactRetrievalQuery('what did we decide overall')).toBe(false);
    expect(isFactRetrievalQuery('summarize the project status')).toBe(false);
  });

  it('sourcePrior: dampens compaction only for fact queries', () => {
    expect(sourcePrior('compaction', 'port 443 config')).toBeLessThan(1);
    expect(sourcePrior('compaction', 'what did we decide overall')).toBe(1);
    expect(sourcePrior('web_pipe', 'port 443 config')).toBe(1);
    expect(sourcePrior(null, 'port 443 config')).toBe(1);
  });

  it('ranks a verbatim web_pipe chunk above a compaction chunk for a fact query (compaction led in FTS)', async () => {
    ftsReturns([
      row('c1', 'compaction', 'distilled recap: the answer is 42'),
      row('w1', 'web_pipe', 'the answer is 42 — verbatim page text from https://example.com/facts'),
    ]);
    const hits = await memSearch([{ type: 'session', id: 'sess-prior' }], 'answer 42 https://example.com/facts', 6);
    expect(hits).toHaveLength(2);
    expect(hits[0].source).toBe('web_pipe');
    expect(hits[1].source).toBe('compaction');
  });

  it('leaves ranking untouched for non-factual queries (prior = 1 everywhere)', async () => {
    ftsReturns([
      row('c1', 'compaction', 'distilled recap: we decided to ship Friday'),
      row('w1', 'web_pipe', 'an article about shipping software on Fridays'),
    ]);
    const hits = await memSearch([{ type: 'session', id: 'sess-prior' }], 'what did we decide overall', 6);
    expect(hits[0].source).toBe('compaction'); // FTS rank order preserved
  });

  it('carries the prior through the cross-encoder rerank — a reranker-topped compaction still loses the near-tie', async () => {
    ftsReturns([
      row('w1', 'web_pipe', 'port 443 verbatim doc text'),
      row('w2', 'web_pipe', 'more port 443 text'),
      row('c1', 'compaction', 'distilled recap mentioning port 443'),
    ]);
    // 3 rows > k=2 → the rerank pool path. Pool order (fused+prior): w1, w2, c1.
    // The reranker tops the COMPACTION chunk (pool index 2); the carried prior
    // must still put the verbatim source first.
    mockRerank.mockResolvedValueOnce([{ index: 2 }, { index: 0 }]);
    const hits = await memSearch([{ type: 'session', id: 'sess-prior' }], 'port 443 config', 2);
    expect(hits[0].source).toBe('web_pipe');
  });
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __resetEmbedFailureNoticeForTests } = require('./unified-memory.service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mockedLogger = require('../../../utils/logger').default;

describe('memStore — a rejected embed batch names its cause once and is re-embedded row by row (telemetry-noise audit PE-13)', () => {
  const BODY_B = `Second indexed tool output: exit code 2, path /opt/app/bin/other, stack frame loader.ts:88, ` +
    `error EACCES while opening 512 bytes of config. `.repeat(3);
  const reject400 = Object.assign(new Error('Request failed with status code 400'), {
    response: { status: 400, data: { code: 'DataInspectionFailed', message: 'Input data may contain inappropriate content.' } },
  });

  beforeEach(() => {
    mockExec.mockClear();
    (embedTexts as jest.Mock).mockReset();
    (mockedLogger.warn as jest.Mock).mockClear();
    (mockedLogger.debug as jest.Mock).mockClear();
    __resetEmbedFailureNoticeForTests();
    delete process.env.UNIFIED_MEMORY_EMBED_ROW_RETRY_MAX;
  });

  function vectorSlots(): number {
    const call = mockExec.mock.calls.find((c) => typeof c[0] === 'string' && String(c[0]).startsWith('INSERT INTO digby_memory'));
    if (!call) throw new Error('no INSERT captured');
    return (String(call[0]).match(/::vector\)/g) || []).length;
  }

  it('keeps the good row\'s vector, stores the rejected row keyword-only, and logs the provider cause ONCE at warn', async () => {
    (embedTexts as jest.Mock).mockImplementation(async (texts: string[]) => {
      if (texts.length > 1 || texts[0].includes('EACCES')) throw reject400;
      return texts.map(() => [0.1, 0.2, 0.3]);
    });
    const written = await memStore({ type: 'session', id: 'sess-embed-400' }, 'orchestrator', [
      { ref: 'a', title: 'good', content: BODY },
      { ref: 'b', title: 'rejected', content: BODY_B },
    ]);
    expect(written).toBe(2);
    expect(vectorSlots()).toBe(1); // one row embedded, one NULL
    expect((embedTexts as jest.Mock).mock.calls.map((c) => c[0].length)).toEqual([2, 1, 1]); // batch, then row by row
    const warns = (mockedLogger.warn as jest.Mock).mock.calls.map((c) => String(c[0])).filter((l) => l.includes('unified-memory: embed failed'));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('http_4xx HTTP 400 code=DataInspectionFailed');
    expect(warns[0]).toContain('inappropriate content');
    expect(warns[0]).toContain('1/2 recovered');
    expect(warns[0]).toContain('source=orchestrator');
    expect(warns[0]).toContain('logged once per cause per process');

    // The SAME cause on the next store is debug, not warn.
    mockExec.mockClear();
    await memStore({ type: 'session', id: 'sess-embed-400' }, 'orchestrator', [{ ref: 'c', title: 'again', content: BODY_B }, { ref: 'd', title: 'fine', content: BODY }]);
    expect((mockedLogger.warn as jest.Mock).mock.calls.map((c) => String(c[0])).filter((l) => l.includes('unified-memory: embed failed'))).toHaveLength(1);
    expect((mockedLogger.debug as jest.Mock).mock.calls.map((c) => String(c[0])).filter((l) => l.includes('unified-memory: embed failed'))).toHaveLength(1);
  });

  it('UNIFIED_MEMORY_EMBED_ROW_RETRY_MAX=0 keeps the whole batch keyword-only but still names the cause', async () => {
    process.env.UNIFIED_MEMORY_EMBED_ROW_RETRY_MAX = '0';
    (embedTexts as jest.Mock).mockRejectedValue(reject400);
    const written = await memStore({ type: 'session', id: 'sess-embed-400-off' }, 'orchestrator', [
      { ref: 'a', title: 'good', content: BODY },
      { ref: 'b', title: 'rejected', content: BODY_B },
    ]);
    expect(written).toBe(2);
    expect(vectorSlots()).toBe(0);
    expect(embedTexts).toHaveBeenCalledTimes(1);
    const warns = (mockedLogger.warn as jest.Mock).mock.calls.map((c) => String(c[0])).filter((l) => l.includes('unified-memory: embed failed'));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('2/2 row(s) stored keyword-only');
    expect(warns[0]).toContain('per-row retry not attempted');
  });
});
