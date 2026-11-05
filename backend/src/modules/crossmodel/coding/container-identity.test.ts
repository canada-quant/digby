/**
 * Ticket c25f8b7e — durable session container identity.
 *
 * THE INCIDENT THIS PINS: a deploy/restart wave replaced two Schooltime lanes'
 * session containers inside one minute. Everything their lanes had running
 * inside died, and the lanes found out hours later from a bare
 * `No such container`, re-deriving (lane 19dd22bc) or losing (lane 60dfc8a8)
 * the artifacts. The container NAME is deterministic, so only the docker ID
 * witnesses a swap — this leaf remembers it durably and reports the swap once.
 *
 * The contract these tests protect is FAIL-SAFE: a false "your work is gone"
 * alarm costs a lane an entire recovery cycle, so an unknown past, an
 * unreadable record and a first sighting must all stay SILENT, and only
 * "same session, different container id" may ever speak.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import {
  readContainerIdentity, recordContainerIdentity, forgetContainerIdentity,
  containerReplacementNotice, containerIdentityRoot,
} from './container-identity';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'container-identity-'));
  // Read at call time by the leaf, so pointing it after import is honoured.
  process.env.CODING_CONTAINER_IDENTITY_ROOT = tmpRoot;
});

afterEach(async () => {
  delete process.env.CODING_CONTAINER_IDENTITY_ROOT;
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

const NAME = 'digby-code-sess-identity';
const ID_A = 'sha256:' + 'a'.repeat(64);
const ID_B = 'sha256:' + 'b'.repeat(64);

describe('container identity — the failure cases must stay silent (fail-safe)', () => {
  test('a FIRST-EVER sighting reports nothing and records what it saw', async () => {
    const r = await recordContainerIdentity('sess-first', NAME, ID_A, 1000);
    expect(r).toBeNull(); // unknown past is NOT a replacement
    const stored = await readContainerIdentity('sess-first');
    expect(stored).toMatchObject({ container: NAME, id: ID_A });
    expect(stored!.seenAt).toBe(new Date(1000).toISOString());
  });

  test('the SAME container id reports nothing on any number of later calls', async () => {
    await recordContainerIdentity('sess-same', NAME, ID_A, 1000);
    for (const t of [2000, 3000, 4000]) {
      expect(await recordContainerIdentity('sess-same', NAME, ID_A, t)).toBeNull();
    }
    // …and the original first-seen time is NOT advanced by repeat sightings, so
    // a later replacement can still say honestly when the lost container began.
    expect((await readContainerIdentity('sess-same'))!.seenAt).toBe(new Date(1000).toISOString());
  });

  test('an UNREADABLE id writes nothing and reports nothing (never guess an identity)', async () => {
    await recordContainerIdentity('sess-noid', NAME, ID_A, 1000);
    for (const bad of ['', '   ', undefined as unknown as string]) {
      expect(await recordContainerIdentity('sess-noid', NAME, bad, 2000)).toBeNull();
    }
    // The record still holds the last REAL id — a docker hiccup must not erase
    // the evidence that would let a later run report the swap.
    expect((await readContainerIdentity('sess-noid'))!.id).toBe(ID_A);
  });

  test('a missing sessionId or container name is a no-op', async () => {
    expect(await recordContainerIdentity('', NAME, ID_A)).toBeNull();
    expect(await recordContainerIdentity('sess-x', '', ID_A)).toBeNull();
    expect(await readContainerIdentity('sess-x')).toBeNull();
  });

  test('a malformed record on disk reads as absent rather than throwing', async () => {
    await fs.mkdir(tmpRoot, { recursive: true });
    await fs.writeFile(path.join(tmpRoot, 'sess-corrupt.json'), '{not json');
    expect(await readContainerIdentity('sess-corrupt')).toBeNull();
    // …and the next sighting is therefore a FIRST sighting (silent), not a bogus swap.
    expect(await recordContainerIdentity('sess-corrupt', NAME, ID_A, 5000)).toBeNull();
    expect((await readContainerIdentity('sess-corrupt'))!.id).toBe(ID_A);
  });

  test('a failsafe on the fs side never throws out of the recorder', async () => {
    // Point the root at a path that cannot be created (a file, not a dir).
    const bogusRoot = path.join(tmpRoot, 'not-a-dir');
    await fs.writeFile(bogusRoot, 'x');
    process.env.CODING_CONTAINER_IDENTITY_ROOT = bogusRoot;
    await expect(recordContainerIdentity('sess-boom', NAME, ID_A)).resolves.toBeNull();
    await expect(forgetContainerIdentity('sess-boom')).resolves.toBeUndefined();
  });
});

describe('container identity — a real replacement IS reported, once, with the old id', () => {
  test('a different docker id for the same session reports the swap, naming the previous id and its first-seen time', async () => {
    await recordContainerIdentity('sess-swap', NAME, ID_A, 1_000_000);
    const r = await recordContainerIdentity('sess-swap', NAME, ID_B, 2_000_000);

    expect(r).not.toBeNull();
    expect(r!.container).toBe(NAME);
    expect(r!.previousId).toBe(ID_A);
    expect(r!.previousSeenAt).toBe(new Date(1_000_000).toISOString());
    expect(r!.replacedAt).toBe(new Date(2_000_000).toISOString());
  });

  test('the swap is reported ONCE — the next run in the new container is quiet', async () => {
    await recordContainerIdentity('sess-once', NAME, ID_A, 1000);
    expect(await recordContainerIdentity('sess-once', NAME, ID_B, 2000)).not.toBeNull();
    // The record now holds B; nothing more to report until B is itself replaced.
    expect(await recordContainerIdentity('sess-once', NAME, ID_B, 3000)).toBeNull();
    expect((await readContainerIdentity('sess-once'))!.id).toBe(ID_B);
    expect((await readContainerIdentity('sess-once'))!.seenAt).toBe(new Date(2000).toISOString());
  });

  test('a container NAME change also counts as a replacement (a session that moved to a different exec target)', async () => {
    await recordContainerIdentity('sess-move', 'digby-dev-aaaa', ID_A, 1000);
    const r = await recordContainerIdentity('sess-move', 'digby-code-sess-move', ID_A, 2000);
    expect(r).not.toBeNull();
    expect(r!.container).toBe('digby-code-sess-move');
    expect(r!.previousId).toBe(ID_A);
  });

  test('two sessions are tracked independently — one swap never implicates the other', async () => {
    await recordContainerIdentity('sess-p', NAME, ID_A, 1000);
    await recordContainerIdentity('sess-q', NAME, ID_A, 1000);
    expect(await recordContainerIdentity('sess-q', NAME, ID_B, 2000)).not.toBeNull();
    expect(await recordContainerIdentity('sess-p', NAME, ID_A, 2000)).toBeNull();
  });
});

describe('container identity — deliberate teardown forgets (no notice nobody needs)', () => {
  test('after forget, the next container is a FIRST sighting — the harness-caused swap stays silent', async () => {
    await recordContainerIdentity('sess-forget', NAME, ID_A, 1000);
    await forgetContainerIdentity('sess-forget');
    expect(await readContainerIdentity('sess-forget')).toBeNull();
    expect(await recordContainerIdentity('sess-forget', NAME, ID_B, 2000)).toBeNull();
  });

  test('forgetting twice is idempotent', async () => {
    await recordContainerIdentity('sess-idem', NAME, ID_A, 1000);
    await forgetContainerIdentity('sess-idem');
    await expect(forgetContainerIdentity('sess-idem')).resolves.toBeUndefined();
  });
});

describe('container identity — the lane-facing notice', () => {
  const replacement = {
    container: NAME,
    previousId: ID_A,
    previousSeenAt: '2026-11-03T04:58:00.000Z',
    replacedAt: '2026-11-03T05:23:00.000Z',
  };

  test('names the detection time, the previous container id (docker 12-char form) and what died', () => {
    const notice = containerReplacementNotice(replacement);
    expect(notice).toContain('CONTAINER WAS REPLACED');
    expect(notice).toContain('2026-11-03T05:23:00.000Z'); // when it was detected
    expect(notice).toContain('aaaaaaaaaaaa');             // previous id, 12 chars
    expect(notice).not.toContain('sha256:');              // never the raw 64-char id
    expect(notice).toContain('2026-11-03T04:58:00.000Z'); // when the lost container began
    // The two facts a lane must act on: what died, and what did NOT.
    expect(notice).toMatch(/background processes/i);
    expect(notice).toMatch(/worktree/i);
    expect(notice).toMatch(/RE-CHECK/i);
  });

  test('opens with the [coding container: …] marker every other container note uses, so a lane recognises the class', () => {
    expect(containerReplacementNotice(replacement).startsWith('[coding container: ')).toBe(true);
  });

  test('the workspace-safe root derivation keeps the record OFF the workspace volume (it is session-mountable)', () => {
    delete process.env.CODING_CONTAINER_IDENTITY_ROOT;
    const savedEnvRoot = process.env.CODING_ENV_ROOT;
    const savedWs = process.env.CODING_WORKSPACE_ROOT;
    process.env.CODING_ENV_ROOT = '/app/coding-session-env';
    delete process.env.CODING_WORKSPACE_ROOT;
    try {
      expect(containerIdentityRoot()).toBe('/app/coding-session-env/containers');
    } finally {
      if (savedEnvRoot === undefined) delete process.env.CODING_ENV_ROOT; else process.env.CODING_ENV_ROOT = savedEnvRoot;
      if (savedWs === undefined) delete process.env.CODING_WORKSPACE_ROOT; else process.env.CODING_WORKSPACE_ROOT = savedWs;
    }
  });
});

/**
 * Ticket 9a391db3 — "a tool I installed is gone but my container is alive".
 *
 * THE SIGHTING THIS REPLAYS: a lane's shell never lost its container, yet
 * `/tmp/bin/tssh-amd2` vanished mid-run and the lane's next call to it exited
 * 127. Two mechanisms were on the table and they are NOT the same event:
 *
 *   (a) the pre-exec disk-pressure wipe. RULED OUT here, and the ruling is
 *       pinned below: its keep-list preserves /tmp/bin unconditionally (load-
 *       bearing, ticket 6a8dddd3, since 2026-09-11 — verified by the same
 *       assertion landing as a failure on any tree that drops `! -name bin`).
 *   (b) the writable layer going with a REPLACED container. HOME is /tmp in
 *       three of the four provisioning postures, so $HOME/.local and $HOME/bin
 *       are ON that layer: a swap takes them silently, and a same-name
 *       re-create means the next exec simply works — the lane never sees a
 *       "No such container" and concludes it survived.
 *
 * WHAT WAS BROKEN BY (b) SURVIVING UNSTATES: the replacement notices told the
 * lane the opposite of the truth — "NOT lost: … (installed CLIs in
 * $HOME/.local, SSH keys, DIGBY_ENV)" — so a lane reading it trusted a tool
 * that was never coming back. A notice that MISSTATES what survived is worse
 * than no notice: it sends the lane looking for a broken PATH instead of a
 * missing binary. These assertions fail on the pre-fix wording.
 */
