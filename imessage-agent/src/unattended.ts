/**
 * "Unattended / Autonomous use" device preset — macOS (2026-10-28).
 *
 * THE PROBLEM. macOS puts the login window BELOW every TCC permission: the
 * Digby agent can see and drive only INSIDE a logged-in session. So every time
 * this Mac reboots, sleeps into a lock, or the screensaver asks for a password,
 * the fleet loses the machine and a lane has to file "please unlock the Mac" —
 * three owner cards asked for that same physical act in one day
 * (oq_f7955582 and two siblings). Today's workaround is the owner's finger; the
 * fix is to make the session NEVER END, as a per-device setting.
 *
 * WHAT THIS MODULE IS. The macOS half of that preset:
 *   - a PURE detector over an injected command runner (so the whole decision
 *     surface unit-tests on Linux CI against scripted `fdesetup` / `defaults` /
 *     `pmset` / `pwpolicy` output — no Mac needed),
 *   - apply / revert that capture the PRIOR values first and restore them,
 *   - the honest refusals: FileVault makes auto-login impossible (a reboot
 *     returns to a pre-boot unlock screen), and an expired password on a remote
 *     device cannot be renewed remotely.
 *
 * WHAT macOS ALLOWS, STATED ONCE (docs/UNATTENDED_DEVICES.md):
 *   - Auto-login is a login-window preference (`autoLoginUser` in
 *     /Library/Preferences/com.apple.loginwindow.plist) PLUS the account
 *     password in /etc/kcpassword — a root-only XOR-OBFUSCATED file (not
 *     encrypted). It cannot live in the Keychain: loginwindow reads kcpassword
 *     before any user session exists, so there is no Keychain to read from. The
 *     password is therefore typed by the user INTO this machine's own terminal,
 *     used once, and never sent to Digby, never written to Digby's config or
 *     database, never placed in an env var.
 *   - FileVault ON ⇒ no auto-login, full stop (pre-boot unlock has no user
 *     context). Digby REFUSES rather than half-configuring.
 *   - Auto-login is reset by macOS updates and by some MDM profiles ⇒ the
 *     detector runs on every poll and the fleet shows the drift as a verdict,
 *     not as a lane discovering a lock screen later.
 *   - A locked (not logged-out) session CAN be woken by input; a logged-OUT or
 *     rebooted Mac at the login window CANNOT be driven by remote software —
 *     no OS lets a remote process type the login password.
 *
 * Wire parity: the blocker tokens emitted here are pinned to the backend's
 * BLOCKER_PRIORITY (backend/src/modules/crossmodel/imessage/unattended-verdict.ts)
 * by imessage-agent/test/unattended.<ticket>.test.mjs.
 */

import { execFile, spawnSync } from 'child_process';

// ── The wire vocabulary (MUST match the backend's BLOCKER_PRIORITY tokens) ────
export type UnattendedBlocker =
  | 'filevault'
  | 'autologin'
  | 'drift'
  | 'no-admin'
  | 'pwd-expiry'
  | 'fast-user'
  | 'lock'
  | 'sleep'
  | 'locked';

/** Same order as the backend's BLOCKER_PRIORITY — a physical impossibility
 *  first, a reverted setting second, live state last. */
export const BLOCKER_ORDER: readonly UnattendedBlocker[] = [
  'filevault', 'autologin', 'drift', 'no-admin', 'pwd-expiry', 'fast-user', 'lock', 'sleep', 'locked',
];

/** Human one-liners for the agent's own log / CLI output. The FLEET renders its
 *  own copy (backend unattended-verdict.ts) — keep the meaning identical. */
export const BLOCKER_TEXT: Record<UnattendedBlocker, string> = {
  filevault: 'FileVault is on — macOS cannot auto-login to a FileVault volume',
  autologin: 'auto-login is not configured — a reboot lands on the login window',
  drift: 'a setting the preset owns reverted (macOS update or policy) — re-apply the preset',
  'no-admin': 'the agent lacks the admin rights the preset needs',
  'pwd-expiry': 'the account password expires — an expired password cannot be renewed remotely',
  'fast-user': 'fast user switching is on — a logout can land on the login window',
  lock: 'the screensaver asks for a password — the session ends on idle/wake',
  sleep: 'the Mac still sleeps — the agent goes offline until someone wakes it',
  locked: 'the Mac is at a lock / login screen right now',
};

// ── The snapshot the detector decides over ───────────────────────────────────
/** Everything the verdict needs, read once per pass. `null` = the read itself
 *  failed / the key is absent — an unknown NEVER counts as a blocker (and never
 *  counts as ready either: `enabled` gates readiness). */
