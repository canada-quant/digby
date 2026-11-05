#!/usr/bin/env bash
# export-public-tree.test.sh — harness for scripts/publish/export-public-tree.sh
# (Phase 2b Step 0, todo 439e4fe3).
#
# TWO KINDS OF LEG, deliberately separated:
#
#   A. MECHANICS (hermetic). A throwaway git repo carries FIXTURE values and
#      FIXTURE rules. These legs prove the engine: redaction applies, drops
#      apply, the residue gate FIRES (exit 3), a failed run writes NO tree
#      (atomicity), and every rules-file error is hard (exit 2).
#
#   B. POLICY (against the REAL rules). These legs never name a real value.
#      They point the exporter at the private rules file (.digby/publish/
#      scrub-rules.txt — which the export DROPS, so it exists only in the
#      private repo) and assert:
#        - the shipped script itself is scrub-clean (it gets published, so it
#          must not carry any value the rules strip), and
#        - the real policy runs clean over the checked-out tree.
#      Leg B is why this file can be public and still prove the private policy:
#      the values live in the rules file, never here.
#
# THE MEASURED UNIVERSE (plan §2) is pinned, not assumed: the export is measured
# against the tree at a named base, because origin/main moves and every head
# gives different counts. Reference point for this harness:
#   base b8ce7f2e2 -> 4,163 tracked / 698 private-only paths / 784 same-path differ
#   (docs/PHASE2B_REPO_SWITCHOVER.md §2, §8)
# The numbers drift as main advances; a divergence figure without its base is
# meaningless, so MOST legs assert BEHAVIOUR and print the measured totals rather
# than pinning a count. The exception is deliberate: B4b/B4c DO pin counts, because
# they exist precisely to catch the plan's own headline figures (§2/§8) going stale
# — a number nothing recomputes rots. Every pinned count names the base it was
# measured at; a pin without that base would be the defect it is meant to prevent.
#
# Run from anywhere: bash scripts/publish/export-public-tree.test.sh
set -u

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SCRIPT=$ROOT/scripts/publish/export-public-tree.sh
REAL_RULES=$ROOT/.digby/publish/scrub-rules.txt

command -v git  >/dev/null 2>&1 || { echo "export-public-tree.test.sh: git required" >&2; exit 1; }
command -v perl >/dev/null 2>&1 || { echo "export-public-tree.test.sh: perl required" >&2; exit 1; }
[ -x "$SCRIPT" ] || { echo "export-public-tree.test.sh: $SCRIPT not executable" >&2; exit 1; }

SBX=$(mktemp -d "${TMPDIR:-/tmp}/export-test.XXXXXX")
trap 'rm -rf "$SBX"' EXIT

# Fixture legs export SYNTHETIC repos through the real REDACTION policy. A
# `supply` line is a PUBLICATION directive (ship this private file AS that
# public path) and cannot resolve inside a synthetic repo, so left in, every
# such leg dies at exit 2 for a reason that has nothing to do with what it
# tests. Strip publication directives for those legs; the mechanism itself is
# proven separately in A6/A6b with their own fixture rules. The legs that
# export the REAL tree keep the full policy — that is where a supply MUST
# resolve, so B2 is what catches a dangling or misaimed supply line.
FIXTURE_RULES=$SBX/real-rules-fixture.txt
if [ -r "$REAL_RULES" ]; then
  grep -v '^supply' "$REAL_RULES" > "$FIXTURE_RULES"
fi
PASS=0; FAIL=0; SKIP=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
skip(){ SKIP=$((SKIP+1)); echo "  SKIP: $1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$2] got [$3])"; fi; }

# cnt <file> <literal> — a count that is ALWAYS a bare integer. `grep -c` prints
# 0 and returns 1 on no-match, which under `|| echo 0` yields "0\n0"; and a
# missing file must read as 0 rather than as an error string.
cnt() {
  local n
  n=$(grep -a -c -F -- "$2" "$1" 2>/dev/null || true)
  n=${n:-0}; n=${n%%$'\n'*}; echo "${n:-0}"
}

echo "=== export-public-tree.test.sh ==="

# ─────────────────────────────────────────────────────────── fixture constructor
# mkrepo <dir> [secret-in-binary] — a git repo with one commit, usable as --repo.
# Fixture values are intentionally FAKE; the point is shape, not any real id.
mkrepo() {
  local d=$1 bin=${2:-0}
  mkdir -p "$d"
  git -C "$d" init -q
  git -C "$d" config user.email t@example.invalid
  git -C "$d" config user.name  fixture
  mkdir -p "$d/src" "$d/private" "$d/node_modules/dep"
  printf 'host=fake-internal-alpha token=%s\n' 'AKIAEXAMPLE123456' > "$d/src/app.txt"
  printf 'slab=203.0.113.99 peer=fake-internal-alpha\n'          > "$d/src/net.txt"
  printf 'nothing to see\n'                                     > "$d/src/clean.txt"
  printf 'secret doctrine\n'                                    > "$d/private/notes.md"
  printf 'vendored junk\n'                                      > "$d/node_modules/dep/index.js"
  # A benign binary: no redactable marker (a binary cannot be rewritten, so
  # putting one here would make EVERY leg exit 3 — see leg A5 which pins that).
  if [ "${bin:-0}" = 1 ]; then
    printf 'binary\x00fake-internal-alpha\x00tail\n'             > "$d/src/blob.bin"
  else
    printf 'binary\x00 harmless payload \x00tail\n'              > "$d/src/blob.bin"
  fi
  git -C "$d" add -A >/dev/null
  git -C "$d" commit -qm fixture
}

# fixture rules (TAB-separated, same grammar the script documents)
write_rules() {
  local f=$1 drop=${2:-1}
  {
    printf '# fixture rules\n'
    printf 'redact\tfake-internal-alpha\texample-internal\n'
    if [ "$drop" = 1 ]; then
      printf 'drop\tprivate/\n'
      printf 'drop\tnode_modules/\n'
    fi
    printf 'forbid\tinternal-label\tfake-internal-[a-z]+\t^example-internal$\n'
  } > "$f"
}

run() { # run <args...> ; captures rc/stdout/stderr
  ( cd "$SBX" && bash "$SCRIPT" "$@" ) > "$SBX/out" 2> "$SBX/err"
  echo $?
}

# ─────────────────────────────────────────────────── A1: happy path + redaction
echo "-- A1 happy path: redacts, drops, writes a tree"
mkrepo "$SBX/repo1"
write_rules "$SBX/rules1"
rc=$(run --repo "$SBX/repo1" --sha HEAD --out "$SBX/o1" --rules "$SBX/rules1")
check "exit 0" "0" "$rc"
check "tree written" "1" "$([ -d "$SBX/o1" ] && echo 1 || echo 0)"
check "redacted: marker gone from app.txt" "0" "$(cnt "$SBX/o1/src/app.txt" 'fake-internal-alpha')"
check "redacted: replacement present in app.txt" "1" "$(cnt "$SBX/o1/src/app.txt" 'example-internal')"
check "redacted: every occurrence (net.txt)" "1" "$(cnt "$SBX/o1/src/net.txt" 'example-internal')"
check "redacted: no marker left in net.txt" "0" "$(cnt "$SBX/o1/src/net.txt" 'fake-internal-alpha')"
check "drop: private/ gone" "0" "$([ -e "$SBX/o1/private" ] && echo 1 || echo 0)"
check "drop: node_modules/ gone" "0" "$([ -e "$SBX/o1/node_modules" ] && echo 1 || echo 0)"
check "untouched file survives" "1" "$(cnt "$SBX/o1/src/clean.txt" 'nothing to see')"
check "binary preserved byte-for-byte" "1" "$(cnt "$SBX/o1/src/blob.bin" 'harmless payload')"

