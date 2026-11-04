import { describe, it, expect } from 'vitest';
import { pendingQuestionFromEvent, composeMultiSelectAnswer } from './ask-user-question';

describe('pendingQuestionFromEvent', () => {
  it('reads a legacy labels-only question unchanged (no details, single pick)', () => {
    const q = pendingQuestionFromEvent({ questionId: 'q1', question: 'Which city?', options: ['Toronto', 'Montreal'], expiresAt: 5 }, 0);
    expect(q).toEqual({ questionId: 'q1', question: 'Which city?', options: ['Toronto', 'Montreal'], expiresAt: 5 });
  });

  it('aligns descriptions with the labels and keeps multiSelect', () => {
    const q = pendingQuestionFromEvent({
      questionId: 'q2', question: 'Which style?', options: ['Playful', 'Minimal', 'Retro'], multiSelect: true,
      optionDetails: [{ label: 'Minimal', description: 'one-colour line mark' }, { label: 'Playful', description: 'cartoon pup' }, { label: 'Retro' }],
    }, 1000);
    expect(q.optionDetails).toEqual([
      { label: 'Playful', description: 'cartoon pup' },
      { label: 'Minimal', description: 'one-colour line mark' },
      { label: 'Retro' },
    ]);
    expect(q.multiSelect).toBe(true);
    expect(q.expiresAt).toBe(1000 + 3_600_000);
  });

  it('drops multiSelect on a one-option question and tolerates junk', () => {
    expect(pendingQuestionFromEvent({ questionId: 'q3', question: 'Go?', options: ['Yes'], multiSelect: true }, 0).multiSelect).toBeUndefined();
    const q = pendingQuestionFromEvent(null, 0);
    expect(q.options).toEqual([]);
    expect(q.optionDetails).toBeUndefined();
  });
});

describe('composeMultiSelectAnswer', () => {
  it('joins picks in option order, with the typed note after them', () => {
    expect(composeMultiSelectAnswer(['A', 'B', 'C'], new Set(['C', 'A']), '')).toBe('A, C');
    expect(composeMultiSelectAnswer(['A', 'B'], new Set(['B']), ' keep it teal ')).toBe('B — keep it teal');
    expect(composeMultiSelectAnswer(['A'], new Set(), 'just type')).toBe('just type');
    expect(composeMultiSelectAnswer(['A'], new Set(), '  ')).toBe('');
  });
});
