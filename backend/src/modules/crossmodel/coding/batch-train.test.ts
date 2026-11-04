/**
 * batch-train.test.ts — the pure leaf's contract (T2c, todo 9c89ab21).
 *
 * Pins, in order of the failure they prevent:
 *   - branch-name/ts parsing: only `batch/<UTC-ts>` names are trains, and an
 *     unparseable ts is reported (never crashed);
 *   - the docs-only carve-out is EXACTLY the todo's set (.md family, docs/**,
 *     .digby/**) — a code file in the diff kills the carve-out, and an EMPTY
 *     diff is NOT docs-only (fail-closed at the gate: unclassifiable holds);
 *   - diff-header extraction sees renames (both sides) and ignores /dev/null;
 *   - discovery classification: behind/identical ⇒ landed (the train's FF
 *     happened), ahead/diverged ⇒ boarding, >72h unmerged ⇒ abandoned, a
 *     compare failure on one branch never fails the whole discovery;
 *   - the notice renders the boarding redirect (baseBranch/gh pr edit) and
 *     renders NOTHING when no train is live.
 */

import {
  BATCH_BRANCH_RE,
  parseBatchBranchTs,
  shortBranchName,
  isTrainDocsPath,
  classifyTrainDocsOnly,
  filesFromUnifiedDiff,
  isLiveTrain,
  buildBatchTrainNotice,
  discoverBatchTrains,
  BATCH_TRAIN_NOTICE_PREFIX,
  ABANDONED_TRAIN_HOURS,
  type ActiveBatchTrain,
  type BatchTrainDiscoveryApi,
} from './batch-train';

const NOW = new Date('2026-10-17T03:00:00Z');

function train(over: Partial<ActiveBatchTrain> = {}): ActiveBatchTrain {
  return {
    branch: 'batch/20261017T020000Z',
    sha: 'ab'.repeat(20),
    activity: 'boarding',
    cutAt: '2026-10-17T02:00:00Z',
    determinedBy: 'compare:ahead',
    checkedAt: NOW.toISOString(),
    ...over,
  };
}

// ── branch-name / ts parsing ─────────────────────────────────────────────────

describe('BATCH_BRANCH_RE + parseBatchBranchTs', () => {
  test('accepts the runbook shape batch/YYYYMMDDTHHMMSSZ', () => {
    expect(BATCH_BRANCH_RE.test('batch/20261017T015348Z')).toBe(true);
    const d = parseBatchBranchTs('batch/20261017T015348Z');
    expect(d?.toISOString()).toBe('2026-10-17T01:53:48.000Z');
  });

  test('rejects non-train names', () => {
    expect(BATCH_BRANCH_RE.test('main')).toBe(false);
    expect(BATCH_BRANCH_RE.test('batch/')).toBe(false);
    expect(BATCH_BRANCH_RE.test('batch/20261017T0153')).toBe(false);
    expect(BATCH_BRANCH_RE.test('batch/2026-10-17')).toBe(false);
    expect(BATCH_BRANCH_RE.test('batchx/20261017T015348Z')).toBe(false);
    expect(BATCH_BRANCH_RE.test('feature/batch/20261017T015348Z')).toBe(false);
    expect(parseBatchBranchTs('main')).toBeNull();
  });

  test('shortBranchName strips refs/heads/', () => {
    expect(shortBranchName('refs/heads/batch/20261017T015348Z')).toBe('batch/20261017T015348Z');
    expect(shortBranchName('batch/20261017T015348Z')).toBe('batch/20261017T015348Z');
    expect(shortBranchName('')).toBe('');
  });
});

// ── the docs-only carve-out (the todo's set, verbatim) ───────────────────────

