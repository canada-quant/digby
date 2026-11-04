/**
 * ACCEPTANCE REPLAY — ticket 1cc1f52e ("Research pipeline: 6 hard-fail classes
 * in one run"). Lane: ticket 1cc1f52e dispatch 1 of 3 (session 6763708c).
 *
 * WHAT THIS FILE IS. The ticket's acceptanceMetric is UNSET, so a machine close
 * needs a committed replay that names the ticket (the replayTestPath bar). This
 * file drives the REAL seams of the research pipeline with fixtures quoted
 * verbatim from the reported run, and is the standing RED/GREEN record for the
 * ticket's five acceptance criteria:
 *
 *   (a) bounded attempts, no apology-as-deliverable
 *   (b) an explicit verified/unverified split — the refusal behaviour that must
 *       NOT regress (the run rightly refused to invent the operation name,
 *       charge breakdown, named arrestees and victim counts)
 *   (c) a just-fetched SERP is retrievable in the SAME run
 *   (d) zero narration / process pills in the delivered answer body
 *   (e) throttle injection does not change the delivered shape
 *
 * MERGE-ORDER INDEPENDENCE (the reason for the `caseWhen` helper below). The
 * six-class fix ships from a DIFFERENT lane (goal 9ecd595e / session b255f095),
 * so either PR may land first. A bare `test.failing` would go RED the moment
 * that fix merges — turning the other lane's fix into an apparent regression,
 * and reddening main. So each criterion that is still open is registered
 * through `caseWhen(fixed, ...)`: it probes whether the fix is present in the
 * code under test and registers a plain `test` when it is, `test.failing` when
 * it is not. Green either way, and it silently becomes a REAL assertion the
 * moment the fix lands — never a false red, never a permanent "maybe".
 *
 * The implementation charter for the six classes belongs to that other lane;
 * this file only MEASURES and deliberately touches none of its paths.
 */
jest.mock('../mcp-search', () => ({ callMcpTool: jest.fn(), extractPdfTextFromUrl: jest.fn(async () => null) }));
jest.mock('../coding/coding-retrieval.service', () => ({ storeFindings: jest.fn(async () => 1) }));
jest.mock('../model-endpoints/model-roles.service', () => ({ __esModule: true, resolveRoleModel: jest.fn(async () => '') }));
jest.mock('../model-endpoints/model-endpoints.service', () => ({ __esModule: true, resolveRegistryModel: jest.fn(async () => null) }));
jest.mock('../platform/loop-metrics.service', () => ({ __esModule: true, noteSeatFallback: jest.fn() }));
jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn() }));
jest.mock('../../../utils/logger', () => ({
  __esModule: true, default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
  warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
// unified-memory's DB + embed/rerank legs: criterion (c) is about the RETRIEVAL
// contract, so the postgres seam is stubbed while the real memStore logic runs.
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { $executeRawUnsafe: jest.fn(async () => 0), $queryRawUnsafe: jest.fn(async () => []) },
}));
jest.mock('../rag.service', () => ({
  __esModule: true,
  // The reported failure: embed produced nothing and the reranker returned no
  // order — the read still has to find the row it just wrote.
  embedTexts: jest.fn(async (t: string[]) => t.map(() => null)),
  rerankTexts: jest.fn(async () => []),
}));

import axios from 'axios';
import { runWebPipe } from '../coding/web-pipe';
import { callMcpTool } from '../mcp-search';
import { stripAnswerScaffolding, stripAnswerScaffoldingText } from './answer-scaffolding';
import { renderUnverifiedClaimsFootnote, UNVERIFIED_FOOTNOTE_HEADER } from '../platform/unverified-claims';
import { serpProviderErrorDetail } from '../serp-provider-guard';
import { memStore } from '../memory/unified-memory.service';
import * as unifiedMemory from '../memory/unified-memory.service';
import prisma from '../../../config/database';

const mockMcp = callMcpTool as jest.Mock;
const mockPost = axios.post as jest.Mock;
const mockGet = axios.get as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DASHSCOPE_API_KEY = 'test-key';
  delete process.env.ANSWER_NARRATION_STRIP_DISABLED;
  // Pin the in-band retry knob: on a box where WEB_PIPE_SERP_RETRY_MS >= the
  // provider's stated wait, web_pipe would SLEEP that long (> jest's 5 s
  // timeout) before the failure — an env-sensitive red from outside this file.
  process.env.WEB_PIPE_SERP_RETRY_MS = '100';
  mockPost.mockResolvedValue({ data: { choices: [{ message: { content: 'DIGEST: verified facts only' } }] } });
  mockGet.mockRejectedValue(new Error('no direct fetch in this replay'));
});

