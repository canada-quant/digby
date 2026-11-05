#!/usr/bin/env bash
# Regression test — deploy-speed switches (2026-09-26 wave anatomy; deploy_speedups
# #1 cache keep, #2 Dockerfile chown, #3 stateless pre-build, #5 shared worker
# image, #6 frontend content bust, #8 drain floor + single prune).
#
# The wave anatomy (runs 36200008105 / 36195616766): 9-min builds on every web
# box because `docker builder prune --keep-storage 10GB` evicted the previous
# wave's layers every time; a 2-min `chown -R /app` in every backend build; a
# worker image built + exported on box B that never runs one; a 60 s drain floor
# served even at 0 runs; two builder prunes per box; B's build waiting for A's
# whole phase; the frontend rebuilt on backend-only waves.
#
# Invariants pinned here (deploy-blue-green.sh + deploy.yml are owner-guarded; the
# defaults must be exactly what the diagnosis rated low-risk, and #3/#6 must be OFF):
#   1. bash -n parses every touched script.
#   2. #1  BUILDER_CACHE_KEEP defaults to 40GB; no literal 10GB prune remains; the
#          ≥90 % / ≥95 % pre-flight disk guards are intact.
#   3. #8  exactly ONE builder prune on the default path (post-build); the
#          end-of-deploy prune only under BUILDER_PRUNE_ONCE_DISABLED=1.
#   4. #8  DRAIN_SECONDS defaults to 10, non-numeric → 10, 60 restores; the floor
#          sleep and the /drain-status poll are still there.
#   5. #5  the build is `backend frontend` unless WORKER_IMAGE_SHARED_DISABLED=1;
#          compose: worker image = ${APP_IMAGE:-digby-app-${BG_COLOR}} with its build
#          stanza kept; backend/relay tags unchanged; deploy-coding-worker.sh
#          carries APP_IMAGE on EVERY compose call and pins the per-wave name.
#   6. #2  backend/Dockerfile: no unconditional recursive chown; COPY --chown on the
#          five shipped trees; ARG BACKEND_CHOWN_RECURSIVE (default 0) gates the
#          recursive path; compose passes the arg; the entrypoint still chowns the
#          volume roots.
#   7. #6  DEFAULT OFF: the build arg is DEPLOY_SHA unless FRONTEND_CONTENT_BUST=1;
#          the runtime `up` still gets the commit; frontend-bust-key.sh is
#          deterministic, parity-safe, content-sensitive and ignores node_modules.
#   8. #3  DEFAULT OFF: deploy.yml gates on PREBUILD_STATELESS=1 (kill switch
#          PREBUILD_STATELESS_DISABLED=1), waits for a host's pre-build BEFORE its
#          deploy, keeps the remote timeout wrap intact, and forwards every switch;
#          prebuild-inactive.sh (shimmed) builds the INACTIVE colour with the
#          deploy's exact inputs and refuses when disabled / a deploy runs / disk ≥90 %.
#
# Plain-bash idiom, mirrors scripts/deploy/blue-green-drain-extension.test.sh.
# Run from anywhere: bash scripts/deploy/blue-green-speedups.test.sh

set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY="$ROOT/deploy-blue-green.sh"
COMPOSE="$ROOT/docker-compose.app.yml"
DOCKERFILE="$ROOT/backend/Dockerfile"
ENTRYPOINT="$ROOT/backend/entrypoint.sh"
YML="$ROOT/.github/workflows/deploy.yml"
CW="$ROOT/scripts/deploy/deploy-coding-worker.sh"
PRE="$ROOT/scripts/deploy/prebuild-inactive.sh"
KEY="$ROOT/scripts/deploy/frontend-bust-key.sh"

