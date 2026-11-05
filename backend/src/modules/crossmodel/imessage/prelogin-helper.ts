/**
 * PRE-LOGIN HELPER — the macOS privileged helper's capability, install plan and
 * revoke plan (ticket c468f922, option (d) of the owner's 2026-11-01 ruling).
 *
 * THE OWNER'S RULING THIS MODULE IMPLEMENTS. Card oq_96b31bed, answered in the
 * owner's own words: "(d) + (b) together — recommended".
 *
 *   (d) = a privileged helper that buys the ABILITY to render and post input at
 *         the login window. CAPABILITY ONLY.
 *   (b) = the "Unattended / Autonomous use" preset stays the default posture,
 *         so a device does not idle to a lock screen in the first place.
 *   (a) = helper + the login password held in the root Keychain. REJECTED.
 *
 * Capability and credential custody are SEPARABLE — that is the whole
 * observation that settled the fork, and it is what TeamViewer actually does: a
 * root daemon to reach the login screen, and the OS password still typed by the
 * human who connects. So this helper:
 *
 *   • IS: a root LaunchDaemon (`ai.digby.prelogin-helper`) loaded in the
 *     `system/` launchd domain, OUTSIDE any user session, which is the only
 *     context from which `loginwindow` accepts synthetic events.
 *   • IS NOT: a credential store. It has no Keychain item, writes no
 *     /etc/kcpassword, takes no password on its command line, and receives none
 *     over its control surface. There is nothing for a revoke to shred because
 *     there was never anything to shred — see planMacHelperRevert().
 *
 * WHY A DAEMON IS REQUIRED AT ALL (the measured fact behind the ticket). macOS
 * runs the login window in its own security context; an app inside a logged-in
 * user session is deliberately denied the ability to post events there.
 * Observed live 2026-10-28 on `cql-stanne-mbp1` (agent 0.9.11) at the login
 * screen: 0 input accepted, refusedRepeats=0 / noChangeStrikes=0 — an OS-level
 * refusal that reads exactly like a hung agent, which is why the deerland
 * Amplify lane burned four runs on it. Root outside the session is the only
 * position from which IOHIDPostEvent / a loginwindow-session CGEvent reaches.
 *
 * THE ACCEPTED COST, stated here so no future lane "fixes" it with a secret: a
 * 3am autonomous run against a device genuinely at the login window still WAITS
 * for a human, because the human types the password. The remedy for that is
 * (b) — the device should not have reached a login screen — never a stored
 * credential. PRELOGIN_CREDENTIAL_POLICY.storesOsPassword stays `false`, and
 * the verdict below REFUSES to report ready for any helper that claims custody.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO: it does not ship the helper
 * BINARY. A signed, notarized Mach-O that posts events at loginwindow must be
 * built on a Mac with a Developer ID identity (see docs/UNATTENDED_DEVICES.md
 * §5.3 for the searchable build shape). Everything that can be decided,
 * planned, rendered and verified without a Mac lives here and is unit-tested;
 * the binary and its on-device proof are hardware-gated and are NOT claimed.
 *
 * Pure planning + parsing — no Prisma, no Redis, no logger, no fs, no
 * child_process (the exec seam is injected, exactly like remote-access.ts), so
 * every decision below is unit-tested without a Mac and this module provably
 * cannot hold a credential of its own.
 */

/**
 * DEPENDENCY DIRECTION, deliberately one-way: this module imports NOTHING.
 * `prelogin-capability.ts` imports THIS one (the capability answer is composed
 * from the helper verdict), never the other way round — a cycle between a
 * policy module and the module it gates is how a "belt and braces" check ends
 * up evaluating to `undefined` at load time and quietly passing.
 *
 * The credential-holding gate therefore takes the policy as an ARGUMENT rather
 * than reading it here; the composer passes the owner's ruling in. Pinned by
 * prelogin-helper.c468f922.test.ts.
 */
export interface PreloginHelperAgentLike {
  preloginHelper?: unknown;
}

// ── Identity ────────────────────────────────────────────────────────────────

/** The launchd label. Namespaced under ai.digby like every Digby job. */
export const PRELOGIN_HELPER_LABEL = 'ai.digby.prelogin-helper';

/** Where the daemon lives. Root-owned and outside /Library/Digby/imessage-agent
 *  on purpose: that tree is the USER agent's payload and is yield-able by the
 *  self-managed installer (postinstall's 405927c9 yield), while a system daemon
 *  must not be removed by a user-level installer deciding to yield. */
