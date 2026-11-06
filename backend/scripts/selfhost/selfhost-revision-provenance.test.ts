/**
 * Self-host source-revision provenance (ticket b37bf85f, 2026-11-06).
 *
 * WHY THIS TEST EXISTS
 *   Asking "is this self-hosted Edge up to date?" had no container-answerable
 *   form. The self-host images carried no OCI revision label and set no
 *   DEPLOY_SHA, so a verification lane had to infer the running revision from a
 *   host-side `git rev-parse`, dist mtimes and dist content (lane 9f6300b5 on
 *   digby.cql.ca). Those are proxies: a container can run an image built from a
 *   different commit than the checkout sits on, and mtimes say nothing about
 *   which source produced the bytes.
 *
 *   The fix is a chain with FOUR links, and every link is droppable by a future
 *   edit that looks harmless:
 *     1. the update path exports the exact checked-out sha   (auto-update.sh)
 *     2. compose forwards it as a BUILD arg                  (selfhost compose)
 *     3. the Dockerfiles bake it into the RUNTIME image      (Dockerfiles)
 *     4. the backend reports it on a read-only surface       (app.ts /health)
 *   Break any one and the answer silently becomes "unknown" again — which is
 *   exactly the state this ticket exists to end. So each link is pinned here,
 *   including the two RE-DECLARATION traps that are invisible when you read
 *   only the top of a Dockerfile:
 *     • an ARG does not cross a `FROM` boundary, so the RUNTIME stage must
 *       re-declare DEPLOY_SHA or the ENV/label expand to empty;
 *     • a LABEL set only in a build stage is NOT on the image an operator
 *       pulls — it must be in the FINAL stage.
 *
 * Runs under BACKEND jest (jest roots include backend/scripts), reads the real
 * source files, and asserts on parsed structure rather than whole-file strings
 * so a comment mentioning DEPLOY_SHA can never satisfy a pin.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { buildRevision } from '../../src/modules/crossmodel/platform/build-revision';
import { shortDeploySha } from '../../src/modules/crossmodel/platform/process-tag';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const COMPOSE = path.join(REPO_ROOT, 'docker-compose.selfhost.yml');
const BACKEND_DOCKERFILE = path.join(REPO_ROOT, 'backend', 'Dockerfile');
const FRONTEND_DOCKERFILE = path.join(REPO_ROOT, 'frontend', 'Dockerfile');
const AUTO_UPDATE = path.join(REPO_ROOT, 'scripts', 'selfhost', 'auto-update.sh');

/** The publish workflow is SUPPLIED into the public tree from a private source
 *  under .digby/, so find it in whichever layout we are in (same dual-layout
 *  rule render-published-compose.test.ts documents). */
const WORKFLOW = (() => {
  const candidates = [
    path.join(REPO_ROOT, '.digby', 'publish', 'publish-images.yml'),
    path.join(REPO_ROOT, '.github', 'workflows', 'publish-images.yml'),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
})();

const read = (p: string) => readFileSync(p, 'utf8');

/** Drop `#` comments and blank lines — a rule stated in prose is not a rule
 *  applied. Indentation is preserved so structure can still be read. */
function codeLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/\s+#.*$/, '').replace(/^\s*#.*$/, ''))
    .filter((l) => l.trim() !== '');
}

/**
 * The lines of one compose service block, from `  <name>:` up to the next key
 * at the same indent (or EOF).
 */
function serviceBlock(composeText: string, name: string): string[] {
  const lines = codeLines(composeText);
  const start = lines.findIndex((l) => new RegExp(`^  ${name}:\\s*$`).test(l));
  if (start === -1) throw new Error(`compose has no service '${name}'`);
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[a-z0-9-]+:\s*$/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out;
}

/** The `args:` entries of a build block, e.g. ['DEPLOY_SHA=${DEPLOY_SHA:-}']. */
function buildArgs(block: string[]): string[] {
  const argsAt = block.findIndex((l) => /^\s+args:\s*$/.test(l));
  if (argsAt === -1) return [];
  const indent = block[argsAt].match(/^ */)![0].length;
  const out: string[] = [];
  for (let i = argsAt + 1; i < block.length; i++) {
    const m = block[i].match(/^(\s*)-\s+(.*)$/);
    if (!m || m[1].length <= indent) break;
    out.push(m[2].trim());
  }
  return out;
}

/** The Dockerfile lines belonging to ONE stage (from its `FROM … AS x`). */
function stageBlock(dockerfileText: string, stage: string): string[] {
  const lines = codeLines(dockerfileText);
  const start = lines.findIndex((l) => new RegExp(`^FROM\\s+\\S+\\s+AS\\s+${stage}\\s*$`, 'i').test(l));
  if (start === -1) throw new Error(`Dockerfile has no 'AS ${stage}' stage`);
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^FROM\s+/i.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out;
}

