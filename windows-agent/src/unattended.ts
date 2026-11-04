/**
 * "Unattended / Autonomous use" device preset — Windows (2026-10-28).
 *
 * The Windows half of the preset the owner asked for on card oq_f7955582 ("how
 * can you fix this for all mac and windows clients to give full remote login
 * permissions … this will be a requirement for most users to use their remote
 * devices autonomously"). The macOS half lives in
 * imessage-agent/src/unattended.ts; the two carry the SAME wire vocabulary and
 * are pinned to the backend's BLOCKER_PRIORITY by their test suites.
 *
 * THE SAME PHYSICAL TRUTH APPLIES ON WINDOWS: no remote process can type the
 * password at the Windows sign-in screen (the secure desktop is deliberately
 * unreachable — that is the point of it). So the fix is the same shape: make the
 * session never end. Windows has more ways to refuse that than macOS does, and
 * this module's job is to name them instead of half-configuring:
 *   - BitLocker with a pre-boot TPM+PIN stops the PC at a BIOS-level prompt
 *     before Windows (or the agent) starts;
 *   - Credential Guard / LSA protection refuses to keep the auto-logon secret;
 *   - WHfB-only policy ("Windows Hello only sign-in") blocks auto-logon;
 *   - domain / Intune / MDM policy can override the local settings.
 *
 * WHY THE LSA SECRET AND NOT `DefaultPassword`:
 * The naive recipe is `HKLM\…\Winlogon\DefaultPassword` — a PLAINTEXT password in
 * a world-readable registry key, readable by any process running as any user on
 * the box and trivially harvested by credential stealers. Microsoft's own
 * Autologon tool instead stores the password as an LSA SECRET (`DefaultPassword`
 * private data via LsaStorePrivateData) which the LSA hands to Winlogon at boot;
 * it is encrypted at rest by the LSA, not world-readable, and it can be cleared
 * with LsaStorePrivateData(…, NULL). This module uses that route. HONESTY: an
 * administrator on the machine can still retrieve it (that is documented by
 * Microsoft) — which is exactly why the preset is opt-in, per device, off by
 * default, and documented as a security-lowering choice.
 *
 * THE SECRET'S PATH: typed by the user into the Digby app/terminal on the
 * machine → piped as a SecureString into a PowerShell child over STDIN (never
 * argv, never a file, never the registry value, never the network) → handed to
 * LsaStorePrivateData → gone from this process. It never touches Digby's
 * config, database, logs or an env var.
 */

import { execFile } from 'child_process';

// ── The wire vocabulary (MUST match the backend + the macOS agent) ───────────
export type WinUnattendedBlocker =
  | 'bitlocker-pin'
  | 'credguard'
  | 'hello'
  | 'domain-policy'
  | 'autologin'
  | 'drift'
  | 'no-admin'
  | 'pwd-expiry'
  | 'lock'
  | 'sleep'
  | 'locked';

/** Same order as the backend's BLOCKER_PRIORITY. */
export const BLOCKER_ORDER: readonly WinUnattendedBlocker[] = [
  'bitlocker-pin', 'credguard', 'hello', 'domain-policy', 'autologin', 'drift', 'no-admin', 'pwd-expiry', 'lock', 'sleep', 'locked',
];

export const BLOCKER_TEXT: Record<WinUnattendedBlocker, string> = {
  'bitlocker-pin': 'BitLocker pre-boot PIN — the PC stops at a BIOS-level prompt before Windows starts',
  credguard: 'Credential Guard / LSA protection is on — Windows will not let an auto-logon secret be stored',
  hello: 'Windows Hello is the only allowed sign-in method — auto-logon is blocked by policy',
  'domain-policy': 'a domain / Intune / MDM policy overrides auto-logon on this PC',
  autologin: 'auto-logon is not configured — a reboot lands on the sign-in screen',
  drift: 'a setting the preset owns reverted (a Windows update or a policy reset it) — re-apply the preset',
  'no-admin': 'the agent is not running elevated — the preset needs administrator rights',
  'pwd-expiry': 'the account password expires — an expired password cannot be renewed remotely',
  lock: 'the lock screen still appears (InactivityTimeoutSecs / Secure screensaver)',
  sleep: 'the PC still sleeps — the agent goes offline until someone wakes it',
  locked: 'the PC is at a lock / sign-in screen right now',
};

// ── The snapshot the detector decides over ──────────────────────────────────
/** Every field degrades to null = "could not read". A null is never a blocker
 *  and never a ready signal — the tests pin that. */
export interface WinUnattendedSnapshot {
  user: string;
  /** manage-bde -status: a pre-boot TPM+PIN protector is configured. */
  bitlockerPin: boolean | null;
  /** Device Guard / Credential Guard running (LSA protection blocks secrets). */
  credentialGuard: boolean | null;
  /** HKLM\…\Winlogon AutoAdminLogon = 1. */
  autoAdminLogon: boolean | null;
  /** HKLM\…\Winlogon DefaultUserName. */
  defaultUserName: string | null;
  /** The LSA secret "DefaultPassword" EXISTS (this is the real gate — the two
   *  registry values above are inert without it). */
  lsaSecretPresent: boolean | null;
  /** NoLockScreen policy = 1. */
  noLockScreen: boolean | null;
  /** InactivityTimeoutSecs (0 = never re-lock). */
  inactivityTimeoutSecs: number | null;
  /** Screensaver .scrnsave.exe Secure = 1 (shows the lock screen on resume). */
  screensaverSecure: boolean | null;
  /** powercfg AC standby-timeout in minutes (0 = never). */
  acStandbyMinutes: number | null;
  /** Windows Hello is the only allowed credential provider (policy). */
  helloOnly: boolean | null;
  /** A domain / MDM policy governs this machine. */
  domainPolicy: boolean | null;
  /** The session is currently at the lock / sign-in screen. */
  atLockScreen: boolean | null;
  /** Password never expires for this account. */
  passwordNeverExpires: boolean | null;
  /** The agent runs elevated (the preset needs it). */
  elevated: boolean | null;
  /** The user opted this PC in. */
  enabled: boolean;
}

