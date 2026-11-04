/**
 * Diagnostics after edit (harness roadmap item 1, owner 2026-09-19) — the pure
 * derivations (command shaping, output split, note) and the tracker's
 * debounce / single-flight / re-run / dispose contract over a fake shell.
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  buildDiagnosticsCommands, splitDiagnostics, renderDiagnosticsNote, tsBuildInfoPath,
  EditDiagnosticsTracker, __resetEditDiagnosticsForTests, EDIT_DIAGNOSTICS_MAX_LINES,
} from './edit-diagnostics';

const CFG = { commands: { typecheck: 'cd backend && npx tsc --noEmit', lint: 'cd backend && npm run lint && cd ../frontend && npm run lint', test: 'cd backend && npx jest' } };

beforeEach(() => { __resetEditDiagnosticsForTests(); });

describe('buildDiagnosticsCommands', () => {
  it('makes the project tsc incremental with a /tmp build-info cache, keeping the cd prefix; a multi-step lint chain is not file-scopable', () => {
    const cmds = buildDiagnosticsCommands(CFG as any, ['backend/src/a.ts', './backend/src/b.ts']);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].key).toBe('typecheck');
    expect(cmds[0].command).toBe(`cd backend && npx tsc --noEmit --incremental --tsBuildInfoFile ${tsBuildInfoPath('cd backend && npx tsc --noEmit')}`);
  });

  it('leaves an already-incremental / build-mode tsc alone and adds --noEmit when missing', () => {
    expect(buildDiagnosticsCommands({ commands: { typecheck: 'npx tsc --noEmit --incremental' } } as any, ['x.ts'])[0].command).toBe('npx tsc --noEmit --incremental');
    expect(buildDiagnosticsCommands({ commands: { typecheck: 'tsc -b' } } as any, ['x.ts'])[0].command).toBe('tsc --noEmit -b');
  });

  it('scopes a single eslint / ruff / pyright / mypy invocation to the touched files (quoted), and returns [] with no config or files', () => {
    const cmds = buildDiagnosticsCommands({ commands: { typecheck: 'pyright', lint: 'ruff check .' } } as any, ["pkg/it's.py", 'pkg/b.py']);
    expect(cmds).toEqual([
      { key: 'typecheck', command: "pyright 'pkg/it'\\''s.py' 'pkg/b.py'" },
      { key: 'lint', command: "ruff check . 'pkg/it'\\''s.py' 'pkg/b.py'" },
    ]);
    expect(buildDiagnosticsCommands({ commands: { lint: 'npx eslint src' } } as any, ['src/a.ts'])).toEqual([{ key: 'lint', command: "npx eslint src --no-error-on-unmatched-pattern 'src/a.ts'" }]);
    expect(buildDiagnosticsCommands(null, ['a.ts'])).toEqual([]);
    expect(buildDiagnosticsCommands(CFG as any, [])).toEqual([]);
    expect(buildDiagnosticsCommands({ commands: { typecheck: 'go vet ./...' } } as any, ['a.go'])).toEqual([]); // unknown checker: nothing derivable
  });

  it('hands each tool ONLY the touched files in its language; a shell/markdown edit yields no pass at all (live 2026-09-19: mypy was given tmp/shard_r1.cmd.sh and its syntax error was reported as the lane\'s)', () => {
    const cfg = { commands: { typecheck: 'mypy src', lint: 'ruff check .' } } as any;
    expect(buildDiagnosticsCommands(cfg, ['tmp/shard_r1.cmd.sh', 'README.md'])).toEqual([]);
    expect(buildDiagnosticsCommands(cfg, ['tmp/shard_r1.cmd.sh', 'pkg/a.py', 'types.pyi'])).toEqual([
      { key: 'typecheck', command: "mypy src 'pkg/a.py' 'types.pyi'" },
      { key: 'lint', command: "ruff check . 'pkg/a.py' 'types.pyi'" },
    ]);
    const ts = { commands: { typecheck: 'npx tsc --noEmit --incremental', lint: 'npx eslint src' } } as any;
    expect(buildDiagnosticsCommands(ts, ['deploy.sh', 'docs/x.md'])).toEqual([]);
    expect(buildDiagnosticsCommands(ts, ['deploy.sh', 'src/a.tsx', 'src/b.mjs', 'pkg/c.py'])).toEqual([
      { key: 'typecheck', command: 'npx tsc --noEmit --incremental' },
      { key: 'lint', command: "npx eslint src --no-error-on-unmatched-pattern 'src/a.tsx' 'src/b.mjs'" },
    ]);
  });
});

describe('splitDiagnostics + renderDiagnosticsNote', () => {
  const OUT = [
    "src/modules/x/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
    'src/modules/y/other.ts(3,1): error TS1005: expected.',
    '  12 |   const n: number = "x";',
    "src/modules/x/a.ts(40,2): warning something",
    'Found 3 errors in 2 files.',
  ].join('\n');

  it('keeps lines naming the touched files and counts the rest', () => {
    const r = splitDiagnostics(OUT, ['backend/src/modules/x/a.ts']);
    expect(r.touchedLines).toHaveLength(2); // basename match covers the cd-prefixed relative path
    expect(r.otherCount).toBe(1); // other.ts only — the "Found 3 errors" summary and the code frame are not diagnostics
  });

  it('understands ruff / mypy "path:line:col" rows (no error word) and eslint-stylish file headers (live 2026-09-19: a ruff exit 1 read as 0 diagnostics)', () => {
    const ruff = ['pkg/a.py:12:5: F401 `os` imported but unused', 'pkg/b.py:3:1: E302 expected 2 blank lines', 'Found 2 errors.'].join('\n');
    const r = splitDiagnostics(ruff, ['pkg/a.py']);
    expect(r.touchedLines).toEqual(['pkg/a.py:12:5: F401 `os` imported but unused']);
    expect(r.otherCount).toBe(1);
    const eslint = ['/wt/src/a.ts', '  10:3  error  Unexpected any  @typescript-eslint/no-explicit-any', '  12:1  warning  Missing return type  x', '', '/wt/src/other.ts', '  1:1  error  bad  rule', '✖ 3 problems (2 errors, 1 warning)'].join('\n');
    const e = splitDiagnostics(eslint, ['src/a.ts']);
    expect(e.touchedLines).toEqual(['/wt/src/a.ts: 10:3  error  Unexpected any  @typescript-eslint/no-explicit-any', '/wt/src/a.ts: 12:1  warning  Missing return type  x']);
    expect(e.otherCount).toBe(1); // other.ts row; the summary line is not a diagnostic
  });

  it('renders touched diagnostics first, the elsewhere count, clean and skipped stages, bounded', () => {
    const many = Array.from({ length: EDIT_DIAGNOSTICS_MAX_LINES + 5 }, (_, i) => `a.ts(${i},1): error TS1 e`);
    const note = renderDiagnosticsNote(['a.ts', 'b.ts'], [
      { key: 'typecheck', exitCode: 2, touchedLines: many, otherCount: 4, skipped: false, ms: 900 },
      { key: 'lint', exitCode: 0, touchedLines: [], otherCount: 0, skipped: false, ms: 200 },
    ]);
    expect(note.startsWith('[DIAGNOSTICS — harness, after your edits to a.ts, b.ts.')).toBe(true);
    expect(note).toContain(`typecheck: ${many.length} diagnostic(s) in the files you touched (+4 elsewhere):`);
    expect(note).toContain(`… (+5 more)`);
    expect(note).toContain('lint: ✓ clean for the files you touched.');
    expect(note).toContain('Fix what is yours before building on it');
    const skipped = renderDiagnosticsNote(['a.ts'], [{ key: 'typecheck', exitCode: 127, touchedLines: [], otherCount: 0, skipped: true, ms: 5 }]);
    expect(skipped).toContain('could not run (tool not installed here)');
    const elsewhere = renderDiagnosticsNote(['a.ts'], [{ key: 'typecheck', exitCode: 2, touchedLines: [], otherCount: 3, skipped: false, ms: 5 }]);
    expect(elsewhere).toContain('no diagnostics in the files you touched; 3 elsewhere');
  });
});

describe('EditDiagnosticsTracker', () => {
  const shell = (outputs: Record<string, string>, calls: string[]) => async (command: string) => {
    calls.push(command);
    const key = /tsc/.test(command) ? 'tsc' : 'lint';
    return { stdout: `${outputs[key] ?? ''}\n__DIGBY_EXIT__ ${outputs[key] ? 2 : 0}`, stderr: '' };
  };

  it('debounces edits into ONE pass, runs the derived command with the heap cap, and hands back one note', async () => {
    const calls: string[] = [];
    const reports: any[] = [];
    const t = new EditDiagnosticsTracker({
      worktree: '/wt', execShell: shell({ tsc: 'src/a.ts(1,1): error TS2322: bad.' }, calls), config: CFG as any, sessionId: 's1',
      onReport: (r) => reports.push(r), debounceMs: 5,
    });
    t.noteEdit('backend/src/a.ts');
    t.noteEdit('./backend/src/b.ts');
    expect(t.takeNote()).toBeNull(); // nothing yet — the pass runs after the debounce
    await t.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^export NODE_OPTIONS="--max-old-space-size=4096"; cd backend && npx tsc --noEmit --incremental --tsBuildInfoFile/);
    expect(calls[0]).toMatch(/; echo "__DIGBY_EXIT__ \$\?"$/);
    const note = t.takeNote()!;
    expect(note).toContain('after your edits to backend/src/a.ts, backend/src/b.ts');
    expect(note).toContain('typecheck: 1 diagnostic(s) in the files you touched');
    expect(t.takeNote()).toBeNull(); // consumed once
    expect(reports).toHaveLength(1);
    expect(reports[0].stages[0]).toMatchObject({ key: 'typecheck', exitCode: 2, otherCount: 0 });
  });

  it('an edit that lands DURING a pass queues exactly one re-run; dispose stops everything', async () => {
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const execShell = async (command: string) => { calls.push(command); await gate; return { stdout: '\n__DIGBY_EXIT__ 0', stderr: '' }; };
    const t = new EditDiagnosticsTracker({ worktree: '/wt', execShell, config: CFG as any, sessionId: 's1', debounceMs: 1 });
    t.noteEdit('a.ts');
    await new Promise((r) => setTimeout(r, 10)); // debounce fired → pass in flight, blocked on the gate
    expect(calls).toHaveLength(1);
    t.noteEdit('b.ts'); t.noteEdit('c.ts'); // land during the pass
    release();
    await t.flush();
    await new Promise((r) => setTimeout(r, 15));
    expect(calls).toHaveLength(2); // ONE re-run for both late edits
    expect(t.takeNote()).toContain('✓ clean');
    t.dispose();
    t.noteEdit('d.ts');
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toHaveLength(2); // disposed: no further passes
  });

  it('a missing tool (exit 127 / "not found" / "No module named") reads as SKIPPED — even when the shell rejects and the real marker sits before the error text', async () => {
    const calls: string[] = [];
    const rejecting = async (command: string) => {
      calls.push(command);
      throw Object.assign(new Error('Command failed'), { stdout: 'sh: 1: ruff: not found\n__DIGBY_EXIT__ 127\n', stderr: '\n[exit: 127]' });
    };
    const reports: any[] = [];
    const t = new EditDiagnosticsTracker({ worktree: '/wt', execShell: rejecting, config: { commands: { lint: 'ruff check .' } } as any, sessionId: 's1', debounceMs: 1, onReport: (r) => reports.push(r) });
    t.noteEdit('pkg/a.py');
    await t.flush();
    expect(reports[0].stages[0]).toMatchObject({ key: 'lint', exitCode: 127, skipped: true, touchedLines: [], otherCount: 0 });
    expect(reports[0].stages[0].tail).toContain('ruff: not found');
    expect(t.takeNote()).toContain('lint: could not run (tool not installed here)');
    // "No module named" with a plain exit 1 is a missing tool too.
    const noModule = async () => ({ stdout: "/usr/bin/python3: No module named mypy\n__DIGBY_EXIT__ 1", stderr: '' });
    const t2 = new EditDiagnosticsTracker({ worktree: '/wt', execShell: noModule, config: { commands: { typecheck: 'mypy .' } } as any, sessionId: 's1', debounceMs: 1, onReport: (r) => reports.push(r) });
    t2.noteEdit('pkg/a.py');
    await t2.flush();
    expect(reports[1].stages[0]).toMatchObject({ key: 'typecheck', skipped: true });
  });

  it('a command the derivation cannot scope produces no pass and no note', async () => {
    const calls: string[] = [];
    const t = new EditDiagnosticsTracker({ worktree: '/wt', execShell: shell({}, calls), config: { commands: { typecheck: 'go vet ./...' } } as any, sessionId: 's1', debounceMs: 1 });
    t.noteEdit('a.go');
    await t.flush();
    expect(calls).toHaveLength(0);
    expect(t.takeNote()).toBeNull();
  });
});