describe('the update path exports the exact checked-out revision', () => {
  const script = read(AUTO_UPDATE);

  it('reads the sha from the checkout it just fast-forwarded', () => {
    // `git rev-parse HEAD` AFTER the merge — not origin/$BRANCH (which can move
    // between fetch and build) and not the pre-merge LOCAL variable.
    const headAt = script.indexOf('DEPLOY_SHA="$(git rev-parse HEAD)"');
    expect(headAt).toBeGreaterThan(-1);
    expect(script.indexOf('git merge --ff-only')).toBeLessThan(headAt);
    expect(script.indexOf('git reset --hard "origin/$BRANCH"')).toBeLessThan(headAt);
  });

  it('EXPORTS it, so compose can interpolate the build arg', () => {
    // An assignment without `export` is invisible to the `docker compose`
    // child process — the single easiest way to break this chain silently.
    expect(script).toMatch(/^export DEPLOY_SHA$/m);
    const exportAt = script.indexOf('export DEPLOY_SHA');
    const buildAt = script.indexOf('"${compose[@]}" up -d --build');
    expect(exportAt).toBeGreaterThan(-1);
    expect(buildAt).toBeGreaterThan(exportAt);
  });
});

describe('every self-host backend service forwards the revision as a build arg', () => {
  const compose = read(COMPOSE);

  // backend/worker/relay/migrate all build from ./backend, so a missing arg on
  // ANY of them means that container cannot name its own revision.
  for (const svc of ['backend', 'worker', 'relay', 'migrate']) {
    it(`${svc}: passes DEPLOY_SHA`, () => {
      const args = buildArgs(serviceBlock(compose, svc));
      expect({ svc, has: args.some((a) => /^DEPLOY_SHA=/.test(a)) }).toEqual({ svc, has: true });
    });
  }

  it('frontend: passes DEPLOY_SHA (it already bakes NEXT_PUBLIC_DEPLOY_SHA)', () => {
    const args = buildArgs(serviceBlock(compose, 'frontend'));
    expect(args.some((a) => /^DEPLOY_SHA=/.test(a))).toBe(true);
  });

  it('never hard-codes a sha — it must follow the checkout', () => {
    for (const svc of ['backend', 'worker', 'relay', 'migrate', 'frontend']) {
      for (const arg of buildArgs(serviceBlock(compose, svc))) {
        if (!/^DEPLOY_SHA=/.test(arg)) continue;
        // `${DEPLOY_SHA:-…}` — interpolated, never a literal commit.
        expect({ svc, interpolated: /\$\{DEPLOY_SHA:?-/.test(arg) }).toEqual({ svc, interpolated: true });
      }
    }
  });

  it('the revision is a BUILD arg, not a runtime env entry on backend', () => {
    // Runtime env would let a container be TOLD a sha that does not match the
    // bytes it runs — the whole failure mode this ticket closes.
    const block = serviceBlock(compose, 'backend');
    const envAt = block.findIndex((l) => /^ {4}environment:\s*$/.test(l));
    expect(envAt).toBeGreaterThan(-1);
    const envLines = block.slice(envAt).filter((l) => /^\s+-\s+/.test(l)).map((l) => l.trim());
    expect(envLines.some((l) => /^-\s+DEPLOY_SHA=/.test(l))).toBe(false);
  });
});

describe('the backend image carries its revision in the RUNTIME stage', () => {
  const dockerfile = read(BACKEND_DOCKERFILE);
  const production = stageBlock(dockerfile, 'production');

  it('re-declares ARG DEPLOY_SHA after the FROM boundary (or it expands empty)', () => {
    expect(production.some((l) => /^ARG\s+DEPLOY_SHA=/.test(l))).toBe(true);
  });

  it('bakes it as ENV so the process (and /api/health) can read it', () => {
    expect(production.some((l) => /^ENV\s+DEPLOY_SHA=\$DEPLOY_SHA\s*$/.test(l))).toBe(true);
  });

  it('stamps the standard OCI revision label', () => {
    const labels = production.filter((l) => l.includes('org.opencontainers.image.revision'));
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.join('\n')).toContain('$DEPLOY_SHA');
  });

  it('defaults to EMPTY, never a fake sha', () => {
    // `dev` or a literal hex string here would make an unstamped local build
    // claim a revision it does not have.
    expect(production.find((l) => /^ARG\s+DEPLOY_SHA=/.test(l))!.trim()).toBe('ARG DEPLOY_SHA=');
  });

  it('stamps the label in the BUILD stage too (migrate service publishes it)', () => {
    const build = stageBlock(dockerfile, 'build');
    expect(build.filter((l) => l.includes('org.opencontainers.image.revision')).length).toBeGreaterThan(0);
  });
});

