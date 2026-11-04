# Digby Code — Agent Harness & Scaffolding

> **Gate flip 2026-09-11 (owner: "get the framework back operating at full steam").**
> Every harness gate below that blocked, withheld, REPLACED/REDACTED, or staged an
> owner confirmation on a machine lane's own work is now **observe-only / default-off**
> — detection still runs and records `loop_metrics` (`guard_strike`/`guard_miss`
> rows with `meta.outcome:'observed'`), the run's ORIGINAL final is delivered with the
> guard's notes appended, and nothing is bounced or paged. Where this document
> describes REPLACE / reject-back / refusal behaviour, read it as **enforce-mode**,
> re-armed per gate by the opt-in envs listed in `.env.example` (`EVIDENCE_GUARD_ENFORCE`,
> `QUOTE_GUARD_ENFORCE`, `ZERO_TOOL_GATE_ENFORCE`, `OUTBOUND_CLAIM_AUDIT_ENFORCE`,
> `RUN_DEADLINE_ENABLED`, `NUMERIC_PROVENANCE_ENABLED`, …). Canonical table:
> `AGENTS.md` §Gate defaults. Kept as-is: credential scans, destructive-action
> confirmations, and the deterministic self-merge gates G1 pr_state / G2 ci / G4 secret_scan.

How Digby Code scaffolds a new coding project and the framework that grounds the
agent. Derived from a deep audit of the SOTA agentic-coding tools (Claude Code,
OpenAI Codex, Cline, Cursor, opencode, aider, Amp), adapted to Digby Code's exact
capabilities and its **open-source drivers** (GLM-5.3 / DeepSeek V4.1 Flash / Kimi K3),
which reward explicit, deterministic instruction over inferred intent.

## Design principles

1. **Lean + project-specific.** `AGENTS.md` is re-injected into every session and
   the drivers have small effective context, so the per-project file holds ONLY
   what is specific to this repo. Invariant doctrine (tool protocol, permission
   modes, safety, subagent/memory mechanics) lives ONCE in the global **Digby
   defaults** system prompt — never restated per project.
2. **Ground truth, not guessing.** Stack + commands are detected by INSPECTING
   manifests/lockfiles, never LLM-freeform-generated (freeform measurably reduces
   task success). A wrong command line is worse than none.
3. **Honest about enforcement.** We distinguish what is deterministically ENFORCED
   from what is MODEL-FOLLOWED prose, and never claim a gate that isn't wired.

**Framework signal sweep** (`framework-signal-sweep`, hourly, DB-only): files deduped `bug_report` tickets when a marker would survive the chat renderer's cleaning, an owner card asks for steps or a paste AND both the old length rule (context column under 40 chars) and the platform's own payload-gap check (`detectOwnerCardPayloadGaps`, the shared pure leaf `owner-card-gaps.ts`, observe-only at write time) find it incomplete — consoleAction cards are exempt structurally (their paste payload and click-by-click steps are composed into the question body, so an empty context column is by design; ticket 84b11946), any card whose background+options the payload-gap check finds — in the question body, the context column, typed options, a declared `yes_no` answer type, the flagger's own `optionalAsk` declaration on flag_owner_question (ticket 90a5b127: true completes the options axis by declaration, false suppresses the prose fallback), or the card's own SCOPE statement ("Nothing else is needed from you", "that's all", "One thing only you can supply" — an enumerated ask declares an EMPTY decision space; ticket 8f5989c7: clause-scoped, present-tense only, and it must CLOSE the ask — an object-restricted cue with a further ask outside that object, or any still-owed state after it, voids the closure) — is complete by the same definition the write-time metric uses (tickets 65cfec1b, 90a5b127) — and since ticket a3a7dd88 the axis scopes differ per signal: a consoleAction body or TYPED OPTIONS complete BOTH axes (background included) by declaration, while a `yes_no` answer type or `optionalAsk:true` completes the OPTIONS axis only — the background axis still needs a background cue or the context column, so a cue-free yes_no/optional-ask card remains a designed true positive — and an explicitly-optional ask ("No rush — the core service is fully live without them", "up to you", "no need") satisfies the options axis the same way when its wording governs the ask clause: the stated decline path IS the decision space (tickets cea10fa4, 90a5b127) — or an admin message reads as frustration the last answer missed. Only renderer-backed markers are flagged (`SEND_EMAIL` / `CANVAS` / `FOLLOWUPS` — ticket d6fdc1df; `[HARNESS …]` blocks, `[SECRET n]` handles and `[REDACTED…]` placeholders are ordinary text), and log signals are owned solely by the log-signal sweep. The `CANVAS` leg's `stripForStorage` copy carries ALL THREE of the renderer's rules (`plain-session.ts` L33-35) since ticket 868902f9 — including the UNTERMINATED `[CANVAS…]` opener, which the renderer deletes to end-of-string; before that the detector kept text the user never sees and filed `raw-marker:CANVAS` for a truncated turn whose tail merely read "…the draft contains no [CANVAS] or". After the rule no CANVAS opener reaches the scanner at all; a stray `[/CANVAS]` closer does render visibly and still fires. Kill switch `FRAMEWORK_SIGNAL_SWEEP_DISABLED=1`.