# ───────────────────────────────────────── A2: fail-closed on surviving residue
# The value has a redact rule for something ELSE (never matches it), so it must
# survive into the gate and be REJECTED. This is the leg that makes it honest.
echo "-- A2 residue: gate rejects, exit 3, no tree"
mkrepo "$SBX/repo2"
{
  printf 'redact\tsomething-else-entirely\treplaced\n'
  printf 'forbid\tinternal-label\tfake-internal-[a-z]+\t^example-internal$\n'
} > "$SBX/rules2"
rc=$(run --repo "$SBX/repo2" --sha HEAD --out "$SBX/o2" --rules "$SBX/rules2")
check "exit 3 (fail-closed)" "3" "$rc"
check "NO tree written on failure" "0" "$([ -e "$SBX/o2" ] && echo 1 || echo 0)"
check "message says FAIL-CLOSED" "1" "$([ "$(cnt "$SBX/err" 'FAIL-CLOSED')" -gt 0 ] && echo 1 || echo 0)"
check "message names the offending file" "1" "$([ "$(cnt "$SBX/err" 'src/app.txt')" -gt 0 ] && echo 1 || echo 0)"

# A2b: an allow-regex must NOT launder a neighbouring real value on the same line.
echo "-- A2b residue: allow-regex cannot launder a neighbour"
mkrepo "$SBX/repo3"
printf 'allowed=fake-internal-public real=fake-internal-secret\n' > "$SBX/repo3/src/mixed.txt"
git -C "$SBX/repo3" add -A >/dev/null; git -C "$SBX/repo3" commit -qm mixed
# allow only the "-public" spelling; "-secret" beside it must still be fatal.
{
  printf 'redact\tsomething-else-entirely\treplaced\n'
  printf 'forbid\tinternal-label\tfake-internal-[a-z]+\t^fake-internal-public$\n'
} > "$SBX/rules3"
rc=$(run --repo "$SBX/repo3" --sha HEAD --out "$SBX/o3" --rules "$SBX/rules3")
check "exit 3 despite an allow on the same line" "3" "$rc"
check "NO tree written" "0" "$([ -e "$SBX/o3" ] && echo 1 || echo 0)"

# ───────────────────────────────────── A3: rules-file hard fails (never silent)
echo "-- A3 rules errors are hard (never a silent empty scrub)"
mkrepo "$SBX/repo4"
rc=$(run --repo "$SBX/repo4" --sha HEAD --out "$SBX/o4" --rules "$SBX/nope.txt")
check "missing rules -> exit 2" "2" "$rc"
check "NO tree written" "0" "$([ -e "$SBX/o4" ] && echo 1 || echo 0)"

{ printf 'redact\tsomething\telse\n'; } > "$SBX/rules-noforbid"
rc=$(run --repo "$SBX/repo4" --sha HEAD --out "$SBX/o4" --rules "$SBX/rules-noforbid")
check "no forbid lines -> exit 2 (a scrub with no gate is not fail-closed)" "2" "$rc"

{ printf 'forbid\tx\tfake-internal-[a-z]+$badre\n'; } > "$SBX/rules-badre"
rc=$(run --repo "$SBX/repo4" --sha HEAD --out "$SBX/o4" --rules "$SBX/rules-badre")
check "malformed regex -> exit 2" "2" "$rc"

{ printf 'bogus\tx\ty\n'; } > "$SBX/rules-bogus"
rc=$(run --repo "$SBX/repo4" --sha HEAD --out "$SBX/o4" --rules "$SBX/rules-bogus")
check "unknown directive -> exit 2" "2" "$rc"

{ printf 'forbid\tonly\tfake-internal-[a-z]+\n'; } > "$SBX/rules-noredact"
rc=$(run --repo "$SBX/repo4" --sha HEAD --out "$SBX/o4" --rules "$SBX/rules-noredact")
check "no redact lines -> exit 2 (refuses an empty scrub)" "2" "$rc"

# ───────────────────── A3b: the escape blind spot (a real defect, now pinned)
# A value written in its language's OWN literal syntax — `example-org\/crossmodel`
# inside a JS regex literal — is invisible to a rule that expects a plain `/`.
# That shipped once: 7 escaped-slug hits went out in a run that printed PASSED.
# These legs prove BOTH spellings are caught: by the redact rules where they are
# slash-agnostic, and by the gate's de-escaped backstop where they are not.
echo "-- A3b escaped-slash spelling is caught, not silently shipped"
mkrepo "$SBX/repoEsc"
cat > "$SBX/repoEsc/src/escaped.ts" <<'EOF'
export const RE = /fake-internal-alpha\/sub/i;
const split = { owner: 'fake-internal-alpha', repo: 'sub' };
const plain = 'fake-internal-alpha/sub';
EOF
git -C "$SBX/repoEsc" add -A >/dev/null; git -C "$SBX/repoEsc" commit -qm escaped
# rules whose redact knows ONLY the plain spelling — the escape must still be fatal
{
  printf 'redact\tunrelated-token\treplaced\n'
  printf 'forbid\tinternal\tfake-internal-alpha\n'
} > "$SBX/rules-esc"
rc=$(run --repo "$SBX/repoEsc" --sha HEAD --out "$SBX/oEsc" --rules "$SBX/rules-esc")
check "escaped/split/plain spellings all reach the gate -> exit 3" "3" "$rc"
check "NO tree written" "0" "$([ -e "$SBX/oEsc" ] && echo 1 || echo 0)"
check "names the escaped-slash file" "1" "$([ "$(cnt "$SBX/err" 'src/escaped.ts')" -gt 0 ] && echo 1 || echo 0)"

# A3b-2: the MUTATION-PROOF half. The leg above is not enough on its own — its
# forbid is the bare token `fake-internal-alpha`, which matches the RAW view of
# every spelling, so it stays green even if the de-escaped view is deleted. (That
# was measured: removing `$unescaped` from the gate's view list left the harness at
# 55 passed / 0 failed — a green pin over a dead backstop.) This sub-leg uses a
# forbid that REQUIRES the separator, so only the de-escaped view can match an
# escaped spelling: `fake-internal-alpha\/sub` has no `alpha/` in raw bytes.
# Delete the de-escaped view and this leg goes RED — that is its whole job.
echo "-- A3b-2 a separator-REQUIRING forbid fires only via the de-escaped view"
mkrepo "$SBX/repoEscOnly"
printf 'export const RE = /fake-internal-omega\\/sub/i;\n' > "$SBX/repoEscOnly/src/escapeonly.ts"
git -C "$SBX/repoEscOnly" add -A >/dev/null; git -C "$SBX/repoEscOnly" commit -qm escapeonly
{
  printf 'redact\tunrelated-token\treplaced\n'
  printf 'forbid\tslug\tfake-internal-omega/[a-z]+\n'
} > "$SBX/rules-esc3"
rc=$(run --repo "$SBX/repoEscOnly" --sha HEAD --out "$SBX/oEsc3" --rules "$SBX/rules-esc3")
check "escaped-only content + slash-requiring forbid -> exit 3" "3" "$rc"
check "NO tree written (the de-escaped backstop is what caught it)" "0" \
  "$([ -e "$SBX/oEsc3" ] && echo 1 || echo 0)"
check "residue names the slug class" "1" \
  "$([ "$(cnt "$SBX/err" 'slug')" -gt 0 ] && echo 1 || echo 0)"

