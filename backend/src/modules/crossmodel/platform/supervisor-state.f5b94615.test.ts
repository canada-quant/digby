/**
 * Ticket f5b94615 (mishap, 2026-09-15) — REPLAY TEST.
 *
 * Incident: a project supervisor's machine-wake note (chat 9e6e1712,
 * 2026-09-15 08:02Z) closed with
 *   "ACTIONS TAKEN - send_chat_message → d24c4c9b (receipt): Fleet delta —
 *    Arm A 8→13/30, 11/13 @07:44Z; DF2-watch 14/30 NEG @07:57Z;
 *    kernel-opt+repo-mgmt dark; zero gates"
 * while its run journal held ZERO consequential actions. The pre-delivery
 * guard (guardMachineWakeFinalAnswer) struck and replaced the note — the
 * containment worked; the mishap is that the model composed the claim at all.
 *
 * Mechanism (three confusion channels, all fed by HISTORY presented as
 * receipt-shaped fact):
 *   1. The injected [SUPERVISOR STATE] block rendered its RECENT DISPATCHES
 *      ledger — up to 30 prior-wake dispatch ids — in the EXACT 'kind → id'
 *      shape the wake-close contract demands for this-wake ACTIONS TAKEN,
 *      with no historical marker (the refutations section had one; dispatches
 *      did not).
 *   2. The update_supervisor_state ack echoed 'dispatch recorded: kind → id'
 *      back as a THIS-wake tool result — superficially satisfying machine-wake
 *      rule 6 ("receipt ids from send/schedule/update/cancel calls") without
 *      any execution.
 *   3. The wake-close contract demanded "a receipt id (8-char prefix)" without
 *      naming history (the state ledger, prior notes) as a forbidden source.
 *
 * Fix (this file pins all three layers plus the deterministic guard replay):
 *   1. RECENT_DISPATCHES_HEADER marks the ledger HISTORICAL at injection;
 *   2. the ack is reworded as a HISTORY record with no arrow idiom;
 *   3. wakeCloseContract names the ledger / prior notes as forbidden id
 *      sources and the ack as a non-receipt.
 *
 * The guard conviction itself is replayed deterministically in test 4 (empty
 * journal + id in no exoneration store ⇒ phantom), and test 5 documents the
 * designed counter-lane: a citation whose id IS in the pre-run ledger is an
 * exonerated restatement — which is why the durable fix lives upstream of the
 * guard, in what the model is shown.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  supervisorState: { findUnique: jest.fn(), upsert: jest.fn() },
  crossModelChat: { findUnique: jest.fn() },
  projectTodo: { findMany: jest.fn(async () => []) },
  codingSchedule: { findMany: jest.fn(async () => []) },
  ownerQuestion: { findMany: jest.fn(async () => []) },
  agentRun: { groupBy: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
// action-verifier's heavy boundaries (same mock set its own suite uses to load).
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: jest.fn(async () => '') }));
jest.mock('../coding/run-receipts.service', () => ({ __esModule: true, getRecentChatReceipts: jest.fn(async () => []) }));

import {
  formatStateForWake,
  applyStateUpdate,
  RECENT_DISPATCHES_HEADER,
  SupervisorStateDoc,
} from './supervisor-state.service';
import { coreWakeCloseContract } from './core-doctrine';
import { findPhantomClaims, mineReceiptIdiomClaims } from './action-verifier';

const CHAT = 'proj-sup-9e6e1712';
const UID = 'u1';
const NOW = new Date('2026-09-15T08:02:00.000Z');
const never = async () => false;

/** The exact prior-wake dispatch the incident note re-cited. */
const INCIDENT_DISPATCH = {
  at: '2026-09-15T07:41:03.000Z',
  kind: 'send_chat_message',
  id: 'd24c4c9b-1a2b-4c3d-8e9f-0a1b2c3d4e5f',
  note: 'Fleet delta — Arm A 8→13/30, 11/13 @07:44Z; DF2-watch 14/30 NEG @07:57Z; kernel-opt+repo-mgmt dark; zero gates',
};

let table: Map<string, unknown>;
const stored = (): any => table.get(CHAT) ?? { directives: [], dispatches: [], projects: [], notes: '', refutations: [] };

beforeEach(() => {
  jest.clearAllMocks();
  table = new Map();
  mockPrisma.supervisorState.findUnique.mockImplementation(async ({ where }: any) =>
    table.has(where.chatId) ? { state: table.get(where.chatId) } : null);
  mockPrisma.supervisorState.upsert.mockImplementation(async ({ where, create, update }: any) => {
    table.set(where.chatId, table.has(where.chatId) ? update.state : create.state);
    return { state: table.get(where.chatId) };
  });
});

