import { transientResumePrompt, isTransientResumeInput, TRANSIENT_RESUME_MARKER } from './transient-resume';

describe('transient-resume (2026-09-29)', () => {
  it('the prompt carries the standard round marker (parsed by the backstop) and the resume marker', () => {
    const p = transientResumePrompt(2, 6);
    expect(p.match(/\[HARNESS CONTINUATION r(\d+)\/\d+\]/)?.[1]).toBe('2');
    expect(p).toContain(TRANSIENT_RESUME_MARKER);
    expect(isTransientResumeInput(p)).toBe(true);
    expect(p.includes('[HARNESS CONTINUATION')).toBe(true); // continuation-guard.isContinuationInput → Stop cancels a queued resume like any continuation
    expect(isTransientResumeInput('[HARNESS CONTINUATION r1/6] resume the plan')).toBe(false);
  });
});
