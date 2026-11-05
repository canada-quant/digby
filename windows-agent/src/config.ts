/**
 * Local agent configuration — stored at %USERPROFILE%\.config\digby-agent\config.json
 * (mirrors the macOS agent's ~/.config/digby-agent path; Node resolves ~ on
 * Windows to %USERPROFILE% so both agents share the layout).
 *
 * Same shape + semantics as imessage-agent/src/config.ts: the backend URL plus
 * the agent identity issued during pairing, plus the stable per-device id that
 * the backend's (userId, deviceId) upsert keys on (multi-device pairing).
 */

import { homedir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'fs';
import { randomUUID } from 'crypto';

export interface AgentConfig {
  apiBaseUrl: string;   // e.g. https://digby.ai/api
  agentId: string;
  agentToken: string;
  /** Stable per-device identity (multi-device): a uuid generated on this PC at
   *  first pair and persisted forever. The backend upserts on
   *  (userId, deviceId), so re-pairing rotates only THIS PC's token. */
  deviceId?: string;
  /** CDP-attach owner master switch (W2, ticket 4258335e) — off by default.
   *  The backend's per-task attach param only takes effect when this is true
   *  (or DIGBY_BROWSER_CDP_ATTACH=1 is set). */
  browserCdpAttach?: boolean;
  /** The owner's Chrome/Edge remote-debugging port (default 9222). */
  browserCdpPort?: number;
  /** W3: extra foreground processes to refuse capture+input on (merged
   *  with the built-in anti-cheat list — vgc.exe, EasyAntiCheat.exe, …).
   *  Case-insensitive exe names. */
  antiCheatProcesses?: string[];
  /** "Unattended / Autonomous use" preset (2026-10-28, owner request on card
   *  oq_f7955582). OFF by default, opt-in per device. `enabled` is set only by
   *  `digby-win-agent unattended enable`; `backup` is the CAPTURED PRE-CHANGE
   *  registry/powercfg state the kill switch restores — values only, NEVER a
   *  password (the auto-logon secret lives in the LSA secret store). */
  unattended?: {
    enabled: boolean;
    backup?: {
      capturedAt: string; user: string;
      autoAdminLogon: string | null; defaultUserName: string | null;
      noLockScreen: string | null; inactivityTimeoutSecs: string | null;
      screensaverSecure: string | null; acStandbyMinutes: string | null;
      lsaSecretExisted: boolean;
    };
    enabledAt?: string;
  };
  /** BROKERED REMOTE ACCESS (ticket c468f922, owner ruling 2026-10-29). OFF by
   *  default, opt-in per device. Set only by
   *  `digby-win-agent remote-access enable`, which runs the HARDENED plan
   *  (firewall scoping BEFORE TermService listens, NLA required, a dedicated
   *  channel account).
   *
   *  ⚠ NO SECRET IS STORED HERE, and none is accepted by the enable path at
   *  all: it never sets a password for the primary account. The dedicated
   *  channel account's secret belongs to Windows (SAM store) and is created by
   *  an administrator on the device. This config holds the non-secret facts
   *  needed to advertise and to revoke. */
  remoteAccess?: {
    enabled: boolean;
    /** The DEDICATED brokered account (never the primary / auto-logon one — the
     *  verdict reports `account-password` if they match). */
    account?: string;
    /** The tunnel CIDR the firewall rule scopes 3389 to. */
    tunnelCidr?: string;
    /** The operator path is the brokered OUTBOUND tunnel. A device that cannot
     *  attest this advertises no `tunnel` mark and reads as not-ready. */
    tunnelOnly?: boolean;
    enabledAt?: string;
  };
}

const CONFIG_DIR = join(homedir(), '.config', 'digby-agent');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

export function configPath(): string {
  return CONFIG_PATH;
}

export function loadConfig(): AgentConfig | null {
  try {
    if (!existsSync(CONFIG_PATH)) return null;
    const raw = readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<AgentConfig>;
    if (!parsed.apiBaseUrl || !parsed.agentId || !parsed.agentToken) return null;
    return parsed as AgentConfig;
  } catch {
    return null;
  }
}

/**
 * Re-read the config from disk, falling back to what the caller already holds.
 *
 * TICKET 11b6974f — WHY THE DAEMON MUST DO THIS. `digby-win-agent unattended
 * enable|disable` and `remote-access …` run in a SEPARATE process and persist
 * their choice by rewriting config.json. The long-running poll loop read the
 * config ONCE at startup and kept that snapshot in a closure for the life of
 * the process, which produced two coupled failures:
 *
 *   1. the agent kept advertising the PRESET IT BOOTED WITH, so an owner who
 *      ran `unattended enable` never saw the fleet flip — the loop's own probe
 *      passed `enabled: false` forever; and
 *   2. worse, the loop writes back to config.json on other changes
 *      (`saveConfig({ ...config, … })`) using that SAME stale snapshot —
 *      silently ERASING the `unattended` block the CLI had just written. The
 *      preset then looked never-configured even after a relaunch.
 *
 * A missing or unreadable file keeps the previous value: a transient read
 * failure must not wipe the agent's identity mid-run (loadConfig already
 * returns null for a parse error, so a torn concurrent write is safe here).
 */
export function reloadConfig(previous: AgentConfig): AgentConfig {
  return loadConfig() ?? previous;
}

export function saveConfig(config: AgentConfig): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  try {
    chmodSync(CONFIG_PATH, 0o600);
  } catch {
    /* best-effort — Windows ACLs differ; the file lives under the user profile */
  }
}

/** Remove the saved config (e.g. after the token is revoked) so the agent re-pairs. */
export function clearConfig(): void {
  try {
    if (existsSync(CONFIG_PATH)) rmSync(CONFIG_PATH);
  } catch {
    /* best-effort */
  }
}

/** This PC's stable device id — generated once, persisted separately from the
 *  pair config so unpairing does not mint a new row on re-pair. */
const DEVICE_ID_PATH = join(CONFIG_DIR, 'device-id');

export function getDeviceId(): string {
  try {
    if (existsSync(DEVICE_ID_PATH)) {
      const existing = readFileSync(DEVICE_ID_PATH, 'utf8').trim();
      if (/^[A-Za-z0-9-]{8,64}$/.test(existing)) return existing;
    }
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
    const fresh = randomUUID();
    writeFileSync(DEVICE_ID_PATH, fresh + '\n', { mode: 0o600 });
    try { chmodSync(DEVICE_ID_PATH, 0o600); } catch { /* best-effort */ }
    return fresh;
  } catch {
    return randomUUID();
  }
}
