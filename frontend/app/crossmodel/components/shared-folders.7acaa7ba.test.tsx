/**
 * Ticket 7acaa7ba — shared workspaces for project MEMBERS.
 *
 * The reported incident (breanne, member of ericfoundation.com / CQL Business
 * Ops): (1) "chats dont appear under project folders in sidebar" — the sidebar
 * folder tree was built ONLY from ownedProjects, so shared folders rendered as
 * flat "Shared with me" rows whose chats never nested; (2) that flat row
 * navigated to /projects/:id — a route that does NOT exist (the page is
 * /crossmodel/projects/[id]), which is why the reporter "had to click settings
 * then click into it"; (3) "when i type something as breanne it throws an
 * error" — the owner's coding session 404'd "Session not found" for a member
 * (owner-only startRun gate) and the sidebar settings gear navigated to the
 * dead route.
 *
 * This pin locks the frontend half: the route fix (8 push sites), the shared
 * folder tree merge, owner-only affordance gating, and the member read-only
 * composer. The backend half (honest 403s + getChatAccess ancestor
 * inheritance) is pinned in backend tests.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const PAGE = readFileSync(
  fileURLToPath(new URL('../page.tsx', import.meta.url)),
  'utf8',
);
const VIEW = readFileSync(
  fileURLToPath(new URL('./CodeSessionView.tsx', import.meta.url)),
  'utf8',
);
const FILES_PAGE = readFileSync(
  fileURLToPath(new URL('../files/page.tsx', import.meta.url)),
  'utf8',
);
const DASHBOARD = readFileSync(
  fileURLToPath(new URL('../management/DashboardTab.tsx', import.meta.url)),
  'utf8',
);

describe('7acaa7ba — every project navigation goes to the REAL route', () => {
  // 2026-10-14 (clean public URLs, "crossmodel was the old name"): /projects/:id
  // IS the real route now — proxy.ts rewrites it to app/crossmodel/projects/[id]
  // (pinned in proxy.test.ts) and a document load of the legacy
  // /crossmodel/projects/:id 308s to it. The dead-route class this pin guarded
  // is an UNREWRITTEN segment, so the pin now asserts the rewrite covers it.
  it('every project navigation uses the clean /projects/:id path the proxy rewrites', () => {
    const proxySrc = readFileSync(fileURLToPath(new URL('../../../proxy.ts', import.meta.url)), 'utf8');
    expect(proxySrc).toContain("'projects',");
    for (const [name, src] of [['page', PAGE], ['files', FILES_PAGE], ['dashboard', DASHBOARD]] as const) {
      expect(src, `${name} still pushes the legacy /crossmodel/projects path`).not.toMatch(/['`]\/crossmodel\/projects\//);
    }
  });

  it('the sidebar settings gear and shared-folder navigation use /projects/:id', () => {
    expect(PAGE).toContain("router.push(`/projects/${node.id}`)");
  });
});

describe('7acaa7ba — shared folders join the sidebar TREE', () => {
  it('the tree is built from owned + shared projects (treeProjects), not owned alone', () => {
    expect(PAGE).toContain('const treeProjects = useMemo(');
    expect(PAGE).toContain('...visibleProjects.map((p) => ({ ...p, isSharedFolder: false }))');
    expect(PAGE).toContain('...sharedProjects');
    expect(PAGE).toContain('.map((p) => ({ ...(p as Project), isSharedFolder: true }))');
    // The tree builder consumes the merged list…
    expect(PAGE).toMatch(/folderTree = useMemo<FolderNode\[\]>\(\(\) => \{\s*const ids = new Set\(treeProjects\.map/);
  });

  it('the retired flat "SHARED WITH ME" section no longer renders rows', () => {
    expect(PAGE).not.toContain('{sharedProjects.map((project) => (');
    expect(PAGE).toMatch(/SHARED WITH ME SECTION[\s\S]{0,200}retired/);
  });

  it('empty-state gates key off the merged tree, not owned-only', () => {
    expect(PAGE).toContain('treeProjects.length === 0 ? (');
    expect(PAGE).not.toContain('visibleProjects.length === 0 ? (');
  });

  it('shared folder rows are NOT drag/drop targets (moves are owner-only server-side)', () => {
    expect(PAGE).toContain('disabled={sharedFolderIds.has(node.id)}');
  });

  it('shared folder rows carry the shared badge with owner/role tooltip', () => {
    expect(PAGE).toContain('{node.isSharedFolder && (');
    expect(PAGE).toContain("title={`Shared by ${(node as any).ownerName ?? 'the project owner'}");
  });

  it('viewer members do not get the "New chat" affordance in a shared folder (createProjectChat 403s for viewers)', () => {
    expect(PAGE).toContain("(!node.isSharedFolder || (node as any).memberRole !== 'viewer')");
  });

  it('foreign chats: drag disabled and owner-only menu actions hidden (rename/share/archive/delete)', () => {
    expect(PAGE).toContain(
      "disabled={renamingChatId === chat.id || (!!user?.id && !!chat.userId && chat.userId !== user.id)}",
    );
    expect(PAGE).toContain('{(!user?.id || !chat.userId || chat.userId === user.id) && (');
  });

  it('the page passes viewerId to CodeSessionView (the member read-only signal)', () => {
    expect(PAGE).toContain('viewerId={user?.id ?? null}');
  });
});

describe('7acaa7ba — the member read-only composer (CodeSessionView)', () => {
  it('memberViewOnly is derived from viewerId vs the session owner', () => {
    expect(VIEW).toContain(
      'const memberViewOnly = !!viewerId && !!activeSession?.userId && viewerId !== activeSession.userId;',
    );
  });

  it('submit and canSubmit are gated for member view', () => {
    expect(VIEW).toContain('if (memberViewOnly) return; // 7acaa7ba: members watch; the owner runs');
    expect(VIEW).toContain('canSubmit={!memberViewOnly && (');
  });

  it('the footer note explains the read-only state in plain language', () => {
    expect(VIEW).toContain('Read-only — this coding session belongs to the project owner.');
  });

  it('the CodingSession type carries the owner userId the gate needs', () => {
    const CODING_API = readFileSync(
      fileURLToPath(new URL('../../../lib/api/coding.ts', import.meta.url)),
      'utf8',
    );
    expect(CODING_API).toContain('userId?: string;');
  });
});
