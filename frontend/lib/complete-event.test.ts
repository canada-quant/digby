import { describe, expect, it } from 'vitest';
import { completePartsOmitted } from './complete-event';

// audit 2026-10-06 T8-7: CodeSessionView reloads the persisted final row (REST) only when the
// server says it omitted an oversized `parts`; every other payload keeps the in-place append.
describe('completePartsOmitted', () => {
  it('true only for an explicit partsOmitted:true', () => {
    expect(completePartsOmitted({ finalText: 'done', partsOmitted: true, partsBytes: 3_600_000, messageId: 'm1' })).toBe(true);
  });

  it('false for today\'s payload, legacy shapes and junk', () => {
    expect(completePartsOmitted({ finalText: 'done', parts: [{ type: 'text', text: 'done' }], stopped: false })).toBe(false);
    expect(completePartsOmitted({ finalText: '', parts: [], interrupted: true })).toBe(false);
    expect(completePartsOmitted({ partsOmitted: 'true' })).toBe(false);
    expect(completePartsOmitted(null)).toBe(false);
    expect(completePartsOmitted(undefined)).toBe(false);
    expect(completePartsOmitted('partsOmitted')).toBe(false);
  });
});
