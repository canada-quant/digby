# Tailnet failover runbook (coding sessions)

> Added 2026-08-28 (owner-steered platform task) after the tt-quietbox wedge
> window (03:03–03:37Z): control plane "connected", data path dead, and the
> session had zero recourse — `kill -TERM` on the root-owned tailscaled was
> EPERM from uid 1001. Audience: coding-session agents first, owner second.

## 1. Diagnose WHICH side failed before touching anything

| Side | Signature | Recourse (in order) |
|---|---|---|
| **Session side** — our dev container's tailscaled | `tailscale status` in-session fails or stays non-Running; netcheck shows `UDP: false` or no DERP; ALL peers unreachable | 1. `restart_dev_tailnet` platform tool (mid-run-safe; see §2) · 2. Same bounce via the API route — `POST /api/crossmodel/coding/dev-container/tailnet/restart` (owner JWT; there is NO Settings-UI button for the tailnet-only restart) · 3. Full dev-container Restart (Settings UI — refuses while a run is in flight) |
| **Target side** — the remote box's tailscaled | Session netcheck HEALTHY (`UDP: true`, DERP <20 ms), other same-owner nodes online, but ONE target: `tailscale ping` "no reply" + ssh `502 Bad Gateway / connect timeout` | A. Site-side LAN hop (§3) · B. Owner power-cycle / on-site `systemctl restart tailscaled` · C. Wait for the box's own watchdog |

The 2026-08-28 rule: run your own end's cheap recourse FIRST to rule it out,
THEN declare the target wedged — never the other way around.

## 2. Session-side recourse (what shipped tonight)

- **Boot respawn loop**: every dev container created after this change runs
  tailscaled under a pid-guarded respawn loop (`/tmp/digby-ts-loop.pid`) — a
  crashed/exited daemon self-heals in ≤2s with the same flags, no container
  restart needed. (A hung-but-alive daemon never exits, so the loop never
  fires on a pure wedge — that case is the restart tool's job, next bullet.)
  The guard (`kill -0` on the pidfile) keeps docker-start
  re-runs of the boot script from stacking a second loop.
- **`restart_dev_tailnet` platform tool / API route**: bounces ONLY tailscaled
  inside the caller's own dev container. It is **mid-run-safe by design** — no
  container rm, no exec interruption (in-flight ssh sessions die with the
  daemon, but a dead path has none worth keeping). Implementation: one root
  `docker exec` captures the live cmdline, TERM→3s→KILL, lets the respawn loop
  win when present, otherwise re-execs the captured (or posture-fallback)
  command; then verifies `BackendState: Running` for up to ~60s and returns the
  dev-container status JSON. Works on pre-loop containers too (verbatim re-exec).
- Honest limit: `restart_dev_tailnet` answers "is it MY end?" — it cannot fix
  a target whose OWN tailscaled is wedged. That is §3.

## 3. Target-side wedge: the site-side LAN hop

**Prerequisite (OWNER-ACTION, one-time):** a stable, always-on tailnet node on
the same LAN as the protected boxes. **LIVE since 2026-08-28:**
`cql-stanne-amd-server-1` (100.64.0.1, linux, same site as tt-quietbox) is
joined and online — verified `tailscale ping` from `digby-dev` on 2026-08-28
(DERP-relayed pong ~70–270 ms; a direct path is NOT required for an emergency
hop). When e.g. `tt-quietbox`'s tailscaled wedges but the box itself is up:

```sh
tssh cql-stanne-amd-server-1         # tailnet to the site node (it stays up)
ssh root@<tt-quietbox-LAN-IP>        # hop over the LAN — tailscaled not involved
systemctl restart tailscaled         # on the wedged box
```

Naming gotcha (verified 2026-08-28): magic DNS resolves only FULL machine names
— `tssh cql-stanne` or `tailscale ping tt-quietbox` fail with `no such host`;
the quietbox's machine name is `cql-stanne-tt-quietbox2` (its host name is
`tt-quietbox`). `tailscale status` first column = the name to use.

If the site node is ever absent/down there is NO out-of-band path to a wedged
box — the only recourse is the box's own watchdog or an owner power cycle.
(2026-08-28 03:03–03:37Z: exactly this — owner-directed box ops blocked ~35 min.)

## 4. Enabling the shared dev container (owner, one-time)

