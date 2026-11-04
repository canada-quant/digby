/** audit 2026-10-08 W2-12 — the per-run read cache leaf (run-read-cache.ts). */
import { RunReadCache, canonicalArgs, isCacheableRead, isUncacheableResult, runReadCacheDisabled, READ_CACHE_TTL_MS } from './run-read-cache';

describe('RunReadCache', () => {
  it('serves an identical allowlisted read with a note naming the step + receipt, until the TTL', () => {
    let t = 1_000_000;
    const c = new RunReadCache(() => t);
    expect(c.lookup('schedule_get', '{"id":"d72b394a"}')).toBeNull();
    c.record('schedule_get', '{"id":"d72b394a"}', '{"id":"d72b394a","enabled":true}', 3, 'rcpt-1');
    t += 30_000;
    const hit = c.lookup('schedule_get', '{ "id" : "d72b394a" }')!;
    expect(hit.text).toMatch(/^\(cached from step 3, 30 s ago, receipt rcpt-1 — an identical schedule_get call/);
    expect(hit.text.endsWith('{"id":"d72b394a","enabled":true}')).toBe(true);
    t += READ_CACHE_TTL_MS.schedule_get;
    expect(c.lookup('schedule_get', '{"id":"d72b394a"}')).toBeNull(); // expired
    expect(c.summary()).toMatchObject({ hits: 1, misses: 2 });
  });

  it('live-state reads get a short window', () => {
    expect(READ_CACHE_TTL_MS.get_chat_status).toBe(60_000);
    expect(READ_CACHE_TTL_MS.list_owner_questions).toBe(300_000);
  });

  it('a state-changing dispatch clears everything; pure local reads do not', () => {
    const c = new RunReadCache(() => 0);
    c.record('todo_list', '{"projectId":"p1"}', 'todos: 3', 1, null);
    c.noteDispatch('read_file');
    c.noteDispatch('search_memory');
    c.noteDispatch('todo_list');
    expect(c.lookup('todo_list', '{"projectId":"p1"}')).not.toBeNull();
    c.noteDispatch('todo_update');
    expect(c.lookup('todo_list', '{"projectId":"p1"}')).toBeNull();
    c.record('list_chats', '{}', 'chats', 2, null);
    c.noteDispatch('run_command');
    expect(c.lookup('list_chats', '{}')).toBeNull();
  });

  it('only the allowlist is cached; errors / refusals / not-ok envelopes never are', () => {
    expect(isCacheableRead('schedule_get')).toBe(true);
    expect(isCacheableRead('read_file')).toBe(false);
    expect(isCacheableRead('send_chat_message')).toBe(false);
    for (const r of ['Error: schedule not found', 'Tool "x" exceeded 900s and was aborted.', '[tool call rejected] x', '[command REFUSED — x]', '{"ok":false,"reason":"x"}', '{"needsConfirmation":true}', '', '[HARNESS NOTICE] x']) {
      expect(isUncacheableResult(r)).toBe(true);
    }
    expect(isUncacheableResult('{"ok":true,"schedules":[]}')).toBe(false);
    expect(isUncacheableResult('3 open owner questions:\n- q1')).toBe(false);
    const c = new RunReadCache(() => 0);
    c.record('schedule_get', '{"id":"bad"}', 'Error: schedule not found', 1, null);
    expect(c.lookup('schedule_get', '{"id":"bad"}')).toBeNull();
  });

  it('canonical args: key order + whitespace insensitive; unparseable → never cached', () => {
    expect(canonicalArgs('{"b":1,"a":" x "}')).toBe(canonicalArgs('{"a":"x","b":1}'));
    expect(canonicalArgs('')).toBe('{}');
    expect(canonicalArgs('{bad')).toBeNull();
    const c = new RunReadCache(() => 0);
    c.record('todo_list', '{bad', 'x', 1, null);
    expect(c.lookup('todo_list', '{bad')).toBeNull();
  });

  it('kill switch reader', () => {
    expect(runReadCacheDisabled({})).toBe(false);
    expect(runReadCacheDisabled({ RUN_READ_CACHE_DISABLED: '1' })).toBe(true);
  });
});
