/**
 * TEST FIXTURE — a ProjectBrief with EVERY cap filled and exceeded: the input
 * of the project-layer budget pins in prompt-layers.test.ts (the render is
 * fitted to PROJECT_BRIEF_BUDGET) and prompt-hygiene.test.ts (the composed
 * prompt lints clean with it). Not used at runtime. Synthetic content only —
 * no project name, model id or incident id (the lint exempts the project
 * layer from those rules anyway; the budget rule is what this pins).
 */
import type { ProjectBrief } from './project-brief.model';

const fill = (label: string, n: number, ch = 'x'): string => `${label} ${ch.repeat(n)}`;

export function maximalProjectBrief(name: string, id: string): ProjectBrief {
  return {
    name,
    id,
    mission: fill('Mission', 700),
    instructions: Array.from({ length: 8 }, (_, i) => fill(`Instruction ${i + 1}:`, 180, 'y')).join('\n'),
    goals: Array.from({ length: 14 }, (_, i) => ({
      id: `goal-${String(i).padStart(4, '0')}-aaaa-bbbb-cccc`,
      title: fill(`Goal ${i + 1}`, 260, 'g'),
      status: i % 3 === 0 ? 'blocked' : 'active',
      ...(i % 3 === 0 ? { blockedReason: fill('Blocked because', 150, 'b') } : {}),
    })),
    kpis: Array.from({ length: 10 }, (_, i) => ({ title: fill(`KPI ${i + 1}`, 260, 'k'), target: fill('target', 70, 't'), unit: 'ms', receipt: fill('receipt', 140, 'r') })),
    premises: Array.from({ length: 24 }, (_, i) => ({ key: `premise_${i + 1}_${'p'.repeat(90)}`, value: (i + 1) * 1.5, unit: 'f1', source: `https://example.test/premises/${i + 1}/${'s'.repeat(120)}` })),
    repos: Array.from({ length: 8 }, (_, i) => ({ url: `https://example.test/org/repo-${i + 1}/${'z'.repeat(220)}`, provider: 'github', defaultBranch: 'main', githubLabel: 'work' })),
    environments: Array.from({ length: 10 }, (_, i) => ({ name: fill(`env-${i + 1}`, 130, 'e'), kind: fill('kind', 50, 'n'), access: fill('access', 130, 'a') })),
    budget: { policy: 'envelope', envelope: 'e'.repeat(90), note: 'n'.repeat(170) },
    codingModel: fill('the workspace default seat', 90, 'c'),
    standingDecisions: Array.from({ length: 12 }, (_, i) => ({
      at: `2026-09-${String(10 + i).padStart(2, '0')}T10:00:00Z`,
      text: fill(`Decision ${i + 1}:`, 260, 'd'),
      evidence: `oq_${String(i).padStart(8, '0')}-${'v'.repeat(80)}`,
    })),
    fleetRules: Array.from({ length: 8 }, (_, i) => ({
      at: `2026-09-${String(10 + i).padStart(2, '0')}T11:00:00Z`,
      text: fill(`Fleet rule ${i + 1}:`, 260, 'q'),
      evidence: `directive ${String(i).padStart(8, '0')}`,
    })),
    supervisorRulings: Array.from({ length: 8 }, (_, i) => ({
      at: `2026-09-${String(10 + i).padStart(2, '0')}T12:00:00Z`,
      text: fill(`Supervisor ruling ${i + 1}:`, 260, 'u'),
      evidence: `oq_${String(i).padStart(8, '1')}`,
    })),
    preferences: Array.from({ length: 10 }, (_, i) => fill(`Preference ${i + 1}:`, 260, 'f')),
    contextState: fill('State', 600, 'w'),
  };
}
