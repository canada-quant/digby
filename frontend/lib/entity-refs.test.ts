/** Clickable references in answers (owner 2026-10-08) — lib/entity-refs.ts. */
import { describe, expect, it } from 'vitest';
import { chatIdFromDeepLink, linkifyEntityRefs, parseEntityRefHref } from './entity-refs';

describe('linkifyEntityRefs', () => {

  it('links the ids a noun names — the screenshot\'s supervisor lines', () => {
    expect(linkifyEntityRefs('start_coding_session → receipt b3649334, session fbb5c9ca — lane spawned'))
      .toBe('start_coding_session → receipt [b3649334](#ref:receipt:b3649334), session [fbb5c9ca](#ref:session:fbb5c9ca) — lane spawned');
    expect(linkifyEntityRefs('todo_create ×3 → todos 536d5d52, 23014278, 63a8404a — restart'))
      .toBe('todo_create ×3 → todos [536d5d52](#ref:todo:536d5d52), [23014278](#ref:todo:23014278), [63a8404a](#ref:todo:63a8404a) — restart');
    expect(linkifyEntityRefs('goal_create → goal 534c37aa — "QB2 64K"')).toContain('goal [534c37aa](#ref:goal:534c37aa)');
    expect(linkifyEntityRefs('the lane 1a2b3c4d and chat ids 9f8e7d6c')).toBe('the lane [1a2b3c4d](#ref:session:1a2b3c4d) and chat ids [9f8e7d6c](#ref:chat:9f8e7d6c)');
  });

  it('leaves bare hex, longer hex / uuids, snake_case tool names, code and links alone', () => {
    expect(linkifyEntityRefs('commit fbb5c9ca landed')).toBe('commit fbb5c9ca landed');
    expect(linkifyEntityRefs('session fbb5c9ca0123')).toBe('session fbb5c9ca0123');
    expect(linkifyEntityRefs('session fbb5c9ca-1111-4111-8111-111111111111')).toBe('session fbb5c9ca-1111-4111-8111-111111111111');
    expect(linkifyEntityRefs('todo_create 536d5d52')).toBe('todo_create 536d5d52');
    expect(linkifyEntityRefs('record `session d1fe1498` proved')).toBe('record `session d1fe1498` proved');
    expect(linkifyEntityRefs('[session fbb5c9ca](/crossmodel?chatId=x)')).toBe('[session fbb5c9ca](/crossmodel?chatId=x)');
    const once = linkifyEntityRefs('session fbb5c9ca');
    expect(linkifyEntityRefs(once)).toBe(once);
  });

  it('parses its own hrefs and full chat deep links', () => {
    expect(parseEntityRefHref('#ref:todo:536d5d52')).toEqual({ kind: 'todo', id: '536d5d52' });
    expect(parseEntityRefHref('#ref:user:536d5d52')).toBeNull();
    expect(parseEntityRefHref('https://x')).toBeNull();
    expect(chatIdFromDeepLink('/crossmodel?chatId=FBB5C9CA-1111-4111-8111-111111111111')).toBe('fbb5c9ca-1111-4111-8111-111111111111');
    expect(chatIdFromDeepLink('/crossmodel/projects/x')).toBeNull();
  });
});
