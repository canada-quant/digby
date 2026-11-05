#!/bin/bash
# prodq-detached.sh — prodq.sh for LONG probes: the probe runs in its OWN container started from the live backend's
# image, env and networks, so a blue-green deploy cannot kill it.
#
# Usage (on the box): bash /opt/crossmodel/scripts/framework-audit/prodq-detached.sh <probe.js> [arg...]
#
# Why (2026-10-20): prodq.sh runs the probe with `docker exec` inside admin-backend-{blue,green}. Every deploy
# removes the old colour's container, and the exec'd probe dies with it. The judge-v2 bench ingest
# (model-bench-ingest.js) runs 1–2 h, and the fleet deploys about every 30 min, so a dry re-ingest started at 22:57Z
# was killed by the next deploy. A container that is not one of the colour containers and not in a compose project
# is left alone by deploy-blue-green.sh (it removes admin-*-<colour> names and `docker compose -p crossmodel_<colour>`
# containers only), and the image of a running container is never pruned.
#
# Same contract as prodq.sh otherwise: the probe sees /app/dist and the backend's own credentials, runs from /app,
# and MUST stay read-only unless the caller passes an explicit write flag the probe itself honours (the ingest's
# --apply). Foreground: stdout / stderr pass through and the exit code is the probe's. The container is removed on
# exit (also when this script is stopped). Env vars whose value spans lines are dropped whole (an env file is
# line-based); the probes need none of them.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
probe="${1:-}"; shift || true
[ -n "$probe" ] || { echo "usage: prodq-detached.sh <probe.js> [arg...]" >&2; exit 2; }
case "$probe" in /*) f="$probe" ;; *) f="$here/$probe" ;; esac
[ -f "$f" ] || { echo "probe not found: $f" >&2; exit 2; }
c="$(sudo docker ps --format '{{.Names}}' | grep -E '^admin-backend-(blue|green)$' | head -1 || true)"
[ -n "$c" ] || { echo "no admin-backend container is running" >&2; exit 3; }
img="$(sudo docker inspect -f '{{.Config.Image}}' "$c")"
read -r -a nets <<<"$(sudo docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$c")"
[ "${#nets[@]}" -gt 0 ] || { echo "could not read $c's networks" >&2; exit 3; }
name="prodq-detached-$(date +%s)-$RANDOM"
envf="$(mktemp /var/tmp/prodq-detached-env.XXXXXX)"
probe_copy="$(mktemp /var/tmp/prodq-detached-probe.XXXXXX.js)"
cleanup() {
  rm -f "$envf" "$probe_copy"
  sudo docker rm -f "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 143' TERM INT
chmod 600 "$envf"
# One KEY=value per line; a var whose value spans lines (a PEM key) is dropped whole, never cut to its first line.
sudo docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$c" | awk '
  /^$/ { next }
  /^[A-Za-z_][A-Za-z0-9_]*=/ { if (prev != "" && !multi) print prev; prev = $0; multi = 0; next }
  { multi = 1 }
  END { if (prev != "" && !multi) print prev }' > "$envf"
# A private copy: a deploy's rsync may rewrite the source file while the probe runs.
cp "$f" "$probe_copy"; chmod 644 "$probe_copy"
sudo docker create --name "$name" --env-file "$envf" --network "${nets[0]}" --memory 2g \
  --entrypoint node -w /app -v "$probe_copy:/tmp/probe.js:ro" "$img" /tmp/probe.js "$@" >/dev/null
rm -f "$envf"
for n in "${nets[@]:1}"; do sudo docker network connect "$n" "$name"; done
echo "prodq-detached: $name from $img (env + networks of $c)" >&2
set +e
sudo docker start -a "$name"
set -e
rc="$(sudo docker inspect -f '{{.State.ExitCode}}' "$name" 2>/dev/null || echo 1)"
exit "$rc"
