/**
 * Tool-call pre-flight pins (2026-09-09) — the deterministic signals that let
 * the derailment breaker trip on the FIRST wrong-tool call instead of the third.
 */
// learnings-index.service (for looksLikeToolFailure) reaches the env/db leaf — mock it like the agent scaffolds do.
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

import { groundingHaystack, findUngroundedIdArgs, detectIntendedTool, ungroundedIdRefusal, toolNotOfferedRefusal, proseMentionsTool } from './tool-preflight';
import { looksLikeToolFailure } from './learnings-index.service';

describe('groundingHaystack', () => {
  it('collects system, user and tool text; skips assistant turns (incl. their tool_calls args)', () => {
    const hay = groundingHaystack([
      { role: 'system', content: 'THIS CHAT id: 3f2a9c11-aaaa-bbbb-cccc-000000000001' },
      { role: 'user', content: [{ type: 'text', text: 'ticket zeta-77 please' }, { type: 'image_url', image_url: { url: 'x' } }] },
      { role: 'assistant', content: 'calling', tool_calls: [{ function: { name: 'update_feedback', arguments: '{"id":"noop"}' } }] },
      { role: 'tool', content: '{"id":"C0123ABC","name":"#general"}' },
    ]);
    expect(hay).toContain('3f2a9c11-aaaa');
    expect(hay).toContain('zeta-77');
    expect(hay).toContain('C0123ABC');
    expect(hay).not.toContain('noop');
    expect(hay).not.toContain('calling');
  });
});

describe('findUngroundedIdArgs', () => {
  const hay = 'list_feedback → [{"id":"7705fec2-1111-2222-3333-444444444444"}]\nSlack channel chan-general\nrun id 34252590547';

  it('refuses narration tokens in id slots — the incident shapes', () => {
    for (const v of ['noop', 'BREAKING_NOW', 'RUN_CMD_NEXT_CALL', 'PLACEHOLDER', 'garbage-1', 'the-ticket']) {
      expect(findUngroundedIdArgs({ id: v, status: 'open' }, hay)).toEqual([{ key: 'id', value: v }]);
    }
  });

  it('a narration token glued INSIDE a longer identifier the model read is NOT grounded (wave/final 2026-09-27: "noop" inside the facts line\'s `supervisor_turn_noop` executed the 13b2f286 placeholder call)', () => {
    const facts = 'DECISION GATE ROLL-OUT: shadow supervisor_turn_noop (skips a sweep / parks a drain), wake_effort; tier rule …';
    expect(findUngroundedIdArgs({ id: 'noop' }, facts)).toEqual([{ key: 'id', value: 'noop' }]);
    expect(findUngroundedIdArgs({ id: 'turn_noop' }, facts)).toEqual([{ key: 'id', value: 'turn_noop' }]);
    // The same token as a WHOLE word / a whole ident IS grounded.
    expect(findUngroundedIdArgs({ id: 'noop' }, `${facts}\nid: noop`)).toEqual([]);
    expect(findUngroundedIdArgs({ id: 'supervisor_turn_noop' }, facts)).toEqual([]);
    // Punctuation-edged values keep the verbatim test on that side.
    expect(findUngroundedIdArgs({ id: 'chan-general' }, 'channel chan-general,' )).toEqual([]);
    expect(findUngroundedIdArgs({ id: '#42' }, 'see#42.' )).toEqual([]);
    expect(findUngroundedIdArgs({ id: 'a/b' }, 'path xa/b' )).toEqual([{ key: 'id', value: 'a/b' }]);
  });

  it('accepts uuids, 8-char hex prefixes and digit ids regardless of the haystack', () => {
    expect(findUngroundedIdArgs({ id: '7705fec2' }, '')).toEqual([]);
    expect(findUngroundedIdArgs({ id: 'deadbeef-cafe-4000-8000-000000000000' }, '')).toEqual([]);
    expect(findUngroundedIdArgs({ deployRunId: '34252590547' }, '')).toEqual([]);
  });

  it('accepts a non-hex id the model READ this run (tool result, brief, user)', () => {
    expect(findUngroundedIdArgs({ chatId: 'chan-general' }, hay)).toEqual([]);
    expect(findUngroundedIdArgs({ chatId: 'chan-general' }, '')).toEqual([{ key: 'chatId', value: 'chan-general' }]);
    // Slack-style ids happen to be hex-shaped — accepted by shape alone.
    expect(findUngroundedIdArgs({ chatId: 'C0123ABC' }, '')).toEqual([]);
  });

  it('only looks at id-shaped keys and string values; empty strings are left to the tool', () => {
    expect(findUngroundedIdArgs({ status: 'noop', adminNote: 'BREAKING_NOW', priority: 3, id: '' }, '')).toEqual([]);
    expect(findUngroundedIdArgs({ todoId: 12 }, '')).toEqual([]);
    expect(findUngroundedIdArgs(null, '')).toEqual([]);
    expect(findUngroundedIdArgs('str', '')).toEqual([]);
  });

  it('flags every ungrounded id arg in one call', () => {
    expect(findUngroundedIdArgs({ sourceChatId: 'src', targetChatId: 'dst' }, '')).toHaveLength(2);
  });
});

