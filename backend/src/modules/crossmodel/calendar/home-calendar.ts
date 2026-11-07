/**
 * The home Today card's two calendar HALVES, as module-level functions.
 *
 * WHY MODULE-LEVEL, NEVER CLASS METHODS (ticket 9ea25082, 2026-11-07).
 * `crossmodel.routes.ts` wires handlers as BARE callbacks
 * (`router.get('/calendar-events', controller.getCalendarEventsForHome)`), and
 * Express calls a bare callback with NO receiver — `this` is undefined inside
 * it. When the unified 2026-11-06 card reached its halves through
 * `this.buildGoogleHomeCalendar(...)` / `this.buildAppleHomeCalendar(...)`,
 * EVERY GET /api/crossmodel/calendar-events FAILED with
 * "Cannot read properties of undefined (reading 'buildGoogleHomeCalendar')"
 * before either half ran: the card was empty for every user, and prod logged it
 * 24x/24h at error level, source error-handler.
 *
 * HOW THE THROW ESCAPED BOTH CATCHES, MEASURED (adversarial review of this
 * very change, 2026-11-07 — the first draft of this comment said "synchronous
 * throw" and that was WRONG). `getCalendarEventsForHome` is an `async` method,
 * and an async body converts a throw into a REJECTED PROMISE:
 *     const p = c.handler.call(undefined);   // returns a Promise
 *     p.then(...).catch(e => ...)            // ASYNCHRONOUS rejection
 * So the failure was a rejected promise, which is why Express 5 forwards it to
 * the error handler and why prod stamped `source: error-handler`. It still beat
 * both per-half `.catch()`es, because those attach to the RESULT of
 * `this.buildGoogleHomeCalendar(...)` — and the property READ on `this` fails
 * while evaluating that argument, before any promise exists to attach to.
 * `Promise.all([...])` cannot help either: its argument array is evaluated
 * first. The conclusion (no graceful degrade, nothing in the handler contained
 * it) stands; only the causality is stated correctly here.
 *
 * WHY THE EXTRACTION RATHER THAN `.bind()`. Binding the handler in the route
 * table would hide the dependency instead of removing it — the repo already
 * treats a `.bind(` on a route-wired handler as the smell (see the ffbf1315
 * suite's structural case, which asserts the controls are wired WITHOUT a
 * receiver). So this takes ffbf1315's own remedy: the helpers live here as
 * plain functions, and the controller keeps its documented invariant that NO
 * method on it touches `this`, so any handler can always be called unbound.
 * Pinned by
 * backend/src/modules/crossmodel/home-calendar.controller.9ea25082.test.ts,
 * which replays the crash unbound AND asserts the controller source is free of
 * `this.` — a future refactor that reintroduces the receiver fails the suite
 * instead of silently emptying the owner's calendar card again.
 */
import { Request } from 'express';
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { parseCalendarEventsText } from '../calendar-events.parser';
import { appleEventsForCard } from './home-calendar-merge';

/**
 * The GOOGLE half of the home Today card, as a plain payload — extracted
 * (2026-11-06) so the Apple Calendar half can be merged in without
 * duplicating Google's several early-return branches. Behaviour is
 * unchanged: `connected` still tracks the Google row only, and a failed
 * Google read still reports `error: 'unavailable' | 'reconnect'`.
 */
