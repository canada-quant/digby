/**
 * audit 2026-10-06 T7-5 — an empty diff keeps the independent reviewer only
 * when the run did MUTATING work; the read-only shell classifier is
 * conservative (unknown ⇒ mutating). Plus the kept-answer review line.
 */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../../config/env', () => ({ __esModule: true, env: { NODE_ENV: 'test' } }));

import { isReadOnlyShellCommand, isMutatingWorkCall, countMutatingWorkCalls, reviewDiffGateVerdict, independentReviewNoDiffSkipDisabled } from './review-diff-gate';
import { keptAnswerWithReviewLine, reviewKeepAnswerDisabled } from './independent-review';

const EMPTY = { files: 0, lines: 0, binary: 0, risky: [] as string[] };

describe('isReadOnlyShellCommand — conservative', () => {
  it.each([
    'ls -la', 'cat README.md | head -50', 'grep -rn TODO src', 'git status && git log --oneline -5', 'git -C /x diff HEAD~1',
    'git fetch origin && git rev-parse origin/main', 'git branch -a', 'git remote -v', 'gh pr list --repo o/r', 'gh pr view 9 --json state',
    'gh api repos/o/r/pulls/9', 'gh api -X GET repos/o/r', 'find . -name "*.ts" 2>/dev/null', 'curl -s https://x/health', 'curl -sI https://x',
    'kubectl get pods -A', 'docker ps', 'systemctl status nginx', 'tailscale status', 'jq .version package.json', 'wc -l src/*.ts',
    'sed -n 1,40p src/a.ts', 'awk \'{print $1}\' f', 'npm ls --depth 0', 'python3 --version', 'echo "a > b"', 'ls >/dev/null 2>&1',
    'timeout 30 curl -s http://x', 'FOO=1 printenv FOO', 'cd src && ls',
  ])('read-only: %s', (cmd) => {
    expect(isReadOnlyShellCommand(cmd)).toBe(true);
  });

  it.each([
    'echo hi > out.txt', 'cat a >> b', 'ls | tee files.txt', 'sed -i s/a/b/ f', 'find . -name x -delete', 'find . -exec rm {} \\;',
    'curl -X POST https://x', 'curl -d a=1 https://x', 'curl -o f https://x', 'wget https://x/f.tgz', 'git commit -m x', 'git push',
    'git checkout -b x', 'git branch newbranch', 'gh pr merge 9 --squash', 'gh api -X POST repos/o/r/issues', 'gh api repos/o/r -f title=x',
    'npm install', 'npm test', 'python3 script.py', 'node -e "1"', 'rm -rf build', 'mkdir x', 'touch f', 'bash -c "ls"', 'make',
    'kubectl apply -f x.yaml', 'docker run x', 'systemctl restart nginx', 'xargs rm', 'awk \'{print > "f"}\' g',
  ])('mutating: %s', (cmd) => {
    expect(isReadOnlyShellCommand(cmd)).toBe(false);
  });
});

describe('isMutatingWorkCall / countMutatingWorkCalls', () => {
  it('file writes + git history always count; a merge never does; run_command by its command', () => {
    expect(isMutatingWorkCall('write_file', '{}')).toBe(true);
    expect(isMutatingWorkCall('git_commit', '{}')).toBe(true);
    expect(isMutatingWorkCall('merge_pull_request', '{"number":9}')).toBe(false);
    expect(isMutatingWorkCall('run_command', JSON.stringify({ command: 'git log -1' }))).toBe(false);
    expect(isMutatingWorkCall('run_command', JSON.stringify({ command: 'npm run build' }))).toBe(true);
    expect(isMutatingWorkCall('run_command', '{not json')).toBe(true); // unparseable ⇒ mutating
    expect(isMutatingWorkCall('read_file', '{}')).toBe(false);
  });
  it('counts a resumed transcript', () => {
    const msgs = [
      { role: 'assistant', tool_calls: [{ function: { name: 'run_command', arguments: JSON.stringify({ command: 'ls' }) } }, { function: { name: 'edit_file', arguments: '{}' } }] },
      { role: 'tool', content: 'x' },
      { role: 'assistant', tool_calls: [{ function: { name: 'run_command', arguments: JSON.stringify({ command: 'make' }) } }] },
    ];
    expect(countMutatingWorkCalls(msgs)).toBe(2);
  });
});

describe('reviewDiffGateVerdict — the empty diff', () => {
  afterEach(() => { delete process.env.INDEPENDENT_REVIEW_NO_DIFF_SKIP_DISABLED; });
  it('no diff + no mutating work ⇒ skip (no_diff_no_mutation); with mutating work ⇒ keep (no_diff)', () => {
    expect(reviewDiffGateVerdict({ assigned: false, source: 'message', stat: EMPTY, mutatingWork: 0 })).toEqual({ skip: true, gate: 'no_diff_no_mutation' });
    expect(reviewDiffGateVerdict({ assigned: false, source: 'message', stat: EMPTY, mutatingWork: 2 })).toEqual({ skip: false, gate: 'no_diff' });
  });
  it('the count omitted (a caller that never measured) keeps the pre-T7-5 verdict; assigned work is never skipped', () => {
    expect(reviewDiffGateVerdict({ assigned: false, source: 'message', stat: EMPTY })).toEqual({ skip: false, gate: 'no_diff' });
    expect(reviewDiffGateVerdict({ assigned: true, source: 'message', stat: EMPTY, mutatingWork: 0 })).toEqual({ skip: false, gate: 'assigned' });
  });
  it('INDEPENDENT_REVIEW_NO_DIFF_SKIP_DISABLED=1 ⇒ no_diff keeps the reviewer (today)', () => {
    process.env.INDEPENDENT_REVIEW_NO_DIFF_SKIP_DISABLED = '1';
    expect(independentReviewNoDiffSkipDisabled()).toBe(true);
    expect(reviewDiffGateVerdict({ assigned: false, source: 'message', stat: EMPTY, mutatingWork: 0 })).toEqual({ skip: false, gate: 'no_diff' });
  });
});

describe('keptAnswerWithReviewLine', () => {
  it('keeps the answer verbatim and appends ONE italic line with the outcome + the first sentence of the review round', () => {
    const out = keptAnswerWithReviewLine('Because the spawn had no prompt.\n\nDetails…', '## Audit\n- **All five criteria verified** — four with this-run receipts. Criterion 3 re-probed.', 0);
    expect(out.startsWith('Because the spawn had no prompt.\n\nDetails…\n\n_Independent review')).toBe(true);
    expect(out).toContain('no defects found — Audit All five criteria verified — four with this-run receipts._');
    expect(out.split('\n').filter((l) => l.startsWith('_Independent review')).length).toBe(1);
    expect(keptAnswerWithReviewLine('A', 'B is fine.', 2)).toContain('2 possible issues raised and weighed');
  });
  it('kill switch reader', () => {
    process.env.INDEPENDENT_REVIEW_KEEP_ANSWER_DISABLED = '1';
    expect(reviewKeepAnswerDisabled()).toBe(true);
    delete process.env.INDEPENDENT_REVIEW_KEEP_ANSWER_DISABLED;
    expect(reviewKeepAnswerDisabled()).toBe(false);
  });
});
