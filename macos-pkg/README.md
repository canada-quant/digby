# Digby iMessage Agent — signed `.pkg` installer (macOS)

Builds a **signed + notarized** `DigbyAgent.pkg` that bundles its own Node runtime,
so end users need **nothing installed** and **never touch Terminal**:

1. Download `DigbyAgent.pkg` from `https://digby.example.com/DigbyAgent.pkg`, double-click,
   click through the installer (no Gatekeeper warning — it's notarized).
2. The agent starts automatically and shows a **native popup** asking for the
   pairing code (copied from Digby → Account → Integrations → iMessage).
3. It then opens **Full Disk Access** and reveals the bundled `DigbyAgent` to drag in
   (one switch). First send also asks to allow **Messages** automation → Allow.

> The build runs **only on macOS** (it needs `pkgbuild`/`productbuild`/`codesign`/
> `notarytool` and your Developer ID private keys). It cannot be built in CI/Linux.

## One-time setup
1. **Two certs** at developer.apple.com → Certificates:
   - **Developer ID Application** — signs the bundled binaries (required for notarization).
   - **Developer ID Installer** — signs the `.pkg`. *(Team ID `Z5U9T5PUJ3`.)*
   Import both into your login Keychain (double-click the downloaded `.cer`).
2. **Notarization credentials** (app-specific password from appleid.apple.com):
   ```bash
   xcrun notarytool store-credentials digby-notary \
     --apple-id "you@example.com" --team-id Z5U9T5PUJ3 --password "abcd-efgh-ijkl-mnop"
   ```

## Build
```bash
cd macos-pkg
./build-pkg.sh          # → ../DigbyAgent.pkg  (signed + notarized + stapled)
```
Override defaults if your cert display names differ:
```bash
APP_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
INSTALLER_IDENTITY="Developer ID Installer: Your Name (TEAMID)" \
TEAM_ID=TEAMID ./build-pkg.sh
```

## Publish
The build already staged BOTH files into `frontend/public/` — the pkg and its
freshness stamp. Commit + push (deploy):
```bash
git add frontend/public/DigbyAgent.pkg frontend/public/DigbyAgent.pkg.json
git commit -m "chore: publish DigbyAgent.pkg" && git push origin main
```
The stamp is what makes the UI offer it: the iMessage card shows **“Download the
Digby installer”** (the `.pkg`) as the primary option ONLY while
`DigbyAgent.pkg.json` says the served pkg bundles the current agent release
(405927c9 interim, 2026-10-25). An unstamped or stale pkg is de-featured to the
one-line installer — publish both files or neither (a pkg without its stamp
stays hidden forever).

## What it installs
- Payload → `/Library/Digby/imessage-agent/` (bundled `DigbyAgent` runtime, `dist/`, `node_modules/`).
- A per-user LaunchAgent `ai.digby.imessage-agent` (runs 24/7 in the user's session).
- Uninstall: `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/ai.digby.imessage-agent.plist`
  then `sudo rm -rf /Library/Digby` and `rm ~/Library/LaunchAgents/ai.digby.imessage-agent.plist`.

## Installer identity + freshness (ticket 405927c9)

- **Branding:** the distribution XML carries `<title>Digby iMessage Agent</title>` —
  Installer.app's title bar, its completion line, and System Settings →
  Installation history all name Digby (the old `productbuild --package` build
  showed a generic "Installer" and `installed ""`). The Digby propeller-beanie
  mark ships as the installer `<background>` (`assets/installer-background.png`,
  centered, proportional) — a `.pkg`'s own file icon cannot be customized, so the
  background is Installer.app's one branding surface.
- **Version:** the pkg version comes from `imessage-agent/package.json`
  (override with `VERSION=x.y.z` when pinning a release) — never a hardcoded
  default.
- **Staleness guard:** the build REFUSES when the tree's agent version ≠ the
  release manifest (`backend/.../agent-release.ts`). A .pkg bundling an agent
  older than the tarball agents actually download is a silent fleet regression
  (the June 2026 .pkg froze agent 0.1.0 for four months). Run
  `scripts/publish-agent-tarball.sh` first when releasing.
- **Yields to self-managed installs:** if `~/Library/LaunchAgents/com.digby.agent.plist`
  exists (the one-line installer's agent — the only shape that self-updates),
  postinstall lays down the payload but does NOT install a launchd job beside
  it: the two would poll with the same token and flap the Mac's reported
  agentVersion forever. Nothing at `/Library/Digby` runs in that case.

## Notes / caveats
- The `.pkg` is built for the **architecture of the build Mac** (Apple Silicon → arm64).
  For a universal installer you'd build the native `node_modules` + bundle node for
  both arches and merge — TODO if you need Intel support.
- Bundling Node keeps the payload ~40–60 MB. That's the trade-off for zero prerequisites.

## Troubleshooting (hard-won)

**`codesign` fails with `errSecInternalComponent` + `Warning: unable to build chain
to self-signed root`** — even though `security find-identity` lists the cert and
`security verify-cert` says "successful". This almost always means you set your
Developer ID **leaf** cert to **"Always Trust"** in Keychain Access (a natural
reaction to a "certificate is not trusted" message). That marks the leaf as a
trust anchor (`kSecTrustSettingsResultTrustAsRoot`), which breaks codesign's chain
build. Diagnose + fix:
```bash
security dump-trust-settings          # look for your Developer ID certs listed here
security find-certificate -c "Developer ID Application: …" -p > /tmp/app.pem
security remove-trusted-cert /tmp/app.pem   # repeat for the Installer cert
sudo killall trustd                    # flush the cached evaluation
```
Then re-test: `codesign --force --options runtime --timestamp --sign <APP-HASH> /tmp/cstest`.
**Never set "Always Trust" on Developer ID certs — leave trust at "Use System Defaults."**

**Other gotchas we hit:**
- **Duplicate cert in the System keychain** (`find-identity` shows the cert twice) →
  codesign may pick the keyless System copy and fail. Remove it:
  `sudo security delete-certificate -c "Developer ID Application: …" /Library/Keychains/System.keychain`.
- **`productsign: unable to build chain to self-signed root` → notary `Invalid`
  ("not signed with a valid Developer ID certificate")** → the Developer ID
  intermediate isn't installed. Double-click `http://certs.apple.com/devidg2.der`.
  Do **not** import the Apple **Root** CA into login (only the intermediate) — a
  duplicate root in login breaks codesign.
- **Notary `Invalid` with a valid-looking cert** → you're signing with a **revoked**
  cert (e.g. one recreated/revoked at developer.apple.com). Sign with the current one
  (`security find-identity -v -p basic` shows the hashes; the build resolves by hash).
- **`errSecInternalComponent` after lots of keychain edits** → if none of the above,
  `security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "<login-pw>"
  ~/Library/Keychains/login.keychain-db` restores codesign's key access.
