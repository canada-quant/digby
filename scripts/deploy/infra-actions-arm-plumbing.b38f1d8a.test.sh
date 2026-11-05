#!/usr/bin/env bash
# b38f1d8a (2026-10-14): pin the INFRA_ACTIONS_ENABLED arming plumbing. The
# switch was grep-verified live as "no lane seat can arm it" because the var
# was NEVER LISTED in the compose env lists — compose interpolates explicit
# ${VAR} keys only, so staging it in .env / env-overrides.env did nothing
# (the same class as the 2026-10-03 compute-policy kill-switch audit). This
# test pins the full channel so a future compose curation cannot silently
# drop it again:
#   (1) docker-compose.app.yml passes INFRA_ACTIONS_ENABLED through to BOTH
#       the backend and the worker services (the gate lives in
#       fleet/infra-actions.service.ts infraActionsArmed(), read from the
#       EXECUTING process's env — backend for chat runs, worker for coding);
#   (2) scripts/ec2-ops/playbook.sh carries the ROLE=coding-c one-shot that
#       stages the value on box C (the ec2-ops env_override dispatch input
#       targets box A only — C's channel is the playbook);
#   (3) .env.example documents the channel + the next-wave apply semantics.
# Semantics of the pass-through: empty ${VAR:-} is UNARMED — infraActionsArmed()
# is `process.env.INFRA_ACTIONS_ENABLED === '1'`, never truthiness (unlike the
# AUTH_SIGNAL_BASELINE_IPS empty-vs-unset class, f134). The armed-posture jest
# coverage lives in infra-actions.service.test.ts; this file pins the plumbing.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$HERE/../.."
APP="$ROOT/docker-compose.app.yml"
PB="$ROOT/scripts/ec2-ops/playbook.sh"
ENVEX="$ROOT/.env.example"
fails=0
check() { # $1=label $2=expected $3=actual
  if [ "$2" = "$3" ]; then echo "ok - $1"; else echo "FAIL - $1 (expected: $2, got: $3)"; fails=$((fails+1)); fi
}
check_grep() { # $1=label $2=pattern $3=file
  if grep -qE -- "$2" "$3"; then echo "ok - $1"; else echo "FAIL - $1 (missing pattern '$2' in $3)"; fails=$((fails+1)); fi
}

for f in "$APP" "$PB" "$ENVEX"; do
  [ -f "$f" ] || { echo "FAIL - required file not found: $f"; exit 1; }
done

# (1) the compose pass-through exists in BOTH service env lists (backend + worker)
n=$(grep -c -- '- INFRA_ACTIONS_ENABLED=${INFRA_ACTIONS_ENABLED:-}' "$APP" || true)
check "compose app.yml passes INFRA_ACTIONS_ENABLED through to 2 service(s)" "2" "$n"

# ...and it is an EMPTY-default interpolation (unset host var ⇒ empty ⇒ unarmed;
# the gate is === '1', so this cannot accidentally arm anything).
check_grep "compose pass-through is empty-default (\${VAR:-})" \
  '- INFRA_ACTIONS_ENABLED=\$\{INFRA_ACTIONS_ENABLED:-\}' "$APP"

# (2) the playbook ROLE=coding-c DISARM one-shot removes the value from box C —
# BOTH files: the staging channel AND the folded .env compose reads (the fold
# MERGES, never removes — cleaning only the overrides would leave a stale =1
# arming every future worker recreate).
pb_del_ov=$(grep -cF 'sudo sed -i '"'"'/^INFRA_ACTIONS_ENABLED=/d'"'"' "$F"' "$PB" || true)
check "playbook coding-c DISARM removes the staged line (env-overrides.env)" "1" "$pb_del_ov"
pb_del_env=$(grep -cF 'sudo sed -i '"'"'/^INFRA_ACTIONS_ENABLED=/d'"'"' "$E"' "$PB" || true)
check "playbook DISARM also cleans the folded /opt/crossmodel/.env (merge-removal gotcha)" "1" "$pb_del_env"
pb_arm_stage=$(grep -cF "echo 'INFRA_ACTIONS_ENABLED=1' | sudo tee -a" "$PB" || true)
check "playbook no longer stages INFRA_ACTIONS_ENABLED=1 (ARM one-shot retired)" "0" "$pb_arm_stage"
check_grep "playbook DISARM one-shot is marker-guarded (idempotent)" "MARKER_B38DISARM" "$PB"

# (3) .env.example documents the staging channel
check_grep ".env.example documents the env-overrides channel" "CHANNEL \(ticket b38f1d8a\)" "$ENVEX"

[ "$fails" -eq 0 ] && { echo "=== infra-actions-arm-plumbing.b38f1d8a: all checks passed ==="; exit 0; }
echo "=== infra-actions-arm-plumbing.b38f1d8a: $fails check(s) FAILED ==="
exit 1