failures=0
ok()  { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; failures=$((failures + 1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$2] got [$3])"; fi; }

for f in "$DEPLOY" "$COMPOSE" "$DOCKERFILE" "$ENTRYPOINT" "$YML" "$CW" "$PRE" "$KEY"; do
  [ -f "$f" ] || { bad "missing file: $f"; echo "$failures invariant(s) violated" >&2; exit 1; }
done

# Print the lines of one compose service block (2-space-indented `name:` header).
svc_block() {
  awk -v svc="$1" '
    $0 == "  " svc ":" { in_svc = 1; next }
    /^  [a-z0-9-]+:$/ { in_svc = 0 }
    in_svc { print }
  ' "$COMPOSE"
}

# ── 1. syntax ────────────────────────────────────────────────────────────────
for f in "$DEPLOY" "$CW" "$PRE" "$KEY"; do
  if bash -n "$f" 2>/dev/null; then ok "$(basename "$f") parses (bash -n)"; else bad "$(basename "$f") has a syntax error"; fi
done

# ── 2. #1 BuildKit cache keep ─────────────────────────────────────────────────
KEEP_DEFAULT=$(sed -n 's/^BUILDER_CACHE_KEEP="\${BUILDER_CACHE_KEEP:-\([^}]*\)}"$/\1/p' "$DEPLOY" | head -1)
check "#1 BUILDER_CACHE_KEEP defaults to 40GB" "40GB" "${KEEP_DEFAULT:-missing}"
check "#1 no literal '--keep-storage 10GB' remains (the eviction that killed the cache)" "0" "$(grep -c 'keep-storage 10GB' "$DEPLOY")"
check "#1 the post-build prune uses \$BUILDER_CACHE_KEEP" "1" "$(grep -c 'docker builder prune -f --keep-storage "\$BUILDER_CACHE_KEEP" 2>/dev/null | tail -1 || true' "$DEPLOY")"
check "#1 pre-flight ≥90% disk guard intact (proven-safe prune set)" "1" "$(grep -c '^if \[ "\${DISK_PCT:-0}" -ge 90 \]; then$' "$DEPLOY")"
check "#1 pre-flight ≥95% abort intact" "1" "$(grep -c '^if \[ "\${DISK_PCT:-0}" -ge 95 \]; then$' "$DEPLOY")"
check "#1 pre-flight guard still prunes ALL builder cache when critical" "1" "$(grep -c '^    sudo docker builder prune -af 2>&1' "$DEPLOY")"
# The default-path prune must run BEFORE migrations (the site that also covers failed deploys).
PRUNE_LINE=$(grep -n 'docker builder prune -f --keep-storage "\$BUILDER_CACHE_KEEP" 2>/dev/null | tail -1' "$DEPLOY" | head -1 | cut -d: -f1)
MIGRATE_LINE=$(grep -n 'Running database migrations' "$DEPLOY" | head -1 | cut -d: -f1)
if [ -n "$PRUNE_LINE" ] && [ -n "$MIGRATE_LINE" ] && [ "$PRUNE_LINE" -lt "$MIGRATE_LINE" ]; then
  ok "#1 the one default prune sits right after the build (before migrations)"
else
  bad "#1 the default prune must sit between build and migrations (prune line ${PRUNE_LINE:-?}, migrate line ${MIGRATE_LINE:-?})"
fi

# ── 3. #8 one builder prune per box ──────────────────────────────────────────
check "#8 exactly three 'docker builder prune' sites (pre-flight -af, post-build, gated end-of-deploy)" "3" "$(grep -c '^ *sudo docker builder prune' "$DEPLOY")"
CLEANUP=$(sed -n '/^# ── Cleanup/,/^# ── Final health/p' "$DEPLOY")
check "#8 the end-of-deploy prune is inside the BUILDER_PRUNE_ONCE_DISABLED=1 guard" "1" "$(printf '%s\n' "$CLEANUP" | grep -c '^if \[ "\${BUILDER_PRUNE_ONCE_DISABLED:-0}" = "1" \]; then$')"
check "#8 the guarded prune uses \$BUILDER_CACHE_KEEP too" "1" "$(printf '%s\n' "$CLEANUP" | grep -c '^    sudo docker builder prune -f --keep-storage "\$BUILDER_CACHE_KEEP" 2>/dev/null || true$')"
check "#8 image prune (until=1h) at cleanup is untouched" "1" "$(printf '%s\n' "$CLEANUP" | grep -c 'docker image prune -a -f --filter "until=1h"')"

# ── 4. #8 drain floor ────────────────────────────────────────────────────────
FLOOR_DEFAULT=$(sed -n 's/^DRAIN_SECONDS="\${DRAIN_SECONDS:-\([0-9][0-9]*\)}"$/\1/p' "$DEPLOY" | head -1)
check "#8 DRAIN_SECONDS defaults to 10 (was the unconditional 60 s floor)" "10" "${FLOOR_DEFAULT:-missing}"
FLOOR_SNIPPET=$(grep -E '^DRAIN_SECONDS="\$\{DRAIN_SECONDS:-[0-9]+\}"$|^case "\$DRAIN_SECONDS" in' "$DEPLOY")
check "#8 the floor has a numeric guard (a bad Variable must not break a post-commit drain)" "2" "$(printf '%s\n' "$FLOOR_SNIPPET" | grep -c .)"
floor_with() { ( unset DRAIN_SECONDS; [ -n "$1" ] && export DRAIN_SECONDS="$1"; eval "$FLOOR_SNIPPET"; echo "$DRAIN_SECONDS" ); }
check "#8 unset → 10" "10" "$(floor_with '')"
check "#8 DRAIN_SECONDS=60 restores the historical minute" "60" "$(floor_with 60)"
check "#8 non-numeric → 10" "10" "$(floor_with abc)"
check "#8 the floor sleep is still served once" "1" "$(grep -c '^sleep "\$DRAIN_SECONDS"$' "$DEPLOY")"
check "#8 the /drain-status poll still exits at 0 active chat runs" "1" "$(grep -c '^    if \[ "\$ACTIVE_RUNS" = "0" \]; then$' "$DEPLOY")"
check "#8 the drain still retires the old backend first" "1" "$(grep -c 'POST "http://localhost:\${OLD_BE_PORT}/drain-status/retire"' "$DEPLOY")"

# ── 5. #5 worker runs the backend image ──────────────────────────────────────
check "#5 BUILD_SERVICES defaults to 'backend frontend'" "backend frontend" "$(sed -n 's/^BUILD_SERVICES="\(.*\)"$/\1/p' "$DEPLOY" | head -1)"
check "#5 WORKER_IMAGE_SHARED_DISABLED=1 restores the full-service build (exactly one gate)" "1" "$(grep -c '^if \[ "\${WORKER_IMAGE_SHARED_DISABLED:-0}" = "1" \]; then$' "$DEPLOY")"
check "#5 the gate empties BUILD_SERVICES (= every service, today's behaviour)" "1" "$(grep -c '^    BUILD_SERVICES=""$' "$DEPLOY")"
check "#5 the build line takes \$BUILD_SERVICES" "1" "$(grep -c 'docker compose -p "crossmodel_\${INACTIVE}" -f "\$APP_COMPOSE" build \$BUILD_SERVICES$' "$DEPLOY")"
check "#5 the worker is still started by 'up -d' on worker boxes (A)" "1" "$(grep -c 'docker compose -p "crossmodel_\${INACTIVE}" -f "\$APP_COMPOSE" up -d$' "$DEPLOY")"
WORKER_BLOCK=$(svc_block worker)
check "#5 compose worker image = \${APP_IMAGE:-digby-app-\${BG_COLOR}}" "1" "$(printf '%s\n' "$WORKER_BLOCK" | grep -c '^    image: \${APP_IMAGE:-digby-app-\${BG_COLOR}}$')"
check "#5 compose worker keeps its build stanza (kill switch + box C 'build worker')" "1" "$(printf '%s\n' "$WORKER_BLOCK" | grep -c '^      context: ./backend$')"
check "#5 compose worker still runs dist/worker.js" "1" "$(printf '%s\n' "$WORKER_BLOCK" | grep -c 'command: \["node", "dist/worker.js"\]')"
check "#5 compose backend tag unchanged (digby-app-\${BG_COLOR})" "1" "$(svc_block backend | grep -c '^    image: digby-app-\${BG_COLOR}$')"
check "#5 compose relay tag unchanged (digby-app-\${BG_COLOR})" "1" "$(svc_block relay | grep -c '^    image: digby-app-\${BG_COLOR}$')"
# deploy-coding-worker.sh: every compose call that touches the worker carries APP_IMAGE
CW_CALLS=$(grep -c 'docker compose -p .* -f docker-compose.app.yml \(build\|up\) .*worker' "$CW")
CW_WITH_IMAGE=$(awk '/APP_IMAGE=/ { armed = 1; next } /docker compose -p .* -f docker-compose.app.yml (build|up) .*worker/ { if (armed) n++; armed = 0; next } { armed = 0 } END { print n + 0 }' "$CW")
check "#5 deploy-coding-worker.sh has worker compose calls" "6" "$CW_CALLS"
check "#5 every worker compose call on box C carries APP_IMAGE (an unset one would look for digby-app-<colour>, absent on C)" "$CW_CALLS" "$CW_WITH_IMAGE"
check "#5 box C pins the per-wave tag its drainer parking/pruning expects" "1" "$(grep -c '^APP_IMAGE="\${NPROJ}-worker"$' "$CW")"
check "#5 legacy (same-project) paths pin <project>-worker" "4" "$(grep -c 'APP_IMAGE="\${PROJ}-worker"' "$CW")"
check "#5 prune_worker_images still keys on the crossmodel_<colour>[_epoch]-worker pattern" "1" "$(grep -c "grep -E '\^crossmodel_(blue|green)(_\[0-9\]+)?-worker:'" "$CW")"

# ── 6. #2 backend/Dockerfile ownership ───────────────────────────────────────
check "#2 no unconditional recursive chown of /app" "0" "$(grep -c '^    chown -R nodejs:nodejs /app$' "$DOCKERFILE")"
CHOWN_RUN='if \[ "\$BACKEND_CHOWN_RECURSIVE" = "1" \]; then chown -R nodejs:nodejs /app; else chown nodejs:nodejs /app /app/coding-workspaces; fi'
check "#2 the recursive walk is gated on BACKEND_CHOWN_RECURSIVE=1; default = non-recursive chown of /app + workspace root" "1" "$(grep -c "$CHOWN_RUN" "$DOCKERFILE")"
ARG_LINE=$(grep -n '^ARG BACKEND_CHOWN_RECURSIVE=0$' "$DOCKERFILE" | head -1 | cut -d: -f1)
RUN_LINE=$(grep -n "$CHOWN_RUN" "$DOCKERFILE" | head -1 | cut -d: -f1)
if [ -n "$ARG_LINE" ] && [ -n "$RUN_LINE" ] && [ "$ARG_LINE" -lt "$RUN_LINE" ]; then
  ok "#2 ARG BACKEND_CHOWN_RECURSIVE=0 is declared before the RUN that reads it"
else
  bad "#2 ARG BACKEND_CHOWN_RECURSIVE=0 must precede the chown RUN (arg line ${ARG_LINE:-?}, run line ${RUN_LINE:-?})"
fi
check "#2 five shipped trees are COPY --chown'ed to the app uid/gid" "5" "$(grep -c -- '--chown=1001:1001' "$DOCKERFILE")"
for tree in 'prisma ./prisma/' 'prisma.config.ts ./' '/app/dist ./dist' '/app/node_modules/.prisma ./node_modules/.prisma' '/app/openapi.json ./openapi.json'; do
  check "#2 COPY --chown covers '$tree'" "1" "$(grep -c -- "--chown=1001:1001 $tree" "$DOCKERFILE")"
done
check "#2 the app user is uid 1001 (matches the --chown ids)" "1" "$(grep -c 'adduser -S nodejs -u 1001' "$DOCKERFILE")"
check "#2 the app group is gid 1001 (matches the --chown ids)" "1" "$(grep -c 'addgroup -g 1001 -S nodejs' "$DOCKERFILE")"
check "#2 the workspace root is still created in the image" "1" "$(grep -c 'mkdir -p /app/coding-workspaces' "$DOCKERFILE")"
check "#2 entrypoint still chowns the mounted volume roots synchronously" "1" "$(grep -c '^chown nodejs:nodejs "\$WORKSPACE" "\$ENVROOT"' "$ENTRYPOINT")"
check "#2 entrypoint still runs the background recursive repair of the volumes" "2" "$(grep -c 'chown -R nodejs:nodejs "\$WORKSPACE" "\$ENVROOT"' "$ENTRYPOINT")"
check "#2 compose passes BACKEND_CHOWN_RECURSIVE (default 0) to the backend + worker builds" "2" "$(grep -c '^        - BACKEND_CHOWN_RECURSIVE=\${BACKEND_CHOWN_RECURSIVE:-0}$' "$COMPOSE")"
check "#2 the deploy build forwards BACKEND_CHOWN_RECURSIVE into compose" "1" "$(grep -c 'BACKEND_CHOWN_RECURSIVE="\${BACKEND_CHOWN_RECURSIVE:-0}" \\$' "$DEPLOY")"

# ── 7. #6 frontend content bust — DEFAULT OFF ────────────────────────────────
check "#6 the bust key defaults to the commit (FRONTEND_BUST_KEY=\$DEPLOY_SHA)" "1" "$(grep -c '^FRONTEND_BUST_KEY="\$DEPLOY_SHA"$' "$DEPLOY")"
check "#6 content hashing only under FRONTEND_CONTENT_BUST=1 (exactly one gate)" "1" "$(grep -c '^if \[ "\${FRONTEND_CONTENT_BUST:-0}" = "1" \]; then$' "$DEPLOY")"
check "#6 the helper's failure falls back to the commit" "1" "$(grep -c '^    \[ -n "\$FRONTEND_BUST_KEY" \] || FRONTEND_BUST_KEY="\$DEPLOY_SHA"$' "$DEPLOY")"
check "#6 the BUILD gets the bust key" "1" "$(grep -c 'DEPLOY_SHA="\$FRONTEND_BUST_KEY"' "$DEPLOY")"
check "#6 both 'up' lines still get the commit as the runtime DEPLOY_SHA (box_health)" "2" "$(grep -c 'DEPLOY_SHA="\$DEPLOY_SHA" \\$' "$DEPLOY")"
check "#6 the commit still comes from .deploy-sha" "1" "$(grep -c '^DEPLOY_SHA="\$(cat /opt/crossmodel/.deploy-sha 2>/dev/null || date -u +%s)"$' "$DEPLOY")"
check "#6 frontend/Dockerfile still busts on DEPLOY_SHA before COPY . ." "1" "$(grep -c '^ARG DEPLOY_SHA=dev$' "$ROOT/frontend/Dockerfile")"
# functional: frontend-bust-key.sh
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/fe/sub" "$TMP/fe/node_modules/pkg" "$TMP/fe/.next"
printf 'a\n' > "$TMP/fe/a.txt"; printf 'b\n' > "$TMP/fe/sub/b.txt"
printf 'x\n' > "$TMP/fe/node_modules/pkg/x.js"; printf 'n\n' > "$TMP/fe/.next/n"; printf 'l\n' > "$TMP/fe/z.log"
K1=$(bash "$KEY" "$TMP/fe"); RC=$?
check "#6 key helper exits 0 on a tree" "0" "$RC"
case "$K1" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ok "#6 key is 40 hex chars (commit-sha shape: $K1)" ;;
  *) bad "#6 key must be 40 hex chars, got '$K1'" ;;