describe('the frontend image carries its revision in the FINAL stage', () => {
  const dockerfile = read(FRONTEND_DOCKERFILE);
  const production = stageBlock(dockerfile, 'production');

  it('re-declares ARG DEPLOY_SHA in the final stage (an ARG does not cross FROM)', () => {
    // NO default here on purpose: the one `ARG DEPLOY_SHA=dev` in this file is
    // the build-stage bust key, pinned by
    // scripts/deploy/blue-green-speedups.test.sh invariant #6. A second `=dev`
    // would put that deploy invariant at 2 and strand a source of truth.
    expect(production.some((l) => /^ARG\s+DEPLOY_SHA\s*$/.test(l))).toBe(true);
  });

  it('exposes the revision INSIDE the running frontend container, not just the label', () => {
    // The ticket asks for the revision readable inside the running container.
    // Label-only would satisfy `docker image inspect` but not
    // `docker exec <frontend> printenv DEPLOY_SHA`.
    expect(production.some((l) => /^ENV\s+DEPLOY_SHA=\$DEPLOY_SHA\s*$/.test(l))).toBe(true);
  });

  it('keeps exactly ONE ARG DEPLOY_SHA=dev in the file (the deploy bust key)', () => {
    // deploy invariant #6: the build stage's ARG is the single source of truth
    // for the frontend content-bust key. Asserted here too so a future edit
    // fails in this suite rather than only in the shell harness.
    expect((codeLines(dockerfile).join('\n').match(/^ARG DEPLOY_SHA=dev$/gm) ?? []).length).toBe(1);
  });

  it('stamps the OCI revision label on the image an operator actually pulls', () => {
    const labels = production.filter((l) => l.includes('org.opencontainers.image.revision'));
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.join('\n')).toContain('$DEPLOY_SHA');
  });

  it('the build stage still feeds NEXT_PUBLIC_DEPLOY_SHA from the same ARG', () => {
    const build = stageBlock(dockerfile, 'build');
    expect(build).toContain('ENV NEXT_PUBLIC_DEPLOY_SHA=$DEPLOY_SHA');
  });
});

/**
 * Every entry of every `build-args:` block in a workflow, with comments and
 * blank lines dropped first.
 *
 * This MUST parse rather than search the raw text. An earlier version of this
 * test asserted `wf.split('DEPLOY_SHA=${{ github.sha }}').length >= 3` on the
 * whole file, and an adversarial review refuted it by mutation: delete all
 * three real `build-args:` entries, leave ONE comment containing the same
 * literal, and the pin stayed green while the published images lost their
 * provenance entirely. A pin a comment can satisfy is not a pin.
 */
function workflowBuildArgs(wfText: string): string[] {
  const lines = codeLines(wfText);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)build-args:\s*\|\s*$/);
    if (!m) continue;
    const keyIndent = m[1].length;
    for (let j = i + 1; j < lines.length; j++) {
      const ind = lines[j].match(/^ */)![0].length;
      if (lines[j].trim() === '' ) continue;
      if (ind <= keyIndent) break;
      out.push(lines[j].trim());
    }
  }
  return out;
}

