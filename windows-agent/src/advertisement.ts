/**
 * Agent platform + capability advertisement (W0, 2026-09-25).
 *
 * The backend now stores a per-agent platform + capability set (Prisma
 * IMessageAgent.platform / .capabilities — migration 20260925031500). The
 * Windows agent advertises `platform: 'windows'` and `capabilities:
 * ['browser','computer']` at pair time and on every poll, so the backend's
 * gates (computerUseAvailable / localBrowserAvailable) answer from the
 * advertisement instead of guessing from Mac version numbers (roadmap §2.7).
 *
 * AGENT_VERSION 0.9.1 (ticket 4424ebd6, 2026-10-21): the helper locator fix
 * — the shipped bundle installs digby-win-helper.exe at the BUNDLE ROOT
 * (beside dist/, per digby.nsi SecAgent) but 0.9.0 probed only INSIDE dist/
 * (join(__dirname,…)), so a fresh standard install paired + polled fine but
 * every computer_* command failed with "helper executable not found".
 * 0.9.1 probes the bundle root FIRST, then inside dist/ (legacy manual
 * workaround). No wire/capability change: 0.9.1 sits above every backend
 * dispatch gate exactly like 0.9.0 — in particular the 0.9.0 minAgentVersion
 * UIA gate (Mac 0.5.x can never claim uia_*; this agent still can).
 * Base 0.9.0 (W3 — UIA perception): the Rust helper (digby-win-helper)
 * replaces the W1 native-FFI layer — Windows Graphics Capture (GDI
 * fallback), SendInput, UI Automation tree dumps + pattern invoke, and the
 * safety surfaces (elevation/secure-desktop/DRM/anti-cheat, frozen UIA_*
 * refusal codes). Capabilities unchanged ['browser','computer'] —
 * uia_tree/uia_invoke ride the existing 'computer' capability.
 */

export const AGENT_VERSION = '0.9.1';

export const PLATFORM = 'windows' as const;

/** What this build ships. iMessage is macOS-only — never advertised here. */
export const CAPABILITIES = ['browser', 'computer'] as const;

/** Pair-body advert (POST /crossmodel/imessage/pair/complete). */
export function pairAdvertisement() {
  return {
    platform: PLATFORM,
    capabilities: [...CAPABILITIES],
  };
}

/** Poll-query advert (GET /crossmodel/imessage/agent/poll?...). */
export function pollAdvertisementQuery(): string {
  return `version=${encodeURIComponent(AGENT_VERSION)}&platform=${PLATFORM}&capabilities=${CAPABILITIES.join(',')}`;
}
