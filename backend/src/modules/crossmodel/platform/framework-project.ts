/**
 * The Digby Framework project — the platform's OWN project surface (ticket
 * 9471d338, owner 2026-10-27: "i want to remove the actual framework and
 * digby/cross model project out of the sidebar and only into the management
 * as a tab properly scaffolded so digby is scaffolded and hardened and not
 * just another project").
 *
 * IDENTITY — no schema column, no migration. A project is the framework
 * surface when EITHER leg holds:
 *   - its workspace repoUrl canonicalizes (instance-targets
 *     .normalizeGithubRepoTarget) to the instance's OWN repo slug (on
 *     production: canada-quant/digby — the same resolution every
 *     self-improvement surface already uses, code-search.ts convention); OR
 *   - the row carries an explicitly-true `isFramework` flag (the future
 *     migration column — a repoUrl rename can never forge or lose it; a
 *     NAME never identifies the surface: names are user-editable).
 *
 * Non-prod instances (selfhost/edge) resolve their OWN repo slug: a row whose
 * repoUrl names THAT instance's repo is ALSO the framework row there — the
 * production repo slug is NEVER a fallback on non-prod (isolation boundary,
 * ticket c75b5f34). An instance with no own repo configured has NO repoUrl
 * identity at all (only the explicit flag can match).
 *
 * Pure leaf ON PURPOSE (the instance-targets doctrine, ticket 6665fff6):
 * validators, services and jest suites import this module, so it never drags
 * the env-validating chain (prisma → logger → config/env) behind it. Every
 * caller either injects its own repo slug (instanceOwnRepoSlugSoft) or an env
 * to resolve it from; nothing here reads the DB, throws platform errors or
 * logs. The kill switch (FRAMEWORK_PROJECT_SURFACE_DISABLED=1) is read at
 * CALL time from process.env so an operator can flip it per-box without a
 * rebuild; =1 restores the pre-2026-10-27 surface byte-for-byte (the project
 * renders in the sidebar like any user folder, its chats are not
 * sidebar-hidden, every guard below stands down).
 */

import {
  normalizeGithubRepoTarget,
  PROD_REPO,
  resolveInstanceRepoTarget,
} from './instance-targets';

/** The platform's own repo on production (instance-targets owns the value). */
export const FRAMEWORK_GITHUB_REPO_SLUG = PROD_REPO;

/**
 * Load-time snapshot of the kill switch — `true` when the box booted with
 * FRAMEWORK_PROJECT_SURFACE_DISABLED=1. Identity functions re-read
 * process.env at CALL time (the effective check); this const is the
 * boot-time answer for callers that want to log/render the posture.
 */
export const FRAMEWORK_PROJECT_SURFACE_DISABLED =
  process.env.FRAMEWORK_PROJECT_SURFACE_DISABLED === '1';

/** =1 restores the pre-2026-10-27 surface (call-time read — see module doc). */
export function frameworkProjectSurfaceDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FRAMEWORK_PROJECT_SURFACE_DISABLED === '1';
}

/**
 * The instance's own repo slug as a soft string — '' when it cannot resolve
 * (a non-prod instance with no SELF_REPO configured): with no own repo there
 * is NO framework identity by repoUrl, so repoUrl-based guards are inert and
 * no project is hidden. Never throws — the guards this feeds are surface
 * hardening, not a security boundary; an unresolvable instance degrades to
 * yesterday's UI.
 */
export function instanceOwnRepoSlugSoft(env: NodeJS.ProcessEnv = process.env): string {
  try {
    const r = resolveInstanceRepoTarget(env, 'SELF_REPO');
    return r.ok ? r.slug : '';
  } catch {
    return '';
  }
}

/**
 * Callers pass EITHER the already-resolved own-repo slug (services that
 * resolved it once for a whole list pass — `instanceOwnRepoSlugSoft()`) OR an
 * env object to resolve it from (tests, leaf-only callers). `undefined`
 * resolves from process.env.
 */
export type OwnRepoSource = string | NodeJS.ProcessEnv | undefined;

function resolveOwnSlug(source: OwnRepoSource): string {
  if (typeof source === 'string') return source.trim();
  return instanceOwnRepoSlugSoft(source ?? process.env);
}

/** A project row the identity check reads — repoUrl + isFramework matter. */
export interface FrameworkProjectRow {
  repoUrl?: string | null;
  isFramework?: boolean | null;
}

function killedBySwitch(): boolean {
  return process.env.FRAMEWORK_PROJECT_SURFACE_DISABLED === '1';
}

