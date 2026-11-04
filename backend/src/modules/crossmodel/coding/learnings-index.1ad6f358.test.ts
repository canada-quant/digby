/**
 * Replay pin — ticket 1ad6f358 (2026-09-10 breaker trip, session 536473e0,
 * run fca18838, auto-filed 22:21:40Z) and its sibling 089d84cd (session
 * e8be6aa7, run 745a08ff, auto-filed 22:44:25Z).
 *
 * THE INCIDENT: burn-down lane 536473e0 was investigating a5f4c3aa — the
 * read_file phantom-failure streak on THIS module (the 7c1e5b9f class) — and
 * grepped its own in-flight fix inside learnings-index.service.ts. Three
 * SUCCESSFUL grep results came back whose match lines quote the failure
 * markers' literal source ("FAILED — no schedule was created", "[exit: N]").
 * The pre-#669 classifier's UNANCHORED content regexes matched those quoted
 * shapes, counted each successful grep as a failure, and the 3× grep streak
 * tripped the derail breaker (grep withheld for a round) and auto-filed
 * 1ad6f358 whose "failure texts" are plain grep output. The defect then
 * re-tripped on the lane investigating 1ad6f358 itself (session e8be6aa7 —
 * same file, same classifier, 23 minutes later) and auto-filed 089d84cd.
 *
 * THE FIX (shipped in PR #669, ticket 7c1e5b9f): every marker is anchored to
 * the position the harness actually authors it (^-anchored envelopes, the
 * exit marker pinned to the result's TAIL line). Grep results are always
 * `path:line:content`-prefixed, so a quoted marker can never sit at the
 * envelope start; a quoted `[exit: N]` mid-string never sits at the tail.
 *
 * These tests replay 1ad6f358's three filed texts verbatim plus 089d84cd's
 * post-#669 self-match shape, and pin both directions: quoted markers never
 * fire, authored envelopes always fire.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => {}),
}));
jest.mock('../memory/unified-memory.service', () => ({
  __esModule: true,
  memReplaceRef: jest.fn(async () => 1),
  memSearch: jest.fn(async () => []),
}));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: { INDEX_SWEPT: 'index_swept' },
}));

import { looksLikeToolFailure } from './learnings-index.service';

// ── 1ad6f358's filed "Failure texts (newest first)" — verbatim ──────────────
// (grep results are path:line:content-prefixed; each text is the harness's
// 1200-char capture, ending mid-path/mid-token exactly as filed).

// Failure text #1: grep matches on the lane's own in-flight fix — the quoted
// "FAILED — no schedule was created" and "[exit: N]" shapes the unanchored
// regexes matched. Ends mid-path (the capture truncation), as filed.
const FILED_GREP_1 =
  '/app/coding-workspaces/worktrees/536473e0-67e4-4213-83c8-6929fb9b3833/backend/src/modules/crossmodel/coding/learnings-index.service.ts:355:// ("FAILED — no schedule was created", "[exit: N]", "exceeded Ns and was\n'
  + '/app/coding-workspaces/worktrees/536473e0-67e4-4213-83c8-6929fb9b3833/backend/src/modules/crossmodel/coding/learnings-index.service.ts:375:// (a `\\n[exit: N]` tail suffix — tools.ts / container.service.ts / agent.ts),\n'
  + '/app/coding-workspaces/worktrees/536473e0-67e4-4213-83c8-6929fb9b3833';

// Failure text #2: the anchored-abort-marker line + agent.ts's template that
// authors the real envelope. Ends mid-token (${Math.round(TOOL_HARD), as filed.
const FILED_GREP_2 =
  '/app/coding-workspaces/worktrees/536473e0-67e4-4213-83c8-6929fb9b3833/backend/src/modules/crossmodel/coding/learnings-index.service.ts:371:  /^Tool "[^"]+" exceeded \\d+s and was aborted/,         // agent-loop hard-timeout backstop (agent.ts)\n'
  + '/app/coding-workspaces/worktrees/536473e0-67e4-4213-83c8-6929fb9b3833/backend/src/modules/crossmodel/coding/agent.ts:2172:              () => resolve(`Tool "${tc.name}" exceeded ${Math.round(TOOL_HARD';

// Failure text #3: the schedule-marker lines again; ends mid-path, as filed.
const FILED_GREP_3 =
  '/app/coding-workspaces/worktrees/536473e0-67e4-4213-83c8-6929fb9b3833/backend/src/modules/crossmodel/coding/learnings-index.service.ts:355:// ("FAILED — no schedule was created", "[exit: N]", "exceeded Ns and was\n'
  + '/app/coding-workspaces/worktrees/536473e0-67e4-4213-83c8-6929fb9b3833/backend/src/modules/crossmodel/coding/learnings-index.service.ts:370:  /^.{0,3}schedule_\\w+ FAILED — no schedule was created/,\n'
  + '/app/coding-workspaces/worktrees/536473e0-67e4-4213-83c8-6929fb9b3833/backend/src/modules/';

// 089d84cd's shape: the lane investigating 1ad6f358 grepped the SAME module
// AFTER #669 — the post-fix marker lines still quote every literal shape
// (that is the point of the pin: the classifier must never fire on them).
const POST_FIX_GREP =
  '/app/coding-workspaces/worktrees/e8be6aa7-882e-4332-ae39-852f8a19dd91/backend/src/modules/crossmodel/coding/learnings-index.service.ts:370:  /^.{0,3}schedule_\\w+ FAILED — no schedule was created/,\n'
  + '/app/coding-workspaces/worktrees/e8be6aa7-882e-4332-ae39-852f8a19dd91/backend/src/modules/crossmodel/coding/learnings-index.service.ts:371:  /^Tool "[^"]+" exceeded \\d+s and was aborted/,         // agent-loop hard-timeout backstop (agent.ts)\n'
  + '/app/coding-workspaces/worktrees/e8be6aa7-882e-4332-ae39-852f8a19dd91/backend/src/modules/crossmodel/coding/learnings-index.service.ts:379:const EXIT_MARKER_TAIL_RE = /(?:^|\\n)\\[exit: (?!0[\\]\\s])[^\\]\\n]{0,40}\\]\\s*$/;';

describe('ticket 1ad6f358 / 089d84cd — quoted marker shapes in grep output are NOT failures', () => {
  it.each([
    ['filed text #1 (schedule + exit-marker quotes, mid-path tail)', FILED_GREP_1],
    ['filed text #2 (abort-marker quote, mid-token tail)', FILED_GREP_2],
    ['filed text #3 (schedule-marker quotes, mid-path tail)', FILED_GREP_3],
    ['089d84cd post-#669 self-match (anchored markers + EXIT_MARKER_TAIL_RE source)', POST_FIX_GREP],
  ])('%s', (_label, text) => {
    expect(looksLikeToolFailure(text)).toBe(false);
  });

  it('a mid-string [exit: N] quote (log excerpt) is not failure-shaped — tail anchor only', () => {
    expect(looksLikeToolFailure('see the log line: [exit: 1] from yesterday\nfinal line of actual output')).toBe(false);
  });
});

describe('anti-hole — authored failure ENVELOPES still fire', () => {
  it('schedule_self rejection envelope (tools.ts authored prefix)', () => {
    expect(looksLikeToolFailure('⚠️ schedule_self FAILED — no schedule was created. The prompt is too long.')).toBe(true);
  });
  it('agent-loop hard-timeout abort envelope (agent.ts authored prefix)', () => {
    expect(looksLikeToolFailure('Tool "grep" exceeded 900s and was aborted. Do not retry it; proceed with what you have.')).toBe(true);
  });
  it('run_command non-zero exit marker at the result TAIL', () => {
    expect(looksLikeToolFailure('npm ERR! something\n[exit: 1]')).toBe(true);
    expect(looksLikeToolFailure('build died\n[exit: 137 — timed out]')).toBe(true);
  });
  it('exit 0 at the tail is a success, not a failure', () => {
    expect(looksLikeToolFailure('ok\n[exit: 0]')).toBe(false);
  });
});
