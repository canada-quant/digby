/**
 * Ticket 0025b3bc — the plain-chat and supervisor-composer file pickers must
 * offer plain-text files with unknown extensions (.log/.out/.diff/.patch),
 * matching the backend's new text-sniffing gate.
 *
 * Before the fix, the accept= lists named only the extension-mapped types, so
 * a .log combat log never even reached the upload POST (and when it did, via
 * drag-and-drop, the backend rejected it with "Unsupported file type:
 * application/octet-stream"). The coding-session composer already accepts
 * .log — the plain-chat surfaces were the inconsistent ones.
 *
 * Source-pin idiom (coding-composer-doc-uploads.7b5ee09b): the composer
 * surfaces are large client components, so the contract is pinned against
 * the source text directly.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const PAGE = readFileSync(
  fileURLToPath(new URL('../page.tsx', import.meta.url)),
  'utf8',
);
const SUPERVISOR_TAB = readFileSync(
  fileURLToPath(new URL('../management/SupervisorChatTab.tsx', import.meta.url)),
  'utf8',
);
const CODE_SESSION_VIEW = readFileSync(
  fileURLToPath(new URL('./CodeSessionView.tsx', import.meta.url)),
  'utf8',
);

const PLAIN_TEXT_EXTS = ['.log', '.out', '.diff', '.patch'];

describe('0025b3bc — plain-chat composer accepts text-sniffable extensions', () => {
  it('page.tsx accept= lists .log/.out/.diff/.patch (the backend sniffs them as text/plain)', () => {
    const accept = PAGE.match(/accept="(image\/\*[^"]*)"/)?.[1] ?? '';
    for (const ext of PLAIN_TEXT_EXTS) expect(accept).toContain(ext);
  });

  it('the previously listed whitelist entries are all still present (no regression)', () => {
    const accept = PAGE.match(/accept="(image\/\*[^"]*)"/)?.[1] ?? '';
    for (const kept of [
      'image/*', '.pdf', '.docx', '.xlsx', '.xls', '.txt', '.csv', '.json', '.xml', '.md', '.markdown',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel', 'text/plain', 'text/csv', 'text/markdown', 'application/json', 'text/xml', 'application/xml',
    ]) {
      expect(accept).toContain(kept);
    }
  });
});

describe('0025b3bc — the supervisor composer (Management tab) is aligned', () => {
  it('SupervisorChatTab accept= lists .log/.out/.diff/.patch like the main composer', () => {
    const accept = SUPERVISOR_TAB.match(/accept="(image\/\*[^"]*)"/)?.[1] ?? '';
    for (const ext of PLAIN_TEXT_EXTS) expect(accept).toContain(ext);
  });

  it('the previously listed whitelist entries are all still present (no regression)', () => {
    const accept = SUPERVISOR_TAB.match(/accept="(image\/\*[^"]*)"/)?.[1] ?? '';
    for (const kept of ['.pdf', '.docx', '.xlsx', '.txt', '.csv', '.json', '.xml', '.md', '.markdown', 'text/plain', 'text/csv', 'text/markdown']) {
      expect(accept).toContain(kept);
    }
  });
});

describe('0025b3bc — the coding-session composer (already .log-capable) is not narrowed', () => {
  it('CodeSessionView accept= still lists .log and .pdf; the inline-text set still admits .diff/.patch', () => {
    const accept = CODE_SESSION_VIEW.match(/accept="([^"]*)"/)?.[1] ?? '';
    expect(accept).toContain('.log');
    expect(accept).toContain('.pdf');
    // The handleIncomingFiles text set (not the accept attribute) admits
    // .diff/.patch files that slip through the picker (drag-and-drop).
    const textExts = CODE_SESSION_VIEW.match(/CODE_ATTACH_TEXT_EXTS = new Set\(\[([^\]]*)\]\)/)?.[1] ?? '';
    expect(textExts).toContain("'diff'");
    expect(textExts).toContain("'patch'");
    expect(textExts).toContain("'log'");
  });
});
