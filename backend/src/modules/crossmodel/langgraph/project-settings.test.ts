/**
 * ProjectSettings defaults — pins the crossProjectMemory DEFAULT-ON semantics
 * (owner directive 2026-09-08): unset parses as TRUE (the 2026-08-13
 * account-wide blend had already made blending always-on; the default now
 * matches reality), and only an EXPLICIT false isolates a folder (chat-context
 * withholds the userId blend key from retrieveChunks). A regression back to
 * `!!v.crossProjectMemory` would silently flip every never-touched folder to
 * "isolated" in the UI while the retrieval default stayed blended — the exact
 * dishonest-toggle state this change removed.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../context.service', () => ({
  __esModule: true,
  default: {},
  capHistoryToCharBudget: jest.fn(),
  MACHINE_WAKE_HISTORY_CHAR_BUDGET: 0,
  MACHINE_WAKE_MAX_PAIRS: 0,
}));
jest.mock('../../../utils/utility-llm', () => ({ utilityChat: jest.fn() }));
jest.mock('../memory/unified-memory.service', () => ({ memStore: {} }));
// Env-heavy transitive imports (user-facts → config/redis → config/env exits
// the process without env vars — see .digby/notes/learnings.md).
jest.mock('../memory/user-facts.service', () => ({
  selectRelevantFacts: jest.fn(),
  syncUserFactRows: jest.fn(),
}));
jest.mock('../memory/episodic.service', () => ({ buildEpisodicBlock: jest.fn() }));
jest.mock('../memory-relevance', () => ({
  filterFactsByRelevance: jest.fn(),
  isTextRelevantToMessage: jest.fn(),
}));

const mockStoreGet: jest.Mock = jest.fn();
const mockStorePut: jest.Mock = jest.fn();
jest.mock('../memory/context-store', () => ({
  storeGet: (...a: any[]) => mockStoreGet(...a),
  storePut: (...a: any[]) => mockStorePut(...a),
}));

const mockMergedRead: jest.Mock = jest.fn();
jest.mock('../platform/folder-inheritance', () => ({
  getMergedProjectStoreState: (...a: any[]) => mockMergedRead(...a),
}));

import { getProjectSettings, setProjectSettings } from './memory.graph';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getProjectSettings — crossProjectMemory default-on (owner 2026-09-08)', () => {
  it('UNSET parses as true (default-on)', async () => {
    mockMergedRead.mockResolvedValue({});
    const s = await getProjectSettings('p1');
    expect(s.crossProjectMemory).toBe(true);
  });

  it('no stored row at all → true', async () => {
    mockMergedRead.mockResolvedValue(null);
    const s = await getProjectSettings('p1');
    expect(s.crossProjectMemory).toBe(true);
  });

  it('explicit false stays false (the real opt-out)', async () => {
    mockMergedRead.mockResolvedValue({ crossProjectMemory: false });
    const s = await getProjectSettings('p1');
    expect(s.crossProjectMemory).toBe(false);
  });

  it('explicit true stays true', async () => {
    mockMergedRead.mockResolvedValue({ crossProjectMemory: true });
    const s = await getProjectSettings('p1');
    expect(s.crossProjectMemory).toBe(true);
  });

  it('store failure falls back to the default (true)', async () => {
    mockMergedRead.mockRejectedValue(new Error('store down'));
    const s = await getProjectSettings('p1');
    expect(s.crossProjectMemory).toBe(true);
  });
});

describe('setProjectSettings — leaf read keeps the same parse', () => {
  it('patching an untouched leaf preserves default-on', async () => {
    mockStoreGet.mockResolvedValue({});
    mockStorePut.mockResolvedValue(undefined);
    const s = await setProjectSettings('p1', {});
    expect(s.crossProjectMemory).toBe(true);
  });

  it('an explicit false opt-out survives an unrelated patch', async () => {
    mockStoreGet.mockResolvedValue({ crossProjectMemory: false });
    mockStorePut.mockResolvedValue(undefined);
    const s = await setProjectSettings('p1', { codingModel: 'glm-5.3' });
    expect(s.crossProjectMemory).toBe(false);
  });
});