# and the positive half: a slash-AGNOSTIC redact escapes the class cleanly
{
  printf 'redact\tfake-internal-alpha\\\\?/[A-Za-z0-9_.-]+\texample-org/repo\n'
  printf 'redact\tfake-internal-alpha\texample-org\n'
  printf 'forbid\tinternal\tfake-internal-alpha\n'
} > "$SBX/rules-esc2"
rc=$(run --repo "$SBX/repoEsc" --sha HEAD --out "$SBX/oEsc2" --rules "$SBX/rules-esc2")
check "slash-agnostic rules scrub both spellings -> exit 0" "0" "$rc"
check "no plain spelling survives" "0" "$(cnt "$SBX/oEsc2/src/escaped.ts" 'fake-internal-alpha/')"
check "no escaped spelling survives" "0" "$(cnt "$SBX/oEsc2/src/escaped.ts" 'fake-internal-alpha\/')"
check "no bare-owner spelling survives" "0" "$(cnt "$SBX/oEsc2/src/escaped.ts" 'fake-internal-alpha')"

# ───────────────── A3b-3: a redact must PRESERVE the source's own escaping
# THE BUILD-BREAKING DEFECT (Phase 2b Step 1 build proof, 2026-11-05). The
# slash-agnostic rule above MATCHES the escaped spelling `…\/…` and, before this
# leg existed, substituted an UNESCAPED `example-org/repo`. Inside a JS regex
# literal that bare `/` TERMINATES the regex, so the file stops parsing: six
# real files scored `TS1127: Invalid character` and `npm run build` exited 2 —
# while every grep-based residue check AND this whole harness called the tree
# CLEAN. The reason is structural: the gate can only see values that SURVIVE; it
# is blind to structure that got CORRUPTED. A removed backslash leaves no
# forbidden token behind, so no forbid rule can ever catch this class.
#
# The assertion is therefore about VALIDITY, not vocabulary: the exported line
# must still be a parseable regex literal, i.e. its internal slash must still be
# escaped. Revert the engine to a raw substitution and this leg goes RED.
echo "-- A3b-3 redaction preserves the source's escaping (a valid regex stays valid)"
mkrepo "$SBX/repoFid"
cat > "$SBX/repoFid/src/fid.ts" <<'EOF'
export const RE = /fake-internal-sigma\/sub/i;
const plain = 'fake-internal-sigma/sub';
EOF
git -C "$SBX/repoFid" add -A >/dev/null; git -C "$SBX/repoFid" commit -qm fid
{
  printf 'redact\tfake-internal-sigma\\\\?/[A-Za-z0-9_.-]+\texample-org/repo\n'
  printf 'redact\tfake-internal-sigma\texample-org\n'
  printf 'forbid\tsigma\tfake-internal-sigma\n'
} > "$SBX/rules-fid"
rc=$(run --repo "$SBX/repoFid" --sha HEAD --out "$SBX/oFid" --rules "$SBX/rules-fid")
check "slash-agnostic redact scrubs both spellings -> exit 0" "0" "$rc"
check "regex literal keeps its escaped slash" "1" \
  "$(cnt "$SBX/oFid/src/fid.ts" 'example-org\/repo')"
check "NO bare slash inside the regex literal (the TS1127 shape)" "0" \
  "$(cnt "$SBX/oFid/src/fid.ts" '/example-org/repo')"
check "plain string still gets a plain replacement" "1" \
  "$(cnt "$SBX/oFid/src/fid.ts" "'example-org/repo'")"

# ───── A3b-4: a redact/forbid must police the class CASE-INSENSITIVELY
# THE LEAK (Phase 2b export-CI run, 2026-11-05). GitHub resolves owner slugs
# case-insensitively (a Mixed-Case owner spelling IS the same account as the
# lowercase one), and the private tree genuinely carries mixed-case spellings
# in fixtures (one case-variant isolation pin alone had three). The rules were
# lowercase-only, so BOTH the redact and the forbid missed them: 9 source
# files shipped the owner's real handle into the export while the gate
# printed PASSED — the residue scan is case-sensitive too, so it can never
# see the spelling it does not know. Same blind shape as A3b-3: the gate
# only sees spellings it was told about.
#
# TWO directions, both load-bearing:
#   1. the REAL fix — (?i) redacts scrub the mixed-case spelling, and
#   2. the MUTATION — with the (?i) reverted, the export MUST fail closed
#      (exit 3), because the case-insensitive forbid is the backstop that
#      catches a redact which misses a case variant. A gate that let the
#      spelling through would print PASSED while leaking: that is the
#      exact defect this leg pins.
echo "-- A3b-4 case variants are scrubbed, and a case-blind redact fails CLOSED"
mkrepo "$SBX/repoCase"
cat > "$SBX/repoCase/src/case.ts" <<'EOF'
export const PROD_A = 'Fake-Internal-Sigma/sub';
export const PROD_B = 'fake-internal-sigma/sub';
export const PROD_C = 'FAKE-INTERNAL-SIGMA/sub';
EOF
git -C "$SBX/repoCase" add -A >/dev/null; git -C "$SBX/repoCase" commit -qm case
# the FIXED shape: (?i) on both the redact and the forbid
{ printf 'redact\t(?i)fake-internal-sigma\\\\?/[A-Za-z0-9_.-]+\texample-org/repo\n'
  printf 'redact\t(?i)fake-internal-sigma\texample-org\n'
  printf 'forbid\tsigma\t(?i)fake-internal-sigma\t\n'
} > "$SBX/rules-case"
rc=$(run --repo "$SBX/repoCase" --sha HEAD --out "$SBX/oCase" --rules "$SBX/rules-case")
check "case-insensitive rules scrub every spelling -> exit 0" "0" "$rc"
check "Mixed-Case spelling scrubbed" "0" "$(cnt "$SBX/oCase/src/case.ts" 'Fake-Internal-Sigma')"
check "UPPERCASE spelling scrubbed" "0" "$(cnt "$SBX/oCase/src/case.ts" 'FAKE-INTERNAL-SIGMA')"
check "lowercase spelling scrubbed" "0" "$(cnt "$SBX/oCase/src/case.ts" 'fake-internal-sigma')"
# the MUTATION: exactly the pre-fix rules (no (?i) anywhere). The redact misses
# the case variants; the forbid — which keeps its (?i) here — must catch them.
{ printf 'redact\tfake-internal-sigma\\\\?/[A-Za-z0-9_.-]+\texample-org/repo\n'
  printf 'redact\tfake-internal-sigma\texample-org\n'
  printf 'forbid\tsigma\t(?i)fake-internal-sigma\t\n'
} > "$SBX/rules-case-mut"
rc=$(run --repo "$SBX/repoCase" --sha HEAD --out "$SBX/oCaseMut" --rules "$SBX/rules-case-mut")
check "case-blind redact + case-aware forbid -> exit 3 (fail CLOSED, never PASSED-while-leaking)" "3" "$rc"
check "NO tree written by the fail-closed mutation" "0" "$([ -e "$SBX/oCaseMut" ] && echo 1 || echo 0)"
rm -rf "$SBX/repoCase" "$SBX/oCase" "$SBX/oCaseMut" "$SBX/rules-case" "$SBX/rules-case-mut"

# ───────────────────────────────────── A3c: an unterminated final rules line
# A rules file with NO trailing newline silently lost its last line — that is how
# the `forbid sealed-box` rule vanished while the export still reported PASSED.
# The parser must consume the unterminated tail, and prove it did.
echo "-- A3c unterminated final rules line is still loaded (never dropped)"
mkrepo "$SBX/repoTail"
printf 'carrier=fake-internal-omega\n' > "$SBX/repoTail/src/tail.txt"
git -C "$SBX/repoTail" add -A >/dev/null; git -C "$SBX/repoTail" commit -qm tail
{ printf 'redact\tunrelated-token\treplaced\n'
  printf 'forbid\ttail-class\tfake-internal-omega\n'; } > "$SBX/rules-tail"
