/**
 * Repo-level deterministic tool hooks (harness roadmap item 2, owner 2026-09-19).
 *
 * The Claude Code PreToolUse / PostToolUse idea, scoped to the PROJECT: a repo
 * declares, in its own `.digby/config.json`, what must happen around the
 * agent's tool calls — format-on-edit, lint --fix, a forbidden command shape —
 * and the harness runs it deterministically, no model judgment involved.
 *
 *   "hooks": {
 *     "postEdit":   [ { "run": "npx prettier --write {file}", "match": "**\/*.{ts,tsx,js}", "timeoutMs": 20000 } ],
 *     "preCommand": [ { "block": "git push --force", "message": "Force-pushes are forbidden in this repo — open a PR." },
 *                     { "block": "/rm -rf \\s+\\//", "message": "Destructive rm at the root is refused." } ]
 *   }
 *
 * - postEdit hooks run AFTER edit_file / write_file on a matching path
 *   (`{file}` = the worktree-relative path, shell-quoted); their outcome is
 *   appended to the tool result as a `[post-edit hook]` line — the file is
 *   already on disk, so a hook can reformat it, and the agent sees what
 *   happened. They never block.
 * - preCommand hooks are matched against run_command BEFORE execution; a
 *   match refuses the command with the project's own message. This is the
 *   PROJECT's rule from the PROJECT's config — the platform adds no gate of
 *   its own (gate-flip doctrine 2026-09-11): with no `hooks` section nothing
 *   changes.
 *
 * Bounds: ≤ REPO_HOOKS_MAX per kind, commands ≤ 500 chars, per-hook timeout
 * clamped to REPO_HOOK_MAX_TIMEOUT_MS, output tail ≤ 600 chars. Config is
 * re-read at most every 30 s per worktree.
 */

import * as path from 'path';
import { readDigbyConfig } from './verify.service';
import logger from '../../../utils/logger';
import { recordLoopMetric, LOOP_METRIC_KINDS } from '../platform/loop-metrics.service';

export const REPO_HOOKS_MAX = 8;
export const REPO_HOOK_DEFAULT_TIMEOUT_MS = 20_000;
export const REPO_HOOK_MAX_TIMEOUT_MS = 60_000;
export const REPO_HOOK_OUTPUT_TAIL = 600;
const CONFIG_MEMO_MS = 30_000;

export interface PostEditHook { run: string; match?: string; timeoutMs: number }
export interface PreCommandHook { block: string; message: string; regex: RegExp }
export interface RepoHooks { postEdit: PostEditHook[]; preCommand: PreCommandHook[] }
/** The raw shape as written in .digby/config.json (validated by parseRepoHooks). */
export interface RepoHooksConfig {
  postEdit?: Array<{ run?: unknown; match?: unknown; timeoutMs?: unknown }>;
  preCommand?: Array<{ block?: unknown; message?: unknown }>;
}

/** Minimal glob → RegExp: `**` any depth, `*` within a segment, `?` one char, `{a,b}` alternation. Pure. */
export function globToRegExp(pattern: string): RegExp {
  let re = '';
  let i = 0;
  const p = pattern.replace(/^\.?\//, '');
  while (i < p.length) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        // `**/` → zero or more segments; bare `**` → anything
        if (p[i + 2] === '/') { re += '(?:.*/)?'; i += 3; } else { re += '.*'; i += 2; }
      } else { re += '[^/]*'; i += 1; }
    } else if (c === '?') { re += '[^/]'; i += 1; }
    else if (c === '{') {
      const close = p.indexOf('}', i);
      if (close < 0) { re += '\\{'; i += 1; continue; }
      const alts = p.slice(i + 1, close).split(',').map((a) => a.replace(/[.+^$()|[\]\\]/g, '\\$&'));
      re += `(?:${alts.join('|')})`;
      i = close + 1;
    } else { re += c.replace(/[.+^$()|[\]\\]/g, '\\$&'); i += 1; }
  }
  return new RegExp(`^${re}$`);
}

