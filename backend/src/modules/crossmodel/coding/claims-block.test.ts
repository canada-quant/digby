/**
 * Tests for the typed CLAIMS block contract (audit #6 phase 1 — claims-block.ts):
 * tolerant parsing (last fenced block wins; malformed → null with reason) and
 * receipt-lookup verification (every claim type: happy path + unverifiable).
 * Pure module — no mocks needed (dependency-free leaf, run-receipts discipline).
 */

import {
  CLAIMS_BLOCK_TYPES, MAX_CLAIMS_BLOCK_ENTRIES,
  parseClaimsBlock, parseClaimsBlocks, findClaimsFences, verifyClaimsBlock, refNamesPrNumber, refNamesSha,
} from './claims-block';
import type { ClaimsBlockEntry } from './claims-block';
import type { ToolReceipt } from './run-receipts';

const NOW = new Date('2026-09-02T12:00:00.000Z');

const receipt = (tool: string, ok: boolean, ids: Record<string, unknown> = {}, id = 'aaaabbbb-cccc-dddd-eeee-ffff00001111'): ToolReceipt => ({
  id, chatId: 'c1', runId: 'run1', tool, ok, ids,
  inputHash: null, outputHash: null, createdAt: NOW,
});

const fence = (json: string) => '```claims\n' + json + '\n```';

// ── parseClaimsBlock ─────────────────────────────────────────────────────────

describe('two-line opener (owner screenshot 2026-09-25: bare ``` then `claims` on the next line)', () => {
  const TWO_LINE = 'Report done.\n\n```\nclaims\n[{"type":"push","ref":"af08e94b1cc3e85961bf4da0532f301283d8d988"},{"type":"pr","ref":"2"}]\n```\n\n---\n🔍 Harness push-claim verification';
  it('findClaimsFences locates it with the body starting AFTER the claims word line', () => {
    const f = findClaimsFences(TWO_LINE);
    expect(f).toHaveLength(1);
    expect([f[0].startLine, f[0].endLine]).toEqual([2, 5]);
    expect(f[0].body).toBe('[{"type":"push","ref":"af08e94b1cc3e85961bf4da0532f301283d8d988"},{"type":"pr","ref":"2"}]');
  });
  it('parseClaimsBlock reads the entries (the typed-manifest lane no longer sees present:false)', () => {
    const p = parseClaimsBlock(TWO_LINE);
    expect(p.present).toBe(true);
    expect(p.claims?.map((c) => c.type)).toEqual(['push', 'pr']);
  });
  it('a bare ``` NOT followed by the claims word is an ordinary code block (never a manifest)', () => {
    expect(findClaimsFences('x\n```\n[{"type":"pr","ref":"1"}]\n```')).toEqual([]);
    expect(findClaimsFences('x\n```\nclaims\n')).toEqual([]); // unterminated
    expect(parseClaimsBlock('```\nclaimsX\n[]\n```').present).toBe(false);
  });
});

