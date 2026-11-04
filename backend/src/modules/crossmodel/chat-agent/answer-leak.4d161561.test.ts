/**
 * Ticket 4d161561 (escalation d36ad50a) — "live-chat audit: internal text leaked into answers".
 *
 * The audit's ANSWER_LEAK_RE convicts a DELIVERED human-turn answer that carries model
 * scaffolding. This suite is the regression pin for the delivered-answer gate
 * (chat-agent/answer-scaffolding.ts): one fixture per ALTERNATIVE of the detector's own regex,
 * pushed through the same composition the chat-agent finalize applies, then re-tested with the
 * REAL regex — so a shape that starts surviving fails HERE first instead of in the nightly audit.
 *
 * Fixtures are synthetic. No production message text is used anywhere in this file — the audit
 * stores no message text, and the ticket's hard limit is counts and regex captures only.
 */
// The DETECTOR of record is imported for real (the pin must be the audit's own regex, not a copy),
// so its module graph's env-validating imports are stubbed exactly as platform/live-chat-audit.test.ts does.
jest.mock('../../../config/database', () => ({ __esModule: true, default: { $queryRaw: jest.fn(), crossModelMessage: { findMany: jest.fn(async () => []), count: jest.fn(async () => 0), findFirst: jest.fn(async () => null) }, messageFeedback: { findMany: jest.fn(async () => []) }, loopMetric: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) } } }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../platform/loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: jest.fn() }));
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: jest.fn(async () => '') }));
jest.mock('../coding/coding-model', () => ({ __esModule: true, resolveProviderForRun: jest.fn(async () => null) }));
jest.mock('../coding/helper-completion', () => ({ __esModule: true, runHelperCompletion: jest.fn(async () => ({ text: '', hadReasoning: false, finishReason: 'stop' })) }));
jest.mock('./handback-detector', () => ({ __esModule: true, findHandback: () => null }));

import {
  scrubDeliveredRowContent,
  stripAnswerScaffolding,
  stripAnswerScaffoldingText,
  CHAT_TOOL_NAME_RE_SRC,
} from './answer-scaffolding';
import { stripAnswerMarkup } from '../langgraph/pipeline-utils';
import { ANSWER_LEAK_RE } from '../platform/live-chat-audit';

/** The exact composition the chat-agent finalize applies to the delivered answer (content and parts). */
function delivered(text: string): string {
  return stripAnswerMarkup(stripAnswerScaffoldingText(text));
}

// Tags are assembled from fragments: a scaffolding marker written literally in this file would be
// indistinguishable from the thing under test, and diff/render steps like to eat them.
const OPEN = '<' + 'think>';
const CLOSE = '<' + '/think>';
const CLOSE_LONG = '<' + '/thinking>';
const BAR = '\uFF5C'; // the fullwidth bar the native tool tokens use
/** The detector's first alternative, assembled for the same reason. */
const THINK_ALT = '<' + 'think';

/** ANSWER_LEAK_RE's alternatives, verbatim — the coverage guard below fails if the detector gains one. */
const ALTERNATIVES = [
  THINK_ALT,
  '<\\/think>',
  '\\[FOLLOWUPS',
  '<\\|tool',
  '<function=',
  '\\bDSML\\b',
  '\\[MACHINE-TRIGGERED',
  '\\[HARNESS ',
  '"name"\\s*:\\s*"(?:search_engine|scrape_as_markdown|web_pipe|create_document|generate_image)"',
];

interface Fixture {
  shape: string;
  /** The ANSWER_LEAK_RE alternative this fixture exercises. */
  matchedBy: string;
  /** Whether the detector convicts the RAW text (i.e. this shape really is one it reports). */
  detectorFires: boolean;
  input: string;
}