export const PRELOGIN_HELPER_INSTALL_DIR = '/Library/Digby/prelogin-helper';

/** The daemon binary. Derived, never configured. */
export const PRELOGIN_HELPER_BINARY = `${PRELOGIN_HELPER_INSTALL_DIR}/DigbyPreloginHelper`;

/** The system-domain plist. */
export const PRELOGIN_HELPER_PLIST = `/Library/LaunchDaemons/${PRELOGIN_HELPER_LABEL}.plist`;

/** The poll query param an agent uses to advertise helper state. Beside
 *  `&unattended=` and `&remoteaccess=` — same closed-vocabulary contract. */
export const PRELOGIN_HELPER_ADVERT_PARAM = 'preloginhelper';

/** Wire state marks: `on` = installed + loaded + answering; `off` = the agent
 *  POSITIVELY PROVED nothing is installed. Everything else is a BLOCKER. */
export const HELPER_ON = 'on';
export const HELPER_OFF = 'off';

// ── Blockers (closed vocabulary) ─────────────────────────────────────────────

/**
 * Every blocker an agent may advertise about the helper, with the ONE line the
 * fleet renders. PRIORITY ORDER — a credential-custody violation outranks
 * everything (it is an owner-ruling breach, not a setup step), then signature
 * (macOS will not load it at all), then load state, then drift.
 */
export const PRELOGIN_HELPER_BLOCKER_PRIORITY: ReadonlyArray<{
  token: string;
  reason: string;
}> = [
  {
    token: 'credential-custody',
    reason:
      'the installed pre-login helper holds an OS credential — that is the option the owner REJECTED (card oq_96b31bed); revoke the helper now (`launchctl bootout system /Library/LaunchDaemons/ai.digby.prelogin-helper.plist`, then remove the plist and /Library/Digby/prelogin-helper) and report the binary, because a helper that can type at the login window AND holds the password is a remote unlock',
  },
  {
    token: 'unsigned',
    reason:
      'the pre-login helper is not validly signed (or its signature is broken) — macOS will refuse to load a system daemon that fails signature validation, so it can never post input at the login window; rebuild it with the Developer ID Application identity',
  },
  {
    token: 'no-binary',
    reason:
      'the pre-login helper plist is installed but its program is missing — launchd will fail the job on every boot; reinstall the helper',
  },
  {
    token: 'not-loaded',
    reason:
      'the pre-login helper is installed but not bootstrapped into the system launchd domain — it is inert until `launchctl bootstrap system <plist>` succeeds; reinstall or bootstrap it',
  },
  {
    token: 'stale',
    // PRODUCER: the AGENT, not any backend probe. An agent that loaded a
    // helper older than itself emits this token on its poll. It stays in the
    // vocabulary deliberately: the normalizer DROPS unknown tokens, so
    // removing it would make a stale helper's advert silently vanish and read
    // as a healthy `on` — a false green. Once the agent-side emitter ships
    // (it needs the signed binary, see docs/UNATTENDED_DEVICES.md §5.2a) this
    // is the branch that catches a version-skewed daemon.
    reason:
      'the loaded pre-login helper is older than the agent that advertised it — the login-window protocol may have changed; reinstall the helper from the current release',
  },
];

const HELPER_BLOCKER_TOKENS: ReadonlySet<string> = new Set(
  PRELOGIN_HELPER_BLOCKER_PRIORITY.map((b) => b.token),
);

/** The reason for the PROVED-ABSENT state. Deliberately not a nag: absent is
 *  the healthy default (installing a root daemon is opt-in, per device), and
 *  the (b) half of the ruling already covers most devices. */
export const HELPER_OFF_REASON =
  'off — no pre-login helper is installed on this device (the default); the "Unattended / Autonomous use" preset keeps the session alive, which is what stops most devices reaching a login screen at all';

