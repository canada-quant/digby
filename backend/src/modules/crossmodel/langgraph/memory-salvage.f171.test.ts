/**
 * memory-salvage.f171.test.ts — pins for salvageTruncatedJson (fo-f171).
 *
 * Motivation: f171's live audit ESCALATEd memory_parse_error_4h — the PROFILE leg
 * at a 71.2 % parse-error share (99/139 rows in 4h), every tail the SAME over-long
 * profile cut mid-string at the 1800-token output budget (the firing-91 class at
 * 900). parseModelJson cannot help a truncation (no closing brace exists), so the
 * whole extraction call was wasted every turn for that user. salvageTruncatedJson
 * keeps every COMPLETE top-level field; the profile leg merges them over the
 * existing profile, so the one truncated field keeps its existing value.
 *
 * These pins cover the parser's risky surface: string state (incl. escapes and a
 * quote INSIDE a truncated string), bracket depth (a mid-array cut drops the whole
 * field, never yields a partial array), the first-field cut (nothing complete →
 * null), the balanced-input rejection (parseModelJson territory), and a reasoning
 * preamble before the '{'.
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { loop_metrics: { create: jest.fn() }, $queryRawUnsafe: jest.fn() },
}));

import { salvageTruncatedJson, parseModelJson } from '../memory/memory-audit';

describe('salvageTruncatedJson (fo-f171)', () => {
  it('(1) keeps every complete top-level field when the cut lands mid-string in a later field', () => {
    const truncated = '{"summary": "lives in Calgary", "preferences": "concise", "currentFocus": "research program at a Halifax aquari';
    expect(salvageTruncatedJson(truncated)).toEqual({ summary: 'lives in Calgary', preferences: 'concise' });
  });

  it('(2) returns null when the cut lands inside the FIRST field (nothing complete to keep)', () => {
    expect(salvageTruncatedJson('{"summary": "a very long value that gets cut')).toBeNull();
  });

  it('(3) a mid-array cut drops the WHOLE field (never a partial array)', () => {
    const truncated = '{"summary": "s", "recentTopics": ["a", "b", "c';
    expect(salvageTruncatedJson(truncated)).toEqual({ summary: 's' });
  });

  it('(4) a completed array field before the cut survives intact', () => {
    const truncated = '{"summary": "s", "recentTopics": ["a", "b"], "preferences": "long string cut he';
    expect(salvageTruncatedJson(truncated)).toEqual({ summary: 's', recentTopics: ['a', 'b'] });
  });

  it('(5) escaped quotes inside a complete string do not fool the string state', () => {
    const truncated = '{"summary": "she said \\"stop\\" twice", "preferences": "cut of';
    expect(salvageTruncatedJson(truncated)).toEqual({ summary: 'she said "stop" twice' });
  });

  it('(6) returns null for a BALANCED object (parseModelJson territory)', () => {
    const balanced = '{"summary": "s", "preferences": "p"}';
    expect(parseModelJson(balanced)).toEqual({ summary: 's', preferences: 'p' }); // sanity: the primary path handles it
    expect(salvageTruncatedJson(balanced)).toBeNull();
  });

  it('(7) ignores a reasoning preamble before the opening brace', () => {
    const truncated = 'Let me analyze this profile first.\n{"summary": "s", "currentFocus": "cut';
    expect(salvageTruncatedJson(truncated)).toEqual({ summary: 's' });
  });

  it('(8) strips ```json fences before scanning', () => {
    const truncated = '```json\n{"summary": "s", "preferences": "cut';
    expect(salvageTruncatedJson(truncated)).toEqual({ summary: 's' });
  });

  it('(9) returns null for empty / non-object text', () => {
    expect(salvageTruncatedJson('')).toBeNull();
    expect(salvageTruncatedJson(null)).toBeNull();
    expect(salvageTruncatedJson('no json here at all')).toBeNull();
  });

  it('(10) nested objects inside a complete field survive the cut', () => {
    const truncated = '{"meta": {"a": 1, "b": [2, 3]}, "summary": "s", "preferences": "cut';
    expect(salvageTruncatedJson(truncated)).toEqual({ meta: { a: 1, b: [2, 3] }, summary: 's' });
  });

  it('(11) the f171 production shape: cut mid-string in the LAST field yields the four complete ones', () => {
    const truncated =
      '{\n  "summary": "User is a researcher.",\n  "preferences": "asks for day-by-day travel itineraries",\n  "currentFocus": "",\n  "recentTopics": [],\n  "communicationStyle": "detailed, prefers bulleted lists and short social media capt';
    expect(salvageTruncatedJson(truncated)).toEqual({
      summary: 'User is a researcher.',
      preferences: 'asks for day-by-day travel itineraries',
      currentFocus: '',
      recentTopics: [],
    });
  });
});
