#!/usr/bin/env bash
# reconcile-public-tree.sh — the TWO-DIRECTION gate for Phase 2b Step 3
# (docs/PHASE2B_REPO_SWITCHOVER.md §4 "Step 3", deliverable "the pipeline must
# never DELETE public-only files on an export-over-public copy").
#
# WHY THIS EXISTS
#   export-public-tree.sh answers "what leaves the private repo". It cannot
#   answer "what does publishing that tree DO to the public repo" — and the
#   divergence is TWO-WAY, not a subset relationship. Measured at private main
#   `0d4ffe2ed` against the live public tree (GitHub tree API, truncated:false,
#   3,478 blobs) with a fresh export of 4,103 files:
#
#       paths only privately ......  639   (would be ADDED by a copy)
#       paths only publicly  ......   14   (would be DELETED by a copy)
#       net difference ...........  625   (639 - 14)
#
#   Thirteen of the fourteen are repository-hygiene files the PUBLIC repo
#   gained and the private one never had — `.github/FUNDING.yml`,
#   `.github/ISSUE_TEMPLATE/*`, `.github/PULL_REQUEST_TEMPLATE.md`,
#   `.gitleaks.toml`, `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`,
#   `LICENSE-COMMERCIAL.md`, `SECURITY.md`, three source files and one tarball.
#   NONE of them matches a `drop` rule in the scrub policy: they are absent
#   because the private repo never had them, not because the exporter strips
#   them. The fourteenth (`frontend/public/digby-imessage-agent.tar.gz`) IS
#   dropped by policy, so the export is right to omit it and the public copy is
#   the stale one.
#
#   Therefore `cp -a export/ public/` — or committing an export over the public
#   tree — SILENTLY DELETES all fourteen. This script is the gate that makes
#   that impossible to do by accident: it REFUSES unless every public-only path
#   is either present in the export or explicitly authorized as a deliberate
#   deletion.
#
# CONTRACT
#   exit 0  SAFE      — every public-only path survives (present in the export),
#                       or every one of them was named with --authorize-delete.
#   exit 3  UNSAFE    — at least one public-only path would be deleted without
#                       authorization. The offending paths are printed, one per
#                       line, so the caller can port them or authorize them.
#   exit 1  usage / environment error.
#   exit 2  an input could not be read (bad export dir, unreadable list,
#           GitHub fetch failed).
#
#   The default verdict is REFUSAL. A deletion is a deliberate act with a name
#   attached, never something a pipeline falls into.
#
# USAGE
#   scripts/publish/reconcile-public-tree.sh --export <dir> --public-list <file>
#                                           [--authorize-delete <path>]...
#   scripts/publish/reconcile-public-tree.sh --export <dir> --repo owner/name
#                                           [--authorize-delete <path>]...
#
#   --export            a tree produced by export-public-tree.sh
#   --public-list       newline-separated repo-relative paths (blobs only)
#   --repo              owner/name — read the same list from the GitHub tree API
#                       via `gh` (requires auth; the public repo is readable)
#   --authorize-delete  a public-only path this run intends to delete. Repeatable.
#                       An authorized path is reported but does not fail the run.
#   --keep              a public-only path this run intends to PRESERVE — carried
#                       forward from the public tree instead of deleted. The
#                       opposite of --authorize-delete, and both are always
#                       reported distinctly so a verdict can never read
#                       "safe to delete" about a file somebody needs. Repeatable.
#                       Use it when a public copy has legitimately diverged:
#                       e.g. a suite that asserts a private-only fixture in this
#                       repo but ships a self-contained variant publicly — the
#                       public one is the working test and deleting it would be
#                       real coverage loss.
#   --quiet             print only the verdict line
#
# Run from anywhere. Pinned by scripts/publish/reconcile-public-tree.test.sh.
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

EXPORT=
PUBLIC_LIST=
REPO=
QUIET=0
AUTHORIZED=()
KEPT=()

while [ $# -gt 0 ]; do
  case "$1" in
    --export)           EXPORT=${2:?--export needs a value}; shift 2 ;;
    --public-list)      PUBLIC_LIST=${2:?--public-list needs a value}; shift 2 ;;
    --repo)             REPO=${2:?--repo needs a value}; shift 2 ;;
    --authorize-delete) AUTHORIZED+=("${2:?--authorize-delete needs a value}"); shift 2 ;;
    --keep)             KEPT+=("${2:?--keep needs a value}"); shift 2 ;;
    --quiet)            QUIET=1; shift ;;
    -h|--help) sed -n '1,60p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "reconcile-public-tree.sh: unknown argument: $1" >&2; exit 1 ;;
  esac