describe('detectIntendedTool', () => {
  const offered = ['run_command', 'update_feedback', 'read_file', 'verify', 'list_feedback'];

  it('names the other tool the reasoning talks about when the called one is never mentioned (CanLaw shape)', () => {
    const reasoning = 'The parts check is done on the box. I need to call run_command with aws ssm get-command-invocation to read it. Calling run_command now.';
    expect(detectIntendedTool(reasoning, 'update_feedback', offered)).toBe('run_command');
  });

  it('returns null when the reasoning names the called tool (a legitimate call that merely failed)', () => {
    expect(detectIntendedTool('Now update_feedback to move the ticket to in_progress after run_command finished.', 'update_feedback', offered)).toBeNull();
  });

  it('returns null on empty / trivial narration or when no offered tool is named', () => {
    expect(detectIntendedTool('', 'update_feedback', offered)).toBeNull();
    expect(detectIntendedTool('ok', 'update_feedback', offered)).toBeNull();
    expect(detectIntendedTool('Let me think about the bundle parts on the EC2 box for a moment.', 'update_feedback', offered)).toBeNull();
  });

  it('matches whole identifiers only — run_command_v2 is not run_command', () => {
    expect(detectIntendedTool('use run_command_v2 to check the build status now', 'update_feedback', offered)).toBeNull();
  });

  it('picks the most-mentioned tool; ties go to the one mentioned last', () => {
    expect(detectIntendedTool('read_file first, then read_file again, then verify.', 'update_feedback', offered)).toBe('read_file');
    expect(detectIntendedTool('maybe read_file, or rather verify the thing.', 'update_feedback', offered)).toBe('verify');
  });
});

describe('detectIntendedTool — mishap e2521a81 adjudication pin (2026-09-29)', () => {
  const offered = ['run_command', 'read_file', 'verify'];
  // Adjudicated MODEL BEHAVIOR, not a framework defect: run 9cce6b5b (chat
  // c3fc83ce, the deck lane) tripped the success-side wrong-tool guard at
  // 2026-09-29T18:36Z — read_file ×5 while the FINAL SENTENCE of the
  // narration carried the bare token `verify`. The guard (2c98b460, shipped
  // 2026-09-22, unchanged since 0d2e12b2d) steered; the lane absorbed the
  // steer, called verify twice (both ok:true with ids.passed:false — real
  // failures, not skips) and kept working productively to step 199+. These
  // three cases pin the exact tokenization boundary that verdict turned on,
  // so a future adjudicator cannot mistake inflected narration for intent.
  it('a final sentence carrying the bare token verify (read_file emitted) convicts — the 9cce6b5b shape', () => {
    expect(detectIntendedTool(
      'The deck builds and the receipts are in. Now I verify the rendered page count via the chain.',
      'read_file', offered,
    )).toBe('verify');
  });

  it('past-tense "verified" is NOT a verify intent — the word-boundary lookahead rejects the inflection, so this false-positive class does not exist', () => {
    // Whole-turn shape: even as the ONLY sentence, "verified" cannot count.
    expect(detectIntendedTool('All claims verified.', 'read_file', offered)).toBeNull();
    // Post-verify-failure shape: recap then a read step — still no conviction.
    expect(detectIntendedTool(
      'All claims verified. Now reading the exact regions I will edit.',
      'read_file', offered,
    )).toBeNull();
  });

  it('verify is a ONE-WORD tool — prose acquittal never applies (tokens<2), so a bare verify in the final sentence has no acquittal path', () => {
    expect(proseMentionsTool('I will verify the deck now', 'verify')).toBe(false);
  });
});

