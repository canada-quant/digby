/**
 * Sessions view pins (session titles + topology, 2026-09-27) — SOURCE-LEVEL,
 * anchored on stable identifiers (the phase0-ui-pins idiom):
 *
 * 1. The project page carries a 'sessions' tab that reads
 *    projectsApi.sessions(projectId, { archived }) and renders one row per
 *    lane with the goal half bold + step half muted, the status pill, the
 *    last-receipt age and today's spend; archived rows hidden unless toggled.
 * 2. The sidebar chat row renders the title through splitSessionTitle
 *    (goal bold, step muted) instead of the raw string.
 * 3. The API client exposes projectsApi.sessions against
 *    /crossmodel/projects/:id/sessions with the ProjectSessionRow shape.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('Sessions tab on the project page', () => {
  const src = read('./crossmodel/projects/[id]/page.tsx');
  it("adds the 'sessions' tab and loads rows through projectsApi.sessions on first open (+ the archived toggle)", () => {
    expect(src).toMatch(/type Tab = 'chats' \| 'sessions' \| 'files'/);
    expect(src).toContain("{ id: 'sessions' as const, label: sessions ? `Sessions (${sessions.length})` : 'Sessions' }");
    expect(src).toContain('projectsApi.sessions(projectId, { archived })');
    expect(src).toContain("if (activeTab !== 'sessions' || sessions !== null) return;");
    expect(src).toContain('aria-label="Show archived sessions"');
  });
  it('renders goal bold + step muted, the status pill, last receipt age and spend per row; empty + loading states exist', () => {
    expect(src).toContain('data-sessions-view');
    expect(src).toContain('data-session-row={s.status}');
    expect(src).toContain('<span className="font-medium">{s.goalHalf}</span>');
    expect(src).toContain('{s.stepHalf && <span className="text-muted-foreground"> · {s.stepHalf}</span>}');
    expect(src).toContain('last receipt ${receiptAgeLabel(s.lastReceiptAgeSec)}');
    expect(src).toContain('${s.spendTodayUsd.toFixed(2)} today');
    expect(src).toContain('No sessions yet');
  });
});

describe('sidebar title halves', () => {
  it('the chat row splits the title (goal bold, step muted) via the shared helper', () => {
    const src = read('./crossmodel/page.tsx');
    expect(src).toContain("import { splitSessionTitle } from '@/lib/session-title';");
    expect(src).toContain('data-session-title');
    expect(src).toMatch(/const h = splitSessionTitle\(chat\.title\); return h\.step \? <><span className="font-medium">\{h\.goal\}<\/span><span className="text-ink-3"> · \{h\.step\}<\/span><\/> : chat\.title;/);
  });
});

describe('API client', () => {
  it('projectsApi.sessions hits /crossmodel/projects/:id/sessions and types the row', () => {
    const src = read('../lib/api/crossmodel.ts');
    expect(src).toContain('export interface ProjectSessionRow {');
    expect(src).toContain("status: 'running' | 'scheduled' | 'idle' | 'archived';");
    expect(src).toContain('apiClient.get(`/crossmodel/projects/${id}/sessions`, { params: opts.archived ? { archived: \'1\' } : {} })');
  });
});