# strip the trailing newline so the LAST rule sits on an unterminated line
perl -i -pe 'chomp if eof' "$SBX/rules-tail"
check "fixture rules really are unterminated" "1" \
  "$([ -n "$(tail -c1 "$SBX/rules-tail")" ] && echo 1 || echo 0)"
rc=$(run --repo "$SBX/repoTail" --sha HEAD --out "$SBX/oTail" --rules "$SBX/rules-tail")
check "last line was PARSED, so its class fires -> exit 3" "3" "$rc"
check "NO tree written" "0" "$([ -e "$SBX/oTail" ] && echo 1 || echo 0)"
mkrepo "$SBX/repo5"; write_rules "$SBX/rules5"
mkdir -p "$SBX/o5"; printf 'precious\n' > "$SBX/o5/keep.txt"
rc=$(run --repo "$SBX/repo5" --sha HEAD --out "$SBX/o5" --rules "$SBX/rules5")
check "exit 1 on existing --out" "1" "$rc"
check "existing dir untouched" "1" "$(cnt "$SBX/o5/keep.txt" 'precious')"

# ───────────────────────────────────── A5: an unredactable marker is FATAL
# A binary cannot carry a substitution. A marker inside one must abort the run —
# never ship silently. This is the property the first draft of this harness got
# wrong (the fixture put a marker in a binary and every other leg went red).
echo "-- A5 unredactable binary carrying a marker -> exit 3, no tree"
mkrepo "$SBX/repo6" 1
write_rules "$SBX/rules6"
rc=$(run --repo "$SBX/repo6" --sha HEAD --out "$SBX/o6" --rules "$SBX/rules6")
check "exit 3 (a binary hit is fatal, never a silent ship)" "3" "$rc"
check "NO tree written" "0" "$([ -e "$SBX/o6" ] && echo 1 || echo 0)"
check "message names the binary" "1" "$([ "$(cnt "$SBX/err" 'blob.bin')" -gt 0 ] && echo 1 || echo 0)"

# ─────────────────────────────── A6: supply (policy REPLACEMENT, §3b-B)
# The flip tree is not the private tree with holes cut in it. Dropping the
# private (deploy-testing) ci.yml without SUPPLYING the public build-only one
# leaves a tree with no CI at all — green by absence. These legs pin the
# replacement mechanism itself: it publishes, it never overwrites, and a
# dangling source is a hard policy error rather than a silent skip.
echo "-- A6 supply publishes a private file AS a public path"
mkrepo "$SBX/repoSup"
printf 'name: PRIVATE\non: [push]\n'  > "$SBX/repoSup/.ci-private.yml"
printf 'name: PUBLIC\non: [push]\n'   > "$SBX/repoSup/ci-public.yml"
git -C "$SBX/repoSup" add -A >/dev/null; git -C "$SBX/repoSup" commit -qm supplysrc
{
  printf 'redact\tfake-internal-alpha\texample-internal\n'
  printf 'forbid\tinternal-label\tfake-internal-[a-z]+\t^example-internal$\n'
  printf 'drop\t.ci-private.yml\n'
  # The SOURCE must also be dropped, or it ships at its own path too. In the
  # real policy that is not a special rule: the source lives under .digby/,
  # which the export drops wholesale — the supply reads it from GIT, not from
  # the staged tree, so a dropped source is still publishable.
  printf 'drop\tci-public.yml\n'
  printf 'supply\tci-public.yml\t.ci/app.yml\n'
} > "$SBX/rules-sup"
rc=$(run --repo "$SBX/repoSup" --sha HEAD --out "$SBX/oSup" --rules "$SBX/rules-sup")
check "supply: exit 0" "0" "$rc"
check "supply: the private source is NOT published at its own path" "0" \
  "$([ -e "$SBX/oSup/.ci-private.yml" ] && echo 1 || echo 0)"
check "supply: the replacement IS published at the dest" "1" \
  "$([ -e "$SBX/oSup/.ci/app.yml" ] && echo 1 || echo 0)"
check "supply: dest carries the SOURCE bytes" "PUBLIC" \
  "$(head -1 "$SBX/oSup/.ci/app.yml" 2>/dev/null | sed 's/^name: //')"
check "supply: the private original was dropped, not merely copied" "0" \
  "$([ -e "$SBX/oSup/ci-public.yml" ] && echo 1 || echo 0)"

echo "-- A6b supply fails CLOSED (missing source / occupied dest)"
{
  printf 'redact\tfake-internal-alpha\texample-internal\n'
  printf 'forbid\tinternal-label\tfake-internal-[a-z]+\t^example-internal$\n'
  printf 'supply\tnonexistent.yml\t.ci/app.yml\n'
} > "$SBX/rules-sup-missing"
rc=$(run --repo "$SBX/repoSup" --sha HEAD --out "$SBX/oSup2" --rules "$SBX/rules-sup-missing")
check "supply: a missing source is exit 2 (policy error, not a skip)" "2" "$rc"
check "supply: NO tree written on a missing source" "0" \
  "$([ -e "$SBX/oSup2" ] && echo 1 || echo 0)"

# A dest that the tree ALREADY carries is an ambiguous double-write: refuse.
{
  printf 'redact\tfake-internal-alpha\texample-internal\n'
  printf 'forbid\tinternal-label\tfake-internal-[a-z]+\t^example-internal$\n'
  printf 'supply\tci-public.yml\tsrc/app.txt\n'
} > "$SBX/rules-sup-clash"
rc=$(run --repo "$SBX/repoSup" --sha HEAD --out "$SBX/oSup3" --rules "$SBX/rules-sup-clash")
check "supply: an existing dest is exit 2 (never a silent overwrite)" "2" "$rc"

# An absolute dest is meaningless inside an export — reject at parse time.
{
  printf 'redact\tfake-internal-alpha\texample-internal\n'
  printf 'forbid\tinternal-label\tfake-internal-[a-z]+\t^example-internal$\n'
  printf 'supply\tci-public.yml\t/etc/passwd\n'
} > "$SBX/rules-sup-abs"
rc=$(run --repo "$SBX/repoSup" --sha HEAD --out "$SBX/oSup4" --rules "$SBX/rules-sup-abs")
check "supply: an absolute dest is exit 2" "2" "$rc"

# ───────────────────────────────────────────────────── B1: the script is clean
# The script ships in the export, so the REAL policy must find nothing in it.
# Proves the redaction-cleanliness of the deliverable without naming a value here.
echo "-- B1 the shipped script passes the REAL policy"
if [ -r "$REAL_RULES" ]; then
  mkdir -p "$SBX/selfrepo/scripts/publish"
  cp "$SCRIPT" "$SBX/selfrepo/scripts/publish/"
  git -C "$SBX/selfrepo" init -q
  git -C "$SBX/selfrepo" config user.email t@example.invalid
  git -C "$SBX/selfrepo" config user.name  fixture
  git -C "$SBX/selfrepo" add -A >/dev/null
  git -C "$SBX/selfrepo" commit -qm self
  rc=$(run --repo "$SBX/selfrepo" --sha HEAD --out "$SBX/o7" --rules "$FIXTURE_RULES")
  check "shipped script is scrub-clean under the real rules" "0" "$rc"
else
  # A PUBLIC clone has no .digby/ (the export drops it), so the private policy
  # is legitimately absent there. Skip LOUDLY — never a silent pass, and never a
  # red build on the public side over a file the private side owns.
  skip "real rules absent (${REAL_RULES#$ROOT/}) — private-policy legs skipped"
fi

