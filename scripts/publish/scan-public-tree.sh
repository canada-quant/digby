#!/usr/bin/env bash
# scan-public-tree.sh — the CLEAN-TREE acceptance scan for a public export
# (docs/PHASE2B_REPO_SWITCHOVER.md §3b-A / §3b-B).
#
# WHY THIS EXISTS
#   The scrub gate inside export-public-tree.sh answers "did any KNOWN value
#   class survive redaction". It cannot answer "does this tree still carry a
#   PRODUCTION DEPLOY PATH, and is its CI build/test-only". Those are policy
#   questions about SHAPE, and they were hand-measured once per run — which is
#   how §3b-B's five prod workflows sat in the flip tree while every scrub run
#   printed PASSED. This script makes the shape check repeatable and its
#   numbers quotable.
#
# WHAT IT ASSERTS (all fail-closed; exit 1 if any assertion fails)
#   A. NO production deploy workflow ships (deploy, deploy-healthcheck, ec2-ops,
#      infrastructure, model-bench, deploy-watchdog).
#   B. NO OIDC/SSH-gate consumer ships: the action dir is absent AND no shipped
#      file references the role var or asks for `id-token: write`.
#   C. The supplied build/test-only CI IS present and references no
#      secrets.*/vars.*.
#   D. NO production topology VALUE survives: AWS account id, the ssh-gate role
#      name, security-group ids, instance ids, internal host labels, RDS/ALB
#      endpoints, the sealed box EIP, internal 10.60.x addresses.
#   E. NO credential-shaped literal survives (AWS key id, GitHub/OpenAI-style
#      tokens, Slack tokens, PEM private-key openers) outside the test files
#      that deliberately carry FAKE fixtures — and .gitleaks.toml is the
#      authority on which those are, so we do not keep a second list here.
#
#                                                          [--no-jest] [--require-jest]
#
# USAGE
#   scripts/publish/scan-public-tree.sh <export-dir> [--quiet] [--no-jest] [--require-jest]
#   exit 0 = CLEAN, 1 = FAILED assertions, 2 = usage/environment error.
set -uo pipefail

DIR=
QUIET=0
NO_JEST=0
REQUIRE_JEST=0
for a in "$@"; do
  case "$a" in
    --quiet) QUIET=1 ;;
    --no-jest) NO_JEST=1 ;;
    --require-jest) REQUIRE_JEST=1 ;;
    -h|--help) sed -n '1,60p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "scan-public-tree.sh: unknown flag $a" >&2; exit 2 ;;
    *)  DIR=$a ;;
  esac
