#!/usr/bin/env bash
# build-installer.sh — build the Digby Windows shell and package it with NSIS.
#
# Runs on windows-latest (GitHub Actions, bash) AND on a dev Linux box:
#   - dotnet publish of windows-shell/Digby.Shell.csproj (self-contained
#     single-file, win-x64). On Linux this needs the EnableWindowsTargeting
#     property — passed automatically when the host is not Windows.
#   - NSIS compile of installer/digby.nsi → dist/Digby-Setup.exe. NSIS is
#     preinstalled on GitHub windows-latest runners at the checked paths;
#     on Linux, a distro makensis works if present.
#
# Usage: bash windows-shell/installer/build-installer.sh
# Env:   none required. ARTIFACT_DIR (optional) copies the installer + exe
#        there at the end (CI artifact staging convenience).
#
# The NSIS script is CWD-independent (`!cd "${__FILEDIR__}"` in digby.nsi) and
# takes its layout via overridable defines; this script passes ITS layout
# (windows-shell/publish, windows-shell/dist). CI's windows.yml invokes
# makensis directly from the repo root with NO defines and relies on the
# script's DEFAULTS (..\..\publish\shell, ..\..\publish).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHELL_DIR="$(cd "$HERE/.." && pwd)"
PUBLISH_DIR="$SHELL_DIR/publish"
DIST_DIR="$SHELL_DIR/dist"

echo "==> Digby Windows shell + installer build"
echo "    shell dir: $SHELL_DIR"

# ── 1. dotnet SDK 8 ──────────────────────────────────────────────────────────
if ! command -v dotnet >/dev/null 2>&1; then
  echo "ERROR: dotnet SDK not found on PATH." >&2
  echo "       Install .NET 8 SDK: https://dotnet.microsoft.com/download/dotnet/8.0" >&2
  exit 1
fi
if ! dotnet --list-sdks 2>/dev/null | grep -qE '^8\.'; then
  echo "ERROR: .NET 8 SDK required (dotnet --list-sdks shows no 8.x)." >&2
  dotnet --list-sdks >&2 || true
  exit 1
fi
echo "    dotnet: $(dotnet --version)"

# ── 2. dotnet publish (idempotent) ───────────────────────────────────────────
echo "==> dotnet publish (Release, win-x64, self-contained single-file)"
PUBLISH_ARGS=(-c Release -r win-x64 -o "$PUBLISH_DIR")
# Cross-building the win-x64 WinForms target from Linux needs this property;
# on Windows it is a harmless no-op.
if [[ "$(uname -s)" != "Linux" ]]; then
  # windows runners (and macOS, just in case) — plain publish works
  :
else
  PUBLISH_ARGS+=("/p:EnableWindowsTargeting=true")
fi
dotnet publish "$SHELL_DIR/Digby.Shell.csproj" "${PUBLISH_ARGS[@]}"

if [[ ! -f "$PUBLISH_DIR/Digby.Shell.exe" ]]; then
  echo "ERROR: publish produced no Digby.Shell.exe in $PUBLISH_DIR" >&2
  exit 1
fi
echo "    published: $PUBLISH_DIR/Digby.Shell.exe ($(du -h "$PUBLISH_DIR/Digby.Shell.exe" | cut -f1))"

