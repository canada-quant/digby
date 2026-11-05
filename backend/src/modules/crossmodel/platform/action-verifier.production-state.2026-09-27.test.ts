/**
 * PRODUCTION-STATE UNREAD lane pins (supervisor doctrine audit D1,
 * 2026-09-27). The incident class: a project supervisor told the owner a
 * specific build ("stock NVFP4 433 GiB") was serving — from memory, with no
 * read of that state on the chat for two weeks — and no lane audited
 * production-state sentences (no id ⇒ every existence lane passed it).
 * Review fixes (same day): whole-token grounding + bare counts never ground,
 * clause-scoped disclaimer / governing-form history / negation exemptions,
 * memory + own-chat reads excluded from the haystack, onMainHead grounding.
 *
 * Pins: the miner (predicate shapes + the four exemptions), the fact-token
 * extractor (clocks stripped; digit-bearing tokens only), the matcher
 * (tokens_unread when NONE of a sentence's tokens appear in this run's tool
 * output / receipt ids; no_read_this_run only for a token-less sentence in a
 * run with zero evidence-bearing reads), the cap, the kill switch, and the
 * fail-open contract. OBSERVE-ONLY by construction: the function returns
 * hits; it never rewrites a note (the chat-agent seam records telemetry and
 * delivers the note unmodified — pinned in chat-agent.service.test.ts).
 *
 * Mock discipline mirrors action-verifier.board-assertions.2026-09-16.test.ts
 * (the module's import chain reaches prisma / utility-llm / feedback).
 */
const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null) },
  chatCodingState: { findFirst: jest.fn(async () => null) },
  chatSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  userFeatureRequest: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  projectGoal: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []), groupBy: jest.fn(async () => []) },
  projectTodo: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []), groupBy: jest.fn(async () => []) },
  ownerQuestion: { findFirst: jest.fn(async () => null) },
  runToolReceipt: { findFirst: jest.fn(async () => null) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockUtilityChat = jest.fn(async () => '');
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: (...a: any[]) => (mockUtilityChat as any)(...a) }));
jest.mock('../feedback/feedback.service', () => ({ __esModule: true, fileFeedbackTicket: jest.fn(async () => ({ deduped: false, ticket: { id: 't-1' } })) }));
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  appendVerifierRefutation: jest.fn(async () => {}),
  getSupervisorState: jest.fn(async () => ({ directives: [], dispatches: [], projects: [], notes: '', refutations: [] })),
}));
jest.mock('../coding/run-receipts.service', () => ({ __esModule: true, getRecentChatReceipts: jest.fn(async () => []) }));

import {
  mineProductionStateSentences,
  productionStateFactTokens,
  findUnreadProductionStateClaims,
  PRODUCTION_STATE_STRIKE,
  PRODUCTION_STATE_MAX_HITS,
  PRODUCTION_STATE_NOT_READ_PHRASE,
  PRODUCTION_STATE_SEAM,
  PRODUCTION_STATE_MEMORY_TOOLS,
  productionStateGroundableTokens,
  productionStateGroundingTexts,
  productionStateHasGroundingRead,
  ownerTurnClaimUnits,
} from './action-verifier';
import { isWriteAckToolName } from '../chat-agent/tool-call-leak';

// The incident sentence, verbatim in shape.
const SPARK = 'Serving status: stock NVFP4 433 GiB is serving on the 4-node cluster behind the vLLM endpoint.';