> ⚠ STALE (2026-10-19, ticket 8d7d07b0): the raw-marker leg's `displayedAfterRenderer` mirror
> (framework-signal-detectors.ts) predates the SEND_EMAIL renderer fix of ticket 8d7d07b0, which made the
> renderer quote-aware and `[`-bounded in SEND_EMAIL tag attrs (a `to="[recipient — see my note below]"`
> placeholder or a bracketed `subject="Re: [Action required]"` now parses to an editable card instead of
> failing), cut markup as source-coordinate display CUTS (card block whole; a no-card block keeps its BODY
> as prose with only its tags cut; a broken opener neither bounded scan closes cuts to end-of-text, as
> `stripLiveTags` does live; a bare-words `[send_email docs](…)` link label is text), and removed raw
> markup from every parseEmailDraft/extractEmailFromParts path. The detector still mirrors the PRE-fix
> renderer, so its `unclosed`/`no valid to` SEND_EMAIL findings are now over-inclusive w.r.t. what the
> user actually sees. Re-aligning the mirror is a detector relaxation (it would stop pinned true positives
> from firing) and needs owner review — ticket 8d7d07b0 holds that decision.

## What Digby scaffolds on project create

On the first worktree provision of a project (`provisionWorktree` →
`ensureProjectDocs` → `scaffoldProjectDocs`), if the repo has no `AGENTS.md`/`.digby`:

| File | Role | Loaded |
|------|------|--------|
| `AGENTS.md` | Lean, project-specific agent guide (open standard) | Always, every session |
| `.digby/config.json` | Machine-readable commands + verify chain (source of truth) | On demand |
| `.digby/notes/learnings.md` | Durable, git-committed learned conventions | When non-empty |
| `.digby/README.md` | Explains the `.digby/` layout | On demand |
| `.digbyignore` | Discovery/index + secret-read exclusions (allows `.env.example`) | — |

`AGENTS.md` sections: **Overview** (what/why + stack with versions) · **Environment**
(ephemeral container, fresh branch off default, missing git tools) · **Commands**
(detected, labelled "verify before relying") · **Structure** · **Conventions** ·
**Done means verified** · **Project boundaries** · **More context**.

### Behaviour

- Repo already ships `AGENTS.md` → **respected, never clobbered**; only the `.digby`
  framework is added alongside it.
- Repo has both `AGENTS.md` and `.digby/` → no-op.
- Everything is best-effort: any failure is logged and swallowed so a session still
  reaches `ready`.

### Docs health (staleness detection + safe refresh)

`ensureProjectDocs` is the ONLY correct provision-time entry point (scaffold →
assess → refresh) and runs on every provision path — `provisionWorktree` plus the
lazy `ensureRunnable` blank/reattach paths in `run-executor.ts`:

- New guides carry an invisible marker (`<!-- digby:scaffold v1 -->`); new configs
  carry `docsHash` (sha256 of `{stack, commands, verify}`). Together they tell
  "Digby still owns this — safe to regenerate" from "user-tuned — never touch".
