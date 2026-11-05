#!/usr/bin/env bash
# reconcile-public-tree.test.sh — harness for scripts/publish/reconcile-public-tree.sh
# (Phase 2b Step 3, todo 439e4fe3).
#
# WHAT IS BEING PINNED
#   The tool exists so that "commit an export over the public tree" can never
#   silently DELETE a path the public repo has and the export does not. So the
#   legs are about the VERDICT, not the arithmetic:
#
#     R1  a clean superset (public ⊆ export) is SAFE                      -> 0
#     R2  one public-only path is UNSAFE and is NAMED                     -> 3
#     R3  authorizing exactly that path makes it SAFE                     -> 0
#     R4  authorizing a DIFFERENT path does NOT launder it                -> 3
#     R5  several public-only paths: authorizing one still fails the rest -> 3
#     R6  the count arithmetic reconciles: private_only - public_only == net
#     R7  a truncated GitHub tree is refused, never treated as a list     -> 2
#     R8  bad inputs are hard errors                                      -> 1/2
#     R9  the real repo's 14 public-only paths are still refused (policy leg)
#
# R9 is the POLICY leg and is the reason this file can live in the public tree:
# it names only PUBLIC paths (already published), never a private value.

set -u

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
TOOL=$ROOT/scripts/publish/reconcile-public-tree.sh

[ -x "$TOOL" ] || { echo "reconcile-public-tree.test.sh: $TOOL not executable" >&2; exit 1; }
command -v comm >/dev/null 2>&1 || { echo "reconcile-public-tree.test.sh: comm required" >&2; exit 1; }

SBX=$(mktemp -d "${TMPDIR:-/tmp}/reconcile-test.XXXXXX")
trap 'rm -rf "$SBX"' EXIT
PASS=0; FAIL=0; SKIP=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
skip(){ SKIP=$((SKIP+1)); echo "  SKIP: $1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$2] got [$3])"; fi; }

# rc <args...> — run the tool, echo its exit code, keep output in $SBX/out.
rc() { "$TOOL" "$@" >"$SBX/out" 2>&1; echo $?; }

# tree <dir> <path...> — make a dir with those files.
tree() {
  local d=$1; shift
  rm -rf "$d"; mkdir -p "$d"
  local p
  for p in "$@"; do mkdir -p "$d/$(dirname "$p")"; : > "$d/$p"; done
}

echo "=== reconcile-public-tree.test.sh ==="

# ─────────────────────────────────────────────────────────────── R1: superset
echo "-- R1 a public tree that is a SUBSET of the export is safe"
tree "$SBX/exp" a.txt b.txt c/d.txt
printf 'a.txt\nb.txt\n' > "$SBX/pub_ok.txt"
check "public ⊆ export -> SAFE" "0" "$(rc --export "$SBX/exp" --public-list "$SBX/pub_ok.txt")"
grep -q 'SAFE: every public-only path survives (0 unauthorized deletions)' "$SBX/out" \
  && ok "verdict line says SAFE/0" || bad "verdict line missing SAFE/0"

# ─────────────────────────────────────────────────────────────── R2: deletion
echo "-- R2 a public-only path is REFUSED and NAMED"
tree "$SBX/exp2" a.txt
printf 'a.txt\nONLY-PUBLIC.md\n' > "$SBX/pub_bad.txt"
check "public-only -> UNSAFE" "3" "$(rc --export "$SBX/exp2" --public-list "$SBX/pub_bad.txt")"
grep -qx '  ONLY-PUBLIC.md' "$SBX/out" && ok "the offending path is named" || bad "path not named in output"

# ─────────────────────────────────────────────────────────────── R3/R4: authorize
echo "-- R3 --authorize-delete makes THAT deletion SAFE"
check "authorized -> SAFE" "0" "$(rc --export "$SBX/exp2" --public-list "$SBX/pub_bad.txt" --authorize-delete ONLY-PUBLIC.md)"
echo "-- R4 authorizing a DIFFERENT path must not launder it"
check "wrong authorization -> still UNSAFE" "3" "$(rc --export "$SBX/exp2" --public-list "$SBX/pub_bad.txt" --authorize-delete some/other/path.md)"

# ─────────────────────────────────────────────────────────────── R5: partial
echo "-- R5 authorizing one of two public-only paths still fails the other"
tree "$SBX/exp3" a.txt
printf 'a.txt\np1.md\np2.md\n' > "$SBX/pub_two.txt"
check "partial authorization -> UNSAFE" "3" "$(rc --export "$SBX/exp3" --public-list "$SBX/pub_two.txt" --authorize-delete p1.md)"
grep -qx '  p2.md' "$SBX/out" && ok "the UNAUTHORIZED one is the one named" || bad "p2.md not named"
grep -qx '  p1.md' "$SBX/out" && bad "p1.md wrongly listed as unauthorized" || ok "the authorized one is not listed as unauthorized"
check "authorizing both -> SAFE" "0" "$(rc --export "$SBX/exp3" --public-list "$SBX/pub_two.txt" --authorize-delete p1.md --authorize-delete p2.md)"

