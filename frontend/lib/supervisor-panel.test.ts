/** Supervisor side-panel dashboards (owner 2026-10-08) — lib/supervisor-panel.ts + the CodeSessionView wiring. */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { supervisorPanelFor } from './supervisor-panel';
import { ProjectSupervisorPanel } from '../app/crossmodel/components/supervisor-panel/ProjectSupervisorPanel';
import { FleetSupervisorPanel } from '../app/crossmodel/components/supervisor-panel/FleetSupervisorPanel';
import { fmtCadence, fmtTokens, fmtUsd } from '../app/crossmodel/components/supervisor-panel/panel-ui';

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('supervisorPanelFor', () => {
  it('fleet for the Fleet Supervisor, project (with its id) for a project supervisor, nothing otherwise', () => {
    expect(supervisorPanelFor({ isSupervisor: true, projectId: null })).toEqual({ kind: 'fleet', projectId: null });
    expect(supervisorPanelFor({ isProjectSupervisor: true, projectId: 'p1' })).toEqual({ kind: 'project', projectId: 'p1' });
    expect(supervisorPanelFor({ isProjectSupervisor: true, projectId: null })).toBeNull();
    expect(supervisorPanelFor({ projectId: 'p1' })).toBeNull();
    expect(supervisorPanelFor(null)).toBeNull();
  });
});

describe('panels', () => {
  it('render their blocks (loading state on the server)', () => {
    const p = renderToStaticMarkup(createElement(ProjectSupervisorPanel, { projectId: 'p1', selfChatId: 'c1' }));
    expect(p).toContain('data-supervisor-panel="project"');
    for (const t of ['Cost &amp; tokens', 'Goals', 'Working now', 'Schedules', 'Project page']) expect(p).toContain(t);
    expect(p).toContain('href="/projects/p1"');
    const f = renderToStaticMarkup(createElement(FleetSupervisorPanel, { selfChatId: 'c1' }));
    expect(f).toContain('data-supervisor-panel="fleet"');
    for (const t of ['Running sessions', 'Cost &amp; tokens', 'Projects', 'Running now', 'Management']) expect(f).toContain(t);
  });

  it('formatters', () => {
    expect(fmtUsd(0)).toBe('$0');
    expect(fmtUsd(0.004)).toBe('<$0.01');
    expect(fmtUsd(12.345)).toBe('$12.35');
    expect(fmtUsd(1234)).toBe('$1,234');
    expect(fmtTokens(1_250_000)).toBe('1.3M');
    expect(fmtTokens(48_200)).toBe('48K');
    expect(fmtCadence('recurring', 7200)).toBe('every 2h');
    expect(fmtCadence('recurring', 1800)).toBe('every 30m');
    expect(fmtCadence('once', null)).toBe('once');
  });

  it('CodeSessionView leads the side panel with the supervisor section and opens it', () => {
    const v = src('../app/crossmodel/components/CodeSessionView.tsx');
    expect(v).toContain("crossModelApi.getChat(chatId, { messageLimit: 1 })");
    expect(v).toContain('setSupervisorPanel(supervisorPanelFor(full))');
    expect(v).toContain('openWorkspaceSection(supervisorPanel.kind)');
    expect(v).toContain('sections={withLeadSection(supervisorSection, plain');
  });
});

/* ── 2026-10-20: every supervisor-panel tab body scrolls on its own ───────────
 * WorkspacePanel mounts a tab in a `flex-1 min-h-0 overflow-hidden` slot, so a
 * tab root without its own scroll container clips everything below the window
 * edge (owner: "it's only the project tab in the sidebar that won't scroll"). */
describe('supervisor panel roots are scroll containers', () => {
  it('Project and Fleet roots carry h-full + overflow-y-auto', () => {
    const p = src('../app/crossmodel/components/supervisor-panel/ProjectSupervisorPanel.tsx');
    const f = src('../app/crossmodel/components/supervisor-panel/FleetSupervisorPanel.tsx');
    for (const body of [p, f]) {
      const root = body.match(/<div className="([^"]*)" data-supervisor-panel="(project|fleet)">/);
      expect(root, 'root div with data-supervisor-panel missing').toBeTruthy();
      expect(root![1]).toContain('h-full');
      expect(root![1]).toContain('overflow-y-auto');
    }
    // The host slot is what makes the tab responsible for its own scrolling.
    expect(src('../app/crossmodel/components/WorkspacePanel.tsx')).toContain('<div className="flex-1 min-h-0 overflow-hidden">{current.node}</div>');
  });
});