describe('mineProductionStateSentences — the serving/deployed/banked predicate + exemptions', () => {
  it('reads the incident shapes: "is serving on", "deployed on", "is banked", "in production", "running on", "on main head"', () => {
    const note = [
      SPARK,
      'GLM-5.3 is deployed on nodes 1-4 via the RunPod template.',
      'The s2v12r6 checkpoint is banked at the S3 prefix.',
      'The 0.6.2 agent is in production on the target Mac.',
      'Box C is running on the shared digby-app image at 32 slots.',
      'Every box is on main head after wave 3620925.',
    ].join('\n');
    const got = mineProductionStateSentences(note);
    expect(got).toHaveLength(6);
    expect(got[0]).toBe(SPARK);
  });

  it('a lane "running" a job is lane state, not production: "running the sweep" / "is running late" are NOT mined', () => {
    const note = [
      'Lane 3e1cae6f is running the comparator sweep now.',
      'The verifier is running late on the 5th shard.',
    ].join('\n');
    expect(mineProductionStateSentences(note)).toEqual([]);
  });

  it('exemptions: the doctrine disclaimer, forward intent, the history register (governing form), a negated predicate, and quoted lines are never mined', () => {
    const note = [
      `Stock NVFP4 433 GiB is serving on the cluster (${PRODUCTION_STATE_NOT_READ_PHRASE}).`,
      'What is serving on the cluster is unverified this wake.',
      'The s2v12r6 checkpoint will be deployed on the cluster once the smoke passes.',
      'Last wake NVFP4 433 GiB was serving on the cluster.',
      'Yesterday the 0.6.2 agent was in production on the target Mac.',
      'NVFP4 433 GiB was serving on the cluster 2 h ago.',
      `> ${SPARK}`,
      'ETA: the 0.6.3 DMG is deployed on the mini by tonight.',
      'PR 1098 is not yet in production.',
      'The s2v12r6 checkpoint is not deployed on the cluster.',
    ].join('\n');
    expect(mineProductionStateSentences(note)).toEqual([]);
  });

  it('REVIEW FIX: a bare "last" / "prior" / "earlier" governs nothing — "the last checkpoint … is serving" and "per the prior plan … is serving" ARE mined', () => {
    const note = [
      'The last checkpoint s2v12r6 is serving on the cluster.',
      'Per the prior plan, stock NVFP4 433 GiB is serving on the cluster.',
      'Since the owner\'s last message, stock NVFP4 433 GiB is serving on the cluster.',
      'The earlier build 0.6.1 is deployed on the mini.',
    ].join('\n');
    expect(mineProductionStateSentences(note)).toHaveLength(4);
  });

  it('REVIEW FIX: the disclaimer / history exemption is CLAUSE-scoped — a neighbour claim in the same sentence is still mined, as its own unit', () => {
    const laundered = `Stock NVFP4 433 GiB is serving on the cluster (${PRODUCTION_STATE_NOT_READ_PHRASE}), and box C is running on 32 slots.`;
    expect(mineProductionStateSentences(laundered)).toEqual(['box C is running on 32 slots.']);
    const history = 'Last wake it was serving on 2 nodes; now stock NVFP4 433 GiB is serving on the 4-node cluster.';
    expect(mineProductionStateSentences(history)).toEqual(['now stock NVFP4 433 GiB is serving on the 4-node cluster.']);
    // The mined unit carries ONLY its own tokens: "32" is a bare count, so the unit follows the token-less rule —
    // an evidence read this run exonerates it, no read at all convicts it (the disclaimed clause's tokens never vouch).
    expect(findUnreadProductionStateClaims(laundered, { parts: [{ type: 'tool_result', name: 'get_chat_status', result: 'lane C: 32 slots busy' }], receipts: [] })).toEqual([]);
    expect(findUnreadProductionStateClaims(laundered, { parts: [], receipts: [] })).toEqual([{ sentence: 'box C is running on 32 slots.', factTokens: ['32'], reason: 'no_read_this_run' }]);
  });

  it('REVIEW FIX: "healthy" / "online" are lane-health vocabulary, not production state', () => {
    expect(mineProductionStateSentences('Lane 3e1cae6f is healthy and online.')).toEqual([]);
    expect(mineProductionStateSentences('Every lane is online and healthy this wake.')).toEqual([]);
  });

  it('is sentence-scoped: an exempt sentence does not launder its neighbour on the same line', () => {
    const note = `Last wake nothing moved. ${SPARK}`;
    const got = mineProductionStateSentences(note);
    expect(got).toEqual([SPARK]);
  });
});

