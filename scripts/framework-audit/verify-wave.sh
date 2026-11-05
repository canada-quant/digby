#!/usr/bin/env bash
# verify-wave.sh — the FO opening check BAKED (33rd f64 bake, f117 2026-10-11;
# pending_runs fix from the f117 independent review, same day).
#
# Every FO firing opens by hand-assembling the previous wave's verification:
# git merge-base --is-ancestor per sha, then gh api actions/runs?head_sha=…
# filtered and eyeballed for red runs. Two by-eye burdens, one live trap:
#   TRAP (hit live at f117): actions runs?head_sha= REQUIRES the FULL 40-char
#   sha — an abbreviated prefix returns HTTP 200 with an EMPTY wave, byte-for-
#   byte indistinguishable from the token-event dispatch gap. f117's first
#   query on "389644943b24" printed nothing and looked exactly like the known
#   benign API-token gap. This script resolves the full sha BEFORE querying,
#   so the empty-wave verdict can only mean genuinely-zero runs.
#
# Verdict per sha (one line, greppable):
#   VERDICT: PASS  <sha> ancestor=ANCESTOR_OK runs=<n> red=<m> pend=<k>
#   VERDICT: FAIL  <sha> cause=<unknown_sha|not_ancestor|gh_error|empty_wave|red_runs|pending_runs> …
# A PASS certifies the wave CONCLUDED green: red runs fail it, and so do runs
# still PENDING (conclusion null — in_progress/queued). The f117-review
# lesson: a wave read mid-deploy (CI success, Deploy in_progress) printed
# PASS exit 0 under the old red-only filter — rubber-stamping exactly what
# "verify concluded success before relying on either" forbids.
# empty_wave is FAIL by default (the token-event gap class — per project
# doctrine the remedy is pushing a commit, not waving it through);
# VERIFY_WAVE_EMPTY_OK=1 downgrades it to PASS for repos known to dispatch
# zero runs on squash merges. Symmetrically VERIFY_WAVE_PENDING_OK=1
# downgrades pending_runs to an annotated PASS (ancestry + no-red only).
# gh_error (ticket 0cea589d, f22 2026-10-12 — hit live: gh unauthenticated in
# the lane shell, the api call exited rc=1 with "gh auth login" on stderr, and
# the swallowed 2>/dev/null made the failure byte-identical to empty_wave,
# whose remedy "push a commit" is exactly wrong for an auth outage): a NON-ZERO
# gh exit (auth/network) is its own cause naming rc + the gh stderr head. An
# rc=0 call with zero runs stays empty_wave (the real dispatch gap).
#
# Read-only: no fetch (caller fetches first), no writes, no kill switch needed
# (pure local/remote read; nothing box-side to suppress).
#
# Usage:   verify-wave.sh <owner/repo> <sha> [sha...]
# Env:     GIT_BIN / GH_BIN (test shims), VERIFY_WAVE_MAIN (default origin/main),
#          VERIFY_WAVE_EMPTY_OK / VERIFY_WAVE_PENDING_OK (see above).
# Exit:    0 all shas PASS · 1 any FAIL · 2 usage.
set -u

VW_TMP="$(mktemp -d)" || exit 2
trap 'rm -rf "$VW_TMP"' EXIT

