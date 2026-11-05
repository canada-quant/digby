# Pain-Point Audit — 2026-08-07 (audit chat 54989484)

> Triggered by owner: *"i dont want to reply confirm with 14 minute windows this is ridiculous —
> review everything audit everything top to bottom and put together a plan to stop all these pain points."*
> Every claim below was verified against fresh platform state at ~14:56Z Aug 7 (list_schedules,
> hook_list, list_chats, get_chat_status/messages on cec340f2, todo_list, list_feedback).

## Current verified state (so the plan starts from truth)

- **Kickoff cec340f2 ("Re-Send Path C Phase 2 Kickoff")**: mission pivoted by owner at 14:55Z —
  single-node 200M-token smoke test was a verified **NO-GO** (12 launches, 6 deaths at the same
  memory wall: full-param BF16 CPT of 219.33B needs ~131 GiB/GPU at first backward vs 139.8
  capacity; CPU-offload set-but-not-honored in backward on NGC torch 2.8.0a0/accelerate 1.14/
  transformers v5). Owner redirected: run the full newest CanLegalBench against the FP8 serving at
  max context (131,072) / max output (65,536) first; CPT/SFT/GRPO/RL deferred to a second node.
  Todo `52da65f9` = blocked (correct). Its hourly loop `f0fcdcbe` was cancelled after the no-go
  (2/40 runs). Running live right now with the owner steering.
- **Relay infrastructure fully torn down**: hook `3dbe4dfc` unsubscribed, watchdog `5951effa`
  cancelled (3/10 runs), zero active schedules/hooks on this audit chat. No cleanup debt.
- **Supervisor 0ff9996f**: sweep `957cfda5` healthy (39/500, next 15:33Z), dispatch-discipline
  patch live in its prompt, wildcard hook `83396217` firing (last 14:41Z).
- **Spark-Cluster Ops af773f1e**: running (tailnet recovery in progress), but its schedule
  `264d231a` is **actively skipping `daily_cap` at only 5/48 own-runs** — the per-chat cap pools
  ALL of a chat's schedules, and that chat carries many. Live cap casualty #2.
- **Feedback queue**: 30 tickets, ALL marked `done` — including 7 confirm-flow tickets and 3
  cap tickets. The pain demonstrably persists anyway (see PP0).

## Pain-point register

### PP0 — META: tickets marked "done" but the pain persists
All 30 feedback tickets are status=done, yet the two most-filed defect classes (confirm flow,
cap skips) are still biting today. Either "done" means triaged-not-fixed, or fixes landed without
closing the loop with the sessions that filed them. **Ask: platform team re-opens or explicitly
de-scopes the confirm/cap lineage, and "done" tickets get a verification note the filing session
can check.**

### PP1 — Confirmation flow is unusable for the owner's real workflow (TOP PAIN)
- Root causes (each independently filed, all "done"): confirmationIds expire in ~14 min
  (`a631cfb3`); confirms must arrive as a NEW standalone user message — steers/auto-continues
  don't count (`ccae359e`); late/expired confirms **fail silently** — the user replies "confirm"
  and nothing happens, with zero feedback (`173ae516`); `cancel_schedule`'s schema stripped the
  confirmationId making it uncompletable (`2aca6d37`); even full-autonomy chats got gated
  (`f71b97d2`); typed-word instead of a Confirm button card (`e3f3ed42`).
- Session evidence: cap-288 grant for cec340f2 staged 3+ times over ~28h, never executed;
  owner's words: "even if i reply confirm it still doesnt work" → "this is ridiculous".
- Blast radius: every consequential platform action on every chat; blocked the ONE fix (cap-288)
  that would have prevented the next cap incident; destroyed owner trust in the autonomy system.

### PP2 — 48/day per-chat schedule cap silently pauses loops
- `e7a73c52` died silently → 14h unwatched H200 box → ~$545 idle burn (of ~$1,252 cumulative).
- "Schedules paused... resume automatically" notice is misleading: resume is up to ~24h later,
  and `list_schedules` kept showing `[active]` while every firing skipped.
- The cap pools ALL schedules per chat — multi-schedule ops chats (af773f1e) blow through 48
  even when each individual schedule is modest. Fresh evidence: `264d231a` skipping today.
- Tickets `619ba9f9` (p5), `a8312808` (p4), `34c1c60b` — all "done".