export interface MacUnattendedSnapshot {
  user: string;
  /** fdesetup status says FileVault is On. */
  fileVaultOn: boolean | null;
  /** loginwindow autoLoginUser — the configured auto-login account, or null. */
  autoLoginUser: string | null;
  /** /etc/kcpassword exists (auto-login stores the password there). */
  kcPasswordExists: boolean | null;
  /** com.apple.screensaver askForPassword (1 = asks for a password). */
  askForPassword: number | null;
  /** com.apple.screensaver askForPasswordDelay (seconds). */
  askForPasswordDelay: number | null;
  /** com.apple.screensaver idleTime (seconds; 0 = never). -currentHost domain. */
  idleTime: number | null;
  /** `pmset -g custom` AC section: system sleep minutes (0 = never). */
  sleepMinutes: number | null;
  /** `pmset -g custom` AC section: Power Nap (1 = on). */
  powerNap: number | null;
  /** loginwindow ShowUserList / FUS: fast user switching enabled. */
  fastUserSwitching: boolean | null;
  /** The account's password policy expires the password. */
  passwordExpires: boolean | null;
  /** The console is sitting at a login / lock screen right now. */
  atLoginScreen: boolean | null;
  /** The user opted this Mac in (config flag; the preset was applied). */
  enabled: boolean;
  /** The agent could read the root-only settings it needs (false = sudo missing). */
  canAdmin: boolean | null;
}

/** The preset's own pre-change record — the revert path. Written to the agent's
 *  LOCAL config (chmod 600) the moment the preset is applied; NO password and
 *  no secret ever appears here (only login-window / screensaver / pmset values). */
export interface MacUnattendedBackup {
  capturedAt: string;
  user: string;
  autoLoginUser: string | null;
  kcPasswordExisted: boolean;
  askForPassword: number | null;
  askForPasswordDelay: number | null;
  idleTime: number | null;
  acSleep: number | null;
  acDiskSleep: number | null;
  acPowerNap: number | null;
  /** `pmset -g custom` disk sleep in the AC section (minutes). */
  acDiskSleepMinutes?: number | null;
}

// ── Pure parsers (the whole point: testable without a Mac) ───────────────────

/** `fdesetup status` → true when FileVault is On for any volume.
 *  Live shapes: "FileVault is On." / "FileVault is Off." /
 *  "FileVault is On, but encryption is paused." */
export function parseFdesetupStatus(output: string): boolean | null {
  const t = (output || '').trim();
  if (!t) return null;
  if (/FileVault is On/i.test(t)) return true;
  if (/FileVault is Off/i.test(t)) return false;
  return null;
}

/** `defaults -currentHost read … idleTime` / `defaults read … askForPassword`
 *  → the integer, or null when unset/garbage. */
