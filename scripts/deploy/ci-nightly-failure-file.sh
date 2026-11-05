#!/usr/bin/env bash
# ci-nightly-failure-file.sh — nightly full-suite failure filing (ticket
# d6f96c89). Called by .github/workflows/nightly-full-suite.yml's
# file-failure job (if: failure()) after the full 4-shard suite ran RED on
# main. The full suite no longer runs per-PR (PRs run related-only tests,
# fail-closed), so a latent break that no PR's related set covers would
# otherwise surface as a SILENT gap until the next PR touches it — this
# step converts a red night into a durable, linkable signal.
#
# Idempotent per night: searches the repo's open issues for one titled
# "Nightly full suite failed <date>"; only creates when none exists, so a
# flaky night that goes green the next day files exactly one issue, and
# consecutive red nights keep appending to the same row.
#
# Needs: GH_TOKEN with issues:write (granted by the workflow's permissions
# block), REPO (github.repository), RUN_URL (the failed run's html_url).
# DATE is OPTIONAL and defaults to today's UTC date — do NOT pass
# github.event.schedule as DATE (that is the cron string, not a date;
# adversarial review d6f96c89, finding 2). Exits 0 on success AND on
# best-effort failure (an alerting step must never make a red run look
# better, and never mask the red with its own red).
set -u

REPO="${REPO:?REPO must be set (github.repository)}"
GH_TOKEN="${GH_TOKEN:?GH_TOKEN must be set}"
RUN_URL="${RUN_URL:?RUN_URL must be set (the failed run html_url)}"
DATE="${DATE:-$(date -u +%Y-%m-%d)}"
TITLE="Nightly full suite failed $DATE"

# Existing open issue with this exact title → append, never duplicate.
existing="$(gh issue list --repo "$REPO" --state open --limit 100 --json number,title --jq ".[] | select(.title == \"$TITLE\") | .number" 2>/dev/null | head -1)"

body="The full backend jest suite ran RED on main in the nightly scheduled run.

- Failed run: $RUN_URL
- Night (UTC): $DATE
- Filing: automatic (nightly-full-suite.yml file-failure step, ticket d6f96c89)

Since PRs run related-only tests (fail-closed scoped CI), this failure may be
latent — not covered by any open PR's related set. Please treat a red nightly
as a main-branch regression until proven otherwise: the deploy gate reuses
CI green on the merge commit, and a red main suite can block deploys.

This issue was filed automatically; close it once the suite is green again
(the next green night does NOT auto-close — a human or lane confirms)."

if [ -n "$existing" ]; then
  echo "Open issue #$existing already carries tonight's failure — appending."
  gh issue comment "$existing" --repo "$REPO" --body "$body" >/dev/null 2>&1 || true
  echo "Filed: $existing (appended)"
  exit 0
fi

url="$(gh issue create --repo "$REPO" --title "$TITLE" --body "$body" 2>/dev/null)" || {
  echo "::warning::gh issue create failed — nightly failure NOT filed. Run: $RUN_URL"
  exit 0
}
echo "Filed: $url"
exit 0
