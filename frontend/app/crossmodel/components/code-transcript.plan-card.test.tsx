/**
 * PlanCard step shapes (ticket 17a0b383, round-2 review nit).
 *
 * PlanCard draws the RAW update_plan tool-call args. The backend validator
 * (coding/plan.service.ts validatePlanUpdate) accepts two step shapes besides
 * {text, status}: a plain non-empty string (stored as {text}, status pending)
 * and the status-keyed shorthand {"in_progress": "<text>"} (+ optional string
 * note, stored as {text, status}). The card used to read s.text / s.status
 * straight off those, so such a step rendered as a blank pending row and the
 * done counter missed a shorthand "completed" step. The card now normalises
 * the same shapes the validator accepts; every other shape passes through.
 *
 * Node-environment vitest idiom (no jsdom): render via react-dom/server and
 * assert on the static markup.
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { PlanCard, normalizePlanCardSteps } from './code-transcript';

const html = (args: unknown) => renderToStaticMarkup(createElement(PlanCard, { args }));

describe('normalizePlanCardSteps — the shapes validatePlanUpdate accepts', () => {
  it('a plain string becomes {text}; the status-keyed shorthand becomes {text, status, note?}', () => {
    const asIs = { text: 'a', status: 'completed' };
    const out = normalizePlanCardSteps([
      'Inspect /app',
      { in_progress: 'Run the verify chain' },
      asIs,
      { completed: 'b', note: 'done in abc123' },
      { 'In-Progress': 'c' },
      { ' blocked ': 'd' },
    ]);
    expect(out).toEqual([
      { text: 'Inspect /app' },
      { text: 'Run the verify chain', status: 'in_progress' },
      { text: 'a', status: 'completed' },
      { text: 'b', status: 'completed', note: 'done in abc123' },
      { text: 'c', status: 'in_progress' },
      { text: 'd', status: 'blocked' },
    ]);
    // A step that already has "text" is the same object (untouched).
    expect(out[2]).toBe(asIs);
  });

  it('shapes the validator rejects pass through unchanged (non-objects become {} so the card never crashes)', () => {
    const ambiguous = [
      { in_progress: 'a', pending: 'b' }, // two status keys
      { in_progress: 5 }, // non-string value
      { in_progress: '   ' }, // empty value
      { doing: 'a' }, // a synonym, not a canonical status key
      { in_progress: 'a', id: 3 }, // an extra key
      { in_progress: 'a', note: 7 }, // a non-string note
      { in_progress: 'a', status: 'pending' }, // a conflicting status field
      { note: 'only a note' }, // no status key
    ];
    const out = normalizePlanCardSteps(ambiguous);
    out.forEach((s, i) => expect(s).toBe(ambiguous[i]));
    expect(normalizePlanCardSteps([null, 7, '', '  ', ['x'], true])).toEqual([{}, {}, {}, {}, {}, {}]);
    expect(normalizePlanCardSteps(undefined)).toEqual([]);
    expect(normalizePlanCardSteps('[{"text":"a"}]')).toEqual([]);
  });
});

describe('PlanCard — renders the normalised steps', () => {
  it('a shorthand and a plain-string step render their text and mark, and the done counter counts a shorthand "completed"', () => {
    const out = html({
      goal: 'Ship the fix',
      steps: [{ completed: 'Write the failing test' }, 'Implement the fix', { in_progress: 'Run the verify chain and commit' }],
    });
    expect(out).toContain('Ship the fix');
    expect(out).toContain('>1/3<');
    expect(out).toContain('Write the failing test');
    expect(out).toContain('Implement the fix');
    expect(out).toContain('Run the verify chain and commit');
    // ● completed (struck through), ○ pending, ◐ in progress — in order.
    const marks = [...out.matchAll(/>([○◐●⊘])</g)].map(m => m[1]);
    expect(marks).toEqual(['●', '○', '◐']);
    expect(out).toMatch(/line-through[^>]*>Write the failing test/);
  });

  it('a shorthand note rides along, and a malformed step no longer crashes the card', () => {
    const out = html({ steps: [{ blocked: 'Deploy', note: 'waiting on CI' }, null] });
    expect(out).toContain('Deploy');
    expect(out).toContain('Deploy<span class="text-muted-foreground"> — waiting on CI</span>');
    expect(out).toContain('>0/2<');
    const marks = [...out.matchAll(/>([○◐●⊘])</g)].map(m => m[1]);
    expect(marks).toEqual(['⊘', '○']);
  });
});