done
[ -n "$DIR" ] || { echo "scan-public-tree.sh: usage: $0 <export-dir>" >&2; exit 2; }
[ -d "$DIR" ] || { echo "scan-public-tree.sh: not a directory: $DIR" >&2; exit 2; }
# ABSOLUTISE ONCE, AT PARSE TIME. Every leg below re-enters the tree with
# `( cd "$DIR" ... )` or `( cd "$ex" ... )`, so a RELATIVE $DIR silently stops
# resolving the moment the subshell changes directory. Measured defect (leg G,
# 2026-11-05): it ran `cd "$ex" && gitleaks dir . --config "$DIR/.gitleaks.toml"`,
# so gitleaks died with "unable to load gitleaks config: open <rel>/.gitleaks.toml:
# no such file or directory", wrote no report, and the leg reported "unprovable,
# not clean" against a genuinely clean archive — a false RED from the harness, the
# mirror image of the phantom-leak class this leg already fixed. The MANUAL run
# with an absolute config path returned gitleaks rc=0 / report `[]` on the same
# bytes, which is what identified it. One normalisation kills the whole class.
case "$DIR" in /*) ;; *) DIR=$(cd "$DIR" && pwd) || exit 2 ;; esac

FAILS=0
pass() { [ "$QUIET" = 1 ] || echo "  PASS  $1"; }
fail() { FAILS=$((FAILS+1)); echo "  FAIL  $1" >&2; }
say()  { [ "$QUIET" = 1 ] || echo "$1"; }

# A file list, repo-relative, excluding binary blobs for the text scans.
mapfile -t FILES < <(cd "$DIR" && find . -type f | sed 's|^\./||' | sort)
say "scanned: ${#FILES[@]} files under $DIR"

# ---------------------------------------------------------------- A. workflows
PROD_WF='deploy|deploy-healthcheck|ec2-ops|infrastructure|model-bench|deploy-watchdog'
n_prod=0
if [ -d "$DIR/.github/workflows" ]; then
  n_prod=$(ls "$DIR/.github/workflows" | grep -cE "^($PROD_WF)\.yml$")
fi
[ "$n_prod" -eq 0 ] && pass "A. 0 production deploy workflows" \
                    || fail "A. $n_prod production deploy workflow(s) still ship"

# ---------------------------------------------------------------- B. OIDC path
[ -e "$DIR/.github/actions/ssh-gate" ] \
  && fail "B. .github/actions/ssh-gate still ships (its defaults carry the prod ARN + SG id)" \
  || pass "B1. ssh-gate action absent"
n_oidc=$(grep -rlE 'SSH_GATE_ROLE_ARN|configure-aws-credentials|id-token:[[:space:]]*write|\./\.github/actions/ssh-gate' "$DIR/.github" 2>/dev/null | wc -l | tr -d ' ')
[ "$n_oidc" -eq 0 ] && pass "B2. 0 OIDC consumers under .github/" \
                    || fail "B2. $n_oidc .github file(s) still reference the deploy OIDC role"

# ---------------------------------------------------------------- C. public CI
CI="$DIR/.github/workflows/ci.yml"
if [ -f "$CI" ]; then
  n_secret_refs=$(grep -cE 'secrets\.|vars\.' "$CI" || true); n_secret_refs=${n_secret_refs:-0}
  [ "$n_secret_refs" -eq 0 ] \
    && pass "C. public ci.yml present ($(wc -c < "$CI" | tr -d ' ') B) with 0 secrets./vars. refs" \
    || fail "C. public ci.yml references $n_secret_refs secrets./vars. names"
else
  fail "C. no .github/workflows/ci.yml — the tree would be green by ABSENCE"
fi

# ------------------------------------------------------- D. prod topology values
# THIS FILE SHIPS IN THE EXPORT, so it may only carry the SHAPES of the classes
# it looks for — never a real value. (The first draft of this script named four
# production EIPs and the sealed-box address as literals; the exporter's
# fail-closed gate rejected the whole tree with `eip` + `sealed-box` residue,
# which is exactly the defect class this repo has fixed before: a scrubber that
# embeds its own deny-list publishes it.)
#
# Two legs, deliberately:
#   D-shape  — universal shapes, safe to write down: an AWS account id, an
#              instance id, a security-group id, our host-label prefix. These
#              are structural; the allow-list below is the same one the
#              exporter uses for documentation values.
#   D-values — the ACTUAL production values, read at runtime from the private
#              rules file (which the export drops, so it exists only on the
#              private side). Absent that file we say so rather than silently
#              claiming a pass on a check we could not run.
TOPO_RE='arn:aws:iam::[0-9]{12}:role/|sg-0[0-9a-f]{8,17}|\bi-0[0-9a-f]{17}\b|digby-ca-[a-z0-9-]+|example-db|digby-alb-[0-9]+'
TOPO_ALLOW='^sg-0123456789abcdef0[0-9]$|^i-0123456789abcdef[0-9]$'
hits=$(grep -rhoE "$TOPO_RE" "$DIR" 2>/dev/null \
       | grep -vE 'arn:aws:iam::123456789012:role/' \
       | grep -vE "$TOPO_ALLOW" | sort -u)
if [ -z "$hits" ]; then
  pass "D. no production topology value survives (account/instance/SG/host-label classes)"
else
  fail "D. production topology value(s) survive:"
  printf '        %s\n' $hits >&2
fi
# The 10.60/16 internal range: only the documented CIDR bounds may appear.
CIDR=$(grep -rhoE '\b10\.60\.[0-9]{1,3}\.[0-9]{1,3}\b' "$DIR" 2>/dev/null \
       | grep -vE '^10\.60\.(0\.0|1\.0|2\.0)$' | sort -u)
[ -z "$CIDR" ] && pass "D2. no internal 10.60.x host address (CIDR bounds excluded)" \
              || { fail "D2. internal address(es) survive:"; printf '        %s\n' $CIDR >&2; }

# D-values: the literal production values come from the PRIVATE rules file.
RULES=${SCAN_RULES:-}
if [ -z "$RULES" ]; then
  for c in "$(dirname "$0")/../../.digby/publish/scrub-rules.txt" \
           ".digby/publish/scrub-rules.txt"; do
    [ -r "$c" ] && { RULES=$c; break; }
  done
fi
if [ -n "$RULES" ] && [ -r "$RULES" ]; then
  # Every literal a `forbid`/`redact` rule names for a topology class. The rules
  # grammar is TAB-separated, so column 2 is the value/regex we want.
  n_lit=0
  while IFS= read -r lit; do
    [ -z "$lit" ] && continue
    n_lit=$((n_lit+1))
    found=$(grep -rlF -- "$lit" "$DIR" 2>/dev/null | head -3)
    [ -n "$found" ] && fail "D3. a private rules literal still appears in: $(echo "$found" | tr '\n' ' ')"
  done < <(awk -F'\t' '$1 ~ /^(redact|forbid)$/ && $2 ~ /(3\.[0-9]+\.[0-9]+\.[0-9]+|10\.60\.|arn:aws|sg-0|i-0)/ {print $2}' "$RULES" 2>/dev/null \
           | grep -vE '\[|\\b|\$|\*|\?|\+' | sort -u)
  pass "D3. checked $n_lit literal production value(s) from ${RULES##*/}"