/** The reason a device that never advertised reads. Unknown is NOT ready.
 *
 *  TICKET e530220e — THE COPY USED TO POINT AT AN UPDATE THAT CANNOT HELP. It
 *  read "an agent older than the release that introduced it … until the agent is
 *  updated and the helper is installed", which asserts two things that are both
 *  FALSE today: that some release introduced the advert, and that updating is
 *  therefore the remedy. No agent build has ever emitted it — `preloginhelper`
 *  has ZERO producers in `imessage-agent/src`, `windows-agent/src` and
 *  `macos-app`, and zero occurrences inside the shipped 0.9.23 tarball (only the
 *  poll/parse seams on the BACKEND side read it). So an owner on the current
 *  release reads a sentence telling them to update, updates, and the row does
 *  not move — one sentence, the wrong remedy, exactly the defect #2521 fixed for
 *  the remote-channel row beside it.
 *
 *  What is true is a FLEET-SIDE gap, not a device fault: the verdict, the closed
 *  vocabulary and the storage all shipped, but nothing on the device side emits
 *  the advert because the signed daemon binary is a Mac-side build step
 *  (docs/UNATTENDED_DEVICES.md §5.2a). The sentence therefore says that, and
 *  stops implying a device action can change the row.
 *
 *  PINNED BY TEST so it cannot silently become a lie in the other direction:
 *  `prelogin-capability.2026-10-28.test.ts` scans the agent trees for an
 *  emitter and fails if one appears while this copy still claims there is none. */
export const HELPER_UNKNOWN_REASON =
  'no agent release reports pre-login helper state yet — the fleet-side verdict, vocabulary and storage all exist, but the privilege-scoped helper that would emit the report is not shipped in any agent build, so updating the agent cannot change this row; until it ships, a locked or signed-out device cannot be driven (the "Unattended / Autonomous use" preset is what keeps a session alive)';

// ── Advert shape ────────────────────────────────────────────────────────────

/** The stored / advertised shape (imessage_agents."preloginHelper" JSONB).
 *  camelCase — it is a Prisma field with no `@map`. The first migration spelled
 *  it `prelogin_helper` and was applied; 20261102013000 repairs the column and
 *  migration-schema-parity.test.ts pins the applied bytes so it cannot recur. */
export interface PreloginHelperAdvert {
  /** The plist is installed at the system path. */
  installed: boolean;
  /** The job is bootstrapped into the `system` launchd domain. */
  loaded: boolean;
  /** Blocker tokens the agent detected on its LAST pass. */
  blockers: string[];
  /** The agent POSITIVELY PROVED nothing is installed (see HELPER_OFF). Only
   *  ever set by a live probe, never by a config flag, and never alongside
   *  `installed`. */
  off?: boolean;
}

/** The fleet-facing verdict a lane reads before dispatching to a locked device. */
export interface PreloginHelperVerdict {
  /** The typed health line. `off` is a HEALTHY state (opt-in default), so a
   *  consumer must not treat it as a failure to fix. */
  state: 'off' | 'on' | 'blocked' | 'unavailable';
  /** The plist is installed on this device. */
  installed: boolean;
  /** YES = the helper can render AND post input at the login window on this
   *  device. NEVER true for a device that advertises nothing — unknown is not
   *  ready, and never true while any blocker (least of all credential
   *  custody) is set. */
  ready: boolean;
  /** The ONE reason when not ready; '' when ready. */
  reason: string;
}

/**
 * Normalize the poll query param / pair-body value / stored object into the
 * advert shape.
 *
 * ABSENT-NEVER-CLOBBERS, the house contract: `undefined` in ⇒ `undefined` out,
 * so a legacy agent (which sends no such param) never wipes a stored verdict
 * and never reads as a fabricated "not installed". Unknown tokens are DROPPED
 * so a newer agent can report a blocker this backend has not learned without
 * breaking the poll or reading as a false "ready".
 */