REPO="${1:?usage: verify-wave.sh <owner/repo> <sha> [sha...]}"
[ $# -ge 2 ] || { echo "usage: verify-wave.sh <owner/repo> <sha> [sha...]"; exit 2; }
shift

GIT_BIN="${GIT_BIN:-git}"
GH_BIN="${GH_BIN:-gh}"
MAIN_REF="${VERIFY_WAVE_MAIN:-origin/main}"

overall=0
for sha in "$@"; do
  echo "=== $sha ==="
  # ^{commit} peel: plain --verify accepts any well-formed 40-hex sha WITHOUT
  # checking the object database (deadbeef… passes!), so the peel forces the
  # existence check.
  full="$("$GIT_BIN" rev-parse --verify --quiet "$sha^{commit}" 2>/dev/null)" || full=""
  if [ -z "$full" ]; then
    echo "VERDICT: FAIL  $sha cause=unknown_sha"
    overall=1
    continue
  fi
  if "$GIT_BIN" merge-base --is-ancestor "$full" "$MAIN_REF" 2>/dev/null; then
    anc="ANCESTOR_OK"
  else
    anc="NOT_ANCESTOR"
  fi
  # FULL sha only — the abbreviated-prefix trap documented above. The exit
  # code is captured (gh_error, ticket 0cea589d): an auth/network failure
  # (rc!=0, "gh auth login" on stderr) is NOT an empty wave — the swallowed
  # 2>/dev/null used to make the two byte-identical, and the empty-wave
  # remedy ("push a commit") is exactly wrong for an auth outage.
  json="$("$GH_BIN" api "repos/$REPO/actions/runs?head_sha=$full&per_page=100" 2>"$VW_TMP/gh.err")"
  gh_rc=$?
  if [ "$gh_rc" -ne 0 ]; then
    gh_head="$(head -1 "$VW_TMP/gh.err" 2>/dev/null | cut -c1-100)"
    echo "VERDICT: FAIL  $sha ancestor=$anc cause=gh_error rc=$gh_rc (gh api failed — auth or network, NOT the token-event gap; stderr: ${gh_head:-<none>})"
    overall=1
    continue
  fi
  [ -n "$json" ] || json='{"workflow_runs":[]}'
  summary="$(printf '%s' "$json" | node -e '
    let s = ""; process.stdin.on("data", d => (s += d)).on("end", () => {
      let runs = [];
      try { runs = JSON.parse(s).workflow_runs || []; } catch (_) {}
      const red = runs.filter(r => r.conclusion && r.conclusion !== "success");
      const pend = runs.filter(r => !r.conclusion);
      const out = [`runs=${runs.length} red=${red.length} pend=${pend.length}`];
      for (const r of red) out.push(`RED run ${r.id} ${r.name} ${r.conclusion}`);
      for (const r of pend) out.push(`PEND run ${r.id} ${r.name} ${r.status || "pending"}`);
      console.log(out.join("\n"));
    });')"
  head1="$(printf '%s\n' "$summary" | head -1)"
  runs_n="$(printf '%s' "$head1" | sed 's/^runs=\([0-9]*\).*/\1/')"
  red_m="$(printf '%s' "$head1" | sed 's/.*red=\([0-9]*\).*/\1/')"
  pend_k="$(printf '%s' "$head1" | sed 's/.*pend=\([0-9]*\)$/\1/')"
  if [ "$anc" = "NOT_ANCESTOR" ]; then
    echo "VERDICT: FAIL  $sha cause=not_ancestor (not on $MAIN_REF)"
    overall=1
  elif [ "$runs_n" = "0" ]; then
    if [ "${VERIFY_WAVE_EMPTY_OK:-0}" = "1" ]; then
      echo "VERDICT: PASS  $sha ancestor=$anc runs=0 red=0 pend=0 (empty_wave downgraded)"
    else
      echo "VERDICT: FAIL  $sha cause=empty_wave (zero runs on full sha $full — token-event gap? push a commit)"
      overall=1
    fi
  elif [ "$red_m" != "0" ]; then
    echo "VERDICT: FAIL  $sha cause=red_runs ancestor=$anc $head1"
    printf '%s\n' "$summary" | tail -n +2
    overall=1
  elif [ "$pend_k" != "0" ]; then
    if [ "${VERIFY_WAVE_PENDING_OK:-0}" = "1" ]; then
      echo "VERDICT: PASS  $sha ancestor=$anc $head1 (pending_runs downgraded — wave NOT concluded: do not rely)"
    else
      echo "VERDICT: FAIL  $sha cause=pending_runs ancestor=$anc $head1 (wave not concluded — re-run when it lands)"
      printf '%s\n' "$summary" | grep '^PEND ' || true
      overall=1
    fi
  else
    echo "VERDICT: PASS  $sha ancestor=$anc $head1"
  fi
done
exit "$overall"
