; digby.nsi — NSIS 3 per-user installer for the Digby Windows shell (W2).
;
; Build: windows-shell/installer/build-installer.sh (publishes the shell to
; windows-shell/publish, then compiles with the local-layout defines below),
; or manually from this directory:
;   makensis -DPUBLISH_DIR=..\publish -DDIST_DIR=..\dist digby.nsi
; (-D, not /D: the dash form works on both Windows and Linux makensis.)
;
; CWD-INDEPENDENT: !cd "${__FILEDIR__}" pins every relative path to THIS
; directory, so makensis may be invoked from anywhere — CI
; (.github/workflows/windows.yml) runs it from the repo root with the full
; script path and NO defines, relying on the defaults below.
;
; PER-USER by design (roadmap §2.9): RequestExecutionLevel user → NO UAC
; prompt; installs to $LOCALAPPDATA\Programs\Digby; shortcuts + Run key are
; HKCU/per-user (SetShellVarContext current). Nothing touches HKLM or
; Program Files, so a standard user can install and uninstall without admin.
;
; /AUTOSTART command-line flag: pre-checks the "Start Digby when I sign in"
; section (e.g. silent install: Digby-Setup.exe /S /AUTOSTART=D=/D=... no —
; just: Digby-Setup.exe /S /AUTOSTART).
;
; Uninstall keeps %LOCALAPPDATA%\Digby user data (login profile, window state,
; shell.log) ON PURPOSE — a reinstall must not log the user out. See README.

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

; ── CWD-independence + build-layout defines ──────────────────────────────────
; ${__FILEDIR__} = the directory THIS script lives in (windows-shell/installer),
; regardless of the CWD makensis was invoked from. Everything below is relative
; to it, so CI can run `makensis <repo-root>\windows-shell\installer\digby.nsi`
; from the repo root with no cd and no defines.
!cd "${__FILEDIR__}"

; Where the published shell is staged. DEFAULT = the CI layout
; (.github/workflows/windows.yml): dotnet publish -o <workspace>\publish\shell,
; which is ..\..\publish\shell relative to this script. build-installer.sh
; overrides it with its own windows-shell\publish layout via -DPUBLISH_DIR=...
!ifndef PUBLISH_DIR
  !define PUBLISH_DIR "..\..\publish\shell"
!endif

