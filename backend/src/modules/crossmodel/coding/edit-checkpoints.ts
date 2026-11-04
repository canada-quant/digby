/**
 * Working-tree checkpoints (harness roadmap item 7, owner-approved 2026-09-19).
 *
 * Claude Code / Cursor snapshot the files an agent touches so a wrong turn is
 * undone in one move instead of by hand-reverting (or reaching for git and
 * disturbing the lane's own commits). Digby's coding loop had no such thing:
 * an edit that broke the build stayed until the model re-read and re-wrote
 * every file it had changed.
 *
 * THE RULE: before every write_file / edit_file on a TOP-LEVEL coding run the
 * file's prior content (or its absence) is snapshotted under the run's own
 * checkpoint directory, tagged with the loop step. `rewind_to_step({step})`
 * restores every file changed at that step or later to its pre-step content,
 * newest snapshot first so the earliest one wins; files the run created are
 * removed. Only the agent's own edits are undone — commands, verify runs, git
 * operations and post-edit hooks are not (the note says so). Calling the tool
 * without a step lists the checkpoints.
 *
 * Bounds: EDIT_CHECKPOINT_MAX_RECORDS snapshots per run (recording stops
 * beyond it — the index says so), files over EDIT_CHECKPOINT_MAX_FILE_BYTES are
 * recorded but not restorable (`skipped`). Snapshots live in the OS temp dir of
 * the process that writes the worktree (the coding worker), never inside the
 * worktree. Never throws into the
 * tool path — a checkpoint failure must never fail an edit.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

export const EDIT_CHECKPOINT_MAX_FILE_BYTES = 2_000_000;
export const EDIT_CHECKPOINT_MAX_RECORDS = 400;

export interface CheckpointRecord {
  seq: number;
  step: number;
  relPath: string;
  absPath: string;
  /** False when the file did not exist before the write — a rewind removes it. */
  existed: boolean;
  bytes: number;
  /** Over the size bound: recorded for the index, not restorable. */
  tooLarge: boolean;
  at: string;
}

export interface CheckpointStep { step: number; files: string[] }

export interface RewindResult {
  step: number;
  restored: string[];
  deleted: string[];
  skipped: string[];
  /** No checkpoint at or after `step` existed. */
  nothing: boolean;
}

/** What the tool layer sees (agent.ts wires the tracker; tools.ts only calls these). */
export interface EditCheckpointSink {
  beforeWrite(relPath: string, absPath: string, prior?: string | null): Promise<void>;
}

export class EditCheckpoints implements EditCheckpointSink {
  private step = 0;
  private seq = 0;
  private records: CheckpointRecord[] = [];
  private full = false;
  private readonly dir: string;
  private dirReady: Promise<boolean> | null = null;

  constructor(private readonly opts: { sessionId: string; runId?: string | null; baseDir?: string }) {
    const safe = (s: string) => String(s || 'run').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'run';
    this.dir = path.join(opts.baseDir ?? path.join(os.tmpdir(), 'digby-checkpoints'), `${safe(opts.sessionId)}-${safe(opts.runId ?? `${Date.now()}`)}`);
  }

  /** The agent loop stamps the current step before each model turn. */
  setStep(step: number): void {
    if (Number.isFinite(step) && step >= 0) this.step = Math.floor(step);
  }

  get currentStep(): number { return this.step; }
  get recordCount(): number { return this.records.length; }
  get isFull(): boolean { return this.full; }

  private ensureDir(): Promise<boolean> {
    if (!this.dirReady) {
      this.dirReady = fs.mkdir(this.dir, { recursive: true }).then(() => true).catch(() => false);
    }
    return this.dirReady;
  }

