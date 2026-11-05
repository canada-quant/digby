/**
 * Unit pin — ticket 9471d338, the framework-project identity leaf.
 *
 * framework-project.ts is the ONE identification + refusal-message leaf for
 * the Digby platform's own project (the "crossmodel" project holding the
 * platform repo). It is deliberately IMPORT-FREE apart from the pure
 * instance-targets leaf, so this suite runs against the REAL module with no
 * mocks: identity is pure string/date/env logic.
 *
 * Identity (two legs, BOTH checked — one alone is spoofable):
 *   - row.repoUrl canonicalizes (instance-targets.normalizeGithubRepoTarget)
 *     to the production repo slug example-org/crossmodel, OR
 *   - row.isFramework is an explicitly-set boolean flag (the future migration
 *     column; a name rename can never forge or lose it).
 *
 * Non-prod instances (selfhost/edge) resolve their OWN repo slug: a row whose
 * repoUrl names THAT instance's repo is ALSO the framework row there — the
 * production repo slug is NEVER a fallback on non-prod (isolation boundary,
 * ticket c75b5f34). FRAMEWORK_PROJECT_SURFACE_DISABLED kill-switches the whole
 * surface (identity reads false; every guard pass-through).
 */

import {
  FRAMEWORK_GITHUB_REPO_SLUG,
  FRAMEWORK_PROJECT_SURFACE_DISABLED,
  frameworkGuardMessage,
  frameworkProjectRefusal,
  isFrameworkChatRow,
  isFrameworkProject,
  isFrameworkProjectRef,
  isFrameworkProjectRow,
  type FrameworkProjectRow,
  resolveFrameworkProjectRef,
} from './framework-project';

const PROD_ENV = { DIGBY_INSTANCE: 'prod' } as NodeJS.ProcessEnv;
const SELFHOST_ENV = { DIGBY_INSTANCE: 'selfhost', SELF_REPO: 'me/my-digby-fork' } as NodeJS.ProcessEnv;

afterEach(() => {
  delete process.env.FRAMEWORK_PROJECT_SURFACE_DISABLED;
});

describe('identity constants', () => {
  it('the production repo slug is pinned (the platform repo)', () => {
    expect(FRAMEWORK_GITHUB_REPO_SLUG).toBe('example-org/crossmodel');
  });

  it('the kill switch defaults OFF (surface enabled)', () => {
    expect(FRAMEWORK_PROJECT_SURFACE_DISABLED).toBe(false);
  });
});

describe('isFrameworkProjectRow — row-level identity (prod env default)', () => {
  it('matches the production repo slug in ANY repoUrl spelling + case', () => {
    for (const repoUrl of [
      'https://github.com/example-org/crossmodel',
      'https://github.com/example-org/crossmodel.git',
      'git@github.com:example-org/crossmodel',
      'example-org/crossmodel',
      'https://github.com:443/example-org/crossmodel',
    ]) {
      expect(isFrameworkProjectRow({ repoUrl }, PROD_ENV)).toBe(true);
    }
  });

  it('matches the explicit isFramework flag regardless of repoUrl', () => {
    expect(isFrameworkProjectRow({ isFramework: true }, PROD_ENV)).toBe(true);
    expect(isFrameworkProjectRow({ isFramework: true, repoUrl: 'someone-else/other-repo' }, PROD_ENV)).toBe(true);
  });

  it('does NOT match a same-named project with no repoUrl and no flag (name is user-editable)', () => {
    expect(isFrameworkProjectRow({ name: 'crossmodel' } as unknown as FrameworkProjectRow, PROD_ENV)).toBe(false);
    expect(isFrameworkProjectRow({ name: 'Crossmodel', description: 'the digby repo' } as unknown as FrameworkProjectRow, PROD_ENV)).toBe(false);
  });

  it('does NOT match OTHER github repos', () => {
    expect(isFrameworkProjectRow({ repoUrl: 'https://github.com/example-org/repo' }, PROD_ENV)).toBe(false);
    expect(isFrameworkProjectRow({ repoUrl: 'schooltime/app' }, PROD_ENV)).toBe(false);
  });

  it('isFramework:false does NOT match on its own (only an explicit true is a stamp)', () => {
    expect(isFrameworkProjectRow({ isFramework: false }, PROD_ENV)).toBe(false);
    expect(isFrameworkProjectRow({}, PROD_ENV)).toBe(false);
  });

  it('a null row is never the framework', () => {
    expect(isFrameworkProjectRow(null, PROD_ENV)).toBe(false);
  });
});

