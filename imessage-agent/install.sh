#!/usr/bin/env bash
#
# Digby iMessage agent installer (macOS).
#
# Builds the agent, pairs it with your Digby account, and installs it as a
# launchd LaunchAgent so it runs 24/7 (at login, restarted if it crashes).
#
# Usage:  ./install.sh
#
set -euo pipefail

AGENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="com.digby.agent"
PLIST_DEST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$HOME/Library/Logs/digby-agent"

echo "▶ Digby iMessage agent installer"
echo "  Agent dir: $AGENT_DIR"

# ── Preconditions ──────────────────────────────────────────────────────────────
if [[ "$(uname)" != "Darwin" ]]; then
  echo "✗ This agent only runs on macOS." >&2
  exit 1
fi
# Make Homebrew-installed node visible even in a minimal non-login shell.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js 20+ is required. Install it (e.g. 'brew install node') and re-run." >&2
  exit 1
fi
NODE_BIN="$(command -v node)"
echo "  Node: $NODE_BIN ($(node -v))"
# Node major preflight (ticket a9a74086): better-sqlite3 12.x (the agent's
# database engine) supports Node 20–26 (prebuilt binaries for 22/24/25/26;
# EOL 20/23 compile from source); an older major cannot install it at
# all. Fail fast with the fix instead of a node-gyp wall further down.
NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
if [[ ! "$NODE_MAJOR" =~ ^[0-9]+$ ]] || [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "✗ Node.js 20 or newer is required (found $(node -v))." >&2
  echo "  Fix: brew upgrade node   (or install the LTS from https://nodejs.org)," >&2
  echo "  then re-run this installer." >&2
  exit 1
fi

# ── Build ───────────────────────────────────────────────────────────────────────
echo "▶ Installing dependencies + building…"
cd "$AGENT_DIR"
# a9a74086: a native-module install failure must explain itself — the raw
# node-gyp wall ("No prebuilt binaries found … CXX better_sqlite3.o") reads
# like a Digby bug and hands the user nothing to do.
if ! npm install; then
  echo "" >&2
  echo "✗ Installing dependencies failed (the npm error is above)." >&2
  echo "  Common causes on a Mac:" >&2
  echo "   • Missing Xcode Command Line Tools (needed to compile native modules):" >&2
  echo "       xcode-select --install    then re-run this installer" >&2
  echo "   • A Node.js the agent's database engine (better-sqlite3) cannot build" >&2
  echo "     under — you need Node 20–26 (found $(node -v)):" >&2
  echo "       brew upgrade node         then re-run this installer" >&2
  exit 1
fi
npm run build

# ── Native module rebuild fallback (ticket 8bcd1c4a) ──────────────────────────
# `npm install` prints "up to date" and rebuilds NOTHING when node_modules
# already satisfies the lockfile — so a stale or never-built native addon
# survives it. Two live classes hit this (the ticket's Mac: node v26 + npm 12):
#   1. npm >= 12 BLOCKS dependency install scripts unless the project's
#      package.json carries allowScripts — through 0.8.2 the tarball had
#      none, so a FRESH install never ran better-sqlite3's node-gyp build at
#      all (npm warns "install scripts not yet covered by allowScripts"): the
#      .node is MISSING, or present only from an older install.
#   2. A Node.js upgrade changes the V8 ABI; the previously built .node is
#      then unloadable, and npm has no reason to rebuild it ("up to date").
# Fix: load the built addon in a FRESH child process under THIS node — exactly
# the selftest's native probe — and when that FAILS (missing OR unloadable),
# rebuild the native dependency (npm rebuild re-runs the install script;
# allowScripts in package.json covers it on npm >= 12).
# On a rebuild that STILL does not load we do NOT exit: the sibling-tree
# carry below (0e4c9601) may yet replace the module with a Team-signed one,
# and the selftest at the end is the final gate — it fails loudly if neither
# the rebuild nor the carry produced a loadable module (reviewer F1: exiting
# here preempted the carry and regressed the DigbyHelper fleet install path).
SQLITE_REL="node_modules/better-sqlite3/build/Release/better_sqlite3.node"
NEW_SQLITE_VER="$(node -p "require('./node_modules/better-sqlite3/package.json').version" 2>/dev/null || true)"
sqlite_loads() { node -e "require(process.argv[1])" "$AGENT_DIR/$SQLITE_REL" >/dev/null 2>&1; }
if [[ -n "$NEW_SQLITE_VER" ]] && ! sqlite_loads; then
  echo "▶ better_sqlite3.node is missing or does not load under $NODE_BIN — rebuilding it…"
  if ! npm rebuild better-sqlite3; then
    echo "  ⚠ npm rebuild failed (Xcode Command Line Tools missing/stale? xcode-select --install)" >&2
  fi
  if ! sqlite_loads; then
    echo "" >&2
    echo "⚠ better_sqlite3.node still does not load under $NODE_BIN after a rebuild." >&2
    echo "  The fresh-child error (pass this to support if it persists):" >&2
    node -e "require(process.argv[1])" "$AGENT_DIR/$SQLITE_REL" 2>&1 | sed 's/^/  /' >&2 || true
    echo "" >&2
    echo "  Common causes:" >&2
    echo "    - Xcode Command Line Tools missing/stale: xcode-select --install" >&2
    echo "    - better-sqlite3 ${NEW_SQLITE_VER} does not build under $(node -v) — install an LTS Node (https://nodejs.org) and re-run install.sh" >&2
    echo "    - Under a hardened-runtime interpreter (DigbyHelper) macOS refuses an" >&2
    echo "      adhoc-signed addon — the sibling-tree carry below may still fix this," >&2
    echo "      and the selftest at the end fails loudly if it cannot." >&2
  else
    echo "  ✓ rebuilt better_sqlite3.node loads under $NODE_BIN"
  fi
fi

# ── Native module carry + smoke (ticket 0e4c9601) ──────────────────────────────
# npm install builds better_sqlite3 ADHOC/linker-signed. A Team-signed
# HARDENED-runtime interpreter (DigbyHelper) refuses adhoc libraries at dlopen
# ("mapping process and mapped file (non-platform) have different Team IDs") —
# but only at first launchd start, so a plain build looks fine and the agent
# then runs with iMessage reads dead. If an OLDER agent tree sits beside this
# one with the SAME better-sqlite3 version, its .node is proven loadable under
# this interpreter — carry it over the fresh adhoc build (the manual mbp-5 fix,
# automated). A better-sqlite3 VERSION change needs a signed module shipped with
# the tarball (see scripts/publish-agent-tarball.sh).
if [[ -n "$NEW_SQLITE_VER" && -f "$SQLITE_REL" ]]; then
  for OLD_SQLITE in "$(dirname "$AGENT_DIR")"/agent-*/node_modules/better-sqlite3; do
    [[ -f "$OLD_SQLITE/build/Release/better_sqlite3.node" ]] || continue
    OLD_AGENT_DIR="$(dirname "$(dirname "$OLD_SQLITE")")"   # …/agent-0.7.3
    [[ "$OLD_AGENT_DIR" == "$AGENT_DIR" ]] && continue       # skip THIS tree
    # Paths cross into node via $ENV (never string interpolation — a quote in
    # the tree path would break the JS literal; reviewer note 8, 0e4c9601).
    OLD_VER="$(OLD_SQLITE="$OLD_SQLITE" node -p "require(process.env.OLD_SQLITE + '/package.json').version" 2>/dev/null || true)"
    if [[ "$OLD_VER" == "$NEW_SQLITE_VER" ]] \
       && OLD_SQLITE="$OLD_SQLITE" node -e "require(process.env.OLD_SQLITE + '/build/Release/better_sqlite3.node')" 2>/dev/null; then
      cp "$OLD_SQLITE/build/Release/better_sqlite3.node" "$SQLITE_REL.carry"
      mv "$SQLITE_REL.carry" "$SQLITE_REL"
      echo "  ✓ carried signed better_sqlite3.node $OLD_VER from $(basename "$OLD_AGENT_DIR")"
      break
    fi
  done
fi
# Smoke the built tree BEFORE installing it: imports every runtime module and
# loads each native addon in a FRESH child process (no cached vnode signature —
# this is the check that was blind to the adhoc module on the 0.8.0 bootstrap).
if ! node "$AGENT_DIR/dist/index.js" selftest; then
  echo "" >&2
  echo "✗ SELFTEST FAILED — the built tree cannot load its native modules under" >&2
  echo "  $NODE_BIN (the child-process error is printed above)." >&2
  echo "  If the error is a signature/Team-ID refusal under a hardened-runtime" >&2
  echo "  interpreter (DigbyHelper), the locally built better_sqlite3.node is" >&2
  echo "  adhoc-signed (ticket 0e4c9601). Fix: copy a Team-signed" >&2
  echo "  better_sqlite3.node (same version $NEW_SQLITE_VER) from a working agent" >&2
  echo "  tree into $AGENT_DIR/$SQLITE_REL," >&2
  echo "  or ship a signed module with the release tarball." >&2
  exit 1
fi

# ── Digby-named runtime (ticket 51d8dbe0) ─────────────────────────────────────
# The launchd service must run a binary NAMED "DigbyAgent", not the shared
# Homebrew 'node': that is the file the user drags into Full Disk Access, and
# TCC lists the executable's NAME — a grant to 'node' reads like a system
# component AND hands every other node process on the Mac FDA (the ticket's
# screenshot shows the Finder reveal of a file literally called 'node').
# Same rename the .app bundle ships (macos-app/build-app.sh: cp bin/node
# DigbyHelper — "reads far better than 'node'").
# The copy lives OUTSIDE the agent tree, at a STABLE path: the agent's
# self-update swaps the whole tree (mv agentRoot → .bak), so a binary inside
# it would vanish under the running plist. A <tree>-sibling 'bin/' dir is
# tarball-colliding (each download stages agent-<n>/); the Application
# Support root is stable across swaps.
# Copied BEFORE pairing so the pair-time TCC snapshot is taken under the
# binary that will actually run as the service (under plain node it would
# report the INSTALLER's node grant, not the service's).
DIGBY_RUNTIME_DIR="$HOME/Library/Application Support/Digby/bin"
DIGBY_AGENT_BIN="$DIGBY_RUNTIME_DIR/DigbyAgent"
mkdir -p "$DIGBY_RUNTIME_DIR"
# cp -f (not cp): a previous install's DigbyAgent may be RUNNING under
# launchd — cp -f removes the destination and recreates it (a new inode) so
# the overwrite never hits a busy text file.
# 933e6ca4: BUT a new inode is a NEW app to macOS TCC — recreating the binary
# on every installer run re-orphans the Screen Recording / Accessibility /
# Full Disk Access grants (the ticket's black-capture mishap). When the
# bytes are already identical, keep the existing file (and its grants):
# cmp -s is byte-identical ⇒ skip the copy; only a REAL runtime change pays
# the re-grant cost, and the agent says so (the permission hint explains it).
# 21c68e74 (2026-10-23): Homebrew's node is a KEG-COUPLED build — its Mach-O
# load commands are LC_LOAD_DYLIB @rpath/libnode.NN.dylib (resolved through
# @loader_path/../lib → this bin/'s sibling lib/, which nothing populates)
# plus ~100 /opt/homebrew/opt/… keg dylibs, so a verbatim copy only runs
# while the exact keg it was poured from still exists. `brew upgrade node`
# (bumps the libnode SONAME) or `brew cleanup` strands the launchd service
# with the ticket's "dyld: Library not loaded: @rpath/libnode.147.dylib"
# crash-loop and the Mac silently reads offline. The official nodejs.org
# binary links system dylibs only. For a coupled interpreter, install the
# OFFICIAL build of the SAME version (sha256-verified against nodejs.org's
# own SHASUMS256.txt) instead.
RUNTIME_SRC="$NODE_BIN"
COUPLED_DEPS=""
if command -v otool >/dev/null 2>&1; then
  # SIGPIPE-safe (review F2): otool -L | grep -q lets otool die on SIGPIPE
  # once grep matches, and under `set -o pipefail` that 141 turns the
  # DETECTION off — silently shipping the coupled binary. Capture the whole
  # listing FIRST (no early-exit consumer), then match on the captured text.
  COUPLED_DEPS="$(otool -L "$NODE_BIN" 2>/dev/null || true)"
else
  echo "  ⚠️  otool not found (Command Line Tools not installed) — cannot check"
  echo "     whether this Node is a Homebrew keg-coupled build; installing it as-is."
fi
if [[ -n "$COUPLED_DEPS" ]] && grep -qE '(^|[[:space:]])(/opt/homebrew/|/usr/local/opt/|/usr/local/Cellar/|@@HOMEBREW_PREFIX@@/|@rpath/libnode)' <<<"$COUPLED_DEPS"; then
  NODE_VERSION_FULL="$("$NODE_BIN" -p 'process.version' 2>/dev/null | tr -d 'v')"
  ARCH="$(uname -m)"; [[ "$ARCH" == "x86_64" ]] && ARCH="x64"
  TARBALL="node-v${NODE_VERSION_FULL}-darwin-${ARCH}.tar.gz"
  echo "  ⚠️  this Node ($NODE_BIN) is a Homebrew keg-coupled build (linked against"
  echo "     @rpath/libnode / Homebrew-prefix dylibs — a brew upgrade or cleanup breaks"
  echo "     it; that is the 2026-10-23 crash-loop). Fetching the official self-contained"
  echo "     build of the same version (v${NODE_VERSION_FULL}) from nodejs.org…"
  RUNTIME_TMP="$(mktemp -d "${TMPDIR:-/tmp}/digby-runtime.XXXXXX")"
  # (set -e safe: a failed fetch/parse reads as an empty sha → the guarded
  # && chain below takes the fallback, it never aborts the installer)
  WANT_SHA="$( (curl -fsSL --max-time 60 "https://nodejs.org/dist/v${NODE_VERSION_FULL}/SHASUMS256.txt" 2>/dev/null || true) | awk -v t="$TARBALL" '$2 == t {print $1}')"
  if [[ -n "$WANT_SHA" ]] \
     && curl -fsSL --max-time 600 "https://nodejs.org/dist/v${NODE_VERSION_FULL}/${TARBALL}" -o "$RUNTIME_TMP/$TARBALL" \
     && [[ "$(shasum -a 256 "$RUNTIME_TMP/$TARBALL" | awk '{print $1}')" == "$WANT_SHA" ]] \
     && tar -xzf "$RUNTIME_TMP/$TARBALL" -C "$RUNTIME_TMP" \
     && [[ -x "$RUNTIME_TMP/node-v${NODE_VERSION_FULL}-darwin-${ARCH}/bin/node" ]]; then
    RUNTIME_SRC="$RUNTIME_TMP/node-v${NODE_VERSION_FULL}-darwin-${ARCH}/bin/node"
    echo "  ✓ official self-contained Node v${NODE_VERSION_FULL} (sha256-verified) — the"
    echo "     DigbyAgent runtime no longer depends on the Homebrew keg."
  else
    echo "  ⚠️  could not fetch/verify the official build — installing the local coupled"
    echo "     binary for now; the agent (v0.9.5+) self-heals the runtime on its first"
    echo "     poll (src/runtime-dylib.ts, ticket 21c68e74)."
    RUNTIME_SRC="$NODE_BIN"
  fi
fi
if [[ ! -f "$DIGBY_AGENT_BIN" ]] || ! cmp -s "$RUNTIME_SRC" "$DIGBY_AGENT_BIN"; then
  cp -f "$RUNTIME_SRC" "$DIGBY_AGENT_BIN"
  echo "  ⚠️  the DigbyAgent binary changed — macOS may need its permissions re-granted"
  echo "     (Screen Recording / Accessibility / Full Disk Access attach to the exact file;"
  echo "      System Settings → Privacy & Security will show what needs re-adding)."
else
  echo "  ✓ DigbyAgent binary unchanged — existing macOS permissions stay valid"
fi
chmod 755 "$DIGBY_AGENT_BIN"
[[ -n "${RUNTIME_TMP:-}" ]] && rm -rf "$RUNTIME_TMP"
# Remember WHERE the interpreter came from, BESIDE the copy (stable — outside
# every agent tree, so the agent's self-update swap never moves it). The
# runtime's own directory holds no npm-cli.js, and the ORIGINAL node's dir
# (Homebrew/nvm — even when the runtime binary itself is the official
# self-contained build, 21c68e74: that dir is where npm lives) must head the
# PATH during a self-update build (an nvm-installed node is otherwise
# invisible in a launchd context) — self-update reads this marker for both.
printf '%s\n' "$NODE_BIN" > "$DIGBY_RUNTIME_DIR/.node-origin"
echo "  ✓ Digby runtime: $DIGBY_AGENT_BIN ($([[ "$RUNTIME_SRC" == "$NODE_BIN" ]] && echo "from $NODE_BIN" || echo "official self-contained build v${NODE_VERSION_FULL} — origin npm: $NODE_BIN"))"

# ── digby-agent CLI shim (ticket 69ce3f01) ────────────────────────────────────
# docs/UNATTENDED_DEVICES.md documents the CLI as `digby-agent <subcommand>`,
# and the OWNER hit `sudo: digby-agent: command not found` from exactly that
# line. package.json's "bin" entry only reaches PATH through a global install
# or `npm link` — this installer does neither, and it must not (a global
# install would collide with every other Digby install shape on the Mac). So
# write a shim beside the DigbyAgent runtime, whose directory is already
# STABLE across self-updates (the tree swaps; this dir does not).
#
# ABSOLUTE paths are baked in, never $HOME: the runbook runs the
# `remote-access` subcommands under `sudo`, where $HOME is ROOT's home and a
# relative lookup finds no agent at all — the shim would "exist" and still
# fail. Under sudo the shell expands $HOME *before* sudo runs, so the
# documented `sudo "$HOME/Library/…/digby-agent"` form works while the
# user-level one keeps working after the PATH line.
#
# install.sh runs as the normal user, so NO /usr/local/bin copy: that needs
# sudo, and a root-owned shim pointing at the /Library/Digby .pkg payload
# would outlive this install and shadow it (the stale-version class of
# 405927c9). One canonical shim path for every install shape self-heals —
# whichever installer ran last rewrites it to the tree that is actually live.
#
# The two paths are emitted SINGLE-QUOTED (review N1): the heredoc below is
# unquoted, so a bare "$AGENT_DIR/…" interpolates and a path containing a
# `"` `` ` `` or `$` (a home like /Users/we"ird) would write a shim that is
# broken from the moment it lands — and, like this ticket, only fails when
# the owner first runs it.
digby_sq() {
  # Quote for /bin/sh. The only byte a single-quoted string cannot hold is a
  # single quote: close, emit an escaped quote, reopen.
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}
DIGBY_CLI_SHIM="$DIGBY_RUNTIME_DIR/digby-agent"
cat > "$DIGBY_CLI_SHIM" <<DIGBY_CLI
#!/bin/sh
# digby-agent — generated by the Digby agent installer (ticket 69ce3f01).
# Absolute paths on purpose: under sudo \$HOME is root's home, and sudo does
# not inherit your shell's PATH. Re-run the Digby installer to regenerate.
exec $(digby_sq "$DIGBY_AGENT_BIN") $(digby_sq "$AGENT_DIR/dist/index.js") "\$@"
DIGBY_CLI
chmod 755 "$DIGBY_CLI_SHIM"
echo "  ✓ digby-agent command: $DIGBY_CLI_SHIM"

# ── Pair (if not already paired) ─────────────────────────────────────────────────
if [[ ! -f "$HOME/.config/digby-agent/config.json" ]]; then
  echo "▶ Pairing — open Digby → Account → Integrations → iMessage → Connect your Mac,"
  echo "  then enter the pairing code below."
  "$DIGBY_AGENT_BIN" "$AGENT_DIR/dist/index.js" pair
else
  echo "▶ Already paired (re-run 'node dist/index.js pair' to re-pair)."
fi

# ── Install launchd service ───────────────────────────────────────────────────────
echo "▶ Installing launchd service ($LABEL)…"
mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"
# 4e75cdea: the marker says THIS tree is self-managed — the agent's self-update
# (0.8.0+) will only ever swap an install that carries it (or lives at the
# canonical tarball path). The .app-bundled and /Library/Digby installs never
# carry it, so they keep their own update paths.
touch "$AGENT_DIR/.digby-selfupdate"
sed -e "s|__NODE__|$DIGBY_AGENT_BIN|g" \
    -e "s|__AGENT_DIR__|$AGENT_DIR|g" \
    -e "s|__LOG_DIR__|$LOG_DIR|g" \
    "$AGENT_DIR/launchd/com.digby.agent.plist.template" > "$PLIST_DEST"

# 31fd8440 + 933e6ca4 + 405927c9: the OTHER Digby agents must not keep
# running — or come BACK — beside this self-managed install. The desktop
# app's one-click "Set up iMessage on this Mac" and the signed .pkg both
# install the launchd label ai.digby.imessage-agent; all three shapes share
# ~/.config/digby-agent (same token, same agent row), and neither of the
# other two EVER self-updates, so a stale one flaps this Mac's stored
# agentVersion between its version and ours — the web card then re-shows
# "Agent update available" after every login (ticket 933e6ca4's framing;
# 405927c9 is the same report with a .pkg install in the mix: its served
# .pkg froze agent 0.1.0 in June 2026). 31fd8440 booted the job out but LEFT
# the plist: launchd loads every plist in ~/Library/LaunchAgents at login, so
# the bundled helper resurrected at every reboot.
#
# WHAT MAY BE RETIRED — every install that can never self-update, by
# CONTENT, not by label (reviewer blocker 3 kept: read ProgramArguments[0],
# never delete by label alone). Read the plist's first ProgramArguments entry:
#   contains ".app/Contents/Resources/" → the desktop app's bundled helper
#     (frozen at the app's build) → boot out + REMOVE the plist (before our
#     own service loads, so the two never poll side by side).
#   starts with "/Library/Digby/" → the signed .pkg install (root-owned
#     payload, no bundled npm, no self-update path; BOTH postinstall
#     generations match by PREFIX — June 2026 wrote …/node, the current one
#     …/DigbyAgent) → boot out + REMOVE the plist. The /Library/Digby
#     payload itself stays (removing it needs sudo; the uninstall line
#     below says how) — with its LaunchAgent gone it never runs or polls
#     again, which is what ends the version flap.
#   anything else (unparseable, a path this installer cannot attribute)
#     → leave it COMPLETELY alone and say so — the agent-side retire
#     (src/retire-bundled-helper.ts) enforces the same policy, with the
#     same identity guards (a bundled helper / .pkg agent never retires).
APP_PLIST="$HOME/Library/LaunchAgents/ai.digby.imessage-agent.plist"
if [[ -f "$APP_PLIST" ]]; then
  APP_PROG="$(sed -n '/<key>ProgramArguments<\/key>/,/<\/array>/p' "$APP_PLIST" | grep -o '<string>[^<]*</string>' | head -1 | sed 's/<[^>]*>//g')"
  if [[ "$APP_PROG" == *".app/Contents/Resources/"* || "$APP_PROG" == "/Library/Digby/"* ]]; then
    launchctl bootout "gui/$(id -u)" "$APP_PLIST" >/dev/null 2>&1 || launchctl unload "$APP_PLIST" >/dev/null 2>&1 || true
    rm -f "$APP_PLIST"
    echo "  ✓ stopped an old Digby install (this install replaces it)"
    echo "    (its launchd plist is removed so it cannot come back at the next login;"
    if [[ "$APP_PROG" == "/Library/Digby/"* ]]; then
      echo "     the old installer's files at /Library/Digby are now inert — remove"
      echo "     them any time with:  sudo rm -rf /Library/Digby)"
    else
      echo "     any stale entries it holds in the permission panes can be deleted)"
    fi
  else
    echo "  ℹ️  found another Digby agent install ($APP_PROG) — left running."
    echo "     (Only the app-bundled helper and the old .pkg install are retired by this installer.)"
  fi
fi

launchctl unload "$PLIST_DEST" >/dev/null 2>&1 || true
STAMP="$HOME/.config/digby-agent/running-agent.json"
# INVALIDATE the previous run's stamp BEFORE loading (post-merge review D-2
# of 5e8d73fc): a stamp outlives its writer, and on the wedged Mac the whole
# point is that `launchctl load` can no-op while an old process's stamp sits
# on disk. Executed proof: a pre-seeded stamp with THIS tree's version and a
# pid that no longer exists satisfied the check instantly — "VERIFIED_IN_0s",
# exit 0, nothing running — the exact silent-success class ticket c6e91d19
# exists to kill. The stamp is only ground truth while its writer lives, so
# drop it here: only a process THIS load starts can pass the verification
# below (and the pid-liveness guard inside verify_running_agent catches a
# writer that dies mid-wait). Best-effort: an undeletable stamp must not
# block the install — the wait loop then times out loudly instead.
rm -f "$STAMP" >/dev/null 2>&1 || true
launchctl load "$PLIST_DEST"

# ── Verify the RUNNING agent (ticket c6e91d19) ────────────────────────────────
# "The command completed but the agent still shows 0.6.3" was this installer's
# silent failure mode: `launchctl load` returning 0 proves the plist was read,
# NOT that a process launched, and NOT that a stale DigbyHelper (the desktop
# app's bundled 0.6.3 helper, label ai.digby.imessage-agent) isn't still the
# only thing polling. The agent (≥ 0.9.3) stamps ~/.config/digby-agent/
# running-agent.json the moment its run loop starts — version, pid, entry.
# Wait for that stamp to name THIS tree's version; one kickstart retry; then
# FAIL LOUDLY with the exact next steps instead of printing success.
# Paths cross into node via $ENV, never string interpolation (the file's own
# convention above, line ~124) — a quote in the tree path (a home like
# /Users/O'Brien) breaks the JS literal and turns every install into a false
# "THE AGENT DID NOT COME UP" (post-merge review D-1 of 5e8d73fc).
AGENT_DIR_REAL="$(AGENT_DIR="$AGENT_DIR" node -e "console.log(require('fs').realpathSync(process.env.AGENT_DIR))" 2>/dev/null || printf '%s' "$AGENT_DIR")"
EXPECTED_VERSION="$(AGENT_DIR="$AGENT_DIR" node -p "require(process.env.AGENT_DIR + '/package.json').version" 2>/dev/null || true)"
verify_running_agent() {
  # 0 = the stamp names this tree's version, entry AND a LIVE pid; 1 = not
  # yet / mismatch / dead writer. The stamp is only ground truth while its
  # writer lives: a stamp naming a pid that no longer exists must read as
  # "not verified", not success (post-merge review D-2 of 5e8d73fc).
  [[ -n "$EXPECTED_VERSION" && -f "$STAMP" ]] || return 1
  local v e p
  v="$(STAMP="$STAMP" node -e "const s=JSON.parse(require('fs').readFileSync(process.env.STAMP,'utf8'));console.log(s.version||'')" 2>/dev/null || true)"
  e="$(STAMP="$STAMP" node -e "const s=JSON.parse(require('fs').readFileSync(process.env.STAMP,'utf8'));console.log(s.entry||'')" 2>/dev/null || true)"
  p="$(STAMP="$STAMP" node -e "const s=JSON.parse(require('fs').readFileSync(process.env.STAMP,'utf8'));console.log(Number.isFinite(s.pid)?String(s.pid):'')" 2>/dev/null || true)"
  [[ -n "$p" ]] && kill -0 "$p" 2>/dev/null || return 1
  # The agent writes the REALPATH of its entry (Node realpaths __dirname);
  # $AGENT_DIR can be a logical path when install.sh is invoked through a
  # symlink (D-3) — compare against the resolved tree, not the invocation path.
  [[ "$v" = "$EXPECTED_VERSION" && ( "$e" = "$AGENT_DIR/dist/index.js" || "$e" = "$AGENT_DIR_REAL/dist/index.js" ) ]]
}
echo "▶ Waiting for the agent service to come up (verifying it is v${EXPECTED_VERSION:-?})…"
WAITED=0
until verify_running_agent; do
  # A load can wedge (the 933e6ca4 lesson) — one kickstart replaces the
  # instance in a single step instead of waiting out a full no-op window.
  if [[ "$WAITED" -ge 20 && -z "${KICKED:-}" ]]; then
    KICKED=1
    echo "  … not up yet after ${WAITED}s — kicking the service once (launchctl kickstart -k)"
    launchctl kickstart -k "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  fi
  sleep 2; WAITED=$((WAITED + 2))
  if [[ "$WAITED" -ge 90 ]]; then
    echo "" >&2
    echo "✗ THE AGENT DID NOT COME UP — the install is NOT complete." >&2
    echo "  The launchd service loaded but nothing stamped the running-agent" >&2
    echo "  file after ${WAITED}s. Most likely causes, in order:" >&2
    echo "   1. The service crashed at startup — the reason is in its log:" >&2
    echo "        tail -40 \"$LOG_DIR/digby-agent.err.log\"  (and digby-agent.log)" >&2
    echo "   2. An OLD Digby helper (the Mac app's bundled 0.6.3, or a /Library/Digby" >&2
    echo "      install) is wedged beside this install — list what is running:" >&2
    echo "        launchctl list | grep -i digby" >&2
    echo "   3. This Mac's one-click path in the Mac app keeps re-adding the bundled" >&2
    echo "      helper — quit the Digby app, re-run this command, then relaunch" >&2
    echo "      the app (and update it when it offers)." >&2
    echo "  Diagnostics to send if it persists:" >&2
    echo "    cat \"$STAMP\" 2>/dev/null; launchctl list | grep -i digby; AGENT_DIR=\"$AGENT_DIR\" node -p \"require(process.env.AGENT_DIR + '/package.json').version\"" >&2
    exit 1
  fi
done
echo "  ✓ verified: the RUNNING agent is v$EXPECTED_VERSION ($(node -e "const s=require(process.argv[1]);console.log('pid '+s.pid+' — '+s.entry)" "$STAMP" 2>/dev/null || echo "$AGENT_DIR"))"

echo ""
echo "✓ The Digby agent is installed and running (it also starts automatically at login)."
echo ""
# 69ce3f01: the runbook's commands are written `digby-agent <subcommand>`, so
# say where that command IS and how to make it a bare word. Printing only the
# path would leave the reader to discover the PATH line themselves — which is
# how the owner got `command not found` in the first place.
echo "  The 'digby-agent' command is installed at:"
echo "    $DIGBY_CLI_SHIM"
echo "  To run it as plain 'digby-agent' (recommended — it survives updates), add"
echo "  its directory to your PATH once:"
echo "    echo 'export PATH=\"\$HOME/Library/Application Support/Digby/bin:\$PATH\"' >> ~/.zshrc && exec zsh"
echo "  Until then, invoke it by that full path (quote it — the path has a space):"
echo "    \"$DIGBY_CLI_SHIM\" unattended status"
echo "  Under sudo the shell expands \$HOME for you, so this also works:"
echo "    sudo \"\$HOME/Library/Application Support/Digby/bin/digby-agent\" remote-access status"
echo ""

# ── Full Disk Access: probe FIRST, name the right file (ticket 51d8dbe0) ───────
# The grant attaches to $DIGBY_AGENT_BIN ("DigbyAgent"), not to 'node'. Probe
# via the NEW binary (chat.db open under THIS executable decides); when it is
# already granted (re-install / re-run of the installer) say so in one line
# instead of re-walking the add-the-file dance, and when it is missing open
# the pane + reveal DigbyAgent. The dialog names DigbyAgent — TCC lists the
# executable's name, so the entry the user adds reads "DigbyAgent".
FDA_OK=0
"$DIGBY_AGENT_BIN" "$AGENT_DIR/dist/index.js" fda-check >/dev/null 2>&1 && FDA_OK=1

if [[ "$FDA_OK" = "1" ]]; then
  echo "✓ Full Disk Access is already granted to DigbyAgent — iMessage reads are enabled."
else
  echo "═══════════════════════════════════════════════════════════════════"
  echo "  ONE LAST STEP — allow Digby to read Messages (takes ~20 seconds)"
  echo "════════════════════════════════════════════════════════════════════"
  echo "  System Settings just opened to 'Full Disk Access'. Please:"
  echo "    1. Click the  +  button (you may need to unlock with Touch ID / password)."
  echo "    2. A Finder window is open showing a file called 'DigbyAgent' (highlighted)."
  echo "       Drag that 'DigbyAgent' file into the list, OR select it and click Open."
  echo "       (If an older install added a plain 'node' entry, you can remove it with"
  echo "        its − button — it is no longer used.)"
  echo "    3. Make sure its switch is turned ON (blue)."
  echo ""
  echo "  When you send your first message, macOS will also ask to allow"
  echo "  controlling 'Messages' — just click  OK / Allow."
  echo "════════════════════════════════════════════════════════════════════"
  echo ""

  # Open the exact System Settings pane and reveal the DigbyAgent binary so
  # the user can simply drag it in — no navigating required.
  open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles" 2>/dev/null || true
  open -R "$DIGBY_AGENT_BIN" 2>/dev/null || true
fi

# Restart the agent ONLY when there is a permission to pick up. 933e6ca4 +
# reviewer round 2 (causality corrected): the OLD code bounced the service
# unconditionally on every installer run, and the owner reproduced the app
# UI losing its connection on every update run. The precise mechanism is
# NOT established (a plain unload→load with RunAtLoad should relaunch
# within seconds — a wedged `load` swallowed by >/dev/null 2>&1, or the
# webview's own connection, are equally plausible); what IS established is
# that the unconditional second bounce existed only to pick up a permission
# granted mid-install, and removing it removes the reproduced disconnect.
# Gate (reviewer round 2 wording): FDA was MISSING at probe time — the user
# is mid-flow and may grant it during the 45s window (an SR/AX-only grant
# with FDA already given is NOT covered; it is picked up at the next
# natural restart). When FDA is already granted there is nothing to pick
# up: no bounce at all. kickstart -k replaces the running instance in one
# step (no unload/load window).
if [[ "$FDA_OK" != "1" ]]; then
  ( sleep 45; launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null || { launchctl unload "$PLIST_DEST" 2>/dev/null; launchctl load "$PLIST_DEST" 2>/dev/null; } ) >/dev/null 2>&1 &
fi

if [[ "$FDA_OK" = "1" ]]; then
  echo "(Logs: $LOG_DIR/digby-agent.log · Stop: launchctl unload \"$PLIST_DEST\")"
else
  echo "Once you've flipped the switch, head back to Digby — it will connect within a few seconds."
  echo "(Logs: $LOG_DIR/digby-agent.log · Stop: launchctl unload \"$PLIST_DEST\")"
fi
