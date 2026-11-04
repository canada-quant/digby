/**
 * Admin → Feedback → Held tickets (audit 2026-10-08 W5-1a) — source-level pins
 * in the repo's idiom for effectful sections (SupervisorsSection.test.tsx): the
 * panel loads the held list, approving confirms first and calls the audited
 * approve endpoint, and the section is mounted as Admin → "Feedback".
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const readSrc = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const SECTION = readSrc('./HeldTicketsSection.tsx');
const ADMIN_TAB = readSrc('./AdminTab.tsx');
const API = readSrc('../../../lib/api/crossmodel.ts');

describe('HeldTicketsSection — Admin → Feedback (W5-1a)', () => {
  it('loads the held list and approves through the audited endpoint', () => {
    expect(SECTION).toContain('featureRequestApi.adminListHeld()');
    expect(SECTION).toContain('featureRequestApi.adminApproveDispatch(t.id, true)');
    expect(API).toContain("apiClient.get('/crossmodel/admin/feature-requests/held')");
    expect(API).toContain('apiClient.post(`/crossmodel/admin/feature-requests/${id}/approve-dispatch`, { approved })');
  });

  it('approving confirms first, with copy that says what a ticket lane does', () => {
    expect(SECTION).toContain('onClick={() => setConfirm(t)}');
    expect(SECTION).toContain('<AlertDialog open={confirm !== null}');
    expect(SECTION).toContain('APPROVE_FOR_LANE_COPY');
    expect(SECTION).toContain('merge it to main and deploy it');
    expect(SECTION).toContain('Approve for a ticket lane');
  });

  it('badges framework tickets and shape-only descriptions; empty state is explicit', () => {
    expect(SECTION).toContain('{t.harness && <Badge variant="outline">framework</Badge>}');
    expect(SECTION).toContain('{t.subjectContentWithheld && <Badge variant="outline">content withheld</Badge>}');
    expect(SECTION).toContain('data-testid="held-tickets-empty"');
  });

  it('is mounted as the Admin "Feedback" section', () => {
    expect(ADMIN_TAB).toContain("import { HeldTicketsSection } from './HeldTicketsSection';");
    expect(ADMIN_TAB).toContain("{ id: 'feedback', label: 'Feedback', icon: Inbox },");
    expect(ADMIN_TAB).toContain("{section === 'feedback' && <HeldTicketsSection />}");
  });
});
