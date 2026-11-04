/**
 * Stranded-steer recovery (tickets 58790b7b / 6a99225c) — unit tests.
 * The helper drains the Redis steer mailbox and queues the drained content as
 * ONE machine-origin follow-up run; any failure after the destructive drain
 * must re-push the batch (content never lost), and nothing may ever throw
 * into a caller's finalize/sweep path.
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
  // The helper instanceof-checks this exact class for the expected busy race.
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

import logger from '../../../utils/logger';
import { recoverStrandedSteers } from './steer-recovery';
import { SessionBusyError } from './run-state';

const DRAINED = { text: 'did you get this', images: [{ b64: 'img' }], files: [{ name: 'f.txt' }] };

beforeEach(() => {
  jest.clearAllMocks();
  mockDrain.mockResolvedValue(null);
  mockFindUniqueChat.mockResolvedValue({ userId: 'u1' });
  mockQueueAgentRun.mockResolvedValue('run-new');
});

describe('recoverStrandedSteers', () => {
  it('empty mailbox → no-op: no chat lookup, no run queued', async () => {
    expect(await recoverStrandedSteers('s1', 'run-finalize')).toBe(false);
    expect(mockFindUniqueChat).not.toHaveBeenCalled();
    expect(mockQueueAgentRun).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('whitespace-only drained text → no-op', async () => {
    mockDrain.mockResolvedValue({ text: '  \n ', images: [], files: [] });
    expect(await recoverStrandedSteers('s1', 'orphan-heal')).toBe(false);
    expect(mockQueueAgentRun).not.toHaveBeenCalled();
  });

  it('review F1: attachment-ONLY steer (blank text + images) is queued, NEVER dropped — the LPOP already destroyed the mailbox copy', async () => {
    const onlyImages = { text: '', images: [{ b64: 'img' }], files: [] };
    mockDrain.mockResolvedValue(onlyImages);
    expect(await recoverStrandedSteers('s1', 'run-finalize')).toBe(true);
    expect(mockQueueAgentRun).toHaveBeenCalledTimes(1);
    expect(mockQueueAgentRun).toHaveBeenCalledWith('s1', {
      message: '',
      images: onlyImages.images,
      files: [],
      userId: 'u1',
      origin: 'schedule',
    });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('review F1: files-only steer (blank text + files) is queued too', async () => {
    const onlyFiles = { text: '', images: [], files: [{ name: 'a.csv' }] };
    mockDrain.mockResolvedValue(onlyFiles);
    expect(await recoverStrandedSteers('s1', 'orphan-heal')).toBe(true);
    expect(mockQueueAgentRun).toHaveBeenCalledWith('s1', expect.objectContaining({ message: '', files: onlyFiles.files }));
  });

  it('drain throw (Redis hiccup) → no-op, never throws', async () => {
    mockDrain.mockRejectedValue(new Error('redis down'));
    expect(await recoverStrandedSteers('s1', 'orphan-heal')).toBe(false);
    expect(mockQueueAgentRun).not.toHaveBeenCalled();
  });

  it('happy path: queues ONE machine-origin run carrying the drained content VERBATIM, unanchored', async () => {
    mockDrain.mockResolvedValue(DRAINED);
    expect(await recoverStrandedSteers('s1', 'run-finalize')).toBe(true);
    expect(mockQueueAgentRun).toHaveBeenCalledTimes(1);
    expect(mockQueueAgentRun).toHaveBeenCalledWith('s1', {
      message: 'did you get this',
      images: DRAINED.images,
      files: DRAINED.files,
      userId: 'u1',
      origin: 'schedule',
    });
    // UNANCHORED: typed during another run — must never launder into a
    // user-anchored turn (pending-confirmation doctrine of drainChatQueue).
    const input = mockQueueAgentRun.mock.calls[0][1];
    expect('userTurnAt' in input).toBe(false);
    expect(mockPush).not.toHaveBeenCalled(); // nothing to restore on success
  });

  it('chat row missing → restores the drained batch to the mailbox, queues nothing', async () => {
    mockDrain.mockResolvedValue(DRAINED);
    mockFindUniqueChat.mockResolvedValue(null);
    expect(await recoverStrandedSteers('s1', 'orphan-heal')).toBe(false);
    expect(mockQueueAgentRun).not.toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('s1', { text: DRAINED.text, images: DRAINED.images, files: DRAINED.files });
  });

  it('busy-gate race (SessionBusyError) → restores the batch, returns false, does NOT warn (expected race)', async () => {
    mockDrain.mockResolvedValue(DRAINED);
    mockQueueAgentRun.mockRejectedValue(new SessionBusyError());
    expect(await recoverStrandedSteers('s1', 'run-finalize')).toBe(false);
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  // audit 2026-10-08 W2-9: the merged restore keeps a SHARED sender origin; a mixed batch restores unmarked.
  it('restore keeps the origin when every drained steer shares one; a mixed batch restores unmarked', async () => {
    mockDrain.mockResolvedValue({ ...DRAINED, messageIds: [], entries: [
      { text: 'a', origin: 'agent', sourceChatId: 'sup-1' }, { text: 'b', origin: 'agent', sourceChatId: 'sup-1' },
    ] });
    mockFindUniqueChat.mockResolvedValue(null);
    await recoverStrandedSteers('s1', 'orphan-heal');
    expect(mockPush).toHaveBeenCalledWith('s1', { text: DRAINED.text, images: DRAINED.images, files: DRAINED.files, origin: 'agent', sourceChatId: 'sup-1' });
    mockPush.mockClear();
    mockDrain.mockResolvedValue({ ...DRAINED, messageIds: [], entries: [{ text: 'a', origin: 'agent' }, { text: 'b' }] });
    await recoverStrandedSteers('s1', 'orphan-heal');
    expect(mockPush).toHaveBeenCalledWith('s1', { text: DRAINED.text, images: DRAINED.images, files: DRAINED.files });
  });

  it('unexpected queue failure → restores the batch, returns false, warns (content never lost)', async () => {
    mockDrain.mockResolvedValue(DRAINED);
    mockQueueAgentRun.mockRejectedValue(new Error('db exploded'));
    expect(await recoverStrandedSteers('s1', 'orphan-heal')).toBe(false);
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
