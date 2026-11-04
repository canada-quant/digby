/** Reopening a chat mid-reply resumes the clock and the steps (owner 2026-10-08) — lib/run-clock.ts. */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { replayedRunStart } from './run-clock';

const view = readFileSync(fileURLToPath(new URL('../app/crossmodel/components/CodeSessionView.tsx', import.meta.url)), 'utf8');

describe('run-clock', () => {
  it('a replayed frame\'s server ts is the run start; absent, unreadable or future ts is ignored', () => {
    const now = Date.parse('2026-10-08T00:06:00Z');
    expect(replayedRunStart('2026-10-08T00:03:00.000Z', now)).toBe(Date.parse('2026-10-08T00:03:00Z'));
    expect(replayedRunStart(undefined, now)).toBeNull();
    expect(replayedRunStart('not a date', now)).toBeNull();
    expect(replayedRunStart('2026-10-08T00:07:00Z', now)).toBeNull();
  });

  it('an ATTACH pulls the clock back to the earliest replayed frame — never forward', () => {
    expect(view).toContain('if (opts?.attach) {');
    expect(view).toContain('const startedMs = replayedRunStart(frameTs);');
    expect(view).toContain('setRunStart(rs => (rs == null || startedMs < rs ? startedMs : rs));');
    // it runs before the normalizer, which swallows the plain-chat init frame
    expect(view.indexOf('replayedRunStart(frameTs)')).toBeLessThan(view.indexOf('const n = normalize(type, data);'));
  });

  it('the replayed status burst is applied line by line (the throttle no longer drops the steps)', () => {
    expect(view).toContain('if (urgent || replayGate || sinceLast > 300) {');
  });
});
