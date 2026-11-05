#!/usr/bin/env node
/**
 * Digby Windows agent — entry point (W0, 2026-09-25).
 *
 * Commands:
 *   digby-win-agent pair     Interactive pairing (enter the code from the Digby web UI)
 *   digby-win-agent run      Run the agent loop (long-poll → execute → return result)
 *   digby-win-agent status   Print config + platform support
 *
 * Mirrors imessage-agent/src/index.ts: same run loop, same UNAUTHORIZED →
 * re-pair semantics, same 5s network-error backoff. The Windows agent
 * advertises platform 'windows' + capabilities ['browser','computer']
 * (advertisement.ts) and NEVER registers iMessage handlers.
 */

import { hostname } from 'os';
import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { AgentConfig, loadConfig, reloadConfig, saveConfig, clearConfig, configPath, getDeviceId } from './config';
import { pairComplete, pollCommand, postResult, AgentCommand, fetchRelayFrames, postRelayFrame, isIdleRelayRefusal, RelayFrame } from './api';
import { executeCommand, GeometryCache, CommandHandlers } from './commands';
import { RustHelperClient, HelperWin32Surface, HelperWin32Input, resolveHelperCommand } from './rust-helper';
import { SafetyGate } from './safety';
import { browserHandlers, ensureChromium } from './browser';
import { AGENT_VERSION, PLATFORM, CAPABILITIES } from './advertisement';
import { runRfbCarrier, nodeSocketOpener } from './relay-rfb';
import {
  probeWinUnattended,
  realWinIo,
  unattendedAdvertValue,
  evaluateWinUnattended,
  BLOCKER_TEXT,
  applyWinPreset,
  revertWinPreset,
  planConsoleReattach,
  buildConsoleReattachCommand,
  UnattendedRefusal as WinUnattendedRefusal,
} from './unattended';
import {
  probeWinRemoteAccess,
  probeWinRemoteListener,
  realWinRemoteIo,
  evaluateWinRemoteAccess,
  remoteAccessAdvertValue as winRemoteAccessAdvertValue,
  planWinRemoteEnable,
  planWinRemoteRevert,
  runWinRemotePlan,
  verifyWinRemoteRevert,
  FIREWALL_RULE_NAME,
  TS_KEY,
  DEFAULT_TUNNEL_CIDR,
} from './remote-access';