const LEAK_FIXTURES: Fixture[] = [
  {
    shape: 'matched reasoning pair mid-answer',
    matchedBy: THINK_ALT,
    detectorFires: true,
    input: `The rate is 4.2%.\n\n${OPEN} let me double-check the table \u2026 ${CLOSE}\n\nThat holds for 2026.`,
  },
  {
    shape: 'stray closing reasoning tag',
    matchedBy: '<\\/think>',
    detectorFires: true,
    input: `The rate is 4.2%.\n${CLOSE}`,
  },
  {
    shape: 'mismatched reasoning pair (opens think, closes thinking)',
    matchedBy: THINK_ALT,
    detectorFires: true,
    input: `Scratch work \u2026${OPEN} \u2026 ${CLOSE_LONG}\n\nThe answer: 4.2%.`,
  },
  {
    shape: 'unterminated reasoning opener at the tail',
    matchedBy: THINK_ALT,
    detectorFires: true,
    input: `The answer: 4.2%.\n\n${OPEN} still weighing whether the table is current`,
  },
  {
    shape: '[FOLLOWUPS] markup (already handled \u2014 pinned so the gate keeps composing with it)',
    matchedBy: '\\[FOLLOWUPS',
    detectorFires: true,
    input: 'The rate is 4.2%.\n\n[FOLLOWUPS]\n- How was that measured?\n[/FOLLOWUPS]',
  },
  {
    shape: 'ASCII native special token',
    matchedBy: '<\\|tool',
    detectorFires: true,
    input: 'The rate is 4.2%.\n<|tool_call|>{"name":"search_engine"}<|/tool_call|>',
  },
  {
    shape: 'Anthropic-style function-call fragment (bare <function=…>)',
    matchedBy: '<function=',
    detectorFires: true,
    input: 'Checking that now.\n<function=search_engine>{"query":"prime rate"}</function>',
  },
  {
    shape: '<function_call> block (the detector misses this one; the gate strips it anyway)',
    matchedBy: '<function=',
    detectorFires: false,
    input: 'One moment.\n<function_call>{"name":"web_pipe"}</function_call>',
  },
  {
    shape: 'native fullwidth-bar tool token block (DeepSeek/Kimi shape)',
    matchedBy: '\\bDSML\\b',
    detectorFires: true,
    input: `Let me look.\n<${BAR}DSML${BAR}invoke name="search_engine">x</${BAR}DSML${BAR}invoke>\n</${BAR}DSML${BAR}tool_calls>`,
  },
  {
    shape: 'harness [MACHINE-TRIGGERED RUN] wake header echoed into the answer',
    matchedBy: '\\[MACHINE-TRIGGERED',
    detectorFires: true,
    input: '[MACHINE-TRIGGERED RUN \u2014 a scheduled firing, NOT a human-typed message.]\n\nNothing needs your attention today.',
  },
  {
    shape: 'harness [HARNESS CLOCK] system note echoed into the answer',
    matchedBy: '\\[HARNESS ',
    detectorFires: true,
    input: '[HARNESS CLOCK \u2014 not typed by the user] Current time: 2026-10-31T12:00:00Z\n\nThe deploy is green.',
  },
  {
    shape: 'harness [EVIDENCE LEDGER] note echoed into the answer (detector misses it; the gate strips it)',
    matchedBy: '\\[HARNESS ',
    detectorFires: false,
    input: '[EVIDENCE LEDGER \u2014 ids a tool result ACTUALLY returned this run: ticket abcd1234]\n\nThe ticket is open.',
  },
  {
    shape: 'a [HARNESS NOTICE] prefix bolted onto an otherwise useful line',
    matchedBy: '\\[HARNESS ',
    detectorFires: true,
    input: '[HARNESS NOTICE] The following text described tool calls that were emitted as plain text.\n\nThe rate is 4.2%.',
  },
  {
    shape: 'bare function-call JSON object with arguments',
    matchedBy: '"name"\\s*:\\s*"(?:search_engine|scrape_as_markdown|web_pipe|create_document|generate_image)"',
    detectorFires: true,
    input: 'Let me check.\n{"name": "search_engine", "arguments": {"query": "prime rate"}}\n\nIt is 4.2%.',
  },
  {
    shape: 'name-only call object (a stream-cut call loses its arguments)',
    matchedBy: '"name"\\s*:\\s*"(?:search_engine|scrape_as_markdown|web_pipe|create_document|generate_image)"',
    detectorFires: true,
    input: 'Let me check.\n{"name": "web_pipe"}\n\nIt is 4.2%.',
  },
];

