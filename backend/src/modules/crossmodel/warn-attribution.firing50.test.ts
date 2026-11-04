/**
 * Warn-attribution pin — FO firing 50 (2026-09-29).
 *
 * THE DEFECT: the audit's errors_4h `unattributed` column (added firing 48)
 * exposed warn classes still landing app_error_logs rows with context=null:
 *   - mcp-search.ts (web-search gateway health / circuit / SSE / SERP classes, ~23/4h)
 *   - coding-model.ts runModelTurn 400 fingerprint (~10/4h)
 *   - coding/tools.ts `coding tool <name> failed` (~3/4h)
 *   - platform.service.ts startCodingSession resolution (~3/4h)
 *   - action-verifier.ts (claim-extraction / phantom-citation classes — NEW this firing)
 * None carried logger META, so no session/run/chat could be attributed.
 *
 * THE FIX: every one of those sites passes a meta object as logger.warn's
 * second arg — { sessionId, runId?, userId?, chatId? } where the scope holds
 * them, plus a stable `source:` class tag — the same doctrine as firing-48's
 * agentWarn (agentLoop) and utility-override stamps.
 *
 * THIS PIN has two legs:
 *   A. BEHAVIORAL (mcp-search, the biggest live class): drive the real
 *      gatewayTier token-gate path with the direct tier down and assert the
 *      warn carries { source: 'web-search', tool }.
 *   B. SOURCE-SHAPE (all five files): scan every logger.warn(…) call span and
 *      assert it stamps `source:` — a new scope-less warn added to these files
 *      fails this test, so the class cannot silently regrow.
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPost = jest.fn();
const mockGet = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: { post: (...a: any[]) => mockPost(...a), get: (...a: any[]) => mockGet(...a) },
}));

const mockTryDirect = jest.fn();
const mockDirectAvailable = jest.fn(() => true);
jest.mock('./brightdata-direct', () => ({
  ...jest.requireActual('./brightdata-direct'),
  tryDirectBrightData: (...a: any[]) => mockTryDirect(...a),
  directBrightDataAvailable: () => mockDirectAvailable(),
}));

const mockExtractPdfText = jest.fn();
jest.mock('./pdf-extract', () => ({
  extractPdfText: (...a: any[]) => mockExtractPdfText(...a),
}));

const mockMetric = jest.fn();
jest.mock('./platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockMetric(...a),
  LOOP_METRIC_KINDS: { WEB_FETCH_PATH: 'web_fetch_path' },
}));

import fs from 'fs';
import path from 'path';

/** Balanced-paren scan: the full text of every logger.warn(…) call in src. */
function warnSpans(rel: string): string[] {
  const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
  const spans: string[] = [];
  let i = 0;
  while ((i = src.indexOf('logger.warn(', i)) !== -1) {
    let depth = 0;
    let j = i + 'logger.warn('.length - 1; // positioned at '('
    for (; j < src.length; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')') { depth--; if (depth === 0) break; }
    }
    spans.push(src.slice(i, j + 1));
    i = j + 1;
  }
  return spans;
}

