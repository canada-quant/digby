/**
 * Folder tree (P2 platform unification) — ancestor inheritance helpers.
 *
 * Hierarchy semantics (plan: "nearest-ancestor everywhere, writes always to
 * the leaf"):
 *   - systemPrompt: concatenated root→leaf (leaf last, highest precedence).
 *   - Memory: context-store reads for [folderId, 'context'|'settings'] merge
 *     the ancestor chain (nearest-wins on key conflicts, arrays concatenate
 *     root→leaf); WRITES STAY LEAF-ONLY (see memory.graph saveProjectContextState
 *     / setProjectSettings).
 *   - Members: effective role = max(own row, nearest ancestor row); the owner
 *     of ANY ancestor has full access (see platform.service getProjectAccess).
 *   - Docs/RAG: retrieval scopes to the folder + its ancestors.
 *   - Workspace: owned by one folder (its repo fields), resolvable from
 *     descendants (nearest ancestor with repoProvider).
 *
 * Feature flag: FOLDERS_INHERITANCE=off disables ALL inheritance (reads become
 * leaf-only, exactly the pre-P2 behavior). Default ON. Tree structure ops
 * (create/move/delete path maintenance) are NOT flag-gated — the materialized
 * path is always kept correct.
 *
 * The materialized `path` (`/rootId/.../id`) makes the ancestor chain one
 * batched query instead of N recursive lookups.
 */

import prisma from '../../../config/database';
import { storeGet } from '../memory/context-store';

/** Depth cap: depth = number of ancestors; roots are 0, deepest allowed is 5. */
export const MAX_FOLDER_DEPTH = 5;

/** Inheritance flag — default ON; `FOLDERS_INHERITANCE=off` disables. */
export function foldersInheritanceOn(): boolean {
  return process.env.FOLDERS_INHERITANCE !== 'off';
}

/** Folder row shape the tree/inheritance helpers operate on. */
export interface FolderChainRow {
  id: string;
  userId: string;
  name: string;
  emoji: string | null;
  color: string | null;
  parentId: string | null;
  depth: number;
  path: string;
  systemPrompt: string | null;
  repoUrl: string | null;
  repoProvider: string | null;
  defaultBranch: string;
  githubLabel: string | null;
}

const CHAIN_SELECT = {
  id: true, userId: true, name: true, emoji: true, color: true,
  parentId: true, depth: true, path: true, systemPrompt: true,
  repoUrl: true, repoProvider: true, defaultBranch: true, githubLabel: true,
} as const;

/** Ids encoded in a materialized path, root→leaf ('/a/b/c' → ['a','b','c']). */
export function pathIds(path: string): string[] {
  return path.split('/').filter(Boolean);
}

/**
 * Root→leaf chain of folder rows for folderId. One batched query over the
 * materialized path. Flag off, a missing/legacy/malformed path, or a missing
 * folder degrade to leaf-only (or [] when the folder does not exist).
 */
export async function getAncestorChain(folderId: string): Promise<FolderChainRow[]> {
  const leaf = await prisma.crossModelProject.findUnique({
    where: { id: folderId },
    select: CHAIN_SELECT,
  }) as FolderChainRow | null;
  if (!leaf) return [];
  if (!foldersInheritanceOn()) return [leaf];
  const ids = pathIds(leaf.path || '');
  if (ids.length <= 1 || ids[ids.length - 1] !== leaf.id) return [leaf];
  const rows = (await prisma.crossModelProject.findMany({
    where: { id: { in: ids } },
    select: CHAIN_SELECT,
  })) as FolderChainRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = ids.map((id) => byId.get(id)).filter((f): f is FolderChainRow => !!f);
  return ordered.length ? ordered : [leaf];
}

/** Root→leaf chain ids (includes folderId itself, last). */
export async function getAncestorChainIds(folderId: string): Promise<string[]> {
  return (await getAncestorChain(folderId)).map((f) => f.id);
}

/**
 * Effective system prompt for a folder: non-empty prompts concatenated
 * root→leaf with '\n\n' separators (leaf last = highest precedence). A chain
 * of length 1 (root folder, or flag off) returns the folder's own prompt
 * unchanged — zero behavior change for pre-P2 projects.
 */
export async function getEffectiveSystemPrompt(folderId: string): Promise<string | null> {
  const chain = await getAncestorChain(folderId);
  const parts = chain.map((f) => (f.systemPrompt || '').trim()).filter(Boolean);
  return parts.length ? parts.join('\n\n') : null;
}

/**
 * Workspace resolution: the NEAREST (leaf-most) folder in the chain that owns
 * a workspace (repoProvider set) — not auto-inherited downward, but resolvable
 * from descendants. Returns null when no folder in the chain has a workspace.
 */
export async function getNearestWorkspaceFolder(folderId: string): Promise<FolderChainRow | null> {
  const chain = await getAncestorChain(folderId);
  for (let i = chain.length - 1; i >= 0; i--) {
    if (chain[i].repoProvider) return chain[i];
  }
  return null;
}

/**
 * RAG scoping: the folder + its ancestors (root→leaf) when inheritance is on;
 * just the folder when off. Retrieval filters chunks by these projectIds.
 */
export async function getRagScopeFolderIds(folderId: string): Promise<string[]> {
  if (!foldersInheritanceOn()) return [folderId];
  const ids = await getAncestorChainIds(folderId);
  return ids.length ? ids : [folderId];
}

// ── Store-state merging (memory reads) ────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Merge two JSON values where `nearer` comes from a folder CLOSER to the leaf:
 * plain objects merge key-wise (nearer wins conflicts, recursing into nested
 * objects); arrays concatenate root→leaf (farther first); anything else the
 * nearer value wins outright.
 */
function mergeNearest(base: unknown, nearer: unknown): unknown {
  if (Array.isArray(base) || Array.isArray(nearer)) {
    return [...(Array.isArray(base) ? base : []), ...(Array.isArray(nearer) ? nearer : [])];
  }
  if (isPlainObject(base) && isPlainObject(nearer)) {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(nearer)) {
      out[k] = k in out ? mergeNearest(out[k], v) : v;
    }
    return out;
  }
  return nearer;
}

/**
 * Merge store states root→leaf (pass states ordered root first). Nulls are
 * skipped; all-null → null. Nearest-ancestor wins scalar key conflicts;
 * arrays concatenate root→leaf.
 */
export function mergeNearestWins<T>(states: Array<T | null>): T | null {
  let acc: unknown = null;
  for (const s of states) {
    if (s === null || s === undefined) continue;
    acc = acc === null ? s : mergeNearest(acc, s);
  }
  return acc as T | null;
}

/**
 * Merged read of a project's [folderId, kind] store namespace across the
 * ancestor chain (kind 'context' | 'settings'). READS ONLY — writes always go
 * to the leaf namespace (memory.graph setProjectSettings / saveProjectContextState).
 * Flag off → plain leaf read (pre-P2 behavior).
 */
export async function getMergedProjectStoreState<T>(
  folderId: string,
  kind: 'context' | 'settings',
): Promise<T | null> {
  if (!foldersInheritanceOn()) {
    return storeGet<T>([folderId, kind], 'state');
  }
  const ids = await getAncestorChainIds(folderId);
  const states = await Promise.all(
    ids.map((id) => storeGet<T>([id, kind], 'state').catch(() => null)),
  );
  return mergeNearestWins(states);
}