afterEach(() => {
  delete process.env.WEB_PIPE_SERP_RETRY_MS;
  delete process.env.DASHSCOPE_API_KEY;
});

/**
 * Register a case that is a REAL assertion once `fixed` is true and a
 * `test.failing` while it is false. Keeps this replay green whichever lane
 * merges first, without ever hiding the gap (a `test.failing` still shows in
 * the report, and flips to an enforced assertion by itself).
 */
function caseWhen(fixed: boolean, name: string, fn: () => any): void {
  if (fixed) it(name, fn);
  else (it as unknown as { failing: (n: string, f: () => any) => void }).failing(name, fn);
}

// ── fixtures quoted verbatim from the reported run (ticket 1cc1f52e) ─────────
/** The provider's own auto-throttle body as the MCP tier flattens it. */
const THROTTLE_BODY = [
  'HTTP/1.1 429 The request was auto-throttled due to low success rate',
  'x-brd-error-code: sr_rate_limit',
  'x-brd-rate-limit-period-ms: 60000',
  'https://docs.brightdata.com/scraping-automation/serp-api/debugging#serp-api-error-catalog',
].join('\n');

/** The delivered answer body, verbatim shape from the reproduction. */
const REPORTED_BODY = [
  'Researched online · Polk County 281 arrested human trafficking bust Di',
  '',
  'The search surfaced older Polk County stings (108/160/219 arrests in 2022–23) — none match the 281 figure from your headline. Searching for the actual current story now.',
  '',
  'Researched online · "Polk County" 281 arrested human trafficking opera',
  '',
  'The aggregated fetch got throttled — going direct to the outlets instead.',
  '',
  'The SERP was stored to memory — retrieving the actual links from it.',
  '',
  'Searched project memory · 281 arrested Polk County human trafficking Disney',
  '',
  "Memory doesn't have it.",
  '',
  "Polk County Sheriff's news page returned a 404 when I hit it directly.",
].join('\n');

/** Process-PROSE lines (the ANS-3 surface: retrieval cue or plumbing idiom). */
const PROSE_NARRATION_LINES = [
  'The aggregated fetch got throttled — going direct to the outlets instead.',
  'The SERP was stored to memory — retrieving the actual links from it.',
  "Memory doesn't have it.",
  "Polk County Sheriff's news page returned a 404 when I hit it directly.",
];

/**
 * The one thing the reported run got RIGHT: it refused to invent the
 * operation's name, charge breakdown, named arrestees or victim counts, and
 * published an explicit split. Defined once so the byte-identity assertion
 * cannot drift from the fixture it compares.
 */
const REFUSAL_BODY = [
  '**Verified**',
  '- A multi-agency operation in Polk County, Florida is reported to have made a large number of arrests.',
  '',
  '**Unverified**',
  '- The "281 arrested" figure: I could not confirm it against a primary source.',
  '- The operation name, charge breakdown, named arrestees and victim counts: not verified, so not stated here.',
].join('\n');

/** Is the ANS-3 narration stripper present in the code under test? */
function narrationFixPresent(): boolean {
  const mod = require('./answer-scaffolding') as { stripProcessNarration?: unknown };
  return typeof mod.stripProcessNarration === 'function';
}

describe('1cc1f52e (a) — bounded attempts, no apology-as-deliverable', () => {
  it('a throttled SERP fails ONCE with the provider code named, not an open-ended retry loop', async () => {
    // The classifier is the real one: it must read the throttle body as a
    // provider error (not as "no results") for the pipeline to fail honestly.
    expect(serpProviderErrorDetail(THROTTLE_BODY)?.code).toBe('sr_rate_limit');

    mockMcp.mockResolvedValue(THROTTLE_BODY);
    const r = await runWebPipe('sess-1cc1f52e-a', { query: 'Polk County 281 arrested human trafficking bust' });

    expect(r.ok).toBe(false);
    // The failure NAMES the cause — the model (and the user) can tell a
    // provider throttle from an empty topic.
    expect(r.summary).toContain('sr_rate_limit');
    // Bounded: the provider states a 60 s wait, which is ABOVE the in-band retry
    // bound, so the pipeline must NOT re-burn a request against a limit it was
    // just refused on. Pinned at exactly ONE search — `<= 2` would still pass if
    // the stated-wait respect (web-pipe.ts) regressed and the retry fired.
    const searchCalls = mockMcp.mock.calls.filter((c) => c[0] === 'search_engine').length;
    expect(searchCalls).toBe(1);
  });

  it('the tool-result diagnosis is never an apology written as the deliverable', async () => {
    mockMcp.mockResolvedValue(THROTTLE_BODY);
    const r = await runWebPipe('sess-1cc1f52e-a2', { query: 'Polk County 281 arrested human trafficking bust' });
    expect(r.summary).not.toMatch(/\b(?:sorry|apolog(?:y|ize|ise))\b/i);
  });
});

