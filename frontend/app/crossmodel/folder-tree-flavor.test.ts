/**
 * P0 2026-09-07 — folder-tree coding sessions rendered as PLAIN chats.
 *
 * Prod repro: a coding session opened from the sidebar FOLDER TREE showed the
 * patience picker, plain panel tabs, and "Attach a workspace" despite a live
 * satellite (dashboard sessions table: Ready + branch), surviving reload.
 * Root cause: loadChat branched the CodeSessionView flavor on
 * `chat.hasWorkspaceState` from the ROW it was handed — rows merged from the
 * project-detail endpoint carried NO capability fields (only
 * crossmodel.service listChats floored them), so `undefined` read as falsy ⇒
 * plain, deterministically.
 *
 * Belt AND suspenders, both pinned here:
 *   - frontend: flavor is NEVER decided from a row lacking the field —
 *     `unknown` full-fetches the chat first (lib/chat-flavor.ts, executable
 *     below; loadChat wiring pinned at source level, the c1-smoke idiom);
 *   - backend: the project-detail endpoint now populates
 *     hasWorkspaceState/codeCapable the same BATCHED way listChats does
 *     (one satellite query + one folder-inheritance lookup — no N+1).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { chatFlavorFromRow, chatFlavorFetchFallback } from '@/lib/chat-flavor';

const readSrc = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const PAGE = readSrc('./page.tsx');
const PROJECTS_CONTROLLER = readSrc('../../../backend/src/modules/crossmodel/projects.controller.ts');

/** Slice helper (the c1-smoke region idiom — anchors, never line numbers). */
function region(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  const b = src.indexOf(to);
  expect(a, `region anchor ${JSON.stringify(from)} missing`).toBeGreaterThanOrEqual(0);
  expect(b, `region anchor ${JSON.stringify(to)} missing`).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('chatFlavorFromRow — the decision table (THE ROUTING RULE, capability-honest)', () => {
  it('explicit true → coding; explicit false → plain (no fetch needed — the row answered)', () => {
    expect(chatFlavorFromRow({ hasWorkspaceState: true })).toBe('coding');
    expect(chatFlavorFromRow({ hasWorkspaceState: false })).toBe('plain');
  });

  it("a row LACKING the field is 'unknown' — never silently plain (the folder-tree bug)", () => {
    expect(chatFlavorFromRow({})).toBe('unknown');
    expect(chatFlavorFromRow({ hasWorkspaceState: undefined })).toBe('unknown');
    expect(chatFlavorFromRow({ hasWorkspaceState: null })).toBe('unknown');
  });

  it("fetch-failure fallback: the legacy mode='code' marker forces coding; anything else → plain", () => {
    expect(chatFlavorFetchFallback({ mode: 'code' })).toBe('coding');
    expect(chatFlavorFetchFallback({ mode: 'thinking' })).toBe('plain');
    expect(chatFlavorFetchFallback({})).toBe('plain');
    expect(chatFlavorFetchFallback({ mode: null })).toBe('plain');
  });
});

describe('loadChat wiring (source pins — loadChat is a component closure)', () => {
  // The whole flavor decision, from the helper call to the coding branch.
  const flavorBlock = () => region(PAGE, 'let flavor = chatFlavorFromRow(chat);', "if (flavor === 'coding') {");

  it('routes the row through chatFlavorFromRow and full-fetches ONLY the unknown case', () => {
    expect(PAGE).toContain("import { chatFlavorFromRow, chatFlavorFetchFallback } from '@/lib/chat-flavor';");
    const block = flavorBlock();
    // The fetch lives INSIDE the unknown branch — an explicit boolean row
    // (sidebar listChats rows) decides directly, no extra request.
    expect(block).toContain("if (flavor === 'unknown') {");
    const unknownBranch = region(block, "if (flavor === 'unknown') {", "if (currentChatIdRef.current !== chat.id) return;");
    expect(unknownBranch).toContain('await crossModelApi.getChat(chat.id');
    // The FETCHED satellite flag decides the flavor…
    expect(unknownBranch).toContain("flavor = full?.hasWorkspaceState ? 'coding' : 'plain';");
    // …and the row is patched so the next open skips the fetch.
    expect(unknownBranch).toContain('hasWorkspaceState: !!full?.hasWorkspaceState');
  });

  it('a failed capability fetch warns and falls back via chatFlavorFetchFallback (never silent)', () => {
    const block = flavorBlock();
    expect(block).toContain('flavor = chatFlavorFetchFallback(chat);');
    expect(block).toContain('console.warn(`[loadChat] capability fetch failed for ${chat.id}');
  });

  it('the coding mount keys on the RESOLVED flavor, not the raw row field', () => {
    expect(PAGE).toContain("if (flavor === 'coding') {");
    expect(PAGE).not.toContain('if (chat.hasWorkspaceState) {');
  });
});

describe('project-detail endpoint populates capability (backend source pin — no N+1)', () => {
  it('getProject floors hasWorkspaceState/codeCapable on every chat row, batched', () => {
    // Anchor with the paren — getProjectBreadcrumbs sits above getProject.
    const block = region(PROJECTS_CONTROLLER, 'export async function getProject(', '// ── Update project');
    // MERGE-1 slice 1 (2026-11-03): the endpoint no longer restates the
    // capability predicate inline — it calls the canonical batched reader, so
    // the folder tree cannot drift from the sidebar / fleet view (they DID
    // drift: fleet's supervisor view had no folder-chain leg).
    expect(block).toContain('getChatCapabilities(');
    // Both capability fields still land on the rows the folder tree merges.
    expect(block).toContain('hasWorkspaceState: cap?.hasWorkspaceState ?? false');
    expect(block).toContain('codeCapable: cap?.codeCapable ?? false');
    // …and the inline duplicate of the rule must never come back.
    expect(block).not.toContain('satelliteIds.has(chat.id)');
    expect(block).not.toContain('getNearestWorkspaceFolder(');
  });
});
