/**
 * Owner 2026-09-29 (the digby-benchmarks recording): the hourly status card
 * leads with the at-a-glance update; older cards are one line; background
 * wakes between visible rows fold into one bundle.
 */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ProjectStatusCard, { changeCountText, detailsLabel } from './ProjectStatusCard';
import MachineBundle, { bundleLabel } from './MachineBundle';
import { normalizeProjectUpdate } from '@/lib/machine-wake';
import { bundleMachineGroups, groupMachineRows, type MachineRowProbe } from '@/lib/machine-turn-grouping';
import { classifyWakeHeadline } from '@/lib/fleet-summary';

const UPDATE = {
  state: 'working', stateLabel: 'Working',
  focus: 'TB 2.1 v3 full-framework run',
  progress: { done: 66, total: 89, label: 'v3 run' },
  summary: 'TB 2.1 v3 full-framework run · 66 of 89 done (74%) · about 2 h left at this pace',
  changes: ['Progress: 61 → 66 of 89', '2 work sessions hit an error'],
  needsYou: ['Rerun the failures at 2× timeout?'],
  needsYouCount: 1,
  nextCheckAt: '2026-09-28T23:03:00.000Z',
  since: '2026-09-28T21:06:00.000Z',
};
const STATUS = {
  projectName: 'digby-benchmarks', headline: 'digby-benchmarks: 1 of 4 goals active, 3 done; 1 lane working',
  workingOn: ['TB 2.1 v3 — production LiteLLM seat + supervisor-routed full-framework run'], doneSince: [], blocked: [], next: [],
  goals: { active: 1, done: 3, blocked: 0 }, lanesRunning: 1, ownerItems: 1,
};
const BRIEF = {
  mission: 'The project benchmarks the Digby coding harness.', now: 'A full run is underway.',
  asks: [
    { at: '2026-09-28T20:40:00.000Z', text: 'thats fine you can let it finish then re run failures', status: 'open', note: 'Steer sent.' },
    { at: '2026-09-28T18:24:00.000Z', text: 'where are things at ?', status: 'done', note: 'Status given.' },
  ],
};

describe('normalizeProjectUpdate', () => {
  it('parses the wire shape defensively', () => {
    const u = normalizeProjectUpdate(UPDATE)!;
    expect(u.state).toBe('working');
    expect(u.progress).toEqual({ done: 66, total: 89, label: 'v3 run' });
    expect(u.needsYouCount).toBe(1);
    expect(normalizeProjectUpdate({ ...UPDATE, state: 'bogus' })).toBeUndefined();
    expect(normalizeProjectUpdate({ ...UPDATE, summary: '' })).toBeUndefined();
    expect(normalizeProjectUpdate({ ...UPDATE, progress: { done: 90, total: 89 } })!.progress).toBeUndefined();
    expect(normalizeProjectUpdate(null)).toBeUndefined();
  });
});