describe('ticket f5b94615 — supervisor phantom send_chat_message → d24c4c9b (chat 9e6e1712)', () => {
  it('layer 1: the injected dispatch ledger is explicitly marked HISTORICAL — the incident id cannot read as a this-wake receipt', () => {
    const doc: SupervisorStateDoc = {
      directives: [],
      archived: [], dispatches: [INCIDENT_DISPATCH],
      projects: [],
      refutations: [],
      notes: '',
      inflightPreemptAt: '',
    };
    const block = formatStateForWake(doc, NOW);
    expect(block).toContain(RECENT_DISPATCHES_HEADER);
    expect(block).toMatch(/HISTORICAL LEDGER — these actions ran on PRIOR wakes, NOT this one/);
    expect(block).toMatch(/never re-cite these ids as ACTIONS TAKEN or this-wake receipts/);
    // The ledger DATA survives — history is legitimate memory; only the framing changed.
    expect(block).toContain('d24c4c9b-1a2b-4c3d-8e9f-0a1b2c3d4e5f');
  });

  it('layer 2: the update_supervisor_state dispatch ack is a HISTORY record, never an execution-receipt echo', async () => {
    const r = await applyStateUpdate(CHAT, UID, {
      dispatches: [{ kind: 'send_chat_message', id: INCIDENT_DISPATCH.id }],
    });
    const ack = r.applied.join(' ');
    expect(ack).toContain('dispatch ledger updated: send_chat_message d24c4c9b');
    expect(ack).toContain('HISTORY record');
    expect(ack).toContain('NOT evidence it ran this wake');
    expect(ack).not.toContain('→'); // the execution-receipt arrow idiom is gone from the ack
    expect(stored().dispatches).toHaveLength(1); // the ledger entry itself is still recorded
    expect(stored().dispatches[0].id).toBe(INCIDENT_DISPATCH.id);
  });

  it('layer 3: the wake-close contract names history as a forbidden id source for ACTIONS TAKEN', () => {
    // build 2026-10-08 S-2: pinned on the layered contract prod sends (the dated
    // supervisor-doctrine wakeCloseContract died with the pre-layering builders).
    const c = coreWakeCloseContract('in New Hampshire');
    expect(c).toContain('copied from a tool result THIS wake');
    expect(c).toContain('[SUPERVISOR STATE] ledger');
    expect(c).toContain('is HISTORY and re-citing it is struck as a phantom');
    expect(c).toContain('ack is a HISTORY record');
    expect(c).toContain('not an execution receipt');
  });

  it('layer 4 (guard replay): the incident citation with ZERO executed actions convicts as a phantom', async () => {
    // The deterministic receipt-idiom lane — first-person form of the incident
    // claim (the ACTIONS TAKEN shape goes through the LLM extractor, whose
    // guard-lane coverage lives in action-verifier.test.ts).
    const note =
      'I sent the Fleet delta message to the Fleet Supervisor — send_chat_message → receipt d24c4c9b: ' +
      'Arm A 8→13/30, 11/13 @07:44Z; DF2-watch 14/30 NEG @07:57Z; kernel-opt+repo-mgmt dark; zero gates';
    const claims = mineReceiptIdiomClaims(note);
    expect(claims).toHaveLength(1);
    expect(claims[0].kind).toBe('message');
    expect(claims[0].id).toBe('d24c4c9b');
    // The incident shape exactly: empty executed pool, id in NO exoneration
    // store (not the pre-run ledger; message-kind artifact check is hard-false
    // by design — reviewed C5; no cross-wake receipt) ⇒ convicted.
    const phantoms = await findPhantomClaims(claims, [], never, []);
    expect(phantoms).toEqual(claims);
  });

  it('counter-lane (designed): the same citation with the id in the PRE-RUN ledger is an exonerated restatement — hence the upstream fix', async () => {
    const note =
      'I sent the Fleet delta message to the Fleet Supervisor — send_chat_message → receipt d24c4c9b: ' +
      'Arm A 8→13/30, 11/13 @07:44Z; DF2-watch 14/30 NEG @07:57Z; kernel-opt+repo-mgmt dark; zero gates';
    const claims = mineReceiptIdiomClaims(note);
    // A prior-run ledger entry (the ae7db80b pre-run filter keeps only entries
    // stamped before this run started) exonerates a truthful restatement —
    // the guard deliberately does NOT strike honest history. The mishap fix
    // therefore lives in what the model is SHOWN (layers 1-3), not in a
    // harsher guard.
    const phantoms = await findPhantomClaims(claims, [], never, [INCIDENT_DISPATCH.id]);
    expect(phantoms).toEqual([]);
  });
});