describe('answer-leak 4d161561 \u2014 the delivered answer never carries model scaffolding', () => {
  it.each(LEAK_FIXTURES)('strips: $shape', ({ input, detectorFires }) => {
    if (detectorFires) expect(ANSWER_LEAK_RE.test(input)).toBe(true);
    const out = delivered(input);
    // The pin: nothing the detector can name survives the delivered composition.
    expect(ANSWER_LEAK_RE.test(out)).toBe(false);
  });

  it('keeps the surrounding prose \u2014 the gate removes scaffolding, never the answer', () => {
    expect(delivered(`The rate is 4.2%.\n\n${OPEN} checking ${CLOSE}`)).toBe('The rate is 4.2%.');
    expect(delivered('Let me check.\n{"name": "search_engine", "arguments": {"query": "prime rate"}}\n\nIt is 4.2%.'))
      .toBe('Let me check.\n\nIt is 4.2%.');
    expect(delivered('[MACHINE-TRIGGERED RUN \u2014 a firing.]\n\nNothing needs your attention today.'))
      .toBe('Nothing needs your attention today.');
  });

  it('the recorded pre-fix gap: the legacy composition alone left <function= and bare <|tool |> in the answer', () => {
    // Documented, not aspirational: stripAnswerMarkup (canvas + follow-ups) was the ONLY strip on the
    // plain-chat answer path, and the detector convicts both shapes in its output. These two assertions are
    // the "fails on the pre-4d161561 code" half of the ticket's acceptance bar — change them only with a
    // ticket that moves the gate itself.
    const fn = 'Checking now.\n<function=search_engine>{"query":"x"}</function>';
    const token = 'The result.\n<|tool_call|>';
    expect(ANSWER_LEAK_RE.test(stripAnswerMarkup(fn))).toBe(true);
    expect(ANSWER_LEAK_RE.test(stripAnswerMarkup(token))).toBe(true);
    // …and the gate closes both.
    expect(ANSWER_LEAK_RE.test(delivered(fn))).toBe(false);
    expect(ANSWER_LEAK_RE.test(delivered(token))).toBe(false);
  });

  it('every alternative of ANSWER_LEAK_RE is pinned here \u2014 a new alternative must add a fixture', () => {
    // The detector is the contract: if EITHER assertion below fails, ANSWER_LEAK_RE changed shape and the
    // gate's coverage must be extended in the same change (and this pin updated with it).
    for (const alt of ALTERNATIVES) expect(ANSWER_LEAK_RE.source).toContain(alt);
    // Measured 2026-10-31: 180 chars, 9 top-level alternatives. A new alternative moves this number.
    expect(ANSWER_LEAK_RE.source.length).toBe(180);
    const covered = new Set(LEAK_FIXTURES.map((f) => f.matchedBy));
    for (const alt of ALTERNATIVES) expect(covered.has(alt)).toBe(true);
  });

  it('leaves clean answers byte-identical (no collateral damage on ordinary prose or markdown)', () => {
    const clean = [
      'The prime rate is 4.2% as of 2026-10-31.\n\n| Year | Rate |\n| --- | --- |\n| 2026 | 4.2% |',
      'Run `npm test` and then `jest --watch`.\n\n```ts\nconst x = a < b ? 1 : 2;\n```',
      'Deeper findings: the ledger reconciles to zero.',
      'I think the 2026 table is right, but the 2025 column looks off.',
    ];
    for (const t of clean) expect(delivered(t)).toBe(t);
  });

  it("keeps the harness's OWN delivered guard chrome (not model scaffolding)", () => {
    const guard = '[ACTION VERIFIER \u2014 1 claim struck] The send was not executed.';
    const evidenceGuard = '[HARNESS EVIDENCE GUARD \u2014 CLAIMS BLOCK] 1 line rewritten.';
    expect(stripAnswerScaffoldingText(guard)).toBe(guard);
    expect(stripAnswerScaffoldingText(evidenceGuard)).toBe(evidenceGuard);
  });

  it('never deletes marker text a human is being SHOWN \u2014 fenced code and block quotes stay', () => {
    const fenced = 'The wake line looks like this:\n\n```\n[HARNESS CLOCK] Current time: \u2026\n```';
    const quoted = 'The harness printed:\n\n> [EVIDENCE LEDGER \u2014 3 ids]\n\nso I used those ids.';
    expect(stripAnswerScaffoldingText(fenced)).toBe(fenced);
    expect(stripAnswerScaffoldingText(quoted)).toBe(quoted);
  });

  it('is idempotent and reports what it removed', () => {
    const messy = `A.\n<function=web_pipe>{"q":1}</function>\n[HARNESS CLOCK] now\nB.`;
    const once = stripAnswerScaffolding(messy);
    expect(once.removed).toBeGreaterThan(0);
    expect(once.stripped.map((s) => s.shape)).toEqual(expect.arrayContaining(['tool-call-markup', 'harness-marker']));
    const twice = stripAnswerScaffolding(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.removed).toBe(0);
  });

  it('a leaked call object is removed whole, including its nested arguments', () => {
    const out = stripAnswerScaffoldingText('Before.\n{"name": "create_document", "arguments": {"title": "x", "sheets": [1, 2]}}\nAfter.');
    expect(out).toBe('Before.\n\nAfter.');
  });

  /**
   * The ROW seam. chat-agent composes the persisted `content` from the finalize text PLUS the
   * structured blocks carried from the answer's parts and the escalation title — assembled AFTER
   * the finalize gate — and the nightly audit convicts THAT string. A scaffolding shape living in
   * a carried block is exactly the miss this seam closes.
   */
  describe('the persisted row (content) seam', () => {
    it('gates the carried-block tail the finalize strip never saw', () => {
      const row = `The answer is 4.2%.\n\n---\nCarried forward from the answer above:\n\n<function=web_pipe>{"q":"x"}</function>\n${OPEN} kept thinking ${CLOSE}`;
      const out = scrubDeliveredRowContent(row);
      expect(ANSWER_LEAK_RE.test(out)).toBe(false);
      // The label the readers key on survives — the gate strips scaffolding, not structure.
      expect(out).toContain('Carried forward from the answer above:');
      expect(out).toContain('The answer is 4.2%.');
    });

    it('gates an escalation title line too', () => {
      expect(ANSWER_LEAK_RE.test(scrubDeliveredRowContent(`**Deeper findings**\n\n<|tool_call|>\n\n4.2%.`))).toBe(false);
    });

    it('preserves a trailing harness appendix byte-identically (harness-authored, not the model)', () => {
      const row = 'The ticket is open.\n\nACTIONS TAKEN (harness):\n- triage_ticket\n- +1 more';
      expect(scrubDeliveredRowContent(row)).toBe(row);
      const record = 'Nothing needs attention.\n\nHarness record: 2 lane actions.';
      expect(scrubDeliveredRowContent(record)).toBe(record);
    });

    it('preserves a delivered guard-chrome row that OPENS with the harness banner', () => {
      const row = '[HARNESS EVIDENCE GUARD — CLAIMS BLOCK] 1 line rewritten.\n\nThe deploy is green.';
      expect(scrubDeliveredRowContent(row)).toBe(row);
    });

    it('is idempotent', () => {
      const row = 'A.\n\n<function=search_engine>{"q":1}</function>';
      const once = scrubDeliveredRowContent(row);
      expect(scrubDeliveredRowContent(once)).toBe(once);
    });
  });

  it('the JSON rule covers every tool id the detector names plus the agent loop vocabulary', () => {
    const re = new RegExp(`^(?:${CHAT_TOOL_NAME_RE_SRC})$`);
    for (const name of ['search_engine', 'scrape_as_markdown', 'web_pipe', 'create_document', 'generate_image', 'get_chat_status', 'run_command']) {
      expect(re.test(name)).toBe(true);
    }
  });
});