import { resolveBeforeCursor, type CursorFinder, type CursorRow } from './chat-cursor';

const rows: CursorRow[] = [
  { id: 'aaaa1111-0000-4000-8000-000000000001', chatId: 'chat-A', createdAt: new Date('2026-09-24T00:00:01Z') },
  { id: 'aaaa2222-0000-4000-8000-000000000002', chatId: 'chat-A', createdAt: new Date('2026-09-24T00:00:02Z') },
  { id: 'bbbb1111-0000-4000-8000-000000000003', chatId: 'chat-B', createdAt: new Date('2026-09-24T00:00:03Z') },
];
const finder: CursorFinder = {
  byId: async (id) => rows.find(r => r.id === id) ?? null,
  byPrefixInChat: async (chatId, prefix) => rows.filter(r => r.chatId === chatId && r.id.startsWith(prefix)).slice(0, 2),
};

describe('resolveBeforeCursor (2026-09-24 — the 8-char citation prefix is a valid cursor; refusals teach recovery)', () => {
  it('a full id of this chat resolves', async () => {
    const r = await resolveBeforeCursor(finder, 'chat-A', rows[0].id);
    expect(r).toMatchObject({ ok: true, resolvedFrom: 'id', before: { id: rows[0].id } });
  });
  it('an 8-char prefix unique within the chat resolves', async () => {
    const r = await resolveBeforeCursor(finder, 'chat-A', 'aaaa2222');
    expect(r).toMatchObject({ ok: true, resolvedFrom: 'prefix', before: { id: rows[1].id } });
  });
  it('an ambiguous prefix asks for more characters', async () => {
    const r = await resolveBeforeCursor(finder, 'chat-A', 'aaaa');
    expect(r).toMatchObject({ ok: false, reason: 'not_found' }); // 4 chars: no exact id, too short for a prefix
    const r2 = await resolveBeforeCursor({ ...finder, byPrefixInChat: async () => [rows[0], rows[1]] }, 'chat-A', 'aaaa0000');
    expect(r2).toMatchObject({ ok: false, reason: 'ambiguous' });
    if (!r2.ok) expect(r2.message).toContain('nextBefore');
  });
  it('a cursor from another chat is refused and named', async () => {
    const r = await resolveBeforeCursor(finder, 'chat-A', rows[2].id);
    expect(r).toMatchObject({ ok: false, reason: 'other_chat' });
    if (!r.ok) { expect(r.message).toContain('DIFFERENT chat'); expect(r.message).toContain('nextBefore'); }
  });
  it('a short exact id (as tests and old callers use) still resolves by exact match', async () => {
    const r = await resolveBeforeCursor({ ...finder, byId: async (id) => (id === 'm2' ? { id: 'm2', chatId: 'chat-A', createdAt: new Date(0) } : null) }, 'chat-A', 'm2');
    expect(r).toMatchObject({ ok: true, resolvedFrom: 'id', before: { id: 'm2' } });
  });
  it('every refusal keeps the "Invalid before cursor for this chat" prefix the old callers pinned', async () => {
    for (const c of ['', 'aaaa', rows[2].id, 'cccc1111-0000-4000-8000-000000000009']) {
      const r = await resolveBeforeCursor(finder, 'chat-A', c);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message.startsWith('Invalid before cursor for this chat')).toBe(true);
    }
  });
  it('an unknown id explains what to pass', async () => {
    const r = await resolveBeforeCursor(finder, 'chat-A', 'cccc1111-0000-4000-8000-000000000009');
    expect(r).toMatchObject({ ok: false, reason: 'not_found' });
    if (!r.ok) expect(r.message).toContain('previous get_chat_messages page');
  });
});
