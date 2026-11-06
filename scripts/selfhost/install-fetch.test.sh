#!/usr/bin/env bash
# install-fetch.test.sh — pins the ONE property install.sh's downloader exists to
# guarantee: a failed fetch leaves NO file behind.
#
# WHY THIS TEST EXISTS (2026-11-06, PR #2581 + its follow-up)
#   install.sh skips work with `[ -f "$COMPOSE" ]`, so an installer that leaves a
#   poisoned file behind is WORSE than one that crashes: every later run "keeps"
#   it and `docker compose -f <poisoned>` dies opaquely, and the operator has no
#   reason to suspect a stale download. Two distinct ways a fetch half-succeeds:
#     * an HTTP error    — `curl -o` / `wget -qO` open the DESTINATION first, so a
#                          404 leaves a 0-byte file;
#     * a truncated body — the server closes early and the bytes already written
#                          stay on disk (measured: curl exits 18 after 65536 of a
#                          promised 1048576 bytes).
#   The first shipped fix covered only the wget branch while its comment claimed
#   "BOTH branches" — so curl hosts, the majority, kept the defect. That is the
#   regression this file pins. A comment cannot catch it; only running the block.
#
# HOW IT IS PROVEN, and why this way
#   The legs EXTRACT the real `_get`/`fetch` block out of scripts/selfhost/install.sh
#   and run it, rather than grepping the source. A grep can confirm `mktemp` is
#   present while the destination is still written in place. The transports are
#   stubbed on PATH so each failure mode is produced on demand, hermetically.
#
# Run from anywhere: bash scripts/selfhost/install-fetch.test.sh
set -u

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SCRIPT=$ROOT/scripts/selfhost/install.sh

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok: %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL: %s\n' "$1"; }

[ -f "$SCRIPT" ] || { echo "FATAL: no $SCRIPT"; exit 1; }

WORK=$(mktemp -d) || exit 1
trap 'rm -rf "$WORK"' EXIT

# ── the real block, extracted verbatim ───────────────────────────────────────
# From the section comment through the closing brace of fetch(). `have` and `die`
# are supplied by this harness (below), so the extraction deliberately starts at
# the comment: install.sh's own definitions live above it and must not be pulled
# in, or the transport could not be forced.
BLOCK=$WORK/block.sh
awk '/^# Downloading a file needs/{on=1} on{print} on && /^\}$/ && seen{exit} on && /^fetch\(\) \{/{seen=1}' \
  "$SCRIPT" >"$BLOCK"
if ! grep -q '^fetch() {' "$BLOCK" || ! grep -q '^}' "$BLOCK"; then
  echo "FATAL: could not extract the fetch block from $SCRIPT"
  exit 1
fi

echo "== syntax (the installer must stay POSIX) =="
if sh -n "$SCRIPT" 2>/dev/null; then ok "sh -n install.sh"; else bad "sh -n install.sh"; fi
if command -v dash >/dev/null 2>&1; then
  if dash -n "$SCRIPT" 2>/dev/null; then ok "dash -n install.sh (no bashisms)"; else bad "dash -n install.sh"; fi
else
  echo "  skip: dash not installed"
fi

# ── stubbed transports ───────────────────────────────────────────────────────
# Each writes partial output to its target and THEN fails, which is the shape
# that defeats a naive `command && keep` check.
STUB=$WORK/bin
mkdir -p "$STUB"
cat >"$STUB/curl" <<'STUBEOF'
#!/bin/sh
# fake curl: curl [-flags] <url> -o <target>
# NOTE the two separate variables: `url` is the FIRST non-flag argument, `out`
# is the one that follows `-o`. Conflating them is how a stub silently stops
# exercising the case it claims to — the dest path would overwrite the url and
# every leg would fall through to the same branch.
url=""; out=""; prev=""
for a in "$@"; do
  [ "$prev" = "-o" ] && out=$a
  case "$a" in -*) ;; *) [ -z "$url" ] && url=$a ;; esac
  prev=$a
done
case "$url" in
  *trunc) head -c 65536 /dev/zero | tr '\0' 'x' >"$out"; exit 18 ;;
  *http404) : >"$out"; exit 22 ;;
  *ok) printf 'GOOD' >"$out"; exit 0 ;;
esac
exit 2
STUBEOF
cat >"$STUB/wget" <<'STUBEOF'
#!/bin/sh
# fake wget: -qO <target> <url>
prev=""; out=""
for a in "$@"; do [ "$prev" = "-qO" ] && out=$a; prev=$a; done
for a in "$@"; do case "$a" in -*) ;; *) url=$a ;; esac; done
case "$url" in
  *trunc) head -c 65536 /dev/zero | tr '\0' 'x' >"$out"; exit 8 ;;
  *http404) : >"$out"; exit 8 ;;
  *ok) printf 'GOOD' >"$out"; exit 0 ;;
esac
exit 2
STUBEOF
chmod +x "$STUB/curl" "$STUB/wget"

# `have` returns true ONLY for the transport under test, which is what selects
# `_get`'s implementation — the same branch a real host would take.
run_fetch() { # <transport> <case> <dest>
  cat >"$WORK/run.sh" <<RUNEOF
have() { case "\$1" in $1) command -v $1 >/dev/null 2>&1 ;; *) return 1 ;; esac; }
die() { echo "die: \$*" >&2; exit 9; }
. "$BLOCK"
fetch "http://example.invalid/$2" "\$1"
RUNEOF
  PATH="$STUB:$PATH" sh "$WORK/run.sh" "$3" >/dev/null 2>&1
}