/** Does a worktree-relative file path match the hook's glob? A pattern with no '/' matches the basename. Pure. */
export function fileMatches(relPath: string, pattern: string | undefined): boolean {
  if (!pattern) return true;
  const rel = relPath.replace(/^\.?\//, '');
  const target = pattern.includes('/') ? rel : path.basename(rel);
  try { return globToRegExp(pattern).test(target); } catch { return false; }
}

/** Validate + bound the raw config. Junk entries are dropped, never thrown. Pure. */
export function parseRepoHooks(raw: unknown): RepoHooks {
  const out: RepoHooks = { postEdit: [], preCommand: [] };
  if (!raw || typeof raw !== 'object') return out;
  const cfg = raw as RepoHooksConfig;
  for (const h of (Array.isArray(cfg.postEdit) ? cfg.postEdit : [])) {
    if (out.postEdit.length >= REPO_HOOKS_MAX) break; // cap counts VALID hooks — junk never eats a slot
    const run = typeof h?.run === 'string' ? h.run.trim() : '';
    if (!run || run.length > 500) continue;
    const match = typeof h.match === 'string' && h.match.trim() ? h.match.trim() : undefined;
    const t = Number(h.timeoutMs);
    const timeoutMs = Number.isFinite(t) && t > 0 ? Math.min(Math.floor(t), REPO_HOOK_MAX_TIMEOUT_MS) : REPO_HOOK_DEFAULT_TIMEOUT_MS;
    out.postEdit.push({ run, match, timeoutMs });
  }
  for (const h of (Array.isArray(cfg.preCommand) ? cfg.preCommand : [])) {
    if (out.preCommand.length >= REPO_HOOKS_MAX) break;
    const block = typeof h?.block === 'string' ? h.block.trim() : '';
    if (!block || block.length > 500) continue;
    const message = typeof h.message === 'string' && h.message.trim() ? h.message.trim().slice(0, 300) : `matches this project's preCommand hook "${block}"`;
    // "/…/" = a regex; anything else = a case-insensitive substring.
    let regex: RegExp;
    try {
      regex = /^\/.+\/[a-z]*$/.test(block)
        ? new RegExp(block.slice(1, block.lastIndexOf('/')), block.slice(block.lastIndexOf('/') + 1).replace(/[^gimsuy]/g, '') || 'i')
        : new RegExp(block.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    } catch { continue; }
    out.preCommand.push({ block, message, regex });
  }
  return out;
}

const memo = new Map<string, { at: number; hooks: RepoHooks }>();
export function __resetRepoHooksForTests(): void { memo.clear(); }

/** The worktree's hooks (memoized 30 s). Empty when unconfigured or unreadable. */
export async function loadRepoHooks(worktree: string): Promise<RepoHooks> {
  if (!worktree) return { postEdit: [], preCommand: [] };
  const hit = memo.get(worktree);
  const now = Date.now();
  if (hit && now - hit.at < CONFIG_MEMO_MS) return hit.hooks;
  const config = await readDigbyConfig(worktree).catch(() => null);
  const hooks = parseRepoHooks((config as any)?.hooks);
  memo.set(worktree, { at: now, hooks });
  return hooks;
}

/** A preCommand match → the refusal text the tool returns instead of running; null = run it. Pure. */
export function preCommandBlock(hooks: RepoHooks, command: string): string | null {
  for (const h of hooks.preCommand) {
    if (h.regex.test(command)) {
      return `[command REFUSED by this project's .digby/config.json preCommand hook] ${h.message}\nHook pattern: ${h.block}. This is the repository's own rule — change the config if it is wrong, do not work around it.`;
    }
  }
  return null;
}

type ExecShell = (command: string, cwd?: string, timeoutMs?: number) => Promise<{ stdout: string; stderr: string }>;
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Run every matching postEdit hook for the file, sequentially, and return the
 * `[post-edit hook]` note to append to the tool result ('' when none matched).
 * Never throws; a failing hook is reported, not raised.
 */
export async function runPostEditHooks(execShell: ExecShell, worktree: string, hooks: RepoHooks, relPath: string, sessionId?: string): Promise<string> {
  const matching = hooks.postEdit.filter((h) => fileMatches(relPath, h.match));
  if (!matching.length) return '';
  const notes: string[] = [];
  for (const h of matching) {
    const cmd = h.run.replace(/\{file\}/g, quote(relPath.replace(/^\.?\//, '')));
    const t0 = Date.now();
    let ok = false; let tail = '';
    try {
      const { stdout, stderr } = await execShell(`${cmd}; echo "__DIGBY_EXIT__ $?"`, worktree, h.timeoutMs);
      const combined = [stdout, stderr].filter(Boolean).join('\n');
      const markers = [...combined.matchAll(/__DIGBY_EXIT__ (\d+)/g)];
      const exit = markers.length ? Number(markers[markers.length - 1][1]) : 1;
      ok = exit === 0;
      tail = combined.replace(/__DIGBY_EXIT__ \d+/g, '').trim().split('\n').slice(-6).join('\n').slice(-REPO_HOOK_OUTPUT_TAIL);
    } catch (err: any) {
      tail = String(err?.message ?? err).slice(-REPO_HOOK_OUTPUT_TAIL);
    }
    const ms = Date.now() - t0;
    notes.push(ok
      ? `[post-edit hook] ${h.run} → ok (${ms} ms)${tail ? `\n${tail}` : ''}`
      : `[post-edit hook] ${h.run} → FAILED (${ms} ms) — the file is on disk as you wrote it; fix what the hook reports:\n${tail || '(no output)'}`);
    recordLoopMetric({ kind: LOOP_METRIC_KINDS.REPO_HOOK, sessionId, value: ms, meta: { kind: 'postEdit', ok, run: h.run.slice(0, 120), file: relPath.slice(0, 200) } });
    if (!ok) logger.info(`repo-hooks: postEdit "${h.run.slice(0, 80)}" failed on ${relPath} (${ms} ms)`);
  }
  return notes.join('\n');
}
