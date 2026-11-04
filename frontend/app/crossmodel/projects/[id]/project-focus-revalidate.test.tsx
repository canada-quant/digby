/**
 * Project-page focus revalidation pins — owner 2026-10-27 stale-list sweep
 * (finding C): the project page loaded ONCE and its only poll was
 * doc-processing-gated, so a project renamed/archived/deleted in another tab
 * (or by the hourly auto-archiver) kept rendering stale state until a manual
 * reload; the Sessions tab never refetched after its first load, so lanes
 * deleted/archived elsewhere kept their rows.
 *
 * Pins the focus-reconcile effect added for both. Same source-level idiom as
 * deleted-chat-stale-view.test.tsx (no jsdom). VERIFICATION-ONLY.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const readSrc = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const SRC = readSrc('./page.tsx');

describe('Project page focus revalidation (owner 2026-10-27, finding C)', () => {
  it('reconciles the project detail on window focus WITHOUT re-seeding the editor fields (finding 5)', () => {
    const i = SRC.indexOf("'focus', onFocus");
    expect(i).toBeGreaterThanOrEqual(0);
    const effect = SRC.slice(Math.max(0, SRC.lastIndexOf('useEffect(() => {', i)), SRC.indexOf('}, [', i) + 700);
    expect(effect).toContain('projectsApi.get(projectId)');
    expect(effect).toContain('setProject(data)');
    expect(effect).toContain("err?.response?.status === 404");
    expect(effect).toContain("router.push('/')");
    // The editor seeders are deliberately absent — a focus mid-edit must
    // never clobber unsaved text (only loadProject seeds them).
    expect(effect).not.toContain('setEditName');
    expect(effect).not.toContain('setEditDescription');
  });

  it('refreshes the open Sessions tab roster on focus with a stale-response generation guard (finding 6)', () => {
    const i = SRC.indexOf("'focus', onFocus");
    const effect = SRC.slice(Math.max(0, SRC.lastIndexOf('useEffect(() => {', i)), SRC.indexOf('}, [', i) + 700);
    expect(effect).toContain("if (activeTab === 'sessions') {");
    expect(effect).toContain('projectsApi.sessions(projectId, { archived: sessionsArchived })');
    // A stale roster answer can never overwrite a newer one.
    expect(effect).toContain('let gen = 0;');
    expect(effect).toContain('if (myGen === gen)');
  });

  it('subscribes to BOTH focus and visibilitychange (the app convention) and unsubscribes on unmount', () => {
    const i = SRC.indexOf("'focus', onFocus");
    const effect = SRC.slice(Math.max(0, SRC.lastIndexOf('useEffect(() => {', i)), SRC.indexOf('}, [', i) + 700);
    expect(effect).toContain("document.addEventListener('visibilitychange', onFocus)");
    expect(effect).toContain("window.removeEventListener('focus', onFocus)");
    expect(effect).toContain("document.removeEventListener('visibilitychange', onFocus)");
  });
});
