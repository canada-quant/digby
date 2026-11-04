import { describe, expect, it } from 'vitest';
import { attachCanvasesToMessages } from './canvas-attach';

const t = (s: number) => new Date(Date.UTC(2026, 9, 6, 12, 0, s)).toISOString();

describe('attachCanvasesToMessages', () => {
  it('a canvas lands on the first answer created at or after it', () => {
    const msgs = [
      { id: 'u1', role: 'user', createdAt: t(0) },
      { id: 'a1', role: 'assistant', createdAt: t(30) },
      { id: 'u2', role: 'user', createdAt: t(40) },
      { id: 'a2', role: 'assistant', createdAt: t(90) },
    ];
    const map = attachCanvasesToMessages(msgs, [{ id: 'c1', createdAt: t(20) }, { id: 'c2', createdAt: t(60) }]);
    expect(map.get('a1')?.map((c) => c.id)).toEqual(['c1']);
    expect(map.get('a2')?.map((c) => c.id)).toEqual(['c2']);
  });

  it('never pins a canvas far older than the next answer, or one with no stamp', () => {
    const msgs = [{ id: 'a1', role: 'assistant', createdAt: t(0) }];
    const old = new Date(Date.parse(t(0)) - 2 * 60 * 60 * 1000).toISOString();
    const map = attachCanvasesToMessages(msgs, [{ id: 'c1', createdAt: old }, { id: 'c2' }]);
    expect(map.size).toBe(0);
  });

  it('a canvas after the last answer stays unattached', () => {
    const map = attachCanvasesToMessages([{ id: 'a1', role: 'assistant', createdAt: t(0) }], [{ id: 'c1', createdAt: t(50) }]);
    expect(map.size).toBe(0);
  });
});
