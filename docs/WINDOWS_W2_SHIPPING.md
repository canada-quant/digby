# Windows Client — W2 Shipping Runbook (owner checklist + internal beta)

W2 makes the Windows client **installable**: WebView2 shell + `__digbyDesktop`
bridge, NSIS per-user installer, CI build/sign pipeline, and CDP-attach that
probes both Chrome and Edge (roadmap §2.10 W2; implementation notes live in
`windows-shell/README.md` and `windows-agent/README.md` — this document is the
**operational** half: what the OWNER must do, what ships when, and how the
internal beta rolls out).

## 1. Owner-gated actions (nothing here is automated)

These require the owner's Azure account and judgment — the repo contains NO
credentials, and CI signs only when the secrets below exist.

### 1.1 Azure Artifact Signing identity validation — START HERE (days of lead time)

> **2026-10-27:** the full, current portal walk-through (the renamed "Artifact
> Signing" resource, Identity Verifier self-assignment, billing-account mechanics
> for individual validation, the 15-region endpoint table, and the six
> `gh secret set` commands) now lives in
> **`docs/WINDOWS_TRUSTED_SIGNING_SETUP.md`** — one read, kept current. The
> summary below still describes the shape; where the two disagree, the setup doc
> wins (notably: lead time is now stated as **1–20 business days**, the RBAC role
> names are now **"Artifact Signing Certificate Profile Signer" / "Artifact
> Signing Identity Verifier"**, and there is **no Canada endpoint** — the
> account/endpoint must be one of the 15 listed regions).

The roadmap said "start at W0"; as of W2 it is still the critical path. Steps
(≈15 minutes of clicks, then a waiting period):

1. **Azure Portal → search "Artifact Signing Accounts" → Create** (older material
   says "Trusted Signing") — Basic tier, **$9.99/mo, 5,000 signatures/mo**. Pick a region and note its
   endpoint — the endpoint MUST match the account's region or every sign call
   403s (e.g. `https://weu.codesigning.azure.net`, `https://eus.codesigning.azure.net`;
   full table: learn.microsoft.com/azure/artifact-signing/how-to-signing-integrations).
   Canada qualifies only for **identity eligibility** (a Canada-based individual
   can pass validation) — there is **no Canada endpoint**, so the account and the
   endpoint must be one of the 15 service regions listed above.
2. **Identity validation** — **1–20 business days** (the older 1–3/3–5-day
   figures are outdated; portal-only, and not expeditable). The validated name
   becomes the certificate subject users see
   (`CN=…`) — choose the identity you want accumulating SmartScreen reputation
   for YEARS. **One stable identity from release 1** (publisher reputation
   accumulates; changing it later resets SmartScreen trust).
3. **Certificate profile** — create a **"Public Trust"** profile under the
   account (this is what earns SmartScreen goodwill; private-trust profiles do
   not).
4. **Entra ID app registration** for CI (the sign step authenticates as a
   service principal):
   - App registrations → New registration → copy the **client (application) ID**
     and the **tenant ID**.
   - Certificates & secrets → New **client secret** → copy the VALUE (shown once).
   - The Artifact Signing account → Access control (IAM) → grant the app
     **"Artifact Signing Certificate Profile Signer"** (older write-ups say
     "Trusted Signing …"; missing role = 403 at
     sign time — the single most common failure).
5. **GitHub repo secrets** (Settings → Secrets and variables → Actions):
   | Secret | Value |
   |---|---|
   | `AZURE_TENANT_ID` | tenant GUID |
   | `AZURE_CLIENT_ID` | app registration client ID |
   | `AZURE_CLIENT_SECRET` | the client secret value |
   | `AZURE_SIGNING_ENDPOINT` | region endpoint, e.g. `https://weu.codesigning.azure.net` |
   | `AZURE_SIGNING_ACCOUNT` | the account name |
   | `AZURE_SIGNING_PROFILE` | the certificate profile name |

   The moment all six exist, `.github/workflows/windows.yml` starts signing
   every build (shell binaries BEFORE packaging, the installer after) — no
   workflow change needed. Until then builds upload UNSIGNED with a visible
   skip notice (internal testing only).

**Verify after setup:** trigger the Windows workflow
(`gh workflow run windows.yml`), open the run, and check the sign step's log —
then on any Windows box: right-click the installer → Properties → Digital
Signatures (or `Get-AuthenticodeSignature .\DigbySetup.exe | fl` — Status
`Valid`, signer = your validated identity, TimeStamperCertificate present).

### 1.2 Why not an EV certificate?

EV certs no longer buy instant SmartScreen trust (Microsoft removed that
guarantee in 2024) and cost 10× more. OV and Artifact Signing are functionally
equivalent for reputation purposes. Do not buy one for this.

## 2. wdsi submission (each release, ~5 minutes, owner action)

