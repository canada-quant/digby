/**
 * Schedules tab (rm9) — pins for the workspace panel's per-chat Schedules
 * section: pure helpers, the SSR-rendered pure view (ChatFilesSection
 * idiom — node-environment vitest, react-dom/server, initial state only), and
 * source-level mount pins (both panel mounts build the tab through the
 * registry; the old Overview schedules block is consolidated to a one-line
 * pointer, ONE source of truth).
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

import {
  SchedulesSectionView,
  type SchedulesSectionViewProps,
  cadenceLabel,
  isCompleted,
  isFoldedCompleted,
  partitionSchedules,
  UNDO_WINDOW_MS,
} from './SchedulesSection';
import type { ChatScheduleRow } from '@/lib/api/crossmodel';

const readSrc = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const NOW = Date.now();
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const HOUR = 3_600_000;

const row = (over: Partial<ChatScheduleRow> & { id: string }): ChatScheduleRow => ({
  kind: 'recurring',
  prompt: 'check the fleet and report anomalies',
  intervalSec: 3600,
  nextRunAt: iso(HOUR),
  enabled: true,
  runsCount: 3,
  maxRuns: 500,
  expiresAt: iso(30 * 24 * HOUR),
  lastFiredAt: iso(-HOUR),
  lastStatus: 'started',
  cancelledBy: null,
  disabledAt: null,
  dailyFiresUsed: 3,
  dailyCapLimit: 48,
  capWindowResetsAt: null,
  projectedDailyFirings: 24,
  clockDriftMinutes: null,
  projectedNextFirings: null,
  ...over,
});

const noop = () => {};
const render = (over: Partial<SchedulesSectionViewProps> = {}) =>
  renderToStaticMarkup(createElement(SchedulesSectionView, {
    rows: [],
    loadError: false,
    hasChat: true,
    busyId: null,
    undoIds: new Set<string>(),
    expandedIds: new Set<string>(),
    warning: null,
    refreshing: false,
    onToggleCompleted: noop,
    onRetry: noop, onRefresh: noop, onCancel: noop, onToggleEnabled: noop, onUndo: noop, onToggleExpand: noop,
    ...over,
  }));

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe('cadenceLabel', () => {
  it("'once' for one-shots regardless of intervalSec", () => {
    expect(cadenceLabel({ kind: 'once', intervalSec: 900 })).toBe('once');
  });

  it('formats recurring cadence through formatInterval ("every 60m")', () => {
    expect(cadenceLabel({ kind: 'recurring', intervalSec: 3600 })).toBe('every 1h');
    expect(cadenceLabel({ kind: 'recurring', intervalSec: 90 * 60 })).toBe('every 90m');
  });

  it("falls back to 'recurring' when intervalSec is missing", () => {
    expect(cadenceLabel({ kind: 'recurring', intervalSec: null })).toBe('recurring');
  });
});

describe('isCompleted (Resume is hidden for rows the server would 409)', () => {
  it('run-capped recurring schedules are completed', () => {
    expect(isCompleted({ kind: 'recurring', runsCount: 5, maxRuns: 5 })).toBe(true);
    expect(isCompleted({ kind: 'recurring', runsCount: 4, maxRuns: 5 })).toBe(false);
  });

  it('a fired once-schedule is completed even without maxRuns', () => {
    expect(isCompleted({ kind: 'once', runsCount: 1, maxRuns: null })).toBe(true);
    expect(isCompleted({ kind: 'once', runsCount: 0, maxRuns: 1 })).toBe(false);
  });

  it('unbounded recurring schedules never complete', () => {
    expect(isCompleted({ kind: 'recurring', runsCount: 400, maxRuns: null })).toBe(false);
  });
});

describe('UNDO_WINDOW_MS', () => {
  it('is the documented ~8s window', () => {
    expect(UNDO_WINDOW_MS).toBe(8_000);
  });
});

// ── SSR view pins ─────────────────────────────────────────────────────────────

describe('SchedulesSectionView states', () => {
  it('empty state carries the agent-can-create copy', () => {
    const html = render({ rows: [] });
    expect(html).toContain('No schedules — the agent can create one, or ask it to run this chat on a cadence.');
  });

  it('loading (rows null) renders a spinner, not the empty state', () => {
    const html = render({ rows: null });
    expect(html).toContain('animate-spin');
    expect(html).not.toContain('No schedules');
  });

  it('chatless mounts explain rather than fetch (hasChat false)', () => {
    const html = render({ hasChat: false, rows: null });
    expect(html).toContain('Schedules attach to a chat');
    expect(html).not.toContain('animate-spin');
  });

  it('hard error with no rows: compact error row with Retry — the panel never blanks', () => {
    const html = render({ rows: null, loadError: true });
    expect(html).toContain('Could not load schedules.');
    expect(html).toContain('Retry');
  });

  it('error WITH previously loaded rows keeps the rows and says they are stale', () => {
    const html = render({ rows: [row({ id: 's1' })], loadError: true });
    expect(html).toContain('Could not refresh — showing the last loaded schedules.');
    expect(html).toContain('check the fleet and report anomalies');
  });

  it('a row renders cadence, next fire, last status, runs count, and the prompt preview', () => {
    const html = render({ rows: [row({ id: 's1', runsCount: 3, maxRuns: 500, lastStatus: 'started' })] });
    expect(html).toContain('every 1h');
    expect(html).toContain('next in ');
    expect(html).toContain('started');
    expect(html).toContain('3/500 runs');
    expect(html).toContain('check the fleet and report anomalies');
  });

  it('enabled rows expose Pause + Cancel with NO confirmation dialog markup', () => {
    const html = render({ rows: [row({ id: 's1' })] });
    expect(html).toContain('aria-label="Pause schedule"');
    expect(html).toContain('aria-label="Cancel schedule"');
    expect(html).not.toContain('AlertDialog');
    expect(html).not.toContain('Are you sure');
  });

  it('a paused row offers Resume; a completed row offers nothing', () => {
    const paused = render({ rows: [row({ id: 's1', enabled: false, lastStatus: 'paused' })] });
    expect(paused).toContain('aria-label="Resume schedule"');
    const completed = render({ rows: [row({ id: 's2', enabled: false, lastStatus: 'expired', kind: 'once', runsCount: 1, maxRuns: 1 })] });
    expect(completed).not.toContain('aria-label="Resume schedule"');
    expect(completed).toContain('completed');
  });

  it('d36344ed: a MACHINE-paused row (paused:provider_failures) ALSO offers Resume — the attention text points here', () => {
    const html = render({ rows: [row({ id: 's1', enabled: false, lastStatus: 'paused:provider_failures' })] });
    expect(html).toContain('aria-label="Resume schedule"');
    expect(html).toContain('paused:provider_failures');
  });

  it('a just-cancelled row greys out and shows the inline "Cancelled — Undo" affordance', () => {
    const html = render({ rows: [row({ id: 's1', enabled: false, lastStatus: 'cancelled' })], undoIds: new Set(['s1']) });
    expect(html).toContain('Cancelled — Undo');
    expect(html).toContain('opacity-60');
    // While undoable the row must not ALSO offer Resume/Pause (one affordance).
    expect(html).not.toContain('aria-label="Resume schedule"');
    expect(html).not.toContain('aria-label="Pause schedule"');
  });

  it('the backend deaf-lane warning surfaces verbatim', () => {
    const warning = 'WARNING — chat abc now has NO enabled schedules';
    const html = render({ rows: [], warning });
    expect(html).toContain('NO enabled schedules');
  });

  it('long prompts get the expand affordance; expanded rows drop the 2-line clamp', () => {
    const long = row({ id: 's1', prompt: 'x'.repeat(400) });
    const collapsed = render({ rows: [long] });
    expect(collapsed).toContain('aria-label="Show full prompt"');
    expect(collapsed).toContain('line-clamp-2');
    const expanded = render({ rows: [long], expandedIds: new Set(['s1']) });
    expect(expanded).toContain('aria-label="Collapse prompt"');
    expect(expanded).toContain('whitespace-pre-wrap');
  });

  it('an in-flight action disables that row (busyId)', () => {
    const html = render({ rows: [row({ id: 's1' })], busyId: 's1' });
    expect(html).toContain('disabled');
  });
});

// ── Source-level mount pins (both panels build the tab via the registry) ──────

describe('cap-burn projection chip (ticket 2694a581)', () => {
  it('renders ≈N/day for a recurring row under the cap, without the flag', () => {
    const html = render({ rows: [row({ id: 'a', intervalSec: 3600, projectedDailyFirings: 24, dailyCapLimit: 48 })] });
    expect(html).toContain('≈24/day');
    expect(html).not.toContain('⚠ cap');
  });

  it('flags a recurring row whose cadence alone reaches the cap', () => {
    const html = render({ rows: [row({ id: 'a', intervalSec: 1800, projectedDailyFirings: 48, dailyCapLimit: 48 })] });
    expect(html).toContain('≈48/day');
    expect(html).toContain('⚠ cap');
  });

  it('renders nothing for one-shots or missing projection', () => {
    const html = render({ rows: [
      row({ id: 'a', kind: 'once', projectedDailyFirings: null }),
      row({ id: 'b', projectedDailyFirings: null }),
    ] });
    expect(html).not.toContain('/day');
  });
});

describe('clock-drift chip (ticket 903249e5)', () => {
  it('flags a ≥12h non-day-divisor cadence with the signed per-firing drift', () => {
    // The incident cadence: 1219m → each firing 221 min EARLIER than the last.
    const html = render({ rows: [row({ id: 'a', intervalSec: 1219 * 60, clockDriftMinutes: -221, projectedNextFirings: ['2026-09-25T07:36:00Z'] })] });
    expect(html).toContain('⚠ drift -221m/firing');
  });

  it('renders nothing for day-divisor / whole-day cadences (0 drift)', () => {
    const html = render({ rows: [row({ id: 'a', intervalSec: 1440 * 60, clockDriftMinutes: 0, projectedNextFirings: ['2026-09-25T07:36:00Z'] })] });
    expect(html).not.toContain('drift');
  });

  it('renders nothing for one-shots (drift fields null)', () => {
    const html = render({ rows: [row({ id: 'a', kind: 'once', intervalSec: 1219 * 60, clockDriftMinutes: null, projectedNextFirings: null })] });
    expect(html).not.toContain('drift');
  });
});

describe('Schedules tab mounts (source pins — c1 idiom)', () => {
  const VIEW = readSrc('./CodeSessionView.tsx');
  const PAGE = readSrc('../page.tsx');

  it('CodeSessionView coding registry maps schedules → <SchedulesSection chatId={chatId}>', () => {
    expect(VIEW).toContain("import SchedulesSection, { ScheduleCountLine } from './SchedulesSection';");
    expect(VIEW).toContain("case 'schedules': return { id: sid, label: WORKSPACE_SECTION_LABELS[sid], icon: <CalendarClock className=\"size-3.5\" />, node: <SchedulesSection chatId={chatId} /> };");
  });

  it('page.tsx plain registry maps schedules → <SchedulesSection chatId=…> (chats have schedules too)', () => {
    expect(PAGE).toContain("import SchedulesSection from './components/SchedulesSection';");
    expect(PAGE).toContain('<SchedulesSection chatId={currentChatId || codeChatId} />');
  });

  it('the Overview keeps ONE source of truth: the count line pointer, not a second row list', () => {
    expect(VIEW).toContain('<ScheduleCountLine chatId={session.id} />');
    // The old display-only Overview schedules block is gone from the view.
    expect(VIEW).not.toContain('No schedules on this session.');
  });
});

// ── Completed accordion (ticket cd0270c0) ────────────────────────────────────

describe('isFoldedCompleted (cd0270c0: completed AND stopped rows fold)', () => {
  it('a fired, disabled once-schedule folds', () => {
    expect(isFoldedCompleted({ kind: 'once', runsCount: 1, maxRuns: null, enabled: false })).toBe(true);
  });

  it('a cancelled NEVER-fired once-schedule stays in the live list (it is not completed)', () => {
    expect(isFoldedCompleted({ kind: 'once', runsCount: 0, maxRuns: 1, enabled: false })).toBe(false);
  });

  it('a run-capped recurring row folds too (same terminal class)', () => {
    expect(isFoldedCompleted({ kind: 'recurring', runsCount: 5, maxRuns: 5, enabled: false })).toBe(true);
  });

  it('an ENABLED completed row stays visible as live until it settles', () => {
    expect(isFoldedCompleted({ kind: 'once', runsCount: 1, maxRuns: null, enabled: true })).toBe(false);
  });

  it('a merely stopped (not completed) recurring row stays live — Resume must stay reachable', () => {
    expect(isFoldedCompleted({ kind: 'recurring', runsCount: 3, maxRuns: null, enabled: false })).toBe(false);
  });
});

describe('partitionSchedules (cd0270c0)', () => {
  it('splits live from completed, preserving order within each group', () => {
    const live = row({ id: 'live1' });
    const done = row({ id: 'done1', kind: 'once', runsCount: 1, maxRuns: 1, enabled: false, lastStatus: 'started' });
    const { liveRows, completedRows } = partitionSchedules([done, live]);
    expect(liveRows.map(r => r.id)).toEqual(['live1']);
    expect(completedRows.map(r => r.id)).toEqual(['done1']);
  });
});

describe('Completed accordion rendering (cd0270c0)', () => {
  const onceDone = (id: string) =>
    row({ id, kind: 'once', runsCount: 1, maxRuns: 1, enabled: false, lastStatus: 'started', lastFiredAt: iso(-HOUR), prompt: 'digest rung ' + id });
  const onceArmed = (id: string) =>
    row({ id, kind: 'once', runsCount: 0, maxRuns: 1, enabled: true, lastStatus: null, prompt: 'verify rung ' + id });

  it('the incident shape (2 live, 8 completed) collapses completed rows behind a Completed (8) accordion', () => {
    const rows = [onceArmed('a1'), onceArmed('a2'), ...[1, 2, 3, 4, 5, 6, 7, 8].map(i => onceDone('d' + i))];
    const html = render({ rows });
    expect(html).toContain('Completed (8)');
    // The completed prompts are hidden behind the collapsed accordion; the live ones render.
    expect(html).toContain('verify rung a1');
    expect(html).not.toContain('digest rung d1');
    expect(html).not.toContain('digest rung d8');
    // The accordion is a disclosure: aria-expanded=false, collapsed by default.
    expect(html).toContain('aria-expanded="false"');
  });

  it('no completed rows → no accordion at all', () => {
    const html = render({ rows: [onceArmed('a1')] });
    expect(html).not.toContain('Completed (');
    expect(html).not.toContain('completed-accordion');
  });

  it('completedOpen=true expands the accordion and renders the completed rows', () => {
    const html = render({ rows: [onceArmed('a1'), onceDone('d1')], completedOpen: true });
    expect(html).toContain('Completed (1)');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('digest rung d1');
  });

  it('the accordion renders even when ALL rows are completed (the live list is empty but the panel must not blank)', () => {
    const html = render({ rows: [onceDone('d1'), onceDone('d2')] });
    expect(html).toContain('Completed (2)');
    expect(html).not.toContain('No schedules');
  });

  it('the "stopped" rows with a paused lastStatus keep their Resume button (not folded)', () => {
    const html = render({ rows: [row({ id: 'p1', enabled: false, lastStatus: 'paused:provider_failures' })] });
    expect(html).toContain('aria-label="Resume schedule"');
    expect(html).not.toContain('Completed (');
  });
});

describe('review D1: a fired once-row inside its Undo window never folds', () => {
  it('a just-cancelled FIRED once-schedule stays in the live list with its Undo affordance', () => {
    const fired = row({ id: 'f1', kind: 'once', runsCount: 1, maxRuns: 1, enabled: false, lastStatus: 'cancelled', prompt: 'digest rung f1' });
    // Same row WITHOUT the undo window: it folds (the accordion path).
    const folded = render({ rows: [fired] });
    expect(folded).toContain('Completed (1)');
    // WITH the undo window (review D1): stays live, Undo visible.
    const live = render({ rows: [fired], undoIds: new Set(['f1']) });
    expect(live).toContain('Cancelled — Undo');
    expect(live).toContain('digest rung f1');
    expect(live).not.toContain('Completed (1)');
  });
});
