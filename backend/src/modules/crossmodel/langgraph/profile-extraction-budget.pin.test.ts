// profile-extraction-budget.pin.test.ts — Framework Operator pin (firing 91, 2026-10-07).
// PROD INCIDENT CLASS (memory_extraction telemetry, 4h window ending 02:35Z 2026-10-07):
// the 'profile' source ESCALATEd the charter's parse-share bar — 20.3 % (25 of 123)
// with every tail cut mid-string ("…prefers ultra-concise formattin"), i.e. the
// {summary, preferences, currentFocus, recentTopics, communicationStyle} JSON plus
// the rejection-scan preamble no longer fit the hard-coded 900 output tokens the
// 2026-09-22 raise had set. A parse_error here silently drops the turn's profile
// update (existing profile re-saved unchanged) — the user-facing symptom is
// "Digby forgot what I told it about myself last turn".
// Same truncation class, same fix shape as firing 88's turn leg: the budget is an
// exported constant at 1800 (headroom for preamble + the 5-field JSON), and EVERY
// outcome row the profile leg records carries budgetTokens so the audit's
// memory_extraction_4h min_budget/max_budget columns can attribute truncations.
// Kill switch: none needed — a token budget is data, not a gate; the raise is
// monotone-safe (the 2026-09-22 doctrine verbatim).

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(
  join(__dirname, 'memory.graph.ts'),
  'utf8',
);

describe('profile extraction budget (memory.graph.ts) — pin the 2026-10-07 truncation class', () => {
  test('PROFILE_EXTRACTION_BUDGET_TOKENS is exported at 1800 (was hard-coded 900 — 20.3 % parse_error)', () => {
    expect(SRC).toMatch(/export const PROFILE_EXTRACTION_BUDGET_TOKENS = 1800;/);
  });

  test('extractUserContextNode sends the exported budget and the 900 literal is gone', () => {
    const fn = SRC.match(
      /async function extractUserContextNode[\s\S]*?Memory: extractUserContextNode failed \(non-fatal\)/,
    )?.[0];
    expect(fn).toBeTruthy();
    expect(fn).toContain('callExtractionLLM(prompt, PROFILE_EXTRACTION_BUDGET_TOKENS');
    // The bug shape must be gone from this function specifically.
    expect(fn).not.toContain('callExtractionLLM(prompt, 900');
  });

  test('firing 91: every profile outcome row carries budgetTokens (parse_error AND llm_error)', () => {
    const fn = SRC.match(
      /async function extractUserContextNode[\s\S]*?Memory: extractUserContextNode failed \(non-fatal\)/,
    )?.[0];
    expect(fn).toBeTruthy();
    const budgetRows = fn?.match(/budgetTokens: PROFILE_EXTRACTION_BUDGET_TOKENS/g) ?? [];
    expect(budgetRows.length).toBeGreaterThanOrEqual(2); // success + catch rows
  });
});
