/**
 * learnings-dream.ts — the SCHEDULED learnings dream works on the learnings INDEX (the cron box has no
 * worktree), sharing its clustering + merge with the file dream (dreamLearnings).
 *
 * End-to-end against the REAL syncLearningsIndex: an in-memory digby_memory (memReplaceRef + the
 * dream's read-only SELECT) and an in-memory context store, so the interplay is pinned — a merge writes
 * one `learning-dream:` row and deletes its members, the members stay in state.refs so a later sync never
 * re-adds them, and the merged row goes once every member has left the file.
 */

jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const mockStore = new Map<string, any>(); // `${namespacePath}::${key}` → value
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async (ns: string[], key: string) => { const v = mockStore.get(`${ns.join(':')}::${key}`); return v === undefined ? null : JSON.parse(JSON.stringify(v)); }),
  storePut: jest.fn(async (ns: string[], key: string, value: any) => { mockStore.set(`${ns.join(':')}::${key}`, JSON.parse(JSON.stringify(value))); }),
}));

interface Row { scopeType: string; scopeId: string; source: string; ref: string; content: string; seq: number }
let mockRows: Row[] = [];
let mockSeq = 0;
const mockFailStoreFor: { prefix: string | null } = { prefix: null };
jest.mock('../memory/unified-memory.service', () => ({
  __esModule: true,
  memReplaceRef: jest.fn(async (scope: { type: string; id: string }, source: string, ref: string, items: Array<{ content: string }>) => {
    mockRows = mockRows.filter(r => !(r.scopeType === scope.type && r.scopeId === scope.id && r.source === source && r.ref === ref));
    if (items.length && mockFailStoreFor.prefix && ref.startsWith(mockFailStoreFor.prefix)) return 0;
    for (const it of items) mockRows.push({ scopeType: scope.type, scopeId: scope.id, source, ref, content: it.content, seq: ++mockSeq });
    return items.length;
  }),
  memSearch: jest.fn(async () => []),
}));

const mockFindMany: jest.Mock = jest.fn(async ({ where }: any) => [...mockStore.entries()]
  .map(([k, value]) => { const i = k.lastIndexOf('::'); return { namespacePath: k.slice(0, i), key: k.slice(i + 2), value }; })
  .filter(r => r.key === where.key && r.namespacePath.endsWith(where.namespacePath.endsWith))
  .map(r => ({ namespacePath: r.namespacePath, value: JSON.parse(JSON.stringify(r.value)) })));
const mockQueryRaw: jest.Mock = jest.fn(async (_sql: string, projectId: string, source: string) => mockRows
  .filter(r => r.scopeType === 'project' && r.scopeId === projectId && r.source === source)
  .sort((a, b) => a.seq - b.seq)
  .map(r => ({ ref: r.ref, content: r.content })));
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { contextStoreEntry: { findMany: (...a: any[]) => mockFindMany(...a) }, $queryRawUnsafe: (...a: any[]) => mockQueryRaw(...a) },
}));

jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: jest.fn(async () => '') }));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { INDEX_SWEPT: 'index_swept' },
}));

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  runLearningsDreamCycle, nearDuplicateClusters, learningsDreamDue,
  LEARNINGS_DREAM_REF_PREFIX, LEARNINGS_DREAM_MIN_GAP_DAYS, MAX_MERGE_CLUSTERS, MAX_CLUSTER_SIZE,
} from './learnings-dream';
import { syncLearningsIndex, learningRef, normalizeEntry, LEARNINGS_REL_PATH } from './learnings-index.service';

const { utilityChat } = jest.requireMock('../../../utils/utility-llm');