# ───────────────────────────────────────────────────── B2: real tree is clean
# The standing guard: the checked-out tree must pass the real policy. This is the
# leg that turns "the scrub is a program" into "the scrub is enforced".
echo "-- B2 the real tree passes the REAL policy"
if [ -r "$REAL_RULES" ]; then
  rc=$(run --repo "$ROOT" --sha HEAD --out "$SBX/o8" --rules "$REAL_RULES" --report)
  check "checked-out tree is scrub-clean" "0" "$rc"
  # Report the measured universe rather than asserting a brittle count (main moves).
  if grep -q 'exported' "$SBX/out"; then
    echo "  measured: $(grep -E 'exported|dropped|redacted' "$SBX/out" | tr -s ' ' | tr '\n' ' ')"
  fi
else
  skip "real rules absent — cannot prove the tree is clean (public clone)"
fi

# ─────────── B2b: the REAL rules file must POLICE the owner class everywhere
# WHY THIS LEG EXISTS (independent review, 2026-11-05 — a blocking finding).
# Every leg above and below this one pins the ENGINE, using fixture rules the
# leg writes itself. Not one of them asserted anything about the CONTENT of the
# real policy file — and the reviewer proved what that costs: revert `(?i)` on
# both the redact and the forbid in `.digby/publish/scrub-rules.txt` (the exact
# pre-fix shape) and this harness still reports "68 passed, 0 failed", while the
# export ships the owner's real handle. A green harness over a reverted policy is
# the precise false confidence that let that leak ship twice.
#
# The owner token is therefore READ FROM THE RULES FILE at runtime, never written
# here: this harness is itself exported, so a literal would bake the very value
# the scrub exists to remove into the public copy. (Every other fixture in this
# file is `fake-internal-*` for the same reason.)
#
# Both assertions are content checks, so they RED on a revert:
#   - drop `(?i)` and the first fails;
#   - narrow the separator class and the second fails;
#   - and the functional leg below independently catches either, because a
#     spelling the policy does not name SURVIVES into the output tree.
echo "-- B2b the REAL rules police the owner class in every spelling and case"
if [ -r "$REAL_RULES" ]; then
  # The bare-owner redact line: `redact <regex> example-org` (only that one has
  # the bare `example-org` replacement; the slug rules map to `example-org/x`).
  owner_re=$(awk -F'\t' '$1=="redact" && $3=="example-org" {print $2; exit}' "$REAL_RULES")
  if [ -z "$owner_re" ]; then
    bad "no bare-owner redact rule found in the real policy (want a 'redact … example-org' line)"
  else
    check "owner redact is case-insensitive" "1" \
      "$(case "$owner_re" in '(?i)'*) echo 1;; *) echo 0;; esac)"
    check "owner redact polices the '-', '_' and ' ' separator spellings" "1" \
      "$(case "$owner_re" in *'[-_ ]'*) echo 1;; *) echo 0;; esac)"

    # Functionally: build a fixture carrying every spelling of the SAME account
    # and export it with the REAL policy. A spelling the policy does not know
    # survives into the tree — that is the leak, and it must read as residue.
    base=$(printf '%s' "$owner_re" | sed -e 's/^(?i)//' -e 's/\[-_ \]/-/')
    variants=$(perl -e 'my $b=shift; my $u=uc($b);
      my $c=join("-", map { ucfirst } split /-/, $b);
      (my $s=$b)=~s/-/_/g; (my $p=$b)=~s/-/ /g;
      print "$_\n" for ($b,$u,$c,$s,$p);' "$base")
    mkdir -p "$SBX/owner/src"
    printf '%s\n' "$variants" > "$SBX/owner/src/owner.txt"
    git -C "$SBX/owner" init -q
    git -C "$SBX/owner" config user.email t@example.invalid
    git -C "$SBX/owner" config user.name  fixture
    git -C "$SBX/owner" add -A >/dev/null
    git -C "$SBX/owner" commit -qm owner
    rc=$(run --repo "$SBX/owner" --sha HEAD --out "$SBX/oOwner" --rules "$FIXTURE_RULES")
    check "every owner spelling is scrubbed by the REAL policy -> exit 0" "0" "$rc"
    owner_rx=$(printf '%s' "$base" | sed 's/-/[-_ ]/g')
    surv=$(grep -a -E -i -c "$owner_rx" "$SBX/oOwner/src/owner.txt" 2>/dev/null || true)
    check "no owner spelling survives into the exported tree" "0" "${surv:-0}"
    rm -rf "$SBX/owner" "$SBX/oOwner"
  fi
else
  skip "real rules absent — cannot prove the OWNER CLASS is policed (public clone)"
fi

# ─────────── B2c: the owner class must have ONE canonical owner (no desync)
# WHY THIS LEG EXISTS (todo 13069ce2, 2026-11-05). The owner class carried TWO
# replacements for the SAME logical repo: the combined-slug rule mapped
# `<owner>/crossmodel -> canada-quant/digby` while the bare-owner rule mapped the
# owner alone to `example-org`. Rules 28-37 all preserve the repo and scrub only
# the owner, so rule 27 was the single inconsistency — and it had two costs:
#
#   1. ONE repo came out under TWO owners depending on how a string was spelled.
#      A fixture written `owner:'<owner>', repo:'crossmodel'` (two literals, each
#      matched by the BARE rule) became `example-org/crossmodel`, while the same
#      fixture's expectation, written as the contiguous slug (matched by rule 27),
#      became `canada-quant/digby`. 12 exported tests failed on that desync alone.
#   2. `canada-quant/digby` is a REAL repository of the owner's, so the rule
#      violated this file's own doctrine (above): a replacement must read as
#      DOCUMENTATION, never as another real value.
#
# The assertion is derived from the policy at runtime — never a literal, since
# this harness is itself exported. Every owner-class replacement must carry the
# canonical owner, so re-introducing a second owner REDS here.
echo "-- B2c the owner class has ONE canonical owner"
if [ -r "$REAL_RULES" ]; then
  canon=$(awk -F'\t' '$1=="redact" && $3=="example-org" {print $3; exit}' "$REAL_RULES")
  if [ -z "$canon" ]; then
    bad "no canonical owner rule found (want a 'redact … example-org' line)"
  else
    # THE AUDIT IS CLASS-TOTAL: selection is by the owner token ANYWHERE in the
    # pattern, never by a prefix and never by the replacement.
    # Two measured failures drove this (independent review, 2026-11-05):
    #   v1 selected by REPLACEMENT (`$3 ~ /^example-org/`) -> a rule rewritten to
    #      a SECOND owner was excluded from the audit instead of flagged; the leg
    #      reported "75 passed" under its own mutation.
    #   v2 selected by PREFIX (`index($2,p)==1`) -> `(?i)(?:\b)pasta[-_ ]paul\?/optcg`
    #      rewritten to `canada-quant/digby` is conforming-but-differently-written
    #      and was EXCLUDED again: green, 70 passed. Same blind shape, one level in.
    # Matching the token ANYWHERE makes the audit total: any redact rule that
    # mentions the owner regex at all is subject to the canonical-owner check,
    # however it is anchored or wrapped.
    owner_rx=$(awk -F'\t' '$1=="redact" && $3=="example-org" {print $2; exit}' "$REAL_RULES")
    n_rules=$(awk -F'\t' -v p="$owner_rx" '
      $1=="redact" && index($2, p) > 0 {n++}
      END { print n+0 }' "$REAL_RULES")
    check "the owner class has more than one rule (sanity: the scan saw them)" "1" \
      "$([ "${n_rules:-0}" -gt 1 ] && echo 1 || echo 0)"
    off=$(awk -F'\t' -v p="$owner_rx" -v c="$canon" '
      $1=="redact" && index($2, p) > 0 {
        if ($3 != c && substr($3, 1, length(c) + 1) != c "/") {
          bad++; printf "%s -> %s\n", $2, $3 > "/dev/stderr"
        }
      }
      END { print bad+0 }' "$REAL_RULES" 2>"$SBX/offowner.txt")
    check "every owner-class replacement carries the ONE canonical owner" "0" "${off:-0}"
    # REPO-NAME CANONICALITY (review finding, 2026-11-05 — a real defect).
    # A rule may RENAME a repo (`<owner>/cql-accelerator -> example-org/cql-accelerator`)
    # while the bare-owner rule leaves repo names alone, so a contiguous slug and a
    # split `owner`/`repo` pair land on DIFFERENT strings — the dual-owner desync
    # again, one field over. Wherever a slug rule renames its repo, a companion
    # rule must map the BARE repo name to the same canonical value; otherwise the
    # two spellings diverge. Derived from the policy at runtime, no literals.
    offrepo=$(awk -F'\t' -v c="$canon" '
      $1=="redact" && substr($3,1,length(c)+1)==c "/" {
        # repo as it appears in the pattern (last path segment) and in the
        # replacement; when they differ the rule renames the repo.
        p=$2; sub(/.*[\/]/, "", p); sub(/[\\\\].*/, "", p);
        r=$3; sub(/.*\//, "", r);
        if (p != r && length(p) > 2) { want[p]=r; cnt++ }
      }
      END { for (k in want) print k "\t" want[k]; }' "$REAL_RULES" > "$SBX/renamed.tsv")
    renamed=$(wc -l < "$SBX/renamed.tsv" | tr -d ' ')
    offrepo=0
    # Normalize a repo segment from EITHER side before comparing: strip the case
    # flag / anchors / escapes and collapse the separator class back to a hyphen.
    # Without this the check compares `cql[-_ ]agx[-_ ]orin64` (pattern form)
    # against `cql-accelerator` (literal form) and calls every rule a rename —
    # measured: my first version reported 2 phantom failures on healthy policy.
    norm_repo() { sed -e 's/(?i)//g' -e 's/\\b//g' -e 's/\\\\?//g' -e 's/\\//g' -e 's/\[-_ \]/-/g'; }
    while IFS="$(printf '\t')" read -r from to; do
      [ -z "$from" ] && continue
      case "$from" in *'['*) continue ;; esac   # a generic char class is not a rename
      from_n=$(printf '%s' "$from" | norm_repo)
      owner_n=$(printf '%s' "$owner_rx" | norm_repo)
      to_n=$(printf '%s' "$to" | norm_repo)
      [ "$from_n" = "$to_n" ] && continue        # rule preserves the repo: nothing to pin
      # Normalize the PATTERN side too before searching: the companion rule
      # writes the repo with its separator CLASS (`cql[-_ ]agx[-_ ]orin64`), so a
      # literal index() against `cql-accelerator` finds nothing and the check
      # calls a healthy policy broken. Build a normalized view of every redact
      # rule once, then match on it.
      # EXCLUDE the renaming rule itself. A slug rule's pattern contains the
      # bare repo name too, so without this the rule satisfies its own
      # companion requirement: measured, M2 (rename optcg -> optcg-renamed with
      # no companion) stayed GREEN. The companion must be a BARE-name rule, so
      # a candidate whose pattern also carries the owner token is skipped.
      have=$(awk -F'\t' '$1=="redact" {print $2 "\t" $3}' "$REAL_RULES" \
        | norm_repo \
        | while IFS="$(printf '\t')" read -r pc rep; do
            case "$pc" in *"$from_n"*) ;; *) continue ;; esac
            case "$pc" in *"$owner_n"*) continue ;; esac
            case "$rep" in *"$to_n"*) printf '%s\n' "$rep"; break ;; esac
          done)
      if [ -z "$have" ]; then
        offrepo=$((offrepo+1)); echo "renamed repo '$from_n' -> '$to_n' has no bare-name companion rule" >&2
      fi
    done < "$SBX/renamed.tsv"
    check "every renamed repo has a bare-name companion rule (split and contiguous agree)" "0" "$offrepo"
    # FUNCTIONAL convergence, independent of rule shape: a fixture carrying the
    # CONTIGUOUS slug must come out with its repo name intact, so that a
    # split-literal fixture (`owner:'…', repo:'crossmodel'`, where the BARE rule
    # matches each literal) and a contiguous-slug fixture land on the SAME value.
    # The slug is derived from the policy at runtime — never written here, since
    # this harness is itself exported.
    slug_base=$(printf '%s' "$owner_rx" | sed -e 's/^(?i)//' -e 's/\[-_ \]/-/')
    mkdir -p "$SBX/conv/src"
    printf '%s/crossmodel\n' "$slug_base" > "$SBX/conv/src/slug.txt"
    git -C "$SBX/conv" init -q
    git -C "$SBX/conv" config user.email t@example.invalid
    git -C "$SBX/conv" config user.name  fixture
    git -C "$SBX/conv" add -A >/dev/null
    git -C "$SBX/conv" commit -qm conv
    conv_rc=$(run --repo "$SBX/conv" --sha HEAD --out "$SBX/oConv" --rules "$FIXTURE_RULES")
    check "the convergence fixture exports cleanly -> exit 0" "0" "$conv_rc"
    kept=$(cnt "$SBX/oConv/src/slug.txt" "crossmodel")
    check "the contiguous slug keeps its repo name (split and contiguous agree)" "1" "${kept:-0}"
    rm -rf "$SBX/conv" "$SBX/oConv"
  fi
