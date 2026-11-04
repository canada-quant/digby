/**
 * Project-supervisor toggle pins (2026-09-14): the per-project DEDICATED
 * supervisor flag (`projectSupervisorEnabled`) must be bound on BOTH toggle
 * surfaces — the management dashboard's projects table and the project
 * settings page. The flag is separate from `supervised` (the fleet-wildcard
 * opt-out): it defaults false, so the switches bind `=== true`.
 *
 * SOURCE-LEVEL pins (the dashboard-polish idiom, see
 * project-pulse-dashboard.test.ts): both surfaces are large client components
 * infeasible to render in the node-environment vitest setup, so pins anchor on
 * stable identifiers, never line numbers.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const DASHBOARD = readFileSync(fileURLToPath(new URL('./DashboardTab.tsx', import.meta.url)), 'utf8');
const PROJECT_PAGE = readFileSync(fileURLToPath(new URL('../projects/[id]/page.tsx', import.meta.url)), 'utf8');

describe('Project supervisor toggle [2026-09-14] — bound on both surfaces', () => {
  it('DashboardTab binds projectSupervisorEnabled and saves it via projectsApi.update', () => {
    expect(DASHBOARD).toContain('projectSupervisorEnabled');
    expect(DASHBOARD).toContain('await projectsApi.update(projectId, { projectSupervisorEnabled: enabled });');
    // Defaults false — checked only on explicit true (unlike supervised's !== false).
    expect(DASHBOARD).toContain('checked={p.projectSupervisorEnabled === true}');
  });

  it('DashboardTab labels the switch as the dedicated per-project agent', () => {
    expect(DASHBOARD).toContain('Project supervisor (dedicated agent for this project)');
  });

  it('projects/[id] settings page binds projectSupervisorEnabled and saves it via projectsApi.update', () => {
    expect(PROJECT_PAGE).toContain('projectSupervisorEnabled');
    expect(PROJECT_PAGE).toContain('await projectsApi.update(projectId, { projectSupervisorEnabled: enabled });');
    // The load path syncs the switch from the fetched project (explicit true only).
    expect(PROJECT_PAGE).toContain('setSupervisorEnabled(data.projectSupervisorEnabled === true);');
  });

  it('projects/[id] settings page labels the switch as the dedicated per-project agent', () => {
    expect(PROJECT_PAGE).toContain('Project supervisor (dedicated agent for this project)');
  });
});