# ─────────────────────────────────────────────────────────────── R6: arithmetic
echo "-- R6 the divergence arithmetic reconciles"
tree "$SBX/exp4" a.txt b.txt priv1.txt priv2.txt
printf 'a.txt\nb.txt\npubonly.txt\n' > "$SBX/pub4.txt"
rc --export "$SBX/exp4" --public-list "$SBX/pub4.txt" --quiet >/dev/null
rc --export "$SBX/exp4" --public-list "$SBX/pub4.txt" --authorize-delete pubonly.txt >/dev/null
check "authorized divergence -> SAFE" "0" "$(rc --export "$SBX/exp4" --public-list "$SBX/pub4.txt" --authorize-delete pubonly.txt)"
grep -qx '    - pubonly.txt' "$SBX/out" && ok "the authorized path is reported, not hidden" || bad "authorized path not reported"
# private_only emitted: priv1.txt, priv2.txt ; public_only: pubonly.txt
p=$(grep -cE '^    \+ ' "$SBX/out")
check "additions listed (2 private-only)" "2" "$p"

# ─────────────────────────────────────────────────────────────── R7: truncated tree
echo "-- R7 a TRUNCATED GitHub tree is refused (never read as a complete list)"
mkdir -p "$SBX/bin"
cat > "$SBX/bin/gh" <<'GHEOF'
#!/usr/bin/env bash
# stub: emit a tree with truncated:true
printf '%s' '{"truncated":true,"tree":[{"path":"a.txt","type":"blob"}]}'
GHEOF
chmod +x "$SBX/bin/gh"
check "truncated tree -> exit 2" "2" "$(PATH="$SBX/bin:$PATH" rc --export "$SBX/exp4" --repo owner/name)"

cat > "$SBX/bin/gh" <<'GHEOF'
#!/usr/bin/env bash
printf '%s' '{"truncated":false,"tree":[{"path":"a.txt","type":"blob"},{"path":"treeonly","type":"tree"}]}'
GHEOF
chmod +x "$SBX/bin/gh"
check "untruncated tree, blobs only (tree entry ignored) -> SAFE" "0" "$(PATH="$SBX/bin:$PATH" rc --export "$SBX/exp4" --repo owner/name)"

# ─────────────────────────────────────────────────────────────── R8: bad inputs
echo "-- R8 bad inputs are hard errors"
check "missing --export -> 1"            "1" "$(rc --public-list "$SBX/pub_ok.txt")"
check "no list and no repo -> 1"         "1" "$(rc --export "$SBX/exp4")"
check "nonexistent export dir -> 2"      "2" "$(rc --export "$SBX/nope" --public-list "$SBX/pub_ok.txt")"
check "unreadable public list -> 2"      "2" "$(rc --export "$SBX/exp4" --public-list "$SBX/does-not-exist.txt")"
mkdir -p "$SBX/emptytree"
check "empty export dir -> 2"            "2" "$(rc --export "$SBX/emptytree" --public-list "$SBX/pub_ok.txt")"

# ─────────────────────────────────────────────────────────────── R9: policy leg
echo "-- R9 the REAL public repo's public-only paths are still refused"
# Names only PUBLIC paths (already published) — never a private value.
PUBLIST=$SBX/public_only_pin.txt
printf '%s\n' \
  .github/FUNDING.yml \
  .github/ISSUE_TEMPLATE/bug_report.yml \
  .github/ISSUE_TEMPLATE/config.yml \
  .github/ISSUE_TEMPLATE/feature_request.yml \
  .github/PULL_REQUEST_TEMPLATE.md \
  .gitleaks.toml \
  CODE_OF_CONDUCT.md \
  CONTRIBUTING.md \
  LICENSE-COMMERCIAL.md \
  SECURITY.md \
  backend/scripts/backfill-coding-transcripts.test.ts \
  backend/scripts/backfill-coding-transcripts.ts \
  backend/src/modules/crossmodel/coding/transcript-source.ts \
  frontend/public/digby-imessage-agent.tar.gz > "$PUBLIST"
tree "$SBX/exp9" a.txt
check "the 14 pinned public-only paths are REFUSED one-by-one" "3" "$(rc --export "$SBX/exp9" --public-list "$PUBLIST")"
n=$(grep -cE '^  ([.A-Za-z0-9_])[^ ]*$' "$SBX/out")
check "all 14 are named" "14" "$n"
check "authorizing all 14 -> SAFE" "0" "$(rc --export "$SBX/exp9" --public-list "$PUBLIST" \
  --authorize-delete .github/FUNDING.yml \
  --authorize-delete .github/ISSUE_TEMPLATE/bug_report.yml \
  --authorize-delete .github/ISSUE_TEMPLATE/config.yml \
  --authorize-delete .github/ISSUE_TEMPLATE/feature_request.yml \
  --authorize-delete .github/PULL_REQUEST_TEMPLATE.md \
  --authorize-delete .gitleaks.toml \
  --authorize-delete CODE_OF_CONDUCT.md \
  --authorize-delete CONTRIBUTING.md \
  --authorize-delete LICENSE-COMMERCIAL.md \
  --authorize-delete SECURITY.md \
  --authorize-delete backend/scripts/backfill-coding-transcripts.test.ts \
  --authorize-delete backend/scripts/backfill-coding-transcripts.ts \
  --authorize-delete backend/src/modules/crossmodel/coding/transcript-source.ts \
  --authorize-delete frontend/public/digby-imessage-agent.tar.gz)"

echo ""
echo "=== $PASS passed, $FAIL failed, $SKIP skipped ==="
[ "$FAIL" -eq 0 ]