else
  skip "real rules absent — cannot prove the owner class is de-duplicated"
fi

# ─────────── B2d: the HOST LABEL is policed in every case it can be spelled
# WHY THIS LEG EXISTS (todo 13069ce2, 2026-11-05 — measured, then pinned).
# The host-label rules were case-SENSITIVE, so only the capitalised spelling was
# rewritten. The LOWERCASE spelling survived into a real export in 4 files — and
# the gate still printed "scrub PASSED", because a gate can only see the
# spellings its own rules name. That is the same case-blind shape as the
# owner-handle leak, and it is why asserting "the policy is right" by READING it
# is not enough: this leg exports a fixture with every spelling and checks what
# actually survives.
#
# NOTE ON THIS COMMENT BLOCK: it deliberately never spells the label. This file
# is itself EXPORTED, so a literal here is a literal in the public tree — and a
# literal wrapped in backslash-b (`\bTOKEN\b`) is invisible to the very rule
# that polices it, because the preceding `b` is a word character and so supplies
# no word boundary. The same applies to `TOKEN_` in an identifier: `_` is a word
# character too. Widening the rule to a bare substring is NOT the answer — that
# class of over-redaction would rewrite base64 integrity hashes in
# `package-lock.json` (measured), which is exactly what leg B3 exists to
# prevent. So the rule stays boundary-anchored and the prose names no token.
#
# THE SECOND HALF OF THIS LEG IS A GUARD, NOT A GAP. Widening the model-family
# token the same way would be WRONG, and the measurement says so: it is ALSO a
# public model-family word (`model-catalog.ts` `[/mimo|xiaomi/i, 'mimo']`, the
# registry id `mimo-v26-flash-RL`). A blanket case-insensitive rule rewrites all
# of them to `node-b`, corrupting the exported code's model classification —
# worse than the label leak it would fix. So this leg pins BOTH directions: the
# host label goes in every case, and the public model spelling SURVIVES
# untouched. Without the second assertion a future "fix" could widen it, keep
# this leg green, and silently mangle the export.
echo "-- B2d the REAL rules police the host label in every case, without eating public model ids"
# THE TOKENS ARE DERIVED FROM THE POLICY AT RUNTIME, never written here. This
# harness is itself EXPORTED, so a literal would bake the very label the scrub
# exists to remove into the public copy — the same rule leg B2b already follows
# for the owner handle. A first cut of this leg DID use literals, and the export
# caught it: the scrub rewrote the fixture to the replacement, so the exported
# leg would have asserted that `node-a` survives being "redacted" to `node-a`;
# and a variable NAME carrying the token plus an underscore leaked, because `_`
# is a word character and therefore supplies no word boundary. Deriving fixes
# both, and this comment names no token for the same reason.
if [ -r "$REAL_RULES" ]; then
  host_re=$(awk -F'\t' '$1=="redact" && $3=="node-a" {print $2; exit}' "$REAL_RULES")
  key_re=$(awk -F'\t' '$1=="redact" && $3=="node-a-key" {print $2; exit}' "$REAL_RULES")
  label_b_re=$(awk -F'\t' '$1=="redact" && $3=="node-b" {print $2; exit}' "$REAL_RULES")
  # Recover the bare TOKEN by stripping the inline flag and the boundary asserts.
  tok() { printf '%s' "$1" | sed -e 's/^(?i)//' -e 's/\\b//g'; }
  host_tok=$(tok "$host_re")
  key_tok=$(tok "$key_re")
  label_b_tok=$(tok "$label_b_re")
  if [ -z "$host_tok" ]; then
    bad "no host-label redact rule found in the real policy"
  else
    check "the host-label redact is case-insensitive" "1" \
      "$(case "$host_re" in '(?i)'*) echo 1;; *) echo 0;; esac)"

    # EVERY case spelling, generated from the LOWERCASED token regardless of how
    # the rule spells it. Deriving the cases from the rule's own case would
    # defeat the pin: revert `(?i)` and the fixture would carry only the
    # uppercase form, which the reverted rule still redacts — the leg would stay
    # green over the very bug it exists to catch (verified by mutation).
    lower=$(printf '%s' "$host_tok" | tr 'A-Z' 'a-z')
    upper=$(printf '%s' "$lower" | tr 'a-z' 'A-Z')
    cap=$(printf '%s' "$lower" | perl -pe 's/^(.)/\U$1/')

    # Functional: every spelling of the SAME host, exported through the REAL
    # policy. A spelling the policy does not name SURVIVES — that is the leak.
    mkdir -p "$SBX/host/src"
    {
      printf '%s is the label\n' "$lower"
      printf '%s is the label\n' "$upper"
      printf '%s is the label\n' "$cap"
      [ -n "$key_tok" ] && printf '/var/.scratch-%s/ts-recovery\n' "$key_tok"
      [ -n "$label_b_tok" ] && printf '%s is the other label\n' "$label_b_tok"
    } > "$SBX/host/src/host.txt"
    git -C "$SBX/host" init -q
    git -C "$SBX/host" config user.email t@example.invalid
    git -C "$SBX/host" config user.name  fixture
    git -C "$SBX/host" add -A >/dev/null
    git -C "$SBX/host" commit -qm host
    rc=$(run --repo "$SBX/host" --sha HEAD --out "$SBX/oHost" --rules "$FIXTURE_RULES")
    check "every host-label spelling is scrubbed by the REAL policy -> exit 0" "0" "$rc"
    for spelling in "$lower" "$upper" "$cap"; do
      surv=$(grep -a -c -F -- "$spelling" "$SBX/oHost/src/host.txt" 2>/dev/null || true)
      check "no '$spelling' spelling survives into the exported tree" "0" "${surv:-0}"
    done
    if [ -n "$key_tok" ]; then
      # No word boundary before this token (`k` follows the token's own tail and
      # `-`/`.`/`/` precede it), so it needs its own rule — and its own check.
      surv=$(grep -a -c -F -- "$key_tok" "$SBX/oHost/src/host.txt" 2>/dev/null || true)
      check "no unscoped '${key_tok}' spelling survives into the exported tree" "0" "${surv:-0}"
    fi

    # The over-redaction half: a public model spelling must come through
    # UNTOUCHED. This is what makes widening the model-family token a failing
    # change. These literals are PUBLIC already (shipped model ids and the
    # catalog's own family rules), so naming them here leaks nothing.
    printf 'family: mimo\nmimo-v26-flash-RL\n' > "$SBX/host/src/model.txt"
    git -C "$SBX/host" add -A >/dev/null
    git -C "$SBX/host" commit -qm model
    rm -rf "$SBX/oHost2"
    rc=$(run --repo "$SBX/host" --sha HEAD --out "$SBX/oHost2" --rules "$FIXTURE_RULES")
    check "a tree carrying public model ids still exports cleanly -> exit 0" "0" "$rc"
    check "public model family token SURVIVES (never widened to a host label)" "1" \
      "$(cnt "$SBX/oHost2/src/model.txt" 'family: mimo')"
    check "public model id SURVIVES verbatim" "1" \
      "$(cnt "$SBX/oHost2/src/model.txt" 'mimo-v26-flash-RL')"
    rm -rf "$SBX/host" "$SBX/oHost" "$SBX/oHost2"
  fi
