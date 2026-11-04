/**
 * REPLAY PIN — ticket 2580b092-937b-4d42-ba11-9434f0391685 (mishap,
 * agent-filed 2026-10-16T05:57Z by the action-verifier): "Supervisor phantom
 * claim: narrated action(s) never executed (chat 41bd202a)".
 *
 * THE INCIDENT (all evidence first-hand in this lane's investigation):
 * the Schooltime PROJECT supervisor (chat 41bd202a) posted its 05:57Z note
 * (msg e84f5e05) answering the owner's SA-key upload. The note's
 * "Meanwhile" paragraph narrates the project's two REAL worker lanes'
 * status in the PRESENT PROGRESSIVE:
 *
 *   · "the Gmail SMTP recovery-email wiring is running on the app lane"
 *   · "the decrypt lane is building your batch-decrypt proposal"
 *
 * Both threads were REAL and genuinely mid-flight: the app lane (1c2b28d6's
 * SMTP leg) had just closed todo 746aa1c5 with full evidence (todo row
 * done at 05:56:05Z — one minute BEFORE this note), and the decrypt lane
 * (0037460b) was mid batch-build (its reports through 07:26Z show the
 * 100-play batch and a measured 130.4 clips/hr pilot). The supervisor
 * executed ZERO claim-kind actions that run (its receipts are goal/todo/
 * board reads — "Executed consequential actions this run: NONE"), which is
 * exactly right: it was REPORTING other lanes' work, not claiming its own.
 * The extractor mislabeled both lines [dispatch]; the id-less claims then
 * convicted on the empty execution pool (step-4 same-kind slot accounting),
 * and the verifier struck the honest note + auto-filed this mishap ticket.
 *
 * THE ROOT CAUSE: the bbd8521e third-party-attribution register (merged
 * 2026-10-15 23:11 PDT — fourteen minutes AFTER this ticket was filed)
 * covers four frames — attributive participle, agent-location (past
 * verbs), status copula (id-anchored), firing-status — none of which
 * matches a PRESENT-PROGRESSIVE lane status: no participle-before-agent-
 * noun ("the decrypt lane is building", not "the dispatched lane"), frame
 * (b)'s verb list is past-tense delivery verbs ("running" is absent), and
 * frame (c) requires an id. The gap is empirically confirmed: pre-fix,
 * isThirdPartyAttributionDetail returned false on BOTH incident details.
 *
 * THE FIX: frame (e) PROGRESSIVE LANE STATUS — two sub-shapes (agent-
 * subject "the decrypt lane is building …", agent-location "the wiring is
 * running on the app lane") appended to the register with three extra
 * actor guards of their own (first-person progressive, embedded actor,
 * elided-actor completed action) because present-progressive prose is
 * where an honest first-person actor lives. Fail toward MISS (the
 * 587e9d64 doctrine); kill switch unchanged
 * (ACTION_VERIFIER_THIRD_PARTY_GATE_DISABLED=1, switch-registry row 88).
 *
 * Mock discipline mirrors action-verifier.bbd8521e.test.ts.
 */
const CHAT = '41bd202a-7152-437e-bf4b-a097981692b1'; // the Schooltime project supervisor
const APP_LANE = '1c2b28d6-21fc-4fb4-9b3b-9f04cd3f7ec5'; // the SMTP/app lane (real chat)
const DECRYPT_LANE = '0037460b-d239-474e-bd32-5fe3ec52d820'; // the decrypt lane (real chat)

const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null) },
  chatCodingState: { findFirst: jest.fn(async () => null) },
  codingSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  userFeatureRequest: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  projectGoal: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  projectTodo: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  agentRun: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockUtilityChat = jest.fn(async () => '');
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: (...a: any[]) => (mockUtilityChat as any)(...a) }));

const mockFileFeedbackTicket = jest.fn(async (..._a: any[]) => ({ deduped: false, ticket: { id: 't-1' } }));
jest.mock('../feedback/feedback.service', () => ({
  __esModule: true,
  fileFeedbackTicket: (...a: any[]) => (mockFileFeedbackTicket as any)(...a),
}));

