/**
 * REPLAY TEST — ticket d2e6b0fb (bug_report, filed 2026-10-19T23:59:32Z by the
 * 9050c226 adjudication lane): "edit_file old_string refusal is not
 * failure-shaped to the derail breaker (FAILURE_MARKERS gap) — a
 * varying-refusal loop with aligned narration trips no breaker leg."
 *
 * THE GAP (pinned by 9050c226's refusal leg as the classification AT
 * ADJUDICATION TIME): edit_file's authored text-mismatch refusals
 * (tools.ts:2298/2299) are the tool's own in-band answers — no
 * "Tool … failed:" prefix, no JSON envelope — so looksLikeToolFailure
 * (learnings-index.service.ts, FAILURE_MARKERS) classified them as SUCCESS.
 * The wild 9050c226 run's sixth edit (seq 799, README.md, 21:48:31.135Z)
 * returned exactly "old_string not found in README.md. Read the file and
 * match exactly." and reset the failure streak instead of feeding it.
 *
 * THE BLIND SPOT (why it matters): a looping lane emitting edit_file calls
 * with VARYING old_strings against narration that stays ALIGNED tripped NO
 * breaker leg at all — the failure ladder saw success (streak reset,
 * agent.ts:5721-5722), the success-side leg saw alignment (no mismatch),
 * the identical-call repeat breaker never fired on varying strings, and the
 * batch cap only bounds per-message counts. The wild instance was TWO
 * refusals with immediate recovery (no harm) — a hardening gap, not an
 * incident. The 718a04a5 gap was closed for DOCUMENT tools only
 * (read_document/update_document/fill_pdf_form); this is the edit_file
 * member of the same class.
 *
 * THE FIX (this ticket): two ANCHORED markers in FAILURE_MARKERS, position-0
 * pinned exactly like the 718a04a5 document-tools markers — the 7c1e5b9f
 * lesson forbids loose substrings (unanchored markers matched their own
 * literal source in files/tests quoting them and phantom-tripped the
 * breaker on SUCCESSFUL reads). The path class is `.+` (not the ticket's
 * suggested `\S+`): with BOTH ends anchored to the exact authored envelope
 * the precision is identical, and a path containing a space still fires.
 *
 * DETECTOR-RECALL REPLAY (the doctrine for a detector change): this file
 * replays looksLikeToolFailure's PRIOR true positives — the convicting
 * shapes pinned by learnings-index.test.ts, learnings-index.7c1e5b9f.test.ts
 * and agent-derail-break.718a04a5.test.ts — asserting they STILL fire, plus
 * the edit_file refusal cases asserting the NEW conviction, and the
 * 7c1e5b9f self-referential guard extended over the marker's own source
 * (a lane that read_file's learnings-index.service.ts must never phantom-
 * trip on the new marker's literal source line).
 */

jest.setTimeout(60_000);

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test', JWT_SECRET: 'x'.repeat(32), JWT_REFRESH_SECRET: 'y'.repeat(32) },
}));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisSubscriber: { subscribe: jest.fn(), on: jest.fn() },
}));
jest.mock('../github/github-mcp', () => ({
  __esModule: true, isGitHubMcpConfigured: jest.fn(() => false), callGitHubMcpTool: jest.fn(),
}));
jest.mock('../google/google-mcp', () => ({
  __esModule: true, isGoogleMcpConfigured: jest.fn(() => false), callGoogleMcpTool: jest.fn(),
}));
jest.mock('../imessage/agent-link', () => ({
  agentBroker: { dispatch: jest.fn() },
}));

const mockRunModelTurn: jest.Mock = jest.fn();
jest.mock('./coding-model', () => {
  const actual = jest.requireActual('./coding-model');
  return { ...actual, runModelTurn: (...a: any[]) => mockRunModelTurn(...a) };
});

// The executor mock: SUCCEEDS by default; failure injection KEYED ON ARGS
// (the old_string), exactly like the 9050c226 scaffold — the real call sites
// pass no call object, so an id-keyed injection is dead code (review B1).
// BAD_OLD_STRINGS members return the WILD refusal; everything else succeeds.
const BAD_OLD_STRINGS = new Set<string>();
const WILD_REFUSAL = (path: string) => `old_string not found in ${path}. Read the file and match exactly.`;
const maybeFail = (_name: string, args: any) => {
  if (args && typeof args.old_string === 'string' && BAD_OLD_STRINGS.has(args.old_string)) {
    return WILD_REFUSAL(String(args.path || 'README.md'));
  }
  return 'probe result: ok';
};
const mockExecuteCodingTool: jest.Mock = jest.fn(async (_ctx: any, _name: string, args: any) => maybeFail(_name, args));
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