describe('productionStateFactTokens — digit-bearing tokens, clocks stripped', () => {
  it('keeps model / size / version / id tokens and drops clock + ISO stamps', () => {
    const toks = productionStateFactTokens('As of 14:20Z (2026-09-27T14:20:11Z) stock NVFP4 433 GiB is serving on the 4-node cluster at 32 slots, msg 3e1cae6f, GLM-5.3, t3.large.');
    expect(toks).toEqual(expect.arrayContaining(['nvfp4', '433', '4-node', '32', '3e1cae6f', 'glm-5.3', 't3.large']));
    expect(toks).not.toContain('14');
    expect(toks).not.toContain('20z');
    expect(toks).not.toContain('2026-09-27t14');
    expect(toks.length).toBeLessThanOrEqual(8);
  });

  it('a sentence with no digits has no fact tokens', () => {
    expect(productionStateFactTokens('The cluster is serving on the endpoint.')).toEqual([]);
  });
});

describe('findUnreadProductionStateClaims — the matcher', () => {
  it('THE INCIDENT: a token-bearing serving sentence in a run with no tool output and no receipts is UNREAD (tokens_unread)', () => {
    const hits = findUnreadProductionStateClaims(`Wake summary.\n${SPARK}\nACTIONS TAKEN\n- nudged lane (msg 11112222)`, { parts: [], receipts: [] });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ reason: 'tokens_unread', sentence: SPARK });
    expect(hits[0].factTokens).toEqual(expect.arrayContaining(['nvfp4', '433']));
  });

  it('ONE grounded token exonerates: the run read "NVFP4" in a get_chat_status result', () => {
    const parts = [{ type: 'tool_call', name: 'get_chat_status' }, { type: 'tool_result', name: 'get_chat_status', result: 'lane spark-serve: last note "NVFP4 up, 433 GiB resident"' }];
    expect(findUnreadProductionStateClaims(SPARK, { parts, receipts: [] })).toEqual([]);
  });

  it('a receipt id grounds a token too (receipt ids ride the haystack; a supervisor\'s receipts are platform reads — it has no run_command); an ok:false receipt does not', () => {
    const okReceipt = [{ tool: 'get_run_receipts', ok: true, ids: { sha: 'abc', note: 'nvfp4' } }] as any;
    expect(findUnreadProductionStateClaims(SPARK, { parts: [], receipts: okReceipt })).toEqual([]);
    const stagedReceipt = [{ tool: 'get_run_receipts', ok: false, ids: { note: 'nvfp4' } }] as any;
    expect(findUnreadProductionStateClaims(SPARK, { parts: [], receipts: stagedReceipt })).toHaveLength(1);
  });

  it('the seam\'s extra haystacks (a rejected first attempt\'s tool texts) exonerate as well', () => {
    expect(findUnreadProductionStateClaims(SPARK, { parts: [], receipts: [], extraEvidenceHaystacks: ['vllm: model NVFP4 loaded'] })).toEqual([]);
  });

  it('a TOKEN-LESS production sentence is unread only when the run made NO evidence-bearing read; a non-evidence tool does not count', () => {
    const note = 'The cluster is serving on the endpoint.';
    expect(findUnreadProductionStateClaims(note, { parts: [], receipts: [] })).toEqual([{ sentence: note, factTokens: [], reason: 'no_read_this_run' }]);
    // update_plan / search_memory prove nothing about the world.
    const nonEvidence = [{ type: 'tool_result', name: 'update_plan', result: 'plan set' }, { type: 'tool_result', name: 'search_memory', result: 'nvfp4 serving' }];
    expect(findUnreadProductionStateClaims(note, { parts: nonEvidence, receipts: [] })).toHaveLength(1);
    // One evidence-bearing read (any tool outside NON_EVIDENCE_TOOLS) exonerates the token-less shape.
    const evidence = [{ type: 'tool_result', name: 'get_fleet_telemetry', result: 'boxes: all green' }];
    expect(findUnreadProductionStateClaims(note, { parts: evidence, receipts: [] })).toEqual([]);
    const okReceipt = [{ tool: 'get_fleet_telemetry', ok: true, ids: {} }] as any;
    expect(findUnreadProductionStateClaims(note, { parts: [], receipts: okReceipt })).toEqual([]);
  });

  it('a note with no production-state sentence yields nothing (a plain no-op wake costs nothing)', () => {
    expect(findUnreadProductionStateClaims('WAKE: no-op — nothing moved in spark-cluster since the previous wake', {})).toEqual([]);
    expect(findUnreadProductionStateClaims('', {})).toEqual([]);
  });

  it('caps at PRODUCTION_STATE_MAX_HITS and clips sentences to 180 chars', () => {
    const lines = Array.from({ length: PRODUCTION_STATE_MAX_HITS + 3 }, (_, i) => `Model v${i + 1}.0 is serving on cluster-${i + 1} with ${100 + i} GiB resident and a long tail ${'x'.repeat(200)}.`);
    const hits = findUnreadProductionStateClaims(lines.join('\n'), { parts: [], receipts: [] });
    expect(hits).toHaveLength(PRODUCTION_STATE_MAX_HITS);
    for (const h of hits) expect(h.sentence.length).toBeLessThanOrEqual(180);
  });

  it('fails open: malformed parts / receipts never throw', () => {
    expect(() => findUnreadProductionStateClaims(SPARK, { parts: [null, 42, { type: 'tool_result' }] as any, receipts: [null, { ok: true }] as any })).not.toThrow();
    expect(findUnreadProductionStateClaims(SPARK, { parts: null, receipts: null })).toHaveLength(1);
  });

  it('constants the seam and the doctrine key on', () => {
    expect(PRODUCTION_STATE_STRIKE).toBe('production_state_unread');
    expect(PRODUCTION_STATE_SEAM).toBe('machine_wake_production_state');
    expect(PRODUCTION_STATE_NOT_READ_PHRASE).toBe('not read this wake');
  });
});