export function normalizePreloginHelper(raw: unknown): PreloginHelperAdvert | undefined {
  if (raw === null || raw === undefined) return undefined;
  let tokens: string[] = [];
  let explicitInstalled: boolean | undefined;
  let explicitLoaded: boolean | undefined;
  let offExplicit = false;

  if (typeof raw === 'string') {
    tokens = raw.split(',');
  } else if (Array.isArray(raw)) {
    tokens = raw.filter((t): t is string => typeof t === 'string');
  } else if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.blockers)) {
      tokens = o.blockers.filter((t): t is string => typeof t === 'string');
    }
    if (typeof o.installed === 'boolean') explicitInstalled = o.installed;
    if (typeof o.loaded === 'boolean') explicitLoaded = o.loaded;
    if (o.off === true) offExplicit = true;
  } else {
    return undefined;
  }

  const seen = new Set<string>();
  for (const t of tokens) {
    const tok = t.trim();
    if (!tok) continue;
    // `on` / `off` are state marks, not blockers; keep only known blockers.
    if (tok === HELPER_ON || tok === HELPER_OFF) continue;
    if (HELPER_BLOCKER_TOKENS.has(tok)) seen.add(tok);
  }

  let installed = explicitInstalled;
  let loaded = explicitLoaded;
  if (typeof raw === 'string' || Array.isArray(raw)) {
    const set = new Set(tokens.map((t) => t.trim()));
    // `on` WINS a conflict, always: an ambiguous advert must never clear a
    // stored green (same rule as normalizeRemoteAccess).
    if (set.has(HELPER_ON)) installed = true;
    else if (set.has(HELPER_OFF)) {
      installed = false;
      offExplicit = true;
    }
    if (installed === true) loaded = !set.has('not-loaded') && !set.has('no-binary');
  }
  if (installed === false) loaded = false;

  if (installed === undefined && seen.size === 0 && !offExplicit) return undefined;

  const blockers = PRELOGIN_HELPER_BLOCKER_PRIORITY.map((b) => b.token).filter((t) => seen.has(t));
  return {
    installed: installed === true,
    loaded: loaded === true,
    blockers,
    ...(offExplicit ? { off: true } : {}),
  };
}

/**
 * The advert VALUE an agent sends on the poll.
 *
 * Structurally cannot carry a credential: it emits ONLY tokens from the closed
 * vocabulary plus the caller's state marks. A password passed in by accident
 * has nowhere to go — the same property remoteAccessAdvertValue() provides at
 * its seam, and the reason criterion 5 ("no credential is ever logged, echoed
 * into a chat, or committed") holds at the agent end too.
 */
export function preloginHelperAdvertValue(
  state: Pick<PreloginHelperAdvert, 'installed' | 'loaded' | 'blockers'> & { off?: boolean },
): string {
  const out: string[] = [];
  if (state.installed) out.push(HELPER_ON);
  else if (state.off) out.push(HELPER_OFF);
  for (const token of PRELOGIN_HELPER_BLOCKER_PRIORITY) {
    if (state.blockers.includes(token.token)) out.push(token.token);
  }
  return out.join(',');
}

/** The reason text for a single token (agent-facing self-check + tests). */
export function reasonForHelperBlocker(token: string): string {
  return PRELOGIN_HELPER_BLOCKER_PRIORITY.find((b) => b.token === token)?.reason ?? '';
}

/**
 * The verdict for one normalized advert.
 *
 * THE POLICY GATE. `ready` additionally requires
 * PRELOGIN_CREDENTIAL_POLICY.storesOsPassword to be false — belt AND braces,
 * because the ruling is an OWNER security decision and a verdict that could
 * report ready over a credential-holding helper would make the ruling advisory.
 * If a future lane flips that constant, this function stops reporting ready
 * rather than silently blessing option (a).
 */
export function preloginHelperVerdict(
  advert: PreloginHelperAdvert | undefined,
  policy?: { storesOsPassword: boolean },
): PreloginHelperVerdict {
  if (!advert) {
    return { state: 'unavailable', installed: false, ready: false, reason: HELPER_UNKNOWN_REASON };
  }
  // BLOCKERS ARE SCANNED BEFORE THE INSTALLED-CHECK, deliberately. A
  // credential-custody breach must never render as the healthy `off` default:
  // an agent that detects custody can only emit the token (an `on` mark
  // requires a positive install signal), so checking `installed` first would
  // turn the owner's rejected option (a) into "off — the default", which is
  // precisely the reading this gate exists to prevent.
  const first = PRELOGIN_HELPER_BLOCKER_PRIORITY.find((b) => advert.blockers.includes(b.token));
  if (first) {
    return { state: 'blocked', installed: advert.installed, ready: false, reason: first.reason };
  }
  if (!advert.installed) {
    return { state: 'off', installed: false, ready: false, reason: HELPER_OFF_REASON };
  }
  if (!advert.loaded) {
    return {
      state: 'blocked',
      installed: true,
      ready: false,
      reason: reasonForHelperBlocker('not-loaded'),
    };
  }
  if (policy && policy.storesOsPassword !== false) {
    // The owner's ruling, enforced at the verdict: a helper that holds an OS
    // credential is option (a), which card oq_96b31bed REJECTED. Refusing to
    // report ready here makes the ruling structural rather than advisory — a
    // future lane that flips PRELOGIN_CREDENTIAL_POLICY.storesOsPassword to
    // true does not get a green fleet, it gets a blocked one.
    return {
      state: 'blocked',
      installed: true,
      ready: false,
      reason: reasonForHelperBlocker('credential-custody'),
    };
  }
  return {
    state: 'on',
    installed: true,
    ready: true,
    reason:
      'the pre-login helper is installed and loaded in the system domain — it can render the login window and post input there; the login password is still typed by a human at the Mac (never stored)',
  };
}