describe('parseClaimsBlock', () => {
  it('parses a valid block: types, refs, notes', () => {
    const text = `Did the work.\n\n${fence('[{"type":"push","ref":"1539fa86","note":"digby/fix-x"},{"type":"pr","ref":"241"}]')}`;
    const out = parseClaimsBlock(text);
    expect(out.present).toBe(true);
    expect(out.malformedReason).toBeUndefined();
    expect(out.claims).toEqual([
      { type: 'push', ref: '1539fa86', note: 'digby/fix-x' },
      { type: 'pr', ref: '241' },
    ]);
  });

  it('absent block → present:false', () => {
    expect(parseClaimsBlock('All done, nothing consequential this run.')).toEqual({ present: false, claims: null });
    expect(parseClaimsBlock('')).toEqual({ present: false, claims: null });
  });

  it('a numeric ref is coerced to a string', () => {
    const out = parseClaimsBlock(fence('[{"type":"pr","ref":241}]'));
    expect(out.claims).toEqual([{ type: 'pr', ref: '241' }]);
  });

  it('a single object (not an array) is wrapped', () => {
    const out = parseClaimsBlock(fence('{"type":"push","ref":"abc1234"}'));
    expect(out.claims).toEqual([{ type: 'push', ref: 'abc1234' }]);
  });

  it('a trailing comma is tolerated (the one malformation models actually emit)', () => {
    const out = parseClaimsBlock(fence('[{"type":"push","ref":"abc1234"},]'));
    expect(out.claims).toEqual([{ type: 'push', ref: 'abc1234' }]);
  });

  it('unknown extra keys are ignored; a non-string note is dropped', () => {
    const out = parseClaimsBlock(fence('[{"type":"verify","ref":"typecheck","note":42,"extra":true}]'));
    expect(out.claims).toEqual([{ type: 'verify', ref: 'typecheck' }]);
  });

  it('invalid JSON → present with malformedReason, claims null', () => {
    const out = parseClaimsBlock(fence('[{"type":"push" "ref":"x"}]'));
    expect(out.present).toBe(true);
    expect(out.claims).toBeNull();
    expect(out.malformedReason).toMatch(/invalid JSON/);
  });

  it('an unknown claim type → malformed, naming the type', () => {
    const out = parseClaimsBlock(fence('[{"type":"merged","ref":"241"}]'));
    expect(out.claims).toBeNull();
    expect(out.malformedReason).toContain('"merged"');
  });

  it('6d7b379f (reviewer M2): finish_run documented spellings pr_opened/pr_merged parse as their fence types pr/merge — but the FUZZY aliases stay unknown', () => {
    const prOut = parseClaimsBlock(fence('[{"type":"pr_opened","ref":"241"}]'));
    expect(prOut.claims).toEqual([{ type: 'pr', ref: '241' }]);
    const mergeOut = parseClaimsBlock(fence('[{"type":"pr_merged","ref":"241"}]'));
    expect(mergeOut.claims).toEqual([{ type: 'merge', ref: '241' }]);
    // strict vocabulary holds: finish-run's fuzzy spellings are NOT imported
    expect(parseClaimsBlock(fence('[{"type":"pushed","ref":"1539fa86"}]')).claims).toBeNull();
    expect(parseClaimsBlock(fence('[{"type":"committed","ref":"1539fa86"}]')).claims).toBeNull();
    expect(parseClaimsBlock(fence('[{"type":"merged","ref":"241"}]')).claims).toBeNull();
    // and the malformed notice names what the MODEL wrote, not the alias
    expect(parseClaimsBlock(fence('[{"type":"bogus","ref":"241"}]')).malformedReason).toContain('"bogus"');
  });

  it('a missing/empty ref → malformed', () => {
    expect(parseClaimsBlock(fence('[{"type":"push"}]')).malformedReason).toMatch(/missing ref/);
    expect(parseClaimsBlock(fence('[{"type":"push","ref":"  "}]')).malformedReason).toMatch(/missing ref/);
  });

  it('a non-object entry → malformed', () => {
    expect(parseClaimsBlock(fence('["push"]')).malformedReason).toMatch(/not an object/);
    expect(parseClaimsBlock(fence('[null]')).malformedReason).toMatch(/not an object/);
  });

  it('an empty block body → malformed; an empty ARRAY → present with zero entries', () => {
    expect(parseClaimsBlock('```claims\n\n```').malformedReason).toBe('empty claims block');
    expect(parseClaimsBlock(fence('[]'))).toEqual({ present: true, claims: [] });
  });

  it(`more than ${MAX_CLAIMS_BLOCK_ENTRIES} entries → malformed (flood cap)`, () => {
    const many = JSON.stringify(Array.from({ length: MAX_CLAIMS_BLOCK_ENTRIES + 1 }, () => ({ type: 'verify', ref: 'x' })));
    expect(parseClaimsBlock(fence(many)).malformedReason).toMatch(/more than/);
  });

  it('the LAST of multiple blocks wins', () => {
    const text = [
      fence('[{"type":"pr","ref":"1"}]'),
      'Corrected below.',
      fence('[{"type":"pr","ref":"2"}]'),
    ].join('\n\n');
    expect(parseClaimsBlock(text).claims).toEqual([{ type: 'pr', ref: '2' }]);
  });

  it('an inline (mid-sentence) fence mention never parses — fences must start a line', () => {
    const text = 'Use the ```claims\n[{"type":"pr","ref":"9"}]\n``` fence for machine finals.';
    // The opening token sits mid-line ("Use the ```claims") → not a block.
    expect(parseClaimsBlock(text).present).toBe(false);
  });

  it('an indented fence (≤3 spaces, markdown rule) still parses; CRLF tolerated', () => {
    const out = parseClaimsBlock('  ```claims\r\n[{"type":"push","ref":"abc1234"}]\r\n  ```');
    expect(out.claims).toEqual([{ type: 'push', ref: 'abc1234' }]);
  });

  it('the contract vocabulary is the 8 audited types + merge (tt-rd audit 2026-09-27) + the finish_run four (ticket 6d7b379f)', () => {
    expect([...CLAIMS_BLOCK_TYPES]).toEqual([
      'push', 'pr', 'deploy', 'ticket_update', 'message_sent', 'dispatch', 'file_change', 'verify', 'merge',
      'commit', 'schedule_armed', 'email_sent', 'state_update',
    ]);
  });
});

