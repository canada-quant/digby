/**
 * SESSION CONTAINER IDENTITY ACROSS REPLACEMENTS — ticket c25f8b7e (2026-11-03).
 *
 * THE INCIDENT. A platform deploy / restart wave replaced two independent
 * Schooltime lanes' session containers inside the same minute. Everything a
 * lane had running INSIDE the container died with it — a 325-row generator
 * launched at 04:58Z and the firing's independent reviewer artifact — and the
 * lanes only found out afterwards, from a bare `Error response from daemon:
 * No such container: digby-code-…`. One lane burned ~1 h re-deriving work a
 * checkpoint would have saved; the other lost two probes outright because its
 * shell never came back for that firing.
 *
 * WHY A SEPARATE STORE IS NEEDED. The container NAME is deterministic
 * (`digby-code-<sid12>` per session, `digby-dev-<uid12>` per shared dev
 * container), so a name can never reveal a swap — but the container's own
 * docker ID does. This module remembers, per session and DURABLY, the ID the
 * session last ran in, and reports the swap the first time a different ID
 * shows up for the same session.
 *
 * WHERE THE RECORD LIVES. On the same dedicated `coding_session_env` volume as
 * the session env-seed sidecars (`CODING_ENV_ROOT`): it survives deploys,
 * container recycles, host restarts and worktree reaps, and that volume is
 * mounted ONLY into backend/worker — never into a session container — so a
 * lane cannot forge or erase its own replacement record. The record holds no
 * secrets (a container id + two timestamps), so a misconfigured root inside
 * the workspace volume would leak nothing; the default derivation still keeps
 * it off that volume for the same reason the env seeds do.
 *
 * FAIL-SAFE — NEVER A FALSE ALARM. This is the whole contract:
 *   - NO record (a new session, a different box, a pruned volume) → NO notice.
 *     An unknown past is not a replacement.
 *   - an unreadable/absent container ID (docker down, container already gone)
 *     → nothing is written, nothing is reported.
 *   - only "same session, SAME container name, a DIFFERENT id than the one we
 *     wrote down" reports — which is exactly and only a replacement.
 * Everything here is best-effort and never throws: this runs on the run-start
 * and exec paths, where a bookkeeping failure must never block a lane.
 */

import * as path from 'path';
import * as fs from 'fs/promises';

/** What we wrote down for a session: the container name it ran in, that
 *  container's docker id, and when we first saw that id. */
export interface ContainerIdentity {
  container: string;
  id: string;
  /** ISO — when this container id was first seen for the session. */
  seenAt: string;
}

/** A detected replacement: the id/name we had on file and when we noticed. */
export interface ContainerReplacement {
  container: string;
  previousId: string;
  /** ISO — when the previous container id was first seen (≈ when the lane's
   *  background workers were started in it, give or take the run boundary). */
  previousSeenAt: string;
  /** ISO — detection time (this run's resolution of the container). */
  replacedAt: string;
}

const WORKSPACE_ROOT = process.env.CODING_WORKSPACE_ROOT || '/app/coding-workspaces';
/** Same volume as the env-seed sidecars (workspace.service CODING_ENV_ROOT),
 *  one level down. `CODING_CONTAINER_IDENTITY_ROOT` overrides it (tests). */
const ENV_ROOT = process.env.CODING_ENV_ROOT
  || path.join(path.dirname(WORKSPACE_ROOT), 'coding-session-env');

/** Directory holding one `<sessionId>.json` per session. Read at call time so a
 *  test can point `CODING_CONTAINER_IDENTITY_ROOT` at a tmp dir after import. */
export function containerIdentityRoot(): string {
  return process.env.CODING_CONTAINER_IDENTITY_ROOT || path.join(ENV_ROOT, 'containers');
}

const recordPath = (sessionId: string): string =>
  path.join(containerIdentityRoot(), `${String(sessionId).replace(/[^a-zA-Z0-9-]/g, '')}.json`);

/** Read the stored identity, or null (absent / unreadable / malformed). Never throws. */
export async function readContainerIdentity(sessionId: string): Promise<ContainerIdentity | null> {
  if (!sessionId) return null;
  try {
    const raw = await fs.readFile(recordPath(sessionId), 'utf8');
    const parsed = JSON.parse(raw) as Partial<ContainerIdentity>;
    if (!parsed || typeof parsed.container !== 'string' || typeof parsed.id !== 'string') return null;
    return {
      container: parsed.container,
      id: parsed.id,
      seenAt: typeof parsed.seenAt === 'string' ? parsed.seenAt : new Date(0).toISOString(),
    };
  } catch { return null; }
}

