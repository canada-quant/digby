/**
 * Instance isolation boundary (ticket c75b5f34) — the leaf's contract.
 *
 * Pins (the ticket's ACCEPT, verbatim): a self-hosted instance runs its full
 * self-improve loop end-to-end on its own copy with prod targets
 * unreachable/unconfigured, and any attempt to resolve a prod target from a
 * non-prod instance HARD-FAILS with a clear error — never a silent fallback.
 *
 * The leaf is import-free ON PURPOSE (ticket 6665fff6 doctrine): validators
 * import it, so this suite must never need the env-validating chain either —
 * pure function tests, no mocks, no DB, no env landmines.
 */
import {
  DIGBY_INSTANCE_ENV,
  PROD_INSTANCE,
  PROD_REPO,
  IsolationBoundaryError,
  instanceKind,
  isProdInstance,
  normalizeGithubRepoTarget,
  isProdRepoTarget,
  isolationRefusal,
  assertRepoTargetAllowed,
  repoTargetAllowed,
  resolveInstanceRepoTarget,
  resolveInstanceOwnRepoSlug,
} from './instance-targets';

const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...over });

afterEach(() => { delete process.env.DIGBY_INSTANCE; });

describe('instanceKind / isProdInstance — DIGBY_INSTANCE is the identity', () => {
  it('unset or empty ⇒ prod (backward compatible: every existing deployment keeps its behavior until it opts in)', () => {
    expect(instanceKind(env())).toBe('prod');
    expect(instanceKind(env({ DIGBY_INSTANCE: '' }))).toBe('prod');
    expect(instanceKind(env({ DIGBY_INSTANCE: '  ' }))).toBe('prod');
    expect(isProdInstance(env())).toBe(true);
  });

  it("'prod' (any case) ⇒ prod; anything else — 'selfhost', 'edge', a box name — is NON-prod", () => {
    expect(instanceKind(env({ DIGBY_INSTANCE: 'prod' }))).toBe('prod');
    expect(instanceKind(env({ DIGBY_INSTANCE: 'PROD' }))).toBe('prod');
    expect(isProdInstance(env({ DIGBY_INSTANCE: 'prod' }))).toBe(true);
    expect(isProdInstance(env({ DIGBY_INSTANCE: 'selfhost' }))).toBe(false);
    expect(isProdInstance(env({ DIGBY_INSTANCE: 'EDGE' }))).toBe(false);
    expect(instanceKind(env({ DIGBY_INSTANCE: 'Edge' }))).toBe('edge');
    expect(instanceKind(env({ DIGBY_INSTANCE: 'my-home-box' }))).toBe('my-home-box');
  });

  it('reads the canonical env var name from the exported constant', () => {
    expect(DIGBY_INSTANCE_ENV).toBe('DIGBY_INSTANCE');
    expect(PROD_INSTANCE).toBe('prod');
    expect(PROD_REPO).toBe('example-org/crossmodel');
  });
});

describe('normalizeGithubRepoTarget — slug/URL canonicalization, never a guess', () => {
  it.each([
    ['example-org/crossmodel', 'example-org/crossmodel'],
    ['example-org/crossmodel', 'example-org/crossmodel'],
    ['https://github.com/example-org/crossmodel', 'example-org/crossmodel'],
    ['https://github.com/example-org/crossmodel.git', 'example-org/crossmodel'],
    ['https://github.com/example-org/crossmodel/', 'example-org/crossmodel'],
    ['git@github.com:example-org/crossmodel.git', 'example-org/crossmodel'],
    // c75b5f34 follow-up (cross-family review finding 1): the spellings that
    // used to fall out as null = FAIL-OPEN. new URL() drops the default
    // port and validateRepoUrl accepts it (port 443 carve-out), git pushes
    // to it — the guard MUST see through it.
    ['https://github.com:443/example-org/crossmodel', 'example-org/crossmodel'],
    ['https://github.com:443/example-org/crossmodel.git', 'example-org/crossmodel'],
    ['https://GITHUB.COM:443/example-org/crossmodel', 'example-org/crossmodel'],
    ['https://github.com./example-org/crossmodel', 'example-org/crossmodel'],
    ['https://user@github.com/example-org/crossmodel', 'example-org/crossmodel'],
    ['acme/edge-digby', 'acme/edge-digby'],
    ['acme/edge-digby.git', 'acme/edge-digby'],
    ['https://github.com:443/acme/edge-digby', 'acme/edge-digby'],
  ])('%s → %s', (input, want) => {
    expect(normalizeGithubRepoTarget(input)).toBe(want);
  });

  it.each([
    [''],
    ['   '],
    ['not-a-repo'],
    ['a/b/c'],
    ['https://gitlab.com/a/b'],
    ['https://gitlab.com:443/a/b'],
    ['https://github.com/'],
    ['a/'],
    ['/b'],
    ['https://github.com:443/only-one-segment'],
  ])('%s → null (no repo named — never a guess)', (input) => {
    expect(normalizeGithubRepoTarget(input)).toBeNull();
  });

  it('isProdRepoTarget matches the prod repo in every spelling; other repos do not match', () => {
    expect(isProdRepoTarget('example-org/crossmodel')).toBe(true);
    expect(isProdRepoTarget('https://github.com/example-org/crossmodel.git')).toBe(true);
    expect(isProdRepoTarget('example-org/crossmodel ')).toBe(true);
    // the review's fail-open spellings are PROD targets now
    expect(isProdRepoTarget('https://github.com:443/example-org/crossmodel')).toBe(true);
    expect(isProdRepoTarget('https://github.com./example-org/crossmodel')).toBe(true);
    expect(isProdRepoTarget('acme/edge-digby')).toBe(false);
    expect(isProdRepoTarget('example-org/crossmodel-2')).toBe(false);
    expect(isProdRepoTarget('')).toBe(false);
  });
});

