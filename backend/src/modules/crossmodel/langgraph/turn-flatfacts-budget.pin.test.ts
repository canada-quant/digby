// turn-flatfacts-budget.pin.test.ts — Framework Operator pin (firing 88, 2026-10-06).
// PROD INCIDENT CLASS (memory_extraction telemetry, 4h window ending 14:35Z 2026-10-06):
// the 'turn' source ESCALATEd the charter's parse-share bar — 12.5 % (1 of 8) with the
// tail cut mid-word ("…is providing additional context/correction regarding their
// compensation structure, not denying previ") — the reasoning model burns its output
// budget on the "STEP 1 — SCAN FOR REJECTIONS: No rejections found. …" prose before
// the {"add":…,"remove":…,"reject":…} JSON answer window starts. The call site stood
// at a hard-coded 384 maxTokens (the only extraction leg never raised in the
// 2026-09-22 family fix: profile 512→900, distill 400→900, thread 600→2000, project
// 768→4000+). A parse_error here silently drops the turn's flat-facts update
// (return before any write) — the user-facing symptom is "Digby forgot what I
// corrected last turn".
// Same truncation class, same fix shape, so the same pin: the budget is an exported
// constant at 2000 (headroom for preamble + JSON on dense turns), and EVERY outcome
// row the flat-facts leg records now carries budgetTokens so the audit's
// memory_extraction_4h min_budget/max_budget columns can attribute truncations.
// Kill switch: none needed — a token budget is data, not a gate; the raise is
// monotone-safe (this is the 2026-09-22 doctrine verbatim).

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(
  join(__dirname, 'memory.graph.ts'),
  'utf8',
);

describe('turn flat-facts extraction budget (memory.graph.ts) — pin the 2026-10-06 truncation class', () => {
  test('TURN_FLAT_FACTS_BUDGET_TOKENS is exported at 2000 (was hard-coded 384 — 12.5 % parse_error)', () => {
    expect(SRC).toMatch(/export const TURN_FLAT_FACTS_BUDGET_TOKENS = 2000;/);
  });

  test('proposeFlatFacts sends the exported budget and the 384 literal is gone', () => {
    const fn = SRC.match(
      /async function proposeFlatFacts[\s\S]*?\n\}/,
    )?.[0];
    expect(fn).toBeTruthy();
    expect(fn).toContain('callExtractionLLM(prompt, TURN_FLAT_FACTS_BUDGET_TOKENS');
    // The bug shape must be gone from this function specifically.
    expect(fn).not.toContain('callExtractionLLM(prompt, 384');
  });

  test('firing 88: every flat-facts outcome row carries budgetTokens (was a dead column)', () => {
    // proposeFlatFacts: llm_error / empty / parse_error all stamp the constant.
    const fn = SRC.match(
      /async function proposeFlatFacts[\s\S]*?\n\}/,
    )?.[0];
    expect(fn).toBeTruthy();
    const budgetRows = fn?.match(/budgetTokens: TURN_FLAT_FACTS_BUDGET_TOKENS/g) ?? [];
    expect(budgetRows.length).toBeGreaterThanOrEqual(4);
    // applyFlatFactProposal: noop / changed stamp the budget carried on the proposal.
    const apply = SRC.match(
      /async function applyFlatFactProposal[\s\S]*?\n\}\n/,
    )?.[0];
    expect(apply).toBeTruthy();
    expect(apply).toMatch(/budgetTokens: proposal\.budgetTokens/);
    // The proposal interface carries the budget from the propose leg to the apply leg.
    expect(SRC).toMatch(/llmMs: number;\s*\n\s*budgetTokens: number;/);
    expect(SRC).toMatch(/llmMs, budgetTokens: TURN_FLAT_FACTS_BUDGET_TOKENS \}/);
  });
});