const mockToolCacheExec: jest.Mock = jest.fn(async (_name: string, args: any) => maybeFail(_name, args));
jest.mock('../tool-executor', () => {
  const actual = jest.requireActual('../tool-executor');
  return {
    ...actual,
    ToolCache: jest.fn().mockImplementation(() => ({
      getOrExecute: (...a: any[]) => mockToolCacheExec(...a),
    })),
  };
});

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  recordRunSpend: jest.fn(),
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike', TOOL_BATCH_CAP: 'tool_batch_cap' },
}));

const _store = new Map<string, any>();
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async (ns: string[], key: string) => _store.get(ns.join('/') + '::' + key) ?? null),
  storePut: jest.fn(async (ns: string[], key: string, value: any) => { _store.set(ns.join('/') + '::' + key, value); }),
}));
jest.mock('./run-journal.service', () => ({
  __esModule: true,
  getRecentJournalEntries: jest.fn(async () => []),
  formatJournalBlock: jest.fn(() => ''),
}));
jest.mock('./container.service', () => ({
  ensureSessionContainer: jest.fn(async () => false),
  execInContainer: jest.fn(),
  isContainerMode: jest.fn(() => false),
}));
jest.mock('./session-credentials', () => ({
  gatherSessionCredentialEnv: jest.fn(async () => ({})),
  credentialEnvNote: jest.fn(() => ''),
}));
jest.mock('./code-index.service', () => ({ __esModule: true, kickCodeIndexSync: jest.fn() }));
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: jest.fn(async () => null) }));
jest.mock('./datetime-context', () => ({
  loadUserTimezone: jest.fn(async () => 'UTC'),
  buildCodingDateTimeBlock: jest.fn(() => ''),
  buildCodingClockNote: jest.fn(() => ''),
  buildChatWakeClockNote: jest.fn(() => ''),
}));
jest.mock('./coding-retrieval.service', () => ({ __esModule: true, storeFindings: jest.fn(async () => 0) }));
jest.mock('./verify-state', () => ({ __esModule: true, recordVerify: jest.fn(async () => {}) }));
jest.mock('./reflection', () => ({
  reflectionDisabled: jest.fn(() => false),
  REFLECTION_MAX_PER_RUN: 2,
  consultCrossCheckerOnStreak: jest.fn(async () => null),
  fileStreakInvestigation: jest.fn(async () => undefined),
}));

import * as fs from 'fs';
import * as path from 'path';
import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';
import { looksLikeToolFailure } from './learnings-index.service';

/** CODING profile (no workspace container in the scaffold — the learnings
 *  nudger is profile-gated off, agent.ts:1515, so a failure-shaped result
 *  cannot mint a [POSSIBLY RELEVANT LEARNING] note here). */
const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

const BRIEF = 'Apply the documented wording corrections to the three flagged files, reading each region before editing so the old_string matches exactly.';

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/derail-d2e6b0fb-test',
  sessionId: 'sess-d2e6b0fb',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.3',
  projectName: 'test',
  branch: 'main',
  profile: CODING_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: BRIEF,
  emit: jest.fn(),
});

/** The blind-spot batch: THREE edit_file calls with VARYING invented
 *  old_strings under narration that names NO offered tool (aligned — the
 *  pre-fix success-side leg saw no mismatch either). Pre-fix, every refusal
 *  read as SUCCESS: the failure streak reset each time, the repeat breaker
 *  never fired on varying strings, and NOTHING tripped. Post-fix the third
 *  refusal completes the 3-streak and trips the FAILURE ladder. */
const BAD_TRIMS: Array<[string, string, string]> = [
  ['docs/weekly-session-prompt.md', 'the poller wakes the old gateway box nightly', 'the poller wakes the lab edge only'],
  ['README.md', 'deployed from this repo at hash zero', 'deployed from this repo at the current hash'],
  ['docs/SECURITY-INCIDENT-2026-10-11.md', 'the r-2 host is active and current', 'the r-2 host is retired history'],
];
const badEditCall = (n: number) => {
  const [p, o, s] = BAD_TRIMS[(n - 1) % BAD_TRIMS.length];
  return { id: `b${n}`, name: 'edit_file', arguments: JSON.stringify({ path: p, old_string: o, new_string: s }) };
};