; Where the AGENT bundle is staged (W3): CI stages it at
; <workspace>\publish\agent (cargo-built digby-win-helper.exe + node.exe +
; agent dist/ + production node_modules — see windows.yml's "Stage the agent
; bundle" step). build-installer.sh overrides with its own layout via
; -DAGENT_PUBLISH_DIR=..\publish\agent. Kept SEPARATE from PUBLISH_DIR so
; the shell dir (which contains only Digby.Shell.exe + the icon) and the
; agent dir never alias.
!ifndef AGENT_PUBLISH_DIR
  !define AGENT_PUBLISH_DIR "..\..\publish\agent"
!endif

; Where the installer EXE is written. DEFAULT = the CI layout: ..\..\publish
; (the workspace publish\ folder) — inside the workflow's upload path
; (publish/**) and the installer-sign step's files-folder (<workspace>\publish,
; non-recursive), so the artifact is uploaded AND signed. build-installer.sh
; overrides to windows-shell\dist via -DDIST_DIR=... for local builds.
!ifndef DIST_DIR
  !define DIST_DIR "..\..\publish"
!endif

; The shell + installer icon: ../digby.ico relative to this script (tracked in
; the repo beside the .csproj). Overridable for out-of-tree builds.
!ifndef ICON_DIR
  !define ICON_DIR ".."
!endif

; ── Compression ──────────────────────────────────────────────────────────────
; LZMA SOLID (NSIS's default is zlib). The payload — self-contained .NET shell
; (~180 MB) + node.exe (~87 MB) + agent JS/node_modules (~19 MB) — lands at
; 103.1 MiB under zlib, which is OVER GitHub's 100 MiB push limit and therefore
; blocks the digby.ai publish path (frontend/public direct commit, the Digby.dmg
; precedent). LZMA-solid compresses this mix ~25-40% smaller (~7x MB) — under
; the limit and a smaller download for every user.
;   /FINAL  — an !include'd script cannot silently re-set it back to zlib.
;   /SOLID  — one data block across all files: best ratio for this payload.
SetCompressor /FINAL /SOLID lzma

!define APPNAME    "Digby"
!define APPEXE      "Digby.Shell.exe"
!define APPICON     "digby.ico"
!define APPVERSION  "1.0.2"   ; keep in sync with <Version> in Digby.Shell.csproj
!define PUBLISHER   "Digby"
!define UNINSTKEY   "Software\Microsoft\Windows\CurrentVersion\Uninstall\Digby"
!define RUNKEY      "Software\Microsoft\Windows\CurrentVersion\Run"
!define SETTINGSKEY "Software\Digby"

Name "${APPNAME}"
OutFile "${DIST_DIR}\Digby-Setup.exe"
Unicode true
ShowInstDetails show
ShowUnInstDetails show
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\Digby"
; Remember a custom install dir across reinstall/upgrade (HKCU — per-user).
InstallDirRegKey HKCU "${SETTINGSKEY}" "InstallDir"

; ── MUI2 configuration (no license page: no LICENSE ships with the installer) ─

!define MUI_ABORTWARNING
!define MUI_ICON "${ICON_DIR}\digby.ico"
!define MUI_UNICON "${ICON_DIR}\digby.ico"

!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; ── Sections ─────────────────────────────────────────────────────────────────

Section "Digby (required)" SecCore
  SectionIn RO    ; always installed, not uncheckable

  SetOutPath "$INSTDIR"

  ; The published shell (CI stages it at <workspace>\publish\shell via
  ; `dotnet publish -o`; build-installer.sh stages it at ..\publish): a
  ; self-contained single-file exe + the tray/window icon. /nonfatal on the
  ; ico so a publish without it never breaks the build (the exe also embeds
  ; it via ApplicationIcon). The exe is HARD-required (makensis errors on a
  ; missing File) — a publish dir without the exe is a real build failure.
  File "${PUBLISH_DIR}\${APPEXE}"
  File /nonfatal "${PUBLISH_DIR}\${APPICON}"

  ; Per-user shortcuts ($SMPROGRAMS/$DESKTOP are user-scoped via
  ; SetShellVarContext current in .onInit).
  CreateDirectory "$SMPROGRAMS\Digby"
  CreateShortcut  "$SMPROGRAMS\Digby\Digby.lnk" "$INSTDIR\${APPEXE}"
  CreateShortcut  "$SMPROGRAMS\Digby\Uninstall Digby.lnk" "$INSTDIR\uninstall.exe"

  ; Registry: install dir memory (per-user) + Add/Remove Programs entry
  ; (HKCU — visible under "Apps & features" for this user only, no admin).
  WriteRegStr HKCU "${SETTINGSKEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayName"     "${APPNAME}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion"  "${APPVERSION}"
  WriteRegStr HKCU "${UNINSTKEY}" "Publisher"       "${PUBLISHER}"
  WriteRegStr HKCU "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayIcon"     "$INSTDIR\${APPEXE}"
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""

  WriteUninstaller "$INSTDIR\uninstall.exe"
SectionEnd

Section "Desktop shortcut" SecDesktop
  CreateShortcut "$DESKTOP\Digby.lnk" "$INSTDIR\${APPEXE}"
SectionEnd

; ── W3: the agent daemon bundle (browser + computer use) ─────────────────────
; Default-ON (a checked section — the agent is part of the standard install),
; with its OWN per-user autostart (HKCU Run "DigbyAgent"), deliberately
; SEPARATE from the shell's SecAutostart: shell and agent are independent
; processes with independent lifecycles — a user may want the tray shell
; without the background daemon or vice versa.
;
; Everything here is File /nonfatal: the bundle is staged by
; build-installer.sh (or CI) and ANY piece may be absent (the agent refuses
; cleanly when the helper exe is missing); the SHELL install must never fail
; because the agent bundle is incomplete (the W2 contract).
Section "Digby Agent (browser + computer use)" SecAgent
  SetOutPath "$INSTDIR\agent"
  File /nonfatal "${AGENT_PUBLISH_DIR}\launch-agent.bat"
  File /nonfatal "${AGENT_PUBLISH_DIR}\node.exe"
  File /nonfatal "${AGENT_PUBLISH_DIR}\digby-win-helper.exe"
  File /nonfatal /r "${AGENT_PUBLISH_DIR}\dist"
  File /nonfatal /r "${AGENT_PUBLISH_DIR}\node_modules"
  SetOutPath "$INSTDIR"

  ; The agent's OWN autostart — the per-user Run key "DigbyAgent" launches
  ; launch-agent.bat, which runs the agent loop under the bundled node.exe.
  ; Written when this section installs (default on); the uninstaller always
  ; removes it even if the section was never installed (DeleteRegValue on a
  ; missing value is a no-op).
  WriteRegStr HKCU "${RUNKEY}" "DigbyAgent" "$\"$INSTDIR\agent\launch-agent.bat$\""

  ; The agent's log dir (rotation-less append; %LOCALAPPDATA%\Digby\agent.log
  ; is user data — deliberately kept on uninstall like the shell's data).
  CreateDirectory "$LOCALAPPDATA\Digby"
SectionEnd

Section /o "Start Digby when I sign in" SecAutostart
  ; Opt-in (the /o flag = unchecked by default). Writes the per-user Run key;
  ; the uninstaller always removes it, even if this section was never
  ; installed (DeleteRegValue on a missing value is a no-op).
  WriteRegStr HKCU "${RUNKEY}" "${APPNAME}" "$\"$INSTDIR\${APPEXE}$\""
SectionEnd

; ── .onInit: per-user shell context + /AUTOSTART pre-check ───────────────────

Function .onInit
  ; ALL $SMPROGRAMS / $DESKTOP / $APPDATA references in this installer are
  ; per-user (current), never all-users — matches RequestExecutionLevel user.
  SetShellVarContext current

  ; /AUTOSTART on the installer command line pre-checks the autostart section
  ; (it can still be unchecked in the UI; a silent /S install takes it).
  ClearErrors
  ${GetOptions} $CMDLINE "/AUTOSTART" $R0
  ${Unless} ${Errors}
    SectionSetFlags ${SecAutostart} 1   ; SF_SELECTED
  ${EndUnless}
FunctionEnd

; ── Uninstaller ──────────────────────────────────────────────────────────────

Section "Uninstall"
  ; Per-user scope for the shortcut folders (mirror of .onInit).
  SetShellVarContext current

  ; The agent FIRST: terminate the running agent loop + helper (the Run key
  ; relaunches at next logon, so the kill matters for THIS session), then
  ; remove the agent's OWN Run key — written by SecAgent whenever it
  ; installed; DeleteRegValue on a missing value is a no-op.
  nsExec::ExecToLog 'taskkill /f /im digby-win-helper.exe'
  nsExec::ExecToLog 'taskkill /f /fi "IMAGENAME eq node.exe" /fi "WINDOWTITLE eq Digby Agent*"'
  DeleteRegValue HKCU "${RUNKEY}" "DigbyAgent"

  ; The SHELL's Run key — removed even when the autostart section was never
  ; selected.
  DeleteRegValue HKCU "${RUNKEY}" "${APPNAME}"

  ; Shortcuts
  Delete "$SMPROGRAMS\Digby\Digby.lnk"
  Delete "$SMPROGRAMS\Digby\Uninstall Digby.lnk"
  RMDir  "$SMPROGRAMS\Digby"
  Delete "$DESKTOP\Digby.lnk"

  ; The agent bundle (SecAgent's mirror).
  RMDir /r "$INSTDIR\agent"

  ; Files + dir
  Delete "$INSTDIR\${APPEXE}"
  Delete "$INSTDIR\${APPICON}"
  Delete "$INSTDIR\uninstall.exe"
  RMDir  "$INSTDIR"    ; removed only if empty — never deletes user data elsewhere

  ; Registry
  DeleteRegKey HKCU "${UNINSTKEY}"
  DeleteRegKey HKCU "${SETTINGSKEY}"

  ; DELIBERATELY NOT REMOVED: %LOCALAPPDATA%\Digby — the WebView2 login
  ; profile, window placement and shell.log. Uninstall+reinstall must not log
  ; the user out. A user who wants a full wipe deletes that folder by hand
  ; (documented in the README).
SectionEnd