esac
check "#6 key is deterministic (same tree twice)" "$K1" "$(bash "$KEY" "$TMP/fe")"
cp -R "$TMP/fe" "$TMP/fe-copy"
check "#6 key is parity-safe (an identical copy — the other box's rsync — hashes the same)" "$K1" "$(bash "$KEY" "$TMP/fe-copy")"
printf 'x2\n' > "$TMP/fe/node_modules/pkg/x.js"; printf 'n2\n' > "$TMP/fe/.next/n"; printf 'l2\n' > "$TMP/fe/z.log"
check "#6 node_modules / .next / *.log changes do not move the key" "$K1" "$(bash "$KEY" "$TMP/fe")"
printf 'a-changed\n' > "$TMP/fe/a.txt"
K2=$(bash "$KEY" "$TMP/fe")
if [ "$K2" != "$K1" ]; then ok "#6 a source change moves the key ($K1 → $K2)"; else bad "#6 a source change must move the key"; fi
printf 'c\n' > "$TMP/fe/sub/c.txt"
K3=$(bash "$KEY" "$TMP/fe")
if [ "$K3" != "$K2" ]; then ok "#6 a new source file moves the key"; else bad "#6 a new file must move the key"; fi
bash "$KEY" "$TMP/does-not-exist" >/dev/null 2>&1; check "#6 missing dir → exit 1 (caller falls back to the commit)" "1" "$?"
mkdir -p "$TMP/empty"; bash "$KEY" "$TMP/empty" >/dev/null 2>&1; check "#6 empty dir → exit 1 (never hash nothing)" "1" "$?"

