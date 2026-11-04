/**
 * audit 2026-10-06 T1-5 — session-scope memory store DEDUPE.
 *
 * The same tool result was offloaded to session memory again and again
 * (config.yaml 8× in one litellm lane run; 2,386 rows evicted from one session
 * at the 6000-row ceiling; ~97 % of offloaded rows evicted unread fleet-wide).
 * A chunk whose exact text already sits in THIS session under the same
 * (source, ref) is now skipped — counted as stored (it IS in memory), never
 * re-embedded. The lookup is read at write time, so a row the cap already
 * evicted is stored again; within-batch repeats collapse; project / user
 * scopes are untouched; a lookup error fails open; the kill switch restores
 * the plain insert.
 */
import * as crypto from 'crypto';

const mockQuery: jest.Mock = jest.fn(async () => []);
const mockExec: jest.Mock = jest.fn(async () => 0);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { $executeRawUnsafe: (...a: any[]) => mockExec(...a), $queryRawUnsafe: (...a: any[]) => mockQuery(...a) },
}));
const mockEmbed: jest.Mock = jest.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]));
jest.mock('../rag.service', () => ({
  __esModule: true,
  embedTexts: (...a: any[]) => mockEmbed(...a),
  rerankTexts: jest.fn(async () => []),
}));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { MEMORY_SCOPE_EVICTED: 'memory_scope_evicted', MEMORY_STORE_DEDUPED: 'memory_store_deduped' },
}));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { memStore } from './unified-memory.service';

const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex');
const BODY = `config.yaml model_list ${'y'.repeat(300)}`;
const dedupeQueries = () => mockQuery.mock.calls.filter(([sql]: [string]) => typeof sql === 'string' && sql.includes('md5(content)'));
const inserts = () => mockExec.mock.calls.filter(([sql]: [string]) => typeof sql === 'string' && sql.startsWith('INSERT INTO digby_memory'));
const flush = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockImplementation(async () => []);
  delete process.env.MEMORY_SESSION_DEDUPE_DISABLED;
});

describe('memStore — session-scope dedupe (audit 2026-10-06 T1-5)', () => {
  it('a chunk already stored under the same (source, ref) is skipped, counted as stored, never re-embedded', async () => {
    mockQuery.mockImplementation(async (sql: string) => (String(sql).includes('md5(content)') ? [{ ref: 'read_file: config/config.yaml', h: md5(BODY) }] : []));
    const n = await memStore({ type: 'session', id: 's1' }, 'orchestrator', [{ ref: 'read_file: config/config.yaml', content: BODY }]);
    expect(n).toBe(1);                 // the content IS in memory — the caller's "stored" marker stays true
    expect(mockEmbed).not.toHaveBeenCalled();
    expect(inserts()).toHaveLength(0);
    const [q] = dedupeQueries();
    expect(q.slice(1)).toEqual(['session', 's1', 'orchestrator', ['read_file: config/config.yaml']]);
    await flush();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'memory_store_deduped', sessionId: 's1', value: 1, meta: { source: 'orchestrator', deduped: 1, written: 0 } }));
  });

  it('new content is written; a within-batch repeat collapses; the result counts written + deduped', async () => {
    const n = await memStore({ type: 'session', id: 's2' }, 'compaction', [
      { ref: 'r', content: BODY }, { ref: 'r', content: BODY }, { ref: 'r', content: `${BODY} changed` },
    ]);
    expect(n).toBe(3);
    expect(inserts()).toHaveLength(1);
    expect(mockEmbed.mock.calls[0][0]).toHaveLength(2); // only the 2 distinct chunks embedded
  });

  it('the same text under a DIFFERENT ref is not a duplicate (the ref is part of the key)', async () => {
    mockQuery.mockImplementation(async () => [{ ref: 'other', h: md5(BODY) }]);
    await memStore({ type: 'session', id: 's3' }, 'orchestrator', [{ ref: 'read_file: a', content: BODY }]);
    expect(inserts()).toHaveLength(1);
  });

  it('project and user scopes are never deduped (no lookup)', async () => {
    await memStore({ type: 'project', id: 'p1' }, 'learning', [{ ref: 'r', content: BODY }]);
    await memStore({ type: 'user', id: 'u1' }, 'conversation', [{ ref: 'r', content: BODY }]);
    expect(dedupeQueries()).toHaveLength(0);
    expect(inserts()).toHaveLength(2);
  });

  it('a failing lookup fails OPEN (stored as before)', async () => {
    mockQuery.mockImplementation(async () => { throw new Error('db hiccup'); });
    expect(await memStore({ type: 'session', id: 's4' }, 'orchestrator', [{ ref: 'r', content: BODY }])).toBe(1);
    expect(inserts()).toHaveLength(1);
  });

  it('kill switch MEMORY_SESSION_DEDUPE_DISABLED=1: no lookup, every chunk stored', async () => {
    process.env.MEMORY_SESSION_DEDUPE_DISABLED = '1';
    mockQuery.mockImplementation(async () => [{ ref: 'r', h: md5(BODY) }]);
    expect(await memStore({ type: 'session', id: 's5' }, 'orchestrator', [{ ref: 'r', content: BODY }, { ref: 'r', content: BODY }])).toBe(2);
    expect(dedupeQueries()).toHaveLength(0);
    expect(inserts()).toHaveLength(1);
    expect(mockEmbed.mock.calls[0][0]).toHaveLength(2);
  });
});