const P = 'proj-1';
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const HEADER = '# Learned conventions (durable)\n\nOne line per durable discovery.';
const E = [
  '- Prisma migrations are hand-written via migrate diff; production runs migrate deploy.',
  '- Sonner toasts position through mobile-offset-top, never the spacing variable.',
  '- Playwright chromium needs dpkg-extracted libraries inside the container sandbox.',
  '- Backups ride the nightly systemd timer plus the S3 offsite bucket instance role.',
  '- Deploy health gates bind on the compose start-period, widen before blind retrying.',
  '- Heredoc terminators under Actions blocks demand matching indentation columns.',
];
const A = '- alpha bravo charlie delta echo foxtrot golf hotel india juliet convention';
const B = '- alpha bravo charlie delta echo foxtrot golf hotel india kilo convention';
const C = '- lima mike november oscar papa quebec romeo sierra tango uniform convention';
const D = '- lima mike november oscar papa quebec romeo sierra tango victor convention';
const M_AB = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo convention (merged)';
const M_CD = 'lima mike november oscar papa quebec romeo sierra tango uniform victor convention (merged)';
const ref = (bullet: string) => learningRef(normalizeEntry(bullet));
const mergedRef = (text: string) => `${LEARNINGS_DREAM_REF_PREFIX}${crypto.createHash('sha1').update(text).digest('hex')}`;
const state = () => mockStore.get(`${P}:learnings-index::state`);
const rowRefs = () => mockRows.filter(r => r.scopeId === P).map(r => r.ref);
const dreamRows = () => mockRecordLoopMetric.mock.calls.map(c => c[0]).filter(r => r.meta?.index === 'learnings_dream');

let root: string;
const writeFile = (...entries: string[]) => fs.writeFile(path.join(root, LEARNINGS_REL_PATH), `${HEADER}\n\n${entries.join('\n')}\n`, 'utf8');
const sync = () => syncLearningsIndex(P, root, { force: true, canonicalForTest: { kind: 'no-mirror' } });

beforeEach(async () => {
  mockStore.clear();
  mockRows = [];
  mockSeq = 0;
  mockFailStoreFor.prefix = null;
  jest.clearAllMocks();
  delete process.env.LEARNINGS_DREAM_DISABLED;
  (utilityChat as jest.Mock).mockResolvedValue('');
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'learnings-dream-'));
  await fs.mkdir(path.dirname(path.join(root, LEARNINGS_REL_PATH)), { recursive: true });
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('nearDuplicateClusters (shared with the file dream)', () => {
  test('groups near-duplicates, orders clusters by first member, bounds size and count', () => {
    expect(nearDuplicateClusters([E[0], A, E[1], B, C, D])).toEqual([[1, 3], [4, 5]]);
    expect(nearDuplicateClusters(E)).toEqual([]);
    const many = Array.from({ length: 6 }, (_, i) => `- shared tokens quartz zephyr ${'w'.repeat(4 + i)} convention`);
    expect(nearDuplicateClusters(many)[0]).toHaveLength(MAX_CLUSTER_SIZE);
    expect(MAX_MERGE_CLUSTERS).toBe(8);
  });

  test('learningsDreamDue: never-dreamt or ≥ the gap', () => {
    expect(learningsDreamDue({}, NOW)).toBe(true);
    expect(learningsDreamDue({ dreamAt: new Date(NOW - (LEARNINGS_DREAM_MIN_GAP_DAYS - 1) * DAY).toISOString() }, NOW)).toBe(false);
    expect(learningsDreamDue({ dreamAt: new Date(NOW - LEARNINGS_DREAM_MIN_GAP_DAYS * DAY).toISOString() }, NOW)).toBe(true);
    expect(learningsDreamDue({ dreamAt: 'garbage' }, NOW)).toBe(true);
  });
});