// ── findClaimsFences / parseClaimsBlocks (ticket 59ac00bd) ───────────────────

describe('findClaimsFences / parseClaimsBlocks (ticket 59ac00bd F1/F2)', () => {
  it('locates EVERY fenced block in source order with 0-based inclusive line spans', () => {
    const text = [
      'Prose line 0.',
      fence('[{"type":"pr","ref":"1"}]'), // lines 1-3
      'Middle line 4.',
      fence('[{"type":"pr","ref":"2"}]'), // lines 5-7
      'Tail line 8.',
    ].join('\n');
    const fences = findClaimsFences(text);
    expect(fences.map((f) => [f.startLine, f.endLine])).toEqual([[1, 3], [5, 7]]);
    expect(fences[0].body).toBe('[{"type":"pr","ref":"1"}]');
    expect(fences[1].body).toBe('[{"type":"pr","ref":"2"}]');
  });

  it('F1: a fence indented ≥4 spaces is an indented code block — NEVER located or parsed', () => {
    const text = [
      fence('[{"type":"pr","ref":"1"}]'),
      '',
      '    ```claims',
      '    [{"type":"ticket_update","ref":"deadbeef-0000-4000-8000-000000000000"}]',
      '    ```',
    ].join('\n');
    expect(findClaimsFences(text).map((f) => [f.startLine, f.endLine])).toEqual([[0, 2]]);
    const blocks = parseClaimsBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].result.claims).toEqual([{ type: 'pr', ref: '1' }]);
    // The LAST-wins singular parser agrees — the pseudo-fence is invisible to it.
    expect(parseClaimsBlock(text).claims).toEqual([{ type: 'pr', ref: '1' }]);
  });

  it('F2: every block is parsed independently — a malformed block never poisons its neighbours', () => {
    const text = [
      fence('[{"type":"push" "ref":"x"}]'), // malformed (invalid JSON)
      fence('[{"type":"pr","ref":"2"}]'),
    ].join('\n');
    const blocks = parseClaimsBlocks(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].result.claims).toBeNull();
    expect(blocks[0].result.malformedReason).toMatch(/invalid JSON/);
    expect(blocks[1].result.claims).toEqual([{ type: 'pr', ref: '2' }]);
  });

  it('an opener with no later closer yields no match; a nested opener line is just body text', () => {
    expect(findClaimsFences('```claims\n[{"type":"pr","ref":"1"}]')).toEqual([]);
    const text = '```claims\n["```claims"]\n```';
    const fences = findClaimsFences(text);
    expect(fences).toHaveLength(1);
    expect(fences[0].body).toBe('["```claims"]');
  });

  it('the closer may sit at any indentation (only the OPENER is ≤3-space strict); CRLF tolerated', () => {
    const text = '  ```claims\r\n[{"type":"push","ref":"abc1234"}]\r\n      ```';
    const fences = findClaimsFences(text);
    expect(fences).toHaveLength(1);
    expect(parseClaimsBlocks(text)[0].result.claims).toEqual([{ type: 'push', ref: 'abc1234' }]);
  });

  it('parseClaimsBlock ≡ the LAST of parseClaimsBlocks across a shape battery (single finder, no drift)', () => {
    const battery = [
      '',
      'no fences here',
      fence('[{"type":"pr","ref":"1"}]'),
      [fence('[{"type":"pr","ref":"1"}]'), 'x', fence('[{"type":"pr","ref":"2"}]')].join('\n'),
      [fence('[{"type":"pr","ref":"1"}]'), fence('[{"type":"merged","ref":"2"}]')].join('\n'), // last malformed
      '  ```claims\r\n[{"type":"push","ref":"abc1234"}]\r\n  ```',
      '```claims\n\n```',
      'Use the ```claims\n[{"type":"pr","ref":"9"}]\n``` inline mention',
      '    ```claims\n[{"type":"pr","ref":"4"}]\n    ```', // indented code block — no fence
      '```claims\n[{"type":"pr","ref":"1"}]', // unclosed
    ];
    for (const text of battery) {
      const blocks = parseClaimsBlocks(text);
      const last = blocks[blocks.length - 1];
      expect(parseClaimsBlock(text)).toEqual(last ? last.result : { present: false, claims: null });
    }
  });
});

