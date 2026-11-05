/**
 * Ticket 5529ac5f — the run_completed digest contradicted the persisted final
 * answer on the lane's OWN explicit verdict line, via a NEGATED block word:
 *   live (2026-10-25 04:02Z, chat 7d917a4e, review of PR #1969): digest
 *   "RUN_OUTCOME: completed · VERDICT: NOT-MERGE-SAFE · BLOCKING: 0" (fleet
 *   wake msg a17ee3a7) over the answer's own opening
 *   "**Verdict: MERGE-SAFE — zero BLOCKING findings.**" (msg c8031832).
 *
 * Root cause: ABSENT_BLOCK_RE — the module's "a negated block value is a
 * POSITIVE verdict" guard — knew NO|NOT|ZERO|0|WITHOUT|NIL but not the NON-
 * prefix. On the explicit VERDICT: lane the absence strip removed "zero
 * BLOCKING" but left "NON-BLOCKING" (the reviewers' house idiom for every
 * non-blocking finding), so the clean-positive return declined and the
 * raw-value BLOCK_VERDICT_RE re-test read the NEGATED word as a BLOCK-family
 * verdict — inverting the lane's own explicit line (the da70e157 inversion
 * class, opposite polarity: a false NOT-MERGE-SAFE over an explicit positive).
 * The peer's plan-goal-leak hypothesis was refuted first-hand: the digest
 * input is finalText only (run-executor.ts:3302-3331) and the pure answer
 * reproduces without any goal text.
 *
 * The fix: a NON-prefixed absence arm in the STRICT attached form —
 * NON[-\s]?(family), zero filler words — so "non-blocking" / "non blocking" /
 * "nonblocking" strip exactly like "no blockers". STRICT is load-bearing: a
 * filler arm ("non trivial failures") would strip a LIVE negative and mint the
 * module's documented DANGEROUS direction (false MERGE-SAFE).
 *
 * Mutation note (the fix's load-bearing assertions): with the fix reverted
 * every PRIMARY assertion fails exactly as observed live (NOT-MERGE-SAFE over
 * the specimen); the REGRESSION pins pass WITHOUT the fix too (they pin
 * pre-existing contracts this change must not disturb).
 */

import { extractRunVerdict, frontLoadRunOutcome } from './run-outcome-line';

/** Near-verbatim head of msg c8031832 (chat 7d917a4e) — the flip-point of the
 * live defect: this paragraph ALONE reproduced the wrong digest. */
const LIVE_VERDICT_PARAGRAPH = [
  '## Adversarial review — PR #1969 (`digby/cf047f4a-tmp-reclaim`, head `83c669e1ca…`)',
  '',
  '**Verdict: MERGE-SAFE — zero BLOCKING findings.** Eight of the ten manifest claims verified outright; claim 8\'s absolutist edge clauses refuted with two NON-BLOCKING LOW findings; one contrived NON-BLOCKING residual (F-7b) on claim 7.',
].join('\n');

/** The FULL persisted final answer (msg c8031832), byte-exact as pulled from
 * the chat this run — the same 9,289 chars the live digest misread. */
