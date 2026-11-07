/**
 * Home Today card — the macOS/Apple Calendar half (2026-11-06).
 *
 * THE REPORT: "how come still i have digby agent on many of my macs and STILL
 * the calendar sync isnt working or showing in my digby calendar on new chats
 * or context". Two of the causes were in this card:
 *
 *   • it was Google-only, so an Apple-calendar owner got "Connect your
 *     calendar" and never an event;
 *   • a Mac read that FAILED looked exactly like a free day, and a Mac that was
 *     never granted permission looked like a calendar with nothing on it.
 *
 * These pins hold the three conclusions that must never regress: Apple events
 * render, a failure is never an empty day, and a row says which calendar it came
 * from.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const PAGE = src('./page.tsx');
const API = src('../../lib/api/crossmodel.ts');

describe('Today card renders the Apple half', () => {
  it('the page state carries the apple verdict from the response', () => {
    expect(PAGE).toContain('setCalendarApple(data.apple ?? null);');
    expect(PAGE).toContain('const [calendarApple, setCalendarApple] = useState<CalendarAppleHalf | null>(null);');
  });

  it('an Apple row is labelled with its source so a merged list is readable', () => {
    expect(PAGE).toContain("event.source === 'apple'");
    // the chip, not just a comment
    expect(PAGE).toContain('>Mac</span>');
  });

  it('a Mac read FAILURE is never rendered as "Nothing on your calendar today"', () => {
    // The empty-day branch must consult the apple state first.
    expect(PAGE).toContain('calendarApple && calendarApple.state !== \'ok\' ? (');
    expect(PAGE).toContain('appleCalendarNotice(calendarApple)');
    // And the not-connected branch surfaces the reason too (an Apple-only user
    // with a failing Mac must not just see "Connect your calendar").
    expect(PAGE).toMatch(/calendarApple\.state !== 'ok' && \(/);
  });

  it('the copy names the Mac and never claims a dialog appeared', () => {
    expect(PAGE).toContain("function appleCalendarNotice(apple: CalendarAppleHalf): string");
    expect(PAGE).toContain('System Settings → Privacy & Security → Calendars');
    // The unverifiable sentence this whole change removes.
    expect(PAGE).not.toMatch(/dialog was just triggered/i);
    // A pending prompt is described as POSSIBLE, never as shown.
    expect(PAGE).toMatch(/may be on that Mac's screen/);
  });

  it('every classified state has its own honest sentence', () => {
    for (const state of [
      'calendar-never-requested',
      'calendar-denied',
      'no-calendar-account',
      'calendar-unreachable',
      'unsupported',
      'no-agent',
    ]) {
      expect(PAGE).toContain(`case '${state}':`);
    }
  });
});

describe('the API types describe the merged response', () => {
  it('CalendarEvent carries the optional source fields (old backends stay valid)', () => {
    expect(API).toContain("source?: 'google' | 'apple';");
    expect(API).toContain('eventId?: string;');
    expect(API).toContain('allDay?: boolean;');
  });
  it('CalendarEventsResponse carries the apple verdict', () => {
    expect(API).toContain('apple?: CalendarAppleHalf;');
    expect(API).toContain('export interface CalendarAppleHalf {');
    // `error` remains the Google-side verdict, unchanged.
    expect(API).toContain("error?: 'unavailable' | 'reconnect';");
  });
});