describe('findUnreadProductionStateClaims — review fixes 2026-09-27 (grounding precision)', () => {
  it('P1/P2b/P10: grounding is WHOLE-TOKEN — "433" is not in "9c4330ab", and a bare 1–2 digit count never grounds ("chats: 4 rows", "ok: 12 chats")', () => {
    const sentence = 'Stock NVFP4 433 GiB is serving on 4 nodes.';
    expect(productionStateGroundableTokens(productionStateFactTokens(sentence))).toEqual(['nvfp4', '433']);
    const p1 = [{ type: 'tool_result', name: 'list_chats', result: 'chats: 4 rows' }];
    expect(findUnreadProductionStateClaims(sentence, { parts: p1, receipts: [] })).toHaveLength(1);
    const p2b = [{ type: 'tool_result', name: 'list_chats', result: 'chat 9c4330ab title x' }];
    expect(findUnreadProductionStateClaims(SPARK, { parts: p2b, receipts: [] })).toHaveLength(1);
    // A real whole-token read still exonerates.
    const real = [{ type: 'tool_result', name: 'get_chat_messages', result: '{"chatId": "lane-1", "messages": [{"role":"assistant","content":"nvidia-smi: 433 GiB resident"}]}' }];
    expect(findUnreadProductionStateClaims(SPARK, { parts: real, receipts: [] })).toEqual([]);
    // P10: a sentence whose only fact is a bare count behaves like a token-less sentence — an evidence read exonerates it, none convicts it.
    const p10 = 'The endpoint is serving on 2 replicas.';
    expect(findUnreadProductionStateClaims(p10, { parts: [{ type: 'tool_result', name: 'get_chat_status', result: 'ok: 12 chats' }], receipts: [] })).toEqual([]);
    expect(findUnreadProductionStateClaims(p10, { parts: [], receipts: [] })).toEqual([{ sentence: p10, factTokens: ['2'], reason: 'no_read_this_run' }]);
  });

  it('P7: a get_chat_messages read of the supervisor\'s OWN chat grounds nothing (a prior note is not a fact) — by call args or by the result envelope; another chat\'s read still does', () => {
    const own = '[assistant 2026-09-14] stock NVFP4 433 GiB is serving on the cluster';
    const byArgs = [{ type: 'tool_call', name: 'get_chat_messages', args: { chatId: 'sup-chat-1' } }, { type: 'tool_result', name: 'get_chat_messages', result: own }];
    expect(findUnreadProductionStateClaims(SPARK, { parts: byArgs, receipts: [], selfChatId: 'sup-chat-1' })).toHaveLength(1);
    const byPrefix = [{ type: 'tool_call', name: 'get_chat_messages', args: { chatId: 'sup-chat' } }, { type: 'tool_result', name: 'get_chat_messages', result: own }];
    expect(findUnreadProductionStateClaims(SPARK, { parts: byPrefix, receipts: [], selfChatId: 'sup-chat-1' })).toHaveLength(1);
    const byEnvelope = [{ type: 'tool_result', name: 'get_chat_messages', result: `{\n "chatId": "sup-chat-1",\n "messages": [{"content": "${own}"}]}` }];
    expect(findUnreadProductionStateClaims(SPARK, { parts: byEnvelope, receipts: [], selfChatId: 'sup-chat-1' })).toHaveLength(1);
    // The LANE's chat: its message is the read the doctrine names.
    const lane = [{ type: 'tool_call', name: 'get_chat_messages', args: { chatId: 'lane-9' } }, { type: 'tool_result', name: 'get_chat_messages', result: '{"chatId": "lane-9", "messages": [{"content": "vllm: NVFP4 loaded, 433 GiB"}]}' }];
    expect(findUnreadProductionStateClaims(SPARK, { parts: lane, receipts: [], selfChatId: 'sup-chat-1' })).toEqual([]);
    // No selfChatId (a non-seam caller): nothing is excluded.
    expect(findUnreadProductionStateClaims(SPARK, { parts: byArgs, receipts: [] })).toEqual([]);
    expect(productionStateGroundingTexts({ parts: byArgs, selfChatId: 'sup-chat-1' }).texts).toEqual([]);
  });

  it('memory surfaces never ground: search_memory (NON_EVIDENCE_TOOLS) and get_supervisor_state results are outside the haystack', () => {
    expect(PRODUCTION_STATE_MEMORY_TOOLS.has('get_supervisor_state')).toBe(true);
    const parts = [
      { type: 'tool_result', name: 'search_memory', result: 'memory: NVFP4 433 GiB serving' },
      { type: 'tool_result', name: 'get_supervisor_state', result: 'notes: NVFP4 433 GiB serving on the cluster' },
    ];
    expect(findUnreadProductionStateClaims(SPARK, { parts, receipts: [] })).toHaveLength(1);
    expect(productionStateGroundingTexts({ parts }).texts).toEqual([]);
  });

  it('P17: the "on main head" shape is grounded by an onMainHead field in a platform-observe read (the digits around it are not the fact)', () => {
    const note = 'Every box is on main head after wave 36209251894.';
    const telemetry = [{ type: 'tool_result', name: 'get_fleet_telemetry', result: '{"boxes":[{"host":"a","onMainHead":true},{"host":"b","onMainHead":true}]}' }];
    expect(findUnreadProductionStateClaims(note, { parts: telemetry, receipts: [] })).toEqual([]);
    // A memory read carrying the same field does not count; no read at all convicts.
    const memory = [{ type: 'tool_result', name: 'search_memory', result: '{"onMainHead":true}' }];
    expect(findUnreadProductionStateClaims(note, { parts: memory, receipts: [] })).toHaveLength(1);
    expect(findUnreadProductionStateClaims(note, { parts: [], receipts: [] })).toHaveLength(1);
  });

  // Downstream observe-only pins (the adjudicator skip + the seam-alarm exclusion) live in
  // fleet/strike-adjudication.service.test.ts and fleet/seam-alarm.test.ts — importing those
  // services here would drag redis/env into this pure suite.
});