# ── 8. #3 stateless pre-build — DEFAULT OFF ──────────────────────────────────
check "#3 deploy.yml reads PREBUILD_STATELESS from repo Variables" "1" "$(grep -c '^          PREBUILD_STATELESS: \${{ vars.PREBUILD_STATELESS }}$' "$YML")"
check "#3 deploy.yml reads the kill switch from repo Variables" "1" "$(grep -c '^          PREBUILD_STATELESS_DISABLED: \${{ vars.PREBUILD_STATELESS_DISABLED }}$' "$YML")"
check "#3 the pre-build block is gated on PREBUILD_STATELESS=1 AND not DISABLED (exactly one gate)" "1" "$(grep -c '^          if \[ "\${PREBUILD_STATELESS:-0}" = "1" \] && \[ "\${PREBUILD_STATELESS_DISABLED:-0}" != "1" \]; then$' "$YML")"
check "#3 the pre-build skips host 1 (the stateful box deploys first, untouched)" "1" "$(grep -c '^              N=\$((N + 1)); \[ "\$N" -gt 1 \] || continue$' "$YML")"
check "#3 the pre-build runs in the background (per-host pid)" "1" "$(grep -c '^              PREBUILD_PID\[\$EC2_HOST\]=\$!$' "$YML")"
check "#3 the remote pre-build is timeout-wrapped (orphan-safe, like the deploy)" "1" "$(grep -c 'timeout --signal=TERM --kill-after=30 1800 bash scripts/deploy/prebuild-inactive.sh' "$YML")"
WAIT_LINE=$(grep -n 'waiting for the background pre-build on \$EC2_HOST' "$YML" | head -1 | cut -d: -f1)
DEPLOY_BANNER=$(grep -n '=================== BLUE-GREEN DEPLOY -> \$EC2_HOST' "$YML" | head -1 | cut -d: -f1)
LOOP_LINE=$(grep -n '^          for EC2_HOST in \$HOSTS; do$' "$YML" | awk -F: -v w="${WAIT_LINE:-0}" '$1 < w { l = $1 } END { print l }')
if [ -n "$WAIT_LINE" ] && [ -n "$DEPLOY_BANNER" ] && [ -n "$LOOP_LINE" ] && [ "$LOOP_LINE" -lt "$WAIT_LINE" ] && [ "$WAIT_LINE" -lt "$DEPLOY_BANNER" ]; then
  ok "#3 each host's deploy WAITS for its own pre-build first (loop $LOOP_LINE < wait $WAIT_LINE < deploy $DEPLOY_BANNER)"
