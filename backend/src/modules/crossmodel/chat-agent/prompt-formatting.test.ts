/**
 * Guard tests for the chat formatting prompt guidance (feedback da7dc5ea /
 * fc841f58 / 112f82db).
 *
 * Regression target: SHARED_AI_RULES is injected into EVERY answering model's
 * system context (chat-context.ts 1f), so the formatting + canvas-scope rules
 * living there must not be silently edited away:
 *   - blank-line-before-structure mandate (models dropping blank lines is the
 *     fc841f58 "formatting degrades mid-conversation" root cause);
 *   - prose-paragraphs default + sparing bold (da7dc5ea "big bold ugly");
 *   - canvas scope: requested content stays in chat; canvas only for long
 *     standalone artifacts (112f82db "i don't see the list" — the grocery list
 *     went canvas-only and was invisible in chat).
 */

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {},
}));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(), set: jest.fn(), setEx: jest.fn(), del: jest.fn(), expire: jest.fn() },
}));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { SHARED_AI_RULES } from './chat-context';

describe('SHARED_AI_RULES formatting guidance', () => {
  it('mandates a blank line before headings/lists/tables (fc841f58)', () => {
    expect(SHARED_AI_RULES).toContain('AFTER A BLANK LINE');
    expect(SHARED_AI_RULES).toContain('blank line before every ## heading, list, and table');
  });

  it('defaults to prose paragraphs with sparing bold (da7dc5ea)', () => {
    expect(SHARED_AI_RULES).toContain('conversational prose paragraphs');
    expect(SHARED_AI_RULES).toContain('SPARINGLY');
  });

  it('scopes canvas to standalone artifacts — the direct answer stays in chat (112f82db)', () => {
    expect(SHARED_AI_RULES).toContain('never for the direct answer itself');
    expect(SHARED_AI_RULES).toContain('[CANVAS:type=document');
  });
});