describe('detectIntendedTool — search-target payload carve-out (1d1967eb, narrowed after review)', () => {
  const offered = ['ast_search', 'file_feedback', 'grep', 'read_file', 'verify'];

  // The REAL mishap shape (non-vacuous): called ast_search, narration never
  // names ast_search, and the convicted name IS this call's own pattern
  // payload. Pre-narrowing probes proved the pin is live: the fddd77b25
  // blanket strip acquitted the quoted-intent class (F1) and left the uncued
  // census class convicted (F2). Both boundaries are pinned below.
  it('acquits when the convicted name is the called code-search tool\'s own payload (the ticket mishap)', () => {
    // exact mishap, NON-VACUOUS: narration names file_feedback as a whole
    // word (the pre-fix detector convicted it — proven by this-run probe),
    // the name IS the call's own pattern payload, ast_search never named
    expect(detectIntendedTool(
      "Census: searching for 'file_feedback' callers across the platform module.",
      'ast_search', offered, { pattern: 'file_feedback' },
    )).toBeNull();
    // grep with a query payload, uncued narration
    expect(detectIntendedTool(
      'Scanning for file_feedback callers in the diff.',
      'grep', offered, { query: 'file_feedback' },
    )).toBeNull();
    // semantic search naming its query target in the decision sentence
    expect(detectIntendedTool(
      'Searching for file_feedback usage across the platform module.',
      'search_code_semantic', offered, { query: 'file_feedback' },
    )).toBeNull();
  });

  it('acquits a code-search cue naming the target even when the payload is escaped or shorthand', () => {
    expect(detectIntendedTool(
      'Enumerating file_feedback callers across the tree.',
      'ast_search', offered, { pattern: 'file[_]feedback' },
    )).toBeNull(); // cue leg: "Enumerating" is a search-enumeration verb taking the name as object
    expect(detectIntendedTool(
      'Searching for file_feedback callers in the platform module.',
      'search_code_semantic', offered, { query: 'file_feedback' },
    )).toBeNull();
  });

  it('reviewer F1 — an explicit INTENT verb on the same name still convicts even when the name is this call\'s payload (occurrence-local strip)', () => {
    expect(detectIntendedTool(
      'Now call file_feedback to file the finding.',
      'grep', offered, { pattern: 'file_feedback' },
    )).toBe('file_feedback');
    expect(detectIntendedTool(
      'Enumerating file_feedback callers, then call file_feedback to file the ticket.',
      'grep', offered, { pattern: 'zzz' },
    )).toBe('file_feedback');
    expect(detectIntendedTool(
      'Enumerating file_feedback callers, then call file_feedback to file the ticket.',
      'grep', offered,
    )).toBe('file_feedback');
  });

  it('reviewer F3 — search-payload tools outside the classic set (web_pipe / search_memory) get the same carve-out', () => {
    expect(detectIntendedTool(
      "Searching for 'file_feedback' rulings.",
      'web_pipe', offered, { query: 'file_feedback' },
    )).toBeNull();
    expect(detectIntendedTool(
      'Searching for file_feedback in session memory.',
      'search_memory', offered, { query: 'file_feedback' },
    )).toBeNull();
  });

  it('F1 boundary — a QUOTED name stated as INTENT convicts again (the over-broad strip is gone)', () => {
    expect(detectIntendedTool(
      'Now I will call `run_command` to probe the box.',
      'edit_file', ['edit_file', 'run_command', 'grep'],
    )).toBe('run_command');
    expect(detectIntendedTool(
      'Next: `verify` the build before merging.',
      'read_file', ['read_file', 'verify', 'grep'],
    )).toBe('verify');
    expect(detectIntendedTool(
      "I should have called 'file_feedback' instead.",
      'ast_search', offered,
    )).toBe('file_feedback');
    // quoted intent while the called tool IS a code-search tool but the name
    // is NOT its payload — still intent evidence
    expect(detectIntendedTool(
      "I should have called 'file_feedback' instead of this search.",
      'grep', offered, { pattern: 'detectIntendedTool' },
    )).toBe('file_feedback');
  });

  it('F2 boundary — a name that is not this call\'s payload and carries no search cue still convicts', () => {
    expect(detectIntendedTool(
      'Switching to file_feedback for the filing step now.',
      'ast_search', offered, { pattern: 'fileFeedbackTicket' },
    )).toBe('file_feedback');
    expect(detectIntendedTool(
      'The census will need file_feedback next.',
      'ast_search', offered, { pattern: 'something-else' },
    )).toBe('file_feedback');
    // non-search tool narrating a search shape — no carve-out at all
    expect(detectIntendedTool(
      "Search for \"file_feedback\" in the tree.",
      'read_file', offered,
    )).toBe('file_feedback');
  });

  it('prior carve-out shapes from fddd77b25 that are NOT this call\'s payload now convict (blanket strip removed)', () => {
    // these acquitted under fddd77b25's blanket strip; the name is a bare
    // mention, not the payload of the call that was actually made
    expect(detectIntendedTool('Look up `file_feedback` in the index.', 'grep', offered, { pattern: 'countStandalone' })).toBe('file_feedback');
    expect(detectIntendedTool('query=file_feedback in the last hour.', 'grep', offered, { pattern: 'else' })).toBe('file_feedback');
  });
});