describe('ProjectStatusCard with an update', () => {
  const render = (extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(ProjectStatusCard, {
    content: '**digby-benchmarks: …**', status: STATUS, brief: BRIEF, update: UPDATE, generatedAt: '2026-09-28T22:06:00.000Z', ...extra,
  }));

  it('leads with the pill, the summary, the progress bar, what changed and what needs you — details collapsed', () => {
    const html = render();
    expect(html).toContain('data-update-state="working"');
    expect(html).toContain('>Working<');
    expect(html).toContain('66 of 89 done (74%)');
    expect(html).toContain('data-update-progress');
    expect(html).toContain('Since the last update');
    expect(html).toContain('Progress: 61 → 66 of 89');
    expect(html).toContain('Needs you');
    expect(html).toContain('“Rerun the failures at 2× timeout?”');
    expect(html).toContain('Next check');
    // The paraphrase, the lanes and the request log sit behind the collapsed toggle.
    expect(html).toContain('data-update-details');
    expect(html).toContain('1 open request of yours');
    expect(html).not.toContain('The project benchmarks the Digby coding harness.');
    expect(html).not.toContain('where are things at');
  });

  it('nothing changed / nothing needs you reads plainly', () => {
    const html = render({ update: { ...UPDATE, state: 'idle', stateLabel: 'Idle', changes: [], needsYou: [], needsYouCount: 0 }, status: { ...STATUS, ownerItems: 0 } });
    expect(html).toContain('No change since the last update.');
    expect(html).toContain('Nothing needs you.');
  });

  it('a superseded card is ONE line: pill · time · summary · change count', () => {
    const html = render({ superseded: true });
    expect(html).toContain('data-status-superseded');
    expect(html).toContain('>Working<');
    expect(html).toContain('· 2 changes');
    expect(html).not.toContain('Since the last update');
    expect(html).not.toContain('data-update-details');
  });

  it('a quiet stub with an update shows the pill and the quiet line, no details', () => {
    const html = render({ unchanged: true, quietSince: '2026-09-28T21:06:00.000Z', quietChecks: 3, update: { ...UPDATE, changes: [] } });
    expect(html).toContain('data-status-compact');
    expect(html).toContain('No change since');
    expect(html).toContain('checked 3 times');
    expect(html).not.toContain('data-update-details');
    expect(renderToStaticMarkup(createElement(ProjectStatusCard, { content: '', status: STATUS, update: { ...UPDATE, changes: [] }, unchanged: true, superseded: true }))).toContain('· no change');
  });

  it('rows without an update (older rows) render the previous layout', () => {
    const html = render({ update: undefined });
    expect(html).not.toContain('data-project-update');
    expect(html).toContain('In plain words');
  });

  it('helpers', () => {
    expect(changeCountText({ changes: [] })).toBe('no change');
    expect(changeCountText({ changes: ['a', 'b', 'c', 'd', 'e', '…and 3 more changes'] })).toBe('8 changes');
    expect(detailsLabel({ hasBrief: true, hasTiming: true, openAsks: 0, asks: 2 })).toBe('Details — summary, lanes and goals · your recent requests');
    expect(detailsLabel({ hasBrief: false, hasTiming: false, openAsks: 0, asks: 0 })).toBe('Details');
  });
});

// ── Bundling ───────────────────────────────────────────────────────────────
type Row = { id: string; role: string; content: string; origin?: string; ownerArmed?: boolean };
const wake = (id: string): Row => ({ id, role: 'user', content: `[MACHINE-TRIGGERED RUN — schedule] sweep ${id}`, origin: 'schedule' });
const note = (id: string, text: string): Row => ({ id, role: 'assistant', content: text });
const probe = (r: Row): MachineRowProbe => ({ id: r.id, role: r.role, content: r.content, origin: r.origin, ownerArmed: r.ownerArmed });
const status = (id: string): Row => ({ id, role: 'assistant', content: '**card**', origin: 'project_status' });