describe('runLearningsDreamCycle — the scheduled dream merges near-duplicates in the INDEX', () => {
  test('a near-dup cluster becomes ONE merged row; members deleted but kept in state.refs; state.merged + dreamAt recorded', async () => {
    await writeFile(...E, A, B);
    expect((await sync()).added).toBe(8);
    const before = state();
    (utilityChat as jest.Mock).mockResolvedValueOnce(JSON.stringify({ merged: [M_AB] }));

    expect(await runLearningsDreamCycle({ now: NOW })).toEqual({ projects: 1, clusters: 1, absorbed: 1 });

    const prompt = (utilityChat as jest.Mock).mock.calls[0][0][0].content;
    expect(prompt).toContain('GROUP 1');
    expect(prompt).toContain('india juliet');
    expect(prompt).toContain('india kilo');
    expect(rowRefs()).not.toContain(ref(A));
    expect(rowRefs()).not.toContain(ref(B));
    expect(mockRows.find(r => r.ref === mergedRef(M_AB))?.content).toBe(M_AB);
    expect(rowRefs()).toHaveLength(7);
    const s = state();
    expect(s.merged).toEqual({ [mergedRef(M_AB)]: [ref(A), ref(B)] });
    expect(s.refs[ref(A)]).toBe(true);
    expect(s.refs[ref(B)]).toBe(true);
    expect(s.dreamAt).toBe(new Date(NOW).toISOString());
    expect(s.fileHash).toBe(before.fileHash); // the sync's fields ride through untouched
    expect(s.gateVersion).toBe(before.gateVersion);
    expect(dreamRows()).toHaveLength(1);
    expect(dreamRows()[0]).toMatchObject({ kind: 'index_swept', value: 1, meta: { index: 'learnings_dream', projectId: P, entries: 8, merged: 1, absorbed: 1, outcome: 'merged' } });
  });

  test('a following sync never re-adds the members; the merged row goes only once EVERY member left the file', async () => {
    await writeFile(...E, A, B);
    await sync();
    (utilityChat as jest.Mock).mockResolvedValueOnce(JSON.stringify({ merged: [M_AB] }));
    await runLearningsDreamCycle({ now: NOW });

    // A new entry changes the file: the sync adds ONLY it — A and B stay merged.
    const E7 = '- Redis lives on box A only; every other box reaches it on the private IP.';
    await writeFile(...E, A, B, E7);
    const r1 = await sync();
    expect(r1).toEqual({ added: 1, removed: 0, skipped: false });
    expect(rowRefs()).not.toContain(ref(A));
    expect(rowRefs()).not.toContain(ref(B));
    expect(rowRefs()).toContain(ref(E7));
    expect(state().merged).toEqual({ [mergedRef(M_AB)]: [ref(A), ref(B)] });
    expect(state().dreamAt).toBe(new Date(NOW).toISOString()); // the sync carries the dream's bookkeeping

    // One member leaves the file: swept, but the merged row stays (B remains).
    await writeFile(...E, B, E7);
    expect((await sync()).removed).toBe(1);
    expect(rowRefs()).toContain(mergedRef(M_AB));
    expect(state().merged).toEqual({ [mergedRef(M_AB)]: [ref(A), ref(B)] });

    // The last member leaves: the merged row is deleted and the group dropped.
    mockRecordLoopMetric.mockClear();
    await writeFile(...E, E7);
    expect((await sync()).removed).toBe(1);
    expect(rowRefs()).not.toContain(mergedRef(M_AB));
    expect(state().merged).toEqual({});
    const swept = mockRecordLoopMetric.mock.calls.map(c => c[0]).find(r => r.meta?.index === 'learnings');
    expect(swept.meta).toMatchObject({ removed: 1, mergedRemoved: 1 });
  });

  test('at most once per LEARNINGS_DREAM_MIN_GAP_DAYS per project', async () => {
    await writeFile(...E, A, B);
    await sync();
    (utilityChat as jest.Mock).mockResolvedValueOnce(JSON.stringify({ merged: [M_AB] }));
    await runLearningsDreamCycle({ now: NOW });
    (utilityChat as jest.Mock).mockClear();
    expect(await runLearningsDreamCycle({ now: NOW + DAY })).toEqual({ projects: 0, clusters: 0, absorbed: 0 });
    expect(utilityChat).not.toHaveBeenCalled();
    // A week later it runs again (nothing left to merge → no LLM call, dreamAt restamped).
    expect(await runLearningsDreamCycle({ now: NOW + 8 * DAY })).toEqual({ projects: 1, clusters: 0, absorbed: 0 });
    expect(utilityChat).not.toHaveBeenCalled();
    expect(state().dreamAt).toBe(new Date(NOW + 8 * DAY).toISOString());
  });

  test('guard: at most 30 % of the entries are absorbed per pass — the cluster that would exceed it waits', async () => {
    await writeFile(E[0], E[1], A, B, C, D); // 6 entries → at most 1 absorbed
    await sync();
    (utilityChat as jest.Mock).mockResolvedValueOnce(JSON.stringify({ merged: [M_AB, M_CD] }));
    expect(await runLearningsDreamCycle({ now: NOW })).toEqual({ projects: 1, clusters: 1, absorbed: 1 });
    expect(rowRefs()).toEqual(expect.arrayContaining([ref(C), ref(D), mergedRef(M_AB)]));
    expect(rowRefs()).not.toContain(mergedRef(M_CD));
    expect(dreamRows()[0].meta).toMatchObject({ merged: 1, guardSkipped: 1 });
  });

  test('a merged row that later clusters with a new near-dup hands over its members (groups stay flat)', async () => {
    await writeFile(...E, A, B);
    await sync();
    (utilityChat as jest.Mock).mockResolvedValueOnce(JSON.stringify({ merged: [M_AB] }));
    await runLearningsDreamCycle({ now: NOW });
    const A2 = '- alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima convention';
    await writeFile(...E, A, B, A2);
    await sync();
    const M2 = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima convention (merged twice)';
    (utilityChat as jest.Mock).mockResolvedValueOnce(JSON.stringify({ merged: [M2] }));
    expect(await runLearningsDreamCycle({ now: NOW + 8 * DAY })).toEqual({ projects: 1, clusters: 1, absorbed: 1 });
    expect(rowRefs()).not.toContain(mergedRef(M_AB));
    expect(rowRefs()).not.toContain(ref(A2));
    expect(state().merged).toEqual({ [mergedRef(M2)]: [ref(A), ref(B), ref(A2)] });
  });
});