const mockAppendVerifierRefutation = jest.fn(async () => {});
const mockGetSupervisorState = jest.fn(async (): Promise<any> => ({ directives: [], dispatches: [], projects: [], notes: '', refutations: [] }));
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  appendVerifierRefutation: (...a: any[]) => (mockAppendVerifierRefutation as any)(...a),
  getSupervisorState: (...a: any[]) => (mockGetSupervisorState as any)(...a),
}));

const mockGetRecentChatReceipts: jest.Mock = jest.fn(async () => [] as any[]);
jest.mock('../coding/run-receipts.service', () => ({
  __esModule: true,
  getRecentChatReceipts: (...a: any[]) => (mockGetRecentChatReceipts as any)(...a),
}));

import {
  computePhantomClaims, isThirdPartyAttributionDetail, dropThirdPartyAttributionClaims,
  ExtractedClaim,
} from './action-verifier';
import type { ToolReceipt } from '../coding/run-receipts';

const flush = () => new Promise((r) => setImmediate(r));

// The supervisor's read-only receipts (verbatim shape from the incident
// run's receipt pull): board/goal/todo reads — ZERO claim-kind executions.
const READ_RECEIPTS: ToolReceipt[] = ['6ac4465c', '8642aeb0', 'be7218d2'].map((id) => ({
  id: `${id}-0000-4000-8000-000000000000`, chatId: CHAT, runId: null,
  tool: 'todo_get', ok: true, ids: { receiptId: `${id}-0000-4000-8000-000000000000` },
  inputHash: null, outputHash: null, createdAt: new Date(),
}));

// THE INCIDENT NOTE — msg e84f5e05's verbatim text (the 05:57Z note the
// verifier struck). The two "Meanwhile" lines are the adjudicated phantom
// claims; every other line is status/plan prose.
const INCIDENT_NOTE = `**That's the right key — the Drive watch is unblocked.** The file is the complete GCP service-account JSON for \`schooltime@polar-column-493616-c8.iam.gserviceaccount.com\` (project \`polar-column-493616-c8\`, key id \`51009aeea7ef…\`) — exactly the \`schooltime-watcher\` credential the Drive push watch was waiting on, and this time the **private_key is fully intact** (the card channel had stripped it; the file upload came through whole). Nothing further needed from you on this.

**Not done yet:** my first vault attempt didn't auto-lift the key — the secret-scanner reads *typed* message text, not file-upload content, so it reported "no credential found in this message." The background follow-through below retries the vault by pointing at this upload message directly, then dismisses the re-delivery card (oq_7a5f6c52), unblocks the Drive-watch todo (5cae138c), and hands lane 1c2b28d6 the go signal to place the key on rutherford-1, register the watch channel, and verify — its landing zone was already confirmed ready, so this is one short step. The result posts here automatically.

Meanwhile the other two threads are already moving: the Gmail SMTP recovery-email wiring is running on the app lane, and the decrypt lane is building your batch-decrypt proposal (play in emulator → pull decrypted media / capture keys at unwrap → measured clips/hour report).

Still working on this in the background — re-run storesecret SCHOOLTIMESAJSON with fromMessageId citing this file-upload message (find its id via getchatmessages); dismissownerquestion oq7a5f6c52 (owner delivered via upload); todoupdate 5cae138c to inprogress clearing the gate with progressNote "SA JSON delivered by owne. I will post the result here.`;

// The claims the LLM extractor emitted for the struck "Meanwhile" lines
// (the ticket's meta names them [dispatch], id-less): verbatim detail
// quotes, exactly the extraction the strike convicted.
const EXTRACTOR_SMTP_CLAIM: ExtractedClaim = {
  kind: 'dispatch',
  detail: 'the Gmail SMTP recovery-email wiring is running on the app lane',
  id: '',
};
const EXTRACTOR_DECRYPT_CLAIM: ExtractedClaim = {
  kind: 'dispatch',
  detail: 'the decrypt lane is building your batch-decrypt proposal',
  id: '',
};

const BASE_INPUT = (note: string) => ({
  chatId: CHAT, userId: 'u-1', finalText: note, parts: [] as any[],
  receipts: READ_RECEIPTS, runStartedAt: new Date(), machineTriggered: true,
  supervisor: true, supervisorScope: 'project' as const,
});

