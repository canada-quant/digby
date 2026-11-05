# Windows W4 — live-desktop validation (WGC / UIA / SendInput)

> Automated live-desktop validation of the W3 Rust helper (`digby-win-helper`).
> Companion docs: `docs/WINDOWS_W3_SHIPPING.md` (the helper itself),
> `docs/CLIENT_PLATFORMS_ROADMAP_2026-09.md` §2.10 (W4 row).
> Status header is refreshed per validation run — see "Evidence" below.

## What W4 live validation means

The W3 unit/integration suite (104 tests) pins the helper's **pure** layers and
the agent↔helper wire contract on Linux; `cargo test` on Windows pins the same.
Neither exercises the real OS surface: an actual DWM-composited desktop, a real
UIA provider tree, a real input desktop receiving `SendInput`. W4 proves, on a
**live interactive Windows session**, that:

1. **WGC capture works end-to-end** — `capture_bgra` returns a real frame of
   the live desktop: correct size, non-uniform content, and the backend is
   honestly reported (`wgc` when WGC is available, `gdi` when it falls back —
   the fallback is a designed behavior, not a failure).
2. **UIA perception works end-to-end** — `uia_tree` walks a real app's
   control tree (Notepad) and returns named, bounded nodes in the frozen
   `UiaNode` shape; `uia_invoke` drives a real element and the effect is
   observable.
3. **SendInput works end-to-end** — keystrokes/mouse injected through the
   helper land in a real foreground app and the effect is observable through
   an independent channel (UIA ValuePattern readback), not just "no error".

## The harness

Everything is driven from ONE harness so the exact same validation runs in CI
and on a physical box:

```
windows-agent/scripts/w4-live-desktop.mjs   — Node, no deps beyond node:*
                                             (spawn helper, protocol, asserts,
                                             PNG artifact writer, exit code)
windows-agent/scripts/w4-desktop.png        — written by the harness (gitignored)
.github/workflows/windows.yml               — `w4-live-desktop` job (windows-latest,
                                             gated on the script existing)
```

Run it anywhere the helper is built:

```powershell
cargo build --release --manifest-path windows-agent/rust-helper/Cargo.toml
node windows-agent/scripts/w4-live-desktop.mjs
```

Exit code 0 = every criterion passed. The harness also writes
`w4-desktop.png` (the actual captured frame — the single most convincing
artifact) and prints a per-criterion result table.

## Criteria (checked by the harness)

| # | Criterion | Assertion |
|---|---|---|
| C1 | Protocol liveness | `ping` answers `ok:true` with `version` = the helper's version |
| C2 | Session is interactive | `environment_check.secure_desktop === false` (the input desktop is openable ⇒ not a locked/UAC session). On a non-interactive runner this FAILS by design — the session must be made interactive first (see "CI runner session model" below) |
| C3 | Foreground app observable | `frontmost` returns `{app, window}` for the foreground window (the harness sets one up: Notepad) |
| C4 | Notepad focused via UIA | after `uia_invoke {pattern:"focus"}` on Notepad's window element, `environment_check.foreground_exe` contains `notepad` — the UIA path moved real window focus |
| C5 | UIA tree of a real app | `uia_tree` returns `node_count > 5`, the linearized `text` names Notepad, an `edit` element exists with a non-empty `runtime_id` |
| C6 | SendInput typing observable | after `unicode_char`-typing the marker string through SendInput, the Notepad **edit** element's UIA `value` contains the marker — synthetic input demonstrably reached the real app |
| C7 | uia_invoke set_value observable | after `uia_invoke {pattern:"set_value"}` on the edit element, its UIA value equals the new string |
| C8 | Capture size + backend | `capture_bgra` width/height match `monitor_size`, backend is `wgc` or `gdi` (both pass; the field exists so the report can say which) |
| C9 | Capture is a real frame | decoded BGRA has ≥ 16 distinct colors and non-uniform luminance variance (a black/empty desktop would fail), size = w×h×4 bytes |
| C10 | Capture reflects desktop change | a wallpaper repaint (SystemParametersInfo SPI_SETDESKWALLPAPER) measurably changes the frame (mean abs diff > threshold) — the frame is live, not a cached/black one |

C2 is the **gate**: the OS-level input paths are only exercisable in an
interactive session, so the harness refuses to "pass" from a service context.
On the CI runner the harness's own diagnostics tell you which session you're
in (session id, `OpenInputDesktop` verdict) — see below.

## CI runner session model (empirically recorded)

GitHub `windows-latest` runners (image `windows-2025-vs2026`, Windows Server
2025 Datacenter 10.0.26100) execute job steps as `runneradmin` in an
**interactive console session** — `environment_check` reports
`secure_desktop: false` (the input desktop is openable), `frontmost` sees
`WindowsTerminal.exe`, and both SendInput and WGC work directly from job
steps. This was not assumed: the harness records the `whoami`/`quser`/`query
session` output and the `environment_check` verdict in the job log BEFORE any
pass/fail. If GitHub changes the runner image so steps run non-interactively,
C2 fails loudly and this section must be re-validated — do not delete C2 to
make CI green.

## Evidence (refreshed per run)

