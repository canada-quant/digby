/**
 * Auto-archive idle chats settings control pins (ticket bb86cee8, 2026-09-14):
 * the per-project `autoArchiveIdleDays` select on the projects/[id] Settings
 * tab. Off maps to null (feature off); 7/14/30/90 map to the day windows the
 * hourly backend idle-chat archiver honours (integer 1..365).
 *
 * SOURCE-LEVEL pins (the project-supervisor-toggle idiom, see
 * management/project-supervisor-toggle.test.ts): the project page is a
 * ~1000-line client component infeasible to render in the node-environment
 * vitest setup, so pins anchor on stable identifiers, never line numbers.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const PROJECT_PAGE = readFileSync(fileURLToPath(new URL('./[id]/page.tsx', import.meta.url)), 'utf8');

describe('Auto-archive idle chats control [bb86cee8] — projects/[id] Settings tab', () => {
  it('binds autoArchiveIdleDays and saves it via projectsApi.update (the sibling-toggle path)', () => {
    expect(PROJECT_PAGE).toContain('autoArchiveIdleDays');
    expect(PROJECT_PAGE).toContain('await projectsApi.update(projectId, { autoArchiveIdleDays: days });');
  });

  it('the load path syncs the select from the fetched project (null/absent = off)', () => {
    expect(PROJECT_PAGE).toContain('setAutoArchiveDays(data.autoArchiveIdleDays ?? null);');
  });

  it('value mapping: Off ↔ null, and the 7/14/30/90-day windows', () => {
    // Select value: null renders as the 'off' option.
    expect(PROJECT_PAGE).toContain("value={autoArchiveDays === null ? 'off' : String(autoArchiveDays)}");
    // onValueChange: 'off' parses back to null, everything else to its number.
    expect(PROJECT_PAGE).toContain("updateAutoArchiveDays(v === 'off' ? null : Number(v))");
    // The four preset windows.
    expect(PROJECT_PAGE).toContain('<SelectItem value="off">Off</SelectItem>');
    expect(PROJECT_PAGE).toContain('<SelectItem value="7">7 days</SelectItem>');
    expect(PROJECT_PAGE).toContain('<SelectItem value="14">14 days</SelectItem>');
    expect(PROJECT_PAGE).toContain('<SelectItem value="30">30 days</SelectItem>');
    expect(PROJECT_PAGE).toContain('<SelectItem value="90">90 days</SelectItem>');
  });

  it('labels the control and explains skips + reversibility (the help text)', () => {
    expect(PROJECT_PAGE).toContain('Auto-archive idle chats');
    expect(PROJECT_PAGE).toContain('checked hourly');
    expect(PROJECT_PAGE).toContain('schedules, running coding sessions, or active share links');
    expect(PROJECT_PAGE).toContain('Archived view');
  });

  it('is optimistic with a revert on failure (the supervisor-toggle pattern)', () => {
    expect(PROJECT_PAGE).toContain('setAutoArchiveDays(previous);');
    expect(PROJECT_PAGE).toContain("toast.error('Could not update auto-archive.');");
  });
});
