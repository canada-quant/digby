/**
 * Apple Calendar device policy + read contract + consent copy
 * (ticket: "still no calendar sync on new chats/context", 2026-11-06).
 *
 * THE REPORT: four Mac agents online, and Apple Calendar events still never
 * appeared in Digby — not in a new chat's context, not on the home Today card.
 * Two of the three causes live in this module's subject matter:
 *
 *   • the device policy silently failed over to a Mac that is NOT signed in to
 *     an Apple account, so a read answered `no-calendar-account` (or, worse,
 *     was reported about a Mac nobody named);
 *   • a failure was indistinguishable from an empty day to every caller.
 *
 * These tests pin the policy table, the classifier table, the dedupe rule and
 * the copy — the things that must not silently drift.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// config/env calls process.exit(1) without env vars and kills the whole jest
// worker at import time — apple-calendar reaches it transitively through
// imessage.service (database → env). Same stand-ins as the house suites.
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test' },
}));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { set: jest.fn(), get: jest.fn(), del: jest.fn(), publish: jest.fn() },
}));
// The policy + normalisation under test are PURE; the dispatch surface is
// mocked so no test ever touches a real agent.
jest.mock('../imessage/imessage.service', () => ({
  __esModule: true,
  listAgents: jest.fn(async () => []),
  isOnline: (lastSeenAt: any) => !!lastSeenAt && Date.now() - new Date(lastSeenAt).getTime() < 45_000,
  agentDisplayName: (a: any) => a?.label || a?.deviceName || 'Mac',
  selectAgent: jest.fn(async () => ({ agent: null, note: 'x', error: 'no paired Mac' })),
}));
jest.mock('../imessage/agent-link', () => ({
  __esModule: true,
  agentBroker: { dispatch: jest.fn() },
  IMESSAGE_READ_DISPATCH_TIMEOUT_MS: 30_000,
}));
jest.mock('../imessage/agent-capabilities', () => ({
  __esModule: true,
  agentPlatform: (a: any) => (a?.platform ? String(a.platform).toLowerCase() : 'macos'),
  hasCapability: (a: any, cap: string) => {
    const v = String(a?.agentVersion || '0.0.0').split('.').map(Number);
    const legacyOk = v[0] > 0 || v[1] >= 7;
    if (Array.isArray(a?.capabilities) && a.capabilities.length > 0) return a.capabilities.includes(cap);
    return legacyOk;
  },
}));

import {
  chooseAppleCalendarDevice,
  interpretAgentCalendarResult,
  interpretConsent,
  appleCalendarStateLine,
  appleCalendarDeviceTag,
  noteAppleCalendarSignedOut,
  clearAppleCalendarSignedOut,
  appleCalendarKnownSignedOut,
  resetAppleCalendarSignedOut,
  APPLE_SIGNED_OUT_TTL_MS,
  type AppleCalendarRead,
} from './apple-calendar';
import {
  appleEventsForCard,
  mergeAppleAndGoogleEvents,
  localDayWindow,
  DEDUPE_START_TOLERANCE_MS,
} from './home-calendar-merge';
import type { AppleCalendarEvent } from './apple-calendar';

// Real-relative baseline: `isOnline` (the production 45 s freshness rule) runs
// on the real clock, so the fixture clock must too — a frozen future instant
// would make every "offline" fixture look online.
const NOW = Date.now();
const fresh = () => new Date(NOW - 1000); // "online" = seen within 45 s

function mac(over: Partial<any> = {}): any {
  return {
    id: 'agent-1',
    userId: 'u1',
    label: 'mac-a',
    deviceId: 'dev-1',
    deviceName: 'mac-a.local',
    agentVersion: '0.9.23',
    capabilities: ['imessage', 'calendar'],
    platform: 'macos',
    isDefault: false,
    lastSeenAt: fresh(),
    pairedAt: new Date(NOW - 1e6),
    ...over,
  };
}

beforeEach(() => resetAppleCalendarSignedOut());

// ── Device policy ───────────────────────────────────────────────────────────

describe('Apple Calendar device policy', () => {
  it('an EXPLICIT device is honoured exactly — never re-routed to a sibling', () => {
    const offline = mac({ id: 'a-off', label: 'named-mac', lastSeenAt: new Date(NOW - 3600_000) });
    const online = mac({ id: 'a-on', label: 'other-mac', isDefault: true });
    const out = chooseAppleCalendarDevice({ agents: [offline, online], explicit: 'named-mac', now: NOW });
    expect(out.agent).toBeNull();
    expect(out.via).toBe('none');
    expect(out.reason).toMatch(/offline/);
  });

  it('an explicit device is still tried when it is KNOWN signed-out (the honest refusal beats a sibling answer)', () => {
    const signedOut = mac({ id: 'a-out', label: 'signed-out' });
    noteAppleCalendarSignedOut('a-out', NOW);
    const out = chooseAppleCalendarDevice({ agents: [signedOut], explicit: 'signed-out', now: NOW });
    expect(out.agent?.id).toBe('a-out');
    expect(out.via).toBe('targeted');
  });

  it('names the paired Macs when an explicit device does not match', () => {
    const out = chooseAppleCalendarDevice({ agents: [mac({ label: 'real-mac' })], explicit: 'nope', now: NOW });
    expect(out.agent).toBeNull();
    expect(out.reason).toContain("'real-mac'");
  });

  it('skips a Mac that last reported no Apple account and answers from a signed-in one', () => {
    const def = mac({ id: 'a-out', label: 'signed-out', isDefault: true });
    const other = mac({ id: 'a-in', label: 'signed-in' });
    noteAppleCalendarSignedOut('a-out', NOW);
    const out = chooseAppleCalendarDevice({ agents: [def, other], now: NOW });
    expect(out.agent?.id).toBe('a-in');
    expect(out.via).toBe('fallback');
    expect(out.skipped).toContain('signed-out');
  });

  it('falls back to a skipped Mac rather than answering "no device" — its refusal is the actionable copy', () => {
    const def = mac({ id: 'a-out', label: 'signed-out', isDefault: true });
    noteAppleCalendarSignedOut('a-out', NOW);
    const out = chooseAppleCalendarDevice({ agents: [def], now: NOW });
    expect(out.agent?.id).toBe('a-out');
    expect(out.via).toBe('fallback');
  });

  it('the default Mac answers when it can serve (via=default, no silent fail-over)', () => {
    const def = mac({ id: 'a-def', label: 'the-default', isDefault: true });
    const other = mac({ id: 'a-2', label: 'second' });
    const out = chooseAppleCalendarDevice({ agents: [other, def], now: NOW });
    expect(out.agent?.id).toBe('a-def');
    expect(out.via).toBe('default');
  });

  it('a Windows PC or an old agent never serves an Apple Calendar read', () => {
    const win = mac({ id: 'w', label: 'pc', platform: 'windows', capabilities: ['imessage'] });
    const old = mac({ id: 'o', label: 'old-mac', agentVersion: '0.6.3', capabilities: ['imessage'] });
    const out = chooseAppleCalendarDevice({ agents: [win, old], now: NOW });
    expect(out.agent).toBeNull();
    expect(out.reason).toMatch(/No paired Mac can read Calendar/);
  });

  it('offline-only answers with the offline line, and an empty list with the pair line', () => {
    const off = mac({ lastSeenAt: new Date(NOW - 10 * 60_000) });
    expect(chooseAppleCalendarDevice({ agents: [off], now: NOW }).reason).toMatch(/offline/);
    expect(chooseAppleCalendarDevice({ agents: [], now: NOW }).reason).toMatch(/No Mac is connected/);
  });

  it('the signed-out mark is read-derived: it expires, and a successful read clears it', () => {
    noteAppleCalendarSignedOut('a-1', NOW);
    expect(appleCalendarKnownSignedOut('a-1', NOW)).toBe(true);
    expect(appleCalendarKnownSignedOut('a-1', NOW + APPLE_SIGNED_OUT_TTL_MS + 1)).toBe(false);
    noteAppleCalendarSignedOut('a-1', NOW);
    clearAppleCalendarSignedOut('a-1');
    expect(appleCalendarKnownSignedOut('a-1', NOW)).toBe(false);
  });

  it('labelling: a fallback is never presented as the named Mac', () => {
    const read: AppleCalendarRead = { state: 'ok', device: 'mac-b', agentId: 'a', via: 'fallback', events: [] };
    expect(appleCalendarDeviceTag(read)).toBe('[device: mac-b, via fallback]');
    const targeted: AppleCalendarRead = { ...read, via: 'targeted' };
    expect(appleCalendarDeviceTag(targeted)).toBe('[device: mac-b, via requested]');
  });
});

// ── The read contract ───────────────────────────────────────────────────────

describe('interpretAgentCalendarResult — failure is never an empty day', () => {
  it('an events array is state ok (even when empty) and keeps the EventKit id', () => {
    const out = interpretAgentCalendarResult({ events: [{ id: 'e1', calendar: 'Work', title: 'Standup', startDate: '2026-11-06T17:00:00Z', endDate: '2026-11-06T17:15:00Z', allDay: false }] });
    expect(out.state).toBe('ok');
    expect(out.events?.[0].id).toBe('e1');
  });

  it('events: [] is ok-and-empty, NOT a failure state', () => {
    expect(interpretAgentCalendarResult({ events: [] }).state).toBe('ok');
  });

  it.each([
    ['no-calendar-account'],
    ['calendar-denied'],
    ['calendar-never-requested'],
    ['calendar-unreachable'],
  ])('%s is carried through as its own state with events:null', (reason) => {
    const out = interpretAgentCalendarResult({ events: null, unavailable: { reason } });
    expect(out.state).toBe(reason);
    expect(out.events).toBeNull();
  });

  it('an unknown reason degrades to calendar-unreachable (never to ok)', () => {
    const out = interpretAgentCalendarResult({ events: null, unavailable: { reason: 'something-new' } });
    expect(out.state).toBe('calendar-unreachable');
    expect(out.events).toBeNull();
  });

  it('a null/garbage agent answer is unreachable, never a free day', () => {
    expect(interpretAgentCalendarResult(null).state).toBe('calendar-unreachable');
    expect(interpretAgentCalendarResult('nope').state).toBe('calendar-unreachable');
    expect(interpretAgentCalendarResult(null).events).toBeNull();
  });

  it('passes the TCC client binary through and drops partial consent episodes', () => {
    const withClient = interpretAgentCalendarResult({
      events: null,
      unavailable: { reason: 'calendar-denied', client: '/usr/local/bin/digby-agent' },
    });
    expect(withClient.client).toBe('/usr/local/bin/digby-agent');
    // An incomplete episode must never half-render.
    expect(interpretConsent({ state: 'granted' })).toBeUndefined();
    expect(interpretConsent({ at: '2026-11-06T00:00:00Z' })).toBeUndefined();
    expect(interpretConsent(null)).toBeUndefined();
    expect(interpretConsent({ state: 'bogus', at: 'x' })).toBeUndefined();
  });
});

// ── Copy: what each state is allowed to claim ───────────────────────────────

describe('appleCalendarStateLine — copy states only what was OBSERVED', () => {
  it('tier 0 NEVER claims a dialog was triggered', () => {
    const line = appleCalendarStateLine('calendar-never-requested', 'mac-a');
    expect(line).toMatch(/has never been granted Calendar access/);
    expect(line).not.toMatch(/dialog was just triggered/i);
    expect(line).toMatch(/No consent attempt has been recorded on that Mac yet/);
    expect(line).toMatch(/System Settings → Privacy & Security → Calendars/);
  });

  it.each([
    ['dialog-open', /prompt may still be waiting/],
    ['dispatched', /reported no decision afterwards/],
    ['granted', /WAS granted/],
    ['denied', /answered with a DENY/],
    ['bridge-failed', /refused it/],
    ['request-failed', /could not stage/],
  ])('the %s episode is described as observed, never as a confirmation it was not', (state, re) => {
    const line = appleCalendarStateLine('calendar-never-requested', 'mac-a', {
      state: state as any, at: '2026-11-06T10:00:00Z', observedTier: 0, idiom: 'entity-type', requestExit: 'ok', version: '0.9.24',
    });
    expect(line).toMatch(re as RegExp);
  });

  // Measured live 2026-11-06T18:19:55Z on example-tailnet-peer (agent 0.9.24):
  // the tier-0 read recorded a `bridge-failed` episode, i.e. the EventKit
  // request was never issued. macOS only lists a client in Privacy → Calendars
  // AFTER that client asks, so the old copy's "enable the Digby agent binary
  // directly" instruction was unfollowable — it contradicted the very sentence
  // before it ("macOS has no Calendars entry for the Digby agent yet").
  it.each(['bridge-failed', 'request-failed'])(
    'a %s episode never sends the owner to toggle a row that cannot exist',
    (state) => {
      const line = appleCalendarStateLine('calendar-never-requested', 'mac-a', {
        state: state as any, at: '2026-11-06T18:19:55Z', observedTier: 0, idiom: 'none', requestExit: 'error', version: '0.9.24',
      });
      expect(line).not.toMatch(/enable the Digby agent binary directly/);
      expect(line).toMatch(/no row can appear/);
      expect(line).toMatch(/agent-side defect/);
      // The owner is told what to do instead, and that retrying is futile.
      expect(line).toMatch(/another signed-in Mac/);
      expect(line).toMatch(/retrying\) it cannot fix this/);
    },
  );

  it.each(['dialog-open', 'dispatched'])(
    'a %s episode DOES keep the manual fallback — the request reached macOS',
    (state) => {
      const line = appleCalendarStateLine('calendar-never-requested', 'mac-a', {
        state: state as any, at: '2026-11-06T18:19:55Z', observedTier: 0, idiom: 'entity-type', requestExit: 'timeout', version: '0.9.24',
      });
      // Only a request macOS actually received can create the row to toggle.
      expect(line).toMatch(/enable the Digby agent binary directly/);
      expect(line).not.toMatch(/no row can appear/);
    },
  );

  it('a signed-out Mac gets sign-in copy, not an empty day', () => {
    const line = appleCalendarStateLine('no-calendar-account', 'mac-a');
    expect(line).toMatch(/not signed in to an Apple account/);
    expect(line).toMatch(/Sign in/);
  });

  it('the denial copy names the binary-vs-app trap', () => {
    const line = appleCalendarStateLine('calendar-denied', 'mac-a');
    expect(line).toMatch(/switched OFF/);
    expect(line).toMatch(/DIFFERENT client/);
  });

  it('ok has no error line', () => {
    expect(appleCalendarStateLine('ok', 'mac-a')).toBe('');
  });
});

// ── Home card: normalisation + dedupe ───────────────────────────────────────

const TZ = 'America/Vancouver';

function appleEvent(over: Partial<AppleCalendarEvent> = {}): AppleCalendarEvent {
  return {
    id: 'evt-1',
    calendar: 'Personal',
    title: 'Dentist',
    startDate: '2026-11-06T18:00:00Z',
    endDate: '2026-11-06T19:00:00Z',
    location: 'Main St',
    allDay: false,
    notes: null,
    ...over,
  };
}

describe('appleEventsForCard', () => {
  it('normalises an EventKit event into the card row shape and labels it apple', () => {
    const rows = appleEventsForCard([appleEvent()], TZ, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: 'Dentist', source: 'apple', eventId: 'evt-1', account: 'Personal', location: 'Main St' });
    expect(rows[0].startEpoch).toBe(Date.parse('2026-11-06T18:00:00Z'));
    expect(rows[0].startTime).toMatch(/AM|PM/);
    expect(rows[0].aiPrompts.length).toBeGreaterThan(0);
  });

  it('keeps only events overlapping the local day (an overnight block still counts today)', () => {
    const overnight = appleEvent({ id: 'o', startDate: '2026-11-05T22:00:00Z', endDate: '2026-11-06T19:00:00Z' });
    const tomorrow = appleEvent({ id: 't', title: 'Tomorrow', startDate: '2026-11-08T18:00:00Z', endDate: '2026-11-08T19:00:00Z' });
    const rows = appleEventsForCard([overnight, tomorrow], TZ, NOW);
    expect(rows.map((r) => r.eventId)).toEqual(['o']);
  });

  it('an event with an unparseable date is dropped, never rendered at epoch 0', () => {
    expect(appleEventsForCard([appleEvent({ startDate: 'not-a-date' })], TZ, NOW)).toEqual([]);
  });

  it('an all-day event reads "All day"', () => {
    const rows = appleEventsForCard([appleEvent({ allDay: true })], TZ, NOW);
    expect(rows[0].allDay).toBe(true);
    expect(rows[0].startTime).toBe('All day');
  });

  it('the local day window is tz-aware and DST-safe', () => {
    const w = localDayWindow(TZ, NOW);
    // 2026-11-06 18:00Z is 10:00 PST — the window must contain it, and span ~24h.
    expect(w.start).toBeLessThan(NOW);
    expect(w.end).toBeGreaterThan(NOW);
    expect(w.end - w.start).toBeGreaterThan(23 * 3600_000);
    expect(w.end - w.start).toBeLessThan(25 * 3600_000);
  });
});

describe('mergeAppleAndGoogleEvents — collapse the duplicate, never a distinct event', () => {
  const appleRow = { title: 'Dentist', startEpoch: Date.parse('2026-11-06T18:00:00Z'), title_plain: '' } as any;
  const g = (over: any = {}) => ({ title: 'Dentist', startEpoch: Date.parse('2026-11-06T18:00:00Z'), endEpoch: Date.parse('2026-11-06T19:00:00Z'), startTime: '10:00 AM', ...over });

  it('collapses the same meeting month/day/time and keeps the Apple copy', () => {
    const merged = mergeAppleAndGoogleEvents([appleRow], [g()]);
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe('apple');
  });

  it('tolerates a small start skew (Google derives its epoch from a formatted string)', () => {
    const merged = mergeAppleAndGoogleEvents([appleRow], [g({ startEpoch: appleRow.startEpoch + DEDUPE_START_TOLERANCE_MS - 1 })]);
    expect(merged).toHaveLength(1);
  });

  it('a back-to-back DIFFERENT meeting survives', () => {
    const merged = mergeAppleAndGoogleEvents([appleRow], [g({ startEpoch: appleRow.startEpoch + 25 * 60_000 })]);
    expect(merged).toHaveLength(2);
  });

  it('a different title at the same time survives', () => {
    const merged = mergeAppleAndGoogleEvents([appleRow], [g({ title: 'Standup' })]);
    expect(merged).toHaveLength(2);
  });

  it('an ALL-DAY row and a timed row with the same title never collapse', () => {
    const merged = mergeAppleAndGoogleEvents([{ ...appleRow, allDay: true }], [g()]);
    expect(merged).toHaveLength(2);
  });

  it('title matching ignores case, punctuation and spacing', () => {
    const merged = mergeAppleAndGoogleEvents([appleRow], [g({ title: '  DENTIST!' })]);
    expect(merged).toHaveLength(1);
  });

  it('output is ordered by start instant across both sources', () => {
    const merged = mergeAppleAndGoogleEvents(
      [{ ...appleRow, title: 'Afternoon', startEpoch: Date.parse('2026-11-06T22:00:00Z') }],
      [g({ title: 'Morning', startEpoch: Date.parse('2026-11-06T16:00:00Z') })],
    );
    expect(merged.map((r) => r.title)).toEqual(['Morning', 'Afternoon']);
  });

  it('Google-only and Apple-only lists pass through unchanged', () => {
    expect(mergeAppleAndGoogleEvents([], [g()])).toHaveLength(1);
    expect(mergeAppleAndGoogleEvents([appleRow], [])).toHaveLength(1);
    expect(mergeAppleAndGoogleEvents([], [])).toHaveLength(0);
  });
});