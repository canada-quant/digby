/**
 * Audit 2026-10-06 T6-5 — the pure dispatch / coordination turn detector
 * (dispatch-turn.ts). The chat-lane wiring (checker stopped, no reconcile,
 * pill skipped) is pinned in chat-agent.compute-policy.test.ts.
 */
import { DISPATCH_TOOLS, DISPATCH_TURN_READ_TOOLS, dispatchOnlyTurnTools, dispatchTurnSkipDisabled } from './dispatch-turn';
import { PLATFORM_TOOL_NAMES } from '../platform/platform-tool-names';

const call = (name: string) => ({ type: 'tool_call', name });

beforeEach(() => { delete process.env.CROSSCHECK_DISPATCH_SKIP_DISABLED; });

describe('dispatchOnlyTurnTools', () => {
  it('a turn whose only work was coordination (after platform reads) is a dispatch turn — the coordination tools are named once each', () => {
    expect(dispatchOnlyTurnTools([call('get_chat_status'), call('send_chat_message'), { type: 'tool_result', name: 'send_chat_message' }, call('todo_update'), call('send_chat_message')]))
      .toEqual(['send_chat_message', 'todo_update']);
    expect(dispatchOnlyTurnTools([call('start_coding_session')])).toEqual(['start_coding_session']);
    expect(dispatchOnlyTurnTools([call('load_tools'), call('update_supervisor_state')])).toEqual(['update_supervisor_state']);
  });
  it('research, connector or content work keeps the checker (null)', () => {
    expect(dispatchOnlyTurnTools([call('search_engine'), call('send_chat_message')])).toBeNull();
    expect(dispatchOnlyTurnTools([call('scrape_as_markdown'), call('todo_create')])).toBeNull();
    expect(dispatchOnlyTurnTools([call('gmail_search'), call('send_chat_message')])).toBeNull();
    expect(dispatchOnlyTurnTools([call('remember_fact')])).toBeNull();
    expect(dispatchOnlyTurnTools([call('create_document'), call('send_chat_message')])).toBeNull();
  });
  it('reads only, no tool at all, or empty parts ⇒ not a dispatch turn', () => {
    expect(dispatchOnlyTurnTools([call('get_chat_status'), call('goal_list')])).toBeNull();
    expect(dispatchOnlyTurnTools([{ type: 'text' }])).toBeNull();
    expect(dispatchOnlyTurnTools([])).toBeNull();
    expect(dispatchOnlyTurnTools(undefined)).toBeNull();
  });
  it('every name it treats as dispatch or as a read is a real platform tool (or a harness helper)', () => {
    const helpers = new Set(['load_tools', 'list_tool_groups', 'load_tool_group', 'update_plan']);
    for (const n of [...DISPATCH_TOOLS, ...DISPATCH_TURN_READ_TOOLS]) {
      if (helpers.has(n)) continue;
      expect(PLATFORM_TOOL_NAMES).toContain(n);
    }
  });
  it('CROSSCHECK_DISPATCH_SKIP_DISABLED=1 ⇒ never a dispatch turn (the checker reconciles as before)', () => {
    expect(dispatchTurnSkipDisabled()).toBe(false);
    process.env.CROSSCHECK_DISPATCH_SKIP_DISABLED = '1';
    expect(dispatchTurnSkipDisabled()).toBe(true);
    expect(dispatchOnlyTurnTools([call('send_chat_message')])).toBeNull();
  });
});
