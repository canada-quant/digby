#!/usr/bin/env bash
# prodq-detached.test.sh — harness for prodq-detached.sh (long probes in their own container, deploy-proof).
# PATH-injected `docker` + `sudo` shims record every call and serve canned answers; no Docker, no network.
# Pins: the container is created from the LIVE backend's image with `--entrypoint node -w /app`, the probe mounted
# read-only from a private copy, the first network on create and every other one connected; the env file keeps
# single-line KEY=value vars and drops a multi-line value WHOLE; the probe's exit code is the script's; the
# container and both temp files are removed on exit; usage errors (no probe → 2, missing file → 2, no backend → 3).
set -u
cd "$(dirname "$0")"
SBX=$(mktemp -d); trap 'rm -rf "$SBX"' EXIT
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
mkdir -p "$SBX/bin"
cat > "$SBX/bin/docker" <<'SHIM'
#!/usr/bin/env bash
echo "docker $*" >> "$DOCKER_LOG"
case "$1 $2" in
  "ps --format") [ -n "${NO_BACKEND:-}" ] || echo admin-backend-green ;;
  "inspect -f")
    case "$3" in
      *Config.Image*) echo digby-app-green ;;
      *Networks*) echo "crossmodel_default digby_net " ;;
      *Config.Env*) printf 'NODE_ENV=production\nDATABASE_URL=postgres://x\nPEM_KEY=-----BEGIN KEY-----\nabc\n-----END KEY-----\nEMPTY=\nPATH=/usr/bin\n' ;;
      *ExitCode*) echo "${PROBE_RC:-0}" ;;
    esac ;;
  "create --name")
    take=""
    for a in "$@"; do
      if [ "$take" = env ]; then cp "$a" "$DOCKER_LOG.env"; take=""; continue; fi
      if [ "$take" = vol ]; then src="${a%%:*}"; cp "$src" "$DOCKER_LOG.probe"; echo "$src" > "$DOCKER_LOG.probepath"; take=""; continue; fi
      case "$a" in --env-file) take=env ;; -v) take=vol ;; esac
    done
    echo cid ;;
  "start -a") echo 'RESULT {"ok":true}' ;;
esac
SHIM
printf '#!/usr/bin/env bash\nexec "$@"\n' > "$SBX/bin/sudo"
chmod +x "$SBX/bin/docker" "$SBX/bin/sudo"
echo 'console.log("probe")' > "$SBX/probe.js"
run() { DOCKER_LOG="$SBX/log" PATH="$SBX/bin:$PATH" bash ./prodq-detached.sh "$@"; }

echo "=== prodq-detached.sh ==="
rm -f "$SBX"/log*
out=$(run "$SBX/probe.js" --run-id mbk1020a --per-question 2>"$SBX/err"); rc=$?
[ "$rc" = 0 ] && ok "exit 0 when the probe exits 0" || bad "rc=$rc"
printf '%s' "$out" | grep -q '^RESULT {"ok":true}$' && ok "probe stdout passes through" || bad "stdout: $out"
create=$(grep '^docker create ' "$SBX/log")
printf '%s' "$create" | grep -q -- '--entrypoint node -w /app' && ok "runs node from /app (never the server entrypoint)" || bad "create: $create"
printf '%s' "$create" | grep -q -- '--network crossmodel_default ' && ok "created on the backend's first network" || bad "network: $create"
printf '%s' "$create" | grep -qE ':/tmp/probe\.js:ro digby-app-green /tmp/probe\.js --run-id mbk1020a --per-question$' && ok "probe mounted read-only, live image, args forwarded" || bad "image/args: $create"
grep -q '^docker network connect digby_net prodq-detached-' "$SBX/log" && ok "every other network connected" || bad "no network connect"
grep -q '^docker start -a prodq-detached-' "$SBX/log" && ok "started attached (foreground)" || bad "no start -a"
grep -q '^docker rm -f prodq-detached-' "$SBX/log" && ok "container removed on exit" || bad "no rm -f"
cmp -s "$SBX/probe.js" "$SBX/log.probe" && ok "mounts a byte-identical private copy of the probe" || bad "probe copy differs"
[ "$(cat "$SBX/log.probepath")" != "$SBX/probe.js" ] && ok "never mounts the source file itself (a deploy rsync may rewrite it)" || bad "mounted the source"
[ ! -e "$(cat "$SBX/log.probepath")" ] && ok "probe copy removed on exit" || bad "probe copy left behind"
env=$(cat "$SBX/log.env")
printf '%s\n' "$env" | grep -qx 'DATABASE_URL=postgres://x' && ok "env keeps single-line vars" || bad "env: $env"
printf '%s\n' "$env" | grep -qx 'EMPTY=' && ok "env keeps an empty value" || bad "env lost EMPTY="
printf '%s' "$env" | grep -q 'PEM_KEY\|BEGIN\|END KEY\|^abc' && bad "multi-line value leaked: $env" || ok "a multi-line value is dropped whole"
printf '%s\n' "$env" | grep -qx 'PATH=/usr/bin' && ok "the var after a multi-line value survives" || bad "env lost PATH"
ls /var/tmp/prodq-detached-env.* >/dev/null 2>&1 && bad "env temp file left in /var/tmp" || ok "env temp file removed"

rm -f "$SBX"/log*
PROBE_RC=3 run "$SBX/probe.js" >/dev/null 2>&1; rc=$?
[ "$rc" = 3 ] && ok "the probe's exit code is the script's" || bad "rc=$rc (want 3)"

run >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ] && ok "no probe → usage, rc 2" || bad "no-probe rc=$rc"
run "$SBX/missing.js" >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ] && ok "missing probe file → rc 2" || bad "missing rc=$rc"
NO_BACKEND=1 run "$SBX/probe.js" >/dev/null 2>&1; rc=$?
[ "$rc" = 3 ] && ok "no backend container → rc 3" || bad "no-backend rc=$rc"

echo "prodq-detached.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
