# Fleet audit playbook

> **The standing method for auditing the owner's Digby fleet — written down
> once so every audit starts from the same map (todo 73701043, framework
> audit 2026-10-15; method: Paul's coaching, lesson 1).** The Fleet
> Supervisor owns fleet supervision; this document is the RECONCILIATION
> method an auditor runs when asked "what is actually happening across the
> fleet, and what should change?" It is deliberately tool-shaped: every step
> names the platform read it runs on, and every finding ends in an id.

## Why this exists

Fleet state is spread across four ledgers that can disagree: chat
transcripts (what lanes SAY), run receipts (what lanes DID), board rows
(goals / todos / schedules — what the fleet OWES), and telemetry (what the
platform OBSERVED). An audit that reads only one ledger — most often the
transcripts, because they are the loudest — reports narration as fact. The
2026-10-15 framework audit ran on exactly this method and produced the
audit items in `docs/FRAMEWORK_AUDIT_2026-10-15.md`-class findings; the
2026-10-16 follow-ups (receipt-grounding todos 6f8b52b7 / efb2960d /
76d78ad7 / 1e356736) each closed a reconciliation gap this playbook now
names as a standing check.

## The method (six passes, in order)

### Pass 1 — Harvest (read everything, trust nothing)

- `list_chats` — the fleet roster: every chat, its project, running /
  attention state, archived included when scope demands. Survey, don't judge.
- `get_chat_messages` — the transcripts of the chats in scope, newest page
  first. Read for CLAIMS: ids cited (PR#, sha, receipt id, schedule id,
  ticket id), status assertions ("landed", "started", "nothing needs the
  owner"), and timestamps.
- `get_run_receipts` — the durable evidence: what tool calls each lane's
  runs actually made, with ok / ids envelopes. This is ground truth for
  ACTIONS; a claim without a matching receipt is a hypothesis, not a fact.
- `get_fleet_telemetry` — deploy view (boxes on main head, wave verdicts,
  errors, jobHealth, collab (per-lane run / tool / memory counts — the
  `alone` row names lanes that ran without memory, web, delegation or
  spawn), costs.
  **Box sha claims (ticket 9c0caf1c):** both `boxes` and `deploy` stamp every
  surface with `shaState` (`settled` | `flapping` | `unconfirmed` | `stale` | `unknown`),
  `shaSince` / `shaAgeMin` / `shaRows` / `previousSha`, plus a view-level
  `deployWave {read, inFlight, runs}` and `shaEvidence {settled, code, reason}`.
  A single read taken during a coalesced wave is NOT evidence of what
  production serves: cite a box's sha as settled serving state only when
  `shaEvidence.settled` is true, and treat `deployWave.read != 'read'` as
  "wave unknown" (never as "no wave"). When it is false, quote `shaEvidence.code`
  (`wave_in_flight` / `flapping` / `unconfirmed` / `stale` / `wave_unread`) and say
  what the read does prove — e.g. "continuously reported since <shaSince>" — rather
  than asserting a flip. Two supervisors published and retracted exactly such a
  claim on 2026-10-30 because the payload could not distinguish the two.

Harvest bounds: an audit is a bounded read, not a re-read of history —
default to the last 24 h unless the ask names a longer window; page
transcripts newest-first and stop when the material repeats.

### Pass 2 — Reconcile (claims vs receipts vs ledgers)

For every id-bearing claim in the harvested transcripts, in this order:

1. **Receipt check** — does a `run_tool_receipts` row of this run vouch the
   cited id (exact or ≥8-char prefix)? A missing receipt is NOT yet a
   fabrication: classify the gap first (todo 76d78ad7) —
   `expected_pre_class` (the run predates the receipt class shipping) >
   `drain_loss` (a durable state row exists and the action sits inside a
   deploy window + drain margin) > `unexplained_gap` (durable row, no
   window — watch-list) > `invented_claim` (no durable row anywhere — the
   only model-fabrication signal). A deploy window never launders a claim
   whose side effect never landed.
2. **Ledger check** — `todo_get` / `goal_get` / `schedule_get` /
   `hook_list` on every cited board id: does the row exist, and does its
   state match the claim ("started" needs `in_progress` or a mutating
   receipt this run; "done" needs typed evidence)?
3. **Board truth** — a reply stamps `answered`, not `done`; done is a
   typed-evidence close (audit item 8, PR #1575). Never report an owner
   request done while its ledger row is unresolved.
4. **Status-line contract** — an owner-facing status line is a computed
   view over the ledger, not prose: rate claims compare like-for-like
   (end-to-end wall clock vs active window — a best-leg burst is not a
   sustained rate), "nothing needs the owner" is the UNION of open owner
   cards AND todos/plan steps blocked on an owner action AND approved
   cards whose follow-up action has not landed, and progress words need
   their ledger state (todo 908f48a7's contract).

### Pass 3 — Time-order

Order every reconciled event by its tool-printed or ledger timestamp, never
by narration order. Look for: cause-after-effect narration, stale claims
still being repeated after the underlying state changed, and clocks quoted
from memory instead of a tool result (the harness-clock rule: cite the
turn's tool results, never estimates).

### Pass 4 — Routing and waste

- **Routing** — did work land in the right lane? A goal a lane already
  holds routed elsewhere (topology violation), lanes messaging supervisors
  with state restatements instead of goal changes or asks, project
  supervisor vs Fleet Supervisor overlap, dispatches that should have been
  schedules (a watch/poll is a schedule, never a lane).
- **Waste** — spend without movement: `get_spend` per lane vs the run
  counts and artifact ids those runs produced; audit-only firings reported
  as movement; a lane that reports a verdict every firing but never a
  premise number or a merged change is a record-keeper, not progress.
  Deploy waves that shipped no runtime change (path-only) count against
  cadence, not value.

### Pass 5 — Staleness and security hygiene

- **Staleness** — blocked todos with no recent blockedReason refresh,
  schedules past maxRuns still firing, hooks pointed at archived chats,
  watched resources past their observation window, owner questions answered
  but never propagated to the gated lane, PRs green but unmerged past the
  CI gate, branch protection exceptions.
- **Security hygiene** — credentials in transcripts / receipts / logs (the
  `dgw_`/`tskey-`/`cfat_` shape classes), redaction working as designed
  (never work around it), secrets in commits, `infra` blockers' registered
  scope respected (a blocker's scope is the HOLD boundary — never hold a
  step whose surface it does not name), API keys on retired boxes
  treated as dead by design.

### Pass 6 — Rank and file

- Rank findings by severity: fabricated completions > false owner-facing
  status > routing waste > staleness > hygiene. One owner per item: an
  item is either a lane steer (send_chat_message with the evidence), a
  framework fix (dispatch to the Framework Operator lane with file:line
  and a specimen), a board correction (todo_update with the receipt), or
  an owner question (only for decisions a standing goal cannot answer).
- Every finding carries its evidence: the id pair (claim id vs receipt /
  ledger id), the timestamp, and the ledger row. No id, no finding.
- File fixes where the fix lives: framework defects to the framework repo
  (regression test + FRAMEWORK_LESSONS row per the audit-tranche pattern),
  lane behavior to the lane's standing instructions, fleet wiring to the
  supervisor that owns it.

## Standing cadence and scope

- **Standing daily probe** (todo 36079e96): receipt-check every supervisor
  action claim fleet-wide over 24 h, record the unbacked-claim rate in
  `loop_metrics`, one ticket per NEW failure class, confirmed classes into
  `docs/FRAMEWORK_LESSONS.md`. The playbook's passes 1–2 run daily; passes
  3–6 run when the probe's rate moves or the owner asks.
- **Scope default**: the owner's own chats + every project's lanes +
  supervisors. Other users' data is out of scope for every lane.

## Provenance

- Method: owner coaching (lesson 1, 2026-10-15 framework audit) — harvest,
  reconcile claims against receipts against ledgers, time-order, routing /
  waste / staleness / security checks, rank, one owner per item, file.
- The Fleet Supervisor role profile points here for its audit duties
  (`backend/src/modules/crossmodel/platform/role-profiles.ts`).
- Sibling documents: `docs/FRAMEWORK_OPERATOR.md` (the operator lane's own
  charter), `docs/FRAMEWORK_BACKLOG.md` (the framework's living backlog),
  `docs/FRAMEWORK_LESSONS.md` (confirmed classes), and the probe scripts in
  `scripts/framework-audit/` (this playbook's instrument set —
  `audit-live-state.js`, `probe-76d78ad7.js`).