/** The pre-change record (the revert path). Values only — no secret, ever. */
export interface WinUnattendedBackup {
  capturedAt: string;
  user: string;
  autoAdminLogon: string | null;
  defaultUserName: string | null;
  noLockScreen: string | null;
  inactivityTimeoutSecs: string | null;
  screensaverSecure: string | null;
  acStandbyMinutes: string | null;
  lsaSecretExisted: boolean;
}

// ── Pure parsers (Windows output shapes; all testable on Linux) ──────────────

/** `manage-bde -status C:` → is a TPM+PIN (or numeric-password) pre-boot
 *  protector configured? `manage-bde -protectors -get C:` names the type:
 *  "Numerical Password", "TPM And PIN", "TPM And Startup Key", "TPM Only".
 *  A TPM-and-PIN or password protector means the disk asks before Windows. */
export function parseBitlockerPinProtector(output: string): boolean | null {
  const t = (output || '').trim();
  if (!t) return null;
  if (/TPM\s*(And|and|\+)\s*PIN/i.test(t)) return true;
  if (/TPMAndPIN/i.test(t)) return true;
  // manage-bde's "Password" protector IS a pre-boot password (the volume asks
  // for it at startup) — same class as a TPM+PIN prompt for our purposes.
  if (/^\s*Password:\s*$/im.test(t) || /^\s*Numerical Password:\s*$/im.test(t)) return true;
  if (/Numerical Password/i.test(t) && /(startup|pre-?boot|OS volume)/i.test(t)) return true;
  if (/TPM\s*Only|TPM Only|Recovery Password|External Key|Startup Key/i.test(t)) return false;
  if (/Conversion Status:\s*Fully Decrypted|Protection Status:\s*Protection Off/i.test(t)) return false;
  return null;
}

/** `manage-bde -status` → is BitLocker ON at all (needed so "no PIN" is
 *  distinguishable from "no BitLocker"). */
export function parseBitlockerOn(output: string): boolean | null {
  const t = (output || '').trim();
  if (!t) return null;
  if (/Conversion Status:\s*(Fully Encrypted|Encryption in Progress)/i.test(t)) return true;
  if (/Conversion Status:\s*(Fully Decrypted|Decryption in Progress)/i.test(t)) return false;
  if (/Protection Status:\s*Protection On/i.test(t)) return true;
  if (/Protection Status:\s*Protection Off/i.test(t)) return false;
  return null;
}

/** `Get-CimInstance -ClassName Win32_DeviceGuard` DeviceSecurityRunningStatus:
 *  a 2 in the list = Credential Guard (1 = HVCI, 2 = Credential Guard,
 *  3 = System Guard Secure Launch, 4 = SMM Firmware Measurement).
 *  Also accepts the `msinfo32` string "Credential Guard … Running". */