else
  pass "D3. SKIPPED — private rules not present (public clone): literal-value leg unrun"
fi

# ------------------------------------------------- E. credential-shaped values
# THE AUTHORITY IS GITLEAKS, not a regex of ours. It is what public CI runs
# (full history), it owns the reviewed allowlist in .gitleaks.toml, and its
# allowlist entries are PATH REGEXES — so a second scanner that matched by
# BASENAME would disagree with it in both directions (blessing a file gitleaks
# fails, failing a file gitleaks allows). We therefore run the real thing and
# report its verdict, and only fall back to a shape scan when it is absent.
CRED_RE='AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{32,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----'
if command -v gitleaks >/dev/null 2>&1 && [ -f "$DIR/.gitleaks.toml" ]; then
  gl_report=$(mktemp "${TMPDIR:-/tmp}/scan-gl.XXXXXX")
  ( cd "$DIR" && gitleaks dir . --config .gitleaks.toml \
      --report-format json --report-path "$gl_report" --no-banner --exit-code 1 ) \
      >/dev/null 2>&1
  gl_rc=$?
  n_leaks=$(grep -o '"RuleID"' "$gl_report" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$gl_rc" -eq 0 ] && [ "$n_leaks" -eq 0 ]; then
    pass "E. gitleaks (v$(gitleaks version 2>/dev/null)): 0 leaks against .gitleaks.toml"
  else
    fail "E. gitleaks: $n_leaks leak(s) against .gitleaks.toml"
    [ -s "$gl_report" ] && \
      python3 - "$gl_report" <<'PY' >&2 || true
import json,sys
for f in json.load(open(sys.argv[1])):
    print("        %s | %s" % (f.get('RuleID'), f.get('File')))
PY
  fi
  rm -f "$gl_report"
else
  # Fail-closed: no scanner means no verdict, never a silent pass.
  cred=$(grep -rlE "$CRED_RE" "$DIR" 2>/dev/null | sed "s|^$DIR/||" | sort)
  n_cred=$(printf '%s\n' "$cred" | grep -c . || true); n_cred=${n_cred:-0}
  if [ "$n_cred" -eq 0 ]; then
    pass "E. (no gitleaks) shape scan: no credential-shaped literal"
  else
    fail "E. (no gitleaks) shape scan found $n_cred file(s) — install gitleaks for the authoritative verdict:"
    printf '        %s\n' $cred >&2
  fi
fi

# ---------------------------------------------------------------- F. own test suite
# THE LEG THIS SCRIPT LACKED (defect B1, 2026-11-05). Every assertion above is a
# SHAPE or VALUE check: it proves the tree carries no prod deploy path and no
# credential. None of them runs the tree's OWN tests — so a tree whose jest
# suite is RED (because §3b-B dropped a file that a shipped test reads as its
# fixture) scanned CLEAN and would have shipped. That is exactly what happened:
# three suites failed on the first real export while this script printed PASSED.
#
# CLEAN now means the tree BUILDS AND TESTS, not just that it is credential-clean.
#
# Dependency handling: an export carries no node_modules (git archive never
# includes it, and it must not). If backend/node_modules is absent we can either
# link a same-commit install or skip. SKIPPING IS NOT A PASS — that is the whole
# lesson here — so:
#   default        : skip, but say so LOUDLY and in the summary line
#   --require-jest : a skip is a FAILURE (use this in any release gate)
#   --no-jest      : explicit opt-out for a deliberately shape-only run
run_jest=1
[ "$NO_JEST" = 1 ] && run_jest=0
if [ "$run_jest" = 1 ]; then
  if [ ! -d "$DIR/backend" ]; then
    fail "F. no backend/ in the tree — cannot run its own test suite"
  elif [ ! -x "$DIR/backend/node_modules/.bin/jest" ] && [ ! -x "$DIR/node_modules/.bin/jest" ]; then
    if [ "$REQUIRE_JEST" = 1 ]; then
      fail "F. backend/node_modules absent and --require-jest set — an unproved suite is not a pass"
    else
      say "  SKIP  F. backend/node_modules absent — the tree's own jest suite was NOT run"
      say "        (this is not a pass: run with --require-jest before publishing, or"
      say "         link a same-commit install: ln -s <worktree>/backend/node_modules \$DIR/backend/)"
    fi
  else
    # THE LEG MUST NOT DIRTY THE ARTIFACT IT VALIDATES. Measured the hard way:
    # the first version of this leg ran jest with only JEST_KEEP_TMPDIR=1, which
    # stops globalSetup creating .jest-tmp but NOT jest's own transform cache —
    # jest.config.js pins `cacheDirectory: '<rootDir>/.jest-tmp/jest-cache'`, so a
    # full run still wrote ~1,500 cache files INTO the export. A gitleaks run
    # over that dirtied tree then reported 78 "leaks" (cached test fixtures
    # carrying fake tokens) that do not exist in the export at all. A scanner
    # that manufactures findings is worse than no scanner.
    #
    # Both knobs, belt and braces: JEST_KEEP_TMPDIR=1 for globalSetup, and
    # --cacheDirectory to a scratch dir outside the tree for jest itself.
    jlog=$(mktemp "${TMPDIR:-/tmp}/scan-jest.XXXXXX")
    jcache=$(mktemp -d "${TMPDIR:-/tmp}/scan-jest-cache.XXXXXX")
    ( cd "$DIR/backend" && JEST_KEEP_TMPDIR=1 NODE_OPTIONS="--max-old-space-size=4096" \
        ./node_modules/.bin/jest --ci --silent --cacheDirectory "$jcache" ) >"$jlog" 2>&1
    jrc=$?
    jsum=$(grep -E '^(Test Suites|Tests):' "$jlog" | tr '\n' ' ' | sed 's/  */ /g')
    if [ "$jrc" -eq 0 ]; then
      pass "F. the tree's own jest suite is GREEN ($jsum)"
    else
      fail "F. the tree's own jest suite is RED (rc=$jrc): ${jsum:-<no summary>}"
      grep -E '^(FAIL|  ● )' "$jlog" | head -12 | sed 's/^/        /' >&2
    fi
    rm -f "$jlog"
  fi
fi

# ------------------------------------------------- G. shipped binaries are scanned
# A binary cannot be redacted — only scanned. §3b-B used to solve that by
# DROPPING the prebuilt installers, and it over-applied the rule to
# `digby-imessage-agent.tar.gz`, which is not build output: shipped consumers
# download it (IMessageCard.tsx:71, install-digby-agent.sh:107). A shipped
# binary must not be the ONE thing in a CLEAN tree nobody looked inside, so this
# leg unpacks every shipped tarball and runs the SAME secret rules over its
# CONTENTS. It is not enough that the outer file scans clean — a .tar.gz is
# opaque to a pattern scanner, so a clean outer verdict proves nothing.
run_bin=1
[ "$NO_JEST" = 1 ] && run_bin=0      # --no-jest means "shape only"; skip both exec legs
if [ "$run_bin" = 1 ]; then
  tarballs=$(cd "$DIR" && find . -name '*.tar.gz' -type f 2>/dev/null | sed 's|^\./||')
  if [ -z "$tarballs" ]; then
    say "  SKIP  G. no *.tar.gz in the tree — nothing to unpack"
  else
    gtmp=$(mktemp -d "${TMPDIR:-/tmp}/scan-bin.XXXXXX")
    gall_ok=1
    while IFS= read -r tb; do
      [ -n "$tb" ] || continue
      ex="$gtmp/$(echo "$tb" | tr '/ ' '__')"
      mkdir -p "$ex"
      if ! tar -xzf "$DIR/$tb" -C "$ex" 2>/dev/null; then
        fail "G. $tb could not be unpacked — a shipped binary we cannot inspect is not provable"
        gall_ok=0; continue
      fi
      # 1. the same gitleaks rules over the extracted content
      if command -v gitleaks >/dev/null 2>&1; then
        # REPORT PATH MUST BE A SAFE LEAF NAME. Measured defect: the first
        # version used "$gtmp/$tb.json" where $tb still contains slashes
        # ("frontend/public/digby-imessage-agent.tar.gz"), so gitleaks could not
        # create the nested directories, exited non-zero, and this leg reported
        # a PHANTOM LEAK ("? leak(s)") against a clean archive. Derive a slash-free
        # slug instead — never let a reporting artifact manufacture a finding.
        gl_slug=$(echo "$tb" | tr '/ ' '__')
        gl_report="$gtmp/$gl_slug.json"
        ( cd "$ex" && gitleaks dir . --config "$DIR/.gitleaks.toml" \
            --report-format json --report-path "$gl_report" \
            --no-banner --exit-code 1 ) >/dev/null 2>&1
        grc=$?
        nleak=$(python3 -c "import json;print(len(json.load(open('$gl_report'))))" 2>/dev/null || echo '?')
        if [ "$nleak" = "?" ]; then
          # Could not read the report at all. That is NOT a clean archive and not
          # a leak: say so as a hard failure so nobody reads "?" as either.
          fail "G. $tb contents: gitleaks ran but produced no readable report — unprovable, not clean"
          gall_ok=0
        elif [ "$grc" -eq 0 ]; then
          pass "G. $tb contents: gitleaks clean ($nleak leaks)"
        else
          fail "G. $tb contents: gitleaks found $nleak leak(s) INSIDE the archive"
          gall_ok=0
        fi
      else
        # no gitleaks: fall back to the shape check only, and say so honestly
        say "  SKIP  G. $tb contents: gitleaks unavailable — shape check only"
      fi
      # 2. credential-SHAPED literals inside the content (independent of gitleaks)
      if grep -rIlE 'AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{32,}|-----BEGIN [A-Z ]*PRIVATE KEY-----' "$ex" 2>/dev/null | head -3 | grep -q .; then
        fail "G. $tb contents carry credential-shaped literals (see below)"
        grep -rIlE 'AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{32,}|-----BEGIN [A-Z ]*PRIVATE KEY-----' "$ex" 2>/dev/null | head -3 | sed "s|$gtmp/|        |" >&2
        gall_ok=0
      fi
      # 3. the consumers that make it a REQUIRED file must actually be shipped —
      #    a tarball nobody references is dead weight; a reference with no
      #    tarball is the 404 this whole leg exists to prevent.
      case "$tb" in
        *digby-imessage-agent.tar.gz)
          if ! grep -q 'digby-imessage-agent.tar.gz' "$DIR/frontend/app/crossmodel/account/IMessageCard.tsx" 2>/dev/null; then
            fail "G. $tb ships but IMessageCard.tsx no longer references it — stale consumer pairing"
            gall_ok=0
          fi
          ;;
      esac
    done <<< "$tarballs"
    rm -rf "$gtmp"
  fi