// ── DETECTOR-RECALL REPLAY (ticket 1d1967eb detector change) ────────────────
describe('DETECTOR-RECALL REPLAY — prior true positives still fire (1d1967eb detector change)', () => {
  // This PR relaxes tool-preflight's intent-mismatch conviction for search
  // payloads. The replay below re-runs the detector's PRIOR true positives —
  // the adjudicated incidents its conviction leg exists for — and asserts
  // they STILL convict under the narrowed carve-out.
  it('CanLaw cec340f2 shape — reasoning names run_command, emission is update_feedback', () => {
    const reasoning = 'The parts check is done on the box. I need to call run_command with aws ssm get-command-invocation to read it. Calling run_command now.';
    expect(detectIntendedTool(reasoning, 'update_feedback', ['run_command', 'update_feedback', 'read_file', 'verify'])).toBe('run_command');
  });
  it('9cce6b5b shape (e2521a81 pin) — bare verify in the final sentence convicts read_file', () => {
    expect(detectIntendedTool(
      'The deck builds and the receipts are in. Now I verify the rendered page count via the chain.',
      'read_file', ['run_command', 'read_file', 'verify'],
    )).toBe('verify');
  });
  it('bare unquoted wrong-tool intent convicts (the base conviction class)', () => {
    expect(detectIntendedTool(
      'I should have called file_feedback instead.',
      'ast_search', ['ast_search', 'file_feedback', 'grep'],
    )).toBe('file_feedback');
  });
  it('022eb482 glue boundary still holds — verify-wave.sh is NOT a verify mention', () => {
    expect(detectIntendedTool(
      'applying the remaining `verify-wave.sh` edits now.',
      'edit_file', ['edit_file', 'verify', 'run_command'],
    )).toBeNull();
  });
  it('most-mentioned / tie-to-last resolution still holds', () => {
    expect(detectIntendedTool('read_file first, then read_file again, then verify.', 'update_feedback', ['update_feedback', 'read_file', 'verify'])).toBe('read_file');
    expect(detectIntendedTool('maybe read_file, or rather verify the thing.', 'update_feedback', ['update_feedback', 'read_file', 'verify'])).toBe('verify');
  });
});
// ── end DETECTOR-RECALL REPLAY ─────────────────────────────────────────────

describe('refusal envelopes', () => {
  it('are failure-shaped for looksLikeToolFailure (so the streak breaker sees them)', () => {
    const r1 = ungroundedIdRefusal('update_feedback', [{ key: 'id', value: 'noop' }], 'run_command');
    const r2 = toolNotOfferedRefusal('update_canvas', ['run_command', 'read_file'], 'not loaded');
    expect(looksLikeToolFailure(r1)).toBe(true);
    expect(looksLikeToolFailure(r2)).toBe(true);
    expect(JSON.parse(r1)).toMatchObject({ ok: false, reason: 'ungrounded_id', tool: 'update_feedback' });
    expect(JSON.parse(r1).message).toContain('NOT EXECUTED');
    expect(JSON.parse(r1).message).toContain('named run_command');
    expect(JSON.parse(r2)).toMatchObject({ ok: false, reason: 'tool_not_offered' });
    expect(JSON.parse(r2).message).toContain('not loaded');
  });
});
