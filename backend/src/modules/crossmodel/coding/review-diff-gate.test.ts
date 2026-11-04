/**
 * A3 (2026-10-04 coding quick wins) — the independent-review diff gate
 * (review-diff-gate.ts): the measurement runs against a REAL temp git repo
 * (committed + uncommitted + untracked changes vs the run-start HEAD), the
 * verdict and the assigned-work detector are pure. The agent seam is pinned in
 * agent-independent-review-diff-gate.test.ts.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/env', () => ({ __esModule: true, env: { NODE_ENV: 'test' } }));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisSubscriber: { subscribe: jest.fn(), on: jest.fn() },
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  independentReviewDiffGateDisabled, riskyPathLabel, parseNumstatZ, measureRunDiff, readRunStartHead,
  reviewDiffGateVerdict, reviewDiffGate, isAssignedWorkRequest, TRIVIAL_DIFF_MAX_FILES, TRIVIAL_DIFF_MAX_LINES,
} from './review-diff-gate';
import { agentSendHeader, ownerDispatchHeader } from '../platform/agent-send-header';
import { rmTreeSync } from './rm-tree-sync';

const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

let repo: string;
let startHead: string;
const write = (rel: string, body: string | Buffer) => {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
};
const lines = (n: number, tag = 'l') => Array.from({ length: n }, (_, i) => `${tag}${i}`).join('\n') + '\n';

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'review-diff-gate-'));
  g(repo, 'init', '-q');
  g(repo, 'config', 'user.email', 't@example.com');
  g(repo, 'config', 'user.name', 't');
  // 372ff5a7: no background gc/reflog writers outliving the awaited call —
  // the ENOTEMPTY racer was git's detached work racing the afterEach rm.
  g(repo, 'config', 'gc.auto', '0');
  write('src/app.ts', lines(50, 'app'));
  write('src/util.ts', lines(10, 'util'));
  write('.gitignore', 'node_modules/\n');
  g(repo, 'add', '-A');
  g(repo, 'commit', '-q', '-m', 'init');
  startHead = g(repo, 'rev-parse', 'HEAD');
});
afterEach(() => {
  rmTreeSync(repo);
  delete process.env.INDEPENDENT_REVIEW_DIFF_GATE_DISABLED;
});

describe('measureRunDiff (real git)', () => {
  it('reads the run-start HEAD', async () => {
    expect(await readRunStartHead(repo)).toBe(startHead);
    expect(await readRunStartHead(path.join(repo, 'does-not-exist'))).toBeNull();
  });

  it('an untouched worktree is an EMPTY diff', async () => {
    expect(await measureRunDiff(repo, startHead)).toEqual({ files: 0, lines: 0, binary: 0, risky: [] });
  });

  it('counts an uncommitted edit (added + deleted lines)', async () => {
    write('src/util.ts', lines(10, 'util').replace('util3\n', 'UTIL3\n'));
    expect(await measureRunDiff(repo, startHead)).toEqual({ files: 1, lines: 2, binary: 0, risky: [] });
  });

  it('counts a COMMITTED change since the run start plus a new untracked file (whole file)', async () => {
    write('src/app.ts', lines(50, 'app') + 'one more\n');
    g(repo, 'commit', '-q', '-am', 'run commit');
    write('src/new.ts', 'a\nb\nc\n');
    expect(await measureRunDiff(repo, startHead)).toEqual({ files: 2, lines: 4, binary: 0, risky: [] });
  });

  it('ignores ignored files and labels risky paths', async () => {
    write('node_modules/x/index.js', 'junk\n');
    write('prisma/migrations/20261004/migration.sql', 'ALTER TABLE x;\n');
    const st = await measureRunDiff(repo, startHead);
    expect(st).toMatchObject({ files: 1, lines: 1, risky: ['migrations'] });
  });

  it('a binary file is never trivial', async () => {
    write('img.png', Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
    const st = await measureRunDiff(repo, startHead);
    expect(st?.files).toBe(1);
    expect(st?.binary).toBe(1);
    expect(st!.lines).toBeGreaterThan(TRIVIAL_DIFF_MAX_LINES);
  });

  it('unmeasurable: no start HEAD, or a bad worktree ⇒ null', async () => {
    expect(await measureRunDiff(repo, null)).toBeNull();
    expect(await measureRunDiff(path.join(repo, 'nope'), startHead)).toBeNull();
  });
});

describe('riskyPathLabel', () => {
  it.each([
    ['backend/prisma/migrations/2026/migration.sql', 'migrations'],
    ['backend/prisma/schema.prisma', 'prisma_schema'],
    ['backend/src/middleware/auth.ts', 'auth'],
    ['backend/src/modules/auth/auth.controller.ts', 'auth'],
    ['src/oauth-callback.ts', 'auth'],
    ['.digby/secrets/token', 'secrets'],
    ['.github/workflows/deploy.yml', 'ci'],
    ['scripts/deploy/deploy-coding-worker.sh', 'deploy'],
    ['deploy-blue-green.sh', 'deploy'],
    ['docker-compose.app.yml', 'compose'],
    ['backend/Dockerfile', 'dockerfile'],
    ['.env.example', 'env'],
    ['config/prod.env', 'env'],
    ['infra/main.tf', 'infra'],
    ['terraform/vpc.tf', 'infra'],
  ])('%s → %s', (p, label) => { expect(riskyPathLabel(p)).toBe(label); });

  it.each(['src/author.ts', 'src/environment.ts', 'docs/README.md', 'backend/src/modules/crossmodel/coding/agent.ts'])('%s is not risky', (p) => {
    expect(riskyPathLabel(p)).toBeNull();
  });
});

describe('parseNumstatZ', () => {
  it('parses text and binary records', () => {
    expect(parseNumstatZ('3\t1\tsrc/a.ts\0-\t-\timg.png\0')).toEqual([
      { path: 'src/a.ts', added: 3, deleted: 1 },
      { path: 'img.png', added: null, deleted: null },
    ]);
    expect(parseNumstatZ('')).toEqual([]);
  });
});

describe('reviewDiffGateVerdict (only "trivial" skips)', () => {
  const stat = (o: Partial<{ files: number; lines: number; binary: number; risky: string[] }> = {}) => ({ files: 1, lines: 5, binary: 0, risky: [], ...o });
  it('trivial: 1..2 files, ≤ 40 lines, no binary, no risky path', () => {
    expect(reviewDiffGateVerdict({ assigned: false, source: 'message', stat: stat() })).toEqual({ skip: true, gate: 'trivial' });
    expect(reviewDiffGateVerdict({ assigned: false, source: 'message', stat: stat({ files: TRIVIAL_DIFF_MAX_FILES, lines: TRIVIAL_DIFF_MAX_LINES }) })).toEqual({ skip: true, gate: 'trivial' });
  });
  it.each([
    ['assigned work', { assigned: true, source: 'message' as const, stat: stat() }, 'assigned'],
    ['a continuation (request from history)', { assigned: false, source: 'history' as const, stat: stat() }, 'continuation'],
    ['unmeasured', { assigned: false, source: 'message' as const, stat: null }, 'unmeasured'],
    ['an empty diff (work outside the worktree)', { assigned: false, source: 'message' as const, stat: stat({ files: 0, lines: 0 }) }, 'no_diff'],
    ['a risky path', { assigned: false, source: 'message' as const, stat: stat({ risky: ['auth'] }) }, 'risky'],
    ['3 files', { assigned: false, source: 'message' as const, stat: stat({ files: 3 }) }, 'non_trivial'],
    ['41 lines', { assigned: false, source: 'message' as const, stat: stat({ lines: 41 }) }, 'non_trivial'],
    ['a binary file', { assigned: false, source: 'message' as const, stat: stat({ binary: 1 }) }, 'non_trivial'],
  ])('%s keeps the reviewer', (_l, o, gate) => {
    expect(reviewDiffGateVerdict(o)).toEqual({ skip: false, gate });
  });
});

describe('isAssignedWorkRequest', () => {
  it('owner dispatch (the bench path) and ticket / platform-task briefs are assigned work', () => {
    expect(isAssignedWorkRequest(`${ownerDispatchHeader('PS', 'abcdef123456', 'bench', new Date('2026-10-04T01:00:00Z'))}Solve the task in /app.`)).toBe(true);
    expect(isAssignedWorkRequest('[TICKET DISPATCH — feedback ticket 1234]\nFix it.')).toBe(true);
    expect(isAssignedWorkRequest(`${agentSendHeader('PS', 'abcdef123456', 'p')}[TICKET BATCH DISPATCH — 3 open feedback tickets, owner-ordered burn-down]`)).toBe(true);
    expect(isAssignedWorkRequest('[PLATFORM TASK — fleet]\nTitle: x')).toBe(true);
  });
  it('a plain agent send and a human ask are not', () => {
    expect(isAssignedWorkRequest(`${agentSendHeader('PS', 'abcdef123456', 'p')}Please fix the typo in README.`)).toBe(false);
    expect(isAssignedWorkRequest('fix the typo in src/util.ts')).toBe(false);
    expect(isAssignedWorkRequest(undefined)).toBe(false);
  });
});

describe('reviewDiffGate (seam helper)', () => {
  it('a tiny human-asked edit is trivial; assigned work is never measured', async () => {
    write('src/util.ts', lines(10, 'util').replace('util3\n', 'UTIL3\n'));
    const r = await reviewDiffGate({ worktree: repo, startHead, source: 'message', rawMessage: 'fix util3' });
    expect(r).toEqual({ skip: true, gate: 'trivial', stat: { files: 1, lines: 2, binary: 0, risky: [] } });
    const a = await reviewDiffGate({ worktree: repo, startHead, source: 'message', rawMessage: '[TICKET DISPATCH — feedback ticket 1]\nfix' });
    expect(a).toEqual({ skip: false, gate: 'assigned', stat: null });
  });
  it('a large edit is non_trivial', async () => {
    write('src/app.ts', lines(50, 'APP'));
    const r = await reviewDiffGate({ worktree: repo, startHead, source: 'message', rawMessage: 'rewrite app' });
    expect(r.skip).toBe(false);
    expect(r.gate).toBe('non_trivial');
    expect(r.stat?.lines).toBe(100);
  });
  it('kill switch reader', () => {
    expect(independentReviewDiffGateDisabled()).toBe(false);
    process.env.INDEPENDENT_REVIEW_DIFF_GATE_DISABLED = '1';
    expect(independentReviewDiffGateDisabled()).toBe(true);
  });
});