/** Atomically write the record (tmp + rename). Best-effort — never throws. */
async function writeIdentity(sessionId: string, rec: ContainerIdentity): Promise<void> {
  try {
    const dir = containerIdentityRoot();
    await fs.mkdir(dir, { recursive: true });
    const dst = recordPath(sessionId);
    const tmp = `${dst}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(rec), { mode: 0o600 });
    await fs.rename(tmp, dst);
  } catch { /* bookkeeping only — never block a run */ }
}

/**
 * Note that `sessionId` just ran in container `container` whose docker id is
 * `id`. Returns the replacement when the id (or the container name) differs
 * from what we had on file, else null — including the first-ever call.
 *
 * A missing/blank input writes nothing and reports nothing: we never guess an
 * identity, because a guessed one manufactures a false replacement later.
 */
export async function recordContainerIdentity(
  sessionId: string, container: string, id: string, now: number = Date.now(),
): Promise<ContainerReplacement | null> {
  // Trim before the guard: docker inspect output (or a caller's slice of it) can
  // be whitespace, and a whitespace "id" would overwrite a REAL one and
  // manufacture a bogus replacement on the following run.
  const trimmedId = typeof id === 'string' ? id.trim() : '';
  const trimmedContainer = typeof container === 'string' ? container.trim() : '';
  if (!sessionId || !trimmedContainer || !trimmedId) return null;
  id = trimmedId;
  container = trimmedContainer;
  const prev = await readContainerIdentity(sessionId);
  const same = !!prev && prev.container === container && prev.id === id;
  if (same) return null; // unchanged — leave the record (and its seenAt) alone
  const replacement: ContainerReplacement | null = prev
    ? {
        container,
        previousId: prev.id,
        previousSeenAt: prev.seenAt,
        replacedAt: new Date(now).toISOString(),
      }
    : null; // first-ever sighting: nothing to compare against
  await writeIdentity(sessionId, {
    container,
    id,
    // A replacement starts this id's clock now; the first sighting keeps `now` too.
    seenAt: new Date(now).toISOString(),
  });
  return replacement;
}

/**
 * Drop the record. Called on a DELIBERATE teardown (recycle / idle reap /
 * age reap / session delete): the harness caused that swap and already tells
 * the lane in the same breath (the disk-guard note), so the next run must
 * register fresh instead of reporting a "replacement" nobody needs to react
 * to. A swap the harness did NOT cause (deploy wave, host reprovision) never
 * passes through here, so it still reports.
 */
export async function forgetContainerIdentity(sessionId: string): Promise<void> {
  if (!sessionId) return;
  try { await fs.rm(recordPath(sessionId), { force: true }); } catch { /* best-effort */ }
}

/** Short form of a docker id for a message (docker's own 12-char convention). */
const shortId = (id: string): string => (id || '').replace(/^sha256:/, '').slice(0, 12) || 'unknown';

/**
 * The lane-facing notice. ONE canonical string, shared by the run-start system
 * message and the mid-run exec note, so a lane recognizes the event either way.
 * Pure — exported for tests and both call sites.
 */
export function containerReplacementNotice(r: ContainerReplacement): string {
  const prev = shortId(r.previousId);
  return `[coding container: THIS SESSION'S CONTAINER WAS REPLACED — detected ${r.replacedAt} (previous container id ${prev}, first seen ${r.previousSeenAt}). A deploy/restart wave or a host reprovision swapped the container your shell runs in. Anything you started INSIDE it is GONE: background processes you launched (start_background_process handles, generators, long probes, watchers) are dead, and container-local files (/tmp, the writable layer) are gone — a job they were writing stopped at whatever it had written. NOT lost: the git worktree and $DIGBY_ENV (a worktree file). NOT SAFE — your LIVE $HOME: the shell's HOME is /tmp (the writable layer) unless this session runs with a scoped home on the workspace volume, so a CLI you installed into the live home — including $HOME/.local/bin and $HOME/bin when HOME=/tmp — went with the container, and only image-shipped bins (/usr/local/bin, e.g. tssh, tcurl) and the worktree survived. A tool that answers 'command not found' (exit 127) is this, not a broken PATH: re-check it with 'command -v <tool>' and reinstall it before relying on it. Your SSH identity went the same way (ticket d9ed0c1f): ssh resolves ~ from the passwd row, and this session's row is pw_dir=/tmp, so ~/.ssh IS /tmp/.ssh — any keys, config and known_hosts an earlier container established are gone, so a box deploy fails as 'Host key verification failed' (plain ssh) or 'Cannot stat /tmp/.ssh/known_hosts' (an rsync/scp-over-ssh deploy) instead of connecting. The target host is usually fine; the CLIENT lost its identity. NEVER answer that by weakening host-key checking (StrictHostKeyChecking=no, UserKnownHostsFile=/dev/null, or piping ssh-keyscan into known_hosts): re-establish the identity instead. The key survives a swap only if it lives in the WORKTREE, and the ONE sanctioned place for it there is .digby/secrets/ — already git-excluded, so it never reaches a commit; a private key dropped anywhere else in the tree can be swept into one by the checkpoint/reaper git adds. Prefer the keyless route where it exists (scripts/framework-audit/run-on-box.sh reaches the boxes through SSM with no key at all), and re-add the host key from a channel that is NOT the connection itself (the box fingerprint the owner or a provisioning run recorded), comparing it before you write it. Before relying on anything an earlier run produced, RE-CHECK it (ls / wc -l / a count query) instead of assuming it completed, and if a job supports resume-from-partial, relaunch it with the count you can actually see.]`;
}