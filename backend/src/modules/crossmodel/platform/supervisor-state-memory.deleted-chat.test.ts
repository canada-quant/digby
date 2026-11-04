/**
 * fs-durable-memory re-review (2026-10-23), item 2: an embed already queued on
 * the per-chat serializer (enqueueSupervisorStateEmbed /
 * enqueueSupervisorStateColdEmbed) can re-insert chat-scope supervisor_state
 * mirror rows AFTER deleteChat's memClear({type:'chat'}) — owner directive
 * text in digby_memory with no later deletion path. Each embed that wrote rows
 * now re-checks the chat; a chat confirmed gone has its chat scope cleared.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockChatFindUnique: jest.Mock = jest.fn();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { crossModelChat: { findUnique: (...a: any[]) => mockChatFindUnique(...a) } },
}));
jest.mock('./kpi-register.service', () => ({ __esModule: true, loadKpisForSupervisorChat: jest.fn(async () => []) }));

const mockMemListRefs: jest.Mock = jest.fn(async () => []);
const mockMemDeleteRefs: jest.Mock = jest.fn(async () => 0);
const mockMemStore: jest.Mock = jest.fn(async (_s: any, _src: any, items: any[]) => items.length);
const mockMemReplaceRef: jest.Mock = jest.fn(async (_s: any, _src: any, _ref: any, items: any[]) => items.length);
const mockMemClear: jest.Mock = jest.fn(async () => {});
jest.mock('../memory/unified-memory.service', () => ({
  __esModule: true,
  memReplaceRef: (...a: any[]) => mockMemReplaceRef(...a),
  memSearch: jest.fn(async () => []),
  memListRefs: (...a: any[]) => mockMemListRefs(...a),
  memDeleteRefs: (...a: any[]) => mockMemDeleteRefs(...a),
  memStore: (...a: any[]) => mockMemStore(...a),
  memClear: (...a: any[]) => mockMemClear(...a),
}));

import { enqueueSupervisorStateColdEmbed, enqueueSupervisorStateEmbed } from './supervisor-state-memory';
import type { SupervisorDirective, SupervisorStateDoc } from './supervisor-state.service';

const flush = () => new Promise((r) => setTimeout(r, 25));
let n = 0;
const docFor = (text: string): SupervisorStateDoc => ({
  directives: [{ id: `dir-${++n}`, text, at: '2026-10-22T10:00:00Z', status: 'open', origin: 'owner' } as SupervisorDirective],
  archived: [], dispatches: [], projects: [], notes: '', refutations: [], inflightPreemptAt: '',
});
const coldRow = (text: string): SupervisorDirective => ({ id: `cold-${++n}`, text, at: '2026-09-01T00:00:00Z', status: 'done', evidence: 'pr #1', archivedAt: '2026-10-01T00:00:00Z' } as SupervisorDirective);

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.SUPERVISOR_RECALL_DIFF_QUERY_DISABLED;
  delete process.env.SUPERVISOR_STATE_MEMORY_DISABLED;
  mockChatFindUnique.mockImplementation(async ({ where }: any) => ({ id: where.id }));
});
afterAll(() => { delete process.env.SUPERVISOR_RECALL_DIFF_QUERY_DISABLED; });

describe('a mirror write that lands after its chat was deleted is cleared', () => {
  it('per-row mirror: the chat is deleted while the embed inserts ⇒ the chat scope is cleared after the write', async () => {
    const CHAT = 'del-chat-rows-1';
    let gone = false;
    mockMemStore.mockImplementationOnce(async (_s: any, _src: any, items: any[]) => { gone = true; return items.length; }); // deleteChat (row + memClear) ran mid-insert
    mockChatFindUnique.mockImplementation(async ({ where }: any) => (gone ? null : { id: where.id }));
    enqueueSupervisorStateEmbed(CHAT, docFor('From now on keep the nightly digest under one page'));
    await flush();
    expect(mockMemStore).toHaveBeenCalled();
    expect(mockMemClear).toHaveBeenCalledWith({ type: 'chat', id: CHAT });
  });

  it('batch mirror (SUPERVISOR_RECALL_DIFF_QUERY_DISABLED=1): same', async () => {
    process.env.SUPERVISOR_RECALL_DIFF_QUERY_DISABLED = '1';
    const CHAT = 'del-chat-batch-1';
    mockChatFindUnique.mockResolvedValue(null);
    enqueueSupervisorStateEmbed(CHAT, docFor('Post the bench score with receipts before merging'));
    await flush();
    expect(mockMemReplaceRef).toHaveBeenCalled();
    expect(mockMemClear).toHaveBeenCalledWith({ type: 'chat', id: CHAT });
  });

  it('cold-archive mirror: same', async () => {
    const CHAT = 'del-chat-cold-1';
    mockChatFindUnique.mockResolvedValue(null);
    enqueueSupervisorStateColdEmbed(CHAT, [coldRow('Old closed owner order about the backup cadence')]);
    await flush();
    expect(mockMemStore).toHaveBeenCalled();
    expect(mockMemClear).toHaveBeenCalledWith({ type: 'chat', id: CHAT });
  });

  it('a live chat is never cleared', async () => {
    const CHAT = 'live-chat-1';
    enqueueSupervisorStateEmbed(CHAT, docFor('Keep the canary on the test account'));
    enqueueSupervisorStateColdEmbed(CHAT, [coldRow('Closed order kept cold')]);
    await flush();
    expect(mockMemStore).toHaveBeenCalledTimes(2);
    expect(mockMemClear).not.toHaveBeenCalled();
  });

  it('an unanswerable existence check clears nothing (fail-safe)', async () => {
    const CHAT = 'unknown-chat-1';
    mockChatFindUnique.mockRejectedValue(new Error('db down'));
    enqueueSupervisorStateEmbed(CHAT, docFor('Keep the bench lane paused on weekends'));
    await flush();
    expect(mockMemStore).toHaveBeenCalled();
    expect(mockMemClear).not.toHaveBeenCalled();
  });

  it('an embed that wrote nothing (hash-skipped repeat) does not even look the chat up', async () => {
    const CHAT = 'skip-chat-1';
    const d = docFor('Report the det-v2 score every morning');
    enqueueSupervisorStateEmbed(CHAT, d);
    await flush();
    mockChatFindUnique.mockClear();
    enqueueSupervisorStateEmbed(CHAT, d);
    await flush();
    expect(mockChatFindUnique).not.toHaveBeenCalled();
  });
});