describe('isFrameworkProjectRow — non-prod instances resolve their OWN repo', () => {
  it('a selfhost instance matches its own configured SELF_REPO slug', () => {
    expect(isFrameworkProjectRow({ repoUrl: 'https://github.com/me/my-digby-fork' }, SELFHOST_ENV)).toBe(true);
    // …and NOT the production repo slug (never a fallback there):
    expect(isFrameworkProjectRow({ repoUrl: 'https://github.com/example-org/crossmodel' }, SELFHOST_ENV)).toBe(false);
  });

  it('a non-prod instance with NO own repo configured: only the explicit flag matches', () => {
    const env = { DIGBY_INSTANCE: 'selfhost' } as NodeJS.ProcessEnv;
    expect(isFrameworkProjectRow({ repoUrl: 'https://github.com/me/anything' }, env)).toBe(false);
    expect(isFrameworkProjectRow({ isFramework: true }, env)).toBe(true);
  });

  it('the instance flag alone still matches on a selfhost instance', () => {
    expect(isFrameworkProjectRow({ isFramework: true }, SELFHOST_ENV)).toBe(true);
  });
});

describe('isFrameworkProjectRef — the ref that carries repoUrl at the seam', () => {
  it('reads row.repoUrl (the projects controller loads bare rows)', () => {
    expect(isFrameworkProjectRef({ repoUrl: 'example-org/crossmodel' }, PROD_ENV)).toBe(true);
    expect(isFrameworkProjectRef({ repoUrl: null }, PROD_ENV)).toBe(false);
  });

  it('refuses a string (callers must pass the loaded row)', () => {
    // A string has no repoUrl — never identity. (TypeScript forbids it; the
    // runtime pin keeps a JS caller from spoofing.)
    expect((isFrameworkProjectRef as (r: unknown, e?: NodeJS.ProcessEnv) => boolean)('example-org/crossmodel', PROD_ENV)).toBe(false);
  });
});

describe('resolveFrameworkProjectRef — the getProjectAccess {project, role} shape', () => {
  it('identity rides on access.project (owner call)', () => {
    expect(resolveFrameworkProjectRef({ project: { repoUrl: 'github.com/example-org/crossmodel' }, role: 'owner' } as unknown as Parameters<typeof resolveFrameworkProjectRef>[0], PROD_ENV)).toBe(true);
    expect(resolveFrameworkProjectRef({ project: { name: 'Work' }, role: 'owner' } as unknown as Parameters<typeof resolveFrameworkProjectRef>[0], PROD_ENV)).toBe(false);
  });

  it('null access (no access) is not the framework', () => {
    expect(resolveFrameworkProjectRef(null, PROD_ENV)).toBe(false);
  });
});

describe('isFrameworkChatRow — the chat leg (system chats live in the framework project)', () => {
  it('the Fleet/Project supervisor flags alone are identity (ungrouped system chats)', () => {
    expect(isFrameworkChatRow({ isSupervisor: true })).toBe(true);
    expect(isFrameworkChatRow({ isProjectSupervisor: true })).toBe(true);
    expect(isFrameworkChatRow({ isSupervisor: false, isProjectSupervisor: false })).toBe(false);
  });

  it('a chat FILED in the framework project is framework surface too', () => {
    expect(isFrameworkChatRow({ isSupervisor: false, isProjectSupervisor: false, projectId: 'fw-1' }, 'fw-1')).toBe(true);
    expect(isFrameworkChatRow({ isSupervisor: false, projectId: 'other' }, 'fw-1')).toBe(false);
    expect(isFrameworkChatRow({ isSupervisor: false }, 'fw-1')).toBe(false);
  });

  it('a supervisor flag survives a move (both legs checked)', () => {
    expect(isFrameworkChatRow({ isSupervisor: true, projectId: 'user-proj' }, 'fw-1')).toBe(true);
  });
});

describe('refusal messages', () => {
  it('every action names the Digby Framework surface', () => {
    for (const action of ['rename', 'move', 'delete', 'archive', 'share', 'member', 'move-into'] as const) {
      const msg = frameworkProjectRefusal(action);
      expect(msg).toContain('Digby Framework');
    }
  });

  it('delete names the Manager surface (where it stays reachable)', () => {
    expect(frameworkProjectRefusal('delete')).toContain('Manager');
    expect(frameworkProjectRefusal('archive')).toContain('Manager');
  });

  it('move-into is its own wording (filing user projects under the platform project)', () => {
    expect(frameworkProjectRefusal('move-into')).toContain('filed');
  });

  it('frameworkGuardMessage is the same leaf with a guard-suffix', () => {
    expect(frameworkGuardMessage('delete')).toContain(frameworkProjectRefusal('delete'));
  });
});

describe('FRAMEWORK_PROJECT_SURFACE_DISABLED kill switch', () => {
  it('identity reads FALSE with the switch set (every guard passes through)', () => {
    process.env.FRAMEWORK_PROJECT_SURFACE_DISABLED = '1';
    expect(isFrameworkProjectRow({ repoUrl: 'https://github.com/example-org/crossmodel', isFramework: true }, PROD_ENV)).toBe(false);
    expect(isFrameworkProjectRef({ repoUrl: 'example-org/crossmodel' }, PROD_ENV)).toBe(false);
    expect(isFrameworkProject({ repoUrl: 'example-org/crossmodel' }, PROD_ENV)).toBe(false);
    expect(isFrameworkChatRow({ isSupervisor: true })).toBe(false);
  });
});