describe('ticket 9a391db3 — what a swap actually takes (the /tmp-installed tool)', () => {
  const replacement = {
    container: NAME,
    previousId: ID_A,
    previousSeenAt: '2026-11-03T07:20:00.000Z',
    replacedAt: '2026-11-03T07:30:00.000Z',
  };

  test('REPLAY 9a391db3: the pre-exec wipe keep-list still protects /tmp/bin, so the wipe can NEVER be blamed for this', async () => {
    const svc = await fs.readFile(path.join(__dirname, 'container.service.ts'), 'utf8');
    const wipe = svc.split('\n').find((l) => l.includes('find /tmp -xdev'));
    // The pre-exec /tmp wipe must exist — this test pins its keep-list.
    expect(wipe).toBeTruthy();
    // The exact report path can only vanish if `bin` stops being excluded.
    expect(wipe).toContain('! -name bin');
    expect(wipe).toContain('! -name .local');
    expect(wipe).toContain('! -name digby-proc');
    // …and it must stay maxdepth 1, i.e. it never descends INTO a kept dir.
    expect(wipe).toContain('-maxdepth 1');
  });

  test('REPLAY 9a391db3: the notice no longer promises installed CLIs survived, and names the writable-layer home', () => {
    const notice = containerReplacementNotice(replacement);
    // The false promise that made the lane chase a PATH problem.
    expect(notice).not.toMatch(/installed CLIs in \$HOME\/\.local, SSH keys/);
    expect(notice).not.toMatch(/durable \$HOME on the workspace volume/);
    // The truth a lane must be able to act on.
    expect(notice).toContain('writable layer');
    expect(notice).toContain('$HOME/.local/bin');
    expect(notice).toContain('$HOME/bin');
    expect(notice).toContain('HOME=/tmp');
    // The discriminator: exit 127 after a swap is a missing binary, not a broken PATH.
    expect(notice).toContain('127');
    expect(notice).toContain('command -v');
    // What genuinely survives must STILL be promised (image bins + worktree + env file).
    expect(notice).toContain('/usr/local/bin');
    expect(notice).toContain('tssh');
    expect(notice).toContain('$DIGBY_ENV');
  });

  /**
   * Ticket d9ed0c1f — "the swap took my SSH identity and the deploy is blocked".
   *
   * THE SIGHTING THIS REPLAYS: a lane mid-`box deploy` found $HOME=/tmp with
   * ~/.ssh gone entirely (no keys, no known_hosts, SSH_AUTH_SOCK unset) and got
   * "Host key verification failed" / "Cannot stat /tmp/.ssh/known_hosts", while
   * the target box was HEALTHY over tailscale. It correctly refused to weaken
   * host-key checking to route around it — and then had no stated way forward.
   *
   * WHY THE SHIPPED NOTICE DID NOT COVER IT: the post-9a391db3 wording names the
   * writable layer as the place installed BINARIES die (exit 127, reinstall).
   * SSH reads as a network/tailnet problem, so a lane does not map it onto that
   * sentence — yet it is the same layer, because the session's passwd row is
   * `pw_dir=/tmp`, which makes ssh's `~/.ssh` literally `/tmp/.ssh` (the exact
   * path in the report). The notices must name that identity loss AND forbid the
   * downgrade, so no lane is left choosing between a blocked deploy and turning
   * host-key checking off.
   */
  describe('ticket d9ed0c1f — a swap takes the SSH identity too (pw_dir=/tmp ⇒ ~/.ssh is /tmp/.ssh)', () => {
    const replacement = {
      container: NAME,
      previousId: ID_A,
      previousSeenAt: '2026-11-03T13:40:00.000Z',
      replacedAt: '2026-11-03T14:05:00.000Z',
    };

    test('REPLAY d9ed0c1f: the run-start notice names the SSH identity loss and the exact failures a lane sees', () => {
      const notice = containerReplacementNotice(replacement);
      // The mechanism, so the lane can reason instead of guess.
      expect(notice).toContain('/tmp/.ssh');
      expect(notice).toContain('pw_dir=/tmp');
      // Both error strings from the report — recognition is the whole point.
      expect(notice).toContain('Host key verification failed');
      expect(notice).toContain('Cannot stat /tmp/.ssh/known_hosts');
      // The target is innocent; the client lost its identity.
      expect(notice).toMatch(/target host is usually fine/i);
    });

    test('REPLAY d9ed0c1f: the notice FORBIDS weakening host-key checking and names a SAFE, sanctioned re-establish path', () => {
      const notice = containerReplacementNotice(replacement);
      // The downgrade the lane must not take — named so it is recognisable as forbidden.
      expect(notice).toContain('StrictHostKeyChecking=no');
      expect(notice).toContain('UserKnownHostsFile=/dev/null');
      expect(notice).toMatch(/NEVER answer that by weakening host-key checking/);
      // …and the route that actually works, because the worktree survives a swap.
      // REVIEW FINDING F1 (blocking, safety): "keep a key in the worktree" was the
      // FIRST wording and is unsafe — the checkpoint/reaper git adds would sweep a
      // loose private key into a commit. The sanctioned on-worktree location is
      // .digby/secrets/ (GIT_ADD_NEVER_INCLUDE, workspace.service.ts), and the
      // keyless SSM path needs no key at all. Pin BOTH so a later edit cannot
      // drift back to the unsafe phrasing.
      expect(notice).toContain('.digby/secrets/');
      expect(notice).toMatch(/never reaches a commit/);
      expect(notice).toContain('run-on-box.sh');
      // The host-key source must not be the connection itself (CI's ssh-keyscan
      // trust-on-first-use is exactly what the notice forbids).
      expect(notice).toMatch(/NOT the connection itself/);
    });

    test('REPLAY d9ed0c1f: the MID-RUN "this command did not run" note carries the same SSH truth (a lane can meet either one)', async () => {
      const svc = await fs.readFile(path.join(__dirname, 'container.service.ts'), 'utf8');
      const addendum = svc.split('\n').find((l) => l.includes('THIS COMMAND DID NOT RUN')) || '';
      expect(addendum).toBeTruthy();
      expect(addendum).toContain('/tmp/.ssh');
      expect(addendum).toContain('d9ed0c1f');
      expect(addendum).toMatch(/NEVER disable host-key checking/i);
      expect(addendum).toContain('.digby/secrets/');
      expect(addendum).toContain('run-on-box.sh');
    });

    test('REPLAY d9ed0c1f: the harness doc stops claiming the durable $HOME survives a swap (refuted by 9a391db3)', async () => {
      const doc = await fs.readFile(path.join(__dirname, '../../../../../docs/DIGBY_CODE_HARNESS.md'), 'utf8');
      // The pre-#2404 sentence promised a surviving $HOME; HOME=/tmp is the
      // writable layer, so it cannot survive. A doc that says otherwise sends a
      // lane looking for its key on a volume that never held it.
      expect(doc).not.toContain('the worktree and the durable `$HOME` on the workspace volume survive');
      expect(doc).toContain('/tmp/.ssh');
    });
  });

  test('REPLAY 9a391db3: the standing SHELL STATE note stops teaching "the keep-list protects my installs" as if it survived a swap', async () => {
    const agent = await fs.readFile(path.join(__dirname, 'agent.ts'), 'utf8');
    const shellState = agent.split('\n').find((l) => l.includes('$HOME IS /tmp')) || '';
    expect(shellState).toBeTruthy();
    // The wipe line itself (and its keep-list) must be left standing…
    expect(shellState).toContain('$HOME/.local');
    expect(shellState).toContain('/tmp/digby-proc');
    // …but it must now bound that promise to the WIPE versus a container swap.
    expect(shellState).toContain('9a391db3');
    expect(shellState).toMatch(/CONTAINER REPLACEMENT/);
    expect(shellState).toContain('127');
  });
});