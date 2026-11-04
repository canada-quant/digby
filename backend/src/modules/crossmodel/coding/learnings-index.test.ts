/**
 * Tests for the learnings semantic index (audit #11): parser, recency-aware
 * prompt slice, incremental ingest (memReplaceRef reuse + throttle), the
 * [RELEVANT LEARNINGS] block budget, and the on-tool-failure requery nudger.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// In-memory context store so sync state persists across calls within a test.
const storeMap = new Map<string, any>();
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async (ns: string[], key: string) => storeMap.get(`${ns.join('/')}::${key}`) ?? null),
  storePut: jest.fn(async (ns: string[], key: string, value: any) => { storeMap.set(`${ns.join('/')}::${key}`, JSON.parse(JSON.stringify(value))); }),
}));

// unified-memory is the storage boundary — mocked wholesale (its graph reaches
// rag.service/config); the ingest tests assert the memReplaceRef contract.
jest.mock('../memory/unified-memory.service', () => ({
  __esModule: true,
  memReplaceRef: jest.fn(async () => 1),
  memSearch: jest.fn(async () => []),
}));

// Loop telemetry (remediation P0): a sync that touched the index emits ONE
// index_swept row — mocked so no prisma-backed buffer loads.
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { INDEX_SWEPT: 'index_swept' },
}));

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  parseLearningsDoc, normalizeEntry, learningEntries, learningRef,
  sliceLearningsForInjection, syncLearningsIndex,
  buildLearningsBlock, looksLikeToolFailure, lexicalOverlap, createFailureLearningNudger,
  LEARNING_SOURCE, LEARNINGS_REL_PATH,
} from './learnings-index.service';

const { memReplaceRef, memSearch } = jest.requireMock('../memory/unified-memory.service');

const FIXTURE = `# Learned conventions (durable)

One short line per durable discovery. Keep it deduped and specific.

- First learning: run \`npx prisma generate\` after schema merges before tsc.
- Second learning: gh CLI is NOT installed — use curl REST with $GITHUB_TOKEN.
<!-- e.g. - Tests need Postgres up first. -->
Fleet-ops block (audit session, 2026-08-07):
- Third learning: markers live in /var/tmp because rsync --delete wipes /opt/crossmodel.
- Multi-line learning: the first line
  continues indented here with more detail.
## Heading block entry
Prose line one of the heading block.
Prose line two.

- First learning: run \`npx prisma generate\` after schema merges before tsc.
- Newest learning: heredoc delimiters in Actions run blocks must match base indent.
`;

beforeEach(() => {
  storeMap.clear();
  (memReplaceRef as jest.Mock).mockClear().mockResolvedValue(1);
  (memSearch as jest.Mock).mockClear().mockResolvedValue([]);
  mockRecordLoopMetric.mockClear();
});

describe('parseLearningsDoc / learningEntries (parser)', () => {
  test('header = everything before the first entry', () => {
    const doc = parseLearningsDoc(FIXTURE);
    expect(doc.header).toContain('# Learned conventions (durable)');
    expect(doc.header).toContain('deduped and specific');
    expect(doc.header).not.toContain('First learning');
  });

  test('bullets, multi-line bullets, and heading blocks are entries; labels/comments are preserved as other', () => {
    const doc = parseLearningsDoc(FIXTURE);
    const entries = doc.segments.filter(s => s.kind === 'entry').map(s => s.text);
    const others = doc.segments.filter(s => s.kind === 'other').map(s => s.text);
    expect(entries.some(t => t.startsWith('- First learning'))).toBe(true);
    // Multi-line continuation stays inside ONE entry.
    const multi = entries.find(t => t.startsWith('- Multi-line learning'));
    expect(multi).toContain('continues indented here');
    // Heading block = heading + its prose, one entry.
    const heading = entries.find(t => t.startsWith('## Heading block entry'));
    expect(heading).toContain('Prose line two.');
    // Section label + comment survive as 'other'.
    expect(others).toContain('Fleet-ops block (audit session, 2026-08-07):');
    expect(others.some(t => t.includes('<!--'))).toBe(true);
  });

  test('identical entries dedupe to one (content-addressed refs)', () => {
    const entries = learningEntries(FIXTURE);
    const firsts = entries.filter(e => e.content.startsWith('First learning'));
    expect(firsts).toHaveLength(1);
    // 7 unique entries: First, Second, Third, Multi-line, Heading block, Newest (dup dropped).
    expect(entries).toHaveLength(6);
    // Ref is stable and derived from the normalized content.
    expect(firsts[0].ref).toBe(learningRef(normalizeEntry('- First learning: run `npx prisma generate` after schema merges before tsc.')));
    expect(firsts[0].ref).toMatch(/^learning:[0-9a-f]{40}$/);
  });

  test('normalizeEntry strips the marker and collapses whitespace', () => {
    expect(normalizeEntry('- a  b\n  c')).toBe('a b c');
    expect(normalizeEntry('## Head\nrest')).toBe('Head rest');
  });
});

describe('sliceLearningsForInjection (recency-aware head+tail)', () => {
  test('small files pass through verbatim', () => {
    expect(sliceLearningsForInjection(FIXTURE, 4000)).toBe(FIXTURE);
  });

  test('large files keep the header AND the newest (tail) entries within budget', () => {
    const oldEntries = Array.from({ length: 100 }, (_, i) => `- Old learning number ${i}: some durable fact about subsystem ${i}.`).join('\n');
    const md = `# Learned conventions\n\nIntro prose.\n\n${oldEntries}\n- NEWEST learning: the tail entry that must survive.\n`;
    const out = sliceLearningsForInjection(md, 4000);
    expect(out.length).toBeLessThanOrEqual(4000);
    expect(out).toContain('# Learned conventions');            // head kept
    expect(out).toContain('NEWEST learning');                  // newest kept
    expect(out).toContain('older entries omitted');            // marker present
    expect(out).toContain("search_memory(scope:'project', source:'learning')");
    expect(out).not.toContain('Old learning number 0:');       // oldest entries gone
    // Tail is aligned to an entry start — no torn half-bullet right after the marker.
    const afterMarker = out.slice(out.indexOf('…]\n') + 3);
    expect(afterMarker.startsWith('- ')).toBe(true);
  });
});

describe('syncLearningsIndex (incremental ingest via memReplaceRef)', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'learnings-'));
    await fs.mkdir(path.dirname(path.join(root, LEARNINGS_REL_PATH)), { recursive: true });
    await fs.writeFile(path.join(root, LEARNINGS_REL_PATH), FIXTURE, 'utf8');
  });

  test('first sync stores one row set per unique entry into the PROJECT scope, source learning, skipCap on', async () => {
    const res = await syncLearningsIndex('proj-1', root, { force: true });
    expect(res).toEqual({ added: 6, removed: 0, skipped: false });
    expect(memReplaceRef).toHaveBeenCalledTimes(6);
    const [scope, source, ref, items, opts] = (memReplaceRef as jest.Mock).mock.calls[0];
    expect(scope).toEqual({ type: 'project', id: 'proj-1' });
    expect(source).toBe(LEARNING_SOURCE);
    expect(ref).toMatch(/^learning:[0-9a-f]{40}$/);
    expect(items).toHaveLength(1);
    expect(items[0].content).toContain('First learning');
    expect(items[0].title.length).toBeLessThanOrEqual(120);
    // The project scope is shared with the 20k-row code index — the default
    // 800-row cap sweep must NOT run per store.
    expect(opts).toMatchObject({ skipCap: true });
    // Remediation P0: a sync that touched the index emits ONE index_swept row.
    const swept = mockRecordLoopMetric.mock.calls.filter((c) => c[0]?.kind === 'index_swept');
    expect(swept).toHaveLength(1);
    expect(swept[0][0].meta).toMatchObject({ index: 'learnings', projectId: 'proj-1', added: 6, removed: 0 });
  });

  test('unchanged file re-syncs to zero work; a removed entry is swept', async () => {
    await syncLearningsIndex('proj-1', root, { force: true });
    (memReplaceRef as jest.Mock).mockClear();

    mockRecordLoopMetric.mockClear();
    const again = await syncLearningsIndex('proj-1', root, { force: true });
    expect(again).toEqual({ added: 0, removed: 0, skipped: true }); // file-hash short-circuit
    expect(memReplaceRef).not.toHaveBeenCalled();
    // Remediation P0: an untouched index emits NO index_swept row.
    expect(mockRecordLoopMetric.mock.calls.filter((c) => c[0]?.kind === 'index_swept')).toHaveLength(0);

    // Drop the newest entry from the file → its ref is deleted (empty items).
    await fs.writeFile(path.join(root, LEARNINGS_REL_PATH), FIXTURE.replace(/- Newest learning[^\n]*\n/, ''), 'utf8');
    const res = await syncLearningsIndex('proj-1', root, { force: true });
    expect(res.added).toBe(0);
    expect(res.removed).toBe(1);
    // Remediation P0: the sweep emitted, value = rows swept out.
    const sweptRows = mockRecordLoopMetric.mock.calls.filter((c) => c[0]?.kind === 'index_swept');
    expect(sweptRows).toHaveLength(1);
    expect(sweptRows[0][0]).toMatchObject({ value: 1, meta: { index: 'learnings', removed: 1 } });
    const del = (memReplaceRef as jest.Mock).mock.calls.find(c => Array.isArray(c[3]) && c[3].length === 0);
    expect(del).toBeTruthy();
    expect(del![2]).toBe(learningRef(normalizeEntry('- Newest learning: heredoc delimiters in Actions run blocks must match base indent.')));
  });

  test('throttled: a second un-forced sync within 10 min is skipped', async () => {
    await syncLearningsIndex('proj-1', root, { force: true });
    (memReplaceRef as jest.Mock).mockClear();
    // Wipe the ref state but keep lastSyncAt — throttle must still skip.
    const key = 'proj-1/learnings-index::state';
    storeMap.set(key, { ...storeMap.get(key), refs: {}, fileHash: undefined });
    const res = await syncLearningsIndex('proj-1', root);
    expect(res.skipped).toBe(true);
    expect(memReplaceRef).not.toHaveBeenCalled();
  });

  test('missing learnings file skips without sweeping existing rows', async () => {
    await fs.rm(path.join(root, LEARNINGS_REL_PATH));
    const res = await syncLearningsIndex('proj-1', root, { force: true });
    expect(res).toEqual({ added: 0, removed: 0, skipped: true });
    expect(memReplaceRef).not.toHaveBeenCalled();
  });

  // ── P6 (spark B23): removals gated on the project's CANONICAL content so two
  // worktrees on divergent branches stop sweeping each other's rows. ──────────
  test('P6 B23: a ref gone from THIS worktree but still CANONICAL is kept (another branch owns it)', async () => {
    await syncLearningsIndex('proj-1', root, { force: true });
    (memReplaceRef as jest.Mock).mockClear();
    const newestRef = learningRef(normalizeEntry('- Newest learning: heredoc delimiters in Actions run blocks must match base indent.'));
    await fs.writeFile(path.join(root, LEARNINGS_REL_PATH), FIXTURE.replace(/- Newest learning[^\n]*\n/, ''), 'utf8');
    const res = await syncLearningsIndex('proj-1', root, {
      force: true, canonicalForTest: { kind: 'content', refs: new Set([newestRef]) },
    });
    expect(res.removed).toBe(0);
    expect((memReplaceRef as jest.Mock).mock.calls.find(c => Array.isArray(c[3]) && c[3].length === 0)).toBeUndefined();
  });

  test('P6 B23: a ref gone from BOTH the worktree and the canonical file IS removed (deliberate delete)', async () => {
    await syncLearningsIndex('proj-1', root, { force: true });
    (memReplaceRef as jest.Mock).mockClear();
    await fs.writeFile(path.join(root, LEARNINGS_REL_PATH), FIXTURE.replace(/- Newest learning[^\n]*\n/, ''), 'utf8');
    const res = await syncLearningsIndex('proj-1', root, {
      force: true, canonicalForTest: { kind: 'content', refs: new Set<string>() },
    });
    expect(res.removed).toBe(1);
  });

  test('P6 B23: an UNREADABLE canonical suppresses removals entirely (uncertainty never mass-removes)', async () => {
    await syncLearningsIndex('proj-1', root, { force: true });
    (memReplaceRef as jest.Mock).mockClear();
    await fs.writeFile(path.join(root, LEARNINGS_REL_PATH), FIXTURE.replace(/- Newest learning[^\n]*\n/, ''), 'utf8');
    const res = await syncLearningsIndex('proj-1', root, {
      force: true, canonicalForTest: { kind: 'absent' },
    });
    expect(res.removed).toBe(0);
  });

  test('P6 B23: no-mirror projects (legacy blank, one lineage) keep the old worktree-only sweep', async () => {
    // No mirror exists in this test env → canonicalLearningRefs resolves 'no-mirror'
    // on its own (no canonicalForTest) — the existing removed-entry test above
    // already exercises this path end-to-end; this pins the intent explicitly.
    await syncLearningsIndex('proj-1', root, { force: true });
    (memReplaceRef as jest.Mock).mockClear();
    await fs.writeFile(path.join(root, LEARNINGS_REL_PATH), FIXTURE.replace(/- Newest learning[^\n]*\n/, ''), 'utf8');
    const res = await syncLearningsIndex('proj-1', root, { force: true });
    expect(res.removed).toBe(1);
  });
});

describe('buildLearningsBlock ([RELEVANT LEARNINGS] injection)', () => {
  const hit = (content: string) => ({ ref: 'learning:x', title: content.slice(0, 120), source: 'learning', content, scopeType: 'project', scopeId: 'p', createdAt: '' });

  test('formats matched learnings under the header, querying source=learning in the project scope', async () => {
    (memSearch as jest.Mock).mockResolvedValue([hit('Use curl REST — gh CLI is not installed.')]);
    const block = await buildLearningsBlock('proj-1', 'open a PR via gh');
    expect(block).toContain('[RELEVANT LEARNINGS');
    expect(block).toContain('- Use curl REST');
    expect(memSearch).toHaveBeenCalledWith(
      [{ type: 'project', id: 'proj-1' }], 'open a PR via gh', 5, { sources: [LEARNING_SOURCE], purpose: 'learnings_inject' },
    );
  });

  test('stays within the ~1,200 char budget even with many long hits', async () => {
    (memSearch as jest.Mock).mockResolvedValue(Array.from({ length: 5 }, (_, i) => hit(`Learning ${i}: ${'x'.repeat(500)}`)));
    const block = await buildLearningsBlock('proj-1', 'anything');
    expect(block.length).toBeLessThanOrEqual(1200);
    expect(block).toContain('Learning 0');
  });

  test('empty on no hits, no project, or blank query — and never throws', async () => {
    expect(await buildLearningsBlock('proj-1', 'q')).toBe('');
    expect(await buildLearningsBlock(undefined, 'q')).toBe('');
    expect(await buildLearningsBlock('proj-1', '  ')).toBe('');
    (memSearch as jest.Mock).mockRejectedValue(new Error('boom'));
    expect(await buildLearningsBlock('proj-1', 'q')).toBe('');
  });
});

describe('looksLikeToolFailure (conservative failure shapes)', () => {
  test('matches the harness failure shapes', () => {
    expect(looksLikeToolFailure('Tool run_command failed: spawn ENOENT')).toBe(true);
    expect(looksLikeToolFailure('Verify FAILED at "test": ✓ typecheck  ✗ test (exit 1)')).toBe(true);
    expect(looksLikeToolFailure('git commit failed: nothing to commit')).toBe(true);
    expect(looksLikeToolFailure('COMMIT BLOCKED — the staged changes appear to contain secrets')).toBe(true);
    expect(looksLikeToolFailure('npm ERR! something\n[exit: 1]')).toBe(true);
    expect(looksLikeToolFailure('build died\n[exit: 137 — timed out]')).toBe(true);
    expect(looksLikeToolFailure('Tool "grep" exceeded 900s and was aborted. Do not retry it; proceed with what you have.')).toBe(true);
  });
  test('does NOT fire on ordinary content that merely mentions errors', () => {
    expect(looksLikeToolFailure('const onError = (e) => logger.error(e); // Tool helpers')).toBe(false);
    expect(looksLikeToolFailure('All 42 tests passed')).toBe(false);
    expect(looksLikeToolFailure('ok\n[exit: 0]')).toBe(false);
    expect(looksLikeToolFailure('')).toBe(false);
  });
  // REPLAY — ticket 1ab1a52b (2026-09-10): a machine-triggered burn-down lane
  // called cancel_schedule 3× without an autonomy grant; each call staged a
  // pending confirmation and returned the gate's envelope below (verbatim from
  // the ticket, truncated mid-string exactly as filed). looksLikeToolFailure's
  // /ok:false/ marker counted each staging as a FAILURE → the derail breaker
  // tripped, withheld the tool, and auto-filed mishap 1ab1a52b whose "failure
  // texts" were the confirmation gate working as designed. The staging
  // envelope is a PENDING USER ACTION and must never be failure-shaped.
  test('ticket 1ab1a52b replay: the needsConfirmation staging envelope is NOT failure-shaped', () => {
    const staged = JSON.stringify({
      ok: false,
      needsConfirmation: true,
      confirmationId: 'cf_47362400-ca18-486f-a180-a778b163737d',
      summary: 'Cancel (disable) schedule 794a76cb.',
      expiresInMinutes: 10080,
      expiresAt: 1789655170811,
      instructions: 'This action changes the user\'s account and needs THEIR explicit confirmation. …',
    }, null, 1);
    expect(staged.startsWith('{\n "ok": false,')).toBe(true); // pins the envelope's wire shape
    expect(looksLikeToolFailure(staged)).toBe(false);
    // …and exactly as filed in the ticket (500-char slice, cut mid-string):
    expect(looksLikeToolFailure(staged.slice(0, 500))).toBe(false);
  });
  test('other ok:false refusal envelopes REMAIN failure-shaped (no over-exemption)', () => {
    // The preflight + platform refusal envelopes carry no needsConfirmation key.
    expect(looksLikeToolFailure('{\n "ok": false,\n "tool": "update_feedback",\n "reason": "ticket_not_found"\n}')).toBe(true);
    expect(looksLikeToolFailure('{\n "ok": false,\n "reason": "tool_not_offered",\n "needsConfirmation": false\n}')).toBe(true);
  });
});

describe('createFailureLearningNudger (on-failure requery)', () => {
  const FAIL = 'Tool git_commit failed: insufficient permission for adding an object to repository database';
  const RELEVANT = { ref: 'learning:a', title: 'Git object store is NFS root-squashed', source: 'learning', content: 'Git object store is NFS root-squashed: git_commit fails with insufficient permission for adding an object — chown the git-common-dir then run git as uid 1001.', scopeType: 'project', scopeId: 'p', createdAt: '' };

  test('appends the matched learning on a failure-shaped result (≤400 chars)', async () => {
    (memSearch as jest.Mock).mockResolvedValue([RELEVANT]);
    const nudge = createFailureLearningNudger('proj-1');
    const note = await nudge('git_commit', FAIL);
    expect(note).toContain('[POSSIBLY RELEVANT LEARNING');
    expect(note).toContain('NFS root-squashed');
    expect(note.length).toBeLessThanOrEqual(400);
  });

  test('non-failure results and missing project never requery', async () => {
    const nudge = createFailureLearningNudger('proj-1');
    expect(await nudge('read_file', 'file contents with the word error in them')).toBe('');
    expect(memSearch).not.toHaveBeenCalled();
    const noProj = createFailureLearningNudger(undefined);
    expect(await noProj('git_commit', FAIL)).toBe('');
    expect(memSearch).not.toHaveBeenCalled();
  });

  test('throttles to ≤3 requeries per run', async () => {
    (memSearch as jest.Mock).mockResolvedValue([RELEVANT]);
    const nudge = createFailureLearningNudger('proj-1');
    for (let i = 0; i < 5; i++) await nudge('git_commit', FAIL);
    expect(memSearch).toHaveBeenCalledTimes(3);
  });

  test('drops hits below the lexical-overlap threshold (no score from memSearch)', async () => {
    (memSearch as jest.Mock).mockResolvedValue([{ ...RELEVANT, title: 'Sonner toast CSS', content: 'Sonner uses three CSS custom properties for vertical position.' }]);
    const nudge = createFailureLearningNudger('proj-1');
    expect(await nudge('git_commit', FAIL)).toBe('');
    expect(memSearch).toHaveBeenCalledTimes(1);
  });

  test('lexicalOverlap counts shared distinctive tokens only', () => {
    expect(lexicalOverlap('insufficient permission adding object', 'permission object insufficient database')).toBe(3);
    expect(lexicalOverlap('this that with from', 'this that with from')).toBe(0); // stopwords
  });
});

describe('agent.ts wiring drift-guard (surgical-edit insurance)', () => {
  // The agent-loop integration is 4 one-line seams — pin them so a refactor
  // that drops one fails loudly here instead of silently killing retrieval.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'agent.ts'), 'utf8');
  test('run-start kick, prompt slice, injection block, and failure nudger are all wired', () => {
    // 2026-09-14 memory unification: the kick also carries the run's userId (provenance stamp on project rows)
    expect(src).toContain('kickLearningsIndexSync(input.projectId, input.worktree, input.userId)');
    expect(src).toContain('sliceLearningsForInjection(learnings, 4000)');
    expect(src).toContain('buildLearningsBlock(input.projectId, input.userMessage)');
    expect(src).toContain('createFailureLearningNudger(input.projectId)');
    expect(src).toContain('learningNudge(tc.name, result)');
    // The block lands in the memory block beside the journal — with the
    // code-matches + inventory injections riding beside it (owner 2026-09-04).
    expect(src).toMatch(/formatJournalBlock\(journalEntries, input\.machineTriggered \? MACHINE_JOURNAL_BLOCK_CAP : undefined\), learningsBlock, codeMatchesBlock, memoryInventory\]/);
    expect(src).toContain('buildCodeMatchesBlock(input.projectId, input.userMessage)');
    expect(src).toContain('buildSessionMemoryInventory(input.sessionId)');
  });

  // Retrieval doctrine (owner 2026-09-04): the system prompt used to steer
  // exploration to grep/glob ONLY — neither retrieval tool appeared anywhere in
  // doctrine, so the model rationally never called them. Pin the counterweights.
  test('the coding doctrine carries retrieval discipline, and the offload/failure seams point back at memory', () => {
    // Explore bullet leads with the semantic index; the Memory-first bullet
    // tells the model to check memory before re-deriving/re-reading.
    expect(src).toMatch(/Explore: \*\*search_code_semantic\*\*/);
    expect(src).toMatch(/\*\*Memory first:\*\*/);
    expect(src).toMatch(/search_memory\(source:'learning'\)/);
    // Worker offloads surface to the ORCHESTRATOR TRANSCRIPT (they used to be
    // UI-only progress events): the delegate return appends a harness pointer.
    expect(src).toContain('this worker stored ${sub.offloaded} full-detail finding chunk');
    // The repeat-failure nudge suggests the learnings requery.
    expect(src).toMatch(/repeated the same tool call[^`]*search_memory\(source:'learning'\)/);
  });
});
