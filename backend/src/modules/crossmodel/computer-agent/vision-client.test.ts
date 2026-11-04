/**
 * vision-client.ts — the computer-use loop's Responses-style items → chat
 * messages translation (2026-09-22: the seat replaced the gpt-5.6-luna
 * Responses API; the loop's vocabulary is unchanged).
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../model-endpoints/model-roles.service', () => ({
  __esModule: true, resolveRoleModel: async () => '', resolveRoleFallback: async () => '',
}));

import { toChatMessages, toChatTools, type VisionInputItem } from './vision-client';

describe('toChatMessages', () => {
  it('user items become text+image_url parts; consecutive function_calls merge into ONE assistant turn; outputs become tool messages', () => {
    const input: VisionInputItem[] = [
      { role: 'user', content: [{ type: 'input_text', text: 'Task: open Mail' }, { type: 'input_image', image_url: 'data:image/jpeg;base64,QUJD' }] },
      { type: 'function_call', call_id: 'a', name: 'click', arguments: '{"x":10,"y":20}' },
      { type: 'function_call', call_id: 'b', name: 'type', arguments: '{"text":"hi"}' },
      { type: 'function_call_output', call_id: 'a', output: '{"ok":true}' },
      { type: 'function_call_output', call_id: 'b', output: '{"ok":true}' },
      { role: 'user', content: [{ type: 'input_text', text: '[earlier screenshot omitted]' }] },
      { type: 'function_call', call_id: 'c', name: 'done', arguments: '{"message":"done"}' },
      { type: 'function_call_output', call_id: 'c', output: '{"ok":true}' },
    ];
    const msgs = toChatMessages('SYSTEM', input);
    expect(msgs[0]).toEqual({ role: 'system', content: 'SYSTEM' });
    expect(msgs[1]).toEqual({ role: 'user', content: [{ type: 'text', text: 'Task: open Mail' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } }] });
    expect(msgs[2]).toEqual({ role: 'assistant', content: '', tool_calls: [
      { id: 'a', type: 'function', function: { name: 'click', arguments: '{"x":10,"y":20}' } },
      { id: 'b', type: 'function', function: { name: 'type', arguments: '{"text":"hi"}' } },
    ] });
    expect(msgs[3]).toEqual({ role: 'tool', tool_call_id: 'a', content: '{"ok":true}' });
    expect(msgs[4]).toEqual({ role: 'tool', tool_call_id: 'b', content: '{"ok":true}' });
    // Text-only user content collapses to a plain string (text-only providers reject part arrays).
    expect(msgs[5]).toEqual({ role: 'user', content: '[earlier screenshot omitted]' });
    // A new function_call after outputs starts a NEW assistant turn.
    expect(msgs[6]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'c' }] });
    expect(msgs[7]).toEqual({ role: 'tool', tool_call_id: 'c', content: '{"ok":true}' });
    // No private bookkeeping leaks onto the wire.
    expect(msgs.some(m => '_closed' in m)).toBe(false);
  });

  it('toChatTools wraps flattened Responses tools into OpenAI function tools', () => {
    expect(toChatTools([{ type: 'function', name: 'click', description: 'Click', parameters: { type: 'object' } }]))
      .toEqual([{ type: 'function', function: { name: 'click', description: 'Click', parameters: { type: 'object' } } }]);
    expect(toChatTools(undefined)).toBeUndefined();
    expect(toChatTools([])).toBeUndefined();
  });
});