// ── ref helpers ──────────────────────────────────────────────────────────────

describe('refNamesPrNumber / refNamesSha', () => {
  it('PR refs: bare, #, "PR n", and /pull/ URLs; wrong numbers refuse', () => {
    for (const ref of ['241', '#241', 'PR 241', 'PR #241', 'https://github.com/o/r/pull/241']) {
      expect(refNamesPrNumber(ref, 241)).toBe(true);
      expect(refNamesPrNumber(ref, 242)).toBe(false);
    }
    expect(refNamesPrNumber('the fix for 241 things', 241)).toBe(false); // prose, not an id
  });

  it('sha refs: hex prefix ≥7 either direction; non-hex refuses', () => {
    expect(refNamesSha('1539fa86', '1539fa86b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6')).toBe(true);
    expect(refNamesSha('1539FA86', '1539fa86b1c2')).toBe(true); // case-insensitive
    expect(refNamesSha('deadbeef9', '1539fa86b1c2')).toBe(false);
    expect(refNamesSha('main', '1539fa86b1c2')).toBe(false);
  });
});

// ── verifyClaimsBlock — every claim type: happy + unverifiable ───────────────

describe('verifyClaimsBlock', () => {
  const claim = (type: ClaimsBlockEntry['type'], ref: string): ClaimsBlockEntry => ({ type, ref });

  it('push: verified by an ok git_push via sha prefix, branch, or receipt id — never by ok:false', () => {
    const push = receipt('git_push', true, { branch: 'digby/fix-x', sha: '1539fa86b1c2d3e4' }, '3f09a1bc-aaaa-bbbb-cccc-dddddddddddd');
    expect(verifyClaimsBlock([claim('push', '1539fa86')], [push]).verified).toHaveLength(1);
    expect(verifyClaimsBlock([claim('push', 'digby/fix-x')], [push]).verified).toHaveLength(1);
    expect(verifyClaimsBlock([claim('push', '3f09a1bc-aaaa-bbbb-cccc-dddddddddddd')], [push]).verified).toHaveLength(1);
    expect(verifyClaimsBlock([claim('push', '3f09a1bc')], [push]).verified).toHaveLength(1); // ≥8 prefix
    expect(verifyClaimsBlock([claim('push', 'deadbeef9')], [push]).unverified).toHaveLength(1);
    const failed = receipt('git_push', false, { branch: 'digby/fix-x' });
    expect(verifyClaimsBlock([claim('push', 'digby/fix-x')], [failed]).unverified).toHaveLength(1);
  });

  it('merge: verified ONLY by an ok merge_pull_request receipt — via PR number, merge-sha prefix, or receipt id (tt-rd audit 2026-09-27)', () => {
    const merge = receipt('merge_pull_request', true, { repo: 'o/r', prNumber: 740, mergeSha: '1a2b3c4d5e6f7a8b' }, '5e5e5e5e-aaaa-bbbb-cccc-dddddddddddd');
    for (const ref of ['740', '#740', 'PR 740', '1a2b3c4d', '5e5e5e5e']) {
      expect(verifyClaimsBlock([claim('merge', ref)], [merge]).verified).toHaveLength(1);
    }
    expect(verifyClaimsBlock([claim('merge', '741')], [merge]).unverified).toHaveLength(1);
    // an open_pull_request receipt of the same number does NOT vouch a merge
    const opened = receipt('open_pull_request', true, { prNumber: 740, url: 'https://github.com/o/r/pull/740' });
    expect(verifyClaimsBlock([claim('merge', '740')], [opened]).unverified).toHaveLength(1);
    // nor does the honest ALREADY-merged no-op (ok:false)
    expect(verifyClaimsBlock([claim('merge', '740')], [receipt('merge_pull_request', false, { prNumber: 740, alreadyMerged: true })]).unverified).toHaveLength(1);
    expect(parseClaimsBlock('```claims\n[{"type":"merge","ref":"740"}]\n```').claims).toEqual([{ type: 'merge', ref: '740' }]);
  });

  it('pr: verified by an ok open_pull_request via number (bare/#/PR n/URL) or exact URL', () => {
    const pr = receipt('open_pull_request', true, { prNumber: 241, url: 'https://github.com/o/r/pull/241' });
    for (const ref of ['241', '#241', 'PR 241', 'https://github.com/o/r/pull/241']) {
      expect(verifyClaimsBlock([claim('pr', ref)], [pr]).verified).toHaveLength(1);
    }
    expect(verifyClaimsBlock([claim('pr', '242')], [pr]).unverified).toHaveLength(1);
    expect(verifyClaimsBlock([claim('pr', '241')], [receipt('git_push', true, { sha: '241aaffbb' })]).unverified).toHaveLength(1); // wrong tool class
  });

  it('deploy: coarse tier RETIRED (P4 v1#23) — an unmatched non-uuid ref lands in the UNVERIFIABLE tier, never VERIFIED (an ok `ls` receipt must not vouch); a matched sha still verifies', () => {
    // The 09-08 hole: any ok run_command (even `ls`) stamped a descriptive
    // deploy ref VERIFIED. It is now 'unverifiable' — advisory, no coverage,
    // no conviction (GUARD 5's Actions-API check owns run-id truth).
    const descriptive = verifyClaimsBlock([claim('deploy', 'digby.example.com blue-green flip')], [receipt('run_command', true)]);
    expect(descriptive.verified).toHaveLength(0);
    expect(descriptive.unverified).toHaveLength(0);
    expect(descriptive.unverifiable).toHaveLength(1);
    // A ref naming the receipted push sha still VERIFIES (real id binding).
    expect(verifyClaimsBlock([claim('deploy', '1539fa86')], [receipt('git_push', true, { sha: '1539fa86b1c2' })]).verified).toHaveLength(1);
    // No class receipt at all → still unverifiable (nothing to bind to), not a conviction.
    expect(verifyClaimsBlock([claim('deploy', 'digby.example.com blue-green flip')], [receipt('verify', true, { passed: true })]).unverifiable).toHaveLength(1);
    expect(verifyClaimsBlock([claim('deploy', 'anything')], []).unverifiable).toHaveLength(1);
  });

  it('deploy anti-forgery: a full-uuid ref NEVER rides the coarse tier — it must match a real receipt id', () => {
    const rc = receipt('run_command', true, {}, '3f09a1bc-aaaa-bbbb-cccc-dddddddddddd');
    expect(verifyClaimsBlock([claim('deploy', '9c8b7a6d-1111-2222-3333-444455556666')], [rc]).unverified).toHaveLength(1);
    expect(verifyClaimsBlock([claim('deploy', '3f09a1bc-aaaa-bbbb-cccc-dddddddddddd')], [rc]).verified).toHaveLength(1);
  });

  it('ticket_update: verified by an ok file_feedback via ticketId prefix (≥8); wrong prefix / ok:false refuse', () => {
    const tk = receipt('file_feedback', true, { ticketId: '0122f6a9-4de4-45ef-8888-999900001111' });
    expect(verifyClaimsBlock([claim('ticket_update', '0122f6a9')], [tk]).verified).toHaveLength(1);
    expect(verifyClaimsBlock([claim('ticket_update', 'ffffffff')], [tk]).unverified).toHaveLength(1);
    expect(verifyClaimsBlock([claim('ticket_update', '0122f6a9')], [receipt('file_feedback', false, { ticketId: '0122f6a9-4de4-45ef-8888-999900001111' })]).unverified).toHaveLength(1);
  });

  // Vocabulary parity pin (2026-10-18): finish-run.ts TYPE_RECEIPT_TOOLS.ticket_update
  // includes goal_create / todo_create / goal_premise_set, and finish-run's
  // auto-suggest (its line ~1187) hands lanes ticket_update refs minted FROM
  // goal_premise_set receipts — while this map lacked all three, so a truthful
  // receipt-backed premise registration was convicted as phantom (strike
  // specimen: lane b92ef13f final 2026-10-17 16:48Z, "ticket_update
  // fa54f4b9" against a 16:46:09Z goal_premise_set whose receipt carried
  // ids.goalId). This replays the specimen byte-for-byte.
  it('ticket_update: goal_premise_set / goal_create / todo_create receipts vouch refs via ids.goalId|todoId (drift strike specimen fa54f4b9)', () => {
    // THE STRIKE SPECIMEN — premise registration on goal fa54f4b9.
    const prem = receipt('goal_premise_set', true, { goalId: 'fa54f4b9-db30-444e-8e70-1c9c4453e04e' });
    expect(verifyClaimsBlock([claim('ticket_update', 'fa54f4b9')], [prem]).verified).toHaveLength(1);
    // Full-uuid ref binds ids.goalId exactly — id-exact match, and an
    // unrelated full uuid still never rides the coarse tier.
    expect(verifyClaimsBlock([claim('ticket_update', 'fa54f4b9-db30-444e-8e70-1c9c4453e04e')], [prem]).verified).toHaveLength(1);
    expect(verifyClaimsBlock([claim('ticket_update', 'feedface-0000-4000-8000-000000000000')], [prem]).unverified).toHaveLength(1);
    // A failed registration proves nothing.
    expect(verifyClaimsBlock([claim('ticket_update', 'fa54f4b9')], [receipt('goal_premise_set', false, { goalId: 'fa54f4b9-db30-444e-8e70-1c9c4453e04e' })]).unverified).toHaveLength(1);
    // The sibling board mutations.
    const gc = receipt('goal_create', true, { goalId: 'b3f240e4-57ce-4b85-9cfd-af21554cf327' });
    expect(verifyClaimsBlock([claim('ticket_update', 'b3f240e4')], [gc]).verified).toHaveLength(1);
    const tc = receipt('todo_create', true, { todoId: 'd14e0d2d-43b0-4b28-8802-59e2155a36de' });
    expect(verifyClaimsBlock([claim('ticket_update', 'd14e0d2d')], [tc]).verified).toHaveLength(1);
    // An unrelated id still refuses.
    expect(verifyClaimsBlock([claim('ticket_update', 'deadbeef')], [prem]).unverified).toHaveLength(1);
  });

  it('message_sent: verified by ok send_chat_message/schedule_message via any envelope ids value (exact or ≥8 prefix)', () => {
    const sent = receipt('send_chat_message', true, { chatId: 'c0ffee00-1234-4321-aaaa-bbbbccccdddd', messageId: 'abcdef1234' });
    expect(verifyClaimsBlock([claim('message_sent', 'abcdef1234')], [sent]).verified).toHaveLength(1);
    expect(verifyClaimsBlock([claim('message_sent', 'c0ffee00')], [sent]).verified).toHaveLength(1);
    expect(verifyClaimsBlock([claim('message_sent', 'notinids99')], [sent]).unverified).toHaveLength(1);
    const sched = receipt('schedule_message', true, { scheduleId: 'deadbeef-0000-4000-8000-000000000000' });
    expect(verifyClaimsBlock([claim('message_sent', 'deadbeef')], [sched]).verified).toHaveLength(1);
  });

  it('dispatch: verified by ok dispatch_platform_task/start_coding_session via ids value or receipt id', () => {
    const disp = receipt('dispatch_platform_task', true, { taskId: 'aabbccdd-9999-4999-8999-111122223333' });
    expect(verifyClaimsBlock([claim('dispatch', 'aabbccdd')], [disp]).verified).toHaveLength(1);
    const started = receipt('start_coding_session', true, { sessionId: '12345678-aaaa-4bbb-8ccc-dddddddddddd' });
    expect(verifyClaimsBlock([claim('dispatch', '12345678')], [started]).verified).toHaveLength(1);
    expect(verifyClaimsBlock([claim('dispatch', 'aabbccdd')], [receipt('send_chat_message', true, { chatId: 'aabbccdd-9999-4999-8999-111122223333' })]).unverified).toHaveLength(1); // wrong class
  });

  it('file_change: coarse tier — any ok git_commit vouches for a path ref; no git_commit → unverified', () => {
    const commit = receipt('git_commit', true, { sha: '84fe3ae0b1' });
    expect(verifyClaimsBlock([claim('file_change', 'backend/src/app.ts')], [commit]).verified).toHaveLength(1);
    expect(verifyClaimsBlock([claim('file_change', 'backend/src/app.ts')], [receipt('run_command', true)]).unverified).toHaveLength(1);
    expect(verifyClaimsBlock([claim('file_change', '9c8b7a6d-1111-2222-3333-444455556666')], [commit]).unverified).toHaveLength(1); // uuid anti-forgery
  });

  it('verify: requires ids.passed === true — an executed-but-FAILED chain refuses; descriptive refs allowed', () => {
    expect(verifyClaimsBlock([claim('verify', 'typecheck → lint → test')], [receipt('verify', true, { passed: true, failedStage: null })]).verified).toHaveLength(1);
    expect(verifyClaimsBlock([claim('verify', 'typecheck → lint → test')], [receipt('verify', true, { passed: false, failedStage: 'test' })]).unverified).toHaveLength(1);
    const passedRc = receipt('verify', true, { passed: true }, '3f09a1bc-aaaa-bbbb-cccc-dddddddddddd');
    expect(verifyClaimsBlock([claim('verify', '9c8b7a6d-1111-2222-3333-444455556666')], [passedRc]).unverified).toHaveLength(1); // uuid must match
    expect(verifyClaimsBlock([claim('verify', '3f09a1bc-aaaa-bbbb-cccc-dddddddddddd')], [passedRc]).verified).toHaveLength(1);
  });

  it('records the FIRST matching receipt id; empty receipts leave everything unverified', () => {
    const a = receipt('git_push', true, { sha: '1539fa86b1' }, '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const b = receipt('git_push', true, { sha: '1539fa86b1' }, '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    const out = verifyClaimsBlock([claim('push', '1539fa86')], [a, b]);
    expect(out.verified[0].receiptId).toBe('11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(verifyClaimsBlock([claim('push', '1539fa86'), claim('pr', '9')], []).unverified).toHaveLength(2);
  });

  it('mixed block: every claim lands in exactly one bucket', () => {
    const receipts = [
      receipt('git_push', true, { branch: 'main', sha: '1539fa86b1' }),
      receipt('open_pull_request', true, { prNumber: 241, url: 'https://github.com/o/r/pull/241' }),
    ];
    const out = verifyClaimsBlock(
      [claim('push', '1539fa86'), claim('pr', '241'), claim('ticket_update', '0122f6a9')],
      receipts,
    );
    expect(out.verified.map((v) => v.claim.type)).toEqual(['push', 'pr']);
    expect(out.unverified.map((c) => c.type)).toEqual(['ticket_update']);
  });

  // ── Ticket 6d7b379f — the finish_run vocabulary joins the fence ───────────

  it('6d7b379f: the live incident shape PARSES — {"type":"commit","ref":"<sha>"} no longer malforms the block', () => {
    // Lane b92ef13f firing 22 (2026-10-12 16:37Z, msg 9c693023) emitted
    // exactly this entry and the WHOLE block was rejected as malformed.
    const out = parseClaimsBlock(fence('[{"type":"commit","ref":"1833febd","note":"banked on digby/session-b92ef13f, push refused by oq_6fbf2dc6 — local, not claimed as pushed"}]'));
    expect(out.present).toBe(true);
    expect(out.claims).toEqual([{
      type: 'commit', ref: '1833febd',
      note: 'banked on digby/session-b92ef13f, push refused by oq_6fbf2dc6 — local, not claimed as pushed',
    }]);
    expect(out.malformedReason).toBeUndefined();
  });

  it('6d7b379f commit: verified by an ok git_commit (or git_push) receipt naming the sha — never ok:false, never the coarse tier, never a wrong sha', () => {
    const commit = receipt('git_commit', true, { sha: '1833febd1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6' });
    expect(verifyClaimsBlock([claim('commit', '1833febd')], [commit]).verified).toHaveLength(1);
    // full sha named exactly
    expect(verifyClaimsBlock([claim('commit', '1833febd1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6')], [commit]).verified).toHaveLength(1);
    // receipt id vouches too
    expect(verifyClaimsBlock([claim('commit', 'aaaabbbb-cccc-dddd-eeee-ffff00001111')], [commit]).verified).toHaveLength(1);
    // a pushed commit was committed (finish-run's rule): git_push ids.sha vouches
    expect(verifyClaimsBlock([claim('commit', '1833febd')], [receipt('git_push', true, { sha: '1833febd1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6' })]).verified).toHaveLength(1);
    // wrong sha: a miss is a CONVICTION (the file_change/4243f38a discipline —
    // a sha-bearing claim names its evidence)
    expect(verifyClaimsBlock([claim('commit', 'deadbeef9')], [commit]).unverified).toHaveLength(1);
    expect(verifyClaimsBlock([claim('commit', 'deadbeef9')], [commit]).unverifiable).toHaveLength(0);
    // ok:false proves nothing
    expect(verifyClaimsBlock([claim('commit', '1833febd')], [receipt('git_commit', false, { sha: '1833febd1a' })]).unverified).toHaveLength(1);
    // wrong tool class
    expect(verifyClaimsBlock([claim('commit', '1833febd')], [receipt('run_command', true)]).unverified).toHaveLength(1);
    // no receipts at all
    expect(verifyClaimsBlock([claim('commit', '1833febd')], []).unverified).toHaveLength(1);
  });

  it('6d7b379f commit anti-forgery: a full-uuid ref must match the receipt id', () => {
    const commit = receipt('git_commit', true, { sha: '1833febd1a' });
    expect(verifyClaimsBlock([claim('commit', '9c8b7a6d-1111-2222-3333-444455556666')], [commit]).unverified).toHaveLength(1);
  });

  it('6d7b379f schedule_armed: verified by the schedule-tool receipts via receipt id or ids.scheduleId; a miss is UNVERIFIABLE (schedule_self mints no receipt), a uuid miss still convicts', () => {
    const armed = receipt('schedule_message', true, { scheduleId: 'd3b3ba07-4585-49c2-bef1-b5b80193224b', chatId: 'c1' }, '11112222-3333-4444-8555-666677778888');
    expect(verifyClaimsBlock([claim('schedule_armed', 'd3b3ba07')], [armed]).verified).toHaveLength(1);
    expect(verifyClaimsBlock([claim('schedule_armed', '11112222-3333-4444-8555-666677778888')], [armed]).verified).toHaveLength(1);
    // update_schedule / pause+resume arms count too
    expect(verifyClaimsBlock([claim('schedule_armed', 'd3b3ba07')], [receipt('update_schedule', true, { scheduleId: 'd3b3ba07-4585-49c2-bef1-b5b80193224b' })]).verified).toHaveLength(1);
    expect(verifyClaimsBlock([claim('schedule_armed', 'd3b3ba07')], [receipt('resume_schedule', true, { scheduleId: 'd3b3ba07-4585-49c2-bef1-b5b80193224b' })]).verified).toHaveLength(1);
    // a hex/descriptive miss lands UNVERIFIABLE — schedule_self (the platform
    // tool) mints no receipt, so the channel cannot adjudicate
    const miss = verifyClaimsBlock([claim('schedule_armed', 'd3b3ba07')], [receipt('run_command', true)]);
    expect(miss.verified).toHaveLength(0);
    expect(miss.unverified).toHaveLength(0);
    expect(miss.unverifiable).toHaveLength(1);
    // but a FORGED full-uuid receipt citation stays a conviction
    expect(verifyClaimsBlock([claim('schedule_armed', '9c8b7a6d-1111-2222-3333-444455556666')], [armed]).unverified).toHaveLength(1);
  });

  it('6d7b379f email_sent: NO receipt tool can vouch — every miss is UNVERIFIABLE (advisory), a uuid miss still convicts', () => {
    const miss = verifyClaimsBlock([claim('email_sent', 'owner@example.com')], [receipt('run_command', true)]);
    expect(miss.verified).toHaveLength(0);
    expect(miss.unverified).toHaveLength(0);
    expect(miss.unverifiable).toHaveLength(1);
    // forged uuid citation: conviction, never the unverifiable tier
    expect(verifyClaimsBlock([claim('email_sent', '9c8b7a6d-1111-2222-3333-444455556666')], []).unverified).toHaveLength(1);
  });

  it('6d7b379f state_update: verified by the control-tool receipts via receipt id or envelope ids; a miss is UNVERIFIABLE (the supervisor state tools mint no receipt)', () => {
    const stopped = receipt('stop_run', true, { runId: 'run-99' }, 'aaaacccc-dddd-4eee-8fff-000011112222');
    expect(verifyClaimsBlock([claim('state_update', 'run-99')], [stopped]).verified).toHaveLength(1);
    expect(verifyClaimsBlock([claim('state_update', 'aaaacccc')], [stopped]).verified).toHaveLength(1);
    const gate = receipt('set_decision_gate_mode', true, { purpose: 'wake_triage', mode: 'act' });
    expect(verifyClaimsBlock([claim('state_update', 'wake_triage')], [gate]).verified).toHaveLength(1);
    // a descriptive miss ("supervisor_state") is unverifiable — finish-run FR-3's
    // 18-false-rejection lesson: update_supervisor_state mints NO receipt
    const miss = verifyClaimsBlock([claim('state_update', 'supervisor_state')], [receipt('run_command', true)]);
    expect(miss.verified).toHaveLength(0);
    expect(miss.unverified).toHaveLength(0);
    expect(miss.unverifiable).toHaveLength(1);
    // forged uuid citation: conviction
    expect(verifyClaimsBlock([claim('state_update', '9c8b7a6d-1111-2222-3333-444455556666')], []).unverified).toHaveLength(1);
  });
});
