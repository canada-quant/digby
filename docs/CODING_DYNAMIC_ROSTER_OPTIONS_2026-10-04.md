# Coding sessions — dynamic roster options (2026-10-04)

Owner ask (2026-10-04): "does any of the decisions process apply over to the coding sessions and are there more
opportunities to not only speed up sessions but choose better workflows and dynamic agent flows?"

Companion to `docs/DYNAMIC_ROSTER_PLAN_2026-10-03.md` (the chat turn plan + Quick lane). Status: **options —
awaiting the owner's pick.** Nothing in this doc is built yet.

## 1. What decides a coding run today (verified against main 78e747ee)

**No coding run is classified.** A one-line rename and a multi-file feature get the same lead model (the
`coding_default` seat via `coding/seat-governance.ts`), the same `reasoning_effort` max (`coding/coding-model.ts`
built-ins + custom endpoints), the same 200-step budget with no deadline for user runs
(`coding/agent-profiles.ts CODING_PROFILE`), and the same finish sequence: goal-continue → self-audit →
independent reviewer → auto-verify (`coding/agent.ts` ~5240–5657, gated only on `permissionMode==='auto'`).

The decision gate (Jev) touches coding only at the edges — whether a MACHINE firing runs at all (`sweep_triage`,
`wake_triage`, `delta_material`, `firing_superseded`, `supervisor_turn_noop`), the post-run memory fold
(`coding_memory_fold`), the failure-streak consult (`reflection_route`), the self-audit (`self_audit`, act-capped
in code — too inaccurate) and child-session placement (`session_topology`). Workflow choices (plan first or not,
delegate, reviewer, child sessions) are left to the prompt; delegation appears in ~5 of 57 sessions.

Where models are picked: lead = `coding_default`; workers by role (`coding/delegation.ts`, `coding/roles.ts`):
reviewer / cross_checker → `coding_reviewer` (follows the Double Checker), planner / architect →
`coding_architect`, explorer / web_researcher → `coding_explorer`, coder / editor → the lead, verifier → The
Helper (fast, thinking off); compaction / memory / journal → Utility; failure-streak consult → Double Checker.

## 2. Baseline (prod readout CR1004, 14 days to 2026-10-04 01:00Z)

| Lane-chat runs (completed) | n | duration p50 / p90 | steps p50 / p90 | tool calls p50 / p90 |
|---|---|---|---|---|
| schedule firings | 2,010 | 10.6 min / 64.7 min | 15 / 63 | 26 / 81 |
| agent-dispatched (supervisors → lanes) | 939 | 23.5 min / 2.2 h | 28 / 129 | 41 / 172 |
| hook wakes | 149 | 26.6 min / 1.9 h | 24 / 102 | 38 / 130 |
| **human** coding turns | **84** | **40.8 min / 2.7 h** | 44.5 / 158 | 66.5 / 178 |

- **97 % of coding runs are machine-triggered** — the speed / spend lever is the machine firings, not the 84
  human turns.
- **Spend (14 d, `run_spend`):** coding ≈ **$7,670** (glm-5.3 $3,724, kimi-k3 $2,624, gateway glm-5.3 $1,205,
  qwen3.8-max $62, deepseek-flash $51) vs chat ≈ $1,890 and the decision gate ≈ $1.27. Coding ≈ $550 / day.
- **Small firings:** 459 of 2,010 schedule firings (23 %) used ≤ 10 tool calls (p50 2–4 min) — they still ran on
  the max-effort lead with the full finish sequence.
- **The finish sequence runs on nearly everything:** `self_audit_run` 2,624 vs `self_audit_skip` 99 in 14 days;
  `context_compaction` 21,007; `seat_fallback` 1,553; `goal_continue` 759; `independent_review` 108.
- **Failures:** 26 runs killed by a provider size failure (HTTP 403), 7 "workspace missing on disk".
- **Tool mix (lane runs):** run_command 77k calls, update_plan 13.7k, read_file 11.6k, edit_file 9.3k,
  search_memory 5.9k, get_chat_messages 4.6k, … delegate 340 (199 runs).

