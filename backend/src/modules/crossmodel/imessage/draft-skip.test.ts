/**
 * audit 2026-10-08 W4-6 — the post-answer iMessage send classifier never runs on a supervisor chat or on a turn that
 * already messaged in-app. REPLAY: StAnne Project Supervisor chat, 10-08 17:51:37 — the owner's "well message the
 * tt-rd supervisor …" read as an iMessage send (gate send=0.96) and the confirm card popped; the owner declined
 * ("not a imessage contact"). Pure.
 */
import { imessageDraftSkipReason, toolNamesCalled, IN_APP_MESSAGE_TOOLS } from './draft-skip';

describe('imessageDraftSkipReason', () => {
  it('the replayed supervisor-chat turn is skipped before any model call', () => {
    expect(imessageDraftSkipReason({ supervisorChat: true, toolNames: [] }, {} as any)).toBe('supervisor_chat');
  });
  it('a plain-chat turn that already called send_chat_message is skipped (the ask was answered in-app)', () => {
    const parts = [{ type: 'tool_call', name: 'list_chats' }, { type: 'tool_call', name: 'send_chat_message' }, { type: 'tool_call', name: 'send_chat_message' }];
    expect(toolNamesCalled(parts)).toEqual(['list_chats', 'send_chat_message']);
    expect(imessageDraftSkipReason({ supervisorChat: false, toolNames: toolNamesCalled(parts) }, {} as any)).toBe('in_app_send');
  });
  it('an ordinary plain-chat turn still classifies ("text mum I am late")', () => {
    expect(imessageDraftSkipReason({ supervisorChat: false, toolNames: ['search_engine'] }, {} as any)).toBeNull();
    expect(IN_APP_MESSAGE_TOOLS.has('imessage_send')).toBe(false);
  });
  it('IMESSAGE_DRAFT_INAPP_SKIP_DISABLED=1 restores every-turn classification', () => {
    expect(imessageDraftSkipReason({ supervisorChat: true, toolNames: ['send_chat_message'] }, { IMESSAGE_DRAFT_INAPP_SKIP_DISABLED: '1' } as any)).toBeNull();
  });
  it('bad parts ⇒ no names', () => {
    expect(toolNamesCalled(undefined)).toEqual([]);
  });
});
