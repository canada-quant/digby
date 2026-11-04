/**
 * Ticket ccd634fb — nightly query suite 2026-10-06, case 03-platform-chat-instructions:
 * "for the rest of this chat, always answer in exactly one sentence" → "Noted — every answer from
 * here on will be exactly one sentence." with NO tool call (glm-5.3, 0 steps). The rule was never
 * saved (set_chat_instructions offered + named in the playbook), so it lives only as long as the
 * message stays in the history window. Pins the pure detector the one-shot retry keys on.
 */
import {
  standingChatRuleCue,
  unsavedStandingRule,
  standingRuleNotice,
  standingRuleRetryDisabled,
  STANDING_RULE_MAX_CHARS,
} from './standing-rule';

describe('standingChatRuleCue — a rule for THIS chat, not a task or a fact about the user', () => {
  it.each([
    'for the rest of this chat, always answer in exactly one sentence', // the nightly message, verbatim
    'from now on, reply in French',
    'From now on in this chat answer in Spanish please',
    'in this chat, always use metric units',
    'for this conversation: no emojis',
    'going forward, keep your answers under 50 words',
    'until I say otherwise, respond only in bullet points',
    'always answer in one sentence from now on',
    'from now on I want you to answer in German',
  ])('a standing rule: %s', (msg) => {
    expect(standingChatRuleCue(msg)).not.toBeNull();
  });

  it.each([
    'explain why the sky is blue',
    'from now on I\'m vegetarian', // a fact about the user → remember_fact, never a chat rule
    'going forward my address is 12 Oak Street',
    'In this chat I want to plan a trip to Lisbon',
    'what will happen to interest rates from now on?',
    'remember that my favourite spice is saffron',
    '',
  ])('not a standing rule: %s', (msg) => {
    expect(standingChatRuleCue(msg)).toBeNull();
  });

  it('a long message is a task, never a rule (a story that says "from now on, always …")', () => {
    const story = `Write a story where the hero says "from now on, always be brave". ${'x'.repeat(STANDING_RULE_MAX_CHARS)}`;
    expect(standingChatRuleCue(story)).toBeNull();
  });
});

describe('unsavedStandingRule — retry only when nothing saved the rule and nothing mutated', () => {
  const message = 'for the rest of this chat, always answer in exactly one sentence';
  const finalText = 'Noted — every answer from here on will be exactly one sentence.';

  it('the nightly shape (no tool call at all) ⇒ the cue', () => {
    expect(unsavedStandingRule({ message, finalText, parts: [{ type: 'text' }], unsafeTool: null })).toBe('for the rest of this chat');
  });

  it('a turn that DID save it (set_chat_instructions, or remember_fact for an all-chats preference) ⇒ null', () => {
    expect(unsavedStandingRule({ message, finalText, parts: [{ type: 'tool_call', name: 'set_chat_instructions' }], unsafeTool: 'set_chat_instructions' })).toBeNull();
    expect(unsavedStandingRule({ message, finalText, parts: [{ type: 'tool_call', name: 'remember_fact' }], unsafeTool: null })).toBeNull();
  });

  it('any mutating tool stands the replay down (no side effect may run twice)', () => {
    expect(unsavedStandingRule({ message, finalText, parts: [{ type: 'tool_call', name: 'schedule_message' }], unsafeTool: 'schedule_message' })).toBeNull();
  });

  it('read-only tool calls replay harmlessly — still the cue', () => {
    expect(unsavedStandingRule({ message, finalText, parts: [{ type: 'tool_call', name: 'search_memory' }], unsafeTool: null })).toBe('for the rest of this chat');
  });

  it('an empty answer is the empty-retry lane\'s job, not this one', () => {
    expect(unsavedStandingRule({ message, finalText: '  ', parts: [], unsafeTool: null })).toBeNull();
  });
});

describe('standingRuleNotice + kill switch', () => {
  it('the note names the cue, the tool, the extend-first rule, remember_fact, and the answer-normally escape', () => {
    const n = standingRuleNotice('for the rest of this chat');
    expect(n).toContain('for the rest of this chat');
    expect(n).toContain('set_chat_instructions');
    expect(n).toContain('get_chat_instructions first and EXTEND');
    expect(n).toContain('remember_fact');
    expect(n).toContain('just answer it normally');
  });

  it('CHAT_RULE_UNSAVED_RETRY_DISABLED=1 turns the retry off', () => {
    const saved = process.env.CHAT_RULE_UNSAVED_RETRY_DISABLED;
    process.env.CHAT_RULE_UNSAVED_RETRY_DISABLED = '1';
    expect(standingRuleRetryDisabled()).toBe(true);
    delete process.env.CHAT_RULE_UNSAVED_RETRY_DISABLED;
    expect(standingRuleRetryDisabled()).toBe(false);
    if (saved !== undefined) process.env.CHAT_RULE_UNSAVED_RETRY_DISABLED = saved;
  });
});
