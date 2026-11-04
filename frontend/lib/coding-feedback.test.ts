/**
 * In-chat feedback on coding-session answers (ticket bd5b95b5) — which rows get the shared action row, the member /
 * kid / placeholder-id rails, the kill switch, and that the coding transcript mounts the SAME PlainMessageActions
 * (same feedbackApi.submit → POST /crossmodel/feedback) plain chats use.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { codingActionRowFor, isPersistedMessageId } from './coding-feedback';
import { PlainMessageActions } from '@/app/crossmodel/components/code-transcript';

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const CHAT = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const MSG = '9b2e7c1a-2d3f-4e5a-8b6c-1d2e3f4a5b6c';

describe('codingActionRowFor', () => {
  it('a persisted assistant answer in an owned session gets the row, linked to its message', () => {
    expect(codingActionRowFor({ role: 'assistant', id: MSG, chatId: CHAT })).toEqual({ feedbackChatId: CHAT, messageId: MSG });
  });

  it('user rows, placeholder ids (fresh / streamed rows) and chat-less mounts keep the bare stamp line', () => {
    expect(codingActionRowFor({ role: 'user', id: MSG, chatId: CHAT })).toBeNull();
    for (const id of [`a-${Date.now()}`, 'tmp-1', 'm-3-abc', 'steer-9', '']) {
      expect(isPersistedMessageId(id)).toBe(false);
      expect(codingActionRowFor({ role: 'assistant', id, chatId: CHAT })).toBeNull();
    }
    expect(codingActionRowFor({ role: 'assistant', id: MSG, chatId: null })).toBeNull();
    expect(codingActionRowFor({ role: 'assistant', id: MSG, chatId: '' })).toBeNull();
  });

  it('a kid session never gets the row; a project member gets Copy / Read aloud but no feedback chat (owner-only endpoint)', () => {
    expect(codingActionRowFor({ role: 'assistant', id: MSG, chatId: CHAT, isKid: true })).toBeNull();
    expect(codingActionRowFor({ role: 'assistant', id: MSG, chatId: CHAT, memberViewOnly: true })).toEqual({ feedbackChatId: '', messageId: MSG });
  });

  it('a persisted assistant row still gets the feedback row', () => {
    expect(codingActionRowFor({ role: 'assistant', id: MSG, chatId: CHAT })).toEqual({ feedbackChatId: CHAT, messageId: MSG });
  });
});

describe('the coding row IS the plain chat\'s action row', () => {
  const render = (chatId: string) => renderToStaticMarkup(createElement(PlainMessageActions, {
    content: 'Merged PR #42; tests green.', chatId, messageId: MSG, timeLabel: '1:05 PM',
  }));

  it('an owner sees 👍 + 👎 Report issue + Copy + Read aloud + the stamp; a member (chatId "") sees no feedback controls', () => {
    const owner = render(CHAT);
    expect(owner).toContain('aria-label="Good response"');
    expect(owner).toContain('aria-label="Report issue"');
    expect(owner).toContain('aria-label="Copy"');
    expect(owner).toContain('aria-label="Read aloud"');
    expect(owner).toContain('1:05 PM');
    const member = render('');
    expect(member).toContain('aria-label="Copy"');
    expect(member).not.toContain('Report issue');
    expect(member).not.toContain('Good response');
  });

  it('CodeSessionView mounts PlainMessageActions in the coding branch from codingActionRowFor, keeping the stamp line as the fallback', () => {
    const view = src('../app/crossmodel/components/CodeSessionView.tsx');
    expect(view).toContain("import { codingActionRowFor } from '@/lib/coding-feedback';");
    expect(view).toContain('const codingRow = plain ? null : codingActionRowFor({ role: m.role, id: m.id, chatId, isKid, memberViewOnly });');
    const branch = view.slice(view.indexOf('{!plain && codingRow && ('), view.indexOf('{!plain && !codingRow && timeLabel && ('));
    expect(branch).toContain('<PlainMessageActions');
    expect(branch).toContain('chatId={codingRow.feedbackChatId}');
    expect(branch).toContain('messageId={codingRow.messageId}');
    expect(branch).toContain('timeLabel={timeLabel ?? undefined}');
    expect(branch).toContain('alwaysVisible={m.id === lastAssistantId}');
    // Same API path: the shared component submits through feedbackApi (POST /crossmodel/feedback).
    const transcript = src('../app/crossmodel/components/code-transcript.tsx');
    const actions = transcript.slice(transcript.indexOf('export function PlainMessageActions('), transcript.indexOf('export function UserMessageCopyButton('));
    expect(actions.match(/feedbackApi\.submit\(/g)?.length).toBe(2); // 👍 and the 👎 form
    expect(src('./api/crossmodel.ts')).toContain('`${apiBase}/crossmodel/feedback`');
  });
});