- `assessDocsHealth` re-runs `detectStack` and diffs it against the recorded config
  (**direction-aware**: a detected-NULL command is never drift — monorepos with no
  root manifest don't false-positive against hand-maintained configs).
- `refreshProjectDocs` regenerates ONLY an untouched scaffold guide (marker +
  placeholders survive, or the legacy `to be decided` signature) and rewrites ONLY a
  hash-matched (or legacy all-null) config's `stack`/`commands`/`verify`/`docsHash`
  — preserving `loop`, `verified`, `defaultBranch`, `ignore`, `docsHealth`, unknown
  keys. Any command rewrite forces `verified:false`. Byte-identical output is never
  written; refresh lands as its own commit (`docs: refresh agent guide — …`).
- Hand-written guides + user-tuned configs are never rewritten: when their drift
  can't be auto-fixed, `buildAgentGuide` appends a `=== DOCS HEALTH ===` prompt
  block listing it (silence: `docsHealth.nudge=false`; hard opt-out:
  `docsHealth.autoRefresh=false`). Repos with no guide at all get a CREATE-path
  line in the system prompt.

## Digby defaults (global system prompt)

Relocated out of every per-project file into the agent's system prompt (`agent.ts`),
as short imperative bullets tuned for the open-source drivers:

- **Loop:** explore → plan → change → verify → commit.
- **Protocol:** discovery via grep/glob; read-before-edit; prefer `edit_file` over
  `write_file`; one change → verify → repeat; finish with a summary.
- **Permission modes:** plan (read-only) / ask (approve each mutation) / auto.
- **Safety (all modes):** no `rm -rf`, no force-push, no `reset --hard` over
  uncommitted work, no history rewrites, no `curl | sh`; never print/commit/exfil
  secrets; stay in the worktree.

The agent also loads the project's `AGENTS.md` + any `.digby/rules/*.md` +
`.digby/notes/learnings.md` (when non-empty) into context each turn (`buildAgentGuide`).

## Stack detection (implemented)

`detectStack()` reads manifests only (no execution):

- **Node/TS** — package manager from lockfile (bun/pnpm/yarn/npm); framework +
  versions from deps (Next/Nuxt/Remix/Nest/Express/Fastify/Vite/React/Vue/Svelte);
  commands from `scripts` (+ `tsc --noEmit` fallback for TS); Prettier/ESLint hints.
- **Python** — uv/poetry/pip; pytest; ruff (lint); mypy (typecheck, else omitted so
  the verify chain never lies about a dynamically-typed project).
- **Rust / Go / Ruby** — cargo / go / bundle command sets.
- **Makefile** — augments any stack with `test`/`lint`/`build` targets.

The verify chain is cheapest-first (`typecheck` → `lint` → `test`), including only
commands that actually exist.

## Harness primitives — GOAL / LOOP / MONITOR (implemented)

Distilled from a deep audit of Claude Code, Codex, Cursor, Cline, Amp, opencode,
aider, and the agent frameworks (ReAct / Reflexion / Plan-and-Execute / LangGraph),
tuned for the open-source drivers (which drift more than frontier models).

### GOAL — `update_plan` (`plan.service.ts`)
- ONE full-array-rewrite tool (no id-patching — weak models fumble ids): `update_plan({ goal?, acceptance_criteria?, steps:[{text,status,note?}], explanation? })`.
- goal + acceptance retained server-side when omitted; **server-enforced one in_progress** (normalize + echo, never hard-fail); 3–8 steps (cap 12).
- Canonical in the context store; mirrored to git-ignored `.digby/session/todo.md` (compaction lifeboat, subagent-visible).
- **The anti-drift lever:** the harness re-injects a compact `<plan>` reminder (goal verbatim + checklist + step-N/200 counter + rules) **every turn** — not a model-initiated read. Plus a reflection nudge on repeated/no-progress calls or every 8 steps.

### LOOP — `verify` tool + harness auto-verify (`verify.service.ts` + `agent.ts`)
- `verify({only?})` runs the cheapest-first chain (typecheck → lint → test) from `.digby/config.json`, fail-fast, per-stage results.
- **Harness auto-verify loop (AUTO mode):** on the model's clean finish, re-run the chain; on failure feed the failing stage's output back and resume with a bounded step budget. Guards: `maxAutoVerifyIterations` / `resumeStepBudget` (scaffolded configs ship **3/8** — `scaffolding.service.ts`; the code fallback `DEFAULT_LOOP` is **10/20** — `verify.service.ts`), no-progress (worktree diff-hash unchanged), oscillation (diff-hash reappears, window 4), repeated-failure (normalized `failureSignature` ≥2). On a guard trip it **reports honestly** rather than looping.
- **PR gate:** the agent's autonomous `open_pull_request` requires a verify pass on the current content — enforced only when a chain actually exists **and** `loop.gatePullRequest` (default **true**, `verify.service.ts`/`scaffolding.service.ts`). Since 2026-09-27 (audit A5) the gate is not a refusal loop: a docs-only diff (every file under `docs/` or `*.md`, branch-vs-merge-base ∪ dirty tree) skips the chain with a "docs-only, unverified" trailer in the PR body (`PR_DOCS_ONLY_BYPASS_DISABLED=1`), and an unpassed / stale state makes the tool run the chain itself and open on green — red still refuses with the failing stage's tail (`PR_GATE_AUTO_VERIFY_DISABLED=1` restores the plain refusal). The auto-verify is bounded by `PR_GATE_AUTO_VERIFY_DEADLINE_MS` (default 12 min, clamped ≤ 14 min — under the agent loop's 15-min tool hard abort, which does not cancel the tool): on expiry it refuses pointing at `verify` and nothing is pushed or opened, while the chain finishes behind it and records its result. An explicit `headBranch` that is not the checkout is never docs-only (the classification reads the worktree). A project with no runnable chain isn't gated (honest — don't gate what can't run), and the human "Open PR" button always bypasses it (`ctx.prGateBypass`). Commands are detected-not-probed, so a wrong detected command can only make verify fail loudly, never silently trap a session.
- **The pass is sha/tree-keyed (P5 v1#29):** `recordVerify` stores the HEAD sha plus a full-worktree content **tree hash** (throwaway `GIT_INDEX_FILE` `git add -A` + `write-tree` — tracked changes AND untracked non-ignored files, no side effects), and the gate re-fingerprints at open time. Committing exactly-verified content keeps the same tree and passes (the everyday verify → commit → PR flow); ANY new edit or new commit with different content blocks as **STALE** — mutation tools never clear anything, the comparison covers them. Legacy fingerprint-less states pass unchanged (fail-open on absence, fail-closed on mismatch). Kill-switch `VERIFY_SHA_GATE_DISABLED=1`.
- **UNVERIFIED outcome (P5 v1#30):** a chain that "passed" only because a stage tool is missing (exit 127 / "No module named X" → skipped) is now **unverified**: the tool result reads `Verify UNVERIFIED: …`, the receipt records `passed:false, unverified:true`, and the PR gate appends an UNVERIFIED note + records `guard_strike` seam `unverified_pr_gate` and opens the PR — CI on the PR is the verification of record (gate flip 2026-09-11; opt-in `UNVERIFIED_GATE_ENFORCE=1` re-arms the block, `UNVERIFIED_GATE_DISABLED` is retired). `passed` itself stays true for skips so auto-verify never fix-loops on a missing linter — that behavior is deliberate and unchanged.

### Overview sidebar (goal · project info · todos) — frontend surface for GOAL
The Digby Code page has a right **Overview** panel (persistent column at `xl+`,
slide-over drawer below, toggled from the session header). It surfaces the GOAL
primitive to the user:
- **Project** — name, provider, branch/base, model, permission mode, live status.
- **Goal** — the plan's goal + acceptance criteria (goal is user-editable).
- **Todos** — the plan steps, linked to the goal, with a progress bar. The user
  can add a todo, check one off (click cycles pending → in_progress → completed),
  or delete one.
It live-updates from the `plan_update` SSE event during a run and reconciles from
`GET /coding/sessions/:id/plan` on load/finish. **User edits go through the exact
same `applyPlan` normalization as the agent's `update_plan`** (`planToUpdate` →
targeted transform → `applyPlan`), so a user-added todo shows up in the next
per-turn `<plan>` reminder and steers the agent. Edits are **locked while a run is
active** (server returns 409; the UI shows a read-only banner) so a user edit never
races the agent's own `update_plan`. Endpoints: `GET .../plan`, `PUT .../plan/goal`,
`POST .../plan/todos`, `PATCH .../plan/todos/:stepId`, `DELETE .../plan/todos/:stepId`.

### MONITOR — background processes (`process.service.ts`)
- `start_background_process({command, name?, ready?})` (detached `setsid` under `docker exec`, own process group, logfile) → handle; `read_process_output({handle, sinceOffset?, filter?})` (byte-offset cursor, ground-truth status from exit-file/`kill -0`); `list_processes()`; `stop_process({handle, signal?})` (`kill -- -pgid`). Optional `ready` check (port / HTTP / log-match). The handle cap (5) counts only LIVE processes — at the cap, dead registry entries are auto-reaped first (tier 1: last-known-exited, free; tier 2: one ground-truth exit-file/`kill -0` probe), `list_processes` re-registers only RUNNING handles, and wait/read resolve on-disk handles without a registry entry (ticket d2531cf5 — a 20h session saturated at "1730/5" on leaked dead entries).
- Container gets `--init` (tini) to reap orphans; `docker rm -f` + the idle reaper clean everything up; in-memory handles dropped on stop. Same path works in-process (Docker-off fallback).
- Enables dev servers / watchers for "Done means verified". Note: `browser_task` can't reach the container's localhost — drive a running app with `curl` from `run_command`. The iframe preview proxy IS implemented (see "Live app preview" below); only the per-session subdomain reverse-proxy upgrade is deferred.

## Multi-agent — roles / delegation / retrieval (`roles.ts`, `coding-retrieval.service.ts`, `verify-state.ts`)

Orchestrator-worker system. The main agent is the ORCHESTRATOR (owns goal + todos, all tools + delegate); it delegates scoped work to bounded, depth-1 WORKER subagents, each with a role prompt + a **tool policy** (`ROLE_TOOLS`).

- **8 roles**: planner, architect, explorer, web_researcher (read-only); coder, editor (write); verifier, reviewer (read-only, run tests/review). Read-only roles cannot mutate the worktree; `git_push`/`open_pull_request`/`delegate` are orchestrator-only; `update_plan` is orchestrator + planner only.
- **Delegation tied to todos**: `delegate({role, task, title?, todo_id?})` — on return the linked plan step is marked completed/blocked with the worker's summary as its note (emits `plan_update`). **`delegate_parallel({tasks})`** runs independent read-only workers concurrently (cap 6; writers rejected — concurrent writes corrupt the worktree). Per-run delegation budget: `CODING_PROFILE.maxDelegations = 100` (the old `MAX_DELEGATIONS=20` const was removed — the profile budget is the only enforcement); per-role step budgets via `ROLES[role].maxSteps`.
- **Retrieval RAG**: explorer/web_researcher/architect OFFLOAD the full content they gather (read files, scraped pages, search results, digest) → the session scope of the unified `digby_memory` store (`memory/unified-memory.service.ts`; pgvector 1536, DashScope text-embedding-v4, keyword fallback — long queries reduce to OR-ed distinctive tokens, `ftsQueryFor`; per-scope cap 800, source-scoped on the shared project scope). `coding-retrieval.service.ts` is a thin facade: reads query `digby_memory` first and fall back to the legacy `coding_memory_chunks` table for pre-migration sessions. **EVERY role** retrieves via **`search_memory({query, scope?, source?})`** + **`search_code_semantic({query})`** (editor/verifier included, 2026-09-04). Cleared on session delete.
- **Retrieval is pushed, not just pulled** (owner 2026-09-04): run-start injects `[RELEVANT LEARNINGS]` + `[CODE INDEX MATCHES]` (`buildCodeMatchesBlock`) + `[SESSION MEMORY INVENTORY]` (`buildSessionMemoryInventory`) beside the memory tiers/journal; the doctrine carries a "Memory first" bullet and an Explore bullet leading with `search_code_semantic`; delegate returns append a `[HARNESS: … stored N … search_memory …]` pointer when the worker offloaded (`AgentRunResult.offloaded`); compaction recaps carry the earlier-phases memory pointer FORWARD across compactions (weak marker `is in session memory` survives the synthetic strip; strict marker `embedded to session memory` = this recap's own turns offloaded). Telemetry: `coding_retrieval_usage` (per run) + `coding_retrieval_hits` (per call, value = hits) in `loop_metrics`.
- **PR gate**: the agent's autonomous `open_pull_request` needs the verify chain green on the current content (`verify-state.ts` records it, sha/tree-keyed since P5 — see the LOOP section; enforced when a chain exists AND `loop.gatePullRequest`, default true). Since 2026-09-27 a docs-only diff bypasses it (PR-body "docs-only, unverified" trailer) and any other unpassed / stale state is verified by the tool itself before opening (red refuses with the tail). An `unverified` pass (skipped stages) is observe-only since 2026-09-11 (`UNVERIFIED_GATE_ENFORCE=1` blocks). The human "Open PR" button bypasses it (`ctx.prGateBypass`).
- **UI**: live worker chips (role · title, spinner → check) from `subagent_start`/`subagent_end`.

## Publish path — guards + CI observation (P5 remediation, v1#26-28)

Everything that leaves the worktree flows through `git_push` / `open_pull_request`
(`tools.ts pushSessionBranch` is the one push seam — the agent tools, the PR
pre-push, and the human Push button all use it). Layers:

- **Base-branch push refusal (v1#26)**: pushing the project base branch
  (ctx.baseBranch + the conventional main/master) returns a structured
  `{reason:'base_push_guard'}` envelope naming the session branch to publish
  instead. Machine-triggered runs (no `ctx.userTurnAt`) can never override;
  user-present runs pass `allowBase:true` explicitly (the human Push/Open-PR
  buttons pass it — the click is the confirmation). Kill-switch
  `BASE_PUSH_GUARD_ENFORCE=1` re-arms the refusal (gate flip 2026-09-11: default is observe-only — the push executes with a note + guard_strike; `BASE_PUSH_GUARD_DISABLED` is retired).
- **run_command interception (v1#27)**: the per-command GH_TOKEN
  (session-credentials) would otherwise let raw-shell `git push` / `gh pr merge`
  / REST merge curls bypass every gate. `detectPublishIntent` matches only the
  unambiguous shapes (word-boundary `git push` incl. dash-option forms,
  `gh pr merge`, `api.github.com/repos/…/pulls/N/merge` + `/merges`,
  `git remote add|set-url … x-access-token`). Machine runs → `[command REFUSED
  — publish guard]` envelope (receipt ok:false, nothing executed) redirecting
  to the gated tools; user-present runs → warning line after the status banner,
  then the command proceeds. Accepted edges (tested + documented): an unquoted
  phrase like `echo git push` false-positives into an honest refusal; the
  separated-argument `git -C /path push` is not matched. Kill-switch
  `RUN_COMMAND_PUSH_GUARD_ENFORCE=1` re-arms the refusal (gate flip 2026-09-11: default is a `[publish-intent notice]` + metric and the command runs; only the x-access-token remote shape stays refused; `RUN_COMMAND_PUSH_GUARD_DISABLED` is retired).
- **PR head integrity (ticket c7bf1e66, 2026-09-17)**: `open_pull_request` resolves
  the PR head ONCE and pins it into `pushSessionBranch` (`opts.headBranch`), so
  the published branch and the PR head can never diverge on a shared/stale
  worktree checkout (prod: PR #629 opened with head `digby/gdn-window-a` instead
  of the lane's fold branch). An optional `headBranch` arg opens the PR from a
  branch the agent published out-of-band (e.g. REST-created): the worktree push
  is skipped and the branch is verified to exist on the remote (GitHub 404 ⇒
  loud refusal, nothing opened). The created PR's `head.ref` is then verified
  against the requested head — a mismatch fails loudly (never the `Opened PR #`
  success prefix the receipt extractor keys on) and records a `pr_head_mismatch`
  guard-strike. Replay: `open-pull-request-head.c7bf1e66.test.ts`.
- **Published-refs receipt + branch-only-landing advisory (ticket 2c01e9d2, 2026-09-27)**:
  every `git_push` result now ends with `— published refs: refs/heads/<branch>.`
  and the receipt carries `ids.refs` (the verbatim refspec array) — the reader
  (model, journal, evidence guard) can see WHICH refs moved without
  re-deriving intent. When the durable plan's goal states a landing-on-base
  intent (`goalLandingOnBaseRe`) and the push publishes only a branch ref the
  remote base tip does NOT contain (`pushedShaLandsOnBase` tri-state; `null` =
  base unreadable → no advisory), the result adds a `branch publish ONLY` note
  + a `guard_strike` (seam `branch_only_landing`, state `observed`) — a NOTE,
  never a refusal; every failure leg renders nothing. Replay:
  `coding/push-refs-receipt.2c01e9d2.test.ts`.
- **CI observation (v1#28, `ci-status.ts`)**: `check_ci` is a READ tool
  (orchestrator + verifier/reviewer roles) that queries the GitHub Checks API
  (legacy commit-status fallback; ≤20 check runs) for a sha — defaulting to the
  last sha this session pushed (durable `git_push` receipts) then HEAD — using
  the session's own GitHub OAuth token (`ctx.getGithubToken` →
  `github/token-manager getValidToken`). After a successful agent push,
  git_push/open_pull_request run ONE bounded poll (wait ~30s, query once, ≤45s
  total — never a long-poll; skipped for the human Open-PR button) and append
  `CI: pending|success|failure|none` + failing check names (receipt `ids.ci`).
  An observed failure on a session-pushed sha emits the **`ci_failed` hook
  event** (registered in `HOOK_EVENT_TYPES`, now 8 types; deliberately NOT
  alarm-class — it is a per-lane work signal the lane's own hooks subscribe to,
  and it is not in the stock fleet-supervisor subscription). The coding
  doctrine instructs: after pushing, confirm CI (push-result verdict, then
  check_ci) before claiming done. Opt-in `PUSH_CI_OBSERVE_ENABLED=1` (gate flip 2026-09-11: default OFF — no in-run sleep; `PUSH_CI_OBSERVE_DISABLED` is retired)
  (the explicit check_ci tool keeps working).

## Worktree disk (Box C)

Each coding session gets its own worktree and runs the project's install
(`npm install` in backend and frontend), which leaves ~2G of `node_modules`
(and more after a build: `.next`). Those dirs are reinstallable. The
worktree reaper (`coding/project-workspace.service.ts`, worker cron
`worktree-reaper`) prunes them from idle worktrees and, under disk pressure,
removes whole idle worktrees.

Default (adaptive, 2026-10-18): the pass is hourly. Artifact prune
(`node_modules`, `.next`, `.turbo`, `.pnpm-store`, `__pycache__`, `.npm`,
`.cache`; never `tmp`, which holds user work) runs after 6h idle. A full reap shortens with volume usage —
7 days under 60%, 3 days under 70%, 48 hours at or above — and an extra pass
fires at 70% used. A pass that leaves usage above 85% logs at error (the
log-signal sweep). One `worktree_reap_pass` metric row per pass carries the
worktree count, bytes freed and usage percent.

The prune deletes those artifact dirs only. Git state and uncommitted work
stay. `ensureRunnable` rebuilds a missing or unusable git worktree; it does
not run `npm install` on a usable worktree whose `node_modules` was pruned.
The next install or verify the lane runs regenerates the dependencies.

Never pruned or reaped: a session with a queued or running agent run, or
(once the idle bar is under 7 days) a session with an enabled schedule.
`WORKTREE_DISK_ADAPTIVE_DISABLED=1` restores the previous behaviour: 7-day
idle, a 6-hour cron, batches of 25/50, and the extra pass only above 80%.
Numeric overrides (not kill switches): `ARTIFACT_PRUNE_IDLE_MS` (6h),
`WORKTREE_REAP_INTERVAL_SEC` (3600), `WORKTREE_DISK_PRESSURE` (0.70).

## Deferred roadmap (NOT yet implemented — do not claim these are enforced)

- **Probe-run commands at scaffold time** in the session container; keep only exit-0
  invocations, mark the rest `TODO`. (Today: detected, not run — `config.verified:false`.)
- **PreToolUse hard-deny hooks** driven by `config.json` permissions, applied even in auto.
- **`run_until_pass`** bounded self-correction micro-loop (aider reflection as a tool).
- **`.digby/agents/*.md`** user-defined subagent definitions + **`.digby/commands/*.md`** slash templates. (Built-in roles ship in `roles.ts`; these would let a repo add its own.)
- **`.digby/rules/*.md` path-triggered semantics + `.digby/docs/*.md` deep refs** — rule FILES are already loaded every turn (`buildAgentGuide` in `agent.ts`, up to 6 files × 6k chars); what remains unimplemented is path-triggered activation (today they load wholesale), the ~2k-token injected-set budget, and `.digby/docs/*.md` loading.
- **Live app preview** — IMPLEMENTED (best-effort, `coding-preview.controller.ts`): proxies `curl http://localhost:<port>` inside the session, rewrites HTML, renders in a sidebar iframe. Deferred upgrade: a **per-session subdomain reverse-proxy** (wildcard DNS/TLS) for full SPA/HMR fidelity (absolute JS-built asset URLs + websockets). PTY-backed processes for TTY-only tools.
- **Reviewer sign-off in the PR gate** — currently the gate is verify-green only (deterministic); making a reviewer's "no blocking issues" a hard gate needs a structured verdict, not free text.
- **Precedence engine** + monorepo nearest-AGENTS.md.
- **Docs-freshness gates** — a verify-chain `docs` stage or a CI docs-check workflow:
  considered and deliberately deferred (provision-time refresh + the DOCS HEALTH
  prompt nudge cover the stale-guide failure mode without failing runs/builds over
  docs).

## Files

- `backend/src/modules/crossmodel/coding/scaffolding.service.ts` — detection + render + write/commit + docs health (`ensureProjectDocs` = scaffold → assess → refresh; marker/`docsHash` ownership).
- `backend/src/modules/crossmodel/coding/agent.ts` — Digby defaults prompt + `buildAgentGuide` + per-turn `<plan>` reminder + auto-verify loop.
- `backend/src/modules/crossmodel/coding/plan.service.ts` — GOAL: `applyPlan` normalization, `planToUpdate` (shared by agent + REST), reminder render.
- `backend/src/modules/crossmodel/coding/verify.service.ts` — LOOP: verify chain + failure signatures.
- `backend/src/modules/crossmodel/coding/process.service.ts` — MONITOR: background processes.
- `backend/src/modules/crossmodel/coding/roles.ts` — multi-agent role defs + tool policies.
- `backend/src/modules/crossmodel/coding/coding-retrieval.service.ts` — session RAG (offload + `search_memory`).
- `backend/src/modules/crossmodel/coding/verify-state.ts` — per-session verify pass state (PR gate; sha/tree fingerprint since P5).
- `backend/src/modules/crossmodel/coding/ci-status.ts` — CI observation: `check_ci`, the bounded post-push poll, the `ci_failed` emission (P5).
- `backend/src/modules/crossmodel/coding/coding.controller.ts` — `provisionWorktree` hook + plan/goal/todo REST endpoints (Overview panel).
- `frontend/app/crossmodel/components/CodeSessionView.tsx` — the Overview panel (goal · project info · todos), live `plan_update` handling, user edits (mounted inline by `app/crossmodel/page.tsx`; the legacy `code/page.tsx` was retired).
- `frontend/lib/api/coding.ts` — plan/goal/todo API client.
- `backend/src/modules/crossmodel/coding/scaffolding.service.test.ts`, `loop-goal-monitor.test.ts` — unit tests.
