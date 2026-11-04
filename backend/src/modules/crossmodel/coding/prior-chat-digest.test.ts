/**
 * audit 2026-10-06 T7-11 — chat-engine-era tool calls reach a converted
 * chat's first coding runs as a compact digest (stanne.md #7).
 */
import { priorToolDigest, priorToolDigestDisabled, PRIOR_TOOL_DIGEST_MAX } from './prior-chat-digest';

describe('priorToolDigest', () => {
  it('names each call with its argument keys + short values — an absent key is visibly absent (the spawn with no prompt)', () => {
    const d = priorToolDigest([
      { type: 'text', text: 'The build is underway' },
      { type: 'tool_call', name: 'goal_create', args: { title: 'StAnne control plane', projectId: 'e8f2eb84-0000' } },
      { type: 'tool_call', name: 'start_coding_session', args: { title: 'Build StAnne control plane', goalId: '259a67ee', projectId: 'e8f2eb84', permissionMode: 'auto' } },
      { type: 'tool_call', name: 'todo_create', args: { dependsOnTodoIds: ['placeholder'], title: 'x' } },
      { type: 'tool_result', name: 'start_coding_session', result: 'ok' },
    ]);
    expect(d.startsWith('[Tool calls this earlier chat turn made (chat engine')).toBe(true);
    expect(d).toContain('start_coding_session {title: "Build StAnne control plane", goalId: "259a67ee", projectId: "e8f2eb84", permissionMode: "auto"}');
    expect(d).not.toContain('prompt:');
    expect(d).toContain('todo_create {dependsOnTodoIds: [1 item], title: "x"}');
  });

  it('no tool calls ⇒ empty; long values / many calls are bounded', () => {
    expect(priorToolDigest([{ type: 'text', text: 'hi' }])).toBe('');
    expect(priorToolDigest(null)).toBe('');
    const many = Array.from({ length: 40 }, (_, i) => ({ type: 'tool_call', name: `t${i}`, args: { q: 'x'.repeat(500) } }));
    const d = priorToolDigest(many);
    expect(d.length).toBeLessThanOrEqual(PRIOR_TOOL_DIGEST_MAX);
    expect(d.endsWith(']')).toBe(true);
  });

  it('kill switch reader', () => {
    process.env.CODING_HISTORY_PRIOR_TOOL_DIGEST_DISABLED = '1';
    expect(priorToolDigestDisabled()).toBe(true);
    delete process.env.CODING_HISTORY_PRIOR_TOOL_DIGEST_DISABLED;
    expect(priorToolDigestDisabled()).toBe(false);
  });
});
