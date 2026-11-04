/**
 * PIN — dispatched task (2026-10-01 23:49Z, msg 14656eec): the verify tool answered
 * "No verify chain configured" for canada-quant/tt-rd whose .digby/config.json was
 * git-tracked, on disk, with green commands in BOTH forms (commands.* map + verify[]
 * array). Root cause: resolveVerifyChain expects verify[] to be string[] keys into
 * `commands`; tt-rd (hand-authored) carries the OBJECT form [{name, command}] —
 * JS coerces each entry to "[object Object]", commands["[object Object]"] is
 * undefined, and the chain comes back EMPTY — the exact "no runnable commands"
 * answer, silently, with a config that verifiably has commands.
 *
 * The fix (this file's GREEN twin below): resolveVerifyChain accepts BOTH shapes —
 * string keys (canonical, scaffolded) and {name, command} entries (resolves by
 * `name` into commands, else by inline `command`). Object entries whose command is
 * NOT in commands.* still run (self-describing), which is the whole point of the
 * belt-and-braces form a hand-authored repo writes.
 */
import { resolveVerifyChain, type DigbyConfig } from './verify.service';

// Same mock preamble as verify-unverified.v1-30.test.ts: verify.service imports
// logger → env.ts, which parses/validates process.env at import time and
// process.exit(1)s in the jest environment (no DATABASE_URL). Mock the logger
// so importing the service never drags env validation into the test.
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

/** Byte-faithful shape of tt-rd's .digby/config.json as dispatched in the task
 *  (config.json read verbatim from the worktree in the reporting run). */
const TT_RD_CONFIG = {
  version: 1,
  defaultBranch: 'main',
  stack: null,
  commands: {
    install: null,
    dev: null,
    build: null,
    test: 'python3 -m pytest tests/ -q',
    testOne: 'python3 -m pytest tests/test_verify_chain.py -q',
    typecheck: 'python3 scripts/verify/check_py_compile.py',
    lint: 'bash scripts/verify/check_sh_syntax.sh',
  },
  verify: [
    { name: 'typecheck', command: 'python3 scripts/verify/check_py_compile.py' },
    { name: 'lint', command: 'bash scripts/verify/check_sh_syntax.sh' },
    { name: 'test', command: 'python3 -m pytest tests/ -q' },
  ],
  docsHash: '…',
  verified: false,
  loop: { maxAutoVerifyIterations: 3, resumeStepBudget: 8, perCommandTimeoutMs: 300000, sameFailureStop: 2, oscillationWindow: 4, gatePullRequest: true },
  ignore: '.digbyignore',
} as unknown as DigbyConfig;

describe('resolveVerifyChain — object-form verify[] (tt-rd pin)', () => {
  test('THE DEFECT: object-form verify[] resolved to a 3-stage chain, not []', () => {
    // Before the fix this returned [] → verify tool: "No verify chain configured".
    const chain = resolveVerifyChain(TT_RD_CONFIG);
    expect(chain).toHaveLength(3);
    expect(chain.map(s => s.key)).toEqual(['typecheck', 'lint', 'test']);
    expect(chain.map(s => s.command)).toEqual([
      'python3 scripts/verify/check_py_compile.py',
      'bash scripts/verify/check_sh_syntax.sh',
      'python3 -m pytest tests/ -q',
    ]);
  });

  test('object entries resolve by name into commands.*, preserving array order', () => {
    const cfg = {
      commands: { typecheck: 'tsc --noEmit', lint: 'eslint .', test: 'jest' },
      verify: [{ name: 'lint' }, { name: 'typecheck' }, { name: 'test' }],
    } as unknown as DigbyConfig;
    expect(resolveVerifyChain(cfg).map(s => [s.key, s.command])).toEqual([
      ['lint', 'eslint .'],
      ['typecheck', 'tsc --noEmit'],
      ['test', 'jest'],
    ]);
  });

  test('object entry with an inline command runs even when commands.* lacks the key', () => {
    const cfg = {
      commands: { typecheck: 'tsc --noEmit' },
      verify: [{ name: 'device-e2e', command: 'python3 -m pytest tests/test_gdn.py -q' }],
    } as unknown as DigbyConfig;
    const chain = resolveVerifyChain(cfg);
    expect(chain).toEqual([
      { key: 'device-e2e', command: 'python3 -m pytest tests/test_gdn.py -q' },
    ]);
  });

  test('object entry with neither a resolvable command nor an inline command is dropped', () => {
    const cfg = {
      commands: { test: 'jest' },
      verify: [{ name: 'ghost' }, 'test', { command: '' }, {}],
    } as unknown as DigbyConfig;
    expect(resolveVerifyChain(cfg).map(s => s.key)).toEqual(['test']);
  });

  test('only= filters object-form entries by name (verify.service only param)', () => {
    const cfg = {
      commands: { typecheck: 'tsc --noEmit', test: 'jest' },
      verify: [{ name: 'typecheck' }, { name: 'test' }],
    } as unknown as DigbyConfig;
    expect(resolveVerifyChain(cfg, ['test']).map(s => s.key)).toEqual(['test']);
    // only= with a key NOT in the chain → empty (same as string form).
    expect(resolveVerifyChain(cfg, ['lint'])).toEqual([]);
  });

  test('verified:false does NOT gate chain discovery', () => {
    // tt-rd carries verified:false; the reader must still find the chain —
    // `verified` marks human confirmation of the SCAFFOLD, not chain presence.
    const cfg = { commands: { test: 'jest' }, verified: false } as unknown as DigbyConfig;
    expect(resolveVerifyChain(cfg).map(s => s.key)).toEqual(['test']);
  });

  test('mixed forms: strings and objects in the same verify[]', () => {
    const cfg = {
      commands: { typecheck: 'tsc --noEmit', lint: 'eslint .', test: 'jest' },
      verify: ['typecheck', { name: 'lint' }, { name: 'test', command: 'npx jest --silent' }],
    } as unknown as DigbyConfig;
    // name-matched commands.* wins over the inline command (single source of truth).
    expect(resolveVerifyChain(cfg).map(s => s.command)).toEqual([
      'tsc --noEmit', 'eslint .', 'jest',
    ]);
  });
});