echo "== a failed fetch must leave NO file (both transports) =="
for T in curl wget; do
  for CASE in trunc http404; do
    DEST="$WORK/out/${T}_${CASE}.yml"
    rm -rf "$WORK/out"; mkdir -p "$WORK/out"
    run_fetch "$T" "$CASE" "$DEST" || true
    if [ -e "$DEST" ]; then
      bad "$T/$CASE: left a file behind ($(wc -c <"$DEST" 2>/dev/null || echo '?') bytes) — the [ -f ] guard would keep it forever"
    else
      ok "$T/$CASE: no file left behind"
    fi
    leftovers=$(ls -a "$WORK/out" 2>/dev/null | grep -c '^\.digby-fetch\.' || true)
    if [ "${leftovers:-0}" -eq 0 ]; then ok "$T/$CASE: no temp file left"; else bad "$T/$CASE: $leftovers temp file(s) left in the dest dir"; fi
  done
done

echo "== a successful fetch lands with the pre-fix mode (0644) =="
for T in curl wget; do
  rm -rf "$WORK/out"; mkdir -p "$WORK/out"
  DEST="$WORK/out/${T}_ok.yml"
  if run_fetch "$T" ok "$DEST"; then
    if [ -f "$DEST" ]; then ok "$T/ok: file written"; else bad "$T/ok: no file written"; fi
    mode=$(ls -l "$DEST" 2>/dev/null | cut -c1-10)
    if [ "$mode" = "-rw-r--r--" ]; then
      ok "$T/ok: mode 0644 (mktemp's 0600 is restored, so the fix is not a silent mode change)"
    else
      bad "$T/ok: mode $mode, expected -rw-r--r--"
    fi
    leftovers=$(ls -a "$WORK/out" | grep -c '^\.digby-fetch\.' || true)
    if [ "${leftovers:-0}" -eq 0 ]; then ok "$T/ok: temp renamed away, not copied"; else bad "$T/ok: $leftovers temp file(s) survived"; fi
  else
    bad "$T/ok: fetch reported failure on a good response"
  fi
done

echo "== the temp file lives in the DESTINATION's directory (so mv is an atomic rename) =="
# A temp in /tmp would be copy+unlink across filesystems, and a reader could see
# a partial file at the destination. Proved by pointing TMPDIR at a sentinel and
# asserting nothing appears there.
SENTINEL=$WORK/tmpdir
mkdir -p "$SENTINEL"
rm -rf "$WORK/out"; mkdir -p "$WORK/out"
DEST="$WORK/out/atomic.yml"
cat >"$WORK/run2.sh" <<RUNEOF
have() { case "\$1" in curl) return 0 ;; *) return 1 ;; esac; }
die() { exit 9; }
. "$BLOCK"
fetch "http://example.invalid/ok" "\$1"
RUNEOF
TMPDIR="$SENTINEL" PATH="$STUB:$PATH" sh "$WORK/run2.sh" "$DEST" >/dev/null 2>&1
if [ -f "$DEST" ]; then ok "destination written with TMPDIR redirected"; else bad "destination not written when TMPDIR is set"; fi
if [ -z "$(ls -A "$SENTINEL")" ]; then
  ok "nothing staged in TMPDIR — the temp is beside the destination (atomic rename)"
else
  bad "temp staged in TMPDIR ($(ls -A "$SENTINEL" | tr '\n' ' ')) — mv would cross filesystems"
fi

echo "== static guard: no transport writes the DESTINATION directly =="
# Belt to the behavioural braces: catches a future edit that reintroduces an
# in-place write on a path the stubs above might not reach.
#
# SCOPE MATTERS. `_get` legitimately writes "$2" — inside _get, $2 is the TEMP
# file, handed to it by fetch(). The destination is only ever fetch()'s own $2,
# and fetch() must reach it solely via mv. So the guard inspects the fetch()
# body alone; scanning the whole file would flag correct code (measured: the
# whole-file form's only hit was `_get() { curl -fsSL "$1" -o "$2"; }`).
FETCH_BODY=$(awk '/^fetch\(\) \{/{on=1} on{print} on&&/^\}$/{exit}' "$SCRIPT")
if [ -z "$FETCH_BODY" ]; then
  bad "could not locate the fetch() body"
else
  # Inside fetch(), a direct write to $2 would look like `-o "$2"` / `-qO "$2"`.
  if printf '%s\n' "$FETCH_BODY" | grep -nE '(-o|-O)[[:space:]]*"\$2"' >/dev/null 2>&1; then
    bad "fetch() writes the destination (\$2) directly instead of mv-ing a temp onto it"
  else
    ok "fetch() never writes \$2 directly — the destination is only reached by mv"
  fi
  if printf '%s\n' "$FETCH_BODY" | grep -q 'mv '; then
    ok "fetch() renames the temp into place (mv present in the body)"
  else
    bad "fetch() has no mv — the temp is never promoted to the destination"
  fi
  # The original F1 defect, named exactly, and scoped to fetch() for the same
  # reason: `_get() { curl -fsSL "$1" -o "$2"; }` is the CORRECT fixed code —
  # there, "$2" is _get's own temp. Whole-file matching would call it a defect.
  if printf '%s\n' "$FETCH_BODY" | grep -q 'curl .*-o[[:space:]]*"\$2"'; then
    bad "the old in-place curl form is back inside fetch() (the F1 defect)"
  else
    ok "the old in-place curl form is gone from fetch()"
  fi
fi
if grep -q 'mktemp "\$_dir/' "$SCRIPT"; then
  ok "mktemp is anchored to the destination directory, not bare mktemp"
else
  bad "mktemp is not anchored to the destination directory"
fi

echo
echo "install-fetch: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1