/**
 * Owner 2026-09-26: "for chat session default all chats to auto even
 * supervisors and fleet supervisors". Pins the INTAKE defaults — a REST
 * createChat body without a mode and a stream send without a mode are both
 * 'auto' (the compute policy / Auto router decide per send); a named preset
 * still passes through; retired ids still validate (stored chats keep them).
 * Pure zod — no service imports.
 */
import { createChatSchema, streamQuerySchema } from './crossmodel.validation';

describe('createChatSchema — mode default (2026-09-26)', () => {
  it("an omitted mode is 'auto'", () => {
    const r = createChatSchema.parse({ body: { title: 'T' } });
    expect(r.body.mode).toBe('auto');
  });
  it('a named preset / legacy id / explicit auto passes through untouched (the service aliases legacy ids)', () => {
    for (const mode of ['auto', 'single_thinking', 'thinking', 'deep_research', 'deep_research_all', 'fast', 'single', 'browser_agent']) {
      expect(createChatSchema.parse({ body: { title: 'T', mode } }).body.mode).toBe(mode);
    }
  });
  it("a retired non-mode ('code') is refused", () => {
    expect(() => createChatSchema.parse({ body: { title: 'T', mode: 'code' } })).toThrow();
  });
});

describe('streamQuerySchema — mode default (2026-09-26)', () => {
  it("an omitted mode is 'auto'", () => {
    const r = streamQuerySchema.parse({ query: { message: 'hi' } });
    expect(r.query.mode).toBe('auto');
  });
  it('an explicit level is kept', () => {
    expect(streamQuerySchema.parse({ query: { message: 'hi', mode: 'deep_research' } }).query.mode).toBe('deep_research');
  });
});