  /**
   * Snapshot the file's CURRENT content (before the caller writes). `prior`
   * may be passed when the caller already read the file (edit_file); ENOENT
   * records an "absent" checkpoint. Never throws.
   */
  async beforeWrite(relPath: string, absPath: string, prior?: string | null): Promise<void> {
    try {
      if (this.full) return;
      if (this.records.length >= EDIT_CHECKPOINT_MAX_RECORDS) { this.full = true; return; }
      let content: string | null;
      if (prior !== undefined) {
        content = prior;
      } else {
        try {
          content = await fs.readFile(absPath, 'utf8');
        } catch (err: any) {
          if (err?.code !== 'ENOENT') return; // unreadable for another reason — do not pretend
          content = null;
        }
      }
      const bytes = content === null ? 0 : Buffer.byteLength(content, 'utf8');
      const tooLarge = bytes > EDIT_CHECKPOINT_MAX_FILE_BYTES;
      const seq = ++this.seq;
      if (content !== null && !tooLarge) {
        if (!(await this.ensureDir())) return;
        await fs.writeFile(this.snapPath(seq), content, 'utf8');
      }
      this.records.push({
        seq, step: this.step, relPath: relPath.replace(/^\.?\//, ''), absPath,
        existed: content !== null, bytes, tooLarge, at: new Date().toISOString(),
      });
    } catch { /* never fail an edit over a checkpoint */ }
  }

  /** Steps ascending, unique files per step. */
  list(): CheckpointStep[] {
    const byStep = new Map<number, Set<string>>();
    for (const r of this.records) {
      if (!byStep.has(r.step)) byStep.set(r.step, new Set());
      byStep.get(r.step)!.add(r.relPath);
    }
    return [...byStep.entries()].sort((a, b) => a[0] - b[0]).map(([step, files]) => ({ step, files: [...files] }));
  }

  /**
   * Restore every file changed at `step` or later to its content before that
   * step. Newest snapshot first, so a file touched at several steps ends on
   * its EARLIEST (pre-step) content; a file the run created is removed. The
   * consumed records are dropped (a later rewind cannot cross them). Never
   * throws: a file that cannot be restored is listed under `skipped`.
   */
  async rewindTo(step: number): Promise<RewindResult> {
    const target = Math.max(0, Math.floor(Number(step) || 0));
    const hit = this.records.filter((r) => r.step >= target).sort((a, b) => b.seq - a.seq);
    const restored = new Set<string>(); const deleted = new Set<string>(); const skipped = new Set<string>();
    for (const r of hit) {
      try {
        if (r.tooLarge) { skipped.add(r.relPath); continue; }
        if (!r.existed) {
          await fs.unlink(r.absPath).catch((e: any) => { if (e?.code !== 'ENOENT') throw e; });
          deleted.add(r.relPath); restored.delete(r.relPath);
          continue;
        }
        const content = await fs.readFile(this.snapPath(r.seq), 'utf8');
        await fs.mkdir(path.dirname(r.absPath), { recursive: true });
        await fs.writeFile(r.absPath, content, 'utf8');
        restored.add(r.relPath); deleted.delete(r.relPath);
      } catch {
        skipped.add(r.relPath);
      }
    }
    for (const r of hit) void fs.unlink(this.snapPath(r.seq)).catch(() => {});
    this.records = this.records.filter((r) => r.step < target);
    if (this.records.length < EDIT_CHECKPOINT_MAX_RECORDS) this.full = false;
    return { step: target, restored: [...restored], deleted: [...deleted], skipped: [...skipped], nothing: hit.length === 0 };
  }

  /** Best-effort cleanup at run end. */
  async dispose(): Promise<void> {
    this.records = [];
    await fs.rm(this.dir, { recursive: true, force: true }).catch(() => {});
  }

  private snapPath(seq: number): string { return path.join(this.dir, `${seq}.snap`); }
}

/** The tool's listing text. Pure. */
export function renderCheckpointIndex(steps: CheckpointStep[], currentStep: number, full: boolean): string {
  if (!steps.length) return `No checkpoints yet in this run (current step ${currentStep}) — a write_file / edit_file records one.`;
  const lines = steps.map((s) => `- step ${s.step}: ${s.files.slice(0, 8).join(', ')}${s.files.length > 8 ? ` (+${s.files.length - 8} more)` : ''}`);
  return [
    `Checkpoints in this run (current step ${currentStep}) — rewind_to_step({step: N}) restores every file changed at step N or later to its pre-step content:`,
    ...lines,
    full ? `(recording stopped at ${EDIT_CHECKPOINT_MAX_RECORDS} snapshots — later edits are not restorable)` : '',
  ].filter(Boolean).join('\n');
}

/** The tool's rewind receipt. Pure. */
export function renderRewindResult(r: RewindResult): string {
  if (r.nothing) return `Nothing to rewind: no checkpoint at or after step ${r.step}. Call rewind_to_step without a step to list them.`;
  const parts = [`Rewound to before step ${r.step}.`];
  if (r.restored.length) parts.push(`Restored: ${r.restored.join(', ')}.`);
  if (r.deleted.length) parts.push(`Removed (created by this run): ${r.deleted.join(', ')}.`);
  if (r.skipped.length) parts.push(`Could NOT restore (over the size bound or unreadable): ${r.skipped.join(', ')} — fix these by hand.`);
  parts.push('Only your own file edits were undone — commands, verify runs, git operations and post-edit hooks were not. Re-read a file before editing it again.');
  return parts.join(' ');
}