describe('warn attribution (FO firing 50 — app_error_logs context)', () => {
  describe('A. behavioral — mcp-search gateway tier', () => {
    beforeEach(() => {
      jest.resetModules();
      mockPost.mockReset();
      mockGet.mockReset();
      mockTryDirect.mockReset();
      mockDirectAvailable.mockReturnValue(true);
      delete process.env.MCP_DIGBY_TOKEN;
    });
    afterAll(() => { delete process.env.MCP_DIGBY_TOKEN; });

    it('the token-gate warn carries { source, tool } meta (the class the audit saw ~23×/4h)', async () => {
      mockTryDirect.mockResolvedValue(null); // direct tier down → falls to the gateway tier
      const { callMcpTool } = require('./mcp-search');
      const logger: { warn: jest.Mock } = require('../../utils/logger').default;

      const out = await callMcpTool('search_engine', { query: 'x', engine: 'google' });
      expect(out).toBeNull(); // both tiers down — the proven null-result path

      const tokenWarn = logger.warn.mock.calls.find((c: any[]) => String(c[0]).includes('MCP_DIGBY_TOKEN not set'));
      expect(tokenWarn).toBeTruthy();
      expect(tokenWarn![1]).toMatchObject({ source: 'web-search', tool: 'search_engine' });
    });
  });

  describe('B. source-shape — every logger.warn in the pinned files stamps meta', () => {
    it('mcp-search.ts: EVERY warn span carries source: web-search (14 sites)', () => {
      const spans = warnSpans('mcp-search.ts');
      expect(spans.length).toBeGreaterThanOrEqual(14);
      const bare = spans.filter((s) => !s.includes("source: 'web-search'"));
      expect(bare).toEqual([]); // names the offender(s) on failure
    });

    it('action-verifier.ts: EVERY warn span carries source: action-verifier (27 sites)', () => {
      const spans = warnSpans('platform/action-verifier.ts');
      expect(spans.length).toBeGreaterThanOrEqual(27);
      const bare = spans.filter((s) => !s.includes("source: 'action-verifier'"));
      expect(bare).toEqual([]);
    });

    it('coding-model.ts: the 400-fingerprint warn stamps { model, source }', () => {
      const span = warnSpans('coding/coding-model.ts').find((s) => s.includes('runModelTurn 400 fingerprint'));
      expect(span).toBeTruthy();
      expect(span).toContain("source: 'run-model-turn'");
      expect(span).toContain('model:');
    });

    // FO firing 55 (2026-09-30): the audit convicted TWO more live unattributed
    // classes — chat-agent 'machine-wake note struck pre-delivery' (2/4h) and
    // coding-model 'runModelTurn … rejected max_tokens' (3/4h) — plus a full
    // sweep found ~51 more bare logger.warn sites in chat-agent.service.ts and
    // 5 in coding-model.ts. Both files are now FULLY stamped (whole-file
    // source-shape, per this test's doctrine).
    it('chat-agent.service.ts: EVERY warn span carries a source stamp (~60 sites)', () => {
      const spans = warnSpans('chat-agent/chat-agent.service.ts');
      expect(spans.length).toBeGreaterThanOrEqual(60);
      const bare = spans.filter((s) => !s.includes('source:'));
      expect(bare).toEqual([]); // names the offender(s) on failure
    });

    it('chat-agent.service.ts: the machine-wake reject-back warn (the audited class) stamps chat-agent', () => {
      const span = warnSpans('chat-agent/chat-agent.service.ts').find((s) => s.includes('note struck pre-delivery'));
      expect(span).toBeTruthy();
      expect(span).toContain("source: 'chat-agent'");
    });

    it('coding-model.ts: EVERY warn span carries a source stamp (6 sites)', () => {
      const spans = warnSpans('coding/coding-model.ts');
      expect(spans.length).toBeGreaterThanOrEqual(6);
      const bare = spans.filter((s) => !s.includes('source:'));
      expect(bare).toEqual([]);
    });

    it('coding-model.ts: the output-budget max_tokens REPAIR is handled, not a warn (ticket c6af45ef)', () => {
      // FO firing 55 stamped it as a warn in 2026-09-30 — correct then, wrong
      // once the rows proved it fires on EVERY turn of a prompt-derived-cap
      // seat (21 rows / 21 min on tt-qwen3.8-flash-next, all max_tokens
      // 131072): a repair that worked is not a fault, and an untagged warn made
      // the sweep file it in perpetuity. It is now logHandled (info +
      // logClass:'handled'); the message text is unchanged so greps and the
      // audit pins still match it. The occurrences stay measurable as
      // loop_metrics provider_rejected rows (meta.lane 'output_budget').
      const src = fs.readFileSync(path.join(__dirname, 'coding/coding-model.ts'), 'utf8');
      expect(src).toContain('logHandled(`runModelTurn: ${provider.model} (${provider.label}) rejected ${capKey}');
      expect(src).not.toContain('logger.warn(`runModelTurn: ${provider.model} (${provider.label}) rejected ${capKey}');
      // The five remaining warn sites in this file all stay stamped.
      const spans = warnSpans('coding/coding-model.ts');
      expect(spans.length).toBeGreaterThanOrEqual(5);
      expect(spans.filter((s) => !s.includes('source:'))).toEqual([]);
    });

    // FO firing 58 (2026-10-01): the audit convicted the owner-briefing
    // service's warn class as the live unattributed rows of the window —
    // 'N of N LLM project line(s) ungrounded' (context null, no source).
    // Whole file stamped in the same firing (9 sites), same doctrine as
    // chat-agent/coding-model above.
    it('owner-briefing.service.ts: EVERY warn span carries a source stamp (9 sites)', () => {
      const spans = warnSpans('fleet/owner-briefing.service.ts');
      expect(spans.length).toBeGreaterThanOrEqual(9);
      const bare = spans.filter((s) => !s.includes("source: 'owner-briefing'"));
      expect(bare).toEqual([]); // names the offender(s) on failure
    });

    it('coding/tools.ts: the tool-failed catch stamps { sessionId, runId, userId, source, tool }', () => {
      const span = warnSpans('coding/tools.ts').find((s) => s.includes('coding tool ${name} failed'));
      expect(span).toBeTruthy();
      expect(span).toContain("source: 'coding-tool'");
      expect(span).toContain('sessionId');
      expect(span).toContain('runId');
      expect(span).toContain('userId');
      expect(span).toContain('tool:');
    });

    it('platform.service.ts: the startCodingSession resolution warn stamps { userId, projectId, source }', () => {
      const span = warnSpans('platform/platform.service.ts').find((s) => s.includes('startCodingSession target resolution failed'));
      expect(span).toBeTruthy();
      expect(span).toContain("source: 'platform-start-coding-session'");
      expect(span).toContain('userId');
      expect(span).toContain('projectId');
    });

    // FO firing 59 (2026-10-01): the audit convicted the helper-seat fallback
    // chain's three warn sites as the window's live unattributed rows —
    // 'helper-seat [web_pipe]: custom helper seat cql-litellm … failed' with
    // app_error_logs context null (4 rows, the whole unattributed:4 class).
    // Whole file stamped in the same firing, same doctrine as f55/f58 above.
    it('helper-seat.ts: EVERY warn span carries a source stamp (3 sites)', () => {
      const spans = warnSpans('coding/helper-seat.ts');
      expect(spans.length).toBeGreaterThanOrEqual(3);
      const bare = spans.filter((s) => !s.includes("source: 'helper-seat'"));
      expect(bare).toEqual([]); // names the offender(s) on failure
    });
  });
});