### PP3 — The designed escape hatch (set_chat_autonomy) routes through PP1
`set_chat_autonomy` requires a confirmation in EVERY run type, including live user turns. So the
one action that permanently ends the confirm dance can itself only be executed via the confirm
dance. The cap-288 grant was unreachable for 28h for exactly this reason.

### PP4 — Relay/watchdog workaround complexity (self-inflicted but forced)
To keep the box watched during the cap blackout we built a todo_done→hook relay (5 relay todos
on goal bd374ee5, one recurring watchdog, one event hook). It worked — 4 wakes, caught 2 real
crashes — but it burned plan budget, goal-board noise, and tokens, and should never be necessary.
Keep as documented emergency pattern only; the real fix is PP2/PP3.

### PP5 — Schedule graveyard noise
40+ stopped schedules across chats clutter `list_schedules`; no prune/delete. Stale-prompt hazard
was separately filed (`c6147f39`, "done" via update_schedule). Ask: archive or hide stopped
schedules by default.

### PP6 — Unverified-success reporting (agent-behavior class, mostly fixed)
Supervisor reported a 409-blocked dispatch as success (ticket `c506c9e6`, "done"); the
dispatch-discipline patch is live in its sweep prompt and verified followed. Residual minor
recurrence (23:46Z "stood down" claim vs still-active probe). Standing convention now:
**verify-don't-trust — every dispatch/claim re-checked against platform state before reporting.**

### PP7 — Spend governance gap
A $970/day box depended on chat-level schedules with no circuit breaker. When the cap killed the
watch, nothing paged the owner directly (schedule_cap_skipped events exist — the supervisor
wildcard hook subscribes — but the owner got no push). Stop-the-box remains a Brev-only owner
action. Ask: owner-visible notification on first `daily_cap` skip + on `schedule_cap_skipped`
events for chats running cost-bearing infra.

### PP8 — Fleet collaboration substrate: sessions can't talk or work together by default
> Owner steer (Aug 7): *"everyone should be able to talk to everyone and work together"* — and
> *"there is still trouble for projects to assign goals, tasks, blocked tasks, editing goals at a
> project level from project to project and send messages to project sessions from other sessions
> and same with the supervisor chat."* Verified against fresh pulls ~15:50–16:20Z Aug 7.

- **a) Cross-session messaging is gated and lossy.** `send_chat_message` is a consequential tool:
  machine-triggered (scheduled/hook) runs can't use it without a per-chat `set_chat_autonomy`
  grant, grants are **owner-only + confirm-gated** (→ PP1), and a message to a *busy* chat returns
  **409 = failed, not queued**. Supervisor's own sweep prompt documents both: *"Spark chat
  af773f1e was blocked on an expired confirm token and my close-out steer 409'd (busy)"* and
  *"cross-chat autonomy grants are owner-only"*. Net: by default, no session can autonomously
  reach another; every collaboration edge requires the owner to be live.
- **b) No project-scoped event bus — only 2 hand-wired hooks exist fleet-wide** (`87f1feb3`
  cec340f2→41ee1da5; wildcard `83396217`→supervisor). Hooks are one-directional, pairwise, and
  manually wired. Supervisor explicitly notes: *"cec340f2 run_completed hooks to 41ee1da5, not to
  me"* — it does NOT see events from the chats it supervises unless the wildcard catches them.
  There is no "all sessions in project X see project X's goal/todo/run events."
- **c) Goal-board state is inconsistent with what sessions reference.** Supervisor's standing
  sweep and the kickoff both treat goal `ba83dd99` / todo `52da65f9` (project `d355f5d9`) as live
  ("when landed, mark todo 52da65f9 / goal ba83dd99 done"). Fresh `goal_list` on that project
  returns **zero goals in every status** (active/done/archived), and `todo_list` returns none.
  Three independent actors reference the same IDs, so a hallucinated ID is unlikely — either the
  board lost the data or the query API can't see it. If the kickoff's closing `todo_update` hits
  this, the go/no-go close-out fails silently. **(Caveat: I can't distinguish data-loss from
  query-bug from inside; flagged to platform team as a goal-board integrity defect.)**
- **d) The supervisor is architecturally homeless.** `0ff9996f` is a **plain chat**
  (`codeCapable:false`, no workspace, `projectId:null`, title "Unanswered Test Question in Q&A")
  coordinating 4+ projects it isn't a member of. It works only because owner-scoped access
  ignores membership — but it can't hold a worktree, can't verify code-level claims, and its
  identity/title don't reflect its role.