# ── 3. Agent bundle (W3 — the browser + computer-use daemon) ────────────────
# Stage the full agent bundle to $PUBLISH_DIR/agent/ so digby.nsi's optional
# "Digby Agent" section can install it:
#   agent/dist/                  — the compiled agent (npm run build)
#   agent/node_modules/          — PRODUCTION deps only (npm ci --omit=dev)
#   agent/digby-win-helper.exe   — the Rust helper (cargo build --release;
#                                  prebuilt by CI or $DIGBY_WIN_HELPER_EXE)
#   agent/node.exe               — the official Node runtime (win-x64 zip)
#   agent/launch-agent.bat       — per-user launcher (HKCU Run key target)
# Every stage is SKIPPABLE: a missing piece logs a notice and the section
# simply installs what exists (File /nonfatal in digby.nsi) — the SHELL must
# keep building even when the agent toolchain is absent (the W2 contract).
stage_agent_bundle() {
  local agent_src="$SHELL_DIR/../windows-agent"
  local out="$PUBLISH_DIR/agent"
  mkdir -p "$out"

  # 3a. The compiled agent (dist/) — requires the agent's devDeps (tsc).
  if [[ -d "$agent_src/dist" ]] || (cd "$agent_src" && npm ci --no-audit --no-fund >/dev/null 2>&1 && npm run build >/dev/null 2>&1); then
    cp -R "$agent_src/dist" "$out/dist"
    echo "    agent: dist/ staged ($(find "$out/dist" -name '*.js' | wc -l) js files)"
  else
    echo "    agent: dist/ NOT staged (build unavailable) — the agent section installs without it"
  fi

  # 3b. Production node_modules.
  if (cd "$agent_src" && npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1); then
    cp -R "$agent_src/node_modules" "$out/node_modules"
    echo "    agent: node_modules/ staged (production only)"
  else
    echo "    agent: node_modules/ NOT staged (npm ci unavailable)"
  fi

  # 3c. The Rust helper exe — CI builds it (cargo build --release) and passes
  #     the path via DIGBY_WIN_HELPER_EXE; a locally prebuilt copy next to
  #     the script or in the agent dir also works.
  local helper_exe=""
  if [[ -n "${DIGBY_WIN_HELPER_EXE:-}" && -f "$DIGBY_WIN_HELPER_EXE" ]]; then
    helper_exe="$DIGBY_WIN_HELPER_EXE"
  elif [[ -f "$agent_src/rust-helper/target/release/digby-win-helper.exe" ]]; then
    helper_exe="$agent_src/rust-helper/target/release/digby-win-helper.exe"
  elif [[ -f "$agent_src/digby-win-helper.exe" ]]; then
    helper_exe="$agent_src/digby-win-helper.exe"
  fi
  if [[ -n "$helper_exe" ]]; then
    cp "$helper_exe" "$out/digby-win-helper.exe"
    echo "    agent: digby-win-helper.exe staged ($(du -h "$out/digby-win-helper.exe" | cut -f1) from ${helper_exe#$SHELL_DIR/})"
  else
    echo "    agent: digby-win-helper.exe NOT staged (set DIGBY_WIN_HELPER_EXE or build rust-helper/) — computer_* will refuse on the installed box"
  fi

  # 3d. node.exe from the official win-x64 zip (cached in /tmp or
  #     DIGBY_NODE_ZIP). ~87MB download — skipped when the env points at a
  #     pre-extracted node.exe.
  local node_exe="${DIGBY_NODE_EXE:-}"
  if [[ -z "$node_exe" ]]; then
    local node_ver="${DIGBY_NODE_VERSION:-22.23.3}"
    local cache_zip="${DIGBY_NODE_ZIP:-/tmp/node-v$node_ver-win-x64.zip}"
    if [[ ! -f "$cache_zip" && -f "$out/node.exe" ]]; then
      echo "    agent: node.exe already staged — skipping the download"
    elif [[ -f "$cache_zip" ]]; then
      unzip -p "$cache_zip" "node-v$node_ver-win-x64/node.exe" > "$out/node.exe" 2>/dev/null \
        && echo "    agent: node.exe staged (v$node_ver from cache)" \
        || echo "    agent: node.exe NOT staged (unzip failed)"
    else
      if curl -fsSL --max-time 300 -o "$cache_zip" "https://nodejs.org/dist/v$node_ver/node-v$node_ver-win-x64.zip" 2>/dev/null; then
        unzip -p "$cache_zip" "node-v$node_ver-win-x64/node.exe" > "$out/node.exe" 2>/dev/null \
          && echo "    agent: node.exe staged (v$node_ver downloaded)" \
          || echo "    agent: node.exe NOT staged (unzip failed)"
      else
        echo "    agent: node.exe NOT staged (download unavailable — set DIGBY_NODE_EXE or DIGBY_NODE_ZIP)"
      fi
    fi
  else
    cp "$node_exe" "$out/node.exe"
    echo "    agent: node.exe staged (from DIGBY_NODE_EXE)"
  fi

  # 3e. The launcher the HKCU Run key points at: runs the agent under the
  #     bundled node.exe, from the install dir, hidden.
  cat > "$out/launch-agent.bat" <<'BAT'
@echo off
rem Digby Agent launcher (per-user autostart target) — runs the agent loop
rem under the bundled node.exe from the install directory.
setlocal
set "DIR=%~dp0"
"%DIR%node.exe" "%DIR%dist\index.js" run >> "%LOCALAPPDATA%\Digby\agent.log" 2>&1
endlocal
BAT
  echo "    agent: launch-agent.bat staged"
}

if [[ "${DIGBY_SKIP_AGENT_BUNDLE:-}" = "1" ]]; then
  echo "==> Agent bundle SKIPPED (DIGBY_SKIP_AGENT_BUNDLE=1)"
else
  echo "==> Staging the agent bundle"
  stage_agent_bundle
fi

