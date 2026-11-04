/**
 * Supervisor OFF switch (owner 2026-09-26) — pure presentation helpers shared
 * by the Admin "Supervisors" panel (account/SupervisorsSection.tsx) and the
 * Management Status card (management/SupervisorOverviewPanel.tsx). The
 * backend composes the canonical status `line`; these helpers only render the
 * per-target facts (since / by / skipped) and the panel copy. No fetching.
 */

import type { SupervisorSwitchState, SupervisorSwitchTargetState } from '@/lib/api/fleet';

export const FLEET_SUPERVISOR_ENABLED_KEY = 'fleet_supervisor_enabled';
export const PROJECT_SUPERVISORS_ENABLED_KEY = 'project_supervisors_enabled';

export const SUPERVISOR_SWITCH_LABEL: Record<'fleet' | 'project', string> = {
  fleet: 'Fleet supervisor',
  project: 'Project supervisors',
};

/** What OFF means — the panel's explainer, one fact per line (also pinned by the vitest). */
export const SUPERVISOR_OFF_FACTS: readonly string[] = [
  'Machine wakes to that supervisor tier are skipped and counted: event hooks, its recurring sweeps, infra alerts, follow-through nudges, and the spawn of new worker sessions by it.',
  'Nothing skipped is replayed when you turn it back on — it resumes with new events only.',
  'A run already in flight is never killed; it finishes.',
  'Your lanes, coding sessions and normal chats are unaffected; typing into the supervisor chat still works.',
  'Turn it back on to resume. The switch is admin-only — the supervisor cannot re-enable itself.',
];

/** "2026-09-26 17:30Z" from an ISO stamp; null-safe. */
export function formatSwitchSince(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

/** The per-target fact line: "OFF since 2026-09-26 17:30Z by paul@… — wakes skipped: 7" | "ON since …" | "ON (default)". */
export function describeSwitchTarget(t: SupervisorSwitchTargetState): string {
  const since = formatSwitchSince(t.since);
  const by = t.updatedBy ? ` by ${t.updatedBy}` : '';
  if (t.enabled) return since ? `ON since ${since}${by}` : `ON (default${t.source === 'env' ? `, env ${t.envVar}` : ''})`;
  const skipped = t.skipped == null ? 'n/a' : String(t.skipped);
  const when = since ? `since ${since}${by}` : `since boot (env ${t.envVar})`;
  return `OFF ${when} — wakes skipped: ${skipped}`;
}

/** Total skipped wakes across OFF targets (null when every OFF counter is unreadable; 0 when nothing is off). */
export function totalSkipped(state: SupervisorSwitchState | null | undefined): number | null {
  if (!state) return null;
  const off = [state.fleet, state.project].filter((t) => !t.enabled);
  if (!off.length) return 0;
  const known = off.map((t) => t.skipped).filter((n): n is number => typeof n === 'number');
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}

/** True when either tier is OFF (drives the Status-card badge). */
export function anySwitchOff(state: SupervisorSwitchState | null | undefined): boolean {
  return !!state && (!state.fleet.enabled || !state.project.enabled);
}

/** The confirm-dialog copy for turning a tier OFF. */
export function confirmOffCopy(target: 'fleet' | 'project'): { title: string; body: string } {
  const label = SUPERVISOR_SWITCH_LABEL[target];
  return {
    title: `Turn ${label.toLowerCase()} off?`,
    body: target === 'fleet'
      ? 'The Fleet Supervisor stops being woken: no hook wakes, no sweeps, no infra alerts, no nudges, and it cannot spawn sessions. Skipped wakes are counted, never replayed. Any run already in flight finishes. Lanes and your chats keep working.'
      : 'Every project supervisor lane stops being woken and cannot spawn worker sessions; none is scaffolded while off. Skipped wakes are counted, never replayed. Runs already in flight finish. Lanes and your chats keep working.',
  };
}
