/**
 * tool-call-leak detector tests (owner report, chat 7dc031fb).
 *
 * Contract: fire ONLY on tool-SHAPED output naming a tool the chat
 * orchestrator has — never on prose that merely mentions a tool name. The
 * retry mechanics are covered in chat-agent.service.test.ts; this file pins
 * the detector + the replay-safety gate.
 */

import { looksLikeLeakedChatToolCall, looksLikeToolCallNarration, firedReplayUnsafeTool, CHAT_LEAK_NUDGE, MAX_CHAT_LEAK_RETRIES } from './tool-call-leak';

describe('looksLikeLeakedChatToolCall', () => {
  describe('fires on tool-shaped output (leaks)', () => {
    it('a bare prose call on its own line — the owner-reported shape', () => {
      expect(looksLikeLeakedChatToolCall('list_chats({"limit": 20})')).toBe(true);
    });

    it('a call after a lead-in sentence (same message, own line)', () => {
      expect(looksLikeLeakedChatToolCall('Let me check your live projects:\nlist_chats({"limit": 20})')).toBe(true);
    });

    it('a no-arg call alone on a line', () => {
      expect(looksLikeLeakedChatToolCall('list_chats()')).toBe(true);
    });

    it('kwargs-style args', () => {
      expect(looksLikeLeakedChatToolCall('list_chats(limit=20)')).toBe(true);
    });

    it('a namespaced call (functions./tools. prefixes)', () => {
      expect(looksLikeLeakedChatToolCall('functions.get_chat_status({"chatId": "abc"})')).toBe(true);
      expect(looksLikeLeakedChatToolCall('tools.list_schedules()')).toBe(true);
    });

    it('a multi-line call whose JSON args spill onto later lines', () => {
      expect(looksLikeLeakedChatToolCall('list_chats({\n  "limit": 20\n})')).toBe(true);
    });

    it('a fenced tool-call JSON', () => {
      expect(looksLikeLeakedChatToolCall('```json\n{"name": "list_chats", "arguments": {"limit": 20}}\n```')).toBe(true);
    });

    it('a bare JSON tool-call paragraph', () => {
      expect(looksLikeLeakedChatToolCall('I will list them.\n\n{"name": "list_chats", "arguments": {}}')).toBe(true);
    });

    it('an XML-ish <tool_call> wrapper', () => {
      expect(looksLikeLeakedChatToolCall('<tool_call>{"name": "list_chats", "arguments": {"limit": 5}}</tool_call>')).toBe(true);
    });

    it('a fenced bare call', () => {
      expect(looksLikeLeakedChatToolCall('```\nlist_chats({"limit": 10})\n```')).toBe(true);
    });

    it("the coding loop's STRUCTURAL leak (native begin-token block) still fires", () => {
      expect(looksLikeLeakedChatToolCall('<｜tool▁calls▁begin｜>list_chats<｜tool▁calls▁end｜>')).toBe(true);
      expect(looksLikeLeakedChatToolCall('<x invoke name="list_chats">')).toBe(true);
    });

    it('integration + platform tool names are known (roster mirrors CHAT_ORCH_TOOLS)', () => {
      expect(looksLikeLeakedChatToolCall('gmail_search({"query": "invoices"})')).toBe(true);
      expect(looksLikeLeakedChatToolCall('search_engine({"query": "digby ai"})')).toBe(true);
      expect(looksLikeLeakedChatToolCall('schedule_get({"id": "s1"})')).toBe(true);
      // generate_image (2026-09-24) joined CHAT_ORCH_TOOLS — the mirror must know it.
      expect(looksLikeLeakedChatToolCall('generate_image({"prompt": "a red fox in the snow"})')).toBe(true);
    });
  });

  describe('never fires on prose that merely mentions a tool (quote safety)', () => {
    it('a plain mention', () => {
      expect(looksLikeLeakedChatToolCall('You can use list_chats to see your chats.')).toBe(false);
    });

    it('a mention with call syntax inside a sentence', () => {
      expect(looksLikeLeakedChatToolCall('Use list_chats() to see them all — it takes a limit.')).toBe(false);
      expect(looksLikeLeakedChatToolCall('I tried calling list_chats({"limit": 5}) but it failed.')).toBe(false);
    });

    it('a doc-style bullet describing the tool', () => {
      expect(looksLikeLeakedChatToolCall('- `list_chats()` — lists your chats\n- `get_chat_status()` — one chat')).toBe(false);
    });

    it('a prose parenthetical after a tool name (args-shape gate)', () => {
      expect(looksLikeLeakedChatToolCall('create_project (see the docs for details)')).toBe(false);
    });

    it('a prose line that happens to END with a parenthetical (bracket-close gate)', () => {
      expect(looksLikeLeakedChatToolCall('list_chats("main") is the one you want (I checked)')).toBe(false);
    });

    it('an unknown tool name in call syntax', () => {
      expect(looksLikeLeakedChatToolCall('foo_bar({"x": 1})')).toBe(false);
    });

    it('a JSON object naming a known tool WITHOUT an arguments key (not call-shaped)', () => {
      expect(looksLikeLeakedChatToolCall('{"name": "list_chats", "description": "lists chats"}')).toBe(false);
    });

    it('normal markdown answers (tables/lists/headings)', () => {
      expect(looksLikeLeakedChatToolCall('## Summary\n\n| Project | Status |\n|---|---|\n| A | ok |')).toBe(false);
    });

    it('empty and whitespace-only input', () => {
      expect(looksLikeLeakedChatToolCall('')).toBe(false);
      expect(looksLikeLeakedChatToolCall('   \n  ')).toBe(false);
    });
  });
});