describe('assertRepoTargetAllowed / repoTargetAllowed — the hard fail', () => {
  it('PROD instance: every target allowed (unchanged behavior)', () => {
    expect(() => assertRepoTargetAllowed('example-org/crossmodel', env())).not.toThrow();
    expect(() => assertRepoTargetAllowed('acme/edge-digby', env())).not.toThrow();
    expect(repoTargetAllowed('example-org/crossmodel', env())).toBe(true);
  });

  it('NON-prod instance: the production repo REFUSES (hard fail, IsolationBoundaryError, clear error)', () => {
    const e = env({ DIGBY_INSTANCE: 'selfhost' });
    expect(repoTargetAllowed('example-org/crossmodel', e)).toBe(false);
    expect(() => assertRepoTargetAllowed('example-org/crossmodel', e)).toThrow(IsolationBoundaryError);
    try {
      assertRepoTargetAllowed('example-org/crossmodel', e);
      throw new Error('unreachable');
    } catch (err: any) {
      expect(err).toBeInstanceOf(IsolationBoundaryError);
      expect(err.name).toBe('IsolationBoundaryError');
      expect(err.message).toContain('ISOLATION BOUNDARY');
      expect(err.message).toContain('DIGBY_INSTANCE=selfhost');
      expect(err.message).toContain('example-org/crossmodel');
      expect(err.message).toContain('PRODUCTION');
    }
  });

  it('NON-prod instance: every NON-prod target allowed — the self-improve loop runs on its own copy', () => {
    const e = env({ DIGBY_INSTANCE: 'selfhost' });
    expect(repoTargetAllowed('acme/edge-digby', e)).toBe(true);
    expect(repoTargetAllowed('some-user/digby-fork', e)).toBe(true);
    expect(() => assertRepoTargetAllowed('acme/edge-digby', e)).not.toThrow();
  });

  it('a prod URL spelling is refused too (not just the bare slug)', () => {
    const e = env({ DIGBY_INSTANCE: 'edge' });
    expect(repoTargetAllowed('https://github.com/example-org/crossmodel.git', e)).toBe(false);
    expect(() => assertRepoTargetAllowed('https://github.com/example-org/crossmodel', e)).toThrow(IsolationBoundaryError);
  });

  it('isolationRefusal names the operator fix (own repo env), not just the refusal', () => {
    const msg = isolationRefusal('example-org/crossmodel', env({ DIGBY_INSTANCE: 'selfhost' }));
    expect(msg).toContain('SELF_REPO');
    expect(msg).toContain('GITHUB_REPO_SLUG');
  });
});