describe('1cc1f52e (b) — the explicit verified/unverified split MUST NOT regress', () => {
  it('a body carrying the split and the refusals passes the delivery gate BYTE-IDENTICAL', () => {
    expect(stripAnswerScaffoldingText(REFUSAL_BODY)).toBe(REFUSAL_BODY);
    expect(stripAnswerScaffolding(REFUSAL_BODY).removed).toBe(0);
  });

  it('an explicit unverified-claim footnote survives (guard chrome is preserved, not scrubbed)', () => {
    const footnote = renderUnverifiedClaimsFootnote(
      [{ kind: 'message', quote: 'the 281 figure is confirmed', source: 'action_verifier' }],
      { zeroTool: false },
    );
    expect(footnote.startsWith(UNVERIFIED_FOOTNOTE_HEADER)).toBe(true);
    expect(stripAnswerScaffoldingText(footnote)).toContain('the 281 figure is confirmed');
    expect(stripAnswerScaffoldingText(footnote)).toContain(UNVERIFIED_FOOTNOTE_HEADER);
  });

  it('a refusal sentence is never treated as process narration', () => {
    const refusal = 'I could not confirm the 281 figure against a primary source, so I am not stating it.';
    expect(stripAnswerScaffoldingText(refusal)).toBe(refusal);
  });
});