const DEFAULT_API_BASE = 'https://digby.ai/api';

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Console prompt (W0: no native dialog yet — W2's WebView2 shell adds one). */
async function promptCode(): Promise<string | null> {
  // Hidden/autostart spawns (the Run key, the shell's setupIMessage spawn) have
  // no console stdin — rl.question would hang forever waiting for input that
  // can never arrive. Only prompt when stdin is REALLY an interactive TTY;
  // non-interactive contexts must pair via DIGBY_PAIR_CODE (env) instead.
  if (!process.stdin.isTTY) return null;
  try {
    const rl = createInterface({ input, output });
    const answer = await rl.question('Enter the pairing code from the Digby web UI (XXXX-XXXX): ');
    rl.close();
    const clean = answer.trim().toUpperCase();
    return clean ? clean : null;
  } catch {
    return null;
  }
}

async function ensurePaired(): Promise<AgentConfig | null> {
  const existing = loadConfig();
  if (existing) return existing;

  const apiBaseUrl = (process.env.DIGBY_API_URL || '').trim() || DEFAULT_API_BASE;
  const deviceName = hostname();

  // Non-interactive pairing when a code is supplied via env (the W2 installer
  // uses this — the macOS app's LaunchAgent DIGBY_PAIR_CODE pattern).
  const envCode = (process.env.DIGBY_PAIR_CODE || '').trim().replace(/[^A-Za-z0-9-]/g, '');
  const code = envCode || (await promptCode());
  if (!code) return null;

  try {
    const deviceId = getDeviceId();
    const { agentId, agentToken } = await pairComplete(apiBaseUrl, code, deviceName, deviceId);
    const config: AgentConfig = { apiBaseUrl, agentId, agentToken, deviceId };
    saveConfig(config);
    log(`Paired — agent ${agentId.slice(0, 8)}… (device ${deviceId.slice(0, 8)}…)`);
    return config;
  } catch (e: any) {
    log(`Pairing failed: ${e?.message || e}`);
    return null;
  }
}

async function cmdPair(): Promise<void> {
  const config = await ensurePaired();
  if (!config) {
    log('Not paired. Get a code from Digby → Account → Integrations, then run `digby-win-agent pair`.');
    process.exitCode = 1;
  }
}

async function cmdStatus(): Promise<void> {
  const config = loadConfig();
  console.log(`Digby Windows agent v${AGENT_VERSION}`);
  console.log(`  platform:     ${PLATFORM}`);
  console.log(`  capabilities: ${CAPABILITIES.join(', ')}`);
  console.log(`  config:       ${configPath()}`);
  console.log(`  paired:       ${config ? `yes (agent ${config.agentId.slice(0, 8)}…, device ${(config.deviceId || 'legacy').slice(0, 8)}…)` : 'no'}`);
  console.log(`  api:          ${config?.apiBaseUrl || DEFAULT_API_BASE}`);
  const helper = resolveHelperCommand();
  console.log(`  win32 layer:  W3 — Rust helper (${helper ? helper.cmd : 'NOT found — computer_* will refuse cleanly; set DIGBY_WIN_HELPER or reinstall the agent bundle'})`);
}

async function cmdRun(): Promise<void> {
  // Unattended-preset drift surfacing (2026-10-28): the last advert we logged,
  // so a reverted setting is logged ONCE per flip (never every poll).
  let lastUnattendedAdvert = '';
  // Brokered-remote-access drift surfacing (ticket c468f922, owner ruling
  // 2026-10-29): last advert logged, so an exposure/drift flip logs ONCE.
  let lastRemoteAccessAdvert = '';
  // TICKET 11b6974f: `let`, not `const` — the loop re-reads this from disk on
  // every poll (see the reloadConfig call at the top of the loop body).
  // `unattended enable` / `remote-access enable` are SEPARATE processes that
  // persist by rewriting config.json; a daemon holding a startup snapshot both
  // advertises a stale preset forever AND clobbers the CLI's write on its next
  // saveConfig.
  let config = await ensurePaired();
  if (!config) {
    // Exit 0 BY DESIGN for unattended launches (the Run-key autostart bat, the
    // shell's setupIMessage spawn): a non-zero exit makes the Run key's
    // fail-loop relaunch us every login with no code to pair. `digby-win-agent
    // pair` (the interactive path) still reports failure via cmdPair's exit 1.
    const hadCode = !!(process.env.DIGBY_PAIR_CODE || '').trim();
    log(
      hadCode
        ? 'Pairing with the supplied code failed — will retry on next launch.'
        : 'Not paired (no code supplied and no console). Run `digby-win-agent pair` to pair.',
    );
    return;
  }

  // The platform seam. W3: the Rust helper client (lazy spawn — falls back
  // to the null seam when the helper binary is absent, so every computer_*
  // command refuses cleanly instead of crashing); the Playwright browser
  // handlers NEVER touch the helper (a helper failure must not take
  // browser_* down).
  const helper = new RustHelperClient();
  const surface = new HelperWin32Surface(helper);
  const input = new HelperWin32Input(helper);
  const safety = new SafetyGate(
    { environment: () => import('./rust-helper').then((m) => m.environmentCheck(helper)) },
    { antiCheatProcesses: loadConfig()?.antiCheatProcesses },
  );
  const deps: CommandHandlers = {
    surface,
    input,
    helper,
    safety,
    browser: browserHandlers(),
  };
  const geometry: GeometryCache = { imageWidth: 0, imageHeight: 0, screenWidth: 0, screenHeight: 0 };

  const helperFound = !!resolveHelperCommand();
  log(`Agent loop started (v${AGENT_VERSION}, platform ${PLATFORM}, capabilities ${CAPABILITIES.join('/')}${helperFound ? ', Rust helper' : ', Rust helper NOT found — computer_* will refuse'})`);
  // One-time local-browser setup in the background (the macOS agent pattern):
  // the agent ships the Playwright package but NOT the ~170MB Chromium
  // binary — fetch it now so the first browser_* command usually finds it
  // ready. Best-effort: the loop must keep working even if this fails.
  ensureChromium().catch((e) => log(`⚠️  background Chromium setup failed (browser commands will retry on demand): ${e?.message || e}`));
  for (;;) {
    // TICKET 11b6974f: re-read the config EVERY poll. `unattended enable` /
    // `remote-access enable` run in a SEPARATE process and persist by rewriting
    // config.json; a daemon holding its startup snapshot re-advertised a stale
    // preset forever AND clobbered the CLI's write on its next saveConfig.
    config = reloadConfig(config);
    let command: AgentCommand | null = null;
    try {
      // "Unattended / Autonomous use" preset advert (2026-10-28, owner request
      // oq_f7955582). The detector re-reads every setting the preset owns on
      // EVERY poll — that is the drift detector: a Windows update or a policy
      // refresh silently resets auto-logon, and the fleet must see
      // "unattended-ready: NO — <reason>" instead of a lane discovering a
      // sign-in screen hours later. `off` when the preset is off (opt-in) —
      // reported, never omitted, so the fleet can tell "not enabled" from
      // "this build cannot report it" (ticket 11b6974f).
      let unattendedAdvert = '';
      try {
        const snap = await probeWinUnattended(realWinIo, {
          user: config.unattended?.backup?.user || process.env.USERNAME || '',
          enabled: !!config.unattended?.enabled,
        });
        unattendedAdvert = unattendedAdvertValue(snap);
        const verdictKey = unattendedAdvert || 'off';
        if (verdictKey !== lastUnattendedAdvert) {
          lastUnattendedAdvert = verdictKey;
          const v = evaluateWinUnattended(snap);
          if (v.enabled && v.blockers.length > 0) {
            log(`⚠️  unattended-ready: NO — ${v.blockers.map((b) => BLOCKER_TEXT[b]).join('; ')}`);
          } else if (v.enabled) {
            log('✅ unattended-ready: YES (auto-logon + no lock + no sleep all hold)');
          }
        }
      } catch { /* best-effort — the advert must never break the poll */ }
      // ── BROKERED REMOTE ACCESS advert (ticket c468f922, OWNER RULING
      // 2026-10-29: "can we do option three but a little more secure like how
      // it's just like TeamViewer") ──
      // Re-probed on EVERY poll: a policy refresh can re-enable RDP without NLA
      // or reset the firewall scope, and the fleet must SEE that as `exposed`
      // rather than a lane discovering a public RDP port later.
      //
      // `off` is advertised from a LIVE PROBE, not from config (owner ruling
      // 2026-10-30, health-line item 2). A user who enables Remote Desktop in
      // Settings by hand has a listener the config does not know about; asking
      // the OS means that case surfaces as `on`+`exposed` instead of silently
      // reading "off". Unknown emits nothing (absent-never-clobbers).
      let remoteAccessAdvert = '';
      try {
        const listener = config.remoteAccess?.enabled ? true : await probeWinRemoteListener(realWinRemoteIo);
        if (listener === true) {
          const snap = await probeWinRemoteAccess(realWinRemoteIo, {
            channelAccount: config.remoteAccess?.account ?? null,
            tunnelCidr: config.remoteAccess?.tunnelCidr || DEFAULT_TUNNEL_CIDR,
            tunnelBound: config.remoteAccess?.tunnelOnly === true,
          });
          const verdict = evaluateWinRemoteAccess(snap);
          remoteAccessAdvert = winRemoteAccessAdvertValue({
            enabled: verdict.enabled,
            tunnelOnly: config.remoteAccess?.tunnelOnly === true,
            blockers: verdict.blockers,
            off: !verdict.enabled,
          });
          if (remoteAccessAdvert !== lastRemoteAccessAdvert) {
            lastRemoteAccessAdvert = remoteAccessAdvert;
            if (verdict.blockers.length > 0) {
              log(`⚠️  remote-access: NOT ready — ${verdict.blockers.join('; ')} (run \`digby-win-agent remote-access status\`)`);
            } else if (verdict.enabled) {
              log('✅ remote-access: ready (tunnel-scoped, NLA, dedicated account)');
            } else {
              log('✅ remote-access: off — nothing is listening (the default; opt in per device to enable)');
            }
          }
        } else if (listener === false) {
          remoteAccessAdvert = winRemoteAccessAdvertValue({ enabled: false, tunnelOnly: false, blockers: [], off: true });
          if (remoteAccessAdvert !== lastRemoteAccessAdvert) {
            lastRemoteAccessAdvert = remoteAccessAdvert;
            log('✅ remote-access: off — nothing is listening (the default; opt in per device to enable)');
          }
        }
      } catch { /* best-effort — the advert must never break the poll */ }
      // Remote-unlock: the ONE mechanically recoverable case (2026-10-28). A
      // DISCONNECTED session (an RDP/screen-share drop) leaves the desktop alive
      // but off the console, so the fleet sees a dark box. `tscon <id>
      // /dest:console` re-attaches it. Gated on the preset being enabled and on
      // `query user` really showing a Disc row — planConsoleReattach() refuses
      // everything else (Active, services, no session, opt-out device).
      if (config.unattended?.enabled) {
        try {
          const qu = await realWinIo.run('query', ['user']);
          const plan = planConsoleReattach(qu.stdout, { enabled: true });
          if (plan) {
            const { cmd, args } = buildConsoleReattachCommand(plan);
            const r = await realWinIo.run(cmd, args);
            log(r.code === 0
              ? `↩ re-attached disconnected session to the console (${plan.reason})`
              : `⚠ could not re-attach session ${plan.sessionId} (tscon exit ${r.code}) — needs elevation or the session is gone`);
          }
        } catch { /* never fatal: the verdict still reports `locked` */ }
      }
      command = await pollCommand(config, unattendedAdvert || null, remoteAccessAdvert || null);
      // ── RELAY PUMP (ticket c468f922) ──
      // Runs after every successful poll so a brokered session carries frames on
      // the same beat the command channel uses. Best-effort and self-contained:
      // `pumpRelay` swallows its own failures, because losing the relay must
      // never cost this PC the command channel that repairs it.
      await pumpRelay(config);
    } catch (e: any) {
      if (e?.message === 'UNAUTHORIZED') {
        log('Token rejected (unpaired or revoked) — clearing config; re-pair to continue.');
        clearConfig();
        process.exit(1); // the service manager relaunches → re-pair
      }
      log(`Poll failed: ${e?.message || e} — retrying in 5s`);
      await sleep(5000);
      continue;
    }
    if (!command) continue; // empty poll window — re-poll immediately

    log(`Command ${command.cmdId.slice(0, 8)}… ${command.method}`);
    const out = await executeCommand(command.method, command.params || {}, deps, geometry);
    if (out.ok) {
      log(`  → ok`);
    } else {
      log(`  → error: ${out.error}`);
    }
    await postResult(config, command.cmdId, out.ok, out.result, out.error);
  }
}

/**
 * ── RELAY PUMP (ticket c468f922) — the PC's dial-OUT for a brokered session ──
 *
 * Independent review of the first cut found the relay had a server and no
 * client. This is the client's engine: on every loop tick it (1) drains frames
 * the operator queued for this PC and (2) flushes anything this PC has queued
 * back. Both are requests THIS process initiates — there is no inbound port, so
 * the backend still cannot reach this PC and a home NAT is no obstacle.
 *
 * Deliberately NOT wired to capture/input yet. The request scoped this slice to
 * a dial-out channel that demonstrably CARRIES an authorized session's byte
 * stream, with payloads allowed to be minimal or mocked. So the pump moves bytes
 * and hands them to a handler seam; the RDP codec and the real screen/input
 * producers are the next slice. Wiring a fake screen producer in here would make
 * it look finished while carrying nothing anyone can use.
 *
 * RATE: one relay poll per loop tick, the same cadence as the command channel.
 * A real screen stream will need its own tighter pump — stated rather than
 * pretended.
 */
interface RelayPumpState {
  sessionId: string | null;
  /** Last sequence number received from the operator. */
  cursor: number;
  /** Last refusal we LOGGED, so an idle PC does not spam the log every tick. */
  lastLoggedRefusal: string;
}

const relayPump: RelayPumpState = { sessionId: null, cursor: 0, lastLoggedRefusal: '' };

/** Frames this PC wants to send to the operator, drained by the pump. */
const relayOutbox: RelayFrame[] = [];

/**
 * The live RFB carrier for the brokered session, or null when none is running.
 *
 * ── WHY THIS EXISTS (post-merge review of PR #2341) ────────────────────────
 * The review found "the relay had a server and NO CLIENT": `queueRelayFrame`
 * below had no callers at all, so nothing on this PC ever produced a byte for
 * the operator, and the backend's Windows/RFB decoder could never run against a
 * real stream. This is the client half — it dials the RFB server already
 * running on this PC and hands its bytes to the outbox below.
 */
let relayCarrier: Awaited<ReturnType<typeof runRfbCarrier>> | null = null;

/**
 * Is a carrier START in flight (dialled, handshaking, not yet returned)?
 *
 * ── WHY A SECOND FLAG IS REQUIRED (review finding D2) ──────────────────────
 * `relayCarrier` is only assigned AFTER `runRfbCarrier`'s promise resolves, but
 * `startRelayCarrier` is called from `pumpRelay` on every tick (5 s). So for the
 * whole connect+handshake window — longer than a tick when the RFB server is
 * slow or briefly down — `relayCarrier` was still null and the `if (relayCarrier)
 * return` guard did nothing: every tick started ANOTHER carrier, each opening
 * its own socket to 5900 and its own relay stream.
 *
 * This flag is set SYNCHRONOUSLY before the first await, so the guard actually
 * guards from the first call onwards.
 */
let relayCarrierStarting = false;

/** Where this PC's own RFB server listens (the port the firewall anchor scopes). */
function rfbTarget(): { host: string; port: number } {
  const host = process.env.DIGBY_RFB_HOST || '127.0.0.1';
  const port = Number(process.env.DIGBY_RFB_PORT || 5900);
  return { host, port: Number.isFinite(port) ? port : 5900 };
}

/** Start carrying a real RFB stream for this session, if one is not already up. */
function startRelayCarrier(): void {
  // BOTH checks are needed: `relayCarrier` covers a RUNNING carrier,
  // `relayCarrierStarting` covers the connect+handshake window before it exists.
  if (relayCarrier || relayCarrierStarting) return;
  relayCarrierStarting = true;
  const { host, port } = rfbTarget();
  // Fire and forget: `runRfbCarrier` never rejects (a failed connect is a
  // `failed` state), so nothing can throw into the poll loop.
  void runRfbCarrier({
    host,
    port,
    openSocket: nodeSocketOpener(),
    emit: (chunk) => queueRelayFrame(chunk.payloadB64),
    log: (line) => log(line),
  })
    .then((carrier) => {
      relayCarrierStarting = false;
      // A `failed` carrier (no RFB server on this PC) must NOT be cached: the
      // next tick should retry, because the server may be started later. Caching
      // a dead carrier would leave the PC permanently unable to carry even after
      // the operator fixed the cause.
      if (carrier.state === 'failed' || carrier.state === 'closed') {
        log(`relay: carrier did not come up (${carrier.state}) — will retry next tick`);
        return;
      }
      relayCarrier = carrier;
    })
    .catch((err: Error) => {
      relayCarrierStarting = false;
      log(`relay: carrier could not start — ${err.message}`);
    });
}

/** Tear the carrier down — the session ended, so its stream is not ours to keep. */
function stopRelayCarrier(why: string): void {
  if (!relayCarrier) return;
  relayCarrier.stop();
  relayCarrier = null;
  log(`relay: carrier stopped — ${why}`);
}

/** Queue a frame for the operator. `payload` is base64 and stays opaque. */
export function queueRelayFrame(payloadB64: string, final = false): void {
  // Bounded: an unattended PC must not grow this without limit if nobody is
  // reading (the backend returns queue-full; this is the mirror of that guard).
  if (relayOutbox.length >= 256) relayOutbox.shift();
  relayOutbox.push({ seq: 0, payloadB64, sentAt: Date.now(), ...(final ? { final: true } : {}) });
}

/**
 * One pump tick. Never throws into the poll loop: a relay problem must not cost
 * this PC the command channel, which is how it gets repaired.
 */
async function pumpRelay(config: AgentConfig): Promise<void> {
  // ── Drain what the operator sent us ──
  try {
    const out = await fetchRelayFrames(config, relayPump.cursor);
    if (out.ok) {
      relayPump.sessionId = out.data.sessionId ?? relayPump.sessionId;
      relayPump.cursor = out.data.cursor;
      relayPump.lastLoggedRefusal = '';
      // A session is live: start carrying the PC's real RFB stream into it.
      // Idempotent — `startRelayCarrier` returns immediately when one is up.
      startRelayCarrier();
      for (const frame of out.data.frames) {
        // The operator's OWN input comes down this channel already encoded as
        // RFB client messages (PointerEvent/KeyEvent), so it is forwarded
        // verbatim to the RFB server. Bytes the backend encoded must not be
        // re-interpreted here: a second copy of the wire format is exactly the
        // drift this slice exists to remove.
        if (relayCarrier && relayCarrier.state === 'carrying') {
          relayCarrier.write(Buffer.from(frame.payloadB64, 'base64'));
        } else {
          // Nothing to forward INTO yet (the PC's RFB server is down or the
          // carrier is still handshaking). Say so once rather than silently
          // dropping operator input, which would read as an unresponsive PC.
          log(`relay frame #${frame.seq} received (${frame.payloadB64.length}b) — no RFB session to forward into`);
        }
      }
    } else if (!isIdleRelayRefusal(out.code)) {
      // Idle refusals (no-session / not-open / stale) are the NORMAL steady
      // state on a paired PC nobody is brokering — logging them each tick would
      // bury a real failure in noise.
      if (relayPump.lastLoggedRefusal !== out.code) {
        relayPump.lastLoggedRefusal = out.code;
        log(`relay: ${out.code} — not carrying frames`);
      }
    } else if (relayPump.sessionId) {
      // A session we WERE serving just ended (closed or stale). Drop our cursor
      // so the next session starts clean rather than inheriting a position that
      // would skip its first frames.
      relayPump.sessionId = null;
      relayPump.cursor = 0;
    }
  } catch {
    /* best-effort — the next tick retries */
  }

  // ── Flush anything we owe the operator ──
  while (relayOutbox.length > 0) {
    const frame = relayOutbox[0];
    const res = await postRelayFrame(config, frame.payloadB64, frame.final === true);
    if (!res.ok) {
      // Leave it queued when the refusal is transient/backpressure; drop it when
      // the session is simply not open, or the outbox would replay a dead
      // session's frames into the NEXT one.
      if (isIdleRelayRefusal(res.code)) relayOutbox.length = 0;
      break;
    }
    relayOutbox.shift();
  }
}

/**
 * `digby-win-agent unattended <status|enable|disable>` — the Windows preset CLI
 * (2026-10-28, owner request on card oq_f7955582: "how can you fix this for all
 * mac and windows clients to give full remote login permissions … this will be
 * a requirement for most users to use their remote devices autonomously").
 *
 * SECURITY POSTURE, enforced by this function's shape:
 *   - the account password is read from the LOCAL console (never argv, never an
 *     env var, never the pairing config, never the network) and is used exactly
 *     once, piped on STDIN into the LSA-secret write;
 *   - `enable` captures the pre-change registry/powercfg values into the config
 *     BEFORE changing anything, so `disable` can always restore them;
 *   - nothing here ever prints the password.
 */
async function cmdUnattended(argv: string[]): Promise<void> {
  const sub = (argv[0] || 'status').toLowerCase();
  const config = loadConfig();
  const user = process.env.USERNAME || '';
  const enabled = !!config?.unattended?.enabled;

  if (sub === 'status') {
    const snap = await probeWinUnattended(realWinIo, { user: config?.unattended?.backup?.user || user, enabled });
    const v = evaluateWinUnattended(snap);
    console.log(`Unattended preset: ${v.enabled ? 'ENABLED' : 'OFF (opt-in, per device)'}`);
    console.log(`Unattended-ready:  ${v.enabled && v.blockers.length === 0 ? 'YES' : 'NO'}`);
    for (const b of v.blockers) console.log(`  - ${b}: ${BLOCKER_TEXT[b]}`);
    console.log(
      `bitlockerPin=${snap.bitlockerPin} credGuard=${snap.credentialGuard} autoLogon=${snap.autoAdminLogon} ` +
      `lsaSecret=${snap.lsaSecretPresent} noLockScreen=${snap.noLockScreen} ` +
      `inactivity=${snap.inactivityTimeoutSecs} acStandby=${snap.acStandbyMinutes} ` +
      `hello=${snap.helloOnly} domain=${snap.domainPolicy} atLock=${snap.atLockScreen} elevated=${snap.elevated}`,
    );
    console.log('Nothing was changed (status is read-only).');
    return;
  }

  if (sub === 'enable') {
    if (!config) {
      console.error('Not paired — run `digby-win-agent pair` first (the fleet can only see a paired device).');
      process.exitCode = 1;
      return;
    }
    const loginUser = (argv[1] || user).trim();
    console.log(`Enabling the unattended preset for "${loginUser}".`);
    console.log("This LOWERS this PC's security while it is enabled: anyone with physical access to the");
    console.log('signed-in machine can use it, and the account password is kept in the LSA secret store');
    console.log('(recoverable by an administrator on this PC — that is a documented Windows property).');
    console.log('`digby-win-agent unattended disable` restores every prior setting.');
    const password = await readSecretConsole('Windows account password (input hidden, used once for the LSA secret): ');
    if (!password) {
      console.error('No password entered — nothing was changed.');
      process.exitCode = 1;
      return;
    }
    try {
      const r = await applyWinPreset(realWinIo, { user: loginUser, password, loginUser });
      saveConfig({ ...config, unattended: { enabled: true, backup: r.backup, enabledAt: new Date().toISOString() } });
      console.log(`\n✓ Applied: ${r.applied.join(', ')}`);
      if (r.skipped.length) console.log(`⚠️  Skipped: ${r.skipped.join(', ')}`);
      console.log('The agent now advertises `unattended=on,ok` (or the blocker it finds) on every poll,');
      console.log('so the fleet shows this PC as UNATTENDED-READY instead of filing an unlock card.');
    } catch (e: any) {
      if (e instanceof WinUnattendedRefusal) {
        console.error(`\n✗ Cannot enable on this PC — ${e.message}`);
        process.exitCode = 2;
        return;
      }
      throw e;
    }
    return;
  }

  if (sub === 'disable') {
    if (!config) {
      console.error('Not paired — nothing to disable.');
      process.exitCode = 1;
      return;
    }
    const backup = config.unattended?.backup;
    if (!backup) {
      console.error('No captured pre-change values — the preset was never applied from this PC. Nothing changed.');
      process.exitCode = 1;
      return;
    }
    const r = await revertWinPreset(realWinIo, backup);
    saveConfig({ ...config, unattended: { enabled: false, backup } });
    console.log(`\n✓ Restored: ${r.reverted.join(', ')}`);
    console.log('The preset is OFF — this PC locks and sleeps normally again, and the fleet shows');
    console.log('unattended-ready: NO (preset not enabled).');
    return;
  }

  console.log('Usage: digby-win-agent unattended <status|enable [loginUser]|disable>');
  process.exitCode = 1;
}

/**
 * `digby-win-agent remote-access <status|enable <account> [tunnelCidr]|disable>`
 * — the BROKERED REMOTE ACCESS CLI (ticket c468f922, OWNER RULING 2026-10-29 on
 * card oq_b5118c38: "can we do option three but a little more secure like how
 * it's just like TeamViewer").
 *
 * WHAT IT DOES: provisions the OS's OWN remote channel (Remote Desktop) under
 * the hardened posture — a Defender Firewall rule scoping 3389 to the tunnel
 * BEFORE TermService can listen, Network Level Authentication REQUIRED, and a
 * DEDICATED channel account (never the primary/auto-logon account).
 *
 * ⚠ THE CORRECTED PREMISE, stated where an operator will read it: RDP does NOT
 * unlock a locked console — it creates a session BESIDE it. What RDP gives us is
 * a NEW interactive session for the connecting account, which is the capability
 * the lane needed. `tscon /dest:console` (already shipped) is the separate
 * re-attach path for a DISCONNECTED session.
 *
 * SECURITY POSTURE, enforced by this function's shape:
 *   - it NEVER accepts, stores or sets a password — for the primary account or
 *     any other. The dedicated account is created by an administrator on the
 *     device (Control Panel / `net user`), so this module is structurally
 *     incapable of putting the machine's real login password behind a listening
 *     service;
 *   - `disable` is a VERIFIED revoke: it re-reads fDenyTSConnections and the
 *     firewall rule and reports survivors rather than printing "done".
 */
async function cmdRemoteAccess(argv: string[]): Promise<void> {
  const sub = (argv[0] || 'status').toLowerCase();
  const config = loadConfig();
  const enabled = !!config?.remoteAccess?.enabled;
  const cidr = config?.remoteAccess?.tunnelCidr || DEFAULT_TUNNEL_CIDR;

  if (sub === 'status') {
    const snap = await probeWinRemoteAccess(realWinRemoteIo, {
      channelAccount: config?.remoteAccess?.account ?? null,
      tunnelCidr: cidr,
      tunnelBound: config?.remoteAccess?.tunnelOnly === true,
    });
    const v = evaluateWinRemoteAccess(snap);
    console.log(`Brokered remote access: ${v.enabled ? 'ENABLED' : 'OFF (opt-in, per device)'}`);
    console.log(`Remote-ready:           ${v.enabled && v.blockers.length === 0 ? 'YES' : 'NO'}`);
    for (const b of v.blockers) console.log(`  - ${b}`);
    console.log(`rdpEnabled=${snap.rdpEnabled} nla=${snap.nlaRequired} scopedToTunnel(${cidr})=${snap.firewallScopedToTunnel} ` +
      `channelAccount=${snap.channelAccount ?? '(none)'} primaryAccount=${snap.primaryAccount ?? '(none)'} ` +
      `tunnelBound=${snap.tunnelBound}`);
    console.log('Nothing was changed (status is read-only).');
    return;
  }

  if (sub === 'enable') {
    if (!config) {
      console.error('Not paired — run `digby-win-agent pair` first (the fleet can only see a paired device).');
      process.exitCode = 1;
      return;
    }
    const account = (argv[1] || '').trim();
    const tunnelCidr = (argv[2] || DEFAULT_TUNNEL_CIDR).trim();
    if (!account) {
      console.error('Usage: digby-win-agent remote-access enable <dedicatedAccount> [tunnelCidr]');
      console.error('');
      console.error('The account MUST be a dedicated account for brokered access — NOT the account');
      console.error('this PC auto-logs-in as. Create it first (Settings → Accounts, or `net user`),');
      console.error('then re-run this. This command never sets or stores a password.');
      process.exitCode = 1;
      return;
    }
    console.log(`Enabling BROKERED remote access (RDP) for dedicated account "${account}",`);
    console.log(`firewalled to the tunnel range "${tunnelCidr}".`);
    console.log('');
    console.log('This ENABLES a listening service on this PC. The protections are:');
    console.log(`  - the firewall rule allows 3389 ONLY from ${tunnelCidr} (Windows cannot bind`);
    console.log('    TermService to one interface — the firewall is the boundary);');
    console.log('  - Network Level Authentication is REQUIRED (the host authenticates before');
    console.log('    allocating a session, removing the pre-auth surface RDP brute-force targets);');
    console.log(`  - access is scoped to "${account}" — a DEDICATED account, never the one this`);
    console.log('    PC auto-logs-in as (this command never sets or stores any password).');
    console.log('RDP creates a session BESIDE a locked console; it does not unlock one.');
    console.log('`digby-win-agent remote-access disable` removes all of it, verified.');
    const results = await runWinRemotePlan(realWinRemoteIo, planWinRemoteEnable({ tunnelCidr }));
    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      console.error('\n✗ Enable did NOT fully apply — revoking to a known-safe state:');
      for (const f of failed) console.error(`  - ${f.cmd}: ${f.why} (exit ${f.code})`);
      await runWinRemotePlan(realWinRemoteIo, planWinRemoteRevert());
      process.exitCode = 2;
      return;
    }
    for (const r of results) console.log(`✓ ${r.cmd} — ${r.why}`);
    saveConfig({
      ...config,
      remoteAccess: {
        enabled: true,
        account,
        tunnelCidr,
        // A local probe cannot attest the OUTBOUND broker binding, so this stays
        // false until the broker path confirms it — which makes the fleet show
        // "not ready" rather than a false green.
        tunnelOnly: false,
        enabledAt: new Date().toISOString(),
      },
    });
    console.log('\nThe channel is up and firewalled to the tunnel.');
    console.log('The fleet will show remote-ready: NO until the brokered tunnel binding is confirmed');
    console.log('(deliberate — an unprovable exposure boundary never reads as ready).');
    return;
  }

  if (sub === 'disable') {
    if (!config) {
      console.error('Not paired — nothing to disable.');
      process.exitCode = 1;
      return;
    }
    const results = await runWinRemotePlan(realWinRemoteIo, planWinRemoteRevert());
    for (const r of results) console.log(`${r.ok ? '✓' : '⚠️ '} ${r.cmd} — ${r.why}`);
    const [deny, fw] = await Promise.all([
      realWinRemoteIo.run('reg', ['query', TS_KEY, '/v', 'fDenyTSConnections']),
      realWinRemoteIo.run('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${FIREWALL_RULE_NAME}`, 'verbose']),
    ]);
    const check = verifyWinRemoteRevert({ fDenyTsConnections: deny.stdout, firewallRule: fw.stdout });
    saveConfig({
      ...config,
      remoteAccess: { enabled: false, account: config.remoteAccess?.account, tunnelCidr: cidr },
    });
    if (check.clean) {
      console.log('\n✓ Revoked and VERIFIED: Remote Desktop is denied and the scoped firewall rule is gone.');
    } else {
      console.error('\n⚠️  Revoked, but VERIFICATION FOUND REMAINDERS:');
      for (const r of check.remaining) console.error(`  - ${r}`);
      process.exitCode = 2;
    }
    return;
  }

  console.log('Usage: digby-win-agent remote-access <status|enable <dedicatedAccount> [tunnelCidr]|disable>');
  process.exitCode = 1;
}

/**
 * Read a secret from the LOCAL console with echo disabled.
 *
 * REFUSES in a non-interactive shell rather than reading a secret from a pipe:
 * a password sitting in a script file or a shell history is exactly the mistake
 * this restriction prevents. The value lives only in this process's memory for
 * the length of the LSA write.
 */
function readSecretConsole(promptText: string): Promise<string> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      console.error('Refusing to read a password from a non-interactive shell — run this in a terminal window.');
      resolve('');
      return;
    }
    process.stdout.write(promptText);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          stdin.setRawMode?.(wasRaw ?? false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(buf);
          return;
        }
        if (ch === '\u0003') {
          stdin.setRawMode?.(wasRaw ?? false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve('');
          return;
        }
        if (ch === '\u007f' || ch === '\b') { buf = buf.slice(0, -1); continue; }
        buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  const cmd = process.argv[2] || 'run';
  switch (cmd) {
    case 'pair': return cmdPair();
    case 'status': return cmdStatus();
    case 'run': return cmdRun();
    case 'unattended': return cmdUnattended(process.argv.slice(3));
    // ── BROKERED REMOTE ACCESS (ticket c468f922, owner ruling 2026-10-29) ─
    // `status`  — read-only verdict (what the fleet sees), no changes.
    // `enable`  — firewall scope FIRST, then NLA, then TermService; scoped
    //             to a DEDICATED account. Never sets or stores a password.
    // `disable` — verified revoke: re-reads fDenyTSConnections + the rule
    //             and reports survivors rather than printing "done".
    case 'remote-access': return cmdRemoteAccess(process.argv.slice(3));
    default:
      console.log(`Digby Windows agent v${AGENT_VERSION} (W0 scaffold)`);
      console.log('');
      console.log('Usage:');
      console.log('  digby-win-agent pair                    Pair with a code from the Digby web UI');
      console.log('  digby-win-agent run                     Run the agent loop (long-poll)');
      console.log('  digby-win-agent status                  Print config + platform support');
      console.log('  digby-win-agent unattended status       Read-only: the unattended-preset verdict');
      console.log('  digby-win-agent unattended enable       Apply the preset (needs elevation; password prompt hidden)');
      console.log('  digby-win-agent unattended disable      The kill switch: restore every captured value');
      process.exitCode = 1;
  }
}

main().catch((e) => {
  log(`Fatal: ${e?.message || e}`);
  process.exit(1);
});