/**
 * Is this row the platform's own framework surface? Both legs checked; the
 * kill switch (read at call time) forces false. A null/undefined row and a
 * row with neither leg are user projects.
 */
export function isFrameworkProjectRow(
  row: FrameworkProjectRow | null | undefined,
  ownRepoSource: OwnRepoSource = process.env,
): boolean {
  if (killedBySwitch()) return false;
  if (!row) return false;
  if (row.isFramework === true) return true; // only an EXPLICIT true is a stamp
  const ownSlug = resolveOwnSlug(ownRepoSource);
  if (!ownSlug) return false;
  const normalized = normalizeGithubRepoTarget(String(row.repoUrl ?? ''));
  return !!normalized && normalized === ownSlug;
}

/**
 * The readable alias for the common call-site question "is THIS project the
 * framework?" — same semantics as isFrameworkProjectRow.
 */
export function isFrameworkProject(
  row: FrameworkProjectRow | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isFrameworkProjectRow(row, env);
}

/**
 * Seam-level identity for a ref that carries repoUrl (the projects
 * controller loads bare rows). A bare string is NEVER identity — callers
 * must pass the loaded row (the runtime pin keeps a JS caller from spoofing
 * with the slug text alone).
 */
export function isFrameworkProjectRef(
  ref: FrameworkProjectRow | string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!ref || typeof ref === 'string') return false;
  return isFrameworkProjectRow(ref, env);
}

/**
 * Identity for the getProjectAccess shape ({ project, role } | null) —
 * the shape every platform.service mutation seam already holds.
 */
export function resolveFrameworkProjectRef(
  access: { project: FrameworkProjectRow | null | undefined } | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isFrameworkProjectRow(access?.project ?? null, env);
}

/**
 * The chat leg: system chats (Fleet/Project supervisor flags — ungrouped
 * platform lanes) are framework surface wherever they live, and any chat
 * FILED in the framework project is framework surface too. With the kill
 * switch on this reads false (the surface is disabled wholesale).
 */
export function isFrameworkChatRow(
  chat: { isSupervisor?: boolean | null; isProjectSupervisor?: boolean | null; projectId?: string | null } | null | undefined,
  frameworkProjectId?: string | null,
): boolean {
  if (killedBySwitch()) return false;
  if (!chat) return false;
  if (chat.isSupervisor === true || chat.isProjectSupervisor === true) return true;
  return !!frameworkProjectId && chat.projectId === frameworkProjectId;
}

/**
 * The mutation classes the framework surface refuses. rename/move/delete/
 * archive/share/member/repoint harden the project row itself; move-into /
 * move-out harden its chat (and sub-project) membership — system lanes filed
 * there never move out, user chats and projects never file in.
 */
export type FrameworkGuardAction =
  | 'delete'
  | 'archive'
  | 'rename'
  | 'move'
  | 'share'
  | 'member'
  | 'repoint'
  | 'move-into'
  | 'move-out';

const FRAMEWORK_HOME = 'Manager → Framework';

const PROJECT_VERB: Record<Exclude<FrameworkGuardAction, 'move-into' | 'move-out'>, string> = {
  delete: 'deleted',
  archive: 'archived or restored',
  rename: 'renamed or re-described',
  move: 'moved in the folder tree',
  share: 'shared with a public link',
  member: 'given members',
  repoint: 're-pointed at another repository',
};

/**
 * The human refusal message for a guard action on the framework surface —
 * names the Management home so the surface stays discoverable after it
 * leaves the sidebar.
 */
export function frameworkProjectRefusal(action: FrameworkGuardAction): string {
  if (action === 'move-into') {
    return `Chats and sub-projects cannot be filed under the Digby Framework project — it is the platform surface, not a folder (manage it from ${FRAMEWORK_HOME}).`;
  }
  if (action === 'move-out') {
    return `Framework lanes cannot be moved out of the Digby Framework project — they are platform-managed (reach them from ${FRAMEWORK_HOME}).`;
  }
  return `The Digby Framework project is a platform surface and cannot be ${PROJECT_VERB[action]} like a user project (manage it from ${FRAMEWORK_HOME}).`;
}

/**
 * The same refusal with a stable machine-greppable suffix — the string
 * callers throw (AppError) or render on the tool/REST seams, so a refusal in
 * a log is attributable to THIS guard, not a generic 403.
 */
export function frameworkGuardMessage(action: FrameworkGuardAction): string {
  return `${frameworkProjectRefusal(action)} [refused: framework surface]`;
}
