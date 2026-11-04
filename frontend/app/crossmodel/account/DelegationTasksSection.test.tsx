/**
 * Admin → Jobs → Delegation ledger (build 2026-10-08 D) — source-level pins in
 * the repo's idiom for effectful admin sections (HeldTicketsSection.test.tsx)
 * plus the pure readout line: the panel reads the admin endpoint only (it
 * never writes), is labelled shadow, filters by kind / state / stale, and is
 * mounted under Admin → Jobs.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { reconcileLine, DELEGATION_KINDS, DELEGATION_STATES } from '../../../lib/api/delegation-tasks';

const readSrc = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const SECTION = readSrc('./DelegationTasksSection.tsx');
const ADMIN_TAB = readSrc('./AdminTab.tsx');
const API = readSrc('../../../lib/api/delegation-tasks.ts');

describe('DelegationTasksSection — Admin → Jobs (build 2026-10-08 D)', () => {
  it('reads the admin endpoint and nothing else (read-only: no post / put / delete)', () => {
    expect(API).toContain("apiClient.get('/crossmodel/admin/delegation-tasks', { params })");
    expect(API).not.toMatch(/apiClient\.(post|put|patch|delete)/);
    expect(SECTION).toContain('delegationTasksApi.list(');
  });

  it('is labelled shadow and says nothing acts on it yet', () => {
    expect(SECTION).toContain('<Badge variant="outline">shadow</Badge>');
    expect(SECTION).toContain('Recorded only — nothing acts on it yet.');
  });

  it('filters by kind, state (incl. open) and stale; shows the journal line and an explicit empty state', () => {
    expect(SECTION).toContain('aria-label="Kind"');
    expect(SECTION).toContain('aria-label="State"');
    expect(SECTION).toContain("'open'");
    expect(SECTION).toContain('stale only');
    expect(SECTION).toContain('data-testid="tool-intent-line"');
    expect(SECTION).toContain('data-testid="delegation-ledger-empty"');
  });

  it('is mounted under the Admin "Jobs" section', () => {
    expect(ADMIN_TAB).toContain("import { DelegationTasksSection } from './DelegationTasksSection';");
    expect(ADMIN_TAB).toContain("{section === 'jobs' && <div className=\"mt-4\"><DelegationTasksSection /></div>}");
  });

  it('vocabulary mirrors the backend ledger', () => {
    expect([...DELEGATION_KINDS]).toEqual(['session', 'message_ask', 'ticket', 'background_worker', 'schedule_firing', 'continuation']);
    expect([...DELEGATION_STATES]).toEqual(['submitted', 'working', 'input_required', 'completed', 'failed', 'canceled']);
  });

  it('reconcile line: explicit before the first nightly run, the bar figures after', () => {
    expect(reconcileLine(null)).toBe('No nightly reconcile yet — it runs once a day.');
    expect(reconcileLine({ at: 'x', value: 99.2, meta: { agreementPct: 99.2, checked: 512, missingParent: 0, missingRows: 1, stale: 3 } }))
      .toBe('Agreement 99.2% over 512 tasks · missing parent 0 · missing rows 1 · stale 3');
  });
});