/** Convenience for a stored row: normalize then verdict. Never throws. */
export function preloginHelperReadyFor(
  agent: PreloginHelperAgentLike | null | undefined,
  policy?: { storesOsPassword: boolean },
): PreloginHelperVerdict {
  return preloginHelperVerdict(normalizePreloginHelper(agent?.preloginHelper), policy);
}

// ── Install / revoke plans (the exec seam is injected, like remote-access.ts) ──

/** One privileged step. Mirrors remote-access.ts's MacRemoteStep so the two
 *  privileged surfaces of this ticket read the same way. */
export interface PreloginHelperStep {
  cmd: string;
  args: string[];
  /** The ONE line naming why this step exists — rendered by the CLI. */
  why: string;
}

export interface PreloginHelperIo {
  /** Run a command; never throws — a failure is `{stdout:'', code≠0}`. */
  run(cmd: string, args: string[]): Promise<{ stdout: string; code: number }>;
  /** True when a path exists. */
  exists(path: string): Promise<boolean>;
}

/**
 * The LaunchDaemon plist the installer writes.
 *
 * A LAUNCHDAEMON (system domain), not a LaunchAgent — deliberately, and this is
 * the crux of the ticket: only a job outside every user session survives to the
 * login window, which is exactly the context the existing per-user LaunchAgent
 * cannot reach. `ock`/`ProcessType` are left default so launchd restarts it.
 *
 * The plist carries NO credential key of any kind. It cannot: the helper takes
 * no password (see the module header), so there is nothing to serialize. Pinned
 * by test — a future lane that adds a `Password`/`KeychainItem` key here fails
 * the build, which is the enforcement half of the owner's ruling.
 */
export function renderHelperPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PRELOGIN_HELPER_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <!-- Posts events at the login window on request. It has no credential
         surface: no password argument, no Keychain item, no kcpassword write.
         The OS password is typed by a human at the Mac. -->
    <string>${PRELOGIN_HELPER_BINARY}</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