else
  bad "#3 the wait must sit inside the host loop before the deploy banner (loop ${LOOP_LINE:-?}, wait ${WAIT_LINE:-?}, banner ${DEPLOY_BANNER:-?})"
fi
check "#3 a failed pre-build only warns (the host's deploy builds normally)" "1" "$(grep -c '::warning::pre-build failed on \$EC2_HOST' "$YML")"
check "#3/#8 the remote blue-green timeout wrap is intact (deploy-wedge-bounds pin; 3300 since T2d — the did-it-work window rides inside it)" "1" "$(grep -c 'timeout --signal=TERM --kill-after=30 3300 bash deploy-blue-green.sh' "$YML")"
check "#3 the parity gate is unchanged" "1" "$(grep -c 'Cross-box asset manifests DIVERGE' "$YML")"
EXPORT_LINE=$(grep 'export BUILDER_CACHE_KEEP=%q' "$YML" | head -1)
for v in BUILDER_CACHE_KEEP BUILDER_PRUNE_ONCE_DISABLED DRAIN_SECONDS WORKER_IMAGE_SHARED_DISABLED BACKEND_CHOWN_RECURSIVE FRONTEND_CONTENT_BUST; do
  check "runner env: deploy.yml forwards $v to the box" "1" "$(printf '%s\n' "$EXPORT_LINE" | grep -c " $v=%q\|^.*export $v=%q")"
  check "runner env: deploy.yml reads $v from repo Variables" "1" "$(grep -c "^          $v: \${{ vars.$v }}$" "$YML")"
