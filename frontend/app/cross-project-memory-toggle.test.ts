/**
 * Source pin — the folder "Draw on my other folders" switch is LIVE, not inert.
 *
 * 2026-09-14: a crossmodel lane executed a stale P2 todo (e1a9c80f, #769) that
 * hid the crossProjectMemory toggle as "always-on since #227 — the stored value
 * gates nothing". That was true when the todo was filed; it stopped being true
 * the same day, when the memory unification made the stored value the gate for
 * the ownership-checked cross-project blend in BOTH chat RAG
 * (chat-context.ts `blendUserId`) and coding retrieval
 * (coding-retrieval.service.ts). Hiding the switch left users unable to
 * isolate a folder. #769 was reverted; this pin keeps the control wired to the
 * backend gate it controls (stable identifiers, never line numbers).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const PROJECT_PAGE = read('./crossmodel/projects/[id]/page.tsx');
const CHAT_CONTEXT = read('../../backend/src/modules/crossmodel/chat-agent/chat-context.ts');
const CODING_RETRIEVAL = read('../../backend/src/modules/crossmodel/coding/coding-retrieval.service.ts');

describe('folder cross-project memory toggle (revert of #769)', () => {
  it('the backend gates the cross-project blend on the stored crossProjectMemory value', () => {
    // If either gate disappears, the toggle really is inert — then hide it AND
    // delete this pin in the same commit; never one without the other.
    expect(CHAT_CONTEXT).toMatch(/const \{ crossProjectMemory \} = await getProjectSettings\(projectId\)/);
    expect(CHAT_CONTEXT).toMatch(/blendUserId = crossProjectMemory &&/);
    expect(CODING_RETRIEVAL).toMatch(/crossProjectMemory/);
  });

  it('the folder settings page renders the switch and round-trips the field', () => {
    expect(PROJECT_PAGE).toContain('Draw on my other folders');
    // load mapping (default-on: only an explicit false isolates)
    expect(PROJECT_PAGE).toContain('setEditCrossProjectMemory(data.crossProjectMemory !== false)');
    // save payload
    expect(PROJECT_PAGE).toContain('crossProjectMemory: editCrossProjectMemory');
    // the Switch is bound to the edit state
    expect(PROJECT_PAGE).toMatch(/checked=\{editCrossProjectMemory\}\s+onCheckedChange=\{setEditCrossProjectMemory\}/);
    // and the "inert control" rationale never comes back as a comment in place of the switch
    expect(PROJECT_PAGE).not.toMatch(/crossProjectMemory toggle hidden/);
  });
});