`;
}

/**
 * The install plan. Every step is root-only, and the sequence is the one that
 * survives a reboot: lay the binary down, write the plist, chown root:wheel,
 * chmod 644 (launchd refuses a group/world-writable daemon plist), THEN
 * bootstrap the system domain, then enable it so a later disable is reversible.
 *
 * `stagedBinary` is where the installer put the signed binary; the plan copies
 * it rather than referencing a path this module invents.
 */
export function planMacHelperInstall(opts: { stagedBinary: string; stagedPlist?: string }): PreloginHelperStep[] {
  const steps: PreloginHelperStep[] = [
    {
      cmd: 'mkdir',
      args: ['-p', PRELOGIN_HELPER_INSTALL_DIR],
      why: 'create the root-owned helper tree (separate from the user agent payload, which a yielding installer may remove)',
    },
    {
      cmd: 'install',
      args: ['-m', '0755', '-o', 'root', '-g', 'wheel', opts.stagedBinary, PRELOGIN_HELPER_BINARY],
      why: 'lay the SIGNED helper binary down root-owned and root-writable only',
    },
    {
      cmd: 'install',
      args: ['-m', '0644', '-o', 'root', '-g', 'wheel', opts.stagedPlist ?? `${opts.stagedBinary}.plist`, PRELOGIN_HELPER_PLIST],
      why: 'install the LaunchDaemon plist 0644 root:wheel — launchd REFUSES a daemon plist that is group- or world-writable',
    },
    {
      cmd: 'launchctl',
      args: ['bootstrap', 'system', PRELOGIN_HELPER_PLIST],
      why: 'load the job into the SYSTEM domain — the domain outside every user session, which is the only reason a daemon is needed',
    },
    {
      cmd: 'launchctl',
      args: ['enable', `system/${PRELOGIN_HELPER_LABEL}`],
      why: 'clear any prior disable so a revoke/reinstall cycle is symmetric',
    },
    {
      cmd: 'launchctl',
      args: ['print', `system/${PRELOGIN_HELPER_LABEL}`],
      why: 'VERIFY the install: print the loaded job (a missing job is the failure this step catches)',
    },
  ];
  return steps;
}

/**
 * The revoke plan — criterion 4 ("revoke removes the daemon/service and any
 * stored credential, verified").
 *
 * BOOTOUT THEN RM, in that order, and the order is load-bearing: launchd loads
 * daemons that EXIST at boot, so removing the plist alone leaves the job running
 * until reboot and a stale binary on disk. This is the same discipline as
 * retire-bundled-helper.ts:128-178, adapted from `gui/<uid>` to the `system`
 * domain a daemon lives in.
 *
 * NOTE WHAT IS ABSENT: there is no credential-deleting step, because option (d)
 * never creates one. That absence is the ruling, not an oversight — the
 * verify function checks for it positively (see verifyMacHelperRevert).
 */
export function planMacHelperRevert(): PreloginHelperStep[] {
  return [
    {
      cmd: 'launchctl',
      args: ['bootout', 'system', PRELOGIN_HELPER_PLIST],
      why: 'stop the running daemon FIRST — launchd reloads any plist that still exists at boot, so removing the file alone leaves it running until reboot',
    },
    {
      cmd: 'launchctl',
      args: ['disable', `system/${PRELOGIN_HELPER_LABEL}`],
      why: 'record the job as disabled in the launchd override database, so a leftover plist cannot resurrect it at the next boot',
    },
    {
      cmd: 'rm',
      args: ['-f', PRELOGIN_HELPER_PLIST],
      why: 'remove the plist — the step that actually ends the resurrect loop',
    },
    {
      cmd: 'rm',
      args: ['-rf', PRELOGIN_HELPER_INSTALL_DIR],
      why: 'remove the helper binary tree (root-owned; no user data lives here)',
    },
    {
      cmd: 'launchctl',
      args: ['print', `system/${PRELOGIN_HELPER_LABEL}`],
      why: 'VERIFY the revoke: print must FAIL (absent job) — a successful print here means the daemon is still loaded',
    },
  ];
}

/**
 * Post-revert verification, pure: given the read-back values, is the device
 * clean? Used by the CLI so "revoked" is a claim with a check behind it rather
 * than a printed intention (the remote-access.ts:570 discipline).
 *
 * `credentialArtifacts` is the positive check for the ruling: by design it must
 * be empty. A non-empty list means something DID store a credential, which is
 * both a failed revoke and an owner-ruling breach worth naming explicitly.
 */
export function verifyMacHelperRevert(reads: {
  plistExists: boolean;
  dirExists: boolean;
  jobLoaded: boolean;
  credentialArtifacts?: string[];
}): { clean: boolean; remaining: string[] } {
  const remaining: string[] = [];
  if (reads.jobLoaded) remaining.push(`${PRELOGIN_HELPER_LABEL} is still loaded in the system domain`);
  if (reads.plistExists) remaining.push(`${PRELOGIN_HELPER_PLIST} still exists`);
  if (reads.dirExists) remaining.push(`${PRELOGIN_HELPER_INSTALL_DIR} still exists`);
  for (const artifact of reads.credentialArtifacts ?? []) {
    remaining.push(`a credential artifact survived the revoke: ${artifact} (option (d) must never create one — this is an owner-ruling breach)`);
  }
  return { clean: remaining.length === 0, remaining };
}

/**
 * The one-line reason a `prelogin-helper status` run prints, from a live probe.
 * Pure, so the CLI and the tests agree on the wording.
 */
export function helperStatusLine(reads: {
  plistExists: boolean;
  jobLoaded: boolean;
  binaryExists: boolean;
}): PreloginHelperVerdict {
  // A LOADED JOB COUNTS AS INSTALLED even if its plist is not where we look:
  // a running pre-login daemon must never be reported as "no helper installed"
  // — that is the reading that would send an operator to install a second copy
  // on top of a live one.
  if (!reads.plistExists && !reads.jobLoaded) {
    return preloginHelperVerdict({ installed: false, loaded: false, blockers: [], off: true });
  }
  const installed = reads.plistExists || reads.jobLoaded;
  const blockers: string[] = [];
  if (reads.plistExists && !reads.binaryExists) blockers.push('no-binary');
  if (installed && !reads.jobLoaded) blockers.push('not-loaded');
  return preloginHelperVerdict({
    installed,
    loaded: reads.jobLoaded,
    blockers,
  });
}