describe('firedReplayUnsafeTool (replay-safety gate)', () => {
  it('read-only tool calls are replay-safe', () => {
    expect(firedReplayUnsafeTool([
      { type: 'tool_call', name: 'list_chats' },
      { type: 'tool_result', name: 'list_chats' },
      { type: 'tool_call', name: 'gmail_search' },
      { type: 'text' },
    ])).toBeNull();
  });

  it('a mutating platform tool blocks replay', () => {
    expect(firedReplayUnsafeTool([
      { type: 'tool_call', name: 'list_chats' },
      { type: 'tool_call', name: 'send_chat_message' },
    ])).toBe('send_chat_message');
  });

  it('opts.allow treats ONLY the named tools as replay-safe (owner-turn empty retry: update_supervisor_state)', () => {
    const parts = [
      { type: 'tool_call', name: 'goal_list' },
      { type: 'tool_call', name: 'update_supervisor_state' },
    ];
    expect(firedReplayUnsafeTool(parts)).toBe('update_supervisor_state');
    expect(firedReplayUnsafeTool(parts, { allow: ['update_supervisor_state'] })).toBeNull();
    // every OTHER mutating tool still forbids the replay, allow-list or not
    expect(firedReplayUnsafeTool([...parts, { type: 'tool_call', name: 'send_chat_message' }], { allow: ['update_supervisor_state'] })).toBe('send_chat_message');
    expect(firedReplayUnsafeTool(parts, { allow: [] })).toBe('update_supervisor_state');
  });

  it('document/browser mutations block replay', () => {
    expect(firedReplayUnsafeTool([{ type: 'tool_call', name: 'create_document' }])).toBe('create_document');
    expect(firedReplayUnsafeTool([{ type: 'tool_call', name: 'browser_task' }])).toBe('browser_task');
  });

  it('a mutating name in a NON-tool_call part is ignored (results/text quote names)', () => {
    expect(firedReplayUnsafeTool([{ type: 'tool_result', name: 'send_chat_message' }])).toBeNull();
  });

  it('handles missing parts', () => {
    expect(firedReplayUnsafeTool(undefined)).toBeNull();
    expect(firedReplayUnsafeTool([])).toBeNull();
  });
});