**First all-green run: [36163611290](https://github.com/example-org/crossmodel/actions/runs/36163611290)**
— job `W4 live-desktop validation (WGC + UIA + SendInput)`, head `dc8aed5d`,
runner image `windows-2025-vs2026` (Windows Server 2025 Datacenter). **10/10
criteria passed.** Captured frame artifact: `w4-live-desktop-dc8aed5…`
(downloaded and verified: PNG 1024×768 RGBA, 195,836 bytes).

| # | Criterion | Observed (verbatim from the run log) |
|---|---|---|
| C1 | helper protocol liveness | `version=0.9.0 platform=windows` |
| C2 | interactive session | `secure_desktop=false fg=WindowsTerminal.exe` |
| C3 | frontmost observable | `app=notepad.exe window="Untitled - Notepad"` |
| C4 | uia_tree walks real app | `node_count=27 root="Untitled - Notepad"` |
| C5 | uia_invoke focus moves real focus | `focus moved off combobox → menu "Status Bar" via SetFocus on pane ""` |
| C6 | SendInput typing observable via UIA | `typed "DigbyW4live0123456789" → observed via uia-value: "DigbyW4live0123456789"` |
| C7 | uia_invoke set_value observable | `control.value="W4setValue-xyz-9876543210"` |
| C8 | capture size + backend | `frame=1024x768 monitor=1024x768 bytes=3145728 backend=wgc` |
| C9 | capture has real content | `distinctColors=27149 meanLum=166.1 variance=10653.2` |
| C10 | capture is live | `topmost 900x700 red overlay (Application.Run-pumped) → meanAbsDiff=120.76 (threshold 1.5)` |

### Defects the live runs caught (fixed in this PR)

1. **`uia_invoke` was dead on live desktops (W3 bug)** — `runtime_id_of`
   called `SafeArrayGetLBound/UBound` with dimension **0**, but SAFEARRAY
   dims are 1-based: the call returns `DISP_E_BADINDEX`, every element's
   runtime_id walked out empty, so `uia_tree` emitted no `#id` markers and
   `uia_invoke`'s `find_by_runtime_id` could never match. Invisible to the
   W3 suite (fake helpers hand-build nodes with runtime ids); first observed
   in run 36161863314 (27 real nodes, zero `#` markers), fixed and proven in
   run 36162681191 (every node carries `#42.393582`-style ids) → 36163611290
   (C5–C7 pass).
2. Harness-side (not product bugs): WinUI Notepad's text area is a Document
   control in the CONTENT view (the control view surfaces a combobox
   container) — discovery matches by role set; the WinForms liveness overlay
   needs `Application.Run` (`Show()`+`Sleep` never pumps WM_PAINT → diff
   0.01 in run 36161863314 vs 120.76 with the pump).

The `w4-desktop.png` artifact is uploaded by the workflow on every run
(success or failure) for eyeball verification.

## What CI CANNOT validate (residual physical-box checklist)

CI gives a real interactive session but a **headless VM**: one virtual monitor,
a software/compositor-backed display, no physical input hardware, and a
pristine OS image that is not a real user machine. The following need a human
on a physical Windows box (run the same harness — `node
windows-agent/scripts/w4-live-desktop.mjs` — after building the helper):

- [ ] **Multi-monitor WGC guard**: the WGC path deliberately falls back to GDI
      when the primary monitor ≠ the whole virtual screen (capture.rs's
      multi-monitor guard; per-monitor WGC composition is future work). On a
      multi-monitor physical box, verify: backend reports `gdi`, capture size
      equals the full virtual-screen span, and coordinates map correctly
      across monitors.
- [ ] **Hardware GPU capture**: CI has no physical GPU output; the D3D11
      device is created on a virtual adapter. On a physical box verify the
      backend reports `wgc` (hardware path) and capture performance is
      interactive-grade.
- [ ] **DRM / protected content**: Netflix/Prime fullscreen playback should
      trigger the DRM heuristic (`UIA_W_DRM_SUSPECTED` warning or `UIA_E_DRM`
      refusal) — no DRM content is installed on CI images.
- [ ] **Physical display quirks**: HDR, high-DPI scaling (150%/200%), rotated
      orientations, variable refresh — capture size and coordinate math only
      approximate these on a single-DPI virtual monitor.
- [ ] **Locked-workstation behavior** (roadmap W4 proper): lock the
      workstation (`Win+L`), then run a capture — expect the documented
      refusal `UIA_E_SECURE_DESKTOP`. Destructive to a CI run's session
      state, safe on a physical box.
- [ ] **Real AV/Defender posture**: the pristine CI image is not a managed
      user machine; the AV-quarantine runbook (roadmap W4) needs a real box
      with Defender cloud heuristics warmed by everyday use.
- [ ] **Real user session profile**: UIA providers of third-party apps
      (Chrome/Edge with a user profile, Office, Slack) are richer than
      Notepad; sanity-check `uia_tree` node counts and readback on the owner's
      actual machine.

## Maintenance

- The harness is Windows-only by nature (it drives the real desktop); it runs
  in the `w4-live-desktop` CI job, not the Linux agent-tests job.
- Criteria C1–C10 are deliberately ordered so a failure names the FIRST broken
  link in the chain (protocol → session → app → UIA → input → capture →
  freshness).
- If the runner session model changes, update "CI runner session model" with
  the new probe evidence — never weaken C2 to fit the runner.
