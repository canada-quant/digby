/**
 * Snapshot add-failure classification (autonomy loop #12, 2026-09-20): the
 * live warn line "Command failed: git add -A -- ." carried no reason; the two
 * real shapes are execFile's timeout kill and git's volatile-tree fatal.
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: {} }));

import { classifySnapshotAddError, describeExecFailure } from './workspace.service';

describe('classifySnapshotAddError', () => {
  it('an execFile timeout kill (empty stderr, killed/SIGTERM) is a timeout', () => {
    expect(classifySnapshotAddError({ message: 'Command failed: git add -A -- .\n', stderr: '', killed: true, signal: 'SIGTERM', code: null })).toBe('timeout');
    expect(classifySnapshotAddError({ message: 'Command failed: git add -A -- .\n', stderr: '', signal: 'SIGTERM' })).toBe('timeout');
    expect(classifySnapshotAddError({ message: 'git add timed out after 120000ms' })).toBe('timeout');
  });

  it("git's mid-write fatal is 'unstable'; the embedded-repo error is 'embedded'; anything else is 'other'", () => {
    expect(classifySnapshotAddError({ message: 'Command failed: git add -A -- .\nfatal: confused by unstable object source data for cabc7ce9abec6a7df1e9e9523fdee21ac46d1762\n', stderr: '' })).toBe('unstable');
    expect(classifySnapshotAddError({ stderr: "error: 'audit-pack12/' does not have a commit checked out\nfatal: adding files failed", message: 'Command failed' })).toBe('embedded');
    expect(classifySnapshotAddError({ message: 'Command failed: git add -A -- .\nfatal: Unable to create index.lock: File exists.' })).toBe('other');
    expect(classifySnapshotAddError(null)).toBe('other');
  });
});

describe("loop #16: a signal kill with empty stderr is 'killed' (the OOM shape), and every warn names exit code + signal", () => {
  it('SIGKILL / any non-SIGTERM signal → killed; SIGTERM stays a timeout; a plain exit code with empty stderr stays other', () => {
    expect(classifySnapshotAddError({ message: 'Command failed: git add -A -- .\n', stderr: '', signal: 'SIGKILL', code: null })).toBe('killed');
    expect(classifySnapshotAddError({ message: 'Command failed: git add -A -- .\n', stderr: '', signal: 'SIGABRT', code: null })).toBe('killed');
    expect(classifySnapshotAddError({ message: 'Command failed: git add -A -- .\n', stderr: '', signal: 'SIGTERM', code: null })).toBe('timeout');
    expect(classifySnapshotAddError({ message: 'Command failed: git add -A -- .\n', stderr: '', code: 128 })).toBe('other');
    expect(classifySnapshotAddError({ message: 'Command failed: git add -A -- .\n', stderr: '', signal: null, code: null })).toBe('other');
  });
  it('describeExecFailure renders code and signal (null/none when absent)', () => {
    expect(describeExecFailure({ code: 128, signal: null })).toBe('exit code=128, signal=none');
    expect(describeExecFailure({ code: null, signal: 'SIGKILL' })).toBe('exit code=null, signal=SIGKILL');
    expect(describeExecFailure(undefined)).toBe('exit code=null, signal=none');
  });
});
