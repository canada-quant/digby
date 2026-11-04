// distill-budget.pin.test.ts — Framework Operator pin (2026-09-22 steer run).
// PROD INCIDENT CLASS (memory_extraction telemetry, 4h window ending 23:05Z 2026-09-22):
// the distill node ran 25 % parse_error (3 of 12 calls) with cut-off-mid-string tails —
//   '{"question": "Did the z.ai granted rate limits …", "summary": "PR #23 was squ'
//   (22:21:45Z), '{"question": "Where is the LLAMA_BENCHY_GLM53_FLASH_S3S5…' (22:12:12Z), etc.
// Its maxTokens stood at 400 while every sibling extraction node got a raise on 2026-09-22
// (fa915ba0: project 768→2000→4000, thread 600→2000, profile 512→900): the distill record's
// JSON (question + 2-4-sentence summary + resolution + refs[]) does not fit 400 output tokens
// whenever the exchange is dense — the answer window alone is 4000 chars of input. A parse_error
// here silently drops the conversation's memory record (return before any write).
// This pin: the budget constant is 900 and the failure detail carries head+TAIL so a cut-off
// answer is visible in the telemetry tails section on the next audit.
// Kill switch: none needed — a token budget is data, not a gate; the raise is monotone-safe.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(
  join(__dirname, 'memory.graph.ts'),
  'utf8',
);

describe('distill extraction budget (memory.graph.ts) — pin the 2026-09-22 truncation class', () => {
  test('distillConversationToUnifiedMemory sends maxTokens 900 (was 400 — 25 % parse_error)', () => {
    const fn = SRC.match(
      /async function distillConversationToUnifiedMemory[\s\S]*?\n\}/,
    )?.[0];
    expect(fn).toBeTruthy();
    expect(fn).toContain('maxTokens: 900');
    // The bug shape must be gone from this function specifically.
    expect(fn).not.toContain('maxTokens: 400');
  });

  test('the distill parse_error detail carries head + TAIL (cut-off answers visible in tails)', () => {
    const fn = SRC.match(
      /async function distillConversationToUnifiedMemory[\s\S]*?\n\}/,
    )?.[0];
    expect(fn).toBeTruthy();
    // fa915ba0's head+tail detail idiom, applied to the distill failure path.
    expect(fn).toMatch(/detail:\s*`/);
    expect(fn).toMatch(/\.slice\(0, 90\)/);
    expect(fn).toMatch(/\.slice\(-70\)/);
  });

  // ── Firing 13 (2026-09-24): the rows, not just the call ──────────────────
  // Live evidence: the standing audit's memory_extraction_4h read distill
  // avg_ms = 0 (every row hardcoded ms: 0 — real seconds of LLM time
  // invisible) and min_budget/max_budget NULL, while the budget was in fact
  // 900 since the raise above. A dead column cannot convict anything.
  test('firing 13: every distill outcome row carries budgetTokens 900 and REAL elapsed ms (was ms: 0)', () => {
    const fn = SRC.match(
      /async function distillConversationToUnifiedMemory[\s\S]*?\n\}/,
    )?.[0];
    expect(fn).toBeTruthy();
    const body = fn ?? '';
    expect(body).toContain('distillStartedAt');
    // all three terminal rows (parse_error/empty, noop, changed) carry the budget
    const budgetRows = body.match(/budgetTokens: 900/g) ?? [];
    expect(budgetRows.length).toBeGreaterThanOrEqual(3);
    // the dead ms: 0 literal is gone from the CALL SITES (shape `ms: 0,` / `ms: 0 })`) —
    // the phrase in this pin's own comment must not self-match.
    expect(body).not.toMatch(/ms:\s*0\s*[,})]/);
    // rows measure against the node's own start stamp
    expect((body.match(/Date\.now\(\) - distillStartedAt/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  test('the fa915ba0 raises are still in place (project floor 4000, thread 2000)', () => {
    // 2026-09-23 firing 7: the project node's budget became SCALED
    // (projectExtractionBudget — floor 4000, ceiling 8000) because the model
    // echoes the existing state and a fixed 4000 truncated the largest states
    // (16.9 % parse_error post-f7b0d29f). The family view therefore pins the
    // FLOOR inside the scaling function, not the old call-site literal.
    expect(SRC).toMatch(/Math\.min\(8000, Math\.max\(4000/);
    expect(SRC).toContain('callExtractionLLM(prompt, 2000'); // the thread call (2026-10-20: + an onMeta option)
  });
});