done
# functional: prebuild-inactive.sh under PATH shims (sudo / pgrep / df)
SBX="$TMP/sbx"; mkdir -p "$SBX/bin" "$SBX/box/frontend/sub" "$SBX/box/scripts/deploy"
cp "$KEY" "$SBX/box/scripts/deploy/frontend-bust-key.sh"
printf 'services: {}\n' > "$SBX/box/docker-compose.app.yml"
printf 'blue\n' > "$SBX/box/.active-color"
printf 'abc123def\n' > "$SBX/box/.deploy-sha"
printf 'page\n' > "$SBX/box/frontend/sub/page.tsx"
SHIM_LOG="$SBX/calls.log"
cat > "$SBX/bin/sudo" <<'SHIM'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$SHIM_LOG"
exit 0
SHIM
cat > "$SBX/bin/pgrep" <<'SHIM'
#!/usr/bin/env bash
exit "${SHIM_PGREP_RC:-1}"
SHIM
cat > "$SBX/bin/df" <<'SHIM'
#!/usr/bin/env bash
printf 'Use%%\n%s%%\n' "${SHIM_DF_PCT:-42}"
SHIM
chmod +x "$SBX/bin/"*
run_pre() { : > "$SHIM_LOG"; ( cd "$SBX" && PATH="$SBX/bin:$PATH" SHIM_LOG="$SHIM_LOG" COMPOSE_DIR="$SBX/box" "$@" bash "$PRE" ) >"$SBX/out.log" 2>&1; echo $?; }
check "#3 prebuild: default run exits 0" "0" "$(run_pre env)"
check "#3 prebuild: builds the INACTIVE colour (active blue → crossmodel_green) with 'backend frontend'" "1" "$(grep -c "docker compose -p crossmodel_green -f $SBX/box/docker-compose.app.yml build backend frontend$" "$SHIM_LOG")"
check "#3 prebuild: passes the deploy's exact env (BG_COLOR=green, green ports, DEPLOY_SHA=commit, BACKEND_CHOWN_RECURSIVE=0)" "1" "$(grep -c '^BG_COLOR=green BG_PORT_BACKEND=4002 BG_PORT_FRONTEND=8249 BG_PORT_RELAY=4302 DEPLOY_SHA=abc123def BACKEND_CHOWN_RECURSIVE=0 docker compose' "$SHIM_LOG")"
check "#3 prebuild: never runs 'up' / 'down' / nginx / migrate (compose build ONLY)" "0" "$(grep -c -E ' up | down |nginx|migrate|prune' "$SHIM_LOG")"
check "#3 prebuild: exactly one docker invocation" "1" "$(grep -c . "$SHIM_LOG")"
printf 'green\n' > "$SBX/box/.active-color"
run_pre env >/dev/null
check "#3 prebuild: active green → builds crossmodel_blue on the blue ports" "1" "$(grep -c '^BG_COLOR=blue BG_PORT_BACKEND=4001 BG_PORT_FRONTEND=8248 BG_PORT_RELAY=4301 .*docker compose -p crossmodel_blue ' "$SHIM_LOG")"
printf 'blue\n' > "$SBX/box/.active-color"
check "#3 prebuild: WORKER_IMAGE_SHARED_DISABLED=1 → full-service build (mirrors the deploy)" "0/1" "$(run_pre env WORKER_IMAGE_SHARED_DISABLED=1)/$(grep -c "docker-compose.app.yml build$" "$SHIM_LOG")"
check "#3 prebuild: FRONTEND_CONTENT_BUST=1 → the build arg is the content key (identical to the deploy's)" "1" "$(run_pre env FRONTEND_CONTENT_BUST=1 >/dev/null; grep -c "DEPLOY_SHA=$(bash "$KEY" "$SBX/box/frontend") BACKEND_CHOWN_RECURSIVE=0 docker compose" "$SHIM_LOG")"
check "#3 prebuild: BACKEND_CHOWN_RECURSIVE=1 is forwarded" "1" "$(run_pre env BACKEND_CHOWN_RECURSIVE=1 >/dev/null; grep -c 'BACKEND_CHOWN_RECURSIVE=1 docker compose' "$SHIM_LOG")"
check "#3 prebuild: PREBUILD_STATELESS_DISABLED=1 → exit 0, no docker call" "0/0" "$(run_pre env PREBUILD_STATELESS_DISABLED=1)/$(grep -c . "$SHIM_LOG")"
check "#3 prebuild: a running deploy-blue-green.sh → exit 0, no docker call" "0/0" "$(run_pre env SHIM_PGREP_RC=0)/$(grep -c . "$SHIM_LOG")"
check "#3 prebuild: root disk ≥90% → exit 0, no docker call (the deploy's pre-flight owns it)" "0/0" "$(run_pre env SHIM_DF_PCT=91)/$(grep -c . "$SHIM_LOG")"
check "#3 prebuild: 89% disk still builds" "0/1" "$(run_pre env SHIM_DF_PCT=89)/$(grep -c . "$SHIM_LOG")"
rm -f "$SBX/box/.active-color"
check "#3 prebuild: no .active-color → detects from containers (shim sees none) → defaults blue, builds green, never re-seeds the file" "0/1/absent" "$(run_pre env)/$(grep -c 'docker compose -p crossmodel_green ' "$SHIM_LOG")/$([ -f "$SBX/box/.active-color" ] && echo present || echo absent)"
rm -f "$SBX/box/docker-compose.app.yml"
check "#3 prebuild: no compose file → exit 0, no docker call" "0/0" "$(run_pre env)/$(grep -c . "$SHIM_LOG")"

