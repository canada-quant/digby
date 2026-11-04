/**
 * Project Pulse dashboard pins (owner requirement 2026-09-04): the hourly
 * per-project summary + goal-progress/ETA chips render on the management
 * dashboard UNDER EACH PROJECT TITLE, joined from the digests the tab already
 * fetches on the same poll.
 *
 * SOURCE-LEVEL pins (the dashboard-polish idiom): DashboardTab is a
 * ~1600-line client component with useRouter + polling effects — a full
 * render is infeasible in the node-environment vitest setup, so pins anchor
 * on stable identifiers, never line numbers. The ProjectPulse component
 * itself is render-tested in components/ProjectPulse.test.tsx.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const SRC = readFileSync(fileURLToPath(new URL('./DashboardTab.tsx', import.meta.url)), 'utf8');

describe('DashboardTab [owner 2026-09-04] Project Pulse under the project titles', () => {
  it('imports the SHARED ProjectPulse component (one block for all three surfaces)', () => {
    expect(SRC).toContain("import { ProjectPulse } from '../components/ProjectPulse';");
  });

  it('joins the already-fetched digests by projectId (no second fetch)', () => {
    expect(SRC).toContain('const digestByProject = new Map((digests ?? []).map((d) => [d.projectId, d]));');
  });

  it('renders the pulse INSIDE the projects-table name cell, UNDER the project title', () => {
    // The Projects table region (anchored on its section id, ending before the
    // Coding Sessions card).
    const start = SRC.indexOf('id="fleet-projects-section"');
    // 'Coding Sessions' also appears in an earlier comment — search FROM the
    // projects section so the region ends at the next card, not before it.
    const end = SRC.indexOf('Coding Sessions', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const projectsTable = SRC.slice(start, end);
    const title = projectsTable.indexOf('<span className="font-medium">{p.name}</span>');
    const pulse = projectsTable.indexOf('<ProjectPulse digest={digestByProject.get(p.id) ?? null} compact');
    const cellClose = projectsTable.indexOf('</TableCell>');
    expect(title).toBeGreaterThanOrEqual(0);
    // UNDER the title: the pulse mounts after the name span, inside the SAME
    // (first, name) cell of the row.
    expect(pulse).toBeGreaterThan(title);
    expect(pulse).toBeLessThan(cellClose);
  });

  it('unsupervised projects (no digests by design) render no pulse line', () => {
    expect(SRC).toContain('{p.supervised !== false && (');
  });
});