// 2026-10-22 (owner-turn live-state read — chat-agent/unread-state-note.ts): the owner seam re-runs a supervisor
// owner answer only when NO attempt of the turn made a read that could ground it, with the matcher's own
// haystack discipline; the honest exit the retry notice names must never be judged again.
describe('productionStateHasGroundingRead — the owner-turn re-run gate (2026-10-22)', () => {
  it('a zero-read turn has no grounding read; a lane read, a status read or a fleet-telemetry read does', () => {
    expect(productionStateHasGroundingRead({ parts: [] })).toBe(false);
    expect(productionStateHasGroundingRead({})).toBe(false);
    expect(productionStateHasGroundingRead({ parts: [{ type: 'tool_result', name: 'get_chat_status', result: '{"status":"idle"}' }] })).toBe(true);
    expect(productionStateHasGroundingRead({ parts: [{ type: 'tool_result', name: 'get_fleet_telemetry', result: '{"boxes":[]}' }] })).toBe(true);
    const lane = [{ type: 'tool_call', name: 'get_chat_messages', args: { chatId: 'lane-9' } }, { type: 'tool_result', name: 'get_chat_messages', result: '{"chatId": "lane-9"}' }];
    expect(productionStateHasGroundingRead({ parts: lane, selfChatId: 'sup-chat-1' })).toBe(true);
  });

  it('memory, the own state doc and a read of the supervisor\'s OWN chat are not grounding reads (the incident answered from exactly those)', () => {
    const memory = [
      { type: 'tool_result', name: 'search_memory', result: 'memory: NVFP4 433 GiB serving' },
      { type: 'tool_result', name: 'get_supervisor_state', result: 'notes: NVFP4 433 GiB serving' },
    ];
    expect(productionStateHasGroundingRead({ parts: memory })).toBe(false);
    const own = [{ type: 'tool_call', name: 'get_chat_messages', args: { chatId: 'sup-chat-1' } }, { type: 'tool_result', name: 'get_chat_messages', result: 'prior notes' }];
    expect(productionStateHasGroundingRead({ parts: own, selfChatId: 'sup-chat-1' })).toBe(false);
    // A tool CALL whose result never landed grounds nothing.
    expect(productionStateHasGroundingRead({ parts: [{ type: 'tool_call', name: 'get_chat_status', args: {} }] })).toBe(false);
  });

  it('a WRITE is not a read: a turn whose only calls record / send / file work has no grounding read (review 2026-10-23)', () => {
    // The owner turn records a directive (update_supervisor_state), messages a lane, writes a todo — then answers
    // "GLM-5.3 NVFP4 is serving on spark-2 at 433 tok/s" from memory. Every write answered with a non-empty result,
    // and the old gate counted each as a read: no re-run, no line, no telemetry row.
    const note = 'GLM-5.3 NVFP4 is serving on spark-2 at 433 tok/s.';
    for (const [name, result] of [
      ['update_supervisor_state', '{"ok":true,"directives":[{"id":"d1","text":"keep GLM-5.3 NVFP4 serving on spark-2 at 433 tok/s"}]}'],
      ['send_chat_message', '{"ok":true,"messageId":"m1","delivered":"GLM-5.3 NVFP4 is serving on spark-2 at 433 tok/s"}'],
      ['todo_update', '{"ok":true,"todo":{"id":"t1","note":"spark-2 serving 433 tok/s"}}'],
      ['gmail_send_email', '{"ok":true}'],
    ] as const) {
      const parts = [{ type: 'tool_call', name, args: {} }, { type: 'tool_result', name, result }];
      expect(productionStateHasGroundingRead({ parts })).toBe(false);
      // …and the write's own echo of the model's words never grounds the claim either.
      expect(findUnreadProductionStateClaims(note, { parts, receipts: [], ownerTurn: true }).length).toBeGreaterThan(0);
    }
    // A real read beside the write still counts.
    expect(productionStateHasGroundingRead({ parts: [
      { type: 'tool_result', name: 'update_supervisor_state', result: '{"ok":true}' },
      { type: 'tool_result', name: 'get_chat_status', result: '{"status":"idle"}' },
    ] })).toBe(true);
  });

  // Integration recheck 2026-10-23: the write filter keyed on REPLAY-unsafety, which also drops real live reads —
  // browser_task / computer_task observe the page / screen, infra_action env_probe reads the host — so an owner
  // answer grounded on one got a false "not read in this turn" line. Only a result that merely acknowledges a
  // write (platform mutations, connector + document writes) is skipped.
  it('a live read that is replay-unsafe still grounds: browser_task, computer_task, infra_action env_probe (not its acting kinds)', () => {
    const note = 'GLM-5.3 NVFP4 is serving on spark-2 at 433 tok/s.';
    const page = 'spark-2 dashboard: GLM-5.3 NVFP4 serving — 433 tok/s';
    for (const [name, args] of [
      ['browser_task', { task: 'open the spark-2 dashboard' }],
      ['computer_task', { task: 'read the serving panel' }],
      ['infra_action', { kind: 'env_probe' }],
    ] as const) {
      const parts = [{ type: 'tool_call', name, args }, { type: 'tool_result', name, result: page }];
      expect(productionStateHasGroundingRead({ parts })).toBe(true);
      expect(findUnreadProductionStateClaims(note, { parts, receipts: [], ownerTurn: true })).toEqual([]);
    }
    // An ACTING infra_action kind answers with its own dry-run / executed receipt — a write ack, never a read.
    const resize = [{ type: 'tool_call', name: 'infra_action', args: { kind: 'dev_container_resize' } }, { type: 'tool_result', name: 'infra_action', result: page }];
    expect(productionStateHasGroundingRead({ parts: resize })).toBe(false);
    // The pairing follows the call that PRECEDES each result: an env_probe after a resize grounds, the resize does not.
    expect(productionStateGroundingTexts({ parts: [
      { type: 'tool_call', name: 'infra_action', args: { kind: 'dev_container_resize' } }, { type: 'tool_result', name: 'infra_action', result: 'resize receipt' },
      { type: 'tool_call', name: 'infra_action', args: { kind: 'env_probe' } }, { type: 'tool_result', name: 'infra_action', result: 'probe reading' },
    ] }).texts).toEqual(['probe reading']);
  });

  it('isWriteAckToolName: platform mutations, connector + document writes are acks; live reads and plain reads are not', () => {
    for (const n of ['update_supervisor_state', 'send_chat_message', 'todo_update', 'infra_action', 'gmail_send_email', 'slack_post_message', 'create_document', 'update_document', 'fill_pdf_form']) {
      expect(isWriteAckToolName(n)).toBe(true);
    }
    expect(isWriteAckToolName('infra_action', { kind: 'env_probe' })).toBe(false);
    for (const n of ['browser_task', 'computer_task', 'get_chat_status', 'search_engine', 'gmail_search', 'read_document', '', null, undefined]) {
      expect(isWriteAckToolName(n as any)).toBe(false);
    }
  });

  it('the retry notice\'s honest exit ("not read this turn") is the doctrine disclaimer — never mined again', () => {
    expect(findUnreadProductionStateClaims('GLM-5.3 is deployed on nodes 1-4 (not read this turn — from the 05:40Z lane note).', { parts: [], receipts: [] })).toEqual([]);
    expect(findUnreadProductionStateClaims('GLM-5.3 is deployed on nodes 1-4.', { parts: [], receipts: [] })).toHaveLength(1);
  });
});

