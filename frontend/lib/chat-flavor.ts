/**
 * Chat flavor resolution (P0 2026-09-07: folder-tree coding sessions rendered
 * as PLAIN chats). THE ROUTING RULE (User Space §5): the SATELLITE decides the
 * flavor — hasWorkspaceState ⇒ coding, anything else ⇒ plain. The bug: rows
 * from the project-detail endpoint (the sidebar folder tree merges them into
 * `chats`) carried NO capability fields, and loadChat treated `undefined` as
 * falsy ⇒ coding sessions deterministically opened plain (patience picker,
 * plain tabs, "Attach a workspace") despite a live satellite.
 *
 * The rule now: flavor is NEVER decided from a row that LACKS the field —
 * `undefined` means "fetch the full chat first" (getChat returns
 * codeCapable/hasWorkspaceState), and only an explicit boolean answers
 * directly. Pure helpers so the decision table is executable under the
 * node-environment vitest (page.tsx's loadChat is a component closure).
 */

export type ChatFlavor = 'coding' | 'plain';

/**
 * Decide from the row alone. `unknown` = the row lacks the capability field —
 * the caller must fetch the full chat before choosing (never default to plain).
 */
export function chatFlavorFromRow(row: { hasWorkspaceState?: boolean | null }): ChatFlavor | 'unknown' {
  if (row.hasWorkspaceState === undefined || row.hasWorkspaceState === null) return 'unknown';
  return row.hasWorkspaceState ? 'coding' : 'plain';
}

/**
 * Last resort when the capability fetch FAILED: the retired mode='code'
 * legacy marker still identifies known coding chats — those force coding;
 * anything else falls back to plain (the caller warns — never silent).
 */
export function chatFlavorFetchFallback(row: { mode?: string | null }): ChatFlavor {
  return row.mode === 'code' ? 'coding' : 'plain';
}