# ── 4. NSIS ──────────────────────────────────────────────────────────────────
MAKENSIS=""
if command -v makensis >/dev/null 2>&1; then
  MAKENSIS="makensis"
elif [[ -x "/c/Program Files (x86)/NSIS/makensis.exe" ]]; then
  MAKENSIS="/c/Program Files (x86)/NSIS/makensis.exe"
elif [[ -x "C:\\Program Files (x86)\\NSIS\\makensis.exe" ]] || [[ -x "/c/Program Files (x86)/NSIS/makensis.exe" ]]; then
  MAKENSIS="C:\\Program Files (x86)\\NSIS\\makensis.exe"
fi

mkdir -p "$DIST_DIR"
# digby.nsi is CWD-independent (`!cd ${__FILEDIR__}`) — no cd needed here. The
# -D defines pin THIS script's layout (windows-shell/publish → windows-shell/dist);
# without them the .nsi defaults to the CI layout (..\..\publish\shell, ..\..\publish).
# -D (not /D): the dash form works on BOTH platforms — Linux makensis treats a
# leading / as a path; Windows makensis accepts either prefix. Backslash define
# values are relative to the script dir (the .nsi's !cd anchors them).
NSIS_ARGS=()
NSIS_ARGS+=("-DPUBLISH_DIR=..\\publish")
NSIS_ARGS+=("-DAGENT_PUBLISH_DIR=..\\publish\\agent")
NSIS_ARGS+=("-DDIST_DIR=..\\dist")

if [[ -n "$MAKENSIS" ]]; then
  echo "==> NSIS compile (makensis: $MAKENSIS)"
  # -INPUTCHARSET UTF8: the .nsi contains box-drawing chars in comments.
  # (CI's windows.yml plain `makensis <path>` works because every non-ASCII
  # char in the file is inside comments, which the compiler skips.)
  # Absolute script path + the .nsi's `!cd ${__FILEDIR__}` keep this script
  # itself CWD-independent; the /D defines are relative to the script dir.
  "$MAKENSIS" -INPUTCHARSET UTF8 "${NSIS_ARGS[@]}" "$HERE/digby.nsi"
  if [[ -f "$DIST_DIR/Digby-Setup.exe" ]]; then
    echo "    installer: $DIST_DIR/Digby-Setup.exe ($(du -h "$DIST_DIR/Digby-Setup.exe" | cut -f1))"
  else
    echo "ERROR: makensis ran but $DIST_DIR/Digby-Setup.exe is missing" >&2
    exit 1
  fi
else
  # No NSIS on this box — CI tolerance: warn, do a cheap textual sanity check,
  # exit 0 (the windows-latest CI lane has makensis and does the real compile).
  echo "WARN: makensis not found — the installer was NOT built here." >&2
  echo "      (windows-latest CI runners ship NSIS; local Linux needs 'apt install nsis'.)" >&2
  if bash -n "$HERE/digby.nsi" 2>/dev/null; then
    :
  fi
  # Textual fallback: section openers balanced with SectionEnd + the
  # non-negotiable directives present. The opener pattern must NOT match
  # SectionIn/SectionEnd (both start with "Section").
  opens=$(grep -cE '^Section([[:space:]]|$)' "$HERE/digby.nsi" || true)
  closes=$(grep -c '^SectionEnd' "$HERE/digby.nsi" || true)
  if [[ "$opens" != "$closes" ]]; then
    echo "ERROR: digby.nsi Section/SectionEnd mismatch ($opens/$closes)" >&2
    exit 1
  fi
  for directive in "RequestExecutionLevel user" 'OutFile "${DIST_DIR}\Digby-Setup.exe"' 'File "${PUBLISH_DIR}\${APPEXE}"' '!cd "${__FILEDIR__}"' 'WriteUninstaller'; do
    if ! grep -qF "$directive" "$HERE/digby.nsi"; then
      echo "ERROR: digby.nsi is missing: $directive" >&2
      exit 1
    fi
  done
  echo "    textual checks passed (Section/SectionEnd balanced, key directives present)"
fi

# ── 5. Optional artifact staging ────────────────────────────────────────────
if [[ -n "${ARTIFACT_DIR:-}" ]]; then
  mkdir -p "$ARTIFACT_DIR"
  cp "$PUBLISH_DIR/Digby.Shell.exe" "$ARTIFACT_DIR/"
  if [[ -f "$DIST_DIR/Digby-Setup.exe" ]]; then
    cp "$DIST_DIR/Digby-Setup.exe" "$ARTIFACT_DIR/"
  fi
  echo "==> artifacts copied to $ARTIFACT_DIR"
fi

echo "==> DONE"