describe('coding-loop parity constants', () => {
  it('matches the coding loop bound and nudge shape', () => {
    expect(MAX_CHAT_LEAK_RETRIES).toBe(2); // coding/agent.ts MAX_LEAK_RETRIES
    expect(CHAT_LEAK_NUDGE).toContain('[HARNESS NOTICE — not typed by the user]');
    expect(CHAT_LEAK_NUDGE).toContain('NO tool was executed');
  });
});

describe('looksLikeToolCallNarration (feedback ab9d96eb — prose-narration shape)', () => {
  describe('fires on', () => {
    it('the exact 21:35Z smoking-gun answer (production transcript, chat 7dc031fb)', () => {
      const smokingGun =
        `You're right, I missed it entirely — I was surveying chat titles and never checked the actual ` +
        `**TT-RD project folder**, which has its own dedicated session sitting inside it. Give me a second ` +
        `to pull that session fresh. --- **ETA (projection):** one sec --- ` +
        `*(Calling list_chats + get_chat_messages on the TT-RD project session — I'll report what I actually find, not another marketing-page summary)*`;
      expect(looksLikeToolCallNarration(smokingGun)).toBe(true);
      // …and pin the gap this detector fills: the call-shape detector misses it.
      expect(looksLikeLeakedChatToolCall(smokingGun)).toBe(false);
    });

    it('"Calling <tool> on …" (bare, no markdown wrap)', () => {
      expect(looksLikeToolCallNarration('Calling list_chats on the live projects now.')).toBe(true);
    });

    it('"Let me call <tool> tool/on…" first-person phrasing', () => {
      expect(looksLikeToolCallNarration('Let me call send_chat_message tool to notify the lane.')).toBe(true);
      expect(looksLikeToolCallNarration("I'll use get_chat_messages on that chat.")).toBe(true);
      expect(looksLikeToolCallNarration('I need to run search_engine for the latest numbers.')).toBe(true);
    });

    it('"Now calling <tool>" stage-direction phrasing', () => {
      expect(looksLikeToolCallNarration('Now calling list_chats.')).toBe(true);
    });
  });

  describe('never fires on', () => {
    it('prose that merely MENTIONS a tool (the detector contract)', () => {
      expect(looksLikeToolCallNarration('You can use list_chats to see your chats.')).toBe(false);
      expect(looksLikeToolCallNarration('The list_chats tool returned 14 rows.')).toBe(false);
    });

    it('past-tense / quoted call syntax in prose', () => {
      expect(looksLikeToolCallNarration('I tried calling list_chats({"limit": 5}) but it failed.')).toBe(false);
    });

    it('review B1 regressions: honest past-tense "by calling <tool> on…" reports after REAL tool work', () => {
      // Verbatim adversarial-review FPs (PR #602): the ungated pattern matched
      // "calling" after "by" — a report of work DONE, not a promise of work.
      expect(looksLikeToolCallNarration('Here are your numbers, pulled fresh. I got them by calling search_engine on each of the three tickers you listed.')).toBe(false);
      expect(looksLikeToolCallNarration('Summary above — I found the session by calling list_chats on your account and reading the thread.')).toBe(false);
    });

    it('loose verb usage with a NON-tool noun (known-tool anchor)', () => {
      expect(looksLikeToolCallNarration("I'll use the data to answer.")).toBe(false);
      expect(looksLikeToolCallNarration('Calling all hands on deck for the deploy.')).toBe(false);
      expect(looksLikeToolCallNarration('Now running late for the meeting.')).toBe(false);
    });

    it('narration phrasing OUTSIDE the tail window (mid-answer mention)', () => {
      const narration = 'Calling list_chats on the fleet. ';
      const body = 'A substantive middle section. '.repeat(40); // >600 chars of real answer after it
      expect(looksLikeToolCallNarration(narration + body)).toBe(false);
    });

    it('normal markdown answers and empty input', () => {
      expect(looksLikeToolCallNarration('## Summary\n\n| Project | Status |\n|---|---|\n| A | ok |')).toBe(false);
      expect(looksLikeToolCallNarration('')).toBe(false);
      expect(looksLikeToolCallNarration('   \n  ')).toBe(false);
    });
  });
});