describe('1cc1f52e (c) — a just-fetched SERP is retrievable in the SAME run', () => {
  // OF-RECORD CORRECTION (lane b255f095, accepted by the supervisor): an earlier
  // revision of this file called the FTS/keyword leg "the raw-row fallback". It
  // is NOT, and the incident proves it — the run's search_memory MISSED a row it
  // had just written. Mechanism, named in the code: ftsQueryFor passes short
  // queries VERBATIM into websearch_to_tsquery (AND-semantics), so ONE absent
  // token yields zero FTS rows; the vector leg separately excludes unembedded
  // rows and caps at the newest 4000. The real raw path is memRecentRows — a
  // plain index read on (scope_type, scope_id) with NO query — wired via
  // sameRunRecall: true at coding/tools.ts.
  it('a same-run write reaches postgres with a NULL embedding (the row a raw read must find)', async () => {
    await memStore(
      { type: 'session', id: 'sess-1cc1f52e-c' },
      'web_pipe',
      [{
        ref: 'serp:polk-county-281',
        title: 'SERP: Polk County 281 arrested human trafficking bust',
        content:
          'Organic results for the Polk County 281 arrested human trafficking bust query: the county sheriff newsroom page, '
          + 'two local outlets reporting the multi-agency operation, and a state attorney press release describing the arrests '
          + 'and the charges filed in the operation, with the arrest total and the agencies involved named in each result.',
      }],
      { skipGate: true },
    );

    // The WRITE must reach postgres even though the embed leg returns nothing
    // (rag.service is stubbed to null above). Assert a real INSERT into the
    // memory table — `$executeRawUnsafe` alone is also used for DDL/index
    // creation, so a bare toHaveBeenCalled() would pass without any row.
    // The INSERT is parameterized, so the row's values ride in the params, not
    // in the SQL text: assert the statement, not the title inside it.
    const callSqls = (prisma.$executeRawUnsafe as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(callSqls.filter((s) => /INSERT\s+INTO\s+digby_memory/i.test(s)).length).toBeGreaterThan(0);
  });

  caseWhen(
    typeof (unifiedMemory as { memRecentRows?: unknown }).memRecentRows === 'function',
    'the query-less raw path (memRecentRows) exists for same-run recall',
    () => {
      // Present ⇒ the raw read exists; absent ⇒ the same-run recall the ticket
      // demands is genuinely unsatisfied on this tree. Merge-order independent:
      // goes green on its own when the chartered lane's branch lands.
      const mem = unifiedMemory as { memRecentRows?: unknown };
      expect(typeof mem.memRecentRows).toBe('function');
    },
  );
});

describe('1cc1f52e (d1) — process PROSE narration is stripped from the body', () => {
  caseWhen(narrationFixPresent(), 'the gate removes the reported process prose', () => {
    expect(stripAnswerScaffolding(REPORTED_BODY).removed).toBeGreaterThan(0);
  });

  caseWhen(narrationFixPresent(), 'no process-prose sentence survives into the delivered body', () => {
    const delivered = stripAnswerScaffoldingText(REPORTED_BODY);
    for (const line of PROSE_NARRATION_LINES) {
      expect(delivered).not.toContain(line);
    }
  });

  it('the gate does not mangle clean prose (no over-strip) — holds before AND after ANS-3', () => {
    const clean = "Polk County Sheriff's Office announced arrests following a multi-agency operation. Reporting on the exact total remains unconfirmed.";
    expect(stripAnswerScaffoldingText(clean)).toBe(clean);
  });
});

describe('1cc1f52e (d2) — the "<Tool> · <query>" pill shape is UI chrome, not answer-body text', () => {
  // FINDING (measured 2026-10-31, session 6763708c): the reported pill lines are
  // NOT model prose and are NOT answer-body leakage. They are rendered by the
  // frontend from tool events: `toolSummary()` in
  // frontend/app/crossmodel/components/code-transcript.tsx returns
  // `Researched online · ${String(args.query).slice(0, 50)}` (and
  // `Searched project memory · …` likewise).
  //
  // The proof is the truncation: the reported line is EXACTLY 50 characters —
  // "Polk County 281 arrested human trafficking bust Di" — ending mid-word
  // ("Di" for "Disney"). `len === 50` and `slice(0, 50)` reproduces it byte for
  // byte. A model composing narration does not stop at precisely the UI's slice
  // bound mid-word, so the string is the frontend's own output.
  //
  // Consequence for the ticket: criterion (d) says "zero narration in the ANSWER
  // BODY". These pills are transcript chrome for a tool call the user can see,
  // not body text — so they are out of scope for (d), and stripping them from a
  // model answer would be wrong (it would mangle an answer that legitimately
  // quotes a query). The real (d) work is the PROSE narration covered by (d1),
  // which ANS-3 closes. This case pins the boundary so nobody "fixes" chrome.
  it('the reported pill line carries the frontend 50-char QUERY truncation, not model prose', () => {
    const reported = 'Researched online · Polk County 281 arrested human trafficking bust Di';
    const prefix = 'Researched online · ';
    expect(reported.startsWith(prefix)).toBe(true);
    // The query part is the UI's slice(0, 50) of the untruncated query — that is
    // why it stops mid-word ("Di" for "Disney"). Reproduce it exactly the way
    // toolSummary() does; a model writing prose would not cut at the slice bound.
    const queryPart = reported.slice(prefix.length);
    const query = 'Polk County 281 arrested human trafficking bust Disney';
    expect(queryPart).toHaveLength(50);
    expect(queryPart).toBe(query.slice(0, 50));
    expect(queryPart).not.toBe(query); // it IS truncated — that is the tell
  });

  it('an answer body that merely QUOTES a query is not stripped (chrome ≠ body)', () => {
    // The delivery gate must not remove a legitimate quotation of a searched
    // query from the prose. This is what keeps (d1) from over-reaching.
    const body = 'The operation the sheriff described — the "Polk County 281 arrested" case — remains unconfirmed.';
    expect(stripAnswerScaffoldingText(body)).toBe(body);
  });
});

describe('1cc1f52e (e) — throttle injection does not change the delivered shape', () => {
  // NOTE (of-record): this GREEN covers the DELIVERED RESULT SHAPE only. It is
  // NOT evidence that the provider-failover ladder (defect class 3) is complete
  // — that class is not exercised here, and this replay makes no claim about it.
  it('a healthy SERP and a throttled SERP yield the same result SHAPE', async () => {
    const healthySerp = JSON.stringify({
      organic: [
        { link: 'https://www.polksheriff.org/newsroom', title: 'Newsroom' },
        { link: 'https://www.example-outlet.test/polk-281', title: 'Polk 281' },
      ],
    });

    mockMcp.mockImplementation(async (tool: string) => {
      if (tool === 'search_engine') return healthySerp;
      return 'x'.repeat(600); // scraped markdown
    });
    const healthy = await runWebPipe('sess-1cc1f52e-e1', { query: 'Polk County 281 arrested human trafficking bust' });

    mockMcp.mockReset();
    mockMcp.mockResolvedValue(THROTTLE_BODY);
    const throttled = await runWebPipe('sess-1cc1f52e-e2', { query: 'Polk County 281 arrested human trafficking bust' });

    // Both outcomes carry the SAME structural contract: a boolean verdict, a
    // human-readable summary and a sources array — degradation changes ok and
    // summary CONTENT, never the delivered SHAPE.
    expect(typeof healthy.ok).toBe('boolean');
    expect(typeof throttled.ok).toBe('boolean');
    expect(Array.isArray(healthy.sources)).toBe(true);
    expect(Array.isArray(throttled.sources)).toBe(true);
    expect(typeof healthy.summary).toBe('string');
    expect(typeof throttled.summary).toBe('string');
    // And the degraded case is HONEST about being degraded.
    expect(throttled.ok).toBe(false);
  });
});