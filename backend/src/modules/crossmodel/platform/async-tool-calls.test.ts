/**
 * SAA-1.6 PHASE 3b (todo e49dfd07, goal d605db05) — the async-tool eligibility leaf.
 *
 * These tests pin THE PROPERTIES THE GATE DEPENDS ON, and each is written so it
 * FAILS on the naive implementation rather than merely passing on this one:
 *
 *   1. The threshold is a MEASURED elapsed bar, not a predicted duration. A tool
 *      is eligible because of what CLASS it is in, never because someone guessed
 *      how long this particular call would take — the Phase-3a mistake that
 *      wrongly excluded `run_command` and computer use.
 *   2. `run_command`, `computer_task` and `browser_task` ARE eligible, and
 *      `wait_for_chat` still is. A regression that narrows the set back to the
 *      declared-duration rule turns this red.
 *   3. `applied` is a real boolean and follows the switch: TRUE only in `apply`
 *      mode. In the default observe mode a deploy can never change the loop's
 *      timing.
 *   4. The kill switch wins over everything and reports `kill_switch`.
 *   5. `wait_for_chat`'s own bound is still clamped to the 600 s cap (it is a
 *      diagnostic now, but it is the number the loop can never exceed).
 *
 * The last test pins the two local constants against `platform/coord-tools.ts`
 * by SOURCE assertion, because importing that module pulls in chat-images and a
 * large tool surface into a leaf that must stay import-free.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ASYNC_TOOL_AFTER_MS,
  ASYNC_TOOL_ELIGIBLE_CLASSES,
  asyncToolCallsDisabled,
  asyncToolCallsMode,
  asyncToolStartedText,
  declaredDurationMs,
  isAsyncToolEligibleClass,
  planAsyncToolCall,
} from './async-tool-calls';

const ENV_ON = { ASYNC_TOOL_CALLS_DISABLED: '1' };
const ENV_APPLY = { ASYNC_TOOL_CALLS_DISABLED: 'apply' };
const ENV_UNSET = {};

describe('SAA-1.6 async-tool-calls — eligibility is a tool CLASS, measured against an elapsed bar', () => {
  it('the threshold is 60 s and it is an ELAPSED bar', () => {
    expect(ASYNC_TOOL_AFTER_MS).toBe(60_000);
    expect(planAsyncToolCall({ tool: 'wait_for_chat', args: {}, env: ENV_UNSET }).afterMs).toBe(60_000);
  });

  it('EVERY long-capable class is eligible — including run_command and computer use', () => {
    // The Phase-3b correction. A cut that reintroduces the declared-duration
    // rule drops run_command/computer_task/browser_task back to not_in_class
    // and turns this red.
    for (const tool of ['wait_for_chat', 'run_command', 'computer_task', 'browser_task']) {
      const p = planAsyncToolCall({ tool, args: {}, env: ENV_UNSET });
      expect(p.eligible).toBe(true);
      expect(p.reason).toBe('eligible_elapsed');
    }
  });

  it('eligibility NEVER depends on an argument guess — a run_command with any command is eligible', () => {
    // There is no duration to declare, so nothing about the args may gate it.
    for (const command of ['ls', 'sleep 300', '', 'npm run build']) {
      expect(planAsyncToolCall({ tool: 'run_command', args: { command }, env: ENV_UNSET }).eligible).toBe(true);
    }
  });

  it('a tool OUTSIDE the class is never eligible, whatever its arguments say', () => {
    for (const tool of ['read_file', 'search_memory', 'finish_run', 'goal_update']) {
      const p = planAsyncToolCall({ tool, args: { timeoutSec: 600 }, env: ENV_UNSET });
      expect(p.eligible).toBe(false);
      expect(p.reason).toBe('not_in_class');
      expect(p.applied).toBe(false);
    }
  });

  it('the eligible set is closed and is exactly the four long-capable classes', () => {
    expect([...ASYNC_TOOL_ELIGIBLE_CLASSES]).toEqual(['wait_for_chat', 'run_command', 'computer_task', 'browser_task']);
    expect(isAsyncToolEligibleClass('run_command')).toBe(true);
    expect(isAsyncToolEligibleClass('computer_task')).toBe(true);
    expect(isAsyncToolEligibleClass('read_file')).toBe(false);
  });
});

describe('SAA-1.6 async-tool-calls — applied follows the switch (a deploy cannot change timing by default)', () => {
  it('OBSERVE (default / unset) reports applied:false even for an eligible call', () => {
    const p = planAsyncToolCall({ tool: 'run_command', args: {}, env: ENV_UNSET });
    expect(p.eligible).toBe(true);
    expect(p.applied).toBe(false);
    expect(p.mode).toBe('observe');
  });

  it('APPLY reports applied:true — this is the armed path', () => {
    const p = planAsyncToolCall({ tool: 'run_command', args: {}, env: ENV_APPLY });
    expect(p.applied).toBe(true);
    expect(p.mode).toBe('apply');
  });

  it('junk values in the switch FAIL SAFE to observe — never to armed', () => {
    for (const junk of ['', '0', 'yes', 'maybe', 'APPLY!!', 'undefined']) {
      expect(asyncToolCallsMode({ ASYNC_TOOL_CALLS_DISABLED: junk })).toBe('observe');
      expect(planAsyncToolCall({ tool: 'run_command', args: {}, env: { ASYNC_TOOL_CALLS_DISABLED: junk } }).applied).toBe(false);
    }
  });

  it('the apply spellings are accepted case-insensitively', () => {
    for (const v of ['apply', 'APPLY', 'rewrite', ' Rewrite ']) {
      expect(asyncToolCallsMode({ ASYNC_TOOL_CALLS_DISABLED: v })).toBe('apply');
    }
  });
});

describe('SAA-1.6 async-tool-calls — the kill switch restores blocking exactly', () => {
  it("'1' / 'true' / 'on' (any case, trimmed) all mean OFF", () => {
    for (const v of ['1', 'true', 'TRUE', 'on', ' On ', '  1  ']) {
      expect(asyncToolCallsDisabled({ ASYNC_TOOL_CALLS_DISABLED: v })).toBe(true);
      expect(asyncToolCallsMode({ ASYNC_TOOL_CALLS_DISABLED: v })).toBe('off');
    }
  });

  it('a kill-switched call is neither eligible NOR applied, and says so', () => {
    const p = planAsyncToolCall({ tool: 'run_command', args: {}, env: ENV_ON });
    expect(p.eligible).toBe(false);
    expect(p.applied).toBe(false);
    expect(p.reason).toBe('kill_switch');
    expect(p.mode).toBe('off');
  });

  it('the kill switch BEATS the apply value — "1" never arms', () => {
    // A switch set to '1' means today's behaviour, full stop, whatever else the
    // string could be read as.
    expect(planAsyncToolCall({ tool: 'wait_for_chat', args: {}, env: { ASYNC_TOOL_CALLS_DISABLED: '1' } }).applied).toBe(false);
  });
});

describe('SAA-1.6 async-tool-calls — wait_for_chat stays bounded (diagnostic, not a gate)', () => {
  it('the declared bound is the timeout, clamped to the 600 s ceiling', () => {
    expect(declaredDurationMs('wait_for_chat', { timeoutSec: 600 })).toBe(600_000);
    expect(declaredDurationMs('wait_for_chat', { timeoutSec: 9_999 })).toBe(600_000);
  });

  it('a junk / non-positive timeout falls back to the tool default (the plan never disagrees with the handler)', () => {
    for (const bad of [0, -5, Number.NaN, 'abc', null, undefined]) {
      expect(declaredDurationMs('wait_for_chat', { timeoutSec: bad })).toBe(120_000);
    }
  });

  it('tools that declare no bound report null — and that no longer affects eligibility', () => {
    expect(declaredDurationMs('run_command', {})).toBeNull();
    expect(planAsyncToolCall({ tool: 'run_command', args: {}, env: ENV_UNSET }).declaredMs).toBeNull();
    // ...but it is still eligible: the elapsed bar, not a declared bound, decides.
    expect(planAsyncToolCall({ tool: 'run_command', args: {}, env: ENV_UNSET }).eligible).toBe(true);
  });

  it('the local constants match platform/coord-tools.ts (source pin: a drift would be invisible to a unit test)', () => {
    const coord = readFileSync(join(__dirname, 'coord-tools.ts'), 'utf8');
    expect(coord).toMatch(/WAIT_FOR_CHAT_MAX_SEC\s*=\s*600\b/);
    expect(coord).toMatch(/WAIT_FOR_CHAT_DEFAULT_SEC\s*=\s*120\b/);
  });
});

describe('SAA-1.6 async-tool-calls — the "Started" text the model reads', () => {
  it('names the correlation id, says it is still running, and forbids a duplicate call', () => {
    const text = asyncToolStartedText('run_command', 'att_abc123def456', 60_000);
    expect(text).toContain('att_abc123def456'); // the id the delivered event is joined on
    expect(text).toContain('started');
    expect(text).toContain('60s');
    expect(text).toContain('[BACKGROUND TOOL RESULT]'); // what to expect next
    // The load-bearing sentence: re-calling would run the side effect twice.
    expect(text).toMatch(/Do NOT call run_command again/);
  });
});