Telemetry gaps to close before any label can be trusted: per-run spend did not join (`run_spend.runId` is not set
on most rows — the per-run p50 read 0); no files / lines-changed per run; auto-verify outcomes live only in
`agent_events` (30-day retention); no coding re-ask label.

## 3. Options

### A — Deterministic quick wins (no model decides; each kill-switched)
1. **Skip auto-verify when nothing changed** since the last green verify (the tree fingerprint already exists —
   `verify-state.ts captureWorktreeTree`).
2. **Self-audit receipt rule → act** (`SELF_AUDIT_RECEIPT_RULE_MODE=act`; built, backtested: 54 % of audits
   skippable at a 2.4 % reopen rate; 1-in-10 control sample + auto-demote already wired). Owner flip.
3. **Reviewer only where it pays:** a non-trivial diff or a risky path (migrations, `schema.prisma`, auth,
   `.github`, deploy scripts); always on dispatched / bench tasks.
4. **Machine-firing effort:** `reasoning_effort: 'high'` instead of max for a firing on an all-complete board or
   after three no-op firings (`AgentRunInput.providerExtra` is already merged at `agent.ts` but never set).
5. **Mechanical-tail downshift:** once verify is green and only commit / PR / docs steps remain, swap to the fast
   seat for the tail.

Expected: the biggest $ cut for the least risk (self-audit ran 2,624 times; firings are 97 % of runs).

### B — `run_plan` lanes for coding (the chat turn plan, applied to runs)
One batched Jev ask per run (≈ 150 ms): lane `answer` (a question about the code, no edits) / `quick_edit` (1–2
files, mechanical) / `standard` / `deep`, plus traits `needs_web`, `risky_surface`, `independent_subtasks`,
`test_first`. Code chooses the roster from pools (as in chat). Only a confident `answer` / `quick_edit` ACTS: the
Quick answers seat or The Helper in fast mode, ~20 steps, no reviewer / self-audit; it UPSHIFTS to the lead on two
verify failures or an exhausted budget (the provider swap at `agent.ts` already exists). Shadow first; labels =
first auto-verify pass, reviewer FAILs, a human re-send within 30 min, goal-continue rounds, wall time; offline
replay over the 14-day run corpus before any act.

### C — Dynamic agents mid-run
1. **Risky-path reviewer call-in** the moment an edit receipt touches a risky path (not only at the finish).
2. **Stuck → call in help:** on the second identical verify failure, escalate to a different-family model or
   dispatch a `web_researcher` with the failure signature (today: stop after three, consult capped at two).
3. **Harness-driven fan-out:** when `independent_subtasks` is confident, the harness itself issues
   `delegate_parallel` / child sessions instead of hoping the prompt does.
4. **Plan-first on deep runs:** a harness-dispatched planner (Architect seat) before step 0.

### D — Machine-firing economy (where the spend is)
`wake_effort` extended to coding firings (the harness-counted label already exists) + a firing-size prediction
(Jev score over the schedule prompt, the board state and the last 5 firings' tool counts) → effort high vs max,
fast seat vs lead, and "skip the finish sequence" for maintenance-only firings. Shadow → readiness → act like every
other purpose.

**Step 1 shipped 2026-10-04 (the label):** `run_tool_profile` now carries `codeWrites` / `gitWrites` /
`platformWrites` (`coding/tool-profile.ts runDidWrite`), so a schedule / hook firing that changed nothing is a
queryable row (`meta->>'triggerKind'` from the run stamp). Step 2 — the shadow predictor — reads the last 5 of these
rows per lane as its state and labels each firing with `runDidWrite` at finalize.

## 4. Recommendation

**A now** (deterministic, measurable within a day), **D in shadow** alongside it (the spend is in the firings), then
**B** in shadow with the offline replay, then **C**. Close the four telemetry gaps (§2) first — they are what every
later label reads.
