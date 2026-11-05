#!/usr/bin/env bash
# apply-env-overrides.sh — runs ON THE PROD BOX over ssh (deploy.yml scp's it
# to /tmp and execs it with stdin from /dev/null — ticket 19ddfe80; NEVER pipe
# scripts over ssh stdin, any stdin-reading command would eat the rest).
#
# Box-local overrides win over the secret-based template. The file lives
# OUTSIDE the rsync root (deploys never delete it) and OUTSIDE git (no secret
# ever enters the repo) — staged via the ec2-ops workflow's `env_override`
# dispatch input (see ec2-ops.yml). Values never echo anywhere (count-only
# output contract); no | or & in values.
#
# Hardening (ticket 18787730 — 2026-08-22 incident): at 05:39Z something
# rewrote /opt/crossmodel-local/env-overrides.env as root:root 600 and the
# ubuntu deploy user's read failed, blocking every deploy at this step. The
# read now falls back to `sudo -n cat` (EC2 ubuntu has NOPASSWD sudo), and an
# existing-but-unreadable file fails the step LOUDLY with a fix instruction
# instead of dying on the bare redirect (old behavior) or silently applying
# zero overrides.
set -e

F="${OVERRIDES_FILE:-/opt/crossmodel-local/env-overrides.env}"
TARGET="${ENV_FILE:-/opt/crossmodel/.env}"
# Deploy-managed seat secrets (2026-09-25, box C): written by deploy.yml's
# coding-box step from GitHub secrets; folded in BEFORE the box-local
# overrides so those still win. Absent on the web boxes (their .env is
# rewritten from secrets directly).
S="${SECRETS_FILE:-/opt/crossmodel-local/env-secrets.env}"

# One-time purge of model-provider key lines from the box-local overrides
# (2026-10-12 credential rotation). The overrides file is applied AFTER the
# GitHub-secret values, so a key once staged here (the env_override rotation
# path) would keep overriding the rotated secret on that box forever. Each box
# drops these lines ONCE — at the first deploy that carries this block — and
# records a marker next to the file; a key staged through env_override after
# that is honoured as before. Count-only output (nothing printed when there
# was nothing to drop); values never echo. To run a purge again for a future
# rotation, bump PURGE_ID.
PURGE_ID="2026-10-12-model-keys"
PURGE_KEYS="MOONSHOT_API_KEY|DEEPSEEK_API_KEY|ZAI_API_KEY|DASHSCOPE_API_KEY|TYPESAFE_API_KEY|OPENAI_API_KEY|XAI_GROK_API_KEY|GOOGLE_GEMINI_API_KEY|COHERE_API_KEY"
purge_model_key_overrides() {
  local dir marker tmp n
  dir=$(dirname "$F")
  marker="$dir/.override-purge-$PURGE_ID"
  if [ -e "$marker" ] || sudo -n test -e "$marker" 2>/dev/null; then return 0; fi
  if [ -s "$F" ] || sudo -n test -s "$F" 2>/dev/null; then
    tmp=$(mktemp)
    chmod 600 "$tmp"
    if ! { cat "$F" 2>/dev/null || sudo -n cat "$F" 2>/dev/null; } > "$tmp"; then
      rm -f "$tmp"
      return 0 # unreadable — apply_file below fails loudly with the fix
    fi
    n=$(grep -cE "^($PURGE_KEYS)=" "$tmp" || true)
    if [ "${n:-0}" -gt 0 ]; then
      grep -vE "^($PURGE_KEYS)=" "$tmp" > "$tmp.new" || true
      # Write in place (cat >) so the file keeps its owner and mode.
      if { cat "$tmp.new" > "$F"; } 2>/dev/null || sudo -n tee "$F" < "$tmp.new" >/dev/null 2>&1; then
        echo "purged $n stale model-key override line(s) ($PURGE_ID)"
      else
        # Never block the deploy over the purge; no marker, so it retries next deploy.
        echo "WARNING: could not rewrite $F to drop $n stale model-key line(s) — left unchanged; fix: chown ubuntu:ubuntu $F" >&2
        rm -f "$tmp" "$tmp.new"
        return 0
      fi
    fi
    rm -f "$tmp" "$tmp.new"
  fi
  { mkdir -p "$dir" && touch "$marker"; } 2>/dev/null \
    || sudo -n sh -c 'mkdir -p "$1" && touch "$2"' _ "$dir" "$marker" 2>/dev/null || true
}
purge_model_key_overrides

# One-time purge #2 (2026-10-20): keys whose ONLY legitimate source is a
# GitHub secret. A box-local copy of one of these keeps beating the secret
# forever, so a rotation never lands on that box. Two classes:
#   SECRET_AUTHORITATIVE_KEYS — the deployed secret is the value in use on the
#     boxes that matter (CODING_EGRESS_SECRET: B and C, where the dev
#     containers live, already run the secret; box A held a stale copy). The
#     box line is dropped once the deployed env carries a non-empty value.
#   SECRET_MATCH_ONLY_KEYS — the box copy may be the live value while the
#     secret catches up (the Google OAuth pair after the 2026-10-20 rotation).
#     The box line is dropped ONLY when it is identical to the deployed value,
#     so a mistyped or not-yet-updated secret can never replace a working one.
# A key it keeps is named (never its value) and the purge retries every
# deploy until nothing is kept; then the marker lands. A missing or empty
# secret never blanks a setting.
# Kill switch: SECRET_OWNED_OVERRIDE_PURGE_DISABLED=1 (in the box env) skips it.
SECRET_PURGE_ID="2026-10-20-secret-owned"
SECRET_AUTHORITATIVE_KEYS="CODING_EGRESS_SECRET"
SECRET_MATCH_ONLY_KEYS="GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET GOOGLE_TOKEN_ENCRYPTION_KEY GOOGLE_MCP_API_KEY"
deployed_value() { # $1 = key; its value in the .env, else the coding box's secrets file (may be empty)
  local k="$1" f v
  for f in "$TARGET" "$S"; do
    [ -n "$f" ] || continue
    v=$({ cat "$f" 2>/dev/null || sudo -n cat "$f" 2>/dev/null; } | grep -E "^$k=" | tail -1 | cut -d= -f2-)
    [ -n "$v" ] && { printf '%s' "$v"; return 0; }
  done
  return 1
}
purge_secret_owned_overrides() {
  [ "${SECRET_OWNED_OVERRIDE_PURGE_DISABLED:-0}" = "1" ] && return 0
  local dir marker tmp k dv ov drop="" kept="" differs="" n=0
  dir=$(dirname "$F")
  marker="$dir/.override-purge-$SECRET_PURGE_ID"
  if [ -e "$marker" ] || sudo -n test -e "$marker" 2>/dev/null; then return 0; fi
  if [ -s "$F" ] || sudo -n test -s "$F" 2>/dev/null; then
    tmp=$(mktemp)
    chmod 600 "$tmp"
    if ! { cat "$F" 2>/dev/null || sudo -n cat "$F" 2>/dev/null; } > "$tmp"; then
      rm -f "$tmp"
      return 0 # unreadable — apply_file below fails loudly with the fix
    fi
    for k in $SECRET_AUTHORITATIVE_KEYS $SECRET_MATCH_ONLY_KEYS; do
      grep -qE "^$k=" "$tmp" || continue
      if ! dv=$(deployed_value "$k"); then kept="$kept $k"; continue; fi
      case " $SECRET_MATCH_ONLY_KEYS " in
        *" $k "*)
          ov=$(grep -E "^$k=" "$tmp" | tail -1 | cut -d= -f2-)
          if [ "$ov" != "$dv" ]; then differs="$differs $k"; continue; fi ;;
      esac
      drop="$drop|$k"; n=$((n + 1))
    done
    if [ "$n" -gt 0 ]; then
      grep -vE "^(${drop#|})=" "$tmp" > "$tmp.new" || true
      if { cat "$tmp.new" > "$F"; } 2>/dev/null || sudo -n tee "$F" < "$tmp.new" >/dev/null 2>&1; then
        echo "purged $n box-local override line(s) the GitHub secrets own ($SECRET_PURGE_ID): $(printf '%s' "${drop#|}" | tr '|' ' ')"
      else
        echo "WARNING: could not rewrite $F to drop $n secret-owned line(s) — left unchanged; fix: chown ubuntu:ubuntu $F" >&2
        rm -f "$tmp" "$tmp.new"
        return 0
      fi
    fi
    [ -n "$kept" ] && echo "kept box-local override(s) with no deployed secret value yet ($SECRET_PURGE_ID):$kept"
    [ -n "$differs" ] && echo "kept box-local override(s) that differ from the GitHub secret — update the secret to the live value and they clear on the next deploy ($SECRET_PURGE_ID):$differs"
    rm -f "$tmp" "$tmp.new"
    # Anything kept is retried next deploy (no marker yet).
    [ -n "$kept$differs" ] && return 0
  fi
  { mkdir -p "$dir" && touch "$marker"; } 2>/dev/null \
    || sudo -n sh -c 'mkdir -p "$1" && touch "$2"' _ "$dir" "$marker" 2>/dev/null || true
}
purge_secret_owned_overrides