/** The CORRECT re-edits (old_strings the scaffold executor accepts). */
const GOOD_TRIMS: Array<[string, string, string]> = [
  ['docs/weekly-session-prompt.md', 'the poller wakes the lab edge only', 'the poller wakes the lab edge (nightly)'],
  ['README.md', 'deployed from this repo at the current hash', 'built from this repo at the current hash'],
  ['docs/SECURITY-INCIDENT-2026-10-11.md', 'the r-2 host is retired history', 'the r-2 host is hibernated (retired)'],
];
const goodEditCall = (n: number) => {
  const [p, o, s] = GOOD_TRIMS[(n - 1) % GOOD_TRIMS.length];
  return { id: `g${n}`, name: 'edit_file', arguments: JSON.stringify({ path: p, old_string: o, new_string: s }) };
};

const badBatchTurn = {
  // Aligned narration — names NO offered tool (the c737d007 test-writing
  // gotcha: an unoffered named tool makes detectIntendedTool return null;
  // here NOTHING is named, so neither leg's detector fires).
  content: 'Clock 22:10Z. Applying the three documented corrections with the exact text:',
  reasoning: 'Applying the three wording corrections to the flagged files now.',
  toolCalls: [badEditCall(1), badEditCall(2), badEditCall(3)],
  finishReason: 'tool_calls' as const,
};

/** The recovery the refusal text itself prescribes ("Read the file and
 *  match exactly") — read_file is not withheld, and the next round's schema
 *  returns edit_file. */
const recoveryReadTurn = {
  content: 'Acknowledged — all three edits missed their old_string. Reading the regions to get the exact current text before re-editing.',
  reasoning: 'Reading the three flagged regions for the exact text first.',
  toolCalls: [
    { id: 'rr1', name: 'read_file', arguments: JSON.stringify({ path: 'docs/weekly-session-prompt.md' }) },
    { id: 'rr2', name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) },
    { id: 'rr3', name: 'read_file', arguments: JSON.stringify({ path: 'docs/SECURITY-INCIDENT-2026-10-11.md' }) },
  ],
  finishReason: 'tool_calls' as const,
};

const fixedEditTurn = {
  content: 'Clock 22:12Z. The exact text is in hand — re-applying the three corrections.',
  reasoning: 'Re-applying the corrections with the exact current text.',
  toolCalls: [goodEditCall(1), goodEditCall(2), goodEditCall(3)],
  finishReason: 'tool_calls' as const,
};

const FINAL = { content: 'All three corrections applied with the exact text; the sweep is complete.', reasoning: '', toolCalls: [], finishReason: 'stop' as const };

const breakerMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_break');
const userTexts = () => (mockRunModelTurn.mock.calls[0]?.[1] as Array<{ role?: string; content?: unknown }> || [])
  .filter((m) => m?.role === 'user').map((m) => String(m.content));

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
  BAD_OLD_STRINGS.clear();
});