export async function buildGoogleHomeCalendar(userId: string): Promise<any> {
  // Owner 2026-10-21 ("where did the calendar view go from the main
  // homepage?"): a connected calendar whose fetch failed used to answer
  // `connected:false` (the catch) or `connected:true, events:[]` (the fan-out
  // failure text parsed to nothing) — both made the home Today card vanish
  // as if the calendar had never been connected. `connected` now tracks the
  // Google row, and a failed read carries `error:'unavailable'` so the card
  // can say so and offer a retry.
  let connected = false;

  try {
    if (!process.env.GOOGLE_OAUTH_CLIENT_ID) {
      return { connected: false, events: [] };
    }

    const googleRow = await (prisma as any).googleOAuthToken.findFirst({
      where: { userId },
      select: { userId: true },
    });

    if (!googleRow) {
      return { connected: false, events: [] };
    }
    connected = true;

    const googleMcp = await import('../google/google-mcp');

    // Dead credentials (the 2026-10-21 case: Google OAuth client id / secret
    // rotated ⇒ every refresh token minted under the old client fails) —
    // `getAllValidTokens` then yields no account and the fetch returned ''
    // = "Nothing today". Say RECONNECT instead; the card links to
    // Account → Integrations.
    const resolution = await googleMcp.resolveGoogleAccount(userId);
    if (!resolution.ok) {
      if (resolution.reason === 'refresh_failed') {
        logger.warn(`getCalendarEventsForHome: Google token refresh failed for userId=${userId} — reconnect needed`);
        return { connected: true, events: [], error: 'reconnect' };
      }
      if (resolution.reason === 'not_connected') {
        return { connected: false, events: [] };
      }
    }

    // Load user's timezone from memory so we query the correct "today"
    // (server runs in UTC; without this, a user at 10 PM EDT sees tomorrow's events)
    let userTz = 'UTC';
    try {
      const mem = await prisma.userMemory.findUnique({ where: { userId }, select: { facts: true } });
      const facts = (mem?.facts as Record<string, string>) || {};
      if (facts.timezone) userTz = facts.timezone;
    } catch { /* non-fatal — fall back to UTC */ }

    // Compute start/end of "today" in the user's local timezone, then convert to UTC.
    // We get the user's local date string (e.g. "2026-04-13") and build midnight/end-of-day
    // in their timezone by computing the UTC offset from the timezone.
    const now = new Date();
    const localDateStr = now.toLocaleDateString('en-CA', { timeZone: userTz }); // "2026-04-13" (ISO format)

    // Compute the UTC offset for the user's timezone by comparing the same instant
    // formatted in UTC vs the user's timezone. This correctly handles DST.
    const utcParts = now.toLocaleString('en-US', { timeZone: 'UTC', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const tzParts  = now.toLocaleString('en-US', { timeZone: userTz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const parseLocaleDate = (s: string) => {
      // Format: "MM/DD/YYYY, HH:MM:SS" — parse to a comparable timestamp
      const m = s.match(/(\d+)\/(\d+)\/(\d+),?\s*(\d+):(\d+):(\d+)/);
      if (!m) return 0;
      return Date.UTC(+m[3], +m[1] - 1, +m[2], +m[4] === 24 ? 0 : +m[4], +m[5], +m[6]);
    };
    const utcMs = parseLocaleDate(utcParts);
    const tzMs  = parseLocaleDate(tzParts);
    // offsetMs = how many ms to ADD to a "local wall clock" Date to get UTC
    // e.g. for EDT (UTC-4): offsetMs = +4h (local midnight + 4h = UTC midnight of that local day)
    const offsetMs = utcMs - tzMs;

    // Build start/end of day as UTC ISO strings
    const startUtc = new Date(new Date(`${localDateStr}T00:00:00Z`).getTime() + offsetMs);
    const endUtc   = new Date(new Date(`${localDateStr}T23:59:59Z`).getTime() + offsetMs);

    logger.info(`getCalendarEventsForHome: userTz=${userTz}, localDate=${localDateStr}, queryRange=${startUtc.toISOString()} to ${endUtc.toISOString()}`);

    const rawEvents = await googleMcp.getCalendarEvents(userId, startUtc.toISOString(), endUtc.toISOString(), 25, userTz);

    if (!rawEvents || rawEvents.trim() === '') {
      return { connected: true, events: [] };
    }
    // The fan-out returns its failure text (no section header) when EVERY
    // account failed — that is an outage to report, not an empty day.
    if (!rawEvents.includes('[Google Calendar Events]')) {
      logger.warn(`getCalendarEventsForHome: calendar fetch failed for userId=${userId}: ${rawEvents.slice(0, 200)}`);
      return { connected: true, events: [], error: 'unavailable' };
    }

    const events = parseCalendarEventsText(rawEvents, userTz);
    logger.info(`getCalendarEventsForHome: found ${events.length} events for userId=${userId}`);
    return { connected: true, events: events.slice(0, 20) };
  } catch (error: any) {
    logger.error('getCalendarEventsForHome error:', error.message);
    return { connected, events: [], ...(connected ? { error: 'unavailable' } : {}) };
  }
}

/**
 * The APPLE half of the home Today card: today's events from the owner's Mac,
 * already filtered to the local day, normalised into the card's display
 * shape. Never throws; a failure is a classified state with `events: []`
 * (an empty ARRAY is safe here because `state` says whether it means "free
 * day" or "couldn't read" — the card reads the state).
 */
export async function buildAppleHomeCalendar(req: Request, userId: string): Promise<any> {
  const { readAppleCalendar } = await import('./apple-calendar');
  // Explicit device selection: ?device=<label> — the honest way to look at a
  // particular Mac (and the only way to inspect one that is not the default).
  const device = typeof (req as any)?.query?.device === 'string' ? String((req as any).query.device) : null;
  // 2 days so "today" is always inside the window even across a DST/timezone
  // boundary; the local-day filter below is what actually scopes the card.
  const read = await readAppleCalendar(userId, { device, days: 2 });
  if (read.state !== 'ok' || !read.events) {
    return { state: read.state, device: read.device, via: read.via, events: [], error: read.error, consent: read.consent, skippedSignedOut: read.skippedSignedOut };
  }
  let userTz = 'UTC';
  try {
    const mem = await prisma.userMemory.findUnique({ where: { userId }, select: { facts: true } });
    const facts = (mem?.facts as Record<string, string>) || {};
    if (facts.timezone) userTz = facts.timezone;
  } catch { /* fall back to UTC */ }
  const forCard = appleEventsForCard(read.events, userTz);
  return { state: 'ok', device: read.device, via: read.via, events: forCard, consent: read.consent };
}