# ── 9. T3g image-build lock (batch-train 2026-10-17) ─────────────────────────
# The race this pins: prebuild-inactive.sh's deploy guard was START-TIME only
# (pgrep), and deploy-blue-green.sh had NO mutual exclusion at all — an
# orphaned pre-build (a cancelled wave drops the ssh transport; the remote
# timeout-wrapped build keeps running) or a second pre-build overlapped
# `compose build`s on the box's one BuildKit builder. Both scripts must take
# the SAME /var/tmp lock (outside the rsync root — a lock inside
# /opt/crossmodel would be deleted mid-hold by `rsync --delete`).
LOCK_PATH_PIN='^IMAGE_BUILD_LOCK="\${IMAGE_BUILD_LOCK:-/var/tmp/.digby-image-build.lock}"$'
check "#T3g prebuild: lock file default lives in /var/tmp (outside the rsync root)" "1" "$(grep -c "$LOCK_PATH_PIN" "$PRE")"
check "#T3g prebuild: takes the lock NON-blocking (a busy builder means skip)" "1" "$(grep -c '^if ! flock -n 9; then$' "$PRE")"
check "#T3g prebuild: a busy lock logs + exits 0 (non-fatal for the wave)" "1" "$(grep -c 'another image build holds \$IMAGE_BUILD_LOCK — skipping' "$PRE")"
check "#T3g deploy: takes the SAME lock (default path identical)" "1" "$(grep -c "$LOCK_PATH_PIN" "$DEPLOY")"
check "#T3g deploy: BOUNDED wait (the deploy's own build can never skip)" "1" "$(grep -c 'flock -w "\${IMAGE_BUILD_LOCK_WAIT_SECONDS:-600}" 9' "$DEPLOY")"
check "#T3g deploy: a stuck holder WARNS and builds anyway (never wedges the deploy)" "1" "$(grep -c 'building anyway (an orphaned pre-build must never wedge the deploy)' "$DEPLOY")"
check "#T3g deploy: IMAGE_BUILD_LOCK_DISABLED=1 kill switch exists (exactly one gate)" "1" "$(grep -c '^if \[ "\${IMAGE_BUILD_LOCK_DISABLED:-0}" != "1" \]; then$' "$DEPLOY")"
check "#T3g deploy: the lock sits AFTER the WORKER_IMAGE_SHARED gate and BEFORE the build" "1" "$(python3 - "$DEPLOY" <<'PY'
import sys
lines = open(sys.argv[1]).read().splitlines()
gate = lock = build = None
for i, l in enumerate(lines, 1):
    if gate is None and 'WORKER_IMAGE_SHARED_DISABLED=1 — building every service' in l: gate = i
    if lock is None and l.startswith('IMAGE_BUILD_LOCK="${IMAGE_BUILD_LOCK:-'): lock = i
    if build is None and 'build $BUILD_SERVICES' in l: build = i
