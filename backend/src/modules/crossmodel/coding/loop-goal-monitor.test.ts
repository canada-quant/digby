/**
 * Tests for the loop/goal/monitor primitives:
 *  - plan.service   (GOAL): normalization, one-in-progress, goal retention, mirror
 *  - verify.service (LOOP): chain resolution, fail-fast, failure signatures
 *  - process.service(MONITOR): start/read/list parsing + handle cap (mocked execShell)
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// In-memory context store so plan persistence works without a DB.
const _store = new Map<string, any>();
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async (ns: string[], key: string) => _store.get(ns.join('/') + '::' + key) ?? null),
  storePut: jest.fn(async (ns: string[], key: string, value: any) => { _store.set(ns.join('/') + '::' + key, value); }),
}));

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { applyPlan, getPlan, planToUpdate, renderPlanReminder, MAX_PLAN_STEPS } from './plan.service';
import {
  resolveVerifyChain, runVerifyChain, failureSignature, loopConfig, DEFAULT_LOOP,
} from './verify.service';
import {
  startBackgroundProcess, readProcessOutput, listProcesses, clearProcessRegistry,
} from './process.service';

async function tmp(): Promise<string> { return fs.mkdtemp(path.join(os.tmpdir(), 'digby-lgm-')); }
beforeEach(() => _store.clear());

// ── GOAL ─────────────────────────────────────────────────────────────────────
describe('plan.service (GOAL)', () => {
  test('assigns ids, keeps one in_progress, persists, mirrors todo.md', async () => {
    const wt = await tmp();
    const { plan, warnings } = await applyPlan('s1', wt, {
      goal: 'Add auth', acceptance_criteria: ['login works'],
      steps: [
        { text: 'a', status: 'completed' },
        { text: 'b', status: 'in_progress' },
        { text: 'c', status: 'in_progress' }, // second in_progress → demoted
      ],
      explanation: 'start',
    });
    expect(plan.steps.map(s => s.id)).toEqual([1, 2, 3]);
    expect(plan.steps.filter(s => s.status === 'in_progress')).toHaveLength(1);
    expect(plan.steps[1].status).toBe('in_progress');
    expect(plan.steps[2].status).toBe('pending');
    expect(warnings.join(' ')).toMatch(/one step/i);
    // persisted + mirrored
    expect(await getPlan('s1')).toMatchObject({ goal: 'Add auth' });
    const md = await fs.readFile(path.join(wt, '.digby', 'session', 'todo.md'), 'utf8');
    expect(md).toContain('# Goal');
    expect(md).toContain('Add auth');
    // session scratch is git-ignored
    expect(await fs.readFile(path.join(wt, '.digby', 'session', '.gitignore'), 'utf8')).toContain('*');
    await fs.rm(wt, { recursive: true, force: true });
  });

  test('retains goal when a later update omits it', async () => {
    const wt = await tmp();
    await applyPlan('s2', wt, { goal: 'Keep me', steps: [{ text: 'x', status: 'in_progress' }] });
    const { plan } = await applyPlan('s2', wt, { steps: [{ text: 'x', status: 'completed' }] });
    expect(plan.goal).toBe('Keep me');
    expect(plan.version).toBe(2);
    await fs.rm(wt, { recursive: true, force: true });
  });

  test('caps overly long plans', async () => {
    const wt = await tmp();
    const steps = Array.from({ length: 20 }, (_, i) => ({ text: `s${i}`, status: 'pending' }));
    const { plan, warnings } = await applyPlan('s3', wt, { goal: 'g', steps });
    expect(plan.steps.length).toBe(MAX_PLAN_STEPS);
    expect(warnings.join(' ')).toMatch(/split/i);
    await fs.rm(wt, { recursive: true, force: true });
  });

  // Sidebar user-edits go through planToUpdate → applyPlan (same path as the agent).
  test('planToUpdate round-trips a stored plan; appending a user todo keeps goal + statuses', async () => {
    const wt = await tmp();
    await applyPlan('u1', wt, {
      goal: 'Ship', acceptance_criteria: ['a'],
      steps: [{ text: 'one', status: 'completed' }, { text: 'two', status: 'in_progress' }],
    });
    // Replicates coding.controller addTodo transform.
    const u = planToUpdate(await getPlan('u1'));
    u.steps.push({ text: 'three', status: 'pending' });
    const { plan } = await applyPlan('u1', wt, u);
    expect(plan.goal).toBe('Ship');
    expect(plan.acceptanceCriteria).toEqual(['a']);
    expect(plan.steps.map(s => s.text)).toEqual(['one', 'two', 'three']);
    expect(plan.steps.map(s => s.status)).toEqual(['completed', 'in_progress', 'pending']);
    await fs.rm(wt, { recursive: true, force: true });
  });

  test('user setting a step in_progress reassigns the active step (no demotion warning)', async () => {
    const wt = await tmp();
    await applyPlan('u2', wt, {
      goal: 'g', steps: [{ text: 'one', status: 'in_progress' }, { text: 'two', status: 'pending' }],
    });
    // Replicates coding.controller setTodoStatus(step 2 → in_progress).
    const u = planToUpdate(await getPlan('u2'));
    u.steps.forEach(s => { if (s.status === 'in_progress') s.status = 'pending'; });
    u.steps[1].status = 'in_progress';
    const { plan, warnings } = await applyPlan('u2', wt, u);
    expect(plan.steps.map(s => s.status)).toEqual(['pending', 'in_progress']);
    expect(warnings).toHaveLength(0);
    await fs.rm(wt, { recursive: true, force: true });
  });

  test('reminder rendering', () => {
    const r = renderPlanReminder(
      { goal: 'Ship it', acceptanceCriteria: ['tests pass'], version: 1, updatedAt: '', steps: [{ id: 1, text: 'do', status: 'in_progress' }] },
      { step: 5, maxSteps: 40, nudge: 'focus' },
    );
    expect(r).toContain('GOAL: Ship it');
    expect(r).toContain('step 5/40');
    expect(r).toContain('← HERE');
    expect(r).toContain('NUDGE: focus');
  });
});

// ── LOOP ─────────────────────────────────────────────────────────────────────
describe('verify.service (LOOP)', () => {
  test('resolveVerifyChain follows verify order, drops missing commands', () => {
    const cfg = { commands: { typecheck: 'tsc', lint: null, test: 'jest' }, verify: ['typecheck', 'lint', 'test'] };
    expect(resolveVerifyChain(cfg).map(c => c.key)).toEqual(['typecheck', 'test']);
    expect(resolveVerifyChain(cfg, ['test']).map(c => c.key)).toEqual(['test']);
  });

  test('runVerifyChain is cheapest-first + fail-fast', async () => {
    const calls: string[] = [];
    const exec = async (cmd: string) => {
      calls.push(cmd);
      const fail = cmd.includes('lint');
      return { stdout: `output\n__DIGBY_EXIT__ ${fail ? 1 : 0}`, stderr: '' };
    };
    const chain = [{ key: 'typecheck', command: 'tsc' }, { key: 'lint', command: 'eslint' }, { key: 'test', command: 'jest' }];
    const r = await runVerifyChain(exec as any, '/wt', chain, 1000);
    expect(r.passed).toBe(false);
    expect(r.failedStage).toBe('lint');
    // stopped before test (the env-guard REAP preamble mentions jest — exclude it)
    expect(calls.some(c => c.includes('jest') && !c.includes('pgrep'))).toBe(false);
    expect(r.stages.map(s => s.key)).toEqual(['typecheck', 'lint']);
  });

  test('runVerifyChain passes when all stages exit 0', async () => {
    const exec = async () => ({ stdout: 'ok\n__DIGBY_EXIT__ 0', stderr: '' });
    const r = await runVerifyChain(exec as any, '/wt', [{ key: 'test', command: 'jest' }], 1000);
    expect(r.passed).toBe(true);
    expect(r.failedStage).toBeNull();
  });

  test('a MISSING tool is skipped (not failed) so the chain continues', async () => {
    // lint: ruff not installed → exit 127; test: passes. Chain should PASS with lint skipped.
    const exec = async (cmd: string) => cmd.includes('ruff')
      ? ({ stdout: 'bash: ruff: command not found\n__DIGBY_EXIT__ 127', stderr: '' })
      : ({ stdout: 'ok\n__DIGBY_EXIT__ 0', stderr: '' });
    const r = await runVerifyChain(exec as any, '/wt',
      [{ key: 'lint', command: 'ruff check .' }, { key: 'test', command: 'jest' }], 1000);
    expect(r.passed).toBe(true);
    expect(r.failedStage).toBeNull();
    expect(r.stages.find(s => s.key === 'lint')?.skipped).toBe(true);
    expect(r.stages.find(s => s.key === 'test')?.passed).toBe(true); // ran after the skip
  });

  test('"No module named" (python -m <tool> missing) is also skipped', async () => {
    const exec = async () => ({ stdout: 'No module named ruff\n__DIGBY_EXIT__ 1', stderr: '' });
    const r = await runVerifyChain(exec as any, '/wt', [{ key: 'lint', command: 'python3 -m ruff check' }], 1000);
    expect(r.passed).toBe(true);
    expect(r.stages[0].skipped).toBe(true);
  });

  test('failureSignature is stable across line numbers/timestamps', () => {
    const a = failureSignature('lint', 'src/x.ts:42:7 error at 12:00:00');
    const b = failureSignature('lint', 'src/x.ts:99:3 error at 15:30:11');
    expect(a).toBe(b);
    const c = failureSignature('test', 'src/x.ts:42:7 error');
    expect(a).not.toBe(c);
  });

  test('loopConfig merges defaults', () => {
    expect(loopConfig(null)).toEqual(DEFAULT_LOOP);
    expect(loopConfig({ loop: { maxAutoVerifyIterations: 5 } }).maxAutoVerifyIterations).toBe(5);
    expect(loopConfig({ loop: { maxAutoVerifyIterations: 5 } }).resumeStepBudget).toBe(DEFAULT_LOOP.resumeStepBudget);
  });
});

// ── MONITOR ────────────────────────────────────────────────────────────────────
describe('process.service (MONITOR)', () => {
  afterEach(() => clearProcessRegistry('m1'));

  test('start returns a handle and parses pgid', async () => {
    const exec = async () => ({ stdout: 'pgid=4242', stderr: '' });
    const r = await startBackgroundProcess(exec as any, 'm1', { command: 'npm run dev' });
    expect(r.handle).toMatch(/^p/);
    expect(r.pgid).toBe('4242');
    expect(r.error).toBeUndefined();
  });

  test('enforces the max-handles cap against confirmed-LIVE processes', async () => {
    const exec = async () => ({ stdout: 'pgid=1', stderr: '' });
    const handles: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await startBackgroundProcess(exec as any, 'm1', { command: `cmd${i}` });
      handles.push(r.handle);
    }
    // Ticket d2531cf5: the cap auto-reaps dead entries first — the error fires
    // only when the ground-truth probe confirms all 5 are LIVE (success
    // sentinel included: a probe without it is treated as failed, reap-nothing).
    const liveExec = async (cmd: string) => String(cmd).includes('kill -0')
      ? { stdout: `${handles.join('\n')}\n__DIGBY_REAP_OK__\n`, stderr: '' }
      : { stdout: 'pgid=1', stderr: '' };
    const sixth = await startBackgroundProcess(liveExec as any, 'm1', { command: 'too many' });
    expect(sixth.error).toMatch(/Too many/);
  });

  test('read parses new output + ground-truth status + offset', async () => {
    const exec = async () => ({ stdout: 'line1\nline2\n__DIGBY_META__ status=running size=128', stderr: '' });
    const r = await readProcessOutput(exec as any, 'm1', 'pX', { sinceOffset: 0 });
    expect(r.status).toBe('running');
    expect(r.nextOffset).toBe(128);
    expect(r.chunk).toContain('line1');
    expect(r.chunk).not.toContain('__DIGBY_META__');
  });

  test('read reports not_found for a missing handle', async () => {
    const exec = async () => ({ stdout: '__DIGBY_NF__', stderr: '' });
    const r = await readProcessOutput(exec as any, 'm1', 'gone', {});
    expect(r.notFound).toBe(true);
  });

  test('list parses handle rows', async () => {
    const exec = async () => ({ stdout: 'p1|running|64|npm run dev\np2|exited:0|10|make build', stderr: '' });
    const procs = await listProcesses(exec as any, 'm1');
    expect(procs).toHaveLength(2);
    expect(procs[0]).toMatchObject({ handle: 'p1', status: 'running', bytes: 64 });
    expect(procs[1].command).toContain('make build');
  });
});

// ── MONITOR: wait_for_process_output (2026-07-14) ────────────────────────────
describe('process.service waitForProcessOutput (MONITOR wait primitive)', () => {
  const { waitForProcessOutput } = require('./process.service');

  it('reports matched when the shell wait finds the pattern', async () => {
    const { startBackgroundProcess } = require('./process.service');
    const started = await startBackgroundProcess(async () => ({ stdout: 'pgid=1', stderr: '' }), 'sw1', { command: 'sleep 60', name: 'x' });
    const execShell = jest.fn(async () => ({ stdout: 'MATCHED\n', stderr: '' }));
    const r = await waitForProcessOutput(execShell, 'sw1', started.handle, { logMatch: 'Ready in' });
    expect(r.outcome).toBe('matched');
    // The wait runs IN THE SESSION SHELL (one tool call, no Node-side polling).
    expect(String((execShell.mock.calls as any[])[0][0])).toContain('sleep 1');
  });

  it('reports exited with the code when the process ends first', async () => {
    const { startBackgroundProcess } = require('./process.service');
    const started = await startBackgroundProcess(async () => ({ stdout: 'pgid=1', stderr: '' }), 'sw2', { command: 'true', name: 'y' });
    const execShell = jest.fn(async () => ({ stdout: 'EXITED 0\n', stderr: '' }));
    const r = await waitForProcessOutput(execShell, 'sw2', started.handle, {});
    expect(r.outcome).toBe('exited');
    expect(r.exitCode).toBe('0');
  });

  it('unknown handle → not_found via the on-disk __DIGBY_NF__ probe (ticket d2531cf5)', async () => {
    // Existence is now judged by on-disk ground truth, not the in-memory
    // registry — an exited-but-real handle from a previous turn must resolve.
    const execShell = jest.fn(async () => ({ stdout: '__DIGBY_NF__\n', stderr: '' }));
    const r = await waitForProcessOutput(execShell, 'sw3', 'nope', {});
    expect(r.outcome).toBe('not_found');
  });
});
