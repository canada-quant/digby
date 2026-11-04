/**
 * The RUNNING-agent stamp (ticket c6e91d19 — "update-only runs but the agent
 * stays 0.6.3").
 *
 * WHY THIS EXISTS: every prior "what version is on this Mac?" answer read a
 * FILE ON DISK (package.json of some tree) — which only proves what was
 * DOWNLOADED, never what launchd actually runs. The ticket's own diagnostic
 * (`cat ~/Library/Application Support/Digby/agent/package.json`) reads a path
 * that never existed, and the owner's uninstall/reinstall cycles kept
 * "succeeding" against a disk tree while a stale 0.6.3 bundled helper (frozen
 * inside the desktop .app, label ai.digby.imessage-agent) stayed the only
 * running poller. One authoritative record fixes the class:
 *
 *   ~/.config/digby-agent/running-agent.json
 *   { version, pid, entry, startedAt }
 *
 * WRITTEN by the agent process itself, first thing in runLoop() — so the file
 * always names the process that is actually polling (last writer wins, and a
 * writer only lives as long as its process does). READ by install.sh after
 * `launchctl load`: the installer now WAITS for this stamp to name the
 * INSTALLED tree's version + entry path and fails loudly when it never does
 * (the "command completes but nothing changed" silent failure this ticket
 * reports). Stable location, outside every agent tree, so a self-update swap
 * (mv agentRoot → .bak) never moves it — same reasoning as the DigbyAgent
 * runtime copy (51d8dbe0).
 *
 * Best-effort by design: an unwritable HOME must never keep the agent from
 * polling. Every helper is safe to call from the run loop.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { AGENT_VERSION } from './config';

/** What the stamp records — the identity of the RUNNING agent process. */
export interface RunningAgentStamp {
  /** The running build's AGENT_VERSION (the value every poll advertises). */
  version: string;
  /** OS pid of the writing process (diagnostics: `ps -p <pid>`). */
  pid: number;
  /** Absolute path of the running dist/index.js — WHICH TREE is live. */
  entry: string;
  /** ISO timestamp of when this process started polling. */
  startedAt: string;
}

export function runningAgentStampPath(home: string = homedir()): string {
  return join(home, '.config', 'digby-agent', 'running-agent.json');
}

/**
 * Write the stamp from the LIVE process. Called once at runLoop() start (and
 * again naturally after every relaunch/self-update — the new process simply
 * overwrites it). Never throws: a Mac whose HOME is unwritable keeps polling;
 * it just cannot answer install.sh's verification (which then fails loudly —
 * the honest outcome).
 */
export function writeRunningAgentStamp(entry: string, home: string = homedir()): RunningAgentStamp | null {
  const stamp: RunningAgentStamp = {
    version: AGENT_VERSION,
    pid: typeof process.pid === 'number' ? process.pid : -1,
    entry,
    startedAt: new Date().toISOString(),
  };
  try {
    const path = runningAgentStampPath(home);
    const dir = join(home, '.config', 'digby-agent');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(stamp, null, 2) + '\n', { mode: 0o600 });
    return stamp;
  } catch {
    return null;
  }
}

/** Read the stamp — null when absent or unreadable (nothing is running / never ran). */
export function readRunningAgentStamp(home: string = homedir()): RunningAgentStamp | null {
  try {
    const path = runningAgentStampPath(home);
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RunningAgentStamp>;
    if (!parsed.version || !parsed.entry) return null;
    return {
      version: String(parsed.version),
      pid: typeof parsed.pid === 'number' ? parsed.pid : -1,
      entry: String(parsed.entry),
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
    };
  } catch {
    return null;
  }
}
