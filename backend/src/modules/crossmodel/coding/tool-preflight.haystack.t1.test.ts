/**
 * audit 2026-10-06 T1-9 (crosscutting X5) — the tool_intent_attribution
 * MEASUREMENT reads the wake / task text only.
 *
 * 113 guard_miss rows / 50 h on 10 coding chats were all `preamble_ordered`
 * matches on SYSTEM-PROMPT doctrine lines ("list_dir/read_file to read…",
 * "Prefer edit_file…"): the system prompt names every core tool, so the probe
 * could not tell an ordered checklist from a derail. wakePromptHaystack now
 * takes `excludeSystem` (the measurement haystack); the default (system +
 * user) is unchanged — the ARMED platform-tool discount still reads it.
 */
import { wakePromptHaystack, intentMismatchDiscount, intentMeasureSystemExcludeDisabled } from './tool-preflight';

const MSGS = [
  { role: 'system', content: 'Doctrine: use list_dir/read_file to read before you write. Prefer edit_file over write_file.' },
  { role: 'user', content: 'Wake: run schedule_get on each of the six schedules and drift-check them.' },
  { role: 'assistant', content: 'calling read_file' },
  { role: 'tool', content: 'edit_file echoed in a result' },
  { role: 'user', content: '[HARNESS NOTICE — not typed by the user] RE-ANCHOR: you called read_file …' },
];

describe('wakePromptHaystack excludeSystem (audit 2026-10-06 T1-9)', () => {
  afterEach(() => { delete process.env.INTENT_MEASURE_SYSTEM_EXCLUDE_DISABLED; });

  it('default haystack is unchanged: system + user text', () => {
    const hay = wakePromptHaystack(MSGS);
    expect(hay).toContain('Prefer edit_file');
    expect(hay).toContain('schedule_get on each');
    expect(hay).not.toContain('echoed in a result');
    expect(hay).not.toContain('RE-ANCHOR');
  });

  it('excludeSystem drops the system prompt — a doctrine-only mention no longer reads as "ordered"', () => {
    const hay = wakePromptHaystack(MSGS, { excludeSystem: true });
    expect(hay).not.toContain('Prefer edit_file');
    expect(hay).toContain('schedule_get on each');
    // the X5 false positive: edit_file named only by doctrine
    expect(intentMismatchDiscount('write_file', 'edit_file', wakePromptHaystack(MSGS))).toMatchObject({ reason: 'preamble_ordered' });
    expect(intentMismatchDiscount('write_file', 'edit_file', hay)).toBeNull();
    // a genuinely wake-ordered call still measures as ordered
    expect(intentMismatchDiscount('get_chat_status', 'schedule_get', hay)).toMatchObject({ reason: 'preamble_ordered', marker: 'schedule_get' });
  });

  it('kill switch flag reads per call', () => {
    expect(intentMeasureSystemExcludeDisabled()).toBe(false);
    process.env.INTENT_MEASURE_SYSTEM_EXCLUDE_DISABLED = '1';
    expect(intentMeasureSystemExcludeDisabled()).toBe(true);
  });
});
