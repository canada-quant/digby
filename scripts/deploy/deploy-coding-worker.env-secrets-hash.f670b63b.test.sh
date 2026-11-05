#!/usr/bin/env bash
# f670b63b residual (2026-09-27): env-secrets.env must be part of the worker
# rebuild-input HASH in deploy-coding-worker.sh. The deploy-managed secrets
# (GitHub secrets → /opt/crossmodel-local/env-secrets.env → apply-env-overrides.sh
# folds them into /opt/crossmodel/.env) reach the RUNNING worker only through a
# container recreate. env-overrides.env was hashed but env-secrets.env was NOT,
# so a secrets-only change (e.g. the DIGBY_SMTP_* keys landing 2026-09-27 21:28Z)
# flipped no input: the skip fired and the worker kept its OLD env with EMPTY
# SMTP keys while .env held the real values — machine-triggered runs (which
# execute on the coding box) kept answering notConfigured for hours until an
# unrelated backend change happened to rebuild the worker.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
S="$HERE/deploy-coding-worker.sh"
fails=0
check() { # $1=label $2=expected-substring $3=file
  if grep -qF -- "$2" "$3"; then echo "ok - $1"; else echo "FAIL - $1 (missing: $2)"; fails=$((fails+1)); fi
}
[ -f "$S" ] || { echo "FAIL - deploy-coding-worker.sh not found at $S"; exit 1; }

# (1) the fix: env-secrets.env joins the hashed rebuild inputs
check "HASH block hashes env-secrets.env" "sha256sum /opt/crossmodel-local/env-secrets.env" "$S"

# (2) regression: env-overrides.env and the compose file stay hashed
check "env-overrides.env still hashed" "sha256sum /opt/crossmodel-local/env-overrides.env" "$S"
check "docker-compose.app.yml still hashed" "sha256sum docker-compose.app.yml" "$S"

# (3) skip semantics unchanged: a hash match still requires a RUNNING worker
#     (an absent worker must rebuild even with unchanged inputs)
check "skip still gated on a running worker" 'container_running "admin-worker-${AC}"' "$S"

# (4) the absent-file case must not break the hash computation (|| true)
check "env-secrets sha256sum tolerates absence" 'sha256sum /opt/crossmodel-local/env-secrets.env 2>/dev/null || true' "$S"

[ "$fails" -eq 0 ] && { echo "=== deploy-coding-worker.env-secrets-hash.f670b63b: all checks passed ==="; exit 0; }
echo "=== deploy-coding-worker.env-secrets-hash.f670b63b: $fails check(s) FAILED ==="
exit 1