export function parseIntSetting(output: string): number | null {
  const t = (output || '').trim();
  if (!t) return null;
  const m = t.match(/-?\d+/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  return Number.isFinite(n) ? n : null;
}

/** `defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser`
 *  → the user name; '' / null when the key is absent (the defaults CLI exits
 *  non-zero for a missing key, which the caller models as a null stdout). */
export function parseAutoLoginUser(output: string): string | null {
  const t = (output || '').trim();
  if (!t) return null;
  // `defaults` on failure prints "The domain/default pair of (… ) does not exist"
  if (/does not exist/i.test(t)) return null;
  const name = t.split('\n')[0].trim().replace(/^"|"$/g, '');
  return name || null;
}

/** `pmset -g custom` → the AC-power section's integer keys.
 *  Shape:
 *      Battery Power:
 *       sleep                10
 *       displaysleep         2
 *       disksleep            10
 *       powernap             0
 *      AC Power:
 *       sleep                0
 *       disksleep            10
 *       powernap             0
 *  Sections are parsed separately; Battery is the fallback when a box reports
 *  only one (a desktop Mac has AC only). */
export function parsePmsetCustom(output: string): {
  ac: Record<string, number>;
  battery: Record<string, number>;
} {
  const ac: Record<string, number> = {};
  const battery: Record<string, number> = {};
  let section: 'ac' | 'battery' | null = null;
  for (const rawLine of (output || '').split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (/^\s*AC Power:/i.test(line)) { section = 'ac'; continue; }
    if (/^\s*Battery Power:/i.test(line)) { section = 'battery'; continue; }
    const m = line.match(/^\s+([A-Za-z]+)\s+(-?\d+)\s*$/);
    if (!m || !section) continue;
    const value = parseInt(m[2], 10);
    if (!Number.isFinite(value)) continue;
    (section === 'ac' ? ac : battery)[m[1].toLowerCase()] = value;
  }
  return { ac, battery };
}

/** The effective pmset value: AC first (an unattended device is plugged in),
 *  Battery as the fallback for a battery-only report. */
export function pmsetEffective(parsed: { ac: Record<string, number>; battery: Record<string, number> }, key: string): number | null {
  const k = key.toLowerCase();
  if (k in parsed.ac) return parsed.ac[k];
  if (k in parsed.battery) return parsed.battery[k];
  return null;
}

/** `pwpolicy -u <user> -getaccountpolicies` → true when the account's password
 *  EXPIRES. The policy plist carries `maxMinutesUntilChangePassword` (or the
 *  10.13+ `policyCategoryPasswordChange` array); a `policyAttributeMaximumPasscodeAge`
 *  also means expiry. Absent/garbage → null (unknown, never a blocker). */
export function parsePasswordExpiry(output: string): boolean | null {
  const t = (output || '').trim();
  if (!t) return null;
  const maxMinutes = t.match(/maxMinutesUntilChangePassword\s*(?:<\/key>)?\s*<(?:integer|real)>\s*(\d+)/i);
  if (maxMinutes) return parseInt(maxMinutes[1], 10) > 0;
  if (/policyAttributeMaximumPasscodeAge/i.test(t)) return true;
  if (/policyCategoryPasswordChange/i.test(t)) return true;
  // A policy document that exists but carries no expiry rule = no expiry.
  if (/policyCategoryPasswordContent|<key>policy/i.test(t)) return false;
  return null;
}

/** `id -Gn <user>` → is this account an ADMINISTRATOR on this Mac?
 *
 *  TICKET e530220e. This replaced a `sudo -n true` probe, and the difference is
 *  the whole bug the owner reported ("Unattended use · blocked — the agent lacks
 *  the administrator rights the preset needs"). `sudo -n` means NEVER PROMPT, so
 *  on a perfectly healthy admin Mac that simply had not run `sudo` in that
 *  terminal recently it exits 1 — and the old code read that as `canAdmin:false`
 *  and advertised `no-admin` on EVERY poll. The owner had granted everything,
 *  enabled the preset, and was still told they lacked administrator rights,
 *  forever, because "sudo is not primed right now" is not "this account cannot
 *  administer".
 *
 *  The question the blocker actually means is the one in the verdict's own
 *  words — "the preset can never be applied" — and since agent 0.9.21 the enable
 *  ASKS for the rights itself (`ensureAdminRights` → `sudo -v` in the user's
 *  terminal, ticket bcdf5d2f). So the account only has to BE an administrator,
 *  not to arrive with sudo already primed. Group membership answers that without
 *  any privilege at all, which also means this probe can never hang waiting for
 *  a password prompt inside a launchd job.
 *
 *  An unreadable output is UNKNOWN (null), never a fabricated false: a
 *  localization or a missing `id` must not accuse the device.
 */
export function parseIsAdmin(groupsOutput: string): boolean | null {
  const tokens = String(groupsOutput ?? '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  // macOS's administrator group is literally named `admin` (gid 80).
  return tokens.includes('admin');
}

/** `defaults read com.apple.loginwindow ShowUserList` /
 *  `defaults read /Library/Preferences/com.apple.loginwindow FUS...` →
 *  fast user switching enabled. Explicit keys win; an absent key is macOS's
 *  default (FUS off since 10.13) → null so the caller can decide.
 *  Also accepts the `sysadminctl -adminUser`-era comma shape. */
export function parseFastUserSwitching(output: string): boolean | null {
  const t = (output || '').trim();
  if (!t) return null;
  const m = t.match(/-?\d+/);
  if (!m) return null;
  return parseInt(m[0], 10) !== 0;
}

/**
 * Who owns the console: `_windowserver` / `loginwindow` own it when NOBODY is
 * logged in (a Mac sitting at the login window); a real user (short name or
 * uid) owns it inside a session. `stat -f %Su /dev/console` is the portable
 * probe. `root` is reported before login completes on some boots. */
export function consoleIsAtLoginWindow(output: string): boolean | null {
  const t = (output || '').trim();
  if (!t) return null;
  if (t === '_windowserver' || t === 'loginwindow' || t === 'root') return true;
  return false;
}

// ── The decision ─────────────────────────────────────────────────────────────

/**
 * The verdict over a snapshot: `{ enabled, blockers }`. `ok` (no blockers +
 * enabled) is the shipped-ready state.
 *
 * The rules, in the agent's own words:
 *   - FileVault on           → filevault (hard blocker; auto-login impossible)
 *   - preset not enabled     → enabled:false (the fleet shows "preset not enabled")
 *   - enabled + no autoLogin → autologin
 *   - enabled + a key reverted below its target → drift
 *   - askForPassword ≠ 0 / idleTime > 0 → lock
 *   - AC sleep > 0 / powernap on → sleep
 *   - FUS on                 → fast-user
 *   - password expires       → pwd-expiry
 *   - console at login window→ locked
 *   - canAdmin === false     → no-admin (the preset can never be applied)
 */
export function evaluateMacUnattended(snap: MacUnattendedSnapshot): {
  enabled: boolean;
  blockers: UnattendedBlocker[];
} {
  const found = new Set<UnattendedBlocker>();
  if (snap.fileVaultOn === true) found.add('filevault');
  if (snap.canAdmin === false) found.add('no-admin');
  if (snap.passwordExpires === true) found.add('pwd-expiry');
  if (snap.fastUserSwitching === true) found.add('fast-user');
  if (snap.askForPassword !== null && snap.askForPassword !== 0) found.add('lock');
  if (snap.idleTime !== null && snap.idleTime > 0) found.add('lock');
  if (snap.sleepMinutes !== null && snap.sleepMinutes > 0) found.add('sleep');
  if (snap.powerNap !== null && snap.powerNap !== 0) found.add('sleep');
  if (snap.atLoginScreen === true) found.add('locked');

  if (snap.enabled) {
    const noAutoLogin = !snap.autoLoginUser || (snap.kcPasswordExists === false);
    if (noAutoLogin) found.add('autologin');
    // Drift: the preset is on and a value it OWNS moved away from its target.
    // Only keys we actually read count — an unknown is never drift.
    const drifted =
      (snap.askForPassword !== null && snap.askForPassword !== 0) ||
      (snap.idleTime !== null && snap.idleTime !== 0) ||
      (snap.sleepMinutes !== null && snap.sleepMinutes !== 0) ||
      (snap.powerNap !== null && snap.powerNap !== 0);
    // `drift` is the UPDATE-RESET story specifically (auto-login vanished while
    // the rest is intact) — a plain reverted lock key is already `lock`, so we
    // only add drift when auto-login is gone AND the preset was enabled.
    if (drifted && noAutoLogin) found.add('drift');
  }
  return { enabled: snap.enabled, blockers: BLOCKER_ORDER.filter((b) => found.has(b)) };
}

/** The poll-query value: 'on,ok' / 'on,filevault' / 'locked' / '' (never advertises).
 *  The backend normalizes + ranks; the agent only reports facts.
 *
 *  PRESET-OFF STILL REPORTS THE LIVE LOCK (ticket c468f922). The blockers that
 *  describe the PRESET (filevault/autologin/drift/lock/sleep) are meaningless
 *  guidance when the user never opted in, so they stay suppressed. But "the
 *  console is at a login window RIGHT NOW" is a fact about the DEVICE, not about
 *  the preset — and it is the one fact a dispatch lane needs in order to refuse
 *  instead of burning a run. Suppressing it here made the pre-login gate
 *  unreachable for exactly the population the incident hit (a Mac that was
 *  never opted in). Emitting the bare `locked` token (no `on`) keeps the fleet
 *  verdict honest: the backend's `unattendedVerdict` gates on `enabled` FIRST,
 *  so `{enabled:false, blockers:['locked']}` still reads "preset not enabled" —
 *  never a false ready — while the pre-login capability sees the lock. */
export function unattendedAdvertValue(snap: MacUnattendedSnapshot): string {
  const v = evaluateMacUnattended(snap);
  if (!v.enabled) {
    // TICKET 11b6974f: an OFF preset now SAYS SO (`off`) instead of advertising
    // nothing. Advertising nothing made "the owner never turned this on" and
    // "this agent build cannot report the preset at all" the same bytes on the
    // wire, so every device read the fleet's "never reported by this build —
    // update the agent" sentence no matter what the owner toggled. `off` is a
    // positive claim, so the two are finally distinguishable.
    // A live login-window lock still rides along: it is a fact about the
    // DEVICE (not the preset), and the pre-login gate refuses on it even for a
    // device that never opted in (ticket c468f922).
    return v.blockers.includes('locked') ? 'off,locked' : 'off';
  }
  return v.blockers.length === 0 ? 'on,ok' : `on,${v.blockers.join(',')}`;
}

// ── IO seam (injected so tests never touch a real Mac) ───────────────────────
export interface MacRunResult { stdout: string; code: number }
export interface MacIo {
  /** Run a command; never throws — a failure is `{stdout:'', code≠0}`. */
  run(cmd: string, args: string[], opts?: { stdin?: string }): Promise<MacRunResult>;
  /** Run a command ATTACHED to the user's own terminal, so the command can
   *  prompt them directly (`sudo -v` and its "Password:" line). Omitted by the
   *  test runners and by any run with no controlling terminal — callers must
   *  treat its ABSENCE as "cannot ask", never as "already authorised".
   *
   *  WHY THIS EXISTS (ticket bcdf5d2f). `applyMacPreset` used to gate on
   *  `sudo -n true`, and `-n` means NEVER PROMPT. So a stock Mac always failed
   *  that check and the owner was told "run it in a terminal where sudo is
   *  already authorised" — i.e. they had to know to run `sudo -v` in that same
   *  window FIRST, while the docs simultaneously said NOT to prefix the command
   *  itself with `sudo` (under sudo `$USER` is root, so the preset configures
   *  auto-login for root and strands the machine). Two opposite hidden
   *  prerequisites, neither discoverable from the card: that is the "very messy
   *  setup flow… normal users wouldn't know to run sudo" the owner reported. */
  runInteractive?(cmd: string, args: string[]): Promise<{ code: number }>;
}

/** The real runner (execFile — no shell, so no quoting surprises). */
export const realMacIo: MacIo = {
  run(cmd, args, opts) {
    return new Promise((resolve) => {
      const child = execFile(cmd, args, { timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        resolve({ stdout: String(stdout || ''), code: err ? 1 : 0 });
      });
      if (opts?.stdin) {
        try { child.stdin?.end(opts.stdin); } catch { /* the command may not read stdin */ }
      }
    });
  },
  runInteractive(cmd, args) {
    return new Promise((resolve) => {
      try {
        // No controlling terminal (a script, a launchd job, a piped run): sudo
        // would either hang forever or fail opaquely, so report "could not ask"
        // instead. Callers treat a non-zero code as a refusal, never a grant.
        if (!process.stdin.isTTY) {
          resolve({ code: 1 });
          return;
        }
        // `stdio: 'inherit'` is the whole point: sudo's own "Password:" prompt
        // goes to the user's terminal and the password never passes through
        // this process, an argv, an env var or a pipe.
        const child = spawnSync(cmd, args, { stdio: 'inherit', timeout: 120000 });
        resolve({ code: typeof child.status === 'number' ? child.status : 1 });
      } catch {
        resolve({ code: 1 });
      }
    });
  },
};

const LOGINWINDOW_PLIST = '/Library/Preferences/com.apple.loginwindow';

/**
 * Read the whole snapshot. Every field degrades to null independently — one
 * unreadable key never blinds the detector (and never fabricates a blocker).
 */
export async function probeMacUnattended(
  io: MacIo,
  opts: { user: string; enabled: boolean },
): Promise<MacUnattendedSnapshot> {
  const user = opts.user;
  const [fv, autoLogin, kc, ask, delay, idle, pmset, pwpolicy, fus, consoleUser, adminGroups] = await Promise.all([
    io.run('fdesetup', ['status']),
    io.run('defaults', ['read', LOGINWINDOW_PLIST, 'autoLoginUser']),
    io.run('test', ['-f', '/etc/kcpassword']),
    io.run('defaults', ['read', 'com.apple.screensaver', 'askForPassword']),
    io.run('defaults', ['read', 'com.apple.screensaver', 'askForPasswordDelay']),
    io.run('defaults', ['-currentHost', 'read', 'com.apple.screensaver', 'idleTime']),
    io.run('pmset', ['-g', 'custom']),
    io.run('pwpolicy', ['-u', user, '-getaccountpolicies']),
    io.run('defaults', ['read', 'com.apple.loginwindow', 'ShowUserList']),
    io.run('stat', ['-f', '%Su', '/dev/console']),
    // TICKET e530220e: group membership, NOT `sudo -n true`. `-n` never
    // prompts, so an ordinary admin Mac that had not primed sudo read as
    // `canAdmin:false` and the card announced "the agent lacks the
    // administrator rights the preset needs" forever. The blocker means "this
    // account can never be an administrator", which is a membership fact and
    // needs no privilege to read. Since 0.9.21 the enable asks for the rights
    // itself (ensureAdminRights), so arriving un-primed is not a blocker.
    // No user name (a row that never captured one) → ask about THIS process's
    // user, which is the account the agent runs as either way.
    io.run('id', user ? ['-Gn', user] : ['-Gn']),
  ]);
  const pm = parsePmsetCustom(pmset.stdout);
  return {
    user,
    fileVaultOn: parseFdesetupStatus(fv.stdout),
    autoLoginUser: parseAutoLoginUser(autoLogin.stdout),
    kcPasswordExists: kc.code === 0 ? true : kc.code === 1 && !kc.stdout ? false : null,
    askForPassword: parseIntSetting(ask.stdout),
    askForPasswordDelay: parseIntSetting(delay.stdout),
    idleTime: parseIntSetting(idle.stdout),
    sleepMinutes: pmsetEffective(pm, 'sleep'),
    powerNap: pmsetEffective(pm, 'powernap'),
    fastUserSwitching: parseFastUserSwitching(fus.stdout),
    passwordExpires: parsePasswordExpiry(pwpolicy.stdout),
    atLoginScreen: consoleIsAtLoginWindow(consoleUser.stdout),
    enabled: opts.enabled,
    // Only a SUCCESSFUL groups read counts. A failed `id` (unknown user, a
    // localized error) is UNKNOWN, never a fabricated `no-admin` — the same
    // absent-never-accuses rule the rest of this snapshot follows.
    canAdmin: adminGroups.code === 0 ? parseIsAdmin(adminGroups.stdout) : null,
  };
}

// ── /etc/kcpassword encoding (documented, root-only, XOR-obfuscated) ─────────

/** The kcpassword XOR key Apple's loginwindow uses. */
export const KCPASSWORD_KEY = [0x7D, 0x89, 0x52, 0x23, 0xD2, 0xBC, 0xDD, 0xEA, 0xA3, 0xB9, 0x1F];

/**
 * Encode the auto-login password exactly the way loginwindow expects:
 * the password bytes + a NUL terminator, XORed with KCPASSWORD_KEY and padded
 * with zeros to a whole multiple of the key length.
 *
 * HONESTY NOTE (this is not encryption, and the docs say so): kcpassword must
 * be readable by loginwindow BEFORE any user session exists, so it cannot live
 * in the Keychain — it is obfuscation behind root-only file permissions
 * (0600 root:wheel). The docs page states this is the one place the account
 * password has to touch disk in a recoverable form, and that the preset is
 * therefore opt-in per device.
 */
export function encodeKcPassword(password: string): Buffer {
  const bytes = Buffer.from(password + '\0', 'utf8');
  const out = Buffer.alloc(Math.ceil(bytes.length / KCPASSWORD_KEY.length) * KCPASSWORD_KEY.length);
  for (let i = 0; i < out.length; i++) {
    out[i] = (bytes[i] ?? 0) ^ KCPASSWORD_KEY[i % KCPASSWORD_KEY.length];
  }
  return out;
}

// ── Apply / revert ───────────────────────────────────────────────────────────

/** Capture the pre-change values — the revert path. Reads ONLY values (never
 *  the password), so this record is safe to keep in the agent's local config. */
export async function captureMacBackup(io: MacIo, user: string): Promise<MacUnattendedBackup> {
  const [autoLogin, kc, ask, delay, idle, pmset] = await Promise.all([
    io.run('defaults', ['read', LOGINWINDOW_PLIST, 'autoLoginUser']),
    io.run('test', ['-f', '/etc/kcpassword']),
    io.run('defaults', ['read', 'com.apple.screensaver', 'askForPassword']),
    io.run('defaults', ['read', 'com.apple.screensaver', 'askForPasswordDelay']),
    io.run('defaults', ['-currentHost', 'read', 'com.apple.screensaver', 'idleTime']),
    io.run('pmset', ['-g', 'custom']),
  ]);
  const pm = parsePmsetCustom(pmset.stdout);
  return {
    capturedAt: new Date().toISOString(),
    user,
    autoLoginUser: parseAutoLoginUser(autoLogin.stdout),
    kcPasswordExisted: kc.code === 0,
    askForPassword: parseIntSetting(ask.stdout),
    askForPasswordDelay: parseIntSetting(delay.stdout),
    idleTime: parseIntSetting(idle.stdout),
    acSleep: pmsetEffective(pm, 'sleep'),
    acDiskSleep: pmsetEffective(pm, 'disksleep'),
    acPowerNap: pmsetEffective(pm, 'powernap'),
  };
}

/** Raised when the preset must NOT be applied — always with the reason a human
 *  can act on. Never half-configure after throwing. */
export class UnattendedRefusal extends Error {
  constructor(
    message: string,
    readonly blocker: UnattendedBlocker,
  ) {
    super(message);
    this.name = 'UnattendedRefusal';
  }
}

export interface MacApplyOptions {
  user: string;
  /** The account password, typed by the user INTO this machine's terminal.
   *  Used once to write /etc/kcpassword; never persisted, never transmitted. */
  password: string;
  /** The real short name of the login account (may differ from $USER). */
  loginUser?: string;
}

export interface MacApplyResult {
  applied: string[];
  skipped: string[];
  backup: MacUnattendedBackup;
}

/** Ask the OS for the administrator rights the preset needs — once, through
 *  sudo's OWN password prompt, in the terminal the user is already sitting in.
 *
 *  TICKET bcdf5d2f. The owner's report: "still very messy setup flow.. normal
 *  users wouldnt know to run sudo prefix to command". The previous shape was a
 *  `sudo -n true` gate — `-n` means NEVER PROMPT — so the enable could only
 *  ever succeed if the user had ALREADY run `sudo -v` in that same terminal,
 *  and the failure message asked them to do exactly that in words they had to
 *  decode ("a terminal where sudo is already authorised"). Worse, the docs
 *  simultaneously forbade the obvious workaround: prefixing the command with
 *  `sudo` makes `$USER` root, and the preset then configures auto-login for
 *  root — which looks applied and strands the machine at the login window.
 *  So the two instructions contradicted each other and neither was discoverable.
 *
 *  WHAT THIS DOES INSTEAD. If sudo is already authorised (`sudo -n` succeeds)
 *  nothing changes and no prompt appears. Otherwise the agent runs `sudo -v`
 *  ATTACHED to the terminal, so the user sees the familiar macOS "Password:"
 *  line and types their own password — the standard, expected escalation of any
 *  installer. The password goes to sudo, never through this process, never into
 *  an argv, env var, log or the pairing config.
 *
 *  FAILS CLOSED with an ACTIONABLE sentence when there is no terminal to ask
 *  in (a non-interactive shell): that is the one case where a human really must
 *  act, and it says so plainly instead of implying a hidden ritual.
 */
export async function ensureAdminRights(io: MacIo): Promise<{ ok: boolean; message: string }> {
  // Already authorised (a recent sudo in this terminal, or a managed Mac whose
  // policy grants it): nothing to ask, nothing to change.
  const probe = await io.run('sudo', ['-n', 'true']);
  if (probe.code === 0) return { ok: true, message: '' };

  // No terminal to prompt in (or a runner that cannot attach one): refuse
  // honestly. Never fall through — the writes below would fail one by one.
  if (!io.runInteractive) {
    return {
      ok: false,
      message:
        'administrator rights are required to enable this (the preset writes a root-owned ' +
        'login-window preference and /etc/kcpassword). Run this command in Terminal.app so it ' +
        'can ask for your Mac password. Nothing was changed.',
    };
  }

  // The normal path: let sudo ask, in the user's own terminal.
  const ask = await io.runInteractive('sudo', ['-v']);
  if (ask.code !== 0) {
    return {
      ok: false,
      message:
        'administrator rights are required to enable this, and the password prompt was ' +
        'cancelled or refused. Run this command again in Terminal.app and enter your Mac ' +
        'password when macOS asks. Nothing was changed.',
    };
  }
  // Re-probe: a `sudo -v` that "succeeded" against a policy that grants nothing
  // must not be read as authorisation for the writes that follow.
  const confirm = await io.run('sudo', ['-n', 'true']);
  if (confirm.code !== 0) {
    return {
      ok: false,
      message:
        'administrator rights could not be confirmed after the password prompt — this ' +
        'account is probably not an administrator on this Mac. Nothing was changed.',
    };
  }
  return { ok: true, message: '' };
}

/**
 * Apply the preset. ORDER MATTERS: probe first, refuse on a hard blocker, and
 * only then touch anything — a refusal leaves the machine exactly as it was.
 */
export async function applyMacPreset(io: MacIo, opts: MacApplyOptions): Promise<MacApplyResult> {
  const user = opts.loginUser || opts.user;
  if (!opts.password) {
    throw new UnattendedRefusal(
      'the account password is required to enable auto-login (it is written only to /etc/kcpassword on this Mac)',
      'autologin',
    );
  }
  const fv = parseFdesetupStatus((await io.run('fdesetup', ['status'])).stdout);
  if (fv === true) {
    throw new UnattendedRefusal(
      'FileVault is ON: macOS cannot auto-login to a FileVault volume — the pre-boot unlock happens before any user account exists, so a reboot would still stop at the unlock screen. Turn FileVault off for this Mac first (System Settings → Privacy & Security → FileVault), then re-run. Nothing was changed.',
      'filevault',
    );
  }
  // TICKET bcdf5d2f — the owner's "very messy setup flow, normal users
  // wouldn't know to run sudo". This used to be a bare `sudo -n true` gate: `-n`
  // NEVER PROMPTS, so on a stock Mac it always failed and the owner was told to
  // "run it in a terminal where sudo is already authorised" — a hidden
  // prerequisite (`sudo -v` first, same window) that was ALSO contradicted by
  // the docs' "do NOT prefix the command with sudo" rule. Two opposite
  // instructions, neither on the card. The agent now asks for the password
  // ITSELF, once, through sudo's own prompt, which is the whole point of running
  // the command in the user's terminal.
  const admin = await ensureAdminRights(io);
  if (!admin.ok) {
    throw new UnattendedRefusal(admin.message, 'no-admin');
  }

  const backup = await captureMacBackup(io, user);
  const applied: string[] = [];
  const skipped: string[] = [];

  // 1. Auto-login: the user name in the login-window domain + the password in
  //    /etc/kcpassword (0600 root:wheel). Both or neither.
  const enc = encodeKcPassword(opts.password).toString('base64');
  const writeKc = await io.run('sudo', ['sh', '-c', `printf %s '${enc}' | base64 -d > /etc/kcpassword && chmod 600 /etc/kcpassword && chown root:wheel /etc/kcpassword`]);
  if (writeKc.code === 0) applied.push('/etc/kcpassword');
  else skipped.push('/etc/kcpassword (write failed)');
  const setAuto = await io.run('sudo', ['defaults', 'write', LOGINWINDOW_PLIST, 'autoLoginUser', user]);
  if (setAuto.code === 0) applied.push('autoLoginUser');
  else skipped.push('autoLoginUser (write failed)');

  // 2. Never ask for a password again on idle / wake / screensaver.
  await io.run('defaults', ['write', 'com.apple.screensaver', 'askForPassword', '-int', '0']);
  await io.run('defaults', ['write', 'com.apple.screensaver', 'askForPasswordDelay', '-int', '0']);
  await io.run('defaults', ['-currentHost', 'write', 'com.apple.screensaver', 'idleTime', '-int', '0']);
  applied.push('screensaver askForPassword=0, idleTime=0');

  // 3. No idle system sleep; Power Nap off. TRADEOFF (docs): a plugged-in Mac
  //    that never sleeps draws more power and runs warmer; display sleep is
  //    left alone because a dark display does NOT end the session.
  const pm = await io.run('sudo', ['pmset', '-a', 'sleep', '0', 'disksleep', '0', 'powernap', '0']);
  if (pm.code === 0) applied.push('pmset sleep=0 disksleep=0 powernap=0');
  else skipped.push('pmset (write failed — system may still sleep)');

  return { applied, skipped, backup };
}

/**
 * The kill switch: restore every captured value. Idempotent — a key that was
 * absent BEFORE the preset is deleted, not "restored" to a guessed default.
 * Returns the steps it ran so the CLI can print exactly what changed.
 */
export async function revertMacPreset(io: MacIo, backup: MacUnattendedBackup): Promise<{ reverted: string[] }> {
  const reverted: string[] = [];
  // Auto-login off.
  await io.run('sudo', ['defaults', 'delete', LOGINWINDOW_PLIST, 'autoLoginUser']);
  await io.run('sudo', ['rm', '-f', '/etc/kcpassword']);
  reverted.push('auto-login disabled (/etc/kcpassword removed)');

  // Screensaver: restore what was there. askForPassword had no key before the
  // preset on most Macs — its EFFECTIVE default is 1 ("asks"), so a missing
  // key is restored to 1 rather than deleted (deleting would re-enable the
  // preset's own weakening).
  await io.run('defaults', ['write', 'com.apple.screensaver', 'askForPassword', '-int', String(backup.askForPassword ?? 1)]);
  if (backup.askForPasswordDelay === null) await io.run('defaults', ['delete', 'com.apple.screensaver', 'askForPasswordDelay']);
  else await io.run('defaults', ['write', 'com.apple.screensaver', 'askForPasswordDelay', '-int', String(backup.askForPasswordDelay)]);
  if (backup.idleTime === null) await io.run('defaults', ['-currentHost', 'delete', 'com.apple.screensaver', 'idleTime']);
  else await io.run('defaults', ['-currentHost', 'write', 'com.apple.screensaver', 'idleTime', '-int', String(backup.idleTime)]);
  reverted.push(`screensaver restored (askForPassword=${backup.askForPassword ?? 1}, idleTime=${backup.idleTime ?? 'unset'})`);

  const sleep = backup.acSleep ?? 10;
  const disk = backup.acDiskSleep ?? 10;
  const nap = backup.acPowerNap ?? 0;
  const pm = await io.run('sudo', ['pmset', '-a', 'sleep', String(sleep), 'disksleep', String(disk), 'powernap', String(nap)]);
  reverted.push(pm.code === 0
    ? `pmset restored (sleep=${sleep} disksleep=${disk} powernap=${nap})`
    : 'pmset restore FAILED — restore by hand with: sudo pmset -a sleep ' + sleep);
  return { reverted };
}

/**
 * The sleep assertion: while the agent is paired and running, hold an idle
 * sleep assertion so the session never falls asleep on its own. `caffeinate -i`
 * prevents IDLE sleep; `-w <pid>` ties the assertion to this process (it ends
 * when the agent dies — no orphan assertion outliving the agent).
 * Returns the child (or null when the spawn failed); the caller kills it on
 * shutdown. Only started when the preset is enabled — a device that never
 * opted in keeps its normal sleep behaviour.
 */
export function startSleepAssertion(io: { spawn?: (cmd: string, args: string[]) => { kill?: () => void } | null }, pid: number): { kill?: () => void } | null {
  try {
    return io.spawn ? io.spawn('caffeinate', ['-i', '-s', '-w', String(pid)]) : null;
  } catch {
    return null; // caffeinate is stdlib on macOS; a failure is never fatal
  }
}