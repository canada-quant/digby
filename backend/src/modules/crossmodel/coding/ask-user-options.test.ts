import { parseAskUserOptions } from './ask-user-options';

/** ask_user quick picks (2026-10-20): labels + optional one-line descriptions for creative-direction asks. */
describe('parseAskUserOptions', () => {
  it('keeps plain labels as they are', () => {
    expect(parseAskUserOptions(['Toronto', 'Montreal'])).toEqual({ labels: ['Toronto', 'Montreal'], details: [{ label: 'Toronto' }, { label: 'Montreal' }] });
  });

  it('splits "Label — description" on an em or en dash only; a plain " - " stays part of the label', () => {
    const r = parseAskUserOptions(['Playful — cartoon pup, bright colours', 'Minimal – one-colour line mark', 'Retro - 70s badge', '9 am - 5 pm', '2-3 days']);
    expect(r.labels).toEqual(['Playful', 'Minimal', 'Retro - 70s badge', '9 am - 5 pm', '2-3 days']);
    expect(r.details[0]).toEqual({ label: 'Playful', description: 'cartoon pup, bright colours' });
    expect(r.details[2]).toEqual({ label: 'Retro - 70s badge' });
  });

  it('accepts {label, description} objects; drops blanks and EXACT duplicates only; caps at 6; never cuts a label', () => {
    const long = 'Refactor the payment module into three services and migrate the ledger tables in one release window';
    const r = parseAskUserOptions([{ label: 'A', description: 'first' }, '', null, 'A', 'a', 'Toronto - Montreal', 'Toronto - Ottawa', long, 'G']);
    expect(r.labels).toEqual(['A', 'a', 'Toronto - Montreal', 'Toronto - Ottawa', long, 'G']);
    expect(r.details[0]).toEqual({ label: 'A', description: 'first' });
  });

  it('returns nothing for a missing / non-array value', () => {
    expect(parseAskUserOptions(undefined)).toEqual({ labels: [], details: [] });
    expect(parseAskUserOptions('Yes')).toEqual({ labels: [], details: [] });
  });
});
