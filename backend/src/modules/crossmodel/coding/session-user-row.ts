/**
 * The uid-1001 passwd/group rows every session-exec container needs (ticket
 * e2f40d10; originally ticket a6051a82 / PR #1482 for the dev container).
 *
 * Session execs run as `--user 1001:1001` (container.service BASE_CREATE) so
 * runner commits write backend-owned objects into the shared volume. A stock
 * runner image (the `node:20` default) has NO passwd row for uid 1001 — only
 * 1000/noddy — so `getpwuid(1001)` returns NULL and every getpwuid-based
 * program dies at startup. openssh is the one that matters operationally:
 *
 *     ssh: No user exists for uid 1001
 *
 * which took the whole tailnet box path away from a lane (its probes failed,
 * and lanes had taken to compiling a getpwuid LD_PRELOAD shim into
 * /tmp/digby-proc/uidshim.so — a re-provisioned container then dangles that
 * preload; a dangling LD_PRELOAD is only an ld.so warning, so the missing
 * passwd ROW is the fatal half).
 *
 * ONE source of truth for the dev container (boot script + live ensure) and
 * per-session containers (container.service ensureSessionUserRow). Leaf
 * module on purpose: container.service must not statically import
 * dev-container.service (that module already imports container.service) and
 * must not drag in config/env through it.
 *
 * Idempotent by construction — each line is a `getent` guard, so running it
 * repeatedly on a container that already has the rows is a no-op.
 */
export const SESSION_USER_SCRIPT = [
  "getent passwd 1001 >/dev/null 2>&1 || { N=digby; grep -q '^digby:' /etc/passwd && N=digby1001; echo \"$N:x:1001:1001:Digby session:/tmp:/bin/bash\" >> /etc/passwd; } || true",
  "getent group 1001 >/dev/null 2>&1 || { G=digby; grep -q '^digby:' /etc/group && G=digby1001; echo \"$G:x:1001:\" >> /etc/group; } || true",
].join('\n');