describe('published images are stamped with the commit they were built from', () => {
  const wf = read(WORKFLOW);

  it('has exactly the three publish build-arg blocks a source-free install needs', () => {
    // backend production + backend build stage (migrate pulls the -build tag)
    // + frontend. Fewer means a published image ships without provenance.
    const blocks = (codeLines(wf).join('\n').match(/^\s*build-args:\s*\|\s*$/gm) ?? []).length;
    expect(blocks).toBe(3);
  });

  it('hands github.sha to the backend production, backend build AND frontend', () => {
    const args = workflowBuildArgs(wf);
    const deployArgs = args.filter((a) => /^DEPLOY_SHA=/.test(a));
    // One per publish leg — a missing one is an image nobody can date.
    expect(deployArgs).toHaveLength(3);
    for (const a of deployArgs) expect(a).toBe('DEPLOY_SHA=${{ github.sha }}');
  });

  it('is the checked-out commit, not an input an operator could fake', () => {
    for (const a of workflowBuildArgs(wf)) {
      if (!/^DEPLOY_SHA=/.test(a)) continue;
      expect(a).not.toMatch(/\$\{\{\s*inputs\./);
    }
  });
});

describe('buildRevision() reports honestly', () => {
  it('returns the EXACT commit sha — the operator compares it with git rev-parse HEAD', () => {
    // Deliberately NOT truncated: "does this container match my checkout?" is a
    // string-equality question, and an 8-char prefix loses that guarantee.
    expect(buildRevision({ DEPLOY_SHA: '3efeac28c9eef791bf150500b17ef0423d54450b' } as any))
      .toBe('3efeac28c9eef791bf150500b17ef0423d54450b');
  });

  it('normalises case without changing the value', () => {
    expect(buildRevision({ DEPLOY_SHA: '3EFEAC28C9EEF791BF150500B17EF0423D54450B' } as any))
      .toBe('3efeac28c9eef791bf150500b17ef0423d54450b');
  });

  it('returns null when the build carries no revision — never a guess', () => {
    expect(buildRevision({} as any)).toBeNull();
    // 'dev' is the frontend's long-standing unstamped default; it is not a sha.
    expect(buildRevision({ DEPLOY_SHA: 'dev' } as any)).toBeNull();
    expect(buildRevision({ DEPLOY_SHA: '   ' } as any)).toBeNull();
  });

  it('accepts EXACTLY what the fleet rule accepts (one rule, no second regex)', () => {
    // The whole point of delegating to shortDeploySha: the health surface must
    // never report a revision the metric proc tag would call NOSHA, or the
    // reverse. Checked across the acceptance boundary itself.
    const cases = ['3efeac28', '3efeac28c9eef791bf150500b17ef0423d54450b', 'dev', '', ' x ', 'not-a-sha!', 'abc'];
    for (const v of cases) {
      const env = { DEPLOY_SHA: v } as any;
      const acceptedByFleet = shortDeploySha(env) !== undefined;
      expect({ v, agrees: buildRevision(env) !== null }).toEqual({ v, agrees: acceptedByFleet });
    }
  });
});

describe('the read-only version surface reports it and needs no credentials', () => {
  it('GET /api/health carries `revision` outside production only', () => {
    const app = read(path.join(REPO_ROOT, 'backend', 'src', 'app.ts'));
    // Both paths (/health and /api/health) share ONE payload builder, so a
    // future edit cannot update one and forget the other.
    expect(app).toContain('revision: health.revision');
    expect(app).toMatch(/isProdInstance\(\)\s*\?\s*\{\}\s*:\s*\{\s*revision/);
  });

  it('the payload builder is what BOTH health routes return', () => {
    const app = read(path.join(REPO_ROOT, 'backend', 'src', 'app.ts'));
    const healthRoutes = [...app.matchAll(/app\.get\('(\/api)?\/health',[\s\S]*?\n\}\);/g)].map((m) => m[0]);
    expect(healthRoutes).toHaveLength(2);
    for (const route of healthRoutes) expect(route).toContain('healthPayload(health)');
  });
});

describe('the fix does not leak into the production deploy path', () => {
  it('docker-compose.app.yml gains none of this change', () => {
    // The ticket forbids touching cloud deploy isolation, and production
    // already has its own provenance path (deploy.yml writes .deploy-sha and
    // docker-compose.app.yml passes DEPLOY_SHA as runtime env). Asserted on the
    // FILE rather than `git diff` so this holds in the exported public tree,
    // which is not a git checkout with origin/main.
    //
    // THE SUBJECT IS EXPORT-DROPPED. `.digby/publish/scrub-rules.txt` carries
    // `drop  docker-compose.app.yml` (the production deploy path is not part of
    // the public build/test-only tree), so this file DOES NOT EXIST in a real
    // public checkout. Before this guard it was an unguarded readFileSync and
    // the exported suite died with ENOENT — measured 2026-11-06 as the LAST of
    // 20 red suites in the public tree (`selfhost-revision-provenance`), after
    // #2602 repaired the other 19. Same rule as the WORKFLOW constant above:
    // find it in whichever layout we are in, and only assert on it when the
    // layout actually ships it. A missing subject is NOT a pass for the
    // private tree, where the file always exists — so the guard is
    // existence-based, never a blanket skip.
    const PROD_COMPOSE = path.join(REPO_ROOT, 'docker-compose.app.yml');
    if (!existsSync(PROD_COMPOSE)) return; // export layout: dropped by policy
    const prod = codeLines(read(PROD_COMPOSE));
    expect(prod.some((l) => l.includes('DIGBY_SOURCE_URL'))).toBe(false);
    expect(prod.some((l) => l.includes('org.opencontainers.image.revision'))).toBe(false);
  });
});