/**
 * Diagnostics after edit (harness roadmap item 1, owner 2026-09-19).
 *
 * THE GAP: a lane learned about a type error only when it ran `verify` — the
 * whole typecheck → lint → test chain, minutes later, often after several more
 * edits built on the broken one. Cursor / oh-my-opencode surface LSP
 * diagnostics the moment a file changes; Claude Code does it with post-edit
 * hooks. Digby had nothing between `edit_file` and `verify`.
 *
 * THE MECHANISM: every `edit_file` / `write_file` on a top-level coding run
 * notes the path here. A debounced BACKGROUND pass then runs the project's
 * own typecheck command from `.digby/config.json` (tsc made `--incremental`
 * with a per-project build-info cache so the second run is seconds, not
 * minutes; pyright/mypy get the touched files appended) and, when the lint
 * command is a single eslint invocation, eslint on the touched files. The
 * result is filtered to the files the lane touched and injected as ONE
 * `[DIAGNOSTICS]` system note at the start of its next turn — errors in the
 * lane's own files first, everything else as a count. Nothing blocks, nothing
 * gates: the lane keeps working while the pass runs, and `verify` stays the
 * verification of record.
 *
 * Bounded: one pass in flight per run (edits during a pass queue ONE re-run),
 * a process-wide concurrency cap, a per-pass timeout, and the same heap cap
 * the verify chain uses.
 */

import * as path from 'path';
import * as crypto from 'crypto';
import logger from '../../../utils/logger';
import type { DigbyConfig } from './verify.service';

export const EDIT_DIAGNOSTICS_DEBOUNCE_MS = 4_000;
export const EDIT_DIAGNOSTICS_TIMEOUT_MS = 180_000;
export const EDIT_DIAGNOSTICS_MAX_LINES = 30;
export const EDIT_DIAGNOSTICS_CONCURRENCY = 3;
export const EDIT_DIAGNOSTICS_MAX_FILES = 40;

export interface DiagnosticsCommand { key: 'typecheck' | 'lint'; command: string }

/** tsc build-info cache path — per command shape, in /tmp (survives inside the dev container across runs). */
export function tsBuildInfoPath(command: string): string {
  return `/tmp/.digby-tsbuildinfo-${crypto.createHash('sha1').update(command).digest('hex').slice(0, 12)}`;
}

/**
 * Derive the file-scoped diagnostics commands from the project's verify
 * commands. Pure. Returns [] when nothing is derivable (no config, a
 * typechecker we do not know how to scope, a multi-step lint chain).
 */