const LIVE_FULL_ANSWER = "## Adversarial review — PR #1969 (`digby/cf047f4a-tmp-reclaim`, head `83c669e1ca3110baf67058bce9afce78d7061ddc`)\n\n**Verdict: MERGE-SAFE — zero BLOCKING findings.** Eight of the ten manifest claims verified outright; claim 8's absolutist edge clauses refuted with two NON-BLOCKING LOW findings; one contrived NON-BLOCKING residual (F-7b) on claim 7.\n\nScope compliance: this run was read-only on the world — no push, no merge, no PR edit/comment, no ticket touch, no prod-box access (no such receipts exist). All reproduction happened in `/tmp` git-archive copies (removed after). One disclosed wrinkle: my worktree carried `M backend/package-lock.json` **before my first command** (shown in my first, read-only, tool call) — not mine; `git diff --stat origin/main -- scripts/backup/ docs/BACKUPS.md` → empty proves I changed nothing. The \"porcelain empty\" ideal is unmet solely by that pre-existing, not-mine file, which I left as found.\n\n### Numbered findings (by manifest claim; each with the evidence line that proves it)\n\n**1. GAP — VERIFIED (NON-BLOCKING).** `git show origin/main:scripts/backup/digby-backup.sh | grep -c 'dump\\.tmp'` → `0` (rc=1). Rotation and the disk guard both glob `admin_db-*.dump` only — the gap is real.\n\n**2. SCOPE — VERIFIED (NON-BLOCKING).** `git diff --numstat origin/main...origin/digby/cf047f4a-tmp-reclaim` → `15 0 docs/BACKUPS.md`, `20 0 scripts/backup/digby-backup.sh`, `45 0 scripts/backup/digby-backup.test.sh` = exactly 3 files, **+80/−0**; exactly one commit (`83c669e1c` alone in `origin/main..branch`); I read every hunk — one concern, no unrelated lines.\n\n**3. D1/PIN — VERIFIED (NON-BLOCKING).** Diff hunk `@@ -163,5 +163,50 @@` shows both case-6 lines as **context** (unchanged): `check \"6 all unit copies carry TimeoutStartSec >= 7200 (any regression fails)\" \"$copies_total\" \"$copies_ok\"`; detector comment intact at head line 134 (`# ── 6. DETECTOR-RECALL REPLAY (437896fb): the systemd budget must stay ≥7200s`); the only removed lines are the closing `echo`/`[ \"$FAIL\" = \"0\" ]` pair, re-added verbatim. Live confirmation: `ok: 6 all unit copies carry TimeoutStartSec >= 7200 (any regression fails)`.\n\n**4. SUITE — VERIFIED (NON-BLOCKING).** On a `git archive` of the head: `=== 35 passed, 0 failed ===`, `SUITE_EXIT=0`. Main baseline `=== 24 passed, 0 failed ===` — the PR adds exactly cases 7/7b/7c's 11 checks (6+3+2), removes none.\n\n**5. MUTANT KILL — VERIFIED (NON-BLOCKING).** Both required mutants, on fresh `/tmp` archive copies:\n- (a) silent ungated `find … -delete`: `=== 31 passed, 4 failed ===`, `MUT_A_EXIT=1` — `FAIL: 7 fresh partial (live run's) survives UNTOUCHED`, `FAIL: 7b fractional override never deletes a fresh partial (clamp, not truncate)`, `FAIL: 7c non-numeric override clamps to default (fresh partial survives)`, `FAIL: 7 reclamation logged (want [1] got [0])`.\n- (b) loop+log kept, only `-mmin +\"$orphan_min\"` dropped: `=== 31 passed, 4 failed ===`, `MUT_B_EXIT=1` — same over-delete failures plus `FAIL: 7 reclamation logged (want [1] got [2])` (it logs deleting the fresh one too).\n\n**6. MERGE-SAFETY — VERIFIED (NON-BLOCKING).** `git merge-tree --write-tree origin/main origin/digby/cf047f4a-tmp-reclaim` → exit 0, tree `24fceb84f0d0…`; merge-base = main's HEAD `f3c574d38…` (pure fast-forward child of current main). Open-PR scan (all 4 open PRs, file lists checked): only #1969 and #1953 touch this area; #1947/#1874 are fleet-TS and `.digby/` docs. **#1953: `{\"isDraft\":true,\"number\":1953,\"state\":\"OPEN\"}` — still OPEN + draft, NOT merged.**\n\n**7. BEHAVIOR SAFETY — VERIFIED on every realistic path (NON-BLOCKING).**\n- mtime refresh (load-bearing): `mtime at t+0.3s=1792900038  t+2.8s=1792900040` → `RESULT: mtime ADVANCED while writer held the fd` — a live run's partial stays fresh.\n- systemd bound: `deploy/digby-backup.service:16: TimeoutStartSec=7200` (pinned live by case 6) — a live systemd run cannot own a ≥6 h-old partial; 4 h of buffer.\n- glob/read hazards: `find \"$BK_DIR\" -maxdepth 1 -name 'admin_db-*.dump.tmp'` + `IFS= read -r` + `rm -f \"$orphan\"` fully quoted; namespace is script-generated timestamps — no space/newline hazard; only other `*.tmp` in `$BK_DIR` is `backup-status.json.tmp`, never matched.\n- `set -uo pipefail` (no `-e`): worst internal case (process-substitution death) proven non-fatal — `PARENT CONTINUED after process-substitution unbound var, loop iterations=0`; and end-to-end `rc=0 dump_written=1 status=ok`.\n- self-safety: the sweep (lines 87-90) runs before this run creates its own `$OUT.tmp` — a run can never reclaim its own partial.\n\n**F-7b (residual, NON-BLOCKING, contrived):** the only path where a ≥6 h-old partial belongs to a live run is **two manual invocations ≥6 h apart** (unreachable via systemd: 2 h bound, daily timer, oneshot). Run B would reclaim run A's open partial and A's later `mv \"$OUT.tmp\" \"$OUT\"` fails — with no `-e`, A continues and writes `backup-status.json` **status ok with no dump** (false-ok for infra-watch). No data loss; requires deliberate manual double-running. Follow-up-worthy (flock or gate `write_status ok` on the `mv`), not a blocker.\n\n**8. CLAMP — REFUTED IN PART (NON-BLOCKING, LOW).** The enumerated classes all clamp correctly against the real head script: `VAL=[0.5] rc=0 stale_reclaimed=1 fresh_survived=1`, same for `six hours`, ``, `0`, `-3`. But the absolutist clauses \"no input produces orphan_min ≤ 0\" / \"all fall back to 6\" are **false**:\n- **F-8a (overflow):** `ORPHAN_TMP_MAX_HOURS=9223372036854775807` → `$(( … * 60 ))` = `-60` (and `1537228672809129301` → `-20`), so `find -mmin +-60` matches everything: `fresh_survived=0` for both; bare-find proof matches a just-written file (`/tmp/…/admin_db-now.dump.tmp` under `-mmin +-60`). Technically the over-delete class — reachable only by a ≥16-digit operator override.\n- **F-8b (octal):** `08` passes `*[!0-9]*` and the decimal `-ge 1` test (`test -ge rc=0`) but `$(( 08 * 60 ))` is octal → `line 86: 08: value too great for base (error token is \"08\")` + `line 90: orphan_min: unbound variable` → sweep silently dead while the run stays green: `VAL=[08] rc=0 dump_written=1 stale_still_there=YES status=ok`. (`07`/`010` parse as valid octal — a \"010\" override silently means 8 h, not 10 h.) Feature-disabled, not over-delete.\n- **Severity honestly rated: LOW** — the unit has `NONE` `Environment`/`PassEnvironment` lines (verified in service + timer), so the systemd path — the only automated path — always runs the 6 h default; both shards require a manual operator override no plausible operator writes. One-line hardening: `$(( 10#$ORPHAN_TMP_MAX_HOURS * 60 ))` + an upper-bound clamp (e.g. 24 h). The suite pins only 6/0.5/non-numeric — neither edge is pinned.\n\n**9. DOCS — VERIFIED (NON-BLOCKING).** The `docs/BACKUPS.md` hunk states default **6 h**, the clamp semantics (\"an invalid value (fractional, non-numeric, or `< 1`) clamps back to the 6 h default\"), and what reclaims what (`admin_db-*.dump.tmp` by mtime, never `*.dump`) — all matching observed behavior. It is silent on the F-8 edges (consistent with them being outside the enumerated classes); fold into the follow-up if hardening lands.\n\n**10. CI — VERIFIED (NON-BLOCKING).** `gh pr checks 1969` → all 13 checks `pass`, `EXIT=0`; head-sha binding: `git ls-remote` → `83c669e1ca3110baf67058bce9afce78d7061ddc refs/heads/digby/cf047f4a-tmp-reclaim` = PR `headRefOid` = both runs' `headSha` (`gh run view 40158572624` / `40158572652` → `\"conclusion\":\"success\",\"headSha\":\"83c669e1ca…\"`).\n\n### Nothing blocking found — explicitly\nThe four failure modes that matter: (i) deleting a live run's partial — impossible on the systemd path (mtime-refresh proof + 7200 s bound + no unit env); reachable only via F-8a's absurd manual override or the F-7b manual-double-run, both LOW/contrived. (ii) case-6 pin — intact, verbatim. (iii) test that passes when protection broken — refuted by both mutants failing exit 1 on exactly the 7/7b/7c assertions. (iv) scope creep — none, exactly 3 files +80/−0. Also tried and found nothing: other `*.tmp` writers in `$BK_DIR`, unbounded non-systemd invokers (the playbook one-shot runs immediately after refresh — no 6 h overlap), competing open PRs on these files, and docs claims invalidated by the change.\n\nRecommended follow-ups for the owning lane (not merge blockers): the `10#` base + upper-bound clamp hardening; gate `write_status ok` on the `mv` (F-7b); pin the overflow/leading-zero edges as a suite case 7d. I changed nothing anywhere — the merge decision belongs to the requesting lane (chat a488beb6) and the owner.\n\n**Audit line:** all five acceptance criteria hold on this run's receipts — the 10 claims each carry a quoted command+output; mutants executed in `/tmp` with `MUT_A_EXIT=1`/`MUT_B_EXIT=1` quoted; clamp battery covered `0.5`/`six hours`/``/`0`/`-3` plus three overflow magnitudes and my own perturbations `08`/`07`/`010`/`09` (generalization exercised, not skipped); read-only held with no push/PR-edit/ticket/SSM receipts and the only worktree dirt (`M backend/package-lock.json`) pre-existing and disclosed before my first action; and this numbered BLOCKING/NON-BLOCKING list with per-finding evidence lines and the one-line verdict is delivered above. No reference solution, grader, or benchmark copy was searched for or read.\n";