else
  skip "real rules absent — cannot prove the HOST LABEL is policed"
fi

# ─────────────────────────── B3: the rules must not launder by over-redaction
# THE BUG THIS PINS (found by inspection before it shipped): a blanket
# `/digby/ → /example/` rule rewrote `refs/heads/digby/session-abc` (a PUBLIC
# branch-ref convention) and `/opt/digby/...` (the self-host prefix), and because
# it rewrote them BEFORE the gate ran, the `/example/...` allow-list then blessed
# the corruption as "clean". A scrub that mangles public content and reports
# success is worse than no scrub. These strings are public already (the public
# tree ships refs/heads/digby/ in 10 files), so naming them here leaks nothing.
echo "-- B3 real rules preserve public 'digby' spellings (no over-redaction)"
if [ -r "$REAL_RULES" ]; then
  mkdir -p "$SBX/passthru/src"
  cat > "$SBX/passthru/src/refs.txt" <<'EOF'
refs/heads/digby/session-abc
origin/digby/session-x
ExecStart=/opt/digby/scripts/selfhost/auto-update.sh
EOF
  git -C "$SBX/passthru" init -q
  git -C "$SBX/passthru" config user.email t@example.invalid
  git -C "$SBX/passthru" config user.name  fixture
  git -C "$SBX/passthru" add -A >/dev/null
  git -C "$SBX/passthru" commit -qm passthru
  rc=$(run --repo "$SBX/passthru" --sha HEAD --out "$SBX/o9" --rules "$FIXTURE_RULES")
  check "exit 0" "0" "$rc"
  check "branch ref preserved verbatim" "1" "$(cnt "$SBX/o9/src/refs.txt" 'refs/heads/digby/session-abc')"
  check "remote-tracking ref preserved" "1" "$(cnt "$SBX/o9/src/refs.txt" 'origin/digby/session-x')"
  check "self-host prefix preserved" "1" "$(cnt "$SBX/o9/src/refs.txt" '/opt/digby/scripts/selfhost/auto-update.sh')"
  check "none of them rewritten to /example/" "0" "$(cnt "$SBX/o9/src/refs.txt" '/example/')"
else
  skip "real rules absent — over-redaction leg skipped (public clone)"
fi