fi

# ------------------------------------------------------- H. the frontend suite too
# F runs jest (backend). The release tree also has a frontend, and its runner is
# VITEST, not jest — so a red frontend suite still scanned CLEAN while this
# script claimed "the tree tests". Same fail-closed shape as F: an unproved
# frontend suite is a SKIP that says so, or a FAILURE under --require-jest.
if [ "$run_jest" = 1 ]; then
  if [ ! -d "$DIR/frontend" ]; then
    fail "H. no frontend/ in the tree — cannot run its own test suite"
  elif [ ! -x "$DIR/frontend/node_modules/.bin/vitest" ]; then
    if [ "$REQUIRE_JEST" = 1 ]; then
      fail "H. frontend/node_modules absent and --require-jest set — an unproved suite is not a pass"
    else
      say "  SKIP  H. frontend/node_modules absent — the frontend vitest suite was NOT run"
      say "        (not a pass: link a same-commit install, e.g."
      say "         ln -s <worktree>/frontend/node_modules \$DIR/frontend/)"
    fi
  else
    vlog=$(mktemp "${TMPDIR:-/tmp}/scan-vitest.XXXXXX")
    # BOUNDED PARALLELISM. Measured: at vitest's default worker count on a loaded
    # 2-vCPU box, `send-email-card.regression.test.ts` failed its wall-clock
    # budget (expected 2608 to be less than 2500) while passing 59/59 in 4.91s in
    # isolation — i.e. genuine environmental flake, not a defect in the tree. A
    # gate that flakes on load is a gate people learn to ignore, so bound it.
    # (If a real wall-clock regression appears, this still catches it: the test
    # gets a quieter machine, not a longer budget.)
    ( cd "$DIR/frontend" && VITEST_CACHE_DIR="${TMPDIR:-/tmp}/scan-vitest-cache" \
        ./node_modules/.bin/vitest run --reporter=dot --maxWorkers=2 ) >"$vlog" 2>&1
    vrc=$?
    # vitest colourises its summary, so `^\s*Tests` matched NOTHING and the leg
    # reported "<no summary>" on a genuinely red run. Strip ANSI first.
    vclean=$(sed -e 's/\x1b\[[0-9;]*m//g' "$vlog")
    vsum=$(printf '%s\n' "$vclean" | grep -E '^\s*(Test Files|Tests)\s' | tr '\n' ' ' | sed 's/  */ /g')
    if [ "$vrc" -eq 0 ]; then
      pass "H. the tree's own frontend vitest suite is GREEN ($vsum)"
    else
      fail "H. the tree's own frontend vitest suite is RED (rc=$vrc): ${vsum:-<no summary>}"
      printf '%s\n' "$vclean" | grep -E 'FAIL |AssertionError' | head -10 | sed 's/^/        /' >&2
    fi
    rm -f "$vlog"
  fi
fi

# ---------------------------------------------------------------------- verdict
echo ""
if [ "$FAILS" -eq 0 ]; then
  echo "CLEAN: $DIR passes the §3b-A/§3b-B clean-tree assertions"
  exit 0
fi
echo "FAILED: $FAILS assertion(s) — this tree must not be published" >&2
exit 1