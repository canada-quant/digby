/**
 * Replay/regression tests for feedback ticket 938dac2e (mishap, fleet-integrity,
 * 2026-09-15): "Agent lane fabricated an entire run report (tt-rd firing-445):
 * phantom artifacts + nonexistent todo/owner-question citations".
 *
 * THE MISHAP BEING REPLAYED: the tt-rd main lane (chat a8976e11) published a
 * final run report whose claimed artifacts DO NOT EXIST — its cited todo
 * 1c0db1a5 returned "Todo not found", its cited owner-question oq_8c8b15d4
 * matched no owner_questions row, and its on-box md5s matched nothing — the
 * first WHOLE-report fabrication (the phantom-citation family to date was
 * single invented ids inside otherwise real reports). Only that project's
 * self-audit habit caught it (self-audit CLOSED 8/8, transcript head
 * ebba237a). Lanes without a self-audit could land the class silently.
 *
 * THE FIX (this PR — GUARD 7, run-evidence-guard.ts): two new citation lanes
 * mirroring GUARD 6's two-lane discipline for the two DB-checkable classes the
 * report carried — project-board todo ids and owner-question (oq_) ids. Lane
 * A: an id this run's own evidence carries (a todo receipt's ids.todoId, or
 * the id present in the run's tool-output haystacks) is observed-real. Lane B:
 * the executor's injected prisma resolvers (todoIdsExist /
 * ownerQuestionIdsExist); absent or throwing → SILENT. A citation neither
 * vouches for convicts (fabricatedTodoIds / fabricatedOwnerQuestionIds) with
 * the guard's strip+mark note. Repo-artifact (path-on-MAIN) and md5 claims are
 * deliberately NOT in this lane — no cheap deterministic primary source (see
 * the PR body); the todo + oq classes are the deterministic core.
 *
 * Boundary-mocked like run-evidence-guard.test.ts: logger + the GitHub token
 * manager are stubs, global.fetch is a mock; the REAL guard module executes.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockGetValidToken: jest.Mock = jest.fn(async () => 'tok');
jest.mock('../github/token-manager', () => ({
  __esModule: true,
  getValidToken: (...a: any[]) => mockGetValidToken(...a),
}));

import {
  applyCompletionClaimGuard,
  extractTodoIdCitations,
  extractOwnerQuestionCitations,
  guardFindingKinds,
  summarizeGuardVerdict,
  verdictHasFindings,
} from './run-evidence-guard';

const OPTS = { userId: 'u1', repoUrl: null, provider: null, githubLabel: null };

const realFetch = global.fetch;
const mockFetch: jest.Mock = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  mockGetValidToken.mockResolvedValue('tok');
  mockFetch.mockReset();
  global.fetch = mockFetch as any;
});

afterEach(() => {
  global.fetch = realFetch;
});

// ── extraction: todos ─────────────────────────────────────────────────────────

describe('extractTodoIdCitations (ticket 938dac2e)', () => {
  it('lifts 8-hex prefixes and full uuids after a todo cue, deduped', () => {
    const text = 'Board: todo 1c0db1a5 done; todo 1c0db1a5-2a93-4b50-8169-cb121a9721b3 also closed.';
    // Order-agnostic: the full-uuid path (a) runs before the cue-chain path (b).
    expect(extractTodoIdCitations(text).map((c) => c.id).sort()).toEqual([
      '1c0db1a5',
      '1c0db1a5-2a93-4b50-8169-cb121a9721b3',
    ].sort());
  });

  it('walks comma chains ("todos 1c0db1a5, ab12cd34 done")', () => {
    expect(extractTodoIdCitations('todos 1c0db1a5, ab12cd34 done').map((c) => c.id)).toEqual(['1c0db1a5', 'ab12cd34']);
  });

  it('a date-shaped 8-digit token is never a todo id', () => {
    expect(extractTodoIdCitations('todo 20260915 review the board')).toEqual([]);
  });

  it('review F1 (PR #811): a bare uuid of ANOTHER id family on a todo-word line is never a todo citation', () => {
    // The F1 false-conviction shape the reviewer reprobed: machine audit finals
    // carry run/schedule/chat uuids on "todo:" lines constantly. GUARD 6's
    // uuid-anywhere path is deliberately NOT copied — only cue-governed ids lift.
    expect(extractTodoIdCitations('todo: continue the review in run 5e61266b-49ad-47a3-8241-c5fd8a303b90 window.')).toEqual([]);
    expect(extractTodoIdCitations('todo: next firing verifies 824b0d28-9c8b-4056-a176-cd222c3f4056 stayed active.')).toEqual([]);
    expect(extractTodoIdCitations('todo: follow up with chat 810c924d-1c74-4295-8049-9b48335c6c37 about the gate.')).toEqual([]);
  });

  it('review F2 (PR #811): backticked/quoted/bold ids after the cue still extract (fleet markdown cannot evade)', () => {
    expect(extractTodoIdCitations('Board: todo `1c0db1a5` done.').map((c) => c.id)).toEqual(['1c0db1a5']);
    expect(extractTodoIdCitations('Board: todo **1c0db1a5** done.').map((c) => c.id)).toEqual(['1c0db1a5']);
    expect(extractTodoIdCitations("Board: todo '1c0db1a5' done.").map((c) => c.id)).toEqual(['1c0db1a5']);
    expect(extractTodoIdCitations('todos `1c0db1a5`, `ab12cd34` done').map((c) => c.id)).toEqual(['1c0db1a5', 'ab12cd34']);
  });

  it('skips absence reports and refutation/audit lines', () => {
    expect(extractTodoIdCitations('todo 1c0db1a5 → 404 on a fresh pull')).toEqual([]);
    expect(extractTodoIdCitations('the lane cited invented todo 1c0db1a5')).toEqual([]);
    // The 938dac2e self-audit's own phrasings — convicting these strikes the messenger:
    expect(extractTodoIdCitations("its cited todo 1c0db1a5 returns 'Todo not found'")).toEqual([]);
    expect(extractTodoIdCitations('todo 1c0db1a5 — no such row in project_todos')).toEqual([]);
  });

  it('ignores lines with no todo cue ("merge sha fb4ab3bd landed")', () => {
    expect(extractTodoIdCitations('merged the fix; merge sha fb4ab3bd landed cleanly')).toEqual([]);
  });

  it('a todo id inside a parsed ```claims fence is typed context, not a prose citation', () => {
    const text = [
      'Dispatched the worker for todo follow-up.',
      '```claims',
      '[{"type":"dispatch","ref":"ab12cd34"}]',
      '```',
    ].join('\n');
    expect(extractTodoIdCitations(text)).toEqual([]);
  });
});

// ── extraction: owner questions ───────────────────────────────────────────────

describe('extractOwnerQuestionCitations (ticket 938dac2e)', () => {
  it('lifts oq_<8-hex> and oq_<uuid> citations', () => {
    const text = 'Gate: oq_8c8b15d4 answered; see also oq_1c0db1a5-2a93-4b50-8169-cb121a9721b3.';
    expect(extractOwnerQuestionCitations(text).map((c) => c.id)).toEqual([
      'oq_8c8b15d4',
      'oq_1c0db1a5-2a93-4b50-8169-cb121a9721b3',
    ]);
  });

  it('skips absence reports and refutation/audit lines', () => {
    expect(extractOwnerQuestionCitations('oq_8c8b15d4 → not found')).toEqual([]);
    expect(extractOwnerQuestionCitations('the lane cited a fabricated oq_8c8b15d4')).toEqual([]);
    // The 938dac2e self-audit's own phrasing:
    expect(extractOwnerQuestionCitations('its cited owner-question oq_8c8b15d4 matches no row')).toEqual([]);
  });

  it('backticked oq_ ids still extract (\\b already spans the quote)', () => {
    expect(extractOwnerQuestionCitations('Gate: `oq_8c8b15d4` answered.').map((c) => c.id)).toEqual(['oq_8c8b15d4']);
  });

  it('an oq_ ref inside a parsed ```claims fence is typed context, not a prose citation', () => {
    const text = [
      'Flagged the gate question for the owner.',
      '```claims',
      '[{"type":"message_sent","ref":"oq_ab12cd34"}]',
      '```',
    ].join('\n');
    expect(extractOwnerQuestionCitations(text)).toEqual([]);
  });
});

// ── the lane (conviction + exoneration) ───────────────────────────────────────

describe('GUARD 7 lane — board-citation existence via injected resolvers', () => {
  const INCIDENT_FINAL = [
    'Firing-445 report.',
    'Fold section landed on MAIN; serving attempt #3 queued under the redesigned gate.',
    'Board: todo 1c0db1a5 done.',
    'Gate: oq_8c8b15d4 answered the fold-readiness question.',
  ].join('\n');

  const guard = (extra: Record<string, unknown>) =>
    applyCompletionClaimGuard({
      finalText: INCIDENT_FINAL,
      parts: [],
      triggerKind: 'schedule',
      resumed: false,
      ...OPTS,
      ...extra,
    } as any);

  it('REPLAY: the incident shape convicts both classes with strip+mark notes (resolvers know nothing)', async () => {
    const out = await guard({
      todoIdsExist: async () => new Set<string>(),
      ownerQuestionIdsExist: async () => new Set<string>(),
    });
    expect(out.verdict.fabricatedTodoIds).toEqual(['1c0db1a5']);
    expect(out.verdict.fabricatedOwnerQuestionIds).toEqual(['oq_8c8b15d4']);
    expect(verdictHasFindings(out.verdict)).toBe(true);
    expect(guardFindingKinds(out.verdict)).toEqual(
      expect.arrayContaining(['fabricated_todo_id', 'fabricated_owner_question_id']),
    );
    expect(out.finalText).toContain('[HARNESS EVIDENCE GUARD — FABRICATED TODO IDS]');
    expect(out.finalText).toContain('[HARNESS EVIDENCE GUARD — FABRICATED OWNER-QUESTION IDS]');
    expect(out.finalText).toContain('938dac2e');
    const summary = summarizeGuardVerdict(out.verdict);
    expect(summary).toContain('fabricated todo ids (no such board todo): 1c0db1a5');
    expect(summary).toContain('fabricated owner-question ids (no such oq_ row): oq_8c8b15d4');
  });

  it('honest citation: the resolver vouching for the ids keeps the lane silent', async () => {
    const out = await guard({
      todoIdsExist: async (ids: string[]) => new Set(ids),
      ownerQuestionIdsExist: async (ids: string[]) => new Set(ids),
    });
    expect(out.verdict.fabricatedTodoIds ?? []).toEqual([]);
    expect(out.verdict.fabricatedOwnerQuestionIds ?? []).toEqual([]);
    expect(out.finalText).not.toContain('FABRICATED TODO IDS');
    expect(out.finalText).not.toContain('FABRICATED OWNER-QUESTION IDS');
  });

  it('no resolver injected → silent (never a conviction on unavailable verification)', async () => {
    const out = await guard({});
    expect(out.verdict.fabricatedTodoIds ?? []).toEqual([]);
    expect(out.verdict.fabricatedOwnerQuestionIds ?? []).toEqual([]);
  });

  it('a THROWING resolver → silent (a DB hiccup never convicts)', async () => {
    const out = await guard({
      todoIdsExist: async () => { throw new Error('db down'); },
      ownerQuestionIdsExist: async () => { throw new Error('db down'); },
    });
    expect(out.verdict.fabricatedTodoIds ?? []).toEqual([]);
    expect(out.verdict.fabricatedOwnerQuestionIds ?? []).toEqual([]);
  });

  it("an id this run's own tool output carries is observed-real (never reaches the resolver)", async () => {
    const todoResolver: jest.Mock = jest.fn(async () => new Set<string>());
    const oqResolver: jest.Mock = jest.fn(async () => new Set<string>());
    const out = await guard({
      todoIdsExist: todoResolver,
      ownerQuestionIdsExist: oqResolver,
      toolTexts: ['todo_update → todo 1c0db1a5 status done', 'flag_owner_question → oq_8c8b15d4 (open)'],
    });
    expect(todoResolver).not.toHaveBeenCalled();
    expect(oqResolver).not.toHaveBeenCalled();
    expect(out.verdict.fabricatedTodoIds ?? []).toEqual([]);
    expect(out.verdict.fabricatedOwnerQuestionIds ?? []).toEqual([]);
  });

  it("a todo receipt's ids.todoId prefix-exonerates the citation", async () => {
    const todoResolver: jest.Mock = jest.fn(async () => new Set<string>());
    const out = await guard({
      todoIdsExist: todoResolver,
      ownerQuestionIdsExist: async () => new Set(['oq_8c8b15d4']),
      receipts: [{ id: 'rcpt1', tool: 'todo_update', ok: true, stamp: 'x', ids: { todoId: '1c0db1a5-2a93-4b50-8169-cb121a9721b3' } }],
    });
    expect(todoResolver).not.toHaveBeenCalled();
    expect(out.verdict.fabricatedTodoIds ?? []).toEqual([]);
    expect(out.verdict.fabricatedOwnerQuestionIds ?? []).toEqual([]);
  });

  it('review F1 lane pin (PR #811): an honest audit final carrying prior-run/schedule uuids on todo lines convicts nothing', async () => {
    const out = await guard({
      finalText: [
        'Audit done.',
        'todo: continue the review in run 5e61266b-49ad-47a3-8241-c5fd8a303b90 window.',
        'todo: next firing verifies 824b0d28-9c8b-4056-a176-cd222c3f4056 stayed active.',
      ].join('\n'),
      todoIdsExist: async () => new Set<string>(),
      ownerQuestionIdsExist: async () => new Set<string>(),
    });
    expect(out.verdict.fabricatedTodoIds ?? []).toEqual([]);
    expect(out.verdict.fabricatedOwnerQuestionIds ?? []).toEqual([]);
    expect(out.finalText).not.toContain('FABRICATED TODO IDS');
    expect(out.finalText).not.toContain('FABRICATED OWNER-QUESTION IDS');
  });

  it('review F2 lane pin (PR #811): a backticked phantom todo citation still convicts', async () => {
    const out = await guard({
      finalText: 'Firing report.\nBoard: todo `1c0db1a5` done.\nGate: `oq_8c8b15d4` answered.',
      todoIdsExist: async () => new Set<string>(),
      ownerQuestionIdsExist: async () => new Set<string>(),
    });
    expect(out.verdict.fabricatedTodoIds).toEqual(['1c0db1a5']);
    expect(out.verdict.fabricatedOwnerQuestionIds).toEqual(['oq_8c8b15d4']);
  });
});