1. Settings → Coding → credentials: set `TS_AUTHKEY` — a **tagged, reusable**
   tailscale auth key (tagged so node identity is stable; reusable so re-joins
   don't burn a new key). Recommended rotation: 90 days.
   **No-key alternative (feedback 0bd05198, shipped 2026-08-29):** if the
   container boots with no key and no persisted ts-state identity, the boot
   script runs an interactive `tailscale up --timeout=30s` instead — the login
   URL lands in `/tmp/ts-up.log`, the status endpoint surfaces it, and
   Settings → Coding shows a "click to approve the node" link. Approve in the
   admin console once, then **tag the node** (tagging disables its key
   expiry — this is the answer to "auth keys expire in 90 days": the URL-flow
   node never depends on an auth key again). A fresh link appears after any
   container restart while the node is unauthorized.
2. Settings → Coding → enable the shared tailnet dev container (admin accounts
   only in v1, until the per-user volume layout ships — ticket 4ed6eb2e).
3. Verify: Settings shows `running` + tailscale `Running`, and the `digby-dev`
   node appears in the tailnet admin console.
4. Per-session containers remain the automatic FALLBACK whenever the dev
   container can't come up or can't join — enabling can degrade, never break,
   a session.

> Status (verified 2026-08-28): the shared container is ENABLED for the owner
> account — `digby-dev` at 100.64.0.1 joined and `Running`, TS_AUTHKEY
> configured, and a `restart_dev_tailnet` bounce re-joined cleanly. Remaining
> owner-console items: confirm the key is **tagged `tag:digby-dev`**, reusable
> and non-ephemeral (tagging the node also disables its key expiry — the
> 90-day expiry worry applies to the AUTH key, which the persisted ts-state
> almost never needs again), and delete the stale duplicate machine entry
> `digby-dev-2` (left by an earlier re-provision).

## 5. Invariants (do not regress)

- Session execs run as uid 1001; tailscaled runs root-owned — sessions must
  NEVER need raw kill signals (the original EPERM pain).
- `DIGBY_TAILNET_PROXY` is opt-in per command (`tssh`/`tcurl` helpers), never a
  global `ALL_PROXY` (a degraded tailscaled must not take every curl/git down).
- The auth key is delivered out-of-band, consumed, and deleted; uid-1001 shells
  can never read it or the node key (root 0600/0700).
- Node identity persists under the workspace volume (`devcontainers/<uid12>/ts-state`) —
  re-joins after redeploys/reaps do not consume new machine entries. A duplicate
  `digby-dev-N` machine entry in the admin console means a re-join consumed a NEW
  identity (ts-state mount skipped, or a manual recreate) — investigate before
  entries proliferate; stale entries are owner-removed in the console.

## 6. Container-user caveats (uid 1001)

- **openssh client fatals `No user exists for uid 1001`** (ticket db587fc1):
  session execs run as uid 1001, which originally had NO `/etc/passwd` entry, and
  the openssh CLIENT requires one and aborts before connecting.
  **The platform provisions the row itself since a6051a82 (dev container) and
  e2f40d10 (per-session containers):** `ensureSessionUserRow` runs an idempotent,
  `getent`-guarded script as root on every per-session container entry point, so a
  fresh or re-provisioned container has uid/gid 1001 before any command runs. A
  container created before that fix heals on next use.
  If you still hit the fatal, the container was NOT provisioned by the platform
  path (e.g. hand-started) — add the entry from a root exec
  (`docker exec -u 0 <container> sh -c "echo 'digby:x:1001:1001::/tmp:/bin/bash' >> /etc/passwd"`).
  Do **not** hand-compile a `getpwuid` `LD_PRELOAD` shim into `/tmp/digby-proc/uidshim.so`:
  a re-provisioned container dangles that preload, and a dangling `LD_PRELOAD` is
  only an ld.so warning (`cannot be preloaded … ignored`), never the cause of the
  fatal — the missing passwd ROW is.
- **A re-provisioned session container is recovered, but the command is NOT re-run** (ticket e2f40d10):
  if the container is replaced mid-run, the executor recognises the daemon's
  `No such container` on the FIRST attempt and re-provisions, so the rest of the
  firing has a working shell. **It does not re-execute that command** — you get an
  explicit `THIS COMMAND DID NOT RUN` note and must re-issue it yourself (it is
  safe to: the exec provably never started, so nothing was double-applied). This
  is deliberately the narrower contract: only the disk-full SPAWN failure is
  auto-retried, because anything that actually ran may have partially completed.
  The lane is told container-local state — background processes, `/tmp`, unbaked
  tooling — did not survive; the worktree on disk is untouched. Fires only on
  docker's own error text at the start of stderr, never on a command that ran.
- **After `restart_dev_tailnet`, read the socket/ports from the tool result**
  instead of assuming defaults: the returned `tailscale.socket` /
  `socks5` / `httpProxy` are the daemon's actual CLI socket and per-posture
  proxy ports. If the default CLI socket lags behind a fresh daemon, point the
  CLI explicitly (`tailscale --socket=<socket> status`) and route proxies via
  the returned ports — do NOT hand-roll a second tailscaled on ad-hoc
  socket/state paths (that is how the 2026-08-30 `digby-recovery` duplicate
  node appeared: two daemons, split-brain state, dead default socket).