print(1 if gate and lock and build and gate < lock < build else 0)
PY
)"
# race case 1: the lock is HELD → the pre-build must skip (no docker call).
# Restore the sandbox the #3 cases above tore down (compose + colour) so this
# genuinely exercises the lock, not the missing-compose early exit.
printf 'services: {}\n' > "$SBX/box/docker-compose.app.yml"
printf 'blue\n' > "$SBX/box/.active-color"
SBX_LOCK="$SBX/box-held.lock"
flock "$SBX_LOCK" -c 'sleep 3' & HELD_PID=$!
sleep 0.3
check "#T3g prebuild: a HELD lock → exit 0, no docker call (the holder's build is authoritative)" "0/0" "$(run_pre env IMAGE_BUILD_LOCK="$SBX_LOCK")/$(grep -c . "$SHIM_LOG")"
wait "$HELD_PID" 2>/dev/null
# race case 2: lock free again → the pre-build runs (the skip is not sticky)
check "#T3g prebuild: lock free again → builds normally (skip is not sticky)" "1" "$(run_pre env IMAGE_BUILD_LOCK="$SBX_LOCK" >/dev/null; grep -c "docker compose -p crossmodel_green" "$SHIM_LOG")"
# race case 3: the deploy's bounded wait fires → warn + build anyway (shimmed flock)
DEPLOY_FLOCK_DIR="$TMP/deploy-flock"; mkdir -p "$DEPLOY_FLOCK_DIR"
cat > "$DEPLOY_FLOCK_DIR/flock" <<'SHIM'
#!/usr/bin/env bash
# Emulates a stuck holder for -w (bounded-wait) calls: -n (non-blocking) on a
# free lock still succeeds; -w times out and fails, like a held lock would.
for a in "$@"; do case "$a" in -w*) exit 1;; esac; done
exit 0
SHIM
chmod +x "$DEPLOY_FLOCK_DIR/flock"
# Extract the deploy's lock block (comments stripped) into a runnable probe.
awk '/^# ── Image-build lock \(batch-train T3g/,/^# shellcheck disable=SC2086/' "$DEPLOY" | grep -v '^#' | sed '/^$/d' > "$DEPLOY_FLOCK_DIR/lock-block.sh"
printf 'log() { echo "[t] $*"; }\nBUILD_SERVICES="backend frontend"\n' > "$DEPLOY_FLOCK_DIR/probe.sh"
cat "$DEPLOY_FLOCK_DIR/lock-block.sh" >> "$DEPLOY_FLOCK_DIR/probe.sh"
printf '\nlog "BUILD-RAN services=$BUILD_SERVICES"\n' >> "$DEPLOY_FLOCK_DIR/probe.sh"
PROBE_OUT="$(cd "$DEPLOY_FLOCK_DIR" && PATH="$DEPLOY_FLOCK_DIR:$PATH" IMAGE_BUILD_LOCK="$DEPLOY_FLOCK_DIR/lock.file" bash probe.sh 2>&1; echo "rc=$?")"
check "#T3g deploy probe: the extracted lock block parses (bash -n)" "0" "$(bash -n "$DEPLOY_FLOCK_DIR/probe.sh" 2>/dev/null; echo $?)"
check "#T3g deploy probe: stuck holder → warns AND builds anyway" "1/1" "$(printf '%s\n' "$PROBE_OUT" | grep -c 'building anyway (an orphaned pre-build must never wedge the deploy)')/$(printf '%s\n' "$PROBE_OUT" | grep -c 'BUILD-RAN')"
check "#T3g deploy probe: the stuck-holder path exits 0 (set -euo pipefail safe)" "0" "$(printf '%s\n' "$PROBE_OUT" | grep -oE 'rc=[0-9]+' | tail -1 | cut -d= -f2)"
# kill switch: with IMAGE_BUILD_LOCK_DISABLED=1 the probe never touches flock
PROBE_KS="$(cd "$DEPLOY_FLOCK_DIR" && PATH="$DEPLOY_FLOCK_DIR:$PATH" IMAGE_BUILD_LOCK_DISABLED=1 IMAGE_BUILD_LOCK="$DEPLOY_FLOCK_DIR/lock.file" bash probe.sh 2>&1; echo "rc=$?")"
check "#T3g deploy probe: kill switch → no lock taken, build still runs (rc 0)" "1/0" "$(printf '%s\n' "$PROBE_KS" | grep -c 'BUILD-RAN')/$(printf '%s\n' "$PROBE_KS" | grep -c 'cannot open\|building anyway')"

if [ "$failures" -eq 0 ]; then
  echo "blue-green speedups invariants OK"
else
  echo "$failures invariant(s) violated" >&2
  exit 1
fi