describe('bundleMachineGroups', () => {
  it('folds consecutive wakes between visible rows into ONE bundle; status cards and humans break it; a lone wake stays a group', () => {
    const rows: Row[] = [
      status('s1'),
      wake('w1'), note('n1', 'Lane checked this wake: healthy, no action needed.'),
      wake('w2'), note('n2', 'Sweep complete. Fresh ledger pulled.'),
      wake('w3'), note('n3', 'Settle-check outcome: the lane failed its probe'),
      status('s2'),
      wake('w4'), note('n4', 'WAKE: no-op'),
      { id: 'h1', role: 'user', content: 'where are we at' },
    ];
    const items = bundleMachineGroups(groupMachineRows(rows, { probe }));
    expect(items.map((i) => i.kind)).toEqual(['row', 'machineBundle', 'row', 'machineGroup', 'row']);
    const b = items[1] as any;
    expect(b.groups).toHaveLength(3);
    expect(b.rowCount).toBe(6);
    expect(b.attention).toBe(1);
    expect(b.latest).toContain('Settle-check outcome');
  });

  it('never bundles a pinned group (owner-armed digest)', () => {
    const rows: Row[] = [wake('w1'), note('n1', 'a'), { ...wake('w2'), ownerArmed: true }, note('n2', 'digest'), wake('w3'), note('n3', 'c')];
    expect(bundleMachineGroups(groupMachineRows(rows, { probe })).map((i) => i.kind)).toEqual(['machineGroup', 'machineGroup', 'machineGroup']);
  });

  it('the bundle row reads as one line and stays collapsed', () => {
    expect(bundleLabel({ groups: 3, firstTime: '9:16 PM', lastTime: '11:16 PM', attention: 1 })).toBe('3 background check-ins · 9:16 PM – 11:16 PM · 1 flagged a problem');
    const html = renderToStaticMarkup(createElement(MachineBundle, { groups: 2, firstTime: '1 PM', lastTime: '2 PM', attention: 0, latest: 'Sweep complete' }, createElement('div', null, 'INNER')));
    expect(html).toContain('2 background check-ins · 1 PM – 2 PM');
    expect(html).toContain('latest: Sweep complete');
    expect(html).not.toContain('INNER');
  });

  it('the supervisors\' quiet phrasings classify quiet', () => {
    expect(classifyWakeHeadline('Lane checked this wake (12:38 PM): healthy, no action needed.')).toBe('quiet');
    expect(classifyWakeHeadline('v3 lane is live and healthy — nothing needs the owner.')).toBe('quiet');
  });
});

describe('messages between agents, sessions and sub-sessions (owner 2026-09-29)', () => {
  type R = { id: string; role: string; content: string; origin?: string; kind?: string };
  const p = (r: R): MachineRowProbe => ({ id: r.id, role: r.role, content: r.content, origin: r.origin, kind: r.kind });

  it('a sub-session hand-off row and a continuation result stay VISIBLE rows even right after a machine turn', () => {
    const rows: R[] = [
      { id: 'u1', role: 'user', content: 'build me the deck' },
      { id: 'a1', role: 'assistant', content: 'Started a session for the deck.' },
      { id: 'w1', role: 'user', content: '[HARNESS CONTINUATION r1/3] keep going', origin: 'schedule' },
      { id: 'a2', role: 'assistant', content: 'Here is the finished comparison.', kind: 'continuation_result' },
      { id: 'w2', role: 'user', content: '[MACHINE-TRIGGERED RUN — schedule] sweep', origin: 'schedule' },
      { id: 'a3', role: 'assistant', content: 'noted' },
      { id: 'h1', role: 'assistant', content: '**Result: DGX deck**\n**Deliverables**', kind: 'deliverable_handoff', origin: 'deliverable_handoff' },
    ];
    const items = groupMachineRows(rows, { probe: p });
    const visible = items.filter((i) => i.kind === 'row').map((i: any) => i.row.id);
    expect(visible).toEqual(['u1', 'a1', 'a2', 'h1']);
    expect(items.filter((i) => i.kind === 'machineGroup').map((g: any) => g.rows.map((r: R) => r.id))).toEqual([['w1'], ['w2', 'a3']]);
  });

  it('lane ↔ supervisor messages fold into the bundle but the bundle row says how many there are', () => {
    const rows: R[] = [
      { id: 'w1', role: 'user', content: '[MACHINE-TRIGGERED RUN — schedule] sweep', origin: 'schedule' },
      { id: 'g1', role: 'user', content: '[AGENT-SENT MESSAGE from "bench lane"] done with batch 3', origin: 'agent' },
      { id: 'n1', role: 'assistant', content: 'Acknowledged.' },
      { id: 'w2', role: 'user', content: '[MACHINE-TRIGGERED RUN — schedule] sweep', origin: 'schedule' },
      { id: 'n2', role: 'assistant', content: 'WAKE: no-op' },
    ];
    const [b] = bundleMachineGroups(groupMachineRows(rows, { probe: p })) as any[];
    expect(b.kind).toBe('machineBundle');
    expect(b.agentMessages).toBe(1);
    expect(bundleLabel({ groups: 2, attention: 0, agentMessages: 1 })).toBe('2 background check-ins · 1 message between agents');
  });
});