describe('ticket 2580b092 replay — present-progressive third-party lane status is not a this-run action claim', () => {
  afterEach(() => { delete process.env.ACTION_VERIFIER_THIRD_PARTY_GATE_DISABLED; });

  it('THE REGISTER (unit): the two adjudicated incident details match frame (e); near variants match', () => {
    // The adjudicated lines (the ticket's [dispatch] phantom claims).
    expect(isThirdPartyAttributionDetail(EXTRACTOR_SMTP_CLAIM.detail)).toBe(true);    // (e2) agent-location
    expect(isThirdPartyAttributionDetail(EXTRACTOR_DECRYPT_CLAIM.detail)).toBe(true); // (e1) agent-subject
    // Near variants of the same honest shape.
    expect(isThirdPartyAttributionDetail('the other two threads are already moving')).toBe(true);
    expect(isThirdPartyAttributionDetail('the spawned reviewer is verifying the diff')).toBe(true);
    expect(isThirdPartyAttributionDetail('the sweep is running on the fleet supervisor')).toBe(true);
    expect(isThirdPartyAttributionDetail('its batch build is running on the app lane')).toBe(true);
    expect(isThirdPartyAttributionDetail('the decrypt lane was already building the batch-decrypt proposal')).toBe(true);
    expect(isThirdPartyAttributionDetail('the **decrypt lane** is building the proposal')).toBe(true);
  });

  it('THE REGISTER (unit): first-person and laundering shapes NEVER match frame (e)', () => {
    // First-person progressive — the run's OWN ongoing work.
    expect(isThirdPartyAttributionDetail('I am building the batch-decrypt proposal now')).toBe(false);
    expect(isThirdPartyAttributionDetail('we are already moving on the SMTP wiring')).toBe(false);
    expect(isThirdPartyAttributionDetail('I was working on the decrypt lane')).toBe(false);
    // Possessive subject (lookbehind guard).
    expect(isThirdPartyAttributionDetail('my batch build is running on the app lane')).toBe(false);
    expect(isThirdPartyAttributionDetail('my batch decrypt proposal build is running on the app lane')).toBe(false);
    expect(isThirdPartyAttributionDetail('your batch-decrypt proposal is running on the app lane')).toBe(false);
    // Embedded first-person actor anchoring the progressive.
    expect(isThirdPartyAttributionDetail('the wiring I just deployed is running on the app lane')).toBe(false);
    expect(isThirdPartyAttributionDetail('the sweep I started yesterday is running on the lane')).toBe(false);
    // Elided-actor completed action riding a location phrase (ee212347 laundering).
    expect(isThirdPartyAttributionDetail('dispatched session c3d4e5f6-a7b8-4901-abcd-f01234567890 and it is now running on the lane')).toBe(false);
    expect(isThirdPartyAttributionDetail('started the SMTP wiring and it is running on the app lane')).toBe(false);
    expect(isThirdPartyAttributionDetail('sent the steer and it is running on the lane now')).toBe(false);
    // (review F1, sub-session 26fa56e8) Rare-synonym completed verbs in the
    // elided-actor shape must ride the SAME guard — the laundering window the
    // review found pre-hardening.
    expect(isThirdPartyAttributionDetail('I revived the session and it is running on the lane')).toBe(false);
    expect(isThirdPartyAttributionDetail('we reinstated the worker and it is running on the lane')).toBe(false);
    expect(isThirdPartyAttributionDetail('I rebooted the decrypt lane and it is running on the lane')).toBe(false);
    expect(isThirdPartyAttributionDetail('I resurrected the batch worker and it is running on the lane')).toBe(false);
    expect(isThirdPartyAttributionDetail('I re-created the session and it is running on the lane')).toBe(false);
    // (cross-family review F1, 2026-10-16) The restart-verb class — \b boundaries
    // mean "restarted" never matches the listed "started" — is the most common
    // supervisor vocabulary and was still open after the sub-session hardening.
    expect(isThirdPartyAttributionDetail('I restarted the session and it is running on the lane')).toBe(false);
    expect(isThirdPartyAttributionDetail('restarted the session and it is running on the lane')).toBe(false);
    expect(isThirdPartyAttributionDetail('I reopened the ticket lane and it is running on the lane')).toBe(false);
    expect(isThirdPartyAttributionDetail('I resumed the decrypt lane and it is running on the lane')).toBe(false);
    expect(isThirdPartyAttributionDetail('I reran the batch and it is running on the lane')).toBe(false);
    expect(isThirdPartyAttributionDetail('I respawned the worker and it is running on the lane')).toBe(false);
    // (cross-family review F3) A long possessive subject (>5 modifier words)
    // must not launder through the e2 lookbehind.
    expect(isThirdPartyAttributionDetail('my brand new decrypt batch proposal build is running on the app lane')).toBe(false);
    // Out of scope: no progressive agent status at all.
    expect(isThirdPartyAttributionDetail('the decrypt lane fires 06:35Z (sched 145a400b)')).toBe(false);
    expect(isThirdPartyAttributionDetail('the container is running on port 3000')).toBe(false);
  });

  it('THE REGISTER (unit): frames (a)–(d) still match their bbd8521e details (register is additive)', () => {
    expect(isThirdPartyAttributionDetail('the **dispatched lane 41fd09ed** is well ahead — read the verdict as it landed and pushed fix commits')).toBe(true);
    expect(isThirdPartyAttributionDetail('The deliverables Result (msg 07d94e8f, PR #1464) posted on the lane is acknowledged — not re-staged')).toBe(true);
    expect(isThirdPartyAttributionDetail('24541fb3 firing 10/24 (msg 8ea56b9e, 14:45Z): fix live, deploy green')).toBe(true);
    expect(isThirdPartyAttributionDetail('lane 41fd09ed is well ahead')).toBe(true);
    // bbd8521e's own first-person guard is untouched.
    expect(isThirdPartyAttributionDetail('I dispatched lane 41fd09ed to own the follow-up')).toBe(false);
  });

  it('THE REGISTER (unit): dropThirdPartyAttributionClaims splits kept/dropped exactly', () => {
    const genuine = { kind: 'message' as const, detail: 'I sent the delta to the Fleet Supervisor — receipt 7ee7540a', id: '7ee7540a' };
    const out = dropThirdPartyAttributionClaims([EXTRACTOR_SMTP_CLAIM, EXTRACTOR_DECRYPT_CLAIM, genuine]);
    expect(out.dropped).toEqual([EXTRACTOR_SMTP_CLAIM, EXTRACTOR_DECRYPT_CLAIM]);
    expect(out.kept).toEqual([genuine]);
  });

  it('THE REGISTER (unit): kill switch ACTION_VERIFIER_THIRD_PARTY_GATE_DISABLED=1 keeps everything', () => {
    process.env.ACTION_VERIFIER_THIRD_PARTY_GATE_DISABLED = '1';
    const out = dropThirdPartyAttributionClaims([EXTRACTOR_SMTP_CLAIM, EXTRACTOR_DECRYPT_CLAIM]);
    expect(out.kept).toEqual([EXTRACTOR_SMTP_CLAIM, EXTRACTOR_DECRYPT_CLAIM]);
    expect(out.dropped).toEqual([]);
  });

  it('THE MISHAP REPLAY (the 05:57Z note, chat 41bd202a): both extracted [dispatch] claims are DROPPED — phantoms empty', async () => {
    // Production truth: the narrated lanes are REAL chats created days earlier
    // (never ≤1h-fresh) — served so any DB probe exonerates on row existence,
    // exactly the incident environment.
    mockPrisma.crossModelChat.findFirst.mockImplementation(async (args: any) => {
      const s = JSON.stringify(args);
      if (s.includes('1c2b28d6')) return { id: APP_LANE, createdAt: new Date('2026-10-13T19:00:00Z') };
      if (s.includes('0037460b')) return { id: DECRYPT_LANE, createdAt: new Date('2026-10-14T02:00:00Z') };
      return null;
    });
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [EXTRACTOR_SMTP_CLAIM, EXTRACTOR_DECRYPT_CLAIM] }) as never);
    const comp = await computePhantomClaims(BASE_INPUT(INCIDENT_NOTE));
    await flush();
    expect(comp.phantoms).toEqual([]);
  });

  it('GUARD (no false acquit, first-person progressive): "I am building your batch-decrypt proposal now" with an invented id still convicts', async () => {
    const noteWithPhantom = INCIDENT_NOTE + '\n\nI am building your batch-decrypt proposal now — session deadbeef is mine.';
    const phantom: ExtractedClaim = {
      kind: 'dispatch',
      detail: 'I am building your batch-decrypt proposal now — session deadbeef is mine',
      id: 'deadbeef',
    };
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [phantom] }) as never);
    const comp = await computePhantomClaims(BASE_INPUT(noteWithPhantom));
    await flush();
    expect(comp.phantoms).toHaveLength(1);
    expect(String(comp.phantoms[0].id)).toBe('deadbeef');
  });

  it('GUARD (kill switch restores the pre-fix strike — the exact regression this ticket pins)', async () => {
    process.env.ACTION_VERIFIER_THIRD_PARTY_GATE_DISABLED = '1';
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [EXTRACTOR_DECRYPT_CLAIM] }) as never);
    const comp = await computePhantomClaims(BASE_INPUT(INCIDENT_NOTE));
    await flush();
    // Pre-fix behavior restored: the id-less [dispatch] claim convicts on the
    // empty execution pool (step-4 slot accounting).
    expect(comp.phantoms).toHaveLength(1);
    expect(comp.phantoms[0].detail).toBe(EXTRACTOR_DECRYPT_CLAIM.detail);
  });

  it('WIRING (args surface): a progressive third-party claim mined from tool-call ARGS is dropped too', async () => {
    // NOTE: the args blob must pass the keyword pre-gate (hasActionClaimKeywords)
    // — "dispatched" here is what a real narrator would write, and it keeps the
    // blob in the scanned set (a blob with NO scan keyword is never extracted,
    // which is also why this test's mock queue must hold exactly one response
    // per scanned surface).
    const parts: any[] = [
      { type: 'tool_call', name: 'send_chat_message', args: { chatId: DECRYPT_LANE, content: 'status check on the dispatched batch: the decrypt lane is building the batch-decrypt proposal; report the measured rate when it lands' } },
      { type: 'tool_result', result: '{"ok":true,"receiptId":"39ec5e80-1183-4393-bcd2-103e1fde8984"}' },
    ];
    mockUtilityChat
      .mockResolvedValueOnce(JSON.stringify({ claims: [] }) as never)                                                                                                                  // note surface: no claims
      .mockResolvedValueOnce(JSON.stringify({ claims: [{ kind: 'dispatch', detail: 'the decrypt lane is building the batch-decrypt proposal; report the measured rate when it lands', id: '' }] }) as never); // args surface: the third-party claim
    const comp = await computePhantomClaims({ ...BASE_INPUT(INCIDENT_NOTE), parts });
    await flush();
    expect(comp.phantoms).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DETECTOR-RECALL REPLAY (ticket 2580b092 detector change): frame (e) widens
// the third-party-attribution register, so this file replays the detector's
// PRIOR TRUE POSITIVES — the genuine-phantom convictions that adjudicated
// tickets 587e9d64, ee212347 (case 5) and bbd8521e (false-acquit guard)
// pinned, ALL of them progressive-adjacent ("… and it is running now")
// shapes frame (e) could plausibly have swallowed — and asserts they STILL
// convict end-to-end through computePhantomClaims.
// ─────────────────────────────────────────────────────────────────────────────
describe('DETECTOR-RECALL REPLAY — prior true positives still fire (2580b092 detector change)', () => {
  it('587e9d64 conviction: "I dispatched the nightly audit worker … — it is running now" (id-bearing, no row) still convicts', async () => {
    const note = 'Run closed. I dispatched the nightly audit worker (session deadbeef-1234-5678-9abc-def012345678) — it is running now.';
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: 'dispatched the nightly audit worker', id: 'deadbeef-1234-5678-9abc-def012345678' }],
    }) as never);
    const comp = await computePhantomClaims(BASE_INPUT(note));
    await flush();
    expect(comp.phantoms).toHaveLength(1);
    expect(String(comp.phantoms[0].id)).toBe('deadbeef-1234-5678-9abc-def012345678');
  });

  it('ee212347 case-5 conviction, hardened with a LOCATION phrase: "dispatched session <id> and it is now running on the lane" still convicts', async () => {
    const id = 'c3d4e5f6-a7b8-4901-abcd-f01234567890';
    const detail = `dispatched session ${id} and it is now running on the lane`;
    const note = `Status: ${detail}.`;
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [{ kind: 'dispatch', detail, id }] }) as never);
    const comp = await computePhantomClaims(BASE_INPUT(note));
    await flush();
    expect(comp.phantoms).toHaveLength(1);
    expect(String(comp.phantoms[0].id)).toBe(id);
  });

  it('bbd8521e false-acquit guard: "I dispatched lane deadbeef … and it is running now" still convicts', async () => {
    const detail = 'I dispatched lane deadbeef to own the follow-up and it is running now';
    const note = `**crossmodel 09:08Z — duplicate resolved.**\n\n${detail}.`;
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [{ kind: 'dispatch', detail, id: 'deadbeef' }] }) as never);
    const comp = await computePhantomClaims(BASE_INPUT(note));
    await flush();
    expect(comp.phantoms).toHaveLength(1);
    expect(String(comp.phantoms[0].id)).toBe('deadbeef');
  });

  it('e413c084/id-less conviction: "dispatched a worker for the backlog and it is running now" (elided actor, id-less) still convicts', async () => {
    const detail = 'dispatched a worker for the backlog and it is running now';
    const note = `Board sweep closed with the backlog item re-triaged. Status: ${detail}.`;
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [{ kind: 'dispatch', detail }] }) as never);
    const comp = await computePhantomClaims(BASE_INPUT(note));
    await flush();
    expect(comp.phantoms).toHaveLength(1);
    expect(comp.phantoms[0].detail).toBe(detail);
  });

  // DETECTOR-RECALL REPLAY (follow-up hardening PR): this PR widens
  // ELIDED_ACTOR_COMPLETED_ACTION_RE (restart-verb class) and the e2
  // possessive lookbehind ({0,5}→{0,12}) — the two surfaces the
  // "…and it is running [on the lane]" prior true positives ride. Replayed
  // here under the HARDENED guards, asserting they STILL convict
  // end-to-end: kept by the register (correct — first-person/elided actor),
  // then convicted by the tier chain on an invented id.
  it('DETECTOR-RECALL REPLAY (hardened guards): the restart-verb first-person phantom kept by the widened ELIDED list STILL convicts end-to-end', async () => {
    const id = 'deadbeef-1234-5678-9abc-def012345678';
    const detail = `I restarted the session and it is running on the lane (session ${id})`;
    const note = `Board sweep closed. ${detail}.`;
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [{ kind: 'dispatch', detail, id }] }) as never);
    const comp = await computePhantomClaims(BASE_INPUT(note));
    await flush();
    expect(comp.phantoms).toHaveLength(1);
    expect(String(comp.phantoms[0].id)).toBe(id);
  });

  it('DETECTOR-RECALL REPLAY (hardened guards): the long-possessive phantom excluded by the widened e2 lookbehind STILL convicts end-to-end', async () => {
    const id = 'c3d4e5f6-a7b8-4901-abcd-f01234567890';
    const detail = `my brand new decrypt batch proposal build is running on the app lane (session ${id})`;
    const note = `Status: ${detail}.`;
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [{ kind: 'dispatch', detail, id }] }) as never);
    const comp = await computePhantomClaims(BASE_INPUT(note));
    await flush();
    expect(comp.phantoms).toHaveLength(1);
    expect(String(comp.phantoms[0].id)).toBe(id);
  });

  it('DETECTOR-RECALL REPLAY (bbd8521e register): the three adjudicated bbd8521e mishap replays still come back clean (frames a–d intact)', async () => {
    // The bbd8521e false-positive details are still DROPPED — the register's
    // original frames are unchanged by the frame (e) addition.
    const bbdDetails = [
      'the **dispatched lane 41fd09ed** is well ahead — read the verdict as it landed and pushed fix commits for all three findings plus the aggravations',
      'The deliverables Result (msg 07d94e8f, PR #1464) posted on the lane is acknowledged — not re-staged',
      '24541fb3 firing 10/24 (msg 8ea56b9e, 14:45Z): fix live, deploy green, probe still shows the pre-fix token',
    ];
    for (const detail of bbdDetails) {
      expect(isThirdPartyAttributionDetail(detail)).toBe(true);
    }
  });
});
