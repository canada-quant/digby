#!/usr/bin/env bash
# export-public-tree.sh — emit the PUBLIC tree from a private sha, through a
# FAIL-CLOSED mechanical scrub. Phase 2b Step 0
# (docs/PHASE2B_REPO_SWITCHOVER.md §4 "Step 0 — make the scrub a program, not a
# memory").
#
# WHY THIS EXISTS
#   `canada-quant/digby` today is a hand-scrubbed point-in-time snapshot: the
#   scrub exists only as a working-tree edit somebody did once, so every re-cut
#   is un-repeatable and the node-a/node-b gap (§2d: 37 and 15 public files still
#   carry internal host labels) cannot be closed by willpower. This script makes
#   the scrub a program with a build gate.
#
# THE CONTRACT (all three legs are load-bearing)
#   1. CONTENT, NEVER HISTORY. It reads a sha with `git archive` and writes a
#      fresh tree. It never pushes, never rewrites, never touches a remote. The
#      private history carries every scrubbed value (§2d), so private history
#      must never reach the public repo — a content export cannot.
#   2. ATOMIC. Everything happens in a scratch dir. The output dir is only
#      created once the scrub has PASSED. A failing run leaves no partial tree
#      behind to be committed by mistake.
#   3. FAIL-CLOSED. After redaction the staged tree is re-scanned. Any surviving
#      marker — a value the rules did not know how to redact, or a rule that
#      failed to apply — aborts with a non-zero exit and the offending files.
#      There is no "warn and continue" path and no override flag. An unknown
#      value class is a rules-file gap to fix, never a run to wave through.
#
# WHY THE VALUES ARE NOT IN THIS FILE
#   This script is itself exported, so it may only carry the SHAPES of the
#   classes it strips (`sg-<8..17 hex>`, `arn:aws:iam::<12 digits>`,
#   `i-<17 hex>`, the `100.64.0.0/10` tailnet range) — those describe AWS
#   identifiers in general, not ours. Every actual VALUE (the redaction targets,
#   their replacements, the drop list, the allow-list of structural addresses)
#   lives in a private rules file under .digby/, which this export DROPS
#   wholesale. A scrubber that embedded its own deny-list would publish it.
#
# USAGE
#   scripts/publish/export-public-tree.sh [--sha <ref>] [--out <dir>]
#                                        [--rules <file>] [--report]
#
#   --sha     commit/sha to export       (default: origin/main)
#   --out     output dir, must not exist (default: tmp/public-export)
#   --rules   rules file                 (default: .digby/publish/scrub-rules.txt)
#   --report  run the full scrub + gate, print counts, write no tree
#
# EXIT CODES
#   0  export written (or --report clean)
#   1  usage / environment error
#   2  a required rule is missing, or the rules file is unreadable/malformed
#   3  RESIDUE: a forbidden marker survived redaction (the fail-closed verdict)
#   4  a staged file could not be scrubbed (unreadable / write failed)
#
# Run from anywhere. Pinned by scripts/publish/export-public-tree.test.sh.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

SHA=origin/main
OUT=tmp/public-export
REPO=$ROOT
RULES=
REPORT_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --sha)     SHA=${2:?--sha needs a value}; shift 2 ;;
    --out)     OUT=${2:?--out needs a value}; shift 2 ;;
    --repo)    REPO=${2:?--repo needs a value}; shift 2 ;;
    --rules)   RULES=${2:?--rules needs a value}; shift 2 ;;
    --report)  REPORT_ONLY=1; shift ;;
    -h|--help) sed -n '1,50p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "export-public-tree.sh: unknown argument: $1" >&2; exit 1 ;;
  esac
done

# die <message> [exit-code]
die() { echo "export-public-tree.sh: $1" >&2; exit "${2:-1}"; }
say() { echo "  $*"; }

# ---------------------------------------------------------------- preconditions
for tool in git perl find grep sort; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required" 1
done

REPO=$(cd "$REPO" 2>/dev/null && pwd) || die "not a directory: $REPO" 1
git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || die "not a git repo: $REPO" 1