describe('ticket d2e6b0fb — edit_file old_string refusals are failure-shaped (DETECTOR-RECALL REPLAY for looksLikeToolFailure + the closed varying-refusal blind spot)', () => {
  describe('DETECTOR-RECALL REPLAY — the classifier (unit)', () => {
    test('PRIOR true positives still fire (the convicting shapes pinned by learnings-index.test.ts / 7c1e5b9f / 718a04a5)', () => {
      // learnings-index.test.ts "matches the harness failure shapes"
      expect(looksLikeToolFailure('Tool run_command failed: spawn ENOENT')).toBe(true);
      expect(looksLikeToolFailure('Verify FAILED at "test": ✓ typecheck  ✗ test (exit 1)')).toBe(true);
      expect(looksLikeToolFailure('git commit failed: nothing to commit')).toBe(true);
      expect(looksLikeToolFailure('COMMIT BLOCKED — the staged changes appear to contain secrets')).toBe(true);
      expect(looksLikeToolFailure('npm ERR! something\n[exit: 1]')).toBe(true);
      expect(looksLikeToolFailure('build died\n[exit: 137 — timed out]')).toBe(true);
      expect(looksLikeToolFailure('Tool "grep" exceeded 900s and was aborted. Do not retry it; proceed with what you have.')).toBe(true);
      // 7c1e5b9f authored envelopes
      expect(looksLikeToolFailure('⚠️ schedule_self FAILED — no schedule was created. prompt exceeds 8000 chars')).toBe(true);
      expect(looksLikeToolFailure('{\n "ok": false,\n "reason": "tool_not_offered",\n "needsConfirmation": false\n}')).toBe(true);
      // the 718a04a5 convictions (document-tools existence refusals)
      expect(looksLikeToolFailure('No generated file with id placeholder042 belongs to this user. Call list_files to see the current files.')).toBe(true);
      expect(looksLikeToolFailure('No knowledge document with id placeholder042 belongs to this user. Call list_files to see the current documents.')).toBe(true);
    });

    test('PRIOR acquittals still acquit (1ab1a52b staging envelope + 7c1e5b9f quoted-marker negatives)', () => {
      const staged = JSON.stringify({
        ok: false, needsConfirmation: true, confirmationId: 'cf_47362400', summary: 'Cancel schedule.', expiresInMinutes: 10080,
      }, null, 1);
      expect(looksLikeToolFailure(staged)).toBe(false);
      expect(looksLikeToolFailure('the deploy died with [exit: 1] and we rolled back')).toBe(false);
      expect(looksLikeToolFailure('see "exceeded 900s and was aborted" in agent.ts:2172')).toBe(false);
      expect(looksLikeToolFailure('notes: FAILED — no schedule was created, per tools.ts')).toBe(false);
      expect(looksLikeToolFailure('[File: digest.md — md, 240 bytes]\nthe guard answered "No generated file with id zz belongs to this user." twice')).toBe(false);
      expect(looksLikeToolFailure('probe result: ok')).toBe(false);
      expect(looksLikeToolFailure('ok\n[exit: 0]')).toBe(false);
      expect(looksLikeToolFailure('')).toBe(false);
    });

    test('THE NEW CONVICTION: both edit_file text-mismatch refusals are failure-shaped (the wild 9050c226 shape verbatim)', () => {
      // tools.ts:2298 — count === 0 (the wild refusal, README.md, seq 799)
      expect(looksLikeToolFailure('old_string not found in README.md. Read the file and match exactly.')).toBe(true);
      // tools.ts:2299 — count > 1 (the non-unique twin, same class)
      expect(looksLikeToolFailure('old_string appears 3× in config.yaml — it must be unique. Add surrounding context.')).toBe(true);
      // the path class is .+ : a path containing a space still fires
      expect(looksLikeToolFailure('old_string not found in docs/my notes.md. Read the file and match exactly.')).toBe(true);
      expect(looksLikeToolFailure('old_string appears 2× in docs/road map.md — it must be unique. Add surrounding context.')).toBe(true);
      // the 2026-10-22 tandem update (efcdcbca + bb77c6ad class fix): the
      // deterministic bracketed hint tail the refusal now appends still
      // counts — the marker admits exactly that tail and nothing else
      expect(looksLikeToolFailure("old_string not found in README.md. Read the file and match exactly. [edit_file hint: nearest match is 83% similar at lines 1–1: 'import { a, b, c } from './x';' — re-read that region and quote it byte-exactly]")).toBe(true);
      expect(looksLikeToolFailure('old_string appears 3× in config.yaml — it must be unique. Add surrounding context. [edit_file hint: occurrences start at lines: 1, 7, 9 — widen old_string with surrounding context unique to your target]')).toBe(true);
    });

    test('ANCHOR DISCIPLINE (the 7c1e5b9f lesson): the envelope quoted mid-string, prefixed or suffixed never fires', () => {
      // leading text — not position 0
      expect(looksLikeToolFailure('I saw: old_string not found in README.md. Read the file and match exactly.')).toBe(false);
      expect(looksLikeToolFailure('the tool said old_string appears 3× in x — it must be unique. Add surrounding context.')).toBe(false);
      // trailing text — the envelope is the whole result, $ pins the end
      expect(looksLikeToolFailure('old_string not found in README.md. Read the file and match exactly. — then I re-read it')).toBe(false);
      // a doc/test QUOTING the refusal (the phantom-streak vector)
      expect(looksLikeToolFailure('// the refusal reads: old_string not found in x. Read the file and match exactly.')).toBe(false);
      // the refusal as a grep result line (colon-prefixed)
      expect(looksLikeToolFailure('2298:        if (count === 0) return `old_string not found in ${args.path}. Read the file and match exactly.`;')).toBe(false);
    });

    test('SELF-REFERENTIAL GUARD (7c1e5b9f, extended over the new marker): reading learnings-index.service.ts itself never trips', () => {
      // The marker's own literal source line lives in this module — a lane
      // that read_file's it (40-line windows, line-number prefixed) or cats
      // it raw must not rack a phantom failure streak on a SUCCESSFUL read.
      const src = fs.readFileSync(path.join(__dirname, 'learnings-index.service.ts'), 'utf8');
      expect(src).toContain('old_string not found in'); // the marker source is really there
      const lines = src.split('\n');
      for (let start = 0; start < lines.length; start += 40) {
        const window = lines
          .slice(start, start + 40)
          .map((l, i) => `${start + i + 1}\t${l}`)
          .join('\n');
        expect(looksLikeToolFailure(window)).toBe(false);
      }
      expect(looksLikeToolFailure(src)).toBe(false);
      // …and tools.ts (the refusal's authoring site) is equally safe to read.
      const toolsSrc = fs.readFileSync(path.join(__dirname, 'tools.ts'), 'utf8');
      expect(toolsSrc).toContain('old_string not found in');
      expect(looksLikeToolFailure(toolsSrc)).toBe(false);
    });
  });

  describe('the closed blind spot (loop replay)', () => {
    it('VARYING old_strings under ALIGNED narration trip the FAILURE ladder at the third refusal — the pre-fix shape tripped NOTHING', async () => {
      BAD_TRIMS.forEach(([, o]) => BAD_OLD_STRINGS.add(o));
      mockRunModelTurn
        .mockResolvedValueOnce(badBatchTurn)     // 3 varying refusals, aligned narration → TRIP at the third
        .mockResolvedValueOnce(recoveryReadTurn) // the refusal's own prescription: read the file (edit_file withheld this round)
        .mockResolvedValueOnce(fixedEditTurn)    // edit_file returns after its one-round ban; all three succeed
        .mockResolvedValue(FINAL);
      const result = await runCodingAgent(makeInput());

      expect(result.finalText).toContain('All three corrections applied with the exact text; the sweep is complete.');
      expect(result.modelErrored).toBeUndefined();
      expect(result.finalText).not.toContain('Run ended: repeated wrong-tool derailment');

      // ── The trip: FAILURE-shaped, on edit_file, one round only. Pre-fix
      //    this run tripped NOTHING (the refusals read as success and the
      //    narration named no other tool) — the exact blind spot. ──
      expect(breakerMetrics()).toHaveLength(1);
      expect(breakerMetrics()[0].meta).toMatchObject({ tool: 'edit_file', shape: 'failure', perma: false });
      expect(breakerMetrics().every((m) => m.meta?.shape === 'failure')).toBe(true); // no success_intent leg fired
      const notice = userTexts().find((t) => t.includes('ALL FAILED'));
      expect(notice).toBeDefined();
      expect(notice).toContain('Your last 3 calls of edit_file ALL FAILED');

      // ── All three refusals executed and reached the model (the tool
      //    result is the WILD envelope); the fixed batch re-edited all
      //    three files — the recover-in-one-call property. ──
      const editDispatches = [...mockToolCacheExec.mock.calls, ...mockExecuteCodingTool.mock.calls]
        .filter((c: any[]) => c[1] === 'edit_file' || (c[1] && BAD_TRIMS.some(([, o]) => o === (c[2] as any)?.old_string)));
      expect(editDispatches.length).toBe(6); // 3 refused + 3 fixed
      const sawRefusal = mockRunModelTurn.mock.calls.some((_c: any, i: number) => {
        const msgs = mockRunModelTurn.mock.calls[i][1] as Array<{ role?: string; content?: unknown }>;
        return (msgs || []).some((m) => m?.role === 'tool' && typeof m.content === 'string' && m.content.includes('old_string not found in'));
      });
      expect(sawRefusal).toBe(true);
    });

    it('a LEGIT lane recovers in ONE refusal — no trip, no notice (the anti-overreach property the ticket demands)', async () => {
      // ONE bad edit (stale old_string), then the refusal's own recovery
      // (read the file) and the corrected edit. failStreak reaches 1 — the
      // 3-trip is far away, and no wrong-tool leg fires (narration aligned).
      BAD_OLD_STRINGS.add(BAD_TRIMS[0][1]);
      const oneBadTurn = {
        content: 'Clock 22:20Z. Applying the first correction with the text I have:',
        reasoning: 'Applying the first wording correction now.',
        toolCalls: [badEditCall(1)],
        finishReason: 'tool_calls' as const,
      };
      mockRunModelTurn
        .mockResolvedValueOnce(oneBadTurn)
        .mockResolvedValueOnce(recoveryReadTurn)
        .mockResolvedValueOnce(fixedEditTurn)
        .mockResolvedValue(FINAL);
      const result = await runCodingAgent(makeInput());

      expect(result.finalText).toContain('All three corrections applied with the exact text; the sweep is complete.');
      expect(result.modelErrored).toBeUndefined();
      expect(breakerMetrics()).toHaveLength(0);            // no trip at all
      expect(userTexts().some((t) => t.includes('ALL FAILED'))).toBe(false); // no notice
    });
  });
});