describe('runLearningsDreamCycle — failures change nothing', () => {
  beforeEach(async () => { await writeFile(...E, A, B); await sync(); });

  test('LLM failure: rows and state untouched (dreamAt NOT stamped — the next cycle retries), an llm_error row', async () => {
    const before = state();
    (utilityChat as jest.Mock).mockRejectedValueOnce(new Error('provider down'));
    expect(await runLearningsDreamCycle({ now: NOW })).toEqual({ projects: 0, clusters: 0, absorbed: 0 });
    expect(state()).toEqual(before);
    expect(rowRefs()).toHaveLength(8);
    expect(dreamRows()[0].meta).toMatchObject({ outcome: 'llm_error' });
  });

  test('a garbage merge (too short, or longer than its members) keeps the originals', async () => {
    (utilityChat as jest.Mock).mockResolvedValueOnce(JSON.stringify({ merged: ['ok'] }));
    expect(await runLearningsDreamCycle({ now: NOW })).toEqual({ projects: 1, clusters: 0, absorbed: 0 });
    expect(rowRefs()).toHaveLength(8);
    expect(dreamRows()[0].meta).toMatchObject({ garbage: 1, outcome: 'unchanged' });
    (utilityChat as jest.Mock).mockResolvedValueOnce(JSON.stringify({ merged: ['x'.repeat(500)] }));
    await runLearningsDreamCycle({ now: NOW + 8 * DAY });
    expect(rowRefs()).toEqual(expect.arrayContaining([ref(A), ref(B)]));
  });

  test('the members are deleted only after the merged row landed', async () => {
    mockFailStoreFor.prefix = LEARNINGS_DREAM_REF_PREFIX;
    (utilityChat as jest.Mock).mockResolvedValueOnce(JSON.stringify({ merged: [M_AB] }));
    expect(await runLearningsDreamCycle({ now: NOW })).toEqual({ projects: 1, clusters: 0, absorbed: 0 });
    expect(rowRefs()).toEqual(expect.arrayContaining([ref(A), ref(B)]));
    expect(state().merged).toBeUndefined();
    expect(dreamRows()[0].meta).toMatchObject({ storeFailed: 1 });
  });

  test('an unreadable index is skipped (nothing stamped); a store failure never throws', async () => {
    mockQueryRaw.mockRejectedValueOnce(new Error('relation does not exist'));
    expect(await runLearningsDreamCycle({ now: NOW })).toEqual({ projects: 0, clusters: 0, absorbed: 0 });
    expect(state().dreamAt).toBeUndefined();
    mockFindMany.mockRejectedValueOnce(new Error('db down'));
    await expect(runLearningsDreamCycle({ now: NOW })).resolves.toEqual({ projects: 0, clusters: 0, absorbed: 0 });
  });
});

describe('LEARNINGS_DREAM_DISABLED=1', () => {
  test('the cycle is a no-op; merges already applied stay', async () => {
    await writeFile(...E, A, B);
    await sync();
    (utilityChat as jest.Mock).mockResolvedValueOnce(JSON.stringify({ merged: [M_AB] }));
    await runLearningsDreamCycle({ now: NOW });
    const rowsBefore = rowRefs();
    const stateBefore = state();
    mockFindMany.mockClear();
    (utilityChat as jest.Mock).mockClear();
    process.env.LEARNINGS_DREAM_DISABLED = '1';
    expect(await runLearningsDreamCycle({ now: NOW + 30 * DAY })).toEqual({ projects: 0, clusters: 0, absorbed: 0 });
    expect(mockFindMany).not.toHaveBeenCalled();
    expect(utilityChat).not.toHaveBeenCalled();
    expect(rowRefs()).toEqual(rowsBefore);
    expect(state()).toEqual(stateBefore);
  });
});
