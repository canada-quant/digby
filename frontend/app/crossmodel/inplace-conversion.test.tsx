/**
 * User Space (P3) frontend pins — docs/USER_SPACE_DESIGN.md §4/§5/§6.
 *
 * THE ROUTING RULE (§4/§5): the SATELLITE (hasWorkspaceState) decides the view
 * and the flavor — codeCapable only means "attachable". Every auto-filed chat
 * is capable, so any mount keyed on codeCapable would 404 satellite-less chats.
 * §6.2 retires the "Code session" gesture (composer chip lineage, destination
 * picker, per-page conversion handler); §6.1 collapses the ⋯ menu into ONE
 * menu; §6.3 keeps ONE power gesture — "Attach a workspace" — on the open
 * plain chat. The panel-unification pins from this file's 2026-08-31
 * in-place-conversion incarnation are kept (still true).
 *
 * Same readSrc source-pin idiom as c3-legacy-retirement.test.tsx.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const readSrc = (rel: string) => readFileSync(join(__dirname, rel), 'utf8');

const PAGE = readSrc('./page.tsx');
const VIEW = readSrc('./components/CodeSessionView.tsx');
const CHROME = readSrc('./components/FloatingChrome.tsx');
const SETTINGS = readSrc('./components/SessionSettingsSection.tsx');
const API = readSrc('../../lib/api/crossmodel.ts');

/** Slice helper for region-anchored pins (fails loudly when an anchor drifts). */
function region(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  const b = src.indexOf(to);
  expect(a, `region anchor ${JSON.stringify(from)} missing`).toBeGreaterThanOrEqual(0);
  expect(b, `region anchor ${JSON.stringify(to)} missing`).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('User Space P3 [page.tsx] — THE ROUTING RULE: the satellite decides the view', () => {
  it('loadChat mounts the coding flavor off hasWorkspaceState, never codeCapable', () => {
    // P0 2026-09-07 (folder-tree flavor bug): the raw `if (chat.hasWorkspaceState)`
    // branch treated a row LACKING the field as plain — flavor now resolves via
    // chatFlavorFromRow (satellite flag when present; full-fetch when unknown —
    // decision table + fetch wiring pinned in folder-tree-flavor.test.ts). The
    // ROUTING RULE itself is unchanged: the satellite decides, never codeCapable.
    const lc = region(PAGE, 'const loadChat = useCallback', 'const handleOpenSearchResult');
    expect(lc).toContain('let flavor = chatFlavorFromRow(chat);');
    expect(lc).toContain("if (flavor === 'coding') {");
    // No BRANCH on codeCapable (the word may survive in the rule's comment and
    // in the row patch that stores the fetched capability).
    expect(lc).not.toContain('if (chat.codeCapable');
    expect(lc).not.toContain('if ((chat as any).codeCapable');
    // The flavor ternary keys on the fetched SATELLITE flag, not capability.
    expect(lc).toContain("flavor = full?.hasWorkspaceState ? 'coding' : 'plain';");
  });

  it('the three minimal-row builders carry hasWorkspaceState through to loadChat', () => {
    const builders = PAGE.match(/hasWorkspaceState: (\(full as any\)|full)\.hasWorkspaceState/g) || [];
    expect(builders.length).toBe(3);
  });

  it('the satellite-at-birth creation marks its optimistic row hasWorkspaceState', () => {
    const snip = region(PAGE, 'const startNewChatInProject', 'const handleMoveToProject');
    expect(snip).toContain("mode: 'code', projectId: project.id, hasWorkspaceState: true,");
  });

  it('the view remount key keeps the plain/coding flavor (same-chatId attach flips must remount)', () => {
    expect(PAGE).toContain('key={codeChatId ? `${codeChatId}:${codeChatPlain ? \'plain\' : \'coding\'}`');
  });

  it('the satellite-less 404 copy is honest (no workspace yet — not archived/deleted)', () => {
    expect(VIEW).toContain('doesn&apos;t have a workspace yet');
    expect(VIEW).not.toContain('may have been archived or deleted');
  });
});

describe('User Space P3 (§6.2) — the "Code session" gesture is retired', () => {
  it('page.tsx carries none of the chip/picker/conversion-gesture machinery', () => {
    for (const gone of [
      'handleCodeChip', 'onCodeSession', 'codeSessionDisabled', 'codeDestPicker',
      'launchCodeSession', 'startCodingChatFromComposer', 'resolveBlankCodingProject',
      'startNewCodingSession', 'onNewCodingSession', 'CODE_CHIP_TOAST_KEY',
    ]) {
      expect(PAGE, `${gone} must be gone from page.tsx`).not.toContain(gone);
    }
  });

  it('FloatingChrome sheds the code-session props (PatiencePicker itself was deleted — roster 2026-10-06 B-3)', () => {
    for (const gone of ['onCodeSession', 'codeSessionDisabled', 'onNewCodingSession', 'Code2']) {
      expect(CHROME, `${gone} must be gone from FloatingChrome.tsx`).not.toContain(gone);
    }
  });

  it('the frontend conversion handler is gone; the API primitive STAYS', () => {
    expect(PAGE).not.toContain('const convertChatToCoding');
    expect(API).toContain('convertToCoding: async (id: string, projectId?: string)');
    expect(API).toContain('apiClient.post(`/crossmodel/chats/${id}/coding`');
  });
});

describe('User Space P3 (§6.1) — ONE ⋯ menu, no per-flavor split', () => {
  it('FloatingChrome has no variant prop — one menu for every flavor', () => {
    expect(CHROME).not.toContain('variant');
    expect(PAGE).not.toContain('variant={');
  });

  // 2026-10-06 (owner: "all that should be in the sidebar or settings"): the
  // header carries no menus — the per-chat controls live ONLY in the side
  // panel's Settings tab (SessionSettingsSection).
  it('the kids note is plain-flavor-only via the showPatience prop (Settings tab)', () => {
    expect(PAGE).toContain('showPatience={!(codeChatId && !codeChatPlain)}');
    expect(CHROME).not.toContain('showPatience');
  });

  it('the workspace block renders only off the pushed-up CodingChrome (satellite present) — Settings tab only', () => {
    expect(SETTINGS).toContain('Push branch');
    expect(SETTINGS).toContain('Open pull request');
    expect(CHROME).not.toContain('Push branch');
    expect(CHROME).not.toContain('New coding session');
  });
});

describe('User Space P3 (§6.3) — "Attach a workspace", the ONE power gesture', () => {
  it('the Settings tab renders the item from the onAttachWorkspace prop (the header no longer duplicates it)', () => {
    expect(SETTINGS).toContain('onAttachWorkspace');
    expect(SETTINGS).toContain('Attach a workspace');
    expect(CHROME).not.toContain('Attach a workspace');
  });

  it('the page gates the gesture: logged-in adult, plain-flavor chat open, not streaming', () => {
    const gate = region(PAGE, 'onAttachWorkspace={', 'showWorkspaceToggle={');
    expect(gate).toContain('user && !isKid && codeChatId && codeChatPlain');
    expect(gate).toContain('!effectiveGeneratingIds.has(codeChatId)');
    expect(gate).toContain('? attachWorkspace');
  });

  it('the slim handler calls the bare endpoint, patches the row, and flips the flavor', () => {
    const handler = region(PAGE, 'const attachWorkspace = useCallback', 'const handleSendMessageInner');
    expect(handler).toContain('await crossModelApi.convertToCoding(chatId)');
    expect(handler).not.toContain('projectId'); // no destination, ever — the chat is already filed
    expect(handler).toContain('{ ...c, hasWorkspaceState: true, codeCapable: true }');
    expect(handler).toContain('setCodeChatPlain(false);');
    expect(handler).toContain("toast.success('Workspace attached — this chat now runs in its workspace')");
    expect(handler).toContain("toast.error(err?.response?.data?.error || 'Could not attach a workspace')");
  });
});

describe('User Space P3 (§5) — the hidden user-space project renders as ungrouped', () => {
  it('the Project DTO carries the isUserSpace marker', () => {
    expect(API).toContain('isUserSpace?: boolean;');
  });

  it('visibleProjects (folder tree + pickers) excludes the user space; userSpaceId derives from ownedProjects', () => {
    expect(PAGE).toContain('ownedProjects.find((p) => p.isUserSpace)?.id');
    // Archive (owner 2026-09-08): archived folders leave the tree alongside the
    // user space + fleet-hidden exclusions. Framework surface (9471d338): the
    // platform's own project joins the exclusion chain (marker-stamped).
    expect(PAGE).toContain('!p.isUserSpace && !p.archivedAt && !p.isFrameworkProject && !fleetHidden.projectIds.has(p.id)');
  });

  it('the ungrouped filter treats the user-space id as ungrouped', () => {
    expect(PAGE).toContain('const ungroupedChats = visibleChats.filter(c => !c.projectId || c.projectId === userSpaceId);');
  });

  it('sidebar chat rows badge a workspace-backed chat (GitBranch beside the schedule icon)', () => {
    // Both row renderers (folder + ungrouped sections) carry the badge.
    const badges = PAGE.match(/chat\.hasWorkspaceState && \(/g) || [];
    expect(badges.length).toBe(2);
    expect(PAGE).toContain('title="Has a workspace"');
  });
});

describe('panel unification (2026-08-31) — kept from the in-place-conversion pins', () => {
  it('CodeSessionView takes the page-owned panel state as CONTROLLED top-level props', () => {
    expect(VIEW).toContain('panelOpen: panelOpenProp, onPanelOpenChange,');
    expect(VIEW).toContain('const panelOpen = panelOpenProp ?? internalPanelOpen;');
    expect(VIEW).toContain('<WorkspacePanel onClose={closePanel}');
  });

  it('plain sessions no longer carry a separate panel state in PlainSessionProps', () => {
    expect(VIEW).not.toContain('plain.panelOpen');
    expect(VIEW).not.toContain('plain.onPanelOpenChange');
  });

  it('the header PanelRight button is the one side-panel toggle; CodingChrome shed the toggle', () => {
    expect(CHROME).toContain('side panel');
    expect(CHROME).not.toContain('Overview panel');
    expect(CHROME).not.toContain('togglePanel');
  });

  it('the page passes its one panelOpen state to the mounted view for every kind', () => {
    expect(PAGE).toContain('panelOpen={panelOpen}');
    expect(PAGE).toContain('onPanelOpenChange={setPanelOpen}');
  });
});