- **e) Verify-don't-trust still catching live drift.** Supervisor's 16:08Z note claims it
  cancelled spark schedule `264d231a` "with my granted autonomy"; my fresh `list_schedules`
  minutes later still shows it `[active]`, `last skipped:daily_cap`. (Also its message bodies
  carry timestamps ~25min ahead of `createdAt` — small telemetry inconsistency worth noting.)
  Kickoff's new hourly loop `ff1691f2` shows runs 0/40, first tick 16:27Z — must be verified
  actually firing (given e7a73c52/f0fcdcbe history), not assumed.
- **Blast radius:** the entire fleet model. The relay pattern (PP4) exists *because* direct
  messaging is gated/lossy; the supervisor's sweep is a manual compensating control for the
  missing event bus; goal-board drift breaks the shared plan-of-record.

## Remediation plan

### A. Platform asks (ranked by pain-killed-per-effort) — filed as feedback
1. **Kill the 14-min window + silent failure**: confirmation tokens persist ≥7 days (or until
   used); a confirm reply matching ANY pending staged action executes it; if none matches, reply
   with explicit "nothing staged / expired" feedback. Add the Confirm/Cancel button card so the
   typed-word path is a fallback, not the only path.
2. **Settings-level autonomy panel**: owner grants per-chat autonomy + schedule cap from a
   settings UI with a single click — no chat-message confirm loop at all. This makes PP3
   disappear and gives the owner the "do it once, never again" path they're asking for.
3. **Cap UX**: distinct `cap_paused` schedule state in list_schedules/UI; attention/notification
   to the OWNER on first daily_cap skip; per-schedule budget instead of per-chat pooling.
4. **Prune stopped schedules** (or hide by default).
5. **"Done" ticket verification loop**: filing session gets the adminNote; status reflects
   verified-fixed vs won't-fix honestly.
6. **Fleet collaboration mesh (PP8) — the "everyone talks to everyone" ask**:
   - **Intra-project messaging by default**: sessions in the same project may `send_chat_message`
     each other in any run type without per-edge autonomy grants (owner keeps veto via project
     settings); grants stay required only for cross-project edges.
   - **Queue, don't 409**: a message to a busy chat is delivered as a queued steer (visible in
     the target's attention state), not dropped; 409 remains only for true errors.
   - **Project event feed**: goal/todo/run events of a project are visible to all its member
     sessions (subscribe-by-default with per-chat opt-out), replacing hand-wired pairwise hooks
     for the common case; keep hooks for cross-project wiring.
   - **Goal-board integrity**: `goal_list`/`todo_list` must reliably return every goal/todo that
     exists (investigate the `ba83dd99`/`52da65f9` invisibility in project `d355f5d9`); writes
     should be readable-back by design (verify-don't-trust shouldn't be necessary against the
     plan-of-record itself).
   - **Give the supervisor a real home**: either convert `0ff9996f` into a code-capable chat
     assigned to the ops project (with a title matching its role), or ship a first-class
     supervisor identity that is automatically a member of every project it supervises.

### B. In-session conventions (adopted now, no platform change needed)
- One schedule per ops chat, longest tolerable interval; prefer event hooks (uncapped) over
  schedules for wake-ups; the relay pattern is documented here as the emergency fallback.
- Verify-don't-trust on every dispatch, cancel, and "stood down" claim.
- For cost-bearing infra: always pair a schedule with a dead-man escalation that reaches the
  owner through a channel that doesn't depend on the capped chat.
- Never stage a confirmation in a machine-triggered run when the owner isn't present — it is
  guaranteed stale by the time they read it. Surface the ask; stage only when the owner is live.

### C. Owner one-time setup (optional, only when you want it — no action requested now)
- A one-time autonomy grant for each long-running ops chat (kickoff, spark-ops, supervisor)
  with scheduleCap raised (e.g. 288) permanently ends both the confirm windows AND the cap
  blackouts for those chats. Today that still routes through one confirm reply per chat; with
  platform ask A2 it becomes one click. **Not re-staged here — you said no more confirm windows,
  and staging one now would create exactly that.**
- Box decision when ready: stop the idle H200 via Brev (~$40/hr) or keep it for the bench rerun
  now underway; second node for CPT/SFT/GRPO/RL per your 14:55Z steer.