A SendInput + screen-capture + HTTPS long-poll + process-spawning agent is
textbook RAT heuristics; Defender ML (`Wacatac.H!ml` class) WILL sometimes
quarantine unsigned or fresh binaries. Microsoft's remedy is proactive
submission of EVERY release:

1. Go to **microsoft.com/wdsi/filesubmission** (sign in with any Microsoft
   account; a company account gets better visibility).
2. Submit the signed installer (and, on first quarantine reports, the agent
   exe) as *Software developer* — "this file should not be detected as
   malware", publisher name = the validated signing identity.
3. Keep the submissions' case numbers in the release notes.
4. Budget **weeks of residual SmartScreen friction** on a fresh identity even
   with perfect process — reputation accrues per-release. For enterprise
   users, document the allowlist path (Defender → Exclusions, or
   `Add-MpPreference -ExclusionPath "$env:LOCALAPPDATA\Programs\Digby"`).

**Build rules that reduce detections** (enforced by the build, listed here so
nobody "optimizes" them away): no packers, no compression shells, no
obfuscation; the C# shell is self-contained single-file (framework-dependent
extraction is fine, UPX is NOT); the agent ships as plain JS + a lazily-loaded
koffi FFI — nothing script-embedding.

## 3. The installer contract (what CI builds)

NSIS per-user (roadmap §2.9 — the agent runs in the USER session, so no UAC and
no Program Files):

- `RequestExecutionLevel user` — installs without any admin prompt.
- Install dir: `$LOCALAPPDATA\Programs\Digby` (the per-user convention; the
  roadmap's relocate-to-`%LOCALAPPDATA%\Digby` for the shell's data).
- Auto-start: HKCU `Software\Microsoft\Windows\CurrentVersion\Run` (opt-in —
  the agent must run in the user session or SendInput/screenshots see nothing;
  SESSION 0 services are useless for computer use).
- Start-menu + desktop shortcuts (per-user locations), full uninstaller that
  also removes the Run key.
- The WebView2 runtime is NOT bundled: it's present on all current Windows
  installs (Edge's engine). The shell's bootstrap checks for it and opens the
  Evergreen Bootstrapper download if genuinely missing.

## 4. Internal beta rollout (W2's distribution milestone)

1. **Channel:** `https://digby.ai/Digby-Setup.exe` — the installer is committed
   to `frontend/public/Digby-Setup.exe` (the `Digby.dmg` precedent) and served
   by the web deploy. The build MUST stay under **GitHub's 100 MiB push limit**
   — `digby.nsi` pins `SetCompressor /FINAL /SOLID lzma` for exactly this
   reason (the zlib default produced a 103.1 MiB installer that could not be
   committed); re-measure on every payload growth (node.exe bumps, new
   node_modules). The CI artifact (`digby-windows-<sha>`, 30-day retention)
   remains the quick-test path for pre-release builds.
2. **Who:** start with 2–3 Windows boxes the owner controls (mixed
   Chrome/Edge, at least one multi-monitor + mixed-DPI machine — the W1
   DPI-reconciliation paths need real-world exercise; at least one
   125%/150%-scaled laptop).
3. **What to watch in week 1:**
   - Defender/AV quarantine events (feed each into wdsi submission §2);
   - SmartScreen "unknown publisher" rates (should drop sharply once signing
     is live);
   - the agent's poll loop behind corporate proxies (the macOS long-poll
     posture should hold; verify CONNECT + 25s poll timeouts);
   - UIPI: any task aimed at an elevated window must return
     `elevation_blocked` — never a silent no-op;
   - CDP-attach against Edge (`msedge --remote-debugging-port=9222`) — W2's
     new probe path has zero production mileage.
4. **Update feed:** the shell checks `https://digby.ai/windows-latest.json`
   (mirror of the macOS `desktop-latest.json` shape — add the file when the
   first beta ships; the web SW bypass already passes `.exe`/`.msi`).

## 5. What W2 does NOT include (do not expect)

- **UIA perception / WGC capture / the Rust helper** — W3 (roadmap §2.4).
  W2's capture stays GDI BitBlt via koffi; UIA tree context arrives next.
- **Anti-cheat refusal list** — W3 (W2 refuses nothing on games beyond the
  documented `elevation_blocked`/verify-or-refuse contracts).
- **Store/MSIX evaluation, locked-workstation matrix, AV runbook hardening** —
  W4.
- **Apple-side anything** — the Apple migration is PARKED by owner decision
  (oq_e70a3c0b, 2026-09-25). macOS notarization and existing certs are
  unaffected.

## 6. Verification evidence (W2)

- `.github/workflows/windows.yml` — YAML-validated, both jobs
  (`agent-tests` on ubuntu; `build` on windows-latest with the resolve-skip
  path). The agent-tests job closes the W1 review gap (the 49-agent tests ran
  nowhere in CI before).
- The shell/installer/cdp-attach implementation evidence lives in the W2
  child PR (see todo bbccd505 evidence for the PR# when merged).
