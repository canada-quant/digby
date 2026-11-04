import { toolFamilyProfile, workedAlone, runDidWrite, TOOL_PROFILE_DISTINCT_CAP } from './tool-profile';

const call = (name: string) => ({ type: 'tool_call', name, args: {} });

describe('toolFamilyProfile (owner 2026-09-19: which lanes work alone and offline)', () => {
  it('counts each family over tool_call parts only, tolerates junk, and lists distinct names', () => {
    const parts = [
      call('run_command'), call('run_command'), call('update_plan'),
      call('search_memory'), call('web_pipe'), call('search_engine'),
      call('delegate_parallel'), call('start_coding_session'), call('send_chat_message'),
      call('gmail_search'), call('slack_search'),
      { type: 'tool_result', name: 'run_command' }, { type: 'text', text: 'done' }, null, 'junk', { type: 'tool_call' },
    ];
    const p = toolFamilyProfile(parts);
    expect(p).toMatchObject({ calls: 11, memory: 1, web: 2, delegate: 1, spawn: 1, messages: 1, connectors: 2, runCommand: 2 });
    expect(p.distinct).toEqual(['delegate_parallel', 'gmail_search', 'run_command', 'search_engine', 'search_memory', 'send_chat_message', 'slack_search', 'start_coding_session', 'update_plan', 'web_pipe']);
    expect(workedAlone(p)).toBe(false);
  });

  it('a run_command-only run reads as working alone; an empty run is alone too', () => {
    const p = toolFamilyProfile([call('run_command'), call('update_plan'), call('todo_update')]);
    expect(p).toMatchObject({ calls: 3, memory: 0, web: 0, delegate: 0, spawn: 0, runCommand: 1 });
    expect(workedAlone(p)).toBe(true);
    expect(workedAlone(toolFamilyProfile([]))).toBe(true);
    expect(workedAlone(toolFamilyProfile(null))).toBe(true);
  });

  it('counts code / git / platform writes orthogonally to the families (option D label)', () => {
    const platformMutating = new Set(['send_chat_message', 'goal_update']);
    const parts = [call('read_file'), call('edit_file'), call('write_file'), call('git_commit'), call('open_pull_request'),
      call('send_chat_message'), call('goal_update'), call('run_command')];
    const p = toolFamilyProfile(parts, { platformMutating });
    expect(p).toMatchObject({ calls: 8, codeWrites: 2, gitWrites: 2, platformWrites: 2, messages: 1, runCommand: 1 });
    expect(runDidWrite(p)).toBe(true);
    // without the caller's set, platform writes read 0 (the leaf stays import-free)
    expect(toolFamilyProfile(parts).platformWrites).toBe(0);
  });

  it('a read-only firing (reads + run_command) did not write; a delegate counts as work', () => {
    const ro = toolFamilyProfile([call('read_file'), call('run_command'), call('get_plan')], { platformMutating: new Set(['goal_update']) });
    expect(runDidWrite(ro)).toBe(false);
    expect(runDidWrite(toolFamilyProfile([call('delegate')]))).toBe(true);
    expect(runDidWrite(toolFamilyProfile(null))).toBe(false);
  });

  it('bounds the distinct list', () => {
    const parts = Array.from({ length: TOOL_PROFILE_DISTINCT_CAP + 10 }, (_, i) => call(`tool_${String(i).padStart(2, '0')}`));
    expect(toolFamilyProfile(parts).distinct).toHaveLength(TOOL_PROFILE_DISTINCT_CAP);
  });
});
