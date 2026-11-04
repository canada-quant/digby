/**
 * Tests for the code-index run-start injection (owner 2026-09-04): the
 * [CODE INDEX MATCHES] block makes the embeddings index pay on EVERY run
 * instead of only when the model volunteers a search_code_semantic call.
 * The sync/walk machinery is I/O-heavy and exercised in prod; these tests pin
 * the injection block's contracts (guards, dedupe, budget, best-effort).
 */
// In-memory context store so sync state (file hashes / throttle) persists
// across calls within a test (learnings-index.test.ts pattern).
const storeMap = new Map<string, any>();
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async (ns: string[], key: string) => storeMap.get(`${ns.join('/')}::${key}`) ?? null),
  storePut: jest.fn(async (ns: string[], key: string, value: any) => { storeMap.set(`${ns.join('/')}::${key}`, JSON.parse(JSON.stringify(value))); }),
}));
jest.mock('../memory/unified-memory.service', () => ({
  __esModule: true,
  memReplaceRef: jest.fn(async () => 1),
  memSearch: jest.fn(async () => []),
  enforceScopeCap: jest.fn(async () => {}),
  memArchiveRefs: jest.fn(async () => ({ evicted: 0, archived: true, archiveFailed: false })),
  memPurgeArchivedRefs: jest.fn(async () => {}),
  memPurgeArchivedRefsExcept: jest.fn(async () => 0),
  memDeleteRefs: jest.fn(async () => 0),
  worthEmbedding: jest.fn(() => true),
}));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Loop telemetry (remediation P0 index_swept): mocked at the boundary.
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { INDEX_SWEPT: 'index_swept' },
}));

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { buildCodeMatchesBlock, syncCodeIndex } from './code-index.service';

const { memSearch } = jest.requireMock('../memory/unified-memory.service');

const hit = (ref: string, content: string) => ({
  ref, title: ref, source: 'code', content, scopeType: 'project', scopeId: 'p1', createdAt: '',
});

const TASK = 'Fix the retry throttle in the provisioning service so bursts back off';

describe('buildCodeMatchesBlock', () => {
  beforeEach(() => (memSearch as jest.Mock).mockReset().mockResolvedValue([]));

  test('short steering turns inject nothing ("yes", "continue" match nothing meaningful)', async () => {
    expect(await buildCodeMatchesBlock('p1', 'yes do it')).toBe('');
    expect(memSearch).not.toHaveBeenCalled();
  });

  test('no project or no hits → empty string', async () => {
    expect(await buildCodeMatchesBlock(undefined, TASK)).toBe('');
    expect(await buildCodeMatchesBlock('p1', TASK)).toBe('');
  });

  test('renders deduped file lines with snippets, part-suffixes stripped', async () => {
    (memSearch as jest.Mock).mockResolvedValue([
      hit('src/a.ts (part 1)', 'export function throttleRetries() {'),
      hit('src/a.ts (part 2)', 'const BACKOFF_MS = 200;'),
      hit('src/b.ts', 'class ProvisioningService {'),
    ]);
    const block = await buildCodeMatchesBlock('p1', TASK);
    expect(block).toContain('[CODE INDEX MATCHES');
    expect(block).toContain('search_code_semantic');
    // one line per FILE (parts collapse into the first hit)
    expect(block.match(/- src\/a\.ts/g)).toHaveLength(1);
    expect(block).toContain('- src/b.ts');
    expect(block).toContain('throttleRetries');
  });

  test('respects the char budget and the max-files cap', async () => {
    const many = Array.from({ length: 20 }, (_, i) => hit(`src/f${i}.ts`, 'x'.repeat(200)));
    (memSearch as jest.Mock).mockResolvedValue(many);
    const block = await buildCodeMatchesBlock('p1', TASK);
    expect(block.length).toBeLessThanOrEqual(900);
    expect((block.match(/\n- /g) || []).length).toBeLessThanOrEqual(6);
  });

  test('failure → empty string (best-effort, never throws into run assembly)', async () => {
    (memSearch as jest.Mock).mockRejectedValue(new Error('down'));
    expect(await buildCodeMatchesBlock('p1', TASK)).toBe('');
  });
});

// ── index_swept telemetry (remediation P0) ───────────────────────────────────

describe('syncCodeIndex index_swept emission (remediation P0)', () => {
  beforeEach(() => {
    mockRecordLoopMetric.mockClear();
    storeMap.clear();
  });

  test('a sync that ingests files emits ONE index_swept row; a no-op re-sync emits none', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-index-'));
    await fs.writeFile(path.join(root, 'a.ts'), 'export const one = 1;\n', 'utf8');

    const res = await syncCodeIndex('proj-swept', root, { force: true });
    expect(res.skipped).toBe(false);
    expect(res.changed).toBe(1);
    const swept = mockRecordLoopMetric.mock.calls.filter((c) => c[0]?.kind === 'index_swept');
    expect(swept).toHaveLength(1);
    expect(swept[0][0].meta).toMatchObject({ index: 'code', projectId: 'proj-swept', changed: 1, removed: 0 });

    // Unchanged tree → hash short-circuit per file → nothing touched → no row.
    mockRecordLoopMetric.mockClear();
    const again = await syncCodeIndex('proj-swept', root, { force: true });
    expect(again.changed).toBe(0);
    expect(mockRecordLoopMetric.mock.calls.filter((c) => c[0]?.kind === 'index_swept')).toHaveLength(0);
  });
});
