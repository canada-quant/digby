# Tailnet Dev Container — Follow-ups: Per-User Volume Layout, Gate Lift, ACL Scoping

> **Ticket:** 4ed6eb2e (amended scope per owner brief dbfe28c3)
> **Status:** design-only — NO code changes, NO migration files in this PR
> **Status update (2026-08):** Part 3(b) landed as per-session egress scoping
> (ticket 4ed6eb2e, dev-container.service.ts); Parts 1-2 still pending.
> **Date:** 2026-08-24
> **Builds on:** PR #326 (shared tailnet dev container v1, ticket 3ba5d35d) + hardening
> 441b51ac; PR #341 (tssh/tcurl helpers d3a983ca, prebuilt `CODING_DEV_IMAGE` 793f5130).
> v1 shipped **admin-only**; this document designs the three follow-ups that lift that gate
> safely.

---

## 1. Current state (v1 as-built)

### 1.1 One shared dev container per user

`backend/src/modules/crossmodel/coding/dev-container.service.ts` (line references
removed — they drift; navigate by function name):

- `devContainerName(userId)` → `digby-dev-<uid12>` (first 12 chars of user id).
- `ensureUserDevContainer(userId)` — ensure→`null` contract: any failure returns
  `null` and the caller falls back to per-session containers; it never throws. Flow:
  1. Gate: `devContainerEnabled(userId)` + `isDockerAvailable()`.
  2. 20 s per-process health memo (`healthyMemo`, `HEALTH_MEMO_MS = 20_000`).
  3. Running → return name. Stopped → `docker start` + `markDevGitSafe` (persistent ts-state
     re-joins without a key).
  4. Auth key read: `getCredentialValueDecrypted(userId, 'tailscale', 'TS_AUTHKEY')`.
  5. Pre-create `devcontainers/<uid12>/ts-state` on the workspace volume, then mount it
     `--mount type=volume,source=<VOL>,target=/var/lib/digby-tailscale,volume-subpath=devcontainers/<uid12>/ts-state`.
     Docker refuses missing volume subpaths, hence the backend-side `mkdir`.
  6. No key AND no persisted state → `null` (a container that can never join is never created).
  7. Create is Redis-locked (`acquireCreateLock`, `SET NX EX 300`); lock held by
     another process → poll up to 90 s and **adopt** the winner; `docker run` name-conflict →
     adopt, never `rm -f`.
  8. `createArgs`: `--label digby.dev.container=<userId>`, `--init`,
     **`-v <VOL>:<CODING_WORKSPACE_ROOT>` — the whole workspace volume**, `-w <ROOT>`,
     `--memory <CODING_DEV_CONTAINER_MEMORY || '12g'> --cpus 4` (raised from `4g` —
     ticket db25c401: co-tenant verify chains OOM-SIGKILLed at the 4 GiB ceiling;
     `ensureDevMemoryCeiling` additionally live-GROWS running legacy containers via
     `docker update --memory`, grow-only), `--network bridge`, `DEV_IMAGE()` (`CODING_DEV_IMAGE` ||
     `CODING_RUNNER_IMAGE` || `node:20`), `bash -lc bootScript()`.
  9. `volume-subpath` unsupported (Docker < 25) → `rm -f` + retry once without the state mount.
  10. Key delivered out-of-band via stdin → root-owned `0600 /run/secrets/ts_authkey`
      (`deliverAuthKey`) — never argv/env.
  11. **Verified join:** `verifyTailnetJoin` polls `tailscale status --json` until
      `BackendState === 'Running'` (60 s default, 3 s poll). Failed join →
      `rm -f` + `null`. Running ≠ joined.

