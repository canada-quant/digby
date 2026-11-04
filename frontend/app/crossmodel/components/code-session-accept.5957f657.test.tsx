/**
 * Ticket 5957f657 — the coding-session composer's file picker must offer the
 * same plain-text extensions the backend's sniff gate now admits.
 *
 * PR #1983 (0025b3bc) aligned the plain-chat and supervisor composers
 * (page.tsx, SupervisorChatTab.tsx) — their accept= lists name
 * .log/.out/.diff/.patch — and added 'out' to CODE_ATTACH_TEXT_EXTS, but the
 * CodeSessionView accept= itself only listed .log: a user opening the picker
 * in a coding session could not even SEE .out/.diff/.patch files, even though
 * drag-and-drop admitted them (CODE_ATTACH_TEXT_EXTS has diff/patch/out) and
 * the backend (after this ticket) stages them as text.
 *
 * Source-pin idiom (upload-text-accept.0025b3bc / coding-composer-doc-uploads.
 * 7b5ee09b): the composer surfaces are large client components, so the
 * contract is pinned against the source text directly.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const CODE_SESSION_VIEW = readFileSync(
  fileURLToPath(new URL('./CodeSessionView.tsx', import.meta.url)),
  'utf8',
);

const PLAIN_TEXT_EXTS = ['.log', '.out', '.diff', '.patch'];

describe('5957f657 — the coding-session composer aligns with the backend sniff gate', () => {
  it('CodeSessionView accept= lists .log/.out/.diff/.patch like the plain-chat composer', () => {
    const accept = CODE_SESSION_VIEW.match(/accept="(image\/\*[^"]*)"/)?.[1] ?? '';
    for (const ext of PLAIN_TEXT_EXTS) expect(accept).toContain(ext);
  });

  it('the previously listed whitelist entries are all still present (no regression)', () => {
    const accept = CODE_SESSION_VIEW.match(/accept="(image\/\*[^"]*)"/)?.[1] ?? '';
    // .txt itself was never named — text/* covers it (pinned pre-change).
    for (const kept of [
      'image/*', 'audio/*', 'text/*', '.pdf', '.docx', '.xlsx', '.xls',
      '.csv', '.json', '.xml', '.md', '.markdown',
      '.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.go', '.rs',
      '.sh', '.sql', '.html', '.css', '.vue', '.svelte', 'application/pdf',
    ]) {
      expect(accept).toContain(kept);
    }
  });

  it("CODE_ATTACH_TEXT_EXTS still admits 'out'/'diff'/'patch' for drag-and-drop (0025b3bc added 'out')", () => {
    const textExts = CODE_SESSION_VIEW.match(/CODE_ATTACH_TEXT_EXTS = new Set\(\[([^\]]*)\]\)/)?.[1] ?? '';
    expect(textExts).toContain("'log'");
    expect(textExts).toContain("'out'");
    expect(textExts).toContain("'diff'");
    expect(textExts).toContain("'patch'");
  });
});