describe('isTrainDocsPath / classifyTrainDocsOnly', () => {
  test('.md family anywhere, docs/**, .digby/** are relief', () => {
    expect(isTrainDocsPath('README.md')).toBe(true);
    expect(isTrainDocsPath('docs/BATCH_TRAIN.md')).toBe(true);
    expect(isTrainDocsPath('docs/deep/nested.txt')).toBe(true);
    expect(isTrainDocsPath('.digby/rules/00-current-state.md')).toBe(true);
    expect(isTrainDocsPath('notes.markdown')).toBe(true);
    expect(isTrainDocsPath('page.mdx')).toBe(true);
  });

  test('code, config, tests, memory-bank are NOT relief (they ride the train)', () => {
    expect(isTrainDocsPath('backend/src/modules/crossmodel/coding/tools.ts')).toBe(false);
    expect(isTrainDocsPath('.github/workflows/ci.yml')).toBe(false);
    expect(isTrainDocsPath('backend/src/x.test.ts')).toBe(false);
    expect(isTrainDocsPath('package.json')).toBe(false);
    expect(isTrainDocsPath('docs')).toBe(true); // the bare dir path counts as docs/**
  });

  test('a memory-bank .md path IS relief (it ends .md) — the .md rule is extension-based', () => {
    // Deliberate: the todo says ".md/docs/** state-only" — extension-based.
    // A memory-bank append is a .md change and may go direct.
    expect(isTrainDocsPath('memory-bank/crossmodel-progress.md')).toBe(true);
  });

  test('one code file kills the carve-out; empty is NOT docs-only', () => {
    expect(classifyTrainDocsOnly(['a.md', 'docs/b.md', 'src/x.ts']).docsOnly).toBe(false);
    expect(classifyTrainDocsOnly(['a.md', 'docs/b.md', '.digby/state.json']).docsOnly).toBe(true);
    expect(classifyTrainDocsOnly([]).docsOnly).toBe(false);
    expect(classifyTrainDocsOnly(['', '   ']).docsOnly).toBe(false);
  });
});

// ── diff-header extraction ───────────────────────────────────────────────────

describe('filesFromUnifiedDiff', () => {
  test('extracts +++ b/ paths, both sides of a rename, never /dev/null', () => {
    const diff = [
      'diff --git a/src/old.ts b/src/new.ts',
      'index 111..222 100644',
      '--- a/src/old.ts',
      '+++ b/src/new.ts',
      '+const x = 1;',
      'diff --git a/docs/a.md b/docs/a.md',
      '--- a/docs/a.md',
      '+++ b/docs/a.md',
      '+doc line',
      '--- /dev/null',
      '+++ /dev/null', // pathological, ignored
    ].join('\n');
    expect(filesFromUnifiedDiff(diff).sort()).toEqual(['docs/a.md', 'src/new.ts', 'src/old.ts']);
  });

  test('empty/absent diff yields [] (the gate fail-closes on it)', () => {
    expect(filesFromUnifiedDiff('')).toEqual([]);
    expect(filesFromUnifiedDiff('no headers here\n+just a line')).toEqual([]);
  });
});

// ── discovery classification ─────────────────────────────────────────────────

function apiFor(refs: Array<{ ref: string; sha: string }>, compares: Record<string, any>): BatchTrainDiscoveryApi {
  return {
    async listBatchRefs() {
      if (refs === null) throw new Error('api down');
      return { status: 200, data: refs };
    },
    async compareWithMain(branch: string) {
      if (branch in compares) return { status: 200, data: compares[branch] };
      throw new Error(`unrouted compare ${branch}`);
    },
  };
}