// 2026-10-22 review (owner-turn live-state read): the matcher was written for machine-wake notes; an OWNER answer
// carries questions, offers and restated asks, and the owner-turn re-run tells the model to say "in the same
// sentence" that it was not read. ownerTurn reduces each sentence to what it ASSERTS; the machine lane never sets it.
describe('ownerTurn — questions, offers and restated asks are never claims on an owner answer (2026-10-22 review)', () => {
  const NONE = { parts: [], receipts: [] };
  it('an offer, a restated question and a bare question are not claims — the machine lane (no ownerTurn) still mines them, byte-identical', () => {
    const offer = 'Want me to verify that the v0.6.3 agent is deployed on mbp-1?';
    const restated = 'You asked whether glm-5.3 is deployed on spark-2';
    const bare = "What's running in production?";
    const chip = '- Is GLM-5.3 still serving on spark-2?';
    const imperative = '- Check that PR 1888 is deployed on main head';
    for (const t of [offer, restated, bare, chip, imperative]) {
      expect(findUnreadProductionStateClaims(t, { ...NONE, ownerTurn: true })).toEqual([]);
      expect(findUnreadProductionStateClaims(t, NONE)).toHaveLength(1);
    }
  });

  it('a question chunk drops only itself: the statement in front of it (or after it) is still a claim', () => {
    expect(ownerTurnClaimUnits('Is GLM-5.3 still serving on spark-2? Yes, it is serving on spark-2 since 21:00Z.')).toEqual(['Yes, it is serving on spark-2 since 21:00Z.']);
    expect(ownerTurnClaimUnits("Yes, it's deployed on spark-2 — want me to pull the logs?")).toEqual(["Yes, it's deployed on spark-2"]);
    expect(ownerTurnClaimUnits('Is GLM-5.3 serving on spark-2 — or did the deploy roll back?')).toEqual([]);
    expect(findUnreadProductionStateClaims('Is GLM-5.3 still serving on spark-2? Yes, it is serving on spark-2 since 21:00Z.', { ...NONE, ownerTurn: true })).toHaveLength(1);
  });

  it('a governing cue cuts its clause — a conditional is not a claim, the claim in front of the cue is; the past tense ("I confirmed that") is a claim', () => {
    expect(ownerTurnClaimUnits('If GLM-5.3 is deployed on spark-2, the memory fix is live.')).toEqual([]);
    expect(ownerTurnClaimUnits('GLM-5.3 is deployed on spark-2 if the canary passed.')).toEqual(['GLM-5.3 is deployed on spark-2']);
    expect(ownerTurnClaimUnits('I can check whether it is serving on spark-2.')).toEqual([]); // "I can check" asserts nothing
    expect(findUnreadProductionStateClaims('I confirmed that GLM-5.3 is deployed on spark-2.', { ...NONE, ownerTurn: true })).toHaveLength(1);
    expect(findUnreadProductionStateClaims('GLM-5.3 is deployed on spark-2, and if you want I can roll it back.', { ...NONE, ownerTurn: true })).toHaveLength(1);
  });

  it('the honest exit in the same sentence — even behind an em-dash, which the machine lane treats as a clause boundary — is never a hit', () => {
    const dash = 'GLM-5.3 is deployed on spark-2 — not read this turn; my last note on it is from 20:00Z.';
    expect(findUnreadProductionStateClaims(dash, { ...NONE, ownerTurn: true })).toEqual([]);
    expect(findUnreadProductionStateClaims(dash, NONE)).toHaveLength(1); // the machine lane's clause scope is unchanged
    // a disclaimer inside a QUESTION launders nothing beside it
    expect(findUnreadProductionStateClaims('Not read this turn? GLM-5.3 is deployed on spark-2.', { ...NONE, ownerTurn: true })).toHaveLength(1);
  });

  it('the incident shape is still a hit on an owner turn; a past-tense "was fixed in PR 1888" is the history register (out of scope)', () => {
    expect(findUnreadProductionStateClaims('Yes — GLM-5.3 is deployed on spark-2 and the memory fix is live.', { ...NONE, ownerTurn: true })).toHaveLength(1);
    expect(findUnreadProductionStateClaims('Yes — the memory issue was fixed in PR 1888.', { ...NONE, ownerTurn: true })).toEqual([]);
  });
});
