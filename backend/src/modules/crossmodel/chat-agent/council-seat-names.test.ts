/**
 * Audit 2026-10-03: the council lead's doctrine named the colleagues
 * 'deepseek' / 'glm' while dispatch_colleagues / send_note accept the seat
 * keys — a prose-following call was refused and still spent a dispatch round.
 */
import { normalizeCouncilSeat } from './council-dispatch';

describe('normalizeCouncilSeat', () => {
  it('maps the seat keys to themselves', () => {
    expect(normalizeCouncilSeat('double_checker')).toBe('double_checker');
    expect(normalizeCouncilSeat('triple_checker')).toBe('triple_checker');
    expect(normalizeCouncilSeat('Double Checker')).toBe('double_checker');
    expect(normalizeCouncilSeat('triple-checker')).toBe('triple_checker');
  });
  it('aliases the legacy persona names forward', () => {
    expect(normalizeCouncilSeat('deepseek')).toBe('double_checker');
    expect(normalizeCouncilSeat('GLM')).toBe('triple_checker');
    expect(normalizeCouncilSeat('double')).toBe('double_checker');
    expect(normalizeCouncilSeat('triple')).toBe('triple_checker');
  });
  it('refuses anything else', () => {
    for (const x of ['lead', 'all', 'kimi', '', null, undefined, 42]) expect(normalizeCouncilSeat(x)).toBeNull();
  });
});