# Default rules live in the repo being exported (so a fixture --repo carries its
# own), and --rules always wins.
[ -n "$RULES" ] || RULES=$REPO/.digby/publish/scrub-rules.txt
case "$RULES" in
  /*) ;;
  *)  RULES=$REPO/$RULES ;;
esac

[ -r "$RULES" ] || die "rules file not readable: $RULES
  The scrub rules are private policy and are NOT shipped beside this script.
  Restore it (it lives under .digby/, which the export drops)." 2

FULL=$(git -C "$REPO" rev-parse --verify --quiet "$SHA^{commit}") \
  || die "cannot resolve '$SHA' to a commit" 1
SHORT=$(git -C "$REPO" rev-parse --short "$FULL")

# ---------------------------------------------------------------- rules parsing
# Rules file is TAB-separated, '#' comments and blank lines ignored:
#
#   redact <regex> <replacement>       content substitution, applied globally
#   drop   <glob>                      path never ships
#   supply <src> <dest>                ship PRIVATE <src> as public <dest>
#   forbid <label> <regex> [<allow>]   residue class; a surviving match that
#                                      does not also match <allow> is fatal
#
# Regexes are PCRE-ish as understood by `perl` (redaction) and GNU `grep -E`
# (residue gate), so a rule must be valid in BOTH dialects. That is deliberate:
# the redactor and the gate must agree on what a value looks like, or a rule can
# scrub one spelling while the gate accepts another.
REDACT_RE=(); REDACT_TO=()
DROP=()
SUPPLY_SRC=(); SUPPLY_DEST=()
FORBID_LABEL=(); FORBID_RE=(); FORBID_ALLOW=()

lineno=0
# `read` returns NON-ZERO at EOF, so a rules file whose last line has no trailing
# newline loses that line entirely — the loop body never runs for it. That is not
# hypothetical: it silently dropped the final `forbid sealed-box` rule, so the
# sealed CQL-Public EIP was neither redacted nor gated while the run still
# printed PASSED. `|| [ -n "$kind" ]` runs the body one last time for the
# unterminated tail; the count check below then proves nothing was skipped.
while IFS=$'\t' read -r kind a b c || [ -n "${kind:-}" ]; do
  lineno=$((lineno+1))
  case "$kind" in
    ''|'#'*) continue ;;
    redact)
      [ -n "${a:-}" ] && [ -n "${b:-}" ] || die "rules line $lineno: malformed 'redact'" 2
      REDACT_RE+=("$a"); REDACT_TO+=("$b") ;;
    drop)
      [ -n "${a:-}" ] || die "rules line $lineno: malformed 'drop'" 2
      DROP+=("$a") ;;
    supply)
      # supply <src> <dest> — publish PRIVATE file <src> (repo-relative) AS
      # <dest> in the public tree. The public/flip tree is not the private tree
      # with holes cut in it: §3b-B's ruling (owner, 2026-11-05T18:07Z) is that
      # the public repo carries a build/test-only CI, while the private ci.yml
      # tests the production deploy machinery. Dropping the private file without
      # SUPPLYING the public one leaves a tree with NO CI at all — silently
      # green by absence, which is the same class of defect as a gate that
      # cannot see an escaping variant. So the replacement is a rule, named in
      # policy, not a hand-edit somebody must remember.
      [ -n "${a:-}" ] && [ -n "${b:-}" ] || die "rules line $lineno: malformed 'supply' (want: supply <src> <dest>)" 2
      case "$b" in /*) die "rules line $lineno: supply dest must be repo-relative: $b" 2 ;; esac
      SUPPLY_SRC+=("$a"); SUPPLY_DEST+=("$b") ;;
    forbid)
      [ -n "${a:-}" ] && [ -n "${b:-}" ] || die "rules line $lineno: malformed 'forbid'" 2
      FORBID_LABEL+=("$a"); FORBID_RE+=("$b"); FORBID_ALLOW+=("${c:-}") ;;
    *)
      die "rules line $lineno: unknown directive '$kind'" 2 ;;
  esac
  # Guard against a `read` that consumed nothing and would loop forever.
  [ -z "${kind:-}" ] && break
done < "$RULES"

# EVERY physical line must have been consumed. `wc -l` counts newlines, so a file
# with no trailing newline reports one fewer than it has; count lines by content
# instead (awk NR sees the unterminated tail).
physical=$(awk 'END{print NR}' "$RULES")
[ "$lineno" -eq "$physical" ] \
  || die "rules: parsed $lineno of $physical physical line(s) in $RULES
  A line was skipped — a truncated or unterminated rule must abort, never be
  dropped silently (that is how the sealed-box forbid rule went missing)." 2

[ ${#REDACT_RE[@]}  -gt 0 ] || die "rules: no 'redact' lines — refusing an empty scrub" 2
[ ${#FORBID_LABEL[@]} -gt 0 ] || die "rules: no 'forbid' lines — a scrub with no gate is not fail-closed" 2

# ---------------------------------------------------------------- scratch space
WORK=$(mktemp -d "${TMPDIR:-/tmp}/export-public.XXXXXX")
trap 'rm -rf "$WORK"' EXIT INT TERM
STAGE=$WORK/tree
mkdir -p "$STAGE"

say "base        : $SHA -> $FULL"
say "rules       : ${RULES#"$ROOT"/} (${#REDACT_RE[@]} redact, ${#DROP[@]} drop, ${#FORBID_LABEL[@]} forbid)"
say "scratch     : $WORK"

# ---------------------------------------------------------------- 1. export
git -C "$REPO" archive --format=tar "$FULL" | tar -x -C "$STAGE" \
  || die "git archive failed for $FULL" 1
total_before=$(find "$STAGE" -type f | wc -l | tr -d ' ')
say "exported    : $total_before files"

# ---------------------------------------------------------------- 2. drop paths
# A drop rule is: a trailing '/' (path prefix), a glob containing '*' (matched
# against the whole relative path — bash case globs cross '/'), or an exact path.
#
# DEFECT FIXED 2026-11-05 (§3b-B): the glob test was `*'*'`, which only matches a
# rule that ENDS with a star (`tmp-*`). A rule with the star in the MIDDLE
# (`scripts/framework-audit/probe-*.js`) fell through to exact-match and silently
# dropped nothing — the export shipped the files while the rule read as present.
# Caught by the fail-closed gate on the very first such rule. `*'*'*` matches a
# string CONTAINING a star, which is what the comment always said.
drop_match() {
  local rel=$1 g=$2
  case "$g" in
    */)     case "$rel" in "$g"*) return 0 ;; esac ;;
    *'*'*)  case "$rel" in $g) return 0 ;; esac ;;
    *)      [ "$rel" = "$g" ] && return 0 ;;
  esac
  return 1
}