describe('discoverBatchTrains', () => {
  test('ahead branch = BOARDING; behind/identical = LANDED (the FF happened)', async () => {
    const refs = [
      { ref: 'refs/heads/batch/20261017T020000Z', sha: 'aa' },
      { ref: 'refs/heads/batch/20261017T015348Z', sha: 'bb' },
    ];
    const api = apiFor(refs, {
      'batch/20261017T020000Z': { status: 'ahead', ahead_by: 2, behind_by: 0 },
      'batch/20261017T015348Z': { status: 'behind', ahead_by: 0, behind_by: 5 },
    });
    const { trains, error } = await discoverBatchTrains(api, NOW);
    expect(error).toBeUndefined();
    expect(trains).toHaveLength(2);
    const boarding = trains.find((t) => t.branch === 'batch/20261017T020000Z')!;
    expect(boarding.activity).toBe('boarding');
    expect(isLiveTrain(boarding)).toBe(true);
    const landed = trains.find((t) => t.branch === 'batch/20261017T015348Z')!;
    expect(landed.activity).toBe('landed');
    expect(isLiveTrain(landed)).toBe(false);
  });

  test('diverged = BOARDING (main moved under the train — the exact race the gate exists for)', async () => {
    const api = apiFor([{ ref: 'refs/heads/batch/20261017T020000Z', sha: 'aa' }], {
      'batch/20261017T020000Z': { status: 'diverged', ahead_by: 3, behind_by: 2 },
    });
    const { trains } = await discoverBatchTrains(api, NOW);
    expect(trains[0].activity).toBe('boarding');
  });

  test(`unmerged past ${ABANDONED_TRAIN_HOURS}h = ABANDONED (not live)`, async () => {
    const oldBranch = 'batch/20261014T010000Z'; // ~3 days before NOW
    const api = apiFor([{ ref: `refs/heads/${oldBranch}`, sha: 'aa' }], {
      [oldBranch]: { status: 'ahead', ahead_by: 1, behind_by: 0 },
    });
    const { trains } = await discoverBatchTrains(api, NOW);
    expect(trains[0].activity).toBe('abandoned');
    expect(isLiveTrain(trains[0])).toBe(false);
  });

  test('refs listing failure = error outcome, empty trains (fail-open)', async () => {
    const api = apiFor(null as any, {});
    const { trains, error } = await discoverBatchTrains(api, NOW);
    expect(trains).toEqual([]);
    expect(error).toContain('matching-refs failed');
  });

  test('a compare failure on ONE branch never fails discovery; that branch is not live', async () => {
    const api = apiFor(
      [
        { ref: 'refs/heads/batch/20261017T020000Z', sha: 'aa' },
        { ref: 'refs/heads/batch/20261017T013000Z', sha: 'bb' }, // compare unrouted → throws
      ],
      { 'batch/20261017T020000Z': { status: 'ahead', ahead_by: 1, behind_by: 0 } },
    );
    const { trains, error } = await discoverBatchTrains(api, NOW);
    expect(error).toBeUndefined();
    const broken = trains.find((t) => t.branch === 'batch/20261017T013000Z')!;
    expect(broken.determinedBy).toContain('compare-error');
    expect(isLiveTrain(broken)).toBe(false);
    expect(trains.find((t) => t.branch === 'batch/20261017T020000Z')!.activity).toBe('boarding');
  });

  test('non-batch refs are ignored; newest names are inspected first and the fan-out is capped', async () => {
    const refs = [
      { ref: 'refs/heads/main', sha: 'm' }, // ignored — not a train name
      ...Array.from({ length: 12 }, (_, i) => ({
        ref: `refs/heads/batch/2026100${Math.floor(i / 10)}T01000${i}Z`,
        sha: String(i),
      })),
    ];
    let compared: string[] = [];
    const api: BatchTrainDiscoveryApi = {
      async listBatchRefs() { return { status: 200, data: refs }; },
      async compareWithMain(branch: string) {
        compared.push(branch);
        return { status: 200, data: { status: 'ahead', ahead_by: 1, behind_by: 0 } };
      },
    };
    const { trains } = await discoverBatchTrains(api, NOW);
    // 12 batch refs, capped at MAX_TRAIN_BRANCHES (10)
    expect(trains).toHaveLength(10);
    expect(compared).toHaveLength(10);
    // newest-first: the FIRST compare is the NEWEST name, the LAST the oldest inspected
    expect(compared[0]).toBe('batch/20261000T010009Z');
    expect(compared[compared.length - 1]).toBe('batch/20261000T010000Z');
  });
});

// ── notice rendering ─────────────────────────────────────────────────────────

describe('buildBatchTrainNotice', () => {
  test('boarding train renders the redirect (baseBranch + gh pr edit + carve-out)', () => {
    const notice = buildBatchTrainNotice([train()], NOW);
    expect(notice.startsWith(BATCH_TRAIN_NOTICE_PREFIX)).toBe(true);
    expect(notice).toContain('batch/20261017T020000Z');
    expect(notice).toContain('gh pr edit');
    expect(notice).toContain('baseBranch');
    expect(notice).toContain('.md, docs/**, .digby/**');
    expect(notice).toContain('Advisory only, never a skip');
  });

  test('no live train renders EMPTY (the seam appends nothing)', () => {
    expect(buildBatchTrainNotice([], NOW)).toBe('');
    expect(buildBatchTrainNotice([train({ activity: 'landed' })], NOW)).toBe('');
    expect(buildBatchTrainNotice([train({ activity: 'abandoned' })], NOW)).toBe('');
  });

  test('bracket-unsafe input never corrupts the block', () => {
    const notice = buildBatchTrainNotice([train({ branch: 'batch/20261017T0200]00Z' })], NOW);
    expect(notice.startsWith(BATCH_TRAIN_NOTICE_PREFIX)).toBe(true);
    expect(notice).not.toMatch(/\]\]/);
  });
});