done

die() { echo "reconcile-public-tree.sh: $1" >&2; exit "${2:-1}"; }
say() { [ "$QUIET" -eq 1 ] || echo "  $*"; }

[ -n "$EXPORT" ] || die "missing --export" 1
[ -n "$PUBLIC_LIST" ] || [ -n "$REPO" ] || die "missing --public-list or --repo" 1
[ -d "$EXPORT" ] || die "not a directory: $EXPORT" 2

WORK=$(mktemp -d "${TMPDIR:-/tmp}/reconcile-public.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

# ---- 1. the two file lists ---------------------------------------------------
find "$EXPORT" -type f | sed "s|^$(printf '%s' "$EXPORT" | sed 's/[\/&]/\\&/g')/||" \
  | sort > "$WORK/export.txt"
EXPORT_N=$(wc -l < "$WORK/export.txt" | tr -d ' ')
[ "$EXPORT_N" -gt 0 ] || die "export dir has no files: $EXPORT" 2

if [ -n "$PUBLIC_LIST" ]; then
  [ -r "$PUBLIC_LIST" ] || die "public list not readable: $PUBLIC_LIST" 2
  grep -v '^[[:space:]]*$' "$PUBLIC_LIST" | sed 's|^\./||; s|/$||' | sort -u > "$WORK/public.txt"
else
  command -v gh >/dev/null 2>&1 || die "gh not found (needed for --repo)" 2
  command -v python3 >/dev/null 2>&1 || die "python3 not found (needed for --repo)" 2
  gh api "repos/$REPO/git/trees/HEAD?recursive=1" > "$WORK/tree.json" 2>"$WORK/gh.err" \
    || die "GitHub tree fetch failed for $REPO: $(head -2 "$WORK/gh.err" | tr '\n' ' ')" 2
  # A TRUNCATED tree is not a list — a partial response would manufacture
  # "public-only" paths that do not exist and hide real ones. Fail closed.
  python3 - "$WORK/tree.json" > "$WORK/public.txt" <<'PY' || die "tree parse failed for $REPO" 2
import json,sys
d=json.load(open(sys.argv[1]))
if d.get("truncated"):
    sys.stderr.write("GitHub returned a TRUNCATED tree; refusing to treat it as complete\n")
    sys.exit(1)
paths=sorted({t["path"] for t in d.get("tree",[]) if t.get("type")=="blob"})
sys.stdout.write("\n".join(paths)+("\n" if paths else ""))
PY
fi
PUBLIC_N=$(wc -l < "$WORK/public.txt" | tr -d ' ')

# ---- 2. the two-way divergence ----------------------------------------------
comm -23 "$WORK/public.txt" "$WORK/export.txt" > "$WORK/public_only.txt"   # in public, not export
comm -13 "$WORK/public.txt" "$WORK/export.txt" > "$WORK/private_only.txt"  # in export, not public
comm -12 "$WORK/public.txt" "$WORK/export.txt" > "$WORK/shared.txt"
PUB_ONLY_N=$(wc -l < "$WORK/public_only.txt" | tr -d ' ')
PRIV_ONLY_N=$(wc -l < "$WORK/private_only.txt" | tr -d ' ')
SHARED_N=$(wc -l < "$WORK/shared.txt" | tr -d ' ')

# ---- 3. the verdict ---------------------------------------------------------
# Every public-only path is a DELETE candidate. It is safe only if this run
# names it explicitly. Nothing is inferred: "probably stale" is not an
# authorization, which is the whole point of the gate.
: > "$WORK/unauthorized.txt"
: > "$WORK/authorized_hit.txt"
: > "$WORK/kept_hit.txt"
# The authorization/keep sets are materialised to FILES once, then matched with a
# plain `grep -qxF -- "$p" <file>`.
#
# NEVER `printf '%s\n' "${ARR[@]}" | grep -qxF -- "$p"`. This script runs under
# `set -o pipefail`, and `grep -q` exits at the FIRST match, so `printf` is killed
# by SIGPIPE and the whole pipeline returns 141. A return value of 141 is
# non-zero, so a path that IS in the array gets scored UNAUTHORIZED — the run
# refuses a deletion it was explicitly told to make. Measured on this repo before
# the fix: 20 spurious refusals in 40 trials on an exact match (bash 5.2.15), and
# a real 276-path publish refused with 2 phantom leftovers (`40-launch-staging.sh`,
# `lane-retire-preview.js`). A safety gate that fires at random is worse than no
# gate: it trains the operator to widen the drop rules to silence it, which is the
# one thing this file's own message forbids.
if [ ${#KEPT[@]} -gt 0 ]; then printf '%s\n' "${KEPT[@]}" > "$WORK/kept.set"; else : > "$WORK/kept.set"; fi
if [ ${#AUTHORIZED[@]} -gt 0 ]; then printf '%s\n' "${AUTHORIZED[@]}" > "$WORK/auth.set"; else : > "$WORK/auth.set"; fi
if [ "$PUB_ONLY_N" -gt 0 ]; then
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    # --keep wins over --authorize-delete: a kept path is PRESERVED, never erased.
    # It is public-only only because the private repo's copy diverged (or was
    # dropped) — the public copy is the working one and the flip must carry it
    # forward from public rather than delete it. Recorded separately from
    # "authorized deletion" on purpose: those are opposites, and a verdict that
    # printed both as "safe to delete" would be the kind of comfortable lie this
    # gate exists to prevent.
    if [ "${#KEPT[@]}" -gt 0 ] && grep -qxF -- "$p" "$WORK/kept.set"; then
      printf '%s\n' "$p" >> "$WORK/kept_hit.txt"
    elif [ "${#AUTHORIZED[@]}" -gt 0 ] && grep -qxF -- "$p" "$WORK/auth.set"; then
      printf '%s\n' "$p" >> "$WORK/authorized_hit.txt"
    else
      printf '%s\n' "$p" >> "$WORK/unauthorized.txt"
    fi
  done < "$WORK/public_only.txt"
fi
UNAUTH_N=$(wc -l < "$WORK/unauthorized.txt" | tr -d ' ')
AUTH_N=$(wc -l < "$WORK/authorized_hit.txt" | tr -d ' ')
KEPT_N=$(wc -l < "$WORK/kept_hit.txt" | tr -d ' ')

say "export      : $EXPORT_N files"
say "public      : $PUBLIC_N files"
say "shared      : $SHARED_N"
say "private-only: $PRIV_ONLY_N  (would be ADDED)"
say "public-only : $PUB_ONLY_N  (in public, not in the export)"
[ "$AUTH_N" -gt 0 ] && say "  deleting $AUTH_N (authorized):" && sed 's/^/    - /' "$WORK/authorized_hit.txt"
[ "$KEPT_N" -gt 0 ] && say "  KEEPING $KEPT_N (carried forward from public, NOT deleted):" && sed 's/^/    = /' "$WORK/kept_hit.txt"
say ""

if [ "$UNAUTH_N" -gt 0 ]; then
  {
    echo "UNSAFE: an export-over-public copy would DELETE $UNAUTH_N path(s)"
    echo "that exist in the public tree and not in this export:"
    sed 's/^/  /' "$WORK/unauthorized.txt"
    echo ""
    echo "None of them matches a 'drop' rule — they are absent because the"
    echo "private repo never had them (or the public copy is the stale one)."
    echo ""
    echo "Fix by ONE of:"
    echo "  - porting the path into the private tree and re-exporting, or"
    echo "  - passing --authorize-delete <path> to record that this run MEANS to"
    echo "    delete it."
    echo ""
    echo "Never widen the drop rules to silence this gate: a drop rule is"
    echo "policy about what may LEAVE, not permission to erase what is there."
  } >&2
  exit 3
fi

# A private-only path is not a defect — it is the payload of the switchover.
if [ "$PRIV_ONLY_N" -gt 0 ]; then
  say "additions   : $PRIV_ONLY_N path(s) will be added (first 10):"
  head -10 "$WORK/private_only.txt" | sed 's/^/    + /'
  [ "$PRIV_ONLY_N" -gt 10 ] && say "    … $((PRIV_ONLY_N-10)) more"
fi

say ""
say "SAFE: every public-only path survives (0 unauthorized deletions)"
exit 0