dropped=0
if [ ${#DROP[@]} -gt 0 ]; then
  while IFS= read -r -d '' f; do
    rel=${f#"$STAGE"/}
    for g in "${DROP[@]}"; do
      if drop_match "$rel" "$g"; then
        rm -f -- "$f"; dropped=$((dropped+1)); break
      fi
    done
  done < <(find "$STAGE" -type f -print0)
  find "$STAGE" -type d -empty -delete 2>/dev/null || true
fi
say "dropped     : $dropped files"

# ---------------------------------------------------------------- 2b. supply
# Publish a private file AS a public path. Runs after drops so policy reads in
# one direction: drops remove what may not leave, supplies add what the public
# tree must carry (a build-only CI in place of the private deploy-testing one).
# FAIL-CLOSED on both ends: a missing source is a policy bug (the file it means
# to publish is gone), and a dest that already exists in the tree is an
# ambiguous double-write — never a silent overwrite.
supplied=0
if [ ${#SUPPLY_SRC[@]} -gt 0 ]; then
  for i in "${!SUPPLY_SRC[@]}"; do
    src=${SUPPLY_SRC[$i]}; dest=${SUPPLY_DEST[$i]}
    git -C "$REPO" cat-file -e "$FULL:$src" 2>/dev/null \
      || die "supply: source '$src' does not exist at $SHORT (policy names a file the export cannot publish)" 2
    [ -e "$STAGE/$dest" ] \
      && die "supply: dest '$dest' already exists in the exported tree — a supply is a REPLACEMENT for a dropped path, never an overwrite" 2
    mkdir -p "$STAGE/$(dirname "$dest")"
    git -C "$REPO" show "$FULL:$src" > "$STAGE/$dest" \
      || die "supply: could not write '$src' -> '$dest'" 1
    supplied=$((supplied+1))
  done
fi
say "supplied    : $supplied files"

# ---------------------------------------------------------------- 3. redaction
# The engine reads the rule table itself (never generated source), so a rule may
# contain any delimiter or quoting character without breaking the program.
cat > "$WORK/redact.pl" <<'PERLEOF'
use strict; use warnings;

my $rules_file = shift @ARGV;
shift @ARGV if @ARGV and $ARGV[0] eq '--';
open my $rf, '<', $rules_file or die "redact.pl: cannot read rules: $!\n";
my @rules;
while (my $line = <$rf>) {
  chomp $line;
  next unless length $line;
  my ($re, $to) = split /\t/, $line, 2;
  next unless defined $to;
  my $qr = eval { qr/$re/ };
  die "redact.pl: bad regex [$re]: $@" unless $qr;
  push @rules, [ $qr, $to ];
}
close $rf;

my ($changed, $binary, $failed) = (0, 0, 0);
for my $file (@ARGV) {
  open my $in, '<:raw', $file or do { warn "UNREADABLE: $file: $!\n"; $failed++; next };
  my $data = do { local $/; <$in> };
  close $in;
  $data = '' unless defined $data;

  # A NUL byte in the first 8 KiB means binary: it cannot carry a substitution,
  # so it is scanned by the residue gate but never rewritten here.
  if (substr($data, 0, 8192) =~ /\x00/) { print "B\t$file\n"; $binary++; next }

  my $before = $data;
  for my $rule (@rules) {
    my ($qr, $to) = @$rule;
    # The replacement is LITERAL DATA — a slug, a hostname, an ARN — so it is
    # returned from an /e block, where perl does no variable or backslash
    # interpolation (`$`, `@`, `\` in a slug can never be re-read as code; a
    # hyphen can never become subtraction).
    #
    # ESCAPE FIDELITY (Phase 2b Step 1 build proof, 2026-11-05): a raw
    # substitution broke the first real build. The rule `example-org\\?/crossmodel`
    # matches the ESCAPED spelling `example-org\/crossmodel` — the form that
    # appears inside JS/regex string literals — and replaced it with an
    # UNESCAPED `canada-quant/digby`. In `export const R = /…\/…/i;` that
    # introduces a bare `/` which TERMINATES the regex literal, so the file no
    # longer parses: six TypeScript files scored `TS1127: Invalid character`
    # and `npm run build` exited 2, while every grep-based residue check called
    # the tree clean (the removed backslash leaves no forbidden token behind —
    # the gate can only see values that SURVIVE, never structure that is
    # CORRUPTED). So: if the matched spelling was escape-quoted, the replacement
    # is escape-quoted the same way. This is faithful, not cosmetic — it
    # preserves the source's own escaping style instead of flattening it.
    $data =~ s{$qr}{
      my $m = $&;
      my $r = $to;
      $r =~ s{/}{\\/}g if $m =~ m{\\/};
      $r;
    }ge;
  }

  next if $data eq $before;
  open my $out, '>:raw', $file or do { warn "UNWRITABLE: $file: $!\n"; $failed++; next };
  print $out $data;
  close $out or do { warn "UNWRITABLE: $file: $!\n"; $failed++; next };
  print "R\t$file\n";
  $changed++;
}
printf STDERR "redact.pl: %d changed, %d binary, %d failed\n", $changed, $binary, $failed;
exit($failed ? 1 : 0);
PERLEOF

: > "$WORK/rules.tsv"
for i in "${!REDACT_RE[@]}"; do
  printf '%s\t%s\n' "${REDACT_RE[$i]}" "${REDACT_TO[$i]}" >> "$WORK/rules.tsv"
done

# Batch the file list through xargs so a deep tree cannot blow the ARG_MAX limit.
if ! find "$STAGE" -type f -print0 \
     | xargs -0 -r -n 200 perl "$WORK/redact.pl" "$WORK/rules.tsv" -- \
     > "$WORK/redact.log" 2> "$WORK/redact.err"; then
  cat "$WORK/redact.err" >&2 || true
  die "RESIDUE/ABORT: the redactor failed on at least one staged file (see above)" 4
fi

redacted=$(grep -c '^R' "$WORK/redact.log" 2>/dev/null || true); redacted=${redacted:-0}
binaries=$(grep -c '^B' "$WORK/redact.log" 2>/dev/null || true); binaries=${binaries:-0}
say "redacted    : $redacted files changed"
say "binary      : $binaries files (scanned by the gate, not rewritable)"

# ---------------------------------------------------------------- 4. residue gate
# The fail-closed verdict. Token-level, not line-level: every match of a forbid
# regex is extracted and tested against that rule's own allow-regex, so a line
# that legitimately carries a structural value (a CIDR bound, a documentation
# example) cannot launder a real value sitting next to it.
#
# This runs in perl, not grep -r: grep's "file:token" output is ambiguous when
# the token itself contains a colon (every ARN does), and a path may start with
# '-'. Walking files and matching in-process removes both hazards.
cat > "$WORK/gate.pl" <<'PERLEOF'
use strict; use warnings;

my $stage      = shift @ARGV;
my $rules_file = shift @ARGV;
open my $rf, '<', $rules_file or die "gate.pl: cannot read rules: $!\n";
my @rules;
while (my $line = <$rf>) {
  chomp $line;
  next unless length $line;
  my ($label, $re, $allow) = split /\t/, $line, 3;
  next unless defined $re;
  my $qr = eval { qr/$re/ } or die "gate.pl: bad regex [$re]: $@";
  my $aq = (defined $allow && length $allow) ? eval { qr/$allow/ } : undef;
  die "gate.pl: bad allow regex [$allow]: $@" if (defined $allow && length $allow && !$aq);
  push @rules, [ $label, $qr, $aq ];
}
close $rf;

# Collect files ourselves: File::Find is core, and this must see binaries too.
use File::Find qw(find);
my @files;
find({ no_chdir => 1, wanted => sub {
  push @files, $File::Find::name if -f $_;
} }, $stage);

my $violations = 0;
my %per_class;
for my $rule (@rules) {
  my ($label, $qr, $aq) = @$rule;
  my $hits = 0;
  for my $file (@files) {
    open my $fh, '<:raw', $file or next;
    my $data = do { local $/; <$fh> };
    close $fh;
    next unless defined $data;

    # BACKSTOP against the escape blind spot (defect: a value written in a
    # language's own literal syntax — `example-org\/crossmodel` in a JS regex
    # literal — is invisible to a rule that expects a plain `/`). Scan the raw
    # bytes AND a de-escaped view, so no escaping variant can slip past a rule
    # that only knows one spelling. The de-escaped view collapses `\/`, `\.`,
    # `\\`, `\-` etc. to the bare character.
    (my $unescaped = $data) =~ s{\\([^A-Za-z0-9])}{$1}g;

    for my $view ($data, $unescaped) {
      while ($view =~ /$qr/g) {
        my $tok = $&;
        next if $aq && $tok =~ $aq;
        (my $rel = $file) =~ s{^\Q$stage\E/}{};
        print STDOUT "$label\t$rel\n";
        $hits++;
      }
    }
  }
  $per_class{$label} = $hits;
  $violations += $hits;
}

for my $label (sort keys %per_class) {
  print STDERR ($per_class{$label} > 0
    ? "  RESIDUE [$label]: $per_class{$label} surviving token(s)\n"
    : "  clean       : $label\n");
}
print STDERR "\n";
exit($violations > 0 ? 3 : 0);
PERLEOF

: > "$WORK/forbid.tsv"
for i in "${!FORBID_LABEL[@]}"; do
  printf '%s\t%s\t%s\n' "${FORBID_LABEL[$i]}" "${FORBID_RE[$i]}" "${FORBID_ALLOW[$i]}" >> "$WORK/forbid.tsv"
done

set +e
perl "$WORK/gate.pl" "$STAGE" "$WORK/forbid.tsv" > "$WORK/residue.tsv" 2> "$WORK/gate.err"
gate_rc=$?
set -e
cat "$WORK/gate.err" >&2 || true

if [ "$gate_rc" -ne 0 ]; then
  violations=$(wc -l < "$WORK/residue.tsv" | tr -d ' ')
  {
    echo ""
    echo "FAIL-CLOSED: $violations forbidden token(s) survived the scrub."
    echo "No tree was written. Affected file(s) per class:"
    cut -f1,2 "$WORK/residue.tsv" | sort -u | sed 's/^/  /'
    echo ""
    echo "Fix the RULES (add a redact, or an allow for a genuine structural"
    echo "value), never the gate."
  } >&2
  exit 3
fi

say ""
say "scrub PASSED — every forbid class is clean on $SHORT"

if [ "$REPORT_ONLY" -eq 1 ]; then
  say "(--report: no tree written)"
  exit 0
fi

# ---------------------------------------------------------------- 5. publish
case "$OUT" in
  /*) OUTABS=$OUT ;;
  *)  OUTABS=$ROOT/$OUT ;;
esac

if [ -e "$OUTABS" ]; then
  die "output path already exists: $OUTABS (remove it or pass --out)" 1
fi

mkdir -p "$(dirname "$OUTABS")"
mv "$STAGE" "$OUTABS"
final=$(find "$OUTABS" -type f | wc -l | tr -d ' ')
say "wrote       : ${OUTABS#"$ROOT"/} ($final files)"
say "base sha    : $FULL"
echo ""
echo "NEXT: this is a TREE, not a push. Committing it to the public repo is a"
echo "separate, deliberate act (a content commit on a parentless branch); the"
echo "private repo stays authoritative and deployable throughout (plan §5)."