#!/usr/bin/env bash
# f670b63b (2026-09-27, P0 owner-filed): pin the DIGBY_SMTP_* env plumbing —
# BOTH channels must carry the keys or the send_email_as_digby tool stays
# "not configured" on part of the fleet:
#   (1) deploy.yml's web .env template (GitHub secrets → /opt/crossmodel/.env,
#       both web boxes, every wave);
#   (2) deploy.yml's coding-box curated env-secrets heredoc (box C's worker
#       .env is never rewritten from secrets — without a list entry the worker
#       never sees the keys; that was the gap this fix closed).
# The compose pass-through (docker-compose.app.yml backend + worker) was already
# present; this test pins the two deploy.yml halves so a future curation cannot
# silently drop SMTP again.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WF="$HERE/../../.github/workflows/deploy.yml"
fails=0
check() { # $1=label $2=expected-substring $3=file
  if grep -qF -- "$2" "$3"; then echo "ok - $1"; else echo "FAIL - $1 (missing: $2 in $3)"; fails=$((fails+1)); fi
}

[ -f "$WF" ] || { echo "FAIL - deploy.yml not found at $WF"; exit 1; }

# (1) the web .env template step carries all five keys from secrets
for k in DIGBY_SMTP_HOST DIGBY_SMTP_PORT DIGBY_SMTP_USER DIGBY_SMTP_PASS DIGBY_SMTP_FROM; do
  check "web .env template has $k" "\${{ secrets.$k }}" "$WF"
done

# (2) the coding-box env-secrets heredoc (SECEOF) carries them too — the
# heredoc feeds /opt/crossmodel-local/env-secrets.env on C, which
# apply-env-overrides.sh folds into the worker .env (empty values dropped).
seceof_start=$(grep -n "<< 'SECEOF'" "$WF" | head -1 | cut -d: -f1)
seceof_end=$(grep -n "^          SECEOF$" "$WF" | head -1 | cut -d: -f1)
if [ -n "$seceof_start" ] && [ -n "$seceof_end" ] && [ "$seceof_end" -gt "$seceof_start" ]; then
  block=$(sed -n "${seceof_start},${seceof_end}p" "$WF")
  for k in DIGBY_SMTP_HOST DIGBY_SMTP_PORT DIGBY_SMTP_USER DIGBY_SMTP_PASS DIGBY_SMTP_FROM; do
    if printf '%s' "$block" | grep -q "$k="; then echo "ok - coding-box SECEOF has $k"; else echo "FAIL - coding-box SECEOF missing $k"; fails=$((fails+1)); fi
  done
else
  echo "FAIL - could not locate the SECEOF heredoc in deploy.yml"
  fails=$((fails+1))
fi

# (3) the compose pass-through still exists (backend + worker in app.yml)
APP="$HERE/../../docker-compose.app.yml"
n=$(grep -c "DIGBY_SMTP_USER=" "$APP" || true)
if [ "$n" -ge 2 ]; then echo "ok - compose app.yml passes DIGBY_SMTP_USER through $n service(s)"; else echo "FAIL - expected ≥2 DIGBY_SMTP_USER pass-throughs in app.yml, found $n"; fails=$((fails+1)); fi

[ "$fails" -eq 0 ] && { echo "=== smtp-env-secrets.f670b63b: all checks passed ==="; exit 0; }
echo "=== smtp-env-secrets.f670b63b: $fails check(s) FAILED ==="
exit 1