apply_file() { # $1=file $2=label $3=absent-message ('' = silent) $4=divergence-report (1 = warn per key)
  local F="$1" label="$2" absent="$3" report="${4:-0}"
  local diverged="" redundant=""
  if [ ! -s "$F" ] && ! sudo -n test -s "$F" 2>/dev/null; then
    [ -n "$absent" ] && echo "$absent"
    return 0
  fi

# Readability pre-check (plain, then sudo) — process-substitution failures do
# NOT trip set -e in the parent shell, so the check must be explicit.
if ! cat "$F" >/dev/null 2>&1 && ! sudo -n cat "$F" >/dev/null 2>&1; then
  echo "ERROR: $F exists but is unreadable (plain read AND sudo -n cat both denied)." >&2
  echo "Fix on the box: chown ubuntu:ubuntu $F  (or repair the ubuntu sudoers entry)." >&2
  exit 1
fi

n=0
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in \#*|"") continue ;; esac
  k="${line%%=*}"
  # Keys are interpolated into grep/sed patterns — restrict to real env-var
  # names or a metachar key (A.B) rewrites UNRELATED lines (PR #308 review).
  if ! printf '%s' "$k" | grep -qE '^[A-Za-z_][A-Za-z0-9_]*$'; then
    echo "ERROR: refusing invalid env key name in $F (not [A-Za-z_][A-Za-z0-9_]*): line $((n+1))" >&2
    exit 1
  fi
  if [ "$report" = "1" ]; then
    # Override divergence report (2026-10-19, review of the Grok-bot ops):
    # a box-local override silently beats the GitHub secret on every deploy,
    # so a rotated secret never reaches this box while an override pins the
    # old value. Name each key whose override DIFFERS from the value the
    # deploy just wrote (key names only — values never echo), and each one
    # that is now REDUNDANT (identical, safe to delete).
    current=$(grep -m1 "^$k=" "$TARGET" 2>/dev/null || true)
    if [ -n "$current" ] && [ "$current" != "$line" ]; then diverged="$diverged $k"
    elif [ -n "$current" ]; then redundant="$redundant $k"; fi
  fi
  if grep -q "^$k=" "$TARGET"; then
    # Escape the sed RHS: an unescaped backslash corrupts secrets silently
    # (\n → newline, \t → tab) and \1 aborts sed mid-loop (PR #308 review).
    escaped=$(printf '%s' "$line" | sed 's/[\\&|]/\\&/g')
    sed -i "s|^$k=.*|$escaped|" "$TARGET"
  else
    echo "$line" >> "$TARGET"
  fi
  n=$((n+1))
done < <(cat "$F" 2>/dev/null || sudo -n cat "$F")
echo "applied $n $label"
if [ -n "$diverged" ]; then
  echo "::warning::box-local env overrides on $(hostname 2>/dev/null || echo this-box) BEAT the GitHub secrets for:$diverged — the deployed secret value is NOT in use here. If the secret was rotated, delete these lines from $F (ec2-ops env_override) so the secret takes effect."
fi
if [ -n "$redundant" ]; then
  echo "box-local env overrides identical to the deployed value (redundant, safe to delete):$redundant"
fi
}

apply_file "$S" "deploy-managed seat secret(s)" ""
apply_file "$F" "env override(s)" "no box-local env overrides" 1