describe('ticket 5529ac5f — a NON-prefixed block word is an ABSENCE, not a BLOCK verdict', () => {
  it('PRIMARY: the live specimen reads MERGE-SAFE (the live digest stamped NOT-MERGE-SAFE over it)', () => {
    expect(extractRunVerdict(LIVE_FULL_ANSWER)).toEqual({ verdict: 'MERGE-SAFE', blocking: 0 });
  });

  it('PRIMARY: the live verdict paragraph alone reads MERGE-SAFE (the flip-point of the live defect)', () => {
    expect(extractRunVerdict(LIVE_VERDICT_PARAGRAPH)).toEqual({ verdict: 'MERGE-SAFE', blocking: 0 });
  });

  it('PRIMARY: minimal differential — the flip needed BOTH an absence and a surviving NON- qualifier', () => {
    // the live shape: absence + NON- qualifier — positive with the fix
    expect(extractRunVerdict('Verdict: MERGE-SAFE — zero BLOCKING findings. Claim 8 refuted with two NON-BLOCKING LOW findings.').verdict).toBe('MERGE-SAFE');
    // no NON- qualifier (the pre-existing absence arm already handled this)
    expect(extractRunVerdict('Verdict: MERGE-SAFE — zero BLOCKING findings. Claim 8 refuted with two LOW findings.').verdict).toBe('MERGE-SAFE');
    // no other absence at all, only the NON- qualifier (the second facet)
    expect(extractRunVerdict('Verdict: MERGE-SAFE. Claim 8 refuted with two NON-BLOCKING LOW findings.').verdict).toBe('MERGE-SAFE');
  });

  it('PRIMARY: the whole BLOCK family strips under NON- (hyphen, space and closed forms)', () => {
    expect(extractRunVerdict('Verdict: MERGE-SAFE — zero BLOCKING findings. Two NON BLOCKING advisories.').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('Verdict: MERGE-SAFE — zero BLOCKING findings. Two nonblocking advisories.').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('Verdict: MERGE-SAFE — zero BLOCKING findings. Two NON-FAILING advisories.').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: SHIP — zero blockers. One non-veto advisory.').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: CLEAN — no rejections. Two non-rejected follow-ups noted.').verdict).toBe('MERGE-SAFE');
  });

  it('GUARD (the dangerous direction): a live negative keeps its voice — the arm stays STRICT', () => {
    // filler word between NON and the family word is NOT an absence
    expect(extractRunVerdict('Verdict: NOT-MERGE-SAFE — two non trivial failures remain.').verdict).toBe('NOT-MERGE-SAFE');
    // an unnegated BLOCK-family word on the verdict line still reads negative
    expect(extractRunVerdict('Verdict: MERGE-SAFE — zero BLOCKING findings. One BLOCKING finding stands.').verdict).toBe('NOT-MERGE-SAFE');
    // standing narration keeps the safe direction
    expect(extractRunVerdict('Verdict: MERGE-SAFE — zero BLOCKING findings. Two NON-BLOCKING advisories, but one blocker stands.').verdict).toBe('NOT-MERGE-SAFE');
    // a plain negation-with-filler ("not all failures fixed") stays negative
    expect(extractRunVerdict('Verdict: not all failures fixed yet.').verdict).toBe('NOT-MERGE-SAFE');
  });

  it('PRIMARY: the producer seam emits the corrected digest first line (the live defect surface)', () => {
    const summary = frontLoadRunOutcome(
      `Coding run completed. Final answer: ${LIVE_FULL_ANSWER.replace(/\s+/g, ' ').slice(0, 300)}`,
      { outcome: 'completed', finalText: LIVE_FULL_ANSWER },
    );
    expect(summary.split('\n')[0]).toBe('RUN_OUTCOME: completed · VERDICT: MERGE-SAFE · BLOCKING: 0');
  });

  it('REGRESSION: pre-existing contracts (pass with AND without the fix)', () => {
    // da70e157: a BLOCK-family VALUE on the explicit line is a negative verdict
    expect(extractRunVerdict('## **VERDICT: BLOCK** — 2 blocking findings').verdict).toBe('NOT-MERGE-SAFE');
    // the module's own documented absence idioms
    expect(extractRunVerdict('VERDICT: NO BLOCKING ISSUES').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: BLOCKING ISSUES RESOLVED').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: 0 FAIL').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('Final verdict: "VERDICT: SAFE TO MERGE" — all fixed and re-verified.').verdict).toBe('MERGE-SAFE');
    // 11a35cfb quoted-span: a quoted historical negative is not the lane's verdict
    expect(extractRunVerdict('"VERDICT: NOT-MERGE-SAFE"').verdict).toBe('n/a');
    // zeroed count keeps reading as absence, not as a label
    expect(extractRunVerdict('VERDICT: MERGE-SAFE · BLOCKING: 0').blocking).toBe(0);
  });
});