- `bootScript()` runs as **container root**: installs tailscale + `netcat-openbsd`
  (skipped when baked into `CODING_DEV_IMAGE` — `docker/dev-image/Dockerfile`, PR #341), writes
  the `tssh`/`tcurl` helpers (d3a983ca), chowns `${TS_STATE_DIR}` (`/var/lib/digby-tailscale`)
  to `0:0 0700`, starts **userspace** tailscaled as uid 1001 (never root), and drops to uid 1001
  for the session. Session execs are uid 1001, never root.

### 1.2 Workspace layout today

The single workspace Docker volume (`CODING_WORKSPACE_VOLUME`) is mounted **whole** at
`CODING_WORKSPACE_ROOT` into the per-user dev container. Its top-level layout is flat and
**cross-tenant**: every user's sessions, worktrees, and repo mirrors live as siblings under one
root (e.g. `worktrees/<sessionId>`, `mirrors/<repo>`, `devcontainers/<uid12>/ts-state`,
`uploads/`, etc.). `worktreePath(sessionId)` and `repoMirrorPath(...)` resolve under that shared
root with no per-user namespacing.

### 1.3 The admin-only gate

`devContainerEnabledTriState(userId)` (dev-container.service.ts) returns enabled only when the
user is an admin AND the `devContainerEnabled` pref is on. Rationale: the shared container mounts
the whole workspace volume, so a non-admin user's dev container would see **other users'**
worktrees/mirrors — a cross-tenant read/write breach. Hence the gate.

---

## 2. Problem statement (tenant isolation)

To lift the admin-only gate we must guarantee a user's dev container can only ever observe that
user's own data. Today that guarantee does not exist because the container mounts the entire
shared volume. The fix is structural: move to a **per-user subtree** on the workspace volume and
mount only that subtree (plus the user's ts-state subpath) into the user's dev container.

Part 1 (per-user volume layout) is therefore the **prerequisite** for Part 2 (gate lift). Part 3
(per-session ACL scoping) is independent and may land later.

---

## 3. Part 1 — Per-user volume layout

### 3.1 Target layout

Introduce a per-user namespace on the workspace volume:

```
<ROOT>/users/<uid12>/
    worktrees/<sessionId>/...        # this user's session worktrees
    repos/<projectId>.git/...        # this user's repo mirrors (keyed by projectId — see 3.4)
    uploads/...                      # user-scoped attachments (re-homed — see 3.3 step 6)
    devcontainers/<uid12>/ts-state   # tailscale state (existing)
```

The dev container for user U mounts **only** `users/<uid12>` via a volume-subpath mount — and,
critically, at its **same absolute target** (`<CODING_WORKSPACE_ROOT>/users/<uid12>`), not at the
container workspace root. This preserves the host↔container absolute-path identity the codebase
relies on (review finding B1 — see below). Top-level shared dirs (`worktrees/`, `repos/`,
`uploads/`, other users' `users/<uid12'>/`) are simply **not mounted** — they do not exist inside
the container at all. `worktreePath`/`repoMirrorPath` resolve under `users/<uid12>/...` for ALL
sessions of that user (dev-container and per-session fallback alike — see 3.5).

### 3.2 Mount change

In `createArgs` (lines 271–283), replace the whole-volume mount with a subpath mount **at the same
absolute target as on the host** — the `scopedMountArgs` pattern from
`container.service.ts:197–224` ("KEEPING the original absolute path so git worktrees … keep
working"):

```
--mount type=volume,source=<VOL>,target=<CODING_WORKSPACE_ROOT>/users/<uid12>,volume-subpath=users/<uid12>
```

Why the target matters (review finding B1): mounting `users/<uid12>` **at `<ROOT>`** instead would
break every session exec and every git op, because the backend and the container would hold two
different absolute roots for the same files:

- Session execs run `docker exec -w <session.worktreePath>` (`container.service.ts:372`, cwd from
  `run-executor.ts:455`). The stored path is `<ROOT>/users/<uid12>/worktrees/<sid>`; if the
  subtree were mounted at `<ROOT>` itself, that path would not exist in-container.
- Worktrees are created host-side (`workspace.service.ts:337,603`), so `<wt>/.git`'s `gitdir:`
  line and the mirror's `worktrees/<name>/gitdir` store host-layout absolute paths. Under a
  shifted mount those pointers dangle and `isUsableWorktree` fails
  (`workspace.service.ts:568–589`) — every session is treated as broken.

With the same-target mount, `<ROOT>/users/<uid12>/worktrees/<sid>` resolves identically on both
sides, and `-w <CODING_WORKSPACE_ROOT>` (line 279) remains valid (the directory exists; Docker
creates the mount-target parents). Keep the ts-state subpath mount (already per-user, same
pattern). Pre-create `users/<uid12>/worktrees`, `users/<uid12>/repos`,
`users/<uid12>/uploads`, `users/<uid12>/devcontainers/<uid12>/ts-state` backend-side before
`docker run` (same pattern as the existing ts-state pre-create at lines 246–252).

### 3.3 Backward compatibility / migration of existing per-user volumes

Existing sessions (created before the layout change) have worktrees at the flat
`worktrees/<sessionId>` and mirrors at `repos/<projectId>.git`. A naive rename is NOT safe
(review finding B2): the `.git` file's `gitdir:` line and the mirror's
`worktrees/<name>/gitdir` are absolute paths that would dangle (the code then treats the
worktree as broken and re-provisions, `workspace.service.ts:568–589`), and
`chatCodingState.worktreePath` would point at the old location (next run: "Workspace missing on
disk", `run-executor.ts:130`). Migration is therefore an ordered, quiesced procedure run on
first dev-container ensure for a user after the change:

1. **Quiesce check.** Verify no `agent_runs` in a running/claimed state exist for ANY of the
   user's sessions (their per-session containers may hold scoped mounts into the very tree being
   renamed). If any are live, skip migration and retry on a later ensure — never rename under a
   live mount (`container.service.ts:211–224`).
2. **Lock.** Take the same Redis create lock used for container creation (`acquireCreateLock`,
   lines 198–208) so a racing ensure cannot interleave.
3. **Worktrees.** For each legacy `worktrees/<sid>` owned by the user (session→user join via the
   session record): rename to `users/<uid12>/worktrees/<sid>` (same volume, metadata-only), then
   repair the git link — `git worktree repair` (or rewrite the two pointer files: `<wt>/.git`'s
   `gitdir:` line and the mirror's `worktrees/<name>/gitdir`) — then update
   `chatCodingState.worktreePath` for that session in the same operation.
4. **Mirrors.** Mirrors are keyed by **projectId** (`repoMirrorPath(projectId)`,
   `workspace.service.ts:109–111`), so ownership must be proven by a **project→user** join
   (project owner === userId), NOT the session join. For each owned `repos/<projectId>.git`:
   rename to `users/<uid12>/repos/<projectId>.git` and apply the same pointer repair.
5. **Consistency.** The per-session container path (non-dev-container fallback) and the dev
   container both resolve paths through the single `workspaceLayout` helper (3.5), so
   post-migration paths resolve identically for both container kinds — no divergent layouts.
6. **Uploads.** `uploads/` is a top-level shared dir today and would simply not exist inside a
   dev container (only `users/<uid12>` is mounted). Re-home per-user attachments to
   `users/<uid12>/uploads` with the same quiesced rename discipline, and scope-mount it at the
   same absolute target when a session needs it.
7. **Failure semantics.** Any failure mid-procedure logs and leaves the user on the v1
   whole-volume path (ensure→null → per-session fallback) — a migration hiccup degrades to v1,
   never breaks a session.

### 3.4 Shared vs per-user mirrors

Repo mirrors are expensive to clone. Options:

- **(a) Per-user mirrors** (simplest, fully isolated): each user gets their own mirror under
  `users/<uid12>/mirrors`. Costs disk per user per repo.
- **(b) Shared read-only mirror + per-user worktrees**: a single shared mirror mounted read-only
  into every dev container; worktrees (writable) stay per-user. Saves disk; requires the mirror
  mount to be strictly read-only and the worktree to never write back to the shared mirror.

**Recommendation:** start with (a) per-user mirrors for correctness and isolation; evaluate (b)
as a later disk optimization behind a flag.

### 3.5 Single source of truth for paths

Add a `workspaceLayout` helper that, given a session's owner, returns the per-user root
(`users/<uid12>`) and derives worktree/mirror/uploads paths from it. Because mounts preserve
host↔container absolute-path identity (3.2), the helper returns **one** absolute path used
verbatim on both sides — no dual-root translation. Both the dev-container mount logic and the
per-session container spawn logic consume this one helper so the two paths can never diverge
(the 2026-08 divergence lesson).

---

## 4. Part 2 — Lifting the admin-only gate

Once Part 1 lands, the cross-tenant breach the gate guards against is closed structurally. The
gate change:

- `devContainerEnabledTriState(userId)` drops the admin check; enablement becomes purely
  pref-driven (`devContainerEnabled` per-user pref) plus server availability (`isDockerAvailable`).
- Settings UI (`account/CodingTab.tsx`) removes the admin-only visibility/lock on the toggle.
- Rollout: keep a server-side kill switch (env `DEV_CONTAINER_OPEN_TO_ALL=false` default) so the
  gate can be re-tightened without a deploy; flip to `true` after Part 1 is verified in prod. The
  env var is read at ensure time (not memoized) so an ops override takes effect on the next ensure
  without a process restart; the per-user pref still gates each user individually, and
  `DEV_CONTAINER_OPEN_TO_ALL=false` restores v1 admin-only behavior exactly.
- The per-session container fallback path is **unaffected** by this change: it already uses
  `scopedMountArgs` (worktree + project mirror only, git-self-verified,
  `container.service.ts:207–227, 316–331`) with its own legacy whole-volume fallback; the admin
  gate only governs the shared dev container. Part 1 narrows the dev container to the same
  per-user blast radius the scoped mounts already enforce for per-session containers.

---

## 5. Part 3 — Per-session tailnet ACL scoping

v1 shares one tailnet identity (one auth key / one node) per user. Per-session scoping options:

- **(a) Tagged child nodes per session:** each session's exec joins the tailnet as a separate
  ephemeral node tagged per-session; ACLs in the tailnet policy restrict by tag. Requires
  per-session auth keys (ephemeral, tagged) issued via the Tailscale API (OAuth client /
  `POST /api/v2/tailnet/{tailnet}/keys` with `capabilities.createKeys` and `tags`). Adds API
  dependency + key lifecycle management.
- **(b) Single per-user node + app-level scoping:** keep one node per user; enforce per-session
  reachability in the app (the proxy/allowlist the session is permitted to use) rather than at
  the tailnet layer. Cheaper; scoping is advisory (app-enforced), not network-enforced.
- **(c) Tailnet ACL policy via the Tailscale API:** push per-session ACL rules into the tailnet
  policy document. Strongest isolation; highest complexity and blast radius (edits the shared
  tailnet policy).

**Recommendation:** (b) for the near term — app-level per-session scoping over the existing
per-user node, with (a) tagged ephemeral child nodes as the network-enforced upgrade once the
key-issuance path (OAuth client in credentials) is built. Defer (c).

---

## 6. Risks and rollout order

1. **Part 1 first** (per-user volume layout) — the tenant-isolation prerequisite. Deploy behind
   the existing per-user pref; verify a non-admin user's dev container sees only their subtree.
2. **Part 2 second** (gate lift) — flip `DEV_CONTAINER_OPEN_TO_ALL` after Part 1 prod-verified.
3. **Part 3 later** (per-session scoping) — independent; app-level (b) first.

Risks: migrating live worktrees under running sessions (do it on ensure, not on a timer);
disk growth from per-user mirrors (3.4); Docker < 25 subpath support (already handled by the
existing retry); the kill-switch default keeping the gate closed until Part 1 is proven.

---

## 7. What this PR does NOT do

- No code changes; no Prisma migration files; no Docker/dev-image changes.
- No Tailscale OAuth client / key-issuance implementation (Part 3 recommendation only).
- No retroactive migration of legacy tickets or other users' data beyond the Part-1 on-ensure
  per-user move described in 3.3.
- Does not flip `DEV_CONTAINER_OPEN_TO_ALL`; the gate lift is a separate, later action.
