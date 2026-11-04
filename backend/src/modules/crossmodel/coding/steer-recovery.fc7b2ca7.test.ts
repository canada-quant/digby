/**
 * Ticket fc7b2ca7 REPLAY — duplicate delivery of an agent-sent message into a
 * target chat transcript (sighting 1, 2026-09-15).
 *
 * THE SIGHTING (reconstructed from the target chat's transcript): the Fleet
 * Supervisor sent ONE triage note via send_chat_message to chat
 * b92ef13f-c3f8-487e-8267-767e56543150 while its DMG-watch run 633fcad4 was in
 * its FINALIZE window (the final answer was already in flight — the run never
 * hit another step-boundary steer drain, and its persisted final answer never
 * mentioned the note). The transcript then showed TWO byte-identical user rows:
 *   - msg 133f6923 (10:18:42Z) — the EAGER steer persist (steerActiveRun →
 *     pushSteerMessage + appendCodingMessage, transcript-honesty by design);
 *   - msg 4e9a91e8 (10:20:28Z) — 1.7 s after the run finalized: the stranded-
 *     steer recovery (recoverStrandedSteers 'run-finalize') drained the
 *     unconsumed mailbox entry and queued a follow-up run whose run-start input
 *     persist INSERTED THE SAME CONTENT A SECOND TIME.
 * The duplicate also woke the target lane for a redundant acknowledgment run.
 *
 * THE FIX: the eager persist's row id is PRE-GENERATED and rides the mailbox
 * payload (messageIds) → the recovery forwards it as
 * RunInput.existingUserMessageIds → the run-start input persist ADOPTS the
 * already-persisted row instead of inserting a duplicate (the executor leg is
 * pinned in run-executor.test.ts). These tests pin the recovery-level contract.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockFindUniqueChat: jest.Mock = jest.fn();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { crossModelChat: { findUnique: (...a: any[]) => mockFindUniqueChat(...a) } },
}));

const mockQueueAgentRun: jest.Mock = jest.fn();
jest.mock('./run-state', () => ({
  __esModule: true,
  queueAgentRun: (...a: any[]) => mockQueueAgentRun(...a),
  SessionBusyError: class SessionBusyError extends Error {
    readonly code = 'BUSY';
    constructor() {
      super('busy');
      this.name = 'SessionBusyError';
    }
  },
}));

const mockDrain: jest.Mock = jest.fn();
const mockPush: jest.Mock = jest.fn(async () => {});
jest.mock('./session-run-lock', () => ({
  __esModule: true,
  drainSteerMessages: (...a: any[]) => mockDrain(...a),
  pushSteerMessage: (...a: any[]) => mockPush(...a),
}));

import { recoverStrandedSteers } from './steer-recovery';

beforeEach(() => {
  jest.clearAllMocks();
  mockDrain.mockResolvedValue(null);
  mockFindUniqueChat.mockResolvedValue({ userId: 'u1' });
  mockQueueAgentRun.mockResolvedValue('run-new');
});

describe('ticket fc7b2ca7 — stranded-steer recovery carries the eager row id', () => {
  it('sighting-1 replay: drained messageIds ride queueAgentRun as existingUserMessageIds', async () => {
    // The mailbox entry the controller pushed for the triage note, carrying the
    // pre-generated id of the eager user row (msg 133f6923 in the sighting).
    mockDrain.mockResolvedValue({ text: 'triage note body', images: [], files: [], messageIds: ['133f6923-aaaa'] });
    expect(await recoverStrandedSteers('s1', 'run-finalize')).toBe(true);
    expect(mockQueueAgentRun).toHaveBeenCalledTimes(1);
    expect(mockQueueAgentRun).toHaveBeenCalledWith('s1', {
      message: 'triage note body',
      images: [],
      files: [],
      userId: 'u1',
      origin: 'schedule',
      existingUserMessageIds: ['133f6923-aaaa'],
    });
    expect(mockPush).not.toHaveBeenCalled(); // nothing to restore on success
  });

  it('multiple steered messages merged in one drain → ALL eager ids forwarded in order', async () => {
    mockDrain.mockResolvedValue({ text: 'first\n\nsecond', images: [], files: [], messageIds: ['m-1', 'm-2'] });
    expect(await recoverStrandedSteers('s1', 'orphan-heal')).toBe(true);
    expect(mockQueueAgentRun.mock.calls[0][1].existingUserMessageIds).toEqual(['m-1', 'm-2']);
  });

  it('legacy mailbox entry (no messageIds — pushed before this fix) → field omitted, old behavior preserved', async () => {
    mockDrain.mockResolvedValue({ text: 'old entry', images: [], files: [] });
    expect(await recoverStrandedSteers('s1', 'run-finalize')).toBe(true);
    const input = mockQueueAgentRun.mock.calls[0][1];
    expect('existingUserMessageIds' in input).toBe(false);
  });

  it('garbage messageIds entries are filtered — only non-empty strings survive', async () => {
    mockDrain.mockResolvedValue({ text: 'x', images: [], files: [], messageIds: ['ok-1', '', 7, null, undefined] });
    expect(await recoverStrandedSteers('s1', 'run-finalize')).toBe(true);
    expect(mockQueueAgentRun.mock.calls[0][1].existingUserMessageIds).toEqual(['ok-1']);
  });

  it('queue failure: the restore re-push PRESERVES messageIds (a later recovery still adopts, never duplicates)', async () => {
    mockDrain.mockResolvedValue({ text: 'triage note body', images: [], files: [], messageIds: ['133f6923-aaaa'] });
    mockQueueAgentRun.mockRejectedValue(new Error('db exploded'));
    expect(await recoverStrandedSteers('s1', 'run-finalize')).toBe(false);
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('s1', {
      text: 'triage note body',
      images: [],
      files: [],
      messageIds: ['133f6923-aaaa'],
    });
  });

  it('chat row missing: the restore re-push also preserves messageIds', async () => {
    mockDrain.mockResolvedValue({ text: 'triage note body', images: [], files: [], messageIds: ['133f6923-aaaa'] });
    mockFindUniqueChat.mockResolvedValue(null);
    expect(await recoverStrandedSteers('s1', 'orphan-heal')).toBe(false);
    expect(mockQueueAgentRun).not.toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith('s1', expect.objectContaining({ messageIds: ['133f6923-aaaa'] }));
  });
});