export function buildDiagnosticsCommands(config: DigbyConfig | null, files: string[]): DiagnosticsCommand[] {
  const out: DiagnosticsCommand[] = [];
  const cmds = config?.commands ?? {};
  const all = files.map((f) => f.replace(/^\.?\//, '')).filter(Boolean).slice(0, EDIT_DIAGNOSTICS_MAX_FILES);
  if (!all.length) return out;
  const quote = (f: string) => `'${f.replace(/'/g, `'\\''`)}'`;
  // Each tool sees ONLY the touched files in its own language (live 2026-09-19:
  // a lane edited tmp/shard_r1.cmd.sh and mypy was handed the shell script —
  // "Unterminated string literal" was then injected as a diagnostic IN THE
  // LANE'S FILE). No file in the tool's language ⇒ that stage does not run.
  const py = all.filter((f) => PY_FILE_RE.test(f));
  const js = all.filter((f) => JS_FILE_RE.test(f));
  const typecheck = cmds.typecheck ? String(cmds.typecheck) : '';
  if (/\btsc\b/.test(typecheck) && js.length) {
    // Make the project's own tsc invocation incremental (cache in /tmp) unless
    // it already is / uses build mode. The cd-prefix form ("cd backend && npx
    // tsc --noEmit") keeps its prefix — flags attach to the tsc segment only.
    const alreadyIncremental = /--incremental|\s-b\b|--build\b|--tsBuildInfoFile/.test(typecheck);
    const withNoEmit = /--noEmit/.test(typecheck) ? typecheck : typecheck.replace(/\btsc\b/, 'tsc --noEmit');
    const command = alreadyIncremental
      ? withNoEmit
      : withNoEmit.replace(/(\btsc\b[^&;|]*)/, (seg) => `${seg.trimEnd()} --incremental --tsBuildInfoFile ${tsBuildInfoPath(typecheck)}`);
    out.push({ key: 'typecheck', command });
  } else if (/\b(pyright|mypy)\b/.test(typecheck) && py.length) {
    out.push({ key: 'typecheck', command: `${typecheck} ${py.map(quote).join(' ')}` });
  }
  const lint = cmds.lint ? String(cmds.lint) : '';
  // Only a SINGLE eslint invocation is file-scopable; "cd a && npm run lint && cd ../b && npm run lint" is not.
  if (/\beslint\b/.test(lint) && !/&&|;|\|\|/.test(lint) && js.length) {
    out.push({ key: 'lint', command: `${lint} --no-error-on-unmatched-pattern ${js.map(quote).join(' ')}` });
  } else if (/\bruff\b/.test(lint) && !/&&|;|\|\|/.test(lint) && py.length) {
    out.push({ key: 'lint', command: `${lint} ${py.map(quote).join(' ')}` });
  }
  return out;
}

/** The languages each derivable tool understands. Anything else (shell, markdown, json, yaml) gets no pass. */
export const PY_FILE_RE = /\.pyi?$/i;
export const JS_FILE_RE = /\.(?:[cm]?[jt]sx?|vue|svelte)$/i;

export interface DiagnosticsStageResult {
  key: 'typecheck' | 'lint';
  exitCode: number;
  /** Lines that name one of the touched files. */
  touchedLines: string[];
  /** Diagnostic lines that name other files. */
  otherCount: number;
  /** Tool missing (exit 127 / "not found" / "No module named") — the stage could not run. */
  skipped: boolean;
  ms: number;
  /** Last lines of the command's output (≤ 240 chars) — carried into the metric when the stage
   *  is non-zero or skipped so a live exit-code surprise can be read without re-running it. */
  tail?: string;
}

/** A diagnostic line: tsc ("a.ts(1,2): error TS…"), eslint stylish ("  12:5  error  msg  rule"),
 *  ruff / mypy / pyright / gcc ("pkg/a.py:12:5: F401 …" — no 'error' word), generic "error:"/"warning:". */
const DIAG_LINE_RE = /(^|[\s(:])(error|warning)\b|\berror TS\d+|: error:|: warning:|^[^\s:]+\.[A-Za-z0-9]{1,6}:\d+:\d+/i;
/** eslint-stylish (and similar) print the file ONCE as a bare path line, then indented diagnostics. */
const FILE_HEADER_RE = /^\S+\.[A-Za-z0-9]{1,6}$/;
/** Tool summary lines ("✖ 3 problems (2 errors, 1 warning)", "Found 3 errors in 2 files.") are not diagnostics. */
const SUMMARY_RE = /^(✖|Found \d+ error|\d+ (problems?|errors?|warnings?)\b)/;

/** Split a tool's output into lines about the touched files vs everything else. Pure. */
export function splitDiagnostics(output: string, files: string[]): { touchedLines: string[]; otherCount: number } {
  const names = files.map((f) => f.replace(/^\.?\//, '')).filter(Boolean);
  const basenames = names.map((f) => path.basename(f));
  const touched: string[] = [];
  let other = 0;
  let currentFile: string | null = null; // eslint-stylish style: bare path header, then indented rows
  const namesFile = (line: string) => names.some((f) => line.includes(f)) || basenames.some((b) => line.includes(b));
  for (const raw of output.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    if (FILE_HEADER_RE.test(line.trim()) && !DIAG_LINE_RE.test(line)) { currentFile = line.trim(); continue; }
    if (SUMMARY_RE.test(line.trim()) || !DIAG_LINE_RE.test(line)) continue;
    const ownPath = /[\w./-]+\.[A-Za-z0-9]{1,6}[(:]/.test(line); // the line names a file itself
    const hits = namesFile(line) || (!ownPath && currentFile !== null && namesFile(currentFile));
    if (hits) touched.push(currentFile && !ownPath ? `${currentFile}: ${line.trim()}` : line); else other += 1;
  }
  return { touchedLines: touched, otherCount: other };
}

/** Render the note the lane reads at its next turn. Pure. */
export function renderDiagnosticsNote(files: string[], stages: DiagnosticsStageResult[]): string {
  const shown = files.slice(0, 6).join(', ') + (files.length > 6 ? ` (+${files.length - 6} more)` : '');
  const lines: string[] = [`[DIAGNOSTICS — harness, after your edits to ${shown}. Informational: verify remains the check of record.]`];
  for (const s of stages) {
    if (s.skipped) { lines.push(`- ${s.key}: could not run (tool not installed here).`); continue; }
    if (s.touchedLines.length === 0 && s.exitCode === 0) { lines.push(`- ${s.key}: ✓ clean for the files you touched.`); continue; }
    if (s.touchedLines.length === 0) {
      lines.push(`- ${s.key}: no diagnostics in the files you touched; ${s.otherCount} elsewhere (pre-existing or caused by your change — run verify for the full list).`);
      continue;
    }
    const cap = s.touchedLines.slice(0, EDIT_DIAGNOSTICS_MAX_LINES);
    lines.push(`- ${s.key}: ${s.touchedLines.length} diagnostic(s) in the files you touched${s.otherCount ? ` (+${s.otherCount} elsewhere)` : ''}:`);
    for (const l of cap) lines.push(`    ${l}`);
    if (s.touchedLines.length > cap.length) lines.push(`    … (+${s.touchedLines.length - cap.length} more)`);
  }
  lines.push('Fix what is yours before building on it; a diagnostic elsewhere that your change caused is yours too.');
  return lines.join('\n');
}

type ExecShell = (command: string, cwd?: string, timeoutMs?: number) => Promise<{ stdout: string; stderr: string }>;

/** Process-wide cap so N sessions cannot stampede the dev container with parallel tsc runs. */
let inFlightGlobal = 0;
const waiters: Array<() => void> = [];
async function acquireSlot(): Promise<void> {
  if (inFlightGlobal < EDIT_DIAGNOSTICS_CONCURRENCY) { inFlightGlobal += 1; return; }
  await new Promise<void>((res) => waiters.push(res));
  inFlightGlobal += 1;
}
function releaseSlot(): void {
  inFlightGlobal = Math.max(0, inFlightGlobal - 1);
  const next = waiters.shift();
  if (next) next();
}
export function __resetEditDiagnosticsForTests(): void { inFlightGlobal = 0; waiters.length = 0; }

export interface EditDiagnosticsSink { noteEdit(relPath: string): void }

export interface EditDiagnosticsOptions {
  worktree: string;
  execShell: ExecShell;
  config: DigbyConfig | null;
  sessionId: string;
  runId?: string | null;
  emit?: (event: string, data: any) => void;
  onReport?: (report: { files: string[]; stages: DiagnosticsStageResult[] }) => void;
  debounceMs?: number;
  timeoutMs?: number;
}

/**
 * One tracker per top-level coding run: collects edited paths, runs the
 * derived commands once the edits go quiet, and hands the rendered note to the
 * agent loop via takeNote() (consumed once). Never throws into the run.
 */
export class EditDiagnosticsTracker implements EditDiagnosticsSink {
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private rerunWanted = false;
  private disposed = false;
  private note: string | null = null;
  /** Resolves when the current pass (and any queued re-run) has finished — tests + dispose. */
  private idleResolvers: Array<() => void> = [];

  constructor(private readonly opts: EditDiagnosticsOptions) {}

  noteEdit(relPath: string): void {
    if (this.disposed || !relPath) return;
    this.pending.add(relPath.replace(/^\.?\//, ''));
    if (this.running) { this.rerunWanted = true; return; }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.run(); }, this.opts.debounceMs ?? EDIT_DIAGNOSTICS_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  /** The latest unread note (one per completed pass), or null. */
  takeNote(): string | null {
    const n = this.note;
    this.note = null;
    return n;
  }

  /** Await quiescence (a pending debounce fires immediately). */
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; await this.run(); }
    if (this.running) await new Promise<void>((res) => this.idleResolvers.push(res));
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.pending.clear();
  }

  private async run(): Promise<void> {
    if (this.disposed || this.running) return;
    const files = [...this.pending];
    this.pending.clear();
    if (!files.length) return;
    const commands = buildDiagnosticsCommands(this.opts.config, files);
    if (!commands.length) return;
    this.running = true;
    const t0 = Date.now();
    const stages: DiagnosticsStageResult[] = [];
    try {
      await acquireSlot();
      try {
        for (const c of commands) {
          if (this.disposed) break;
          const s0 = Date.now();
          // Ticket 7fbc34cd: same POSIX-scoping fix as the verify chain — the
          // prefix form never reached the tool behind a `cd X &&` prefix. 4096
          // (not the never-load-bearing 2048): a real 2048 cap kills this
          // repo's cold tsc (probed 2026-10-09, see verify.service.ts).
          const leg = `export NODE_OPTIONS="--max-old-space-size=4096"; ${c.command}; echo "__DIGBY_EXIT__ $?"`;
          // A rejecting shell still carries the command's own marker in its
          // stdout — never append a synthetic one AFTER it (the first live
          // ruff/mypy passes read "not found" exit 127 as exit 1, 2026-09-19).
          let threw = false;
          const { stdout, stderr } = await this.opts.execShell(leg, this.opts.worktree, this.opts.timeoutMs ?? EDIT_DIAGNOSTICS_TIMEOUT_MS)
            .catch((e: any) => { threw = true; return { stdout: e?.stdout?.toString?.() || '', stderr: e?.stderr?.toString?.() || e?.message || '' }; });
          const combined = [stdout, stderr].filter(Boolean).join('\n');
          const markers = [...combined.matchAll(/__DIGBY_EXIT__ (\d+)/g)];
          const exitCode = markers.length ? Number(markers[markers.length - 1][1]) : (threw ? 1 : 0);
          const cleaned = combined.replace(/__DIGBY_EXIT__ \d+/g, '').replace(/\n\[exit: [^\]]*\]/g, '').trim();
          // Missing tool = skipped (exit 127, "sh: ruff: not found", "No module named mypy") — the
          // same classification the verify chain uses; a skipped stage is reported, never counted.
          const skipped = exitCode === 127 || /(^|\n)[^\n]*: (command )?not found\b|\bNo module named\b/i.test(cleaned);
          const { touchedLines, otherCount } = skipped ? { touchedLines: [], otherCount: 0 } : splitDiagnostics(cleaned, files);
          const tail = (exitCode !== 0 || skipped) ? cleaned.split('\n').slice(-3).join('\n').slice(-240) : undefined;
          stages.push({ key: c.key, exitCode, touchedLines, otherCount, skipped, ms: Date.now() - s0, ...(tail ? { tail } : {}) });
        }
      } finally {
        releaseSlot();
      }
      if (!this.disposed && stages.length) {
        this.note = renderDiagnosticsNote(files, stages);
        const touched = stages.reduce((n, s) => n + s.touchedLines.length, 0);
        this.opts.emit?.('progress', {
          message: touched ? `Diagnostics after edit: ${touched} in the files you touched` : 'Diagnostics after edit: clean for the files you touched',
          stage: 'diagnostics',
        });
        this.opts.onReport?.({ files, stages });
      }
    } catch (err: any) {
      logger.warn(`edit-diagnostics: pass failed (non-fatal): ${err?.message ?? err}`);
    } finally {
      this.running = false;
      logger.info(`edit-diagnostics: ${files.length} file(s), ${stages.map((s) => `${s.key}=${s.skipped ? 'skipped' : s.touchedLines.length + '/' + s.otherCount}`).join(' ')} in ${Date.now() - t0} ms`);
      const resolvers = this.idleResolvers.splice(0);
      if (this.rerunWanted && !this.disposed && this.pending.size) {
        this.rerunWanted = false;
        // Edits landed during the pass — one more pass after the debounce.
        this.timer = setTimeout(() => { this.timer = null; void this.run().finally(() => resolvers.forEach((r) => r())); }, this.opts.debounceMs ?? EDIT_DIAGNOSTICS_DEBOUNCE_MS);
        this.timer.unref?.();
      } else {
        this.rerunWanted = false;
        resolvers.forEach((r) => r());
      }
    }
  }
}