# ─────────────────────── B4: the measured universe is PINNED, not remembered
# WHY THIS LEG EXISTS (review item 9). Until now the "698 private-only paths"
# figure lived only in this file's header comment — a number quoted down from
# the plan, never computed by anything that runs. A pinned measurement that
# nothing recomputes silently rots the moment main moves, and the export's whole
# justification ("the public tree is missing 698 paths, so prove it BUILDS before
# switching over") rests on it. This leg computes the divergence with §8's own
# recipe and asserts it against the BASE it names.
#
# THREE PRECONDITIONS, each skipped LOUDLY rather than silently passed:
#   1. the pinned base commit exists in this clone (a shallow CI clone may not
#      have it),
#   2. the public repo is reachable (this repo's CI has network, a sandbox may
#      not), and
#   3. jq-free: we only need git/comm/join/awk, all already required above.
# The METHOD leg below is fully hermetic and always runs, so a skipped network
# leg can never hide a broken recipe.
PIN_BASE=b8ce7f2e2
# Recorded in docs/PHASE2B_REPO_SWITCHOVER.md §2/§8 and reproduced 2026-11-05.
PIN_TRACKED=4163
PIN_PRIVATE_ONLY=698
PIN_PUBLIC_ONLY=13
PIN_BOTH=3465
PIN_DIFFER=784
PIN_IDENTICAL=2681

echo "-- B4a the divergence RECIPE is correct (hermetic, always runs)"
# Prove comm/join semantics on a fixture with KNOWN answers before trusting them
# on the real trees. The trap §8 documents: a bare `comm -12` over blob-hash SETS
# matches a blob at ANY path and reports a bogus count — the comparison must be
# over PATHS for the path counts and over the JOINED blob pair for differ/identical.
mkdir -p "$SBX/div/a" "$SBX/div/b"
printf 'one\n'   > "$SBX/div/a/same.txt"      # identical both sides
printf 'one\n'   > "$SBX/div/b/same.txt"
printf 'two\n'   > "$SBX/div/a/changed.txt"   # same path, different blob
printf 'TWO\n'   > "$SBX/div/b/changed.txt"
printf 'pri\n'   > "$SBX/div/a/private.txt"   # private-only path
printf 'pub\n'   > "$SBX/div/b/public.txt"    # public-only path
for d in a b; do git -C "$SBX/div/$d" init -q
  git -C "$SBX/div/$d" config user.email t@example.invalid
  git -C "$SBX/div/$d" config user.name fixture
  git -C "$SBX/div/$d" add -A >/dev/null
  git -C "$SBX/div/$d" commit -qm d; done
git -C "$SBX/div/a" ls-tree -r HEAD | awk '{print $3" "$4}' | sort -k2 > "$SBX/div/om.txt"
git -C "$SBX/div/b" ls-tree -r HEAD | awk '{print $3" "$4}' | sort -k2 > "$SBX/div/pub.txt"
div_private_only=$(comm -23 <(cut -d' ' -f2 "$SBX/div/om.txt"|sort) <(cut -d' ' -f2 "$SBX/div/pub.txt"|sort) | wc -l | tr -d ' ')
div_public_only=$(comm -13 <(cut -d' ' -f2 "$SBX/div/om.txt"|sort) <(cut -d' ' -f2 "$SBX/div/pub.txt"|sort) | wc -l | tr -d ' ')
div_both=$(comm -12 <(cut -d' ' -f2 "$SBX/div/om.txt"|sort) <(cut -d' ' -f2 "$SBX/div/pub.txt"|sort) | wc -l | tr -d ' ')
join -j2 "$SBX/div/om.txt" "$SBX/div/pub.txt" > "$SBX/div/j.txt"
div_differ=$(awk '$2!=$3' "$SBX/div/j.txt" | wc -l | tr -d ' ')
div_ident=$(awk '$2==$3' "$SBX/div/j.txt" | wc -l | tr -d ' ')
check "rule: private-only counts only present-in-private"  "1" "$div_private_only"
check "rule: public-only counts only present-in-public"    "1" "$div_public_only"
check "rule: shared paths counted once"                    "2" "$div_both"
check "rule: same path + different blob = differ"          "1" "$div_differ"
check "rule: same path + same blob = identical"            "1" "$div_ident"

echo "-- B4b the PINNED base still measures what the plan says"
if git -C "$ROOT" cat-file -e "${PIN_BASE}^{commit}" 2>/dev/null; then
  pin_tracked=$(git -C "$ROOT" ls-tree -r "$PIN_BASE" | wc -l | tr -d ' ')
  check "pinned base $PIN_BASE tracks $PIN_TRACKED files" "$PIN_TRACKED" "$pin_tracked"
  base_full=$(git -C "$ROOT" rev-parse "$PIN_BASE")
  # A number without its base is meaningless (§8) — name the base in the output.
  echo "  measured:  base=$PIN_BASE ($base_full) tracked=$pin_tracked"
else
  skip "base $PIN_BASE not in this clone (shallow?) — pinned-count leg skipped"
fi

echo "-- B4c the pinned divergence reproduces (needs the public repo)"
if ! git -C "$ROOT" cat-file -e "${PIN_BASE}^{commit}" 2>/dev/null; then
  skip "base $PIN_BASE absent — divergence leg skipped"
elif [ "${EXPORT_TEST_OFFLINE:-0}" = "1" ]; then
  skip "EXPORT_TEST_OFFLINE=1 — divergence leg skipped by request"
elif ! timeout 90 git clone -q --depth 1 https://github.com/canada-quant/digby.git "$SBX/pubclone" 2>/dev/null; then
  # No network is a legitimate CI/sandbox state. Skip LOUDLY: a network-less run
  # must never look like a verified measurement.
  skip "public repo not reachable (offline?) — divergence leg skipped, NOT verified"
else
  git -C "$ROOT" ls-tree -r "$PIN_BASE" | awk '{print $3" "$4}' | sort -k2 > "$SBX/om-real.txt"
  git -C "$SBX/pubclone" ls-tree -r HEAD | awk '{print $3" "$4}' | sort -k2 > "$SBX/pub-real.txt"
  r_private_only=$(comm -23 <(cut -d' ' -f2 "$SBX/om-real.txt"|sort) <(cut -d' ' -f2 "$SBX/pub-real.txt"|sort) | wc -l | tr -d ' ')
  r_public_only=$(comm -13 <(cut -d' ' -f2 "$SBX/om-real.txt"|sort) <(cut -d' ' -f2 "$SBX/pub-real.txt"|sort) | wc -l | tr -d ' ')
  r_both=$(comm -12 <(cut -d' ' -f2 "$SBX/om-real.txt"|sort) <(cut -d' ' -f2 "$SBX/pub-real.txt"|sort) | wc -l | tr -d ' ')
  join -j2 "$SBX/om-real.txt" "$SBX/pub-real.txt" > "$SBX/j-real.txt"
  r_differ=$(awk '$2!=$3' "$SBX/j-real.txt" | wc -l | tr -d ' ')
  r_ident=$(awk '$2==$3' "$SBX/j-real.txt" | wc -l | tr -d ' ')
  check "private-only == $PIN_PRIVATE_ONLY at $PIN_BASE" "$PIN_PRIVATE_ONLY" "$r_private_only"
  check "public-only == $PIN_PUBLIC_ONLY at $PIN_BASE"   "$PIN_PUBLIC_ONLY"   "$r_public_only"
  check "shared paths == $PIN_BOTH at $PIN_BASE"         "$PIN_BOTH"          "$r_both"
  check "same-path differ == $PIN_DIFFER"                "$PIN_DIFFER"        "$r_differ"
  check "same-path identical == $PIN_IDENTICAL"          "$PIN_IDENTICAL"     "$r_ident"
  echo "  measured:  base=$PIN_BASE private_only=$r_private_only public_only=$r_public_only both=$r_both differ=$r_differ identical=$r_ident"
fi

echo ""
echo "=== $PASS passed, $FAIL failed, $SKIP skipped ==="
[ "$FAIL" -eq 0 ] || exit 1
exit 0