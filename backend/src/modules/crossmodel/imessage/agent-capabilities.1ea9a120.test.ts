/**
 * Ticket 1ea9a120 — backend calendar capability + per-key permission merge.
 *
 * Pins the three backend seams the calendar read path rides on:
 *   1. normalizeAgentPermissions / permissionsFromBody / mergeAgentPermissions
 *      per-key absent-never-clobbers semantics on the `cal` axis: a poll or
 *      pair body that OMITS `cal` (every pre-0.7.0 advert) keeps the stored
 *      `cal`; one that carries it overwrites; garbage never reaches the
 *      merge (the parse seam drops it).
 *   2. 'calendar' capability: KNOWN_CAPABILITIES membership, the
 *      advertisement-is-the-answer rule, the legacy Mac 0.7.0 version gate
 *      (LEGACY_MAC_CALENDAR_MIN), and resolvedCapabilities rendering — a
 *      legacy row below 0.7.0 must never render calendar.
 *   3. mac_calendar_list_events tool registration + dispatch (structural
 *      pins on the schema entry and the coding-integrations case): the
 *      serve-time macos+calendar gate BEFORE the broker dispatch, the
 *      'calendar_list_events' agent command name, and the stringified
 *      structured-unavailable body (never a thrown error — a throw 504s
 *      and loses the TCC denial class).
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  KNOWN_CAPABILITIES,
  LEGACY_MAC_CALENDAR_MIN,
  hasCapability,
  mergeAgentPermissions,
  normalizeAgentPermissions,
  permissionsFromBody,
  resolvedCapabilities,
  type AgentPermissions,
} from './agent-capabilities';

const here = __dirname;
const schemaSrc = readFileSync(join(here, '..', 'coding', 'integration-tool-schema.ts'), 'utf8');
const integrationsSrc = readFileSync(join(here, '..', 'coding', 'coding-integrations.ts'), 'utf8');
const controllerSrc = readFileSync(join(here, 'imessage.controller.ts'), 'utf8');
const serviceSrc = readFileSync(join(here, 'imessage.service.ts'), 'utf8');

const ADVERT4: AgentPermissions = { ax: true, sr: true, fda: true, relaunch: true };

// ─── 1. Per-key merge semantics (the `cal` axis of 2f646c10) ────────────────

describe('mergeAgentPermissions — per-key absent-never-clobbers (cal axis)', () => {
  it('keeps the stored cal when the incoming advert omits it (pre-0.7.0 poll)', () => {
    const merged = mergeAgentPermissions({ ...ADVERT4, cal: true }, ADVERT4);
    expect(merged).toBeDefined();
    expect(merged!.cal).toBe(true);
    expect(merged!.ax).toBe(true);
  });

  it('overwrites the stored cal when the incoming advert carries it', () => {
    const merged = mergeAgentPermissions({ ...ADVERT4, cal: false }, { ...ADVERT4, cal: true });
    expect(merged!.cal).toBe(true);
    const back = mergeAgentPermissions({ ...ADVERT4, cal: true }, { ...ADVERT4, cal: false });
    expect(back!.cal).toBe(false);
  });

  it('a false advert is a real value, not an absence — it DOES clobber', () => {
    // The TCC denial path deliberately sends cal=0: a revoked permission must
    // reach the row (the 2f646c10 stale-truth rule). Only ABSENT stays absent.
    const merged = mergeAgentPermissions({ ...ADVERT4, cal: true }, { ...ADVERT4, cal: false });
    expect(merged!.cal).toBe(false);
  });

  it('no advert at all keeps the stored row unchanged', () => {
    const stored: AgentPermissions = { ...ADVERT4, cal: true };
    expect(mergeAgentPermissions(stored, undefined)).toEqual(stored);
    expect(mergeAgentPermissions(stored, undefined)).toBe(stored);
  });

  it('no stored row: the advert lands as-is (first pair)', () => {
    expect(mergeAgentPermissions(null, { ...ADVERT4, cal: true })).toEqual({ ...ADVERT4, cal: true });
    expect(mergeAgentPermissions(undefined, ADVERT4)).toEqual(ADVERT4);
  });

  it('merge is idempotent — feeding the merged result back changes nothing', () => {
    const advert = { ...ADVERT4, cal: true };
    const once = mergeAgentPermissions(ADVERT4, advert);
    const twice = mergeAgentPermissions(once, once);
    expect(twice).toEqual(once);
  });
});

describe('normalizeAgentPermissions — poll form, optional cal', () => {
  it('four legacy flags + cal all parse (1/0 literals accepted)', () => {
    expect(normalizeAgentPermissions({ ax: 1, sr: 0, fda: 1, relaunch: 0, cal: 1 })).toEqual({
      ax: true, sr: false, fda: true, relaunch: false, cal: true,
    });
  });

  it('cal absent → absent key (NOT false), so the merge keeps the stored value', () => {
    const p = normalizeAgentPermissions({ ax: 1, sr: 1, fda: 1, relaunch: 1 });
    expect(p).toEqual(ADVERT4);
    expect(p && 'cal' in p).toBe(false);
  });

  it('garbage cal → absent key (parse discipline: undefined never clobbers)', () => {
    for (const bad of ['yes', 2, null, {}, []]) {
      const p = normalizeAgentPermissions({ ax: 1, sr: 1, fda: 1, relaunch: 1, cal: bad as any });
      expect(p).toBeDefined();
      expect(p && 'cal' in p).toBe(false);
    }
  });

  it('the legacy all-four gate is unchanged: any missing flag → undefined', () => {
    expect(normalizeAgentPermissions({ ax: 1, sr: 1, fda: 1 })).toBeUndefined();
    expect(normalizeAgentPermissions({})).toBeUndefined();
    // cal alone can never carry an advert.
    expect(normalizeAgentPermissions({ cal: 1 })).toBeUndefined();
  });
});

describe('permissionsFromBody — pair form, optional cal', () => {
  it('real booleans parse; cal rides only when boolean', () => {
    expect(permissionsFromBody({ ax: true, sr: false, fda: true, relaunch: false, cal: true })).toEqual({
      ax: true, sr: false, fda: true, relaunch: false, cal: true,
    });
    expect(permissionsFromBody({ ax: true, sr: false, fda: true, relaunch: false })).toEqual({
      ax: true, sr: false, fda: true, relaunch: false,
    });
  });

  it('non-boolean cal → absent (never stored-clobbers)', () => {
    const p = permissionsFromBody({ ax: true, sr: true, fda: true, relaunch: true, cal: 'yes' });
    expect(p).toEqual(ADVERT4);
    expect(p && 'cal' in p).toBe(false);
  });

  it('partial/garbage body → undefined (unchanged 2f646c10 gate)', () => {
    expect(permissionsFromBody({ ax: true })).toBeUndefined();
    expect(permissionsFromBody(null)).toBeUndefined();
    expect(permissionsFromBody('x')).toBeUndefined();
  });
});

describe('poll/pair merge call sites (structural)', () => {
  it('the poll site merges per-key: mergeAgentPermissions(agentPermissions(agent), advertPerms)', () => {
    expect(controllerSrc).toMatch(/mergeAgentPermissions\(agentPermissions\(agent\), advertPerms\)/);
  });
  it('the pair site merges per-key: mergeAgentPermissions(agentPermissions(existing), advert.permissions)', () => {
    expect(serviceSrc).toMatch(/mergeAgentPermissions\(agentPermissions\(existing\), advert\.permissions\)/);
  });
});

// ─── 2. Calendar capability + gating ──────────────────────────────────────

describe('calendar capability (1ea9a120)', () => {
  it('is in KNOWN_CAPABILITIES alongside imessage/browser/computer', () => {
    expect(KNOWN_CAPABILITIES).toContain('calendar');
    expect([...KNOWN_CAPABILITIES]).toEqual(['imessage', 'browser', 'computer', 'calendar']);
  });

  it('an advertised calendar is the answer (no version gate)', () => {
    expect(hasCapability({ platform: 'macos', capabilities: ['imessage', 'calendar'] }, 'calendar')).toBe(true);
    expect(hasCapability({ platform: 'macos', capabilities: ['imessage'] }, 'calendar')).toBe(false);
  });

  it('legacy Mac: 0.7.0 capable, 0.6.3 NOT — LEGACY_MAC_CALENDAR_MIN [0,7,0]', () => {
    expect(LEGACY_MAC_CALENDAR_MIN).toEqual([0, 7, 0]);
    expect(hasCapability({ platform: 'macos', agentVersion: '0.7.0' }, 'calendar')).toBe(true);
    expect(hasCapability({ platform: 'macos', agentVersion: '0.6.3' }, 'calendar')).toBe(false);
  });

  it('a Windows row with no advertisement can do nothing', () => {
    expect(hasCapability({ platform: 'windows', agentVersion: '0.9.0' }, 'calendar')).toBe(false);
  });

  it('resolvedCapabilities renders calendar for advertising + 0.7.0 legacy rows, not below', () => {
    expect(resolvedCapabilities({ platform: 'macos', capabilities: ['imessage', 'calendar'] })).toEqual(['imessage', 'calendar']);
    expect(resolvedCapabilities({ platform: 'macos', agentVersion: '0.7.0' })).toContain('calendar');
    expect(resolvedCapabilities({ platform: 'macos', agentVersion: '0.6.3' })).not.toContain('calendar');
  });
});

// ─── 3. Tool registration + dispatch pins (structural) ─────────────────────

describe('mac_calendar_list_events registration + dispatch (structural pins)', () => {
  it('the tool schema registers mac_calendar_list_events with daysAhead + device params', () => {
    expect(schemaSrc).toMatch(/name:\s*'mac_calendar_list_events'/);
    expect(schemaSrc).toMatch(/daysAhead/);
    expect(schemaSrc).toMatch(/device:/);
    // The description must disambiguate from the Google calendar connector.
    expect(schemaSrc).toMatch(/NOT Google Calendar/);
  });

  it('coding-integrations dispatches the AGENT command calendar_list_events (name independence)', () => {
    const i = integrationsSrc.indexOf("case 'mac_calendar_list_events'");
    expect(i).toBeGreaterThanOrEqual(0);
    const body = integrationsSrc.slice(i, i + 5600);
    // Serve-time gate BEFORE the dispatch: platform + capability. 2026-11-06 —
    // the gate moved INTO the shared device policy (calendar/apple-calendar.ts
    // chooseAppleCalendarDevice), so it is now asserted where it lives; the
    // tool must not dispatch without consulting that policy.
    expect(body).toMatch(/readAppleCalendar\(userId/);
    const policySrc = readFileSync(join(here, '..', 'calendar', 'apple-calendar.ts'), 'utf8');
    expect(policySrc).toMatch(/agentPlatform\(a\) === 'macos'/);
    expect(policySrc).toMatch(/hasCapability\(a, 'calendar'\)/);
    expect(policySrc).toMatch(/agentBroker\.dispatch\(agent\.id, 'calendar_list_events', \{ days \}, timeoutMs\)/);
    // days passthrough + 30s timeout posture (the policy defaults to
    // IMESSAGE_READ_DISPATCH_TIMEOUT_MS, which IS the 30 000 ms budget).
    expect(body).toMatch(/args\.daysAhead != null \? Number\(args\.daysAhead\) : 7/);
    expect(readFileSync(join(here, '..', 'imessage', 'agent-link.ts'), 'utf8')).toMatch(/IMESSAGE_READ_DISPATCH_TIMEOUT_MS = [^;]*30_000/);
    // Structured unavailable is surfaced to the model, never thrown.
    expect(body).toMatch(/return tag \? `\$\{tag\} \$\{body\}` : body/);
  });
});