describe('resolveInstanceRepoTarget — the env-resolved own-repo resolver (no silent prod fallback)', () => {
  it('PROD instance, env unset ⇒ the production repo (the historical default, CORRECT on prod)', () => {
    expect(resolveInstanceRepoTarget(env())).toEqual({ ok: true, slug: 'example-org/crossmodel' });
    expect(resolveInstanceRepoTarget(env({ INFRA_WATCH_REPO: '' }))).toEqual({ ok: true, slug: 'example-org/crossmodel' });
  });

  it('PROD instance, env set ⇒ the configured repo (an operator fork on prod would be honored)', () => {
    expect(resolveInstanceRepoTarget(env({ GITHUB_REPO_SLUG: 'acme/edge-digby' }))).toEqual({ ok: true, slug: 'acme/edge-digby' });
    expect(resolveInstanceRepoTarget(env({ INFRA_WATCH_REPO: 'https://github.com/acme/edge-digby.git' }), 'INFRA_WATCH_REPO')).toEqual({ ok: true, slug: 'acme/edge-digby' });
  });

  it('NON-prod instance, env UNSET ⇒ explicit refusal — NO production fallback (the silent fallback this module removes)', () => {
    const r = resolveInstanceRepoTarget(env({ DIGBY_INSTANCE: 'selfhost' }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal).toContain('ISOLATION BOUNDARY');
      expect(r.refusal).toContain('GITHUB_REPO_SLUG is not configured');
      expect(r.refusal).toContain('example-org/crossmodel');
      expect(r.refusal).toContain('refusing to fall back');
    }
  });

  it('NON-prod instance, env set to its OWN repo ⇒ resolves the own repo (the loop runs end-to-end on its own copy)', () => {
    expect(resolveInstanceRepoTarget(env({ DIGBY_INSTANCE: 'selfhost', GITHUB_REPO_SLUG: 'acme/edge-digby' }))).toEqual({ ok: true, slug: 'acme/edge-digby' });
    expect(resolveInstanceRepoTarget(env({ DIGBY_INSTANCE: 'edge', SELF_REPO: 'some-user/digby-fork' }), 'SELF_REPO')).toEqual({ ok: true, slug: 'some-user/digby-fork' });
  });

  it('NON-prod instance, env set to the PRODUCTION repo ⇒ REFUSAL naming the boundary (hard fail, never a prod read)', () => {
    for (const v of ['example-org/crossmodel', 'https://github.com/example-org/crossmodel.git']) {
      const r = resolveInstanceRepoTarget(env({ DIGBY_INSTANCE: 'selfhost', GITHUB_REPO_SLUG: v }));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.refusal).toContain('ISOLATION BOUNDARY');
        expect(r.refusal).toContain('PRODUCTION');
      }
    }
  });

  it('NON-prod instance, env set to garbage ⇒ refusal (never a guess)', () => {
    const r = resolveInstanceRepoTarget(env({ DIGBY_INSTANCE: 'selfhost', GITHUB_REPO_SLUG: 'not a repo!!' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal).toContain('is not a GitHub repo slug');
  });
});

describe('resolveInstanceOwnRepoSlug — the ownRepoSlug() shape (self-merge)', () => {
  it('PROD instance ⇒ the production repo (self-merge own-repo behavior unchanged)', () => {
    expect(resolveInstanceOwnRepoSlug('SELF_REPO', env())).toBe('example-org/crossmodel');
    expect(resolveInstanceOwnRepoSlug('SELF_REPO', env({ SELF_REPO: 'acme/edge-digby' }))).toBe('acme/edge-digby');
  });

  it('NON-prod instance, SELF_REPO UNSET ⇒ empty string — no own repo, nothing matches (never silently prod)', () => {
    expect(resolveInstanceOwnRepoSlug('SELF_REPO', env({ DIGBY_INSTANCE: 'selfhost' }))).toBe('');
  });

  it('NON-prod instance, SELF_REPO = own fork ⇒ the fork (self-improvement targets its own repo)', () => {
    expect(resolveInstanceOwnRepoSlug('SELF_REPO', env({ DIGBY_INSTANCE: 'selfhost', SELF_REPO: 'acme/edge-digby' }))).toBe('acme/edge-digby');
  });

  it('NON-prod instance, SELF_REPO = PRODUCTION repo ⇒ IsolationBoundaryError (hard fail at the resolver)', () => {
    expect(() => resolveInstanceOwnRepoSlug('SELF_REPO', env({ DIGBY_INSTANCE: 'selfhost', SELF_REPO: 'example-org/crossmodel' }))).toThrow(IsolationBoundaryError);
  });
});

describe('the wired surfaces keep their prod behavior with DIGBY_INSTANCE unset (backward-compat pin)', () => {
  it('repoTargetAllowed and resolveInstanceRepoTarget read process.env when no env is passed (the deployed call shape)', () => {
    // unset ⇒ prod ⇒ allowed (today's production behavior)
    expect(repoTargetAllowed('example-org/crossmodel')).toBe(true);
    const prodResolved = resolveInstanceRepoTarget();
    expect(prodResolved.ok && prodResolved.slug).toBe('example-org/crossmodel');
    // non-prod via the REAL process.env path
    process.env.DIGBY_INSTANCE = 'selfhost';
    expect(repoTargetAllowed('example-org/crossmodel')).toBe(false);
    expect(() => assertRepoTargetAllowed('example-org/crossmodel')).toThrow(IsolationBoundaryError);
  });
});
