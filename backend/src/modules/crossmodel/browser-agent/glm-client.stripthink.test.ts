/** stripThink unit tests — the REAL implementation (glm-client).
 *  fcc28eba hardened it: an unterminated leading <think> block (provider cut
 *  the completion mid-reasoning) is reasoning-only and must strip to empty,
 *  not pass through as the "answer". */

// glm-client imports retryOnModelNotFound (langgraph) — mock it so importing
// the client stays leaf-light like the other browser-agent tests.
// glm-client runs on the Browser agent SEAT (2026-09-22) via seat-call — the
// logger it pulls in sinks to prisma; mock it so importing stays graph-free.
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../model-endpoints/model-roles.service', () => ({
  __esModule: true,
  resolveRoleModel: async () => '',
  resolveRoleFallback: async () => '',
}));
jest.mock('../langgraph/pipeline-utils', () => ({
  __esModule: true,
  retryOnModelNotFound: jest.fn(async (fn: any) => fn()),
}));

import { stripThink } from './glm-client';

describe('stripThink', () => {
  it('strips a leading think block and keeps the answer', () => {
    expect(stripThink('<think>private reasoning</think>The report.')).toBe('The report.');
  });

  it('tolerates leading whitespace before the think block', () => {
    expect(stripThink('  <think>private reasoning</think>\nThe report.')).toBe('The report.');
  });

  it('think-only content strips to empty', () => {
    expect(stripThink('<think>only reasoning, no answer</think>')).toBe('');
  });

  it('unterminated think block (provider truncation) strips to empty (fcc28eba)', () => {
    expect(stripThink('<think>reasoning cut off mid-stream with no closing tag')).toBe('');
  });

  it('unterminated think block with leading whitespace strips to empty', () => {
    expect(stripThink('   <think>cut off')).toBe('');
  });

  it('passes plain text through unchanged', () => {
    expect(stripThink('No reasoning here.')).toBe('No reasoning here.');
  });

  it('passes through text where <think> is not leading', () => {
    const s = 'The answer mentions <think> inline, not as a reasoning block.';
    expect(stripThink(s)).toBe(s);
  });

  it('handles null/undefined/empty', () => {
    expect(stripThink(null)).toBe('');
    expect(stripThink(undefined)).toBe('');
    expect(stripThink('')).toBe('');
  });
});