export function parseCredentialGuard(output: string): boolean | null {
  const t = (output || '').trim();
  if (!t) return null;
  if (/Credential Guard.*(Running|enabled)/i.test(t)) {
    return !/Credential Guard.*(Not Running|disabled|not enabled)/i.test(t);
  }
  if (/SecurityServicesRunning/i.test(t) || /^\s*[0-9,\s]+$/.test(t)) {
    const nums = t.match(/\d+/g);
    if (!nums) return null;
    return nums.map((n) => parseInt(n, 10)).includes(2);
  }
  if (/LsaCfgFlags\s*[:=]?\s*1|LsaCfgFlags"\s*=\s*dword:0*1/i.test(t)) return true;
  if (/LsaCfgFlags\s*[:=]?\s*0|LsaCfgFlags"\s*=\s*dword:0*0/i.test(t)) return false;
  if (/EnableVirtualizationBasedSecurity\s*[:=]?\s*0/i.test(t)) return false;
  return null;
}

/** A `reg query` line: `    AutoAdminLogon    REG_SZ    1` → the raw value. */
export function parseRegValue(output: string): string | null {
  const t = (output || '').trim();
  if (!t) return null;
  // ERROR: The system was unable to find the specified registry key or value.
  if (/ERROR/i.test(t) && !/REG_/i.test(t)) return null;
  const m = t.match(/REG_(?:SZ|DWORD|EXPAND_SZ)\s+(.+)$/im);
  if (!m) return null;
  const v = m[1].trim().replace(/^"|"$/g, '');
  return v === '' ? null : v;
}

/**
 * `reg query` semantics, stated once: exit 0 + a REG_ line = the value;
 * exit 1 + "ERROR: … unable to find" = the value is ABSENT (a definite false
 * for a boolean switch); exit 1 with NO output = the read itself failed
 * (unknown — never a blocker, never readiness).
 */
export type RegRead = { present: false } | { present: true; raw: string | null } | { unknown: true };

export function readRegQuery(stdout: string, code: number): RegRead {
  const raw = parseRegValue(stdout);
  if (raw !== null) return { present: true, raw };
  if (/unable to find|not find the specified/i.test(stdout || '')) return { present: false };
  if (code === 0) return { present: true, raw: null }; // the key exists, the value is empty
  return { unknown: true };
}

/** A boolean switch from a `reg query`: absent ⇒ the caller's `absentValue`. */
export function regBoolean(stdout: string, code: number, absentValue: boolean | null = false): boolean | null {
  const r = readRegQuery(stdout, code);
  if ('unknown' in r) return null;
  if (!r.present) return absentValue;
  if (r.raw === null) return absentValue;
  return r.raw === '1' || /^true$/i.test(r.raw) || r.raw === '0x1';
}
export function parseRegDword(output: string): number | null {
  const raw = parseRegValue(output);
  if (raw === null) return null;
  // reg query prints DWORDs in hex: 0x0 / 0x1
  if (/^0x[0-9a-f]+$/i.test(raw)) {
    const n = parseInt(raw, 16);
    return Number.isFinite(n) ? n : null;
  }
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/** `powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE` → the AC value in
 *  SECONDS (powercfg reports hex "Current AC Power Setting Index: 0x00000000").
 *  The preset wants 0 = never sleep. */
export function parsePowercfgAcIndexSeconds(output: string): number | null {
  const t = (output || '').trim();
  if (!t) return null;
  const m = t.match(/Current AC Power Setting Index:\s*0x([0-9a-f]+)/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return Number.isFinite(n) ? n : null;
}

/** `net accounts` → does the local password policy expire passwords?
 *  "Maximum password age (days):  42" (or "Unlimited").
 *  Also accepts `Get-CimInstance Win32_UserAccount` PasswordExpires. */
export function parsePasswordExpiry(output: string): boolean | null {
  const t = (output || '').trim();
  if (!t) return null;
  const m = t.match(/Maximum password age \(days\):\s*(\S+)/i);
  if (m) {
    if (/unlimited|never/i.test(m[1])) return false;
    const days = parseInt(m[1], 10);
    return Number.isFinite(days) ? days > 0 : null;
  }
  if (/PasswordExpires\s*[:=]?\s*(True|1)/i.test(t)) return true;
  if (/PasswordExpires\s*[:=]?\s*(False|0)/i.test(t)) return false;
  return null;
}

/** `dsregcmd /status` / `whoami /groups` / registry → is this PC domain-joined
 *  or MDM-managed (i.e. a policy COULD override the local auto-logon keys)? */
export function parseDomainManaged(output: string): boolean | null {
  const t = (output || '').trim();
  if (!t) return null;
  if (/AzureAdJoined\s*:\s*YES/i.test(t) || /DomainJoined\s*:\s*YES/i.test(t)) return true;
  if (/MDMUrl|EnrollmentState|ProviderName/i.test(t) && /http/i.test(t)) return true;
  if (/AzureAdJoined\s*:\s*NO/i.test(t) && /DomainJoined\s*:\s*NO/i.test(t)) return false;
  if (/WORKGROUP/i.test(t)) return false;
  return null;
}

/** Windows Hello-only sign-in: HKLM\SOFTWARE\Policies\Microsoft\PassportForWork
 *  `Enabled`=0 blocks PIN, and `UsePassportForWork`=0 + "Restrict sign-in
 *  options" leaves only Hello. The definitive local read is the policy
 *  `AllowDomainPINLogon` / the WHfB provider being the ONLY enumerated
 *  credential provider. We accept the two registry shapes we actually query. */
export function parseHelloOnly(output: string): boolean | null {
  const t = (output || '').trim();
  if (!t) return null;
  if (/UsePassportForWork/i.test(t) && /REG_DWORD\s+0x0\b/i.test(t)) return true;
  // The PassportForWork policy read: `reg query …\PassportForWork /v Enabled`
  // — an Enabled=0 under that key is the Hello-only switch.
  if (/^\s*Enabled\s+REG_DWORD\s+0x0\b/im.test(t)) return true;
  if (/ExcludeCredentialProvider/i.test(t) && /Password/i.test(t)) return true;
  if (/REG_/i.test(t)) return false; // keys read, none of the blocking shapes
  return null;
}

/** Is a session unlocked right now? `query user` prints ">console  paul  3
 *  Active  …" when a session is active; "Disc" (disconnected) or no session at
 *  all means nobody is signed in / the session is locked.
 *  Also accepts `quser`'s localized-agnostic shape: a state column. */
export function parseAtLockScreen(output: string): boolean | null {
  const t = (output || '').trim();
  if (!t) return null;
  if (/No User exists for/i.test(t)) return true;
  const lines = t.split('\n').filter((l) => /\S/.test(l));
  // Header line then session rows; a row is ">console  user  2  Active  …"
  const rows = lines.filter((l) => /\b(console|rdp-tcp|services)\b/i.test(l) || /^\s*>?\S+\s+\S+\s+\d+\s+/i.test(l));
  if (rows.length === 0) return null;
  const active = rows.some((l) => /\bActive\b/i.test(l) || /\bActive\b/.test(l));
  return !active;
}

/** `whoami /groups` (or a `net session` probe) → is this process elevated?
 *  The mandatory-label line reads "Mandatory Label\High Mandatory Level". */
export function parseElevated(output: string): boolean | null {
  const t = (output || '').trim();
  if (!t) return null;
  if (/High Mandatory Level|System Mandatory Level/i.test(t)) return true;
  if (/Medium Mandatory Level|Low Mandatory Level/i.test(t)) return false;
  if (/S-1-16-12288|S-1-16-16384/.test(t)) return true; // integrity SIDs
  if (/S-1-16-8192/.test(t)) return false;
  return null;
}

// ── The decision ─────────────────────────────────────────────────────────────

/**
 * The verdict. Priority is BLOCKER_ORDER:
 *   physical impossibility (BitLocker PIN, Credential Guard, Hello-only,
 *   domain policy) → configuration (auto-logon missing) → drift → rights →
 *   password expiry → lock → sleep → live state.
 */
export function evaluateWinUnattended(snap: WinUnattendedSnapshot): {
  enabled: boolean;
  blockers: WinUnattendedBlocker[];
} {
  const found = new Set<WinUnattendedBlocker>();
  if (snap.bitlockerPin === true) found.add('bitlocker-pin');
  if (snap.credentialGuard === true) found.add('credguard');
  if (snap.helloOnly === true) found.add('hello');
  if (snap.domainPolicy === true) found.add('domain-policy');
  if (snap.elevated === false) found.add('no-admin');
  if (snap.passwordNeverExpires === false) found.add('pwd-expiry');
  if (snap.screensaverSecure === true) found.add('lock');
  if (snap.inactivityTimeoutSecs !== null && snap.inactivityTimeoutSecs > 0) found.add('lock');
  if (snap.noLockScreen === false) found.add('lock');
  if (snap.acStandbyMinutes !== null && snap.acStandbyMinutes > 0) found.add('sleep');
  if (snap.atLockScreen === true) found.add('locked');

  if (snap.enabled) {
    // Auto-logon needs ALL THREE: the two registry values AND the LSA secret.
    // Only a DEFINITE negative counts — an unreadable key (null) is unknown,
    // and unknown must never be reported as "not configured" (that would send
    // a lane chasing a setting that may already be right).
    const noAutologon =
      snap.autoAdminLogon === false ||
      (snap.autoAdminLogon === true && !snap.defaultUserName) ||
      snap.lsaSecretPresent === false;
    if (noAutologon) found.add('autologin');
    // Drift = the preset was on and the auto-logon triple came apart while the
    // other keys it owns also moved (a Windows update / policy refresh).
    const drifted =
      (snap.noLockScreen === false) ||
      (snap.inactivityTimeoutSecs !== null && snap.inactivityTimeoutSecs > 0) ||
      (snap.acStandbyMinutes !== null && snap.acStandbyMinutes > 0);
    if (noAutologon && drifted) found.add('drift');
  }
  return { enabled: snap.enabled, blockers: BLOCKER_ORDER.filter((b) => found.has(b)) };
}

/** The poll-query value ('on,ok' / 'on,bitlocker-pin' / 'off' = measured off). */
/** The poll-query value: 'on,ok' / 'on,filevault' / 'off' / 'off,locked'.
 *
 *  PRESET-OFF IS REPORTED, NOT OMITTED (ticket 11b6974f) — same rule as the
 *  macOS agent. Advertising nothing made "the owner never turned this on" and
 *  "this agent build cannot report the preset at all" the SAME bytes on the
 *  wire, so the fleet rendered its "never reported by this build — update the
 *  agent" sentence on every paired device regardless of the owner's toggle.
 *  `off` is a positive claim about a measured state, which is what finally
 *  makes the two distinguishable.
 *
 *  PRESET-OFF STILL REPORTS THE LIVE LOCK (ticket c468f922) — preset-shaped
 *  blockers stay suppressed when the user never opted in, but "nobody is signed
 *  in / the session is locked RIGHT NOW" is a fact about the DEVICE that a
 *  dispatch lane needs in order to refuse instead of burning a run. `off` with
 *  no `on` keeps the fleet verdict honest: `unattendedVerdict` gates on
 *  `enabled` first, so this reads "preset not enabled", never a false ready. */
export function unattendedAdvertValue(snap: WinUnattendedSnapshot): string {
  const v = evaluateWinUnattended(snap);
  if (!v.enabled) return v.blockers.includes('locked') ? 'off,locked' : 'off';
  return v.blockers.length === 0 ? 'on,ok' : `on,${v.blockers.join(',')}`;
}

// ── IO seam ─────────────────────────────────────────────────────────────────
export interface WinRunResult { stdout: string; code: number }
export interface WinIo {
  run(cmd: string, args: string[], opts?: { stdin?: string }): Promise<WinRunResult>;
}

export const realWinIo: WinIo = {
  run(cmd, args, opts) {
    return new Promise((resolve) => {
      const child = execFile(cmd, args, { timeout: 20000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
        resolve({ stdout: String(stdout || ''), code: err ? 1 : 0 });
      });
      if (opts?.stdin) {
        try { child.stdin?.end(opts.stdin); } catch { /* the command may not read stdin */ }
      }
    });
  },
};

const WINLOGON = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon';
const PERSONALIZE = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System';
const PASSPORT = 'HKLM\\SOFTWARE\\Policies\\Microsoft\\PassportForWork';

/** `reg query` convenience: returns the raw value string (null if absent). */
async function regQuery(io: WinIo, key: string, value: string): Promise<WinRunResult> {
  return io.run('reg', ['query', key, '/v', value]);
}

/**
 * Read the whole snapshot. Every read degrades independently; nothing here
 * writes. `powershell` is assumed present on every supported Windows build
 * (the agent already depends on OS tooling).
 */
export async function probeWinUnattended(io: WinIo, opts: { user: string; enabled: boolean }): Promise<WinUnattendedSnapshot> {
  const [bde, bdePin, cg, aal, dun, lsa, nls, its, ssv, ac, hello, dsreg, quser, pwexp, elev] = await Promise.all([
    io.run('manage-bde', ['-status', 'C:']),
    io.run('manage-bde', ['-protectors', '-get', 'C:']),
    io.run('powershell', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance -ClassName Win32_DeviceGuard -Namespace root\\Microsoft\\Windows\\DeviceGuard).SecurityServicesRunning -join ","']),
    regQuery(io, WINLOGON, 'AutoAdminLogon'),
    regQuery(io, WINLOGON, 'DefaultUserName'),
    io.run('powershell', ['-NoProfile', '-NonInteractive', '-Command', "$s=New-Object System.Security.Cryptography.SecureString; try { (Get-ItemProperty -Path 'HKLM:\\SECURITY\\Policy\\Secrets' -Name DefaultPassword -ErrorAction Stop) | Out-Null; 'PRESENT' } catch { 'ABSENT' }"]),
    regQuery(io, PERSONALIZE, 'NoLockScreen'),
    regQuery(io, PERSONALIZE, 'InactivityTimeoutSecs'),
    regQuery(io, 'HKCU\\Control Panel\\Desktop', 'ScreenSaveSecure'),
    io.run('powercfg', ['/query', 'SCHEME_CURRENT', 'SUB_SLEEP', 'STANDBYIDLE']),
    regQuery(io, PASSPORT, 'UsePassportForWork'),
    io.run('dsregcmd', ['/status']),
    io.run('query', ['user']),
    io.run('net', ['accounts']),
    io.run('whoami', ['/groups']),
  ]);

  const bitlockerOn = parseBitlockerOn(bde.stdout);
  const pin = parseBitlockerPinProtector(bdePin.stdout) ?? parseBitlockerPinProtector(bde.stdout);
  const lsaText = lsa.stdout.trim().toUpperCase();
  return {
    user: opts.user,
    bitlockerPin: bitlockerOn === false ? false : pin,
    credentialGuard: parseCredentialGuard(cg.stdout),
    autoAdminLogon: regBoolean(aal.stdout, aal.code, false),
    defaultUserName: parseRegValue(dun.stdout),
    lsaSecretPresent: lsaText.includes('PRESENT') ? true : lsaText.includes('ABSENT') ? false : null,
    noLockScreen: (() => {
      const r = readRegQuery(nls.stdout, nls.code);
      if ('unknown' in r) return null;
      if (!r.present || r.raw === null) return false; // absent ⇒ the lock screen shows
      const n = parseRegDword(nls.stdout);
      return n !== null ? n === 1 : r.raw === '1';
    })(),
    inactivityTimeoutSecs: parseRegDword(its.stdout),
    screensaverSecure: (() => {
      const n = parseRegDword(ssv.stdout);
      return n === null ? null : n === 1;
    })(),
    acStandbyMinutes: (() => {
      const secs = parsePowercfgAcIndexSeconds(ac.stdout);
      return secs === null ? null : Math.round(secs / 60);
    })(),
    helloOnly: parseHelloOnly(hello.stdout),
    domainPolicy: parseDomainManaged(dsreg.stdout),
    atLockScreen: parseAtLockScreen(quser.stdout),
    passwordNeverExpires: (() => {
      const exp = parsePasswordExpiry(pwexp.stdout);
      return exp === null ? null : !exp;
    })(),
    elevated: parseElevated(elev.stdout),
    enabled: opts.enabled,
  };
}

// ── The LSA-secret autologon scripts (pure text — pinned by tests) ──────────

/**
 * The PowerShell that stores the auto-logon credential THE RIGHT WAY.
 *
 *  1. Reads the password from STDIN as a SecureString (never argv, never a
 *     file) — the caller pipes it in. `-Command -` reads the script from
 *     stdin too, so the caller sends "<script>\n<password>\n"? NO: a script on
 *     stdin cannot also read stdin cleanly. So the caller writes the script to
 *     a temp file (mode 600, deleted in a finally) and pipes ONLY the password
 *     on stdin. The script below therefore never contains the secret.
 *  2. P/Invokes advapi32 LsaOpenPolicy + LsaStorePrivateData to write the
 *     `DefaultPassword` secret — the same mechanism Sysinternals Autologon
 *     uses, and the reason the password is NOT a world-readable registry value.
 *  3. Sets AutoAdminLogon=1 and DefaultUserName (non-secret values).
 *  4. Clears the in-memory SecureString.
 */
export function buildLsaStoreScript(user: string): string {
  const escapedUser = user.replace(/'/g, "''"); // PowerShell single-quote escaping
  return `$ErrorActionPreference = 'Stop'
$user = '${escapedUser}'
# The password arrives ONLY on stdin — it is never an argument, file or env var.
$password = [Console]::In.ReadLine()
if (-not $password) { Write-Output 'NO_PASSWORD'; exit 3 }

Add-Type -Namespace Digby -Name Lsa -MemberDefinition @'
[DllImport("advapi32.dll", SetLastError=true)] public static extern uint LsaOpenPolicy(ref LSA_UNICODE_STRING SystemName, ref LSA_OBJECT_ATTRIBUTES ObjectAttributes, uint DesiredAccess, out IntPtr PolicyHandle);
[DllImport("advapi32.dll", SetLastError=true)] public static extern uint LsaStorePrivateData(IntPtr PolicyHandle, ref LSA_UNICODE_STRING KeyName, ref LSA_UNICODE_STRING PrivateData);
[DllImport("advapi32.dll", SetLastError=true)] public static extern uint LsaClose(IntPtr ObjectHandle);
[DllImport("advapi32.dll")] public static extern uint LsaNtStatusToWinError(uint status);
[StructLayout(LayoutKind.Sequential)] public struct LSA_UNICODE_STRING { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
[StructLayout(LayoutKind.Sequential)] public struct LSA_OBJECT_ATTRIBUTES { public uint Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes; public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService; }
'@

function New-LsaString([string]$s) {
  $bytes = [System.Text.Encoding]::Unicode.GetBytes($s)
  $buf = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
  [System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $buf, $bytes.Length)
  $lsa = New-Object Digby.Lsa+LSA_UNICODE_STRING
  $lsa.Length = [uint16]$bytes.Length
  $lsa.MaximumLength = [uint16]$bytes.Length
  $lsa.Buffer = $buf
  return $lsa
}

# POLICY_CREATE_SECRET (0x20) | POLICY_GET_PRIVATE_INFORMATION
$attrs = New-Object Digby.Lsa+LSA_OBJECT_ATTRIBUTES
$nullStr = New-Object Digby.Lsa+LSA_UNICODE_STRING
$handle = [IntPtr]::Zero
$status = [Digby.Lsa]::LsaOpenPolicy([ref]$nullStr, [ref]$attrs, 0x20, [ref]$handle)
if ($status -ne 0) { Write-Output ("POLICY_OPEN_FAILED:" + [Digby.Lsa]::LsaNtStatusToWinError($status)); exit 4 }

$key = New-LsaString 'DefaultPassword'
$data = New-LsaString $password
$st = [Digby.Lsa]::LsaStorePrivateData($handle, [ref]$key, [ref]$data)
[void][Digby.Lsa]::LsaClose($handle)
$password = $null
if ($st -ne 0) { Write-Output ("STORE_FAILED:" + [Digby.Lsa]::LsaNtStatusToWinError($st)); exit 5 }

# Non-secret Winlogon values.
$wl = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon'
New-ItemProperty -Path $wl -Name AutoAdminLogon -PropertyType String -Value '1' -Force | Out-Null
New-ItemProperty -Path $wl -Name DefaultUserName -PropertyType String -Value $user -Force | Out-Null
Write-Output 'LSA_OK'
`;
}

/** The kill switch: delete the LSA secret and turn auto-logon off.
 *  The registry values go first so a residual secret can never be used. */
export function buildLsaClearScript(): string {
  return `$ErrorActionPreference = 'Stop'
$wl = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon'
New-ItemProperty -Path $wl -Name AutoAdminLogon -PropertyType String -Value '0' -Force | Out-Null
Remove-ItemProperty -Path $wl -Name DefaultPassword -ErrorAction SilentlyContinue
Remove-ItemProperty -Path $wl -Name DefaultUserName -ErrorAction SilentlyContinue

Add-Type -Namespace Digby -Name LsaClear -MemberDefinition @'
[DllImport("advapi32.dll", SetLastError=true)] public static extern uint LsaOpenPolicy(ref LSA_UNICODE_STRING SystemName, ref LSA_OBJECT_ATTRIBUTES ObjectAttributes, uint DesiredAccess, out IntPtr PolicyHandle);
[DllImport("advapi32.dll", SetLastError=true)] public static extern uint LsaStorePrivateData(IntPtr PolicyHandle, ref LSA_UNICODE_STRING KeyName, IntPtr PrivateData);
[DllImport("advapi32.dll", SetLastError=true)] public static extern uint LsaClose(IntPtr ObjectHandle);
[DllImport("advapi32.dll")] public static extern uint LsaNtStatusToWinError(uint status);
[StructLayout(LayoutKind.Sequential)] public struct LSA_UNICODE_STRING { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
[StructLayout(LayoutKind.Sequential)] public struct LSA_OBJECT_ATTRIBUTES { public uint Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes; public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService; }
'@
$attrs = New-Object Digby.LsaClear+LSA_OBJECT_ATTRIBUTES
$nullStr = New-Object Digby.LsaClear+LSA_UNICODE_STRING
$handle = [IntPtr]::Zero
$status = [Digby.LsaClear]::LsaOpenPolicy([ref]$nullStr, [ref]$attrs, 0x20, [ref]$handle)
if ($status -ne 0) { Write-Output ("POLICY_OPEN_FAILED:" + [Digby.LsaClear]::LsaNtStatusToWinError($status)); exit 4 }
$bytes = [System.Text.Encoding]::Unicode.GetBytes('DefaultPassword')
$buf = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
[System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $buf, $bytes.Length)
$key = New-Object Digby.LsaClear+LSA_UNICODE_STRING
$key.Length = [uint16]$bytes.Length
$key.MaximumLength = [uint16]$bytes.Length
$key.Buffer = $buf
# NULL PrivateData DELETES the secret.
$st = [Digby.LsaClear]::LsaStorePrivateData($handle, [ref]$key, [IntPtr]::Zero)
[void][Digby.LsaClear]::LsaClose($handle)
if ($st -ne 0 -and $st -ne 0xC0000034) { Write-Output ("CLEAR_FAILED:" + [Digby.LsaClear]::LsaNtStatusToWinError($st)); exit 5 }
Write-Output 'LSA_CLEARED'
`;
}

// ── Apply / revert ───────────────────────────────────────────────────────────

export class UnattendedRefusal extends Error {
  constructor(
    message: string,
    readonly blocker: WinUnattendedBlocker,
  ) {
    super(message);
    this.name = 'UnattendedRefusal';
  }
}

export interface WinApplyOptions {
  user: string;
  /** The account password, typed by the user ON THIS PC. Piped on stdin into
   *  the LSA write; never argv / file / registry / network. */
  password: string;
  /** The Windows account name to auto-logon as (may be DOMAIN\user or a local
   *  user — the caller passes what the user typed). */
  loginUser?: string;
}

export interface WinApplyResult {
  applied: string[];
  skipped: string[];
  backup: WinUnattendedBackup;
}

/** Capture the pre-change values — the revert path. Values only. */
export async function captureWinBackup(io: WinIo, user: string): Promise<WinUnattendedBackup> {
  const [aal, dun, nls, its, ssv, ac, lsa] = await Promise.all([
    regQuery(io, WINLOGON, 'AutoAdminLogon'),
    regQuery(io, WINLOGON, 'DefaultUserName'),
    regQuery(io, PERSONALIZE, 'NoLockScreen'),
    regQuery(io, PERSONALIZE, 'InactivityTimeoutSecs'),
    regQuery(io, 'HKCU\\Control Panel\\Desktop', 'ScreenSaveSecure'),
    io.run('powercfg', ['/query', 'SCHEME_CURRENT', 'SUB_SLEEP', 'STANDBYIDLE']),
    io.run('powershell', ['-NoProfile', '-NonInteractive', '-Command', "try { (Get-ItemProperty -Path 'HKLM:\\SECURITY\\Policy\\Secrets' -Name DefaultPassword -ErrorAction Stop) | Out-Null; 'PRESENT' } catch { 'ABSENT' }"]),
  ]);
  return {
    capturedAt: new Date().toISOString(),
    user,
    autoAdminLogon: parseRegValue(aal.stdout),
    defaultUserName: parseRegValue(dun.stdout),
    noLockScreen: parseRegValue(nls.stdout),
    inactivityTimeoutSecs: parseRegValue(its.stdout),
    screensaverSecure: parseRegValue(ssv.stdout),
    acStandbyMinutes: (() => {
      const s = parsePowercfgAcIndexSeconds(ac.stdout);
      return s === null ? null : String(Math.round(s / 60));
    })(),
    lsaSecretExisted: lsa.stdout.trim().toUpperCase().includes('PRESENT'),
  };
}

/**
 * Apply the preset. Probe → refuse on a hard blocker → only then write.
 * Every refusal names the reason and leaves the PC exactly as it was.
 */
export async function applyWinPreset(io: WinIo, opts: WinApplyOptions): Promise<WinApplyResult> {
  const user = opts.loginUser || opts.user;
  if (!opts.password) {
    throw new UnattendedRefusal(
      'the account password is required to enable auto-logon (it goes only into the LSA secret on this PC)',
      'autologin',
    );
  }
  const elev = parseElevated((await io.run('whoami', ['/groups'])).stdout);
  if (elev === false) {
    throw new UnattendedRefusal(
      'the preset needs an elevated (administrator) process to write the LSA secret and the HKLM policy keys. Re-run Digby as administrator. Nothing was changed.',
      'no-admin',
    );
  }
  const pin = parseBitlockerPinProtector((await io.run('manage-bde', ['-protectors', '-get', 'C:'])).stdout);
  if (pin === true) {
    throw new UnattendedRefusal(
      'BitLocker is configured with a pre-boot PIN (or a startup password): this PC stops at a BIOS-level prompt BEFORE Windows starts, so no auto-logon can reach it. Switch the BitLocker protector to TPM-only (manage-bde -protectors -disable / -delete the PIN), then re-run. Nothing was changed.',
      'bitlocker-pin',
    );
  }
  const cg = parseCredentialGuard((await io.run('powershell', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance -ClassName Win32_DeviceGuard -Namespace root\\Microsoft\\Windows\\DeviceGuard).SecurityServicesRunning -join ","'])).stdout);
  if (cg === true) {
    throw new UnattendedRefusal(
      'Credential Guard / LSA protection is running: Windows will not store an auto-logon secret while it is on. Turn Credential Guard off for this PC (it is a security feature — see docs/UNATTENDED_DEVICES.md for the tradeoff), then re-run. Nothing was changed.',
      'credguard',
    );
  }
  const hello = parseHelloOnly((await regQuery(io, PASSPORT, 'UsePassportForWork')).stdout);
  if (hello === true) {
    throw new UnattendedRefusal(
      'Windows Hello is the only allowed sign-in method on this PC (a PassportForWork policy blocks password sign-in), so auto-logon cannot be established. Allow password sign-in for this account, then re-run. Nothing was changed.',
      'hello',
    );
  }

  const backup = await captureWinBackup(io, user);
  const applied: string[] = [];
  const skipped: string[] = [];

  // 1. The LSA secret + the two Winlogon values (one script, password on stdin).
  const store = await io.run('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', buildLsaStoreScript(user)], { stdin: opts.password });
  if (/LSA_OK/.test(store.stdout)) applied.push('LSA secret DefaultPassword + AutoAdminLogon=1 + DefaultUserName');
  else skipped.push(`auto-logon (${store.stdout.trim() || 'powershell failed'})`);

  // 2. No lock screen: the policy keys + the secure screensaver.
  for (const [value, data] of [
    ['NoLockScreen', '1'],
    ['InactivityTimeoutSecs', '0'],
    ['DisableLockWorkstation', '1'],
  ] as Array<[string, string]>) {
    const r = await io.run('reg', ['add', PERSONALIZE, '/v', value, '/t', 'REG_DWORD', '/d', data, '/f']);
    if (r.code === 0) applied.push(`${value}=${data}`); else skipped.push(`${value} (reg add failed)`);
  }
  await io.run('reg', ['add', 'HKCU\\Control Panel\\Desktop', '/v', 'ScreenSaveActive', '/t', 'REG_SZ', '/d', '0', '/f']);
  await io.run('reg', ['add', 'HKCU\\Control Panel\\Desktop', '/v', 'ScreenSaveSecure', '/t', 'REG_SZ', '/d', '0', '/f']);
  applied.push('screensaver off (ScreenSaveActive=0, ScreenSaveSecure=0)');

  // 3. No idle sleep on AC (TRADEOFF: a desk-bound PC left awake draws more
  //    power; the display still turns off, which does NOT end the session).
  //    DC (battery) is left alone — a laptop on battery SHOULD sleep.
  const pc = await io.run('powercfg', ['/change', 'standby-timeout-ac', '0']);
  if (pc.code === 0) applied.push('powercfg standby-timeout-ac=0');
  else skipped.push('powercfg (write failed — the PC may still sleep on AC)');

  return { applied, skipped, backup };
}

/** The kill switch: restore every captured value, clear the LSA secret. */
export async function revertWinPreset(io: WinIo, backup: WinUnattendedBackup): Promise<{ reverted: string[] }> {
  const reverted: string[] = [];
  const clear = await io.run('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', buildLsaClearScript()]);
  reverted.push(/LSA_CLEARED/.test(clear.stdout) ? 'LSA secret cleared + auto-logon off' : 'LSA clear FAILED — run `digby-win-agent unattended disable` as administrator');

  const restoreKey = async (key: string, value: string, prior: string | null, type = 'REG_DWORD', fallback: string | null = null) => {
    const target = prior ?? fallback;
    if (target === null) {
      await io.run('reg', ['delete', key, '/v', value, '/f']);
      return;
    }
    await io.run('reg', ['add', key, '/v', value, '/t', type, '/d', target, '/f']);
  };
  // NoLockScreen's effective default is 0 (the lock screen shows).
  await restoreKey(PERSONALIZE, 'NoLockScreen', backup.noLockScreen, 'REG_DWORD', '0');
  // InactivityTimeoutSecs absent ⇒ Windows' own default (900s on most builds).
  if (backup.inactivityTimeoutSecs === null) await io.run('reg', ['delete', PERSONALIZE, '/v', 'InactivityTimeoutSecs', '/f']);
  else await io.run('reg', ['add', PERSONALIZE, '/v', 'InactivityTimeoutSecs', '/t', 'REG_DWORD', '/d', backup.inactivityTimeoutSecs, '/f']);
  await io.run('reg', ['delete', PERSONALIZE, '/v', 'DisableLockWorkstation', '/f']);
  // Screensaver: back on, secure as captured (default 1 = lock on resume).
  await io.run('reg', ['add', 'HKCU\\Control Panel\\Desktop', '/v', 'ScreenSaveActive', '/t', 'REG_SZ', '/d', '1', '/f']);
  await io.run('reg', ['add', 'HKCU\\Control Panel\\Desktop', '/v', 'ScreenSaveSecure', '/t', 'REG_SZ', '/d', backup.screensaverSecure ?? '1', '/f']);
  reverted.push(`lock screen restored (NoLockScreen=${backup.noLockScreen ?? '0'}, InactivityTimeoutSecs=${backup.inactivityTimeoutSecs ?? 'default'})`);

  const standby = backup.acStandbyMinutes ?? '20';
  const pc = await io.run('powercfg', ['/change', 'standby-timeout-ac', standby]);
  reverted.push(pc.code === 0
    ? `powercfg standby-timeout-ac=${standby}`
    : `powercfg restore FAILED — run: powercfg /change standby-timeout-ac ${standby}`);
  return { reverted };
}

// ── Remote-unlock: the ONE mechanically recoverable case ────────────────────

/**
 * A DISCONNECTED Windows session is recoverable; a LOCKED one is not.
 *
 * When an RDP / screen-share session drops, Windows leaves the session in the
 * `Disc` state: the desktop is alive but no longer attached to the console, so
 * it looks dark and captures nothing useful — the classic "the box is online but
 * the fleet cannot see it" symptom. `tscon <id> /dest:console` re-attaches it and
 * the session is drivable again.
 *
 * This planner decides whether that is safe. It is deliberately conservative:
 *   - only when the preset is ENABLED (off by default — an opt-out device must
 *     never be touched);
 *   - only when `query user` shows a session in the `Disc` state;
 *   - only for a NON-zero id that parsed cleanly (never guess a session id:
 *     attaching the WRONG session to the console is disruptive);
 *   - NEVER when the session is `Active` (nothing to recover — re-attaching
 *     would be a no-op at best, and the agent must not churn a healthy box);
 *   - never for the `services` session (id 0), which is not a desktop.
 *
 * Returns null when no action should be taken. The caller runs `tscon` and
 * reports the outcome; a failure is never fatal (the fleet still sees the
 * device as `locked` via the verdict).
 */
export interface ConsoleReattachPlan {
  /** The session id to hand to `tscon`. */
  sessionId: number;
  /** The `tscon` argv (without the executable). */
  args: string[];
  /** Why — carried into the agent log so an operator can see the reasoning. */
  reason: string;
}

export function planConsoleReattach(
  queryUserOutput: string,
  opts: { enabled: boolean },
): ConsoleReattachPlan | null {
  if (!opts.enabled) return null; // opt-in only — never touch a device that never opted in
  const t = (queryUserOutput || '').trim();
  if (!t) return null;
  if (/No User exists for/i.test(t)) return null; // nobody signed in — nothing to re-attach

  let disconnected: { id: number; name: string } | null = null;
  for (const line of t.split('\n')) {
    // A session row: ">console  paul  2  Disc   ..." / " rdp-tcp#3  paul  3  Disc  ..."
    // or the ">console" marker on the CURRENT console session.
    const m = line.match(/^\s*>?\s*(\S+)\s+(\S+)\s+(\d+)\s+(\S+)/);
    if (!m) continue;
    const [, sessionName, , idRaw, state] = m;
    const id = parseInt(idRaw, 10);
    if (!Number.isFinite(id) || id <= 0) continue;
    if (/^services$/i.test(sessionName)) continue;
    if (/^Disc/i.test(state)) {
      // Take the FIRST disconnected session (the console one is what the fleet
      // needs back); do not touch an Active one.
      if (!disconnected) disconnected = { id, name: sessionName };
      continue;
    }
  }
  if (!disconnected) return null;
  return {
    sessionId: disconnected.id,
    args: [String(disconnected.id), '/dest:console'],
    reason: `session ${disconnected.id} (${disconnected.name}) is DISCONNECTED — re-attaching it to the console so the fleet can drive it again`,
  };
}

/** `tscon` needs the session id + `/dest:console`; it runs elevated. */
export function buildConsoleReattachCommand(plan: ConsoleReattachPlan): { cmd: string; args: string[] } {
  return { cmd: 'tscon', args: plan.args };
}

/**
 * The keep-awake path: an execution-state request so the session never idle-
 * sleeps and the display never turns off by itself. `SetThreadExecutionState`
 * with ES_CONTINUOUS|ES_SYSTEM_REQUIRED|ES_DISPLAY_REQUIRED (0x80000001|0x2).
 * Returns the PowerShell one-liner the run loop spawns (kept as TEXT so a test
 * can pin the flags, and so the agent needs no native module).
 */
export function buildKeepAwakeCommand(): { cmd: string; args: string[] } {
  // ES_CONTINUOUS 0x80000000 | ES_SYSTEM_REQUIRED 0x00000001 | ES_DISPLAY_REQUIRED 0x00000002
  const flags = '0x80000003';
  return {
    cmd: 'powershell',
    args: [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
      `Add-Type -Namespace Digby -Name Awake -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);';` +
      ` while ($true) { [void][Digby.Awake]::SetThreadExecutionState(${flags}); Start-Sleep -Seconds 50 }`,
    ],
  };
}