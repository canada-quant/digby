/**
 * misfiled-spawns-4 (tt-rd audit 2026-09-27): the Fleet Supervisor's spawns are
 * never corrected by the home-project pin (an ungrouped caller has no home),
 * and the doctrine nowhere said WHERE a spawn is filed — so a framework fix it
 * spawns could land in a user project with no rule broken. The filing rule
 * lives in the fleet precedence rule (core-doctrine.ts corePrecedenceRule —
 * fleet system prompt + sweep doctrine block). build 2026-10-08 S-2: these pins
 * moved off the dated pre-layering FLEET_PRECEDENCE_RULE (deleted with the
 * legacy builders) onto the layered rule prod actually sends.
 * Prompt text only — the deterministic backstop is observe-only (platform-tools).
 */

import { corePrecedenceRule } from './core-doctrine';

describe('supervisor doctrine — spawn filing rule (misfiled-spawns-4)', () => {
  it('the fleet precedence rule says where a spawn is filed and that the reporter project is never the fix project', () => {
    const fleet = corePrecedenceRule('fleet');
    expect(fleet).toContain('FILE A SPAWN WHERE ITS REPO IS');
    expect(fleet).toContain("framework / harness work → the project holding the platform's own repository (list_projects names it)");
    expect(fleet).toContain('Never file framework work under the project that REPORTED the bug');
    expect(fleet).toContain("a ticket's context.projectId is where the reporter was, not where the fix lives");
  });

  it('the rule is a single bullet (one line) so the sweep doctrine block stays inside its 7,000-char clip budget', () => {
    const lines = corePrecedenceRule('fleet').split('\n').filter((l) => l.includes('FILE A SPAWN WHERE ITS REPO IS'));
    expect(lines).toHaveLength(1);
    expect(lines[0].length).toBeLessThan(600);
  });

  it('the project-supervisor precedence rule does not carry it — a project supervisor always spawns into its own project (its prompt pins projectId)', () => {
    expect(corePrecedenceRule('project')).not.toContain('FILE A SPAWN WHERE ITS REPO IS');
  });
});
