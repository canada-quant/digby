/**
 * Rust-helper client (W3, 2026-09-25) — the digby-win-helper stdio client
 * that implements the Win32Surface/Win32Input seam from win-platform.ts,
 * REPLACING the retired W1 native-FFI adapter (roadmap W3: "the Rust
 * helper replaces it"). Nothing above the seam changes: commands.ts, the
 * geometry math and the whole Linux test suite keep running against the
 * same interfaces.
 *   - The helper process is spawned on FIRST USE, never at module import,
 *     and never on a non-Windows platform (Linux CI: the module imports
 *     inert; computer_* refuses with a clear actionable error).
 *   - The spawn command is injectable for tests: `helperPath` config >
 *     DIGBY_WIN_HELPER env > digby-win-helper.exe beside dist/. The node
 *     test suite spawns a FAKE helper (a plain .mjs script) through the
 *     same code path the real exe takes.
 *   - A spawn/protocol failure NEVER takes browser_* down with it: only
 *     computer_* surfaces go through this client.
 *
 * PROTOCOL (frozen; see rust-helper/src/protocol.rs): line-delimited JSON
 * over stdio — {"id":N,"method":M,"params":{...}} in, exactly one
 * {"id":N,"ok":true,"result":{...}} | {"id":N,"ok":false,"error":{"code",
 * "message"}} line out. The FROZEN UIA_* refusal codes arrive in
 * error.code and are relayed VERBATIM as '<CODE>: <message>'.
 */

import { spawn, ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import {
  Win32Surface,
  Win32Input,
  WinKeySpec,
  VirtualScreenGeometry,
  MonitorRect,
} from './win-platform';
import { encodeJpegFromBgra } from './jpeg-encode';

/** Helper-protocol refusal codes (frozen wire contract — mirror of
 *  rust-helper/src/protocol.rs; the backend + docs pin these strings). */
export const REFUSAL_CODES = {
  ELEVATED: 'UIA_E_ELEVATED',
  SECURE_DESKTOP: 'UIA_E_SECURE_DESKTOP',
  DRM: 'UIA_E_DRM',
  ANTICHEAT: 'UIA_E_ANTICHEAT',
  NOT_FOUND: 'UIA_E_NOT_FOUND',
  UNSUPPORTED: 'UIA_E_UNSUPPORTED',
  DRM_SUSPECTED_WARNING: 'UIA_W_DRM_SUSPECTED',
} as const;

/** Helper-internal error codes (never relayed as UIA_*). */
export const HELPER_CODES = {
  PLATFORM: 'HELPER_E_PLATFORM',
  PARAMS: 'HELPER_E_PARAMS',
  INTERNAL: 'HELPER_E_INTERNAL',
} as const;

/** The wire error the helper returned — .code is the refusal code when it
 *  starts with UIA_ (relayed verbatim), or a helper-internal code. */
export class HelperProtocolError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'HelperProtocolError';
    this.code = code;
  }
  /** True when this is a frozen UIA refusal (vs helper-internal). */
  get isRefusal(): boolean {
    return this.code.startsWith('UIA_');
  }
}

export interface HelperSpawnOptions {
  /** Explicit helper command override (config/tests). */
  helperPath?: string;
  /** Extra args appended after the executable. */
  args?: string[];
}

/** Probe order for the helper executable, relative to a from-dir (the built
 *  module's own directory — `<agent bundle>/dist` at runtime).
 *
 *  Ticket 4424ebd6 (2026-10-21): the SHIPPED bundle layout installs
 *  digby-win-helper.exe at the AGENT BUNDLE ROOT — BESIDE the dist/ folder
 *  (digby.nsi SecAgent `SetOutPath "$INSTDIR\agent"` + `File
 *  ..\digby-win-helper.exe` before the `File /r ..\dist`), because the agent
 *  itself runs from `$INSTDIR\agent\dist\index.js` (launch-agent.bat + the
 *  shell's Bridge.cs). v0.9.0 probed ONLY inside dist/ (`join(__dirname,…)`),
 *  so a fresh standard install paired fine but EVERY computer_* command
 *  failed with "helper executable not found" — computer use fully
 *  unavailable on a device that looked healthy.
 *
 *  The ROOT probe comes FIRST deliberately: it is the canonical shipped
 *  location, and an exe a user once copied INSIDE dist/ (the old manual
 *  workaround) must not shadow a fresh bundle-root exe on upgrade (a stale
 *  helper would win forever — NSIS `File /r dist` never deletes it). The
 *  inside-dist probe stays as the legacy fallback so the documented manual
 *  workaround keeps working when no bundle-root exe exists. */
export function helperProbePaths(fromDir: string): string[] {
  return [
    join(dirname(fromDir), 'digby-win-helper.exe'), // bundle root — beside dist/ (the shipped layout)
    join(fromDir, 'digby-win-helper.exe'), // inside dist/ — legacy manual workaround
  ];
}

/** Resolve the helper executable: helperPath config > DIGBY_WIN_HELPER env
 *  > digby-win-helper.exe beside dist/ (the bundle root — the shipped
 *  installer layout), then inside dist/ (legacy manual workaround). Pure
 *  (fs probe only) — exported for the Linux suite. `fromDir` defaults to
 *  this module's own directory (dist/ at runtime) and is injectable so the
 *  test suite can replay ARBITRARY bundle layouts through the real
 *  resolution logic (ticket 4424ebd6). */
export function resolveHelperCommand(
  opts?: HelperSpawnOptions,
  fromDir: string = __dirname,
): { cmd: string; args: string[] } | null {
  const explicit = opts?.helperPath || (process.env.DIGBY_WIN_HELPER || '').trim();
  if (explicit) return { cmd: explicit, args: opts?.args ? [...opts.args] : [] };
  for (const candidate of helperProbePaths(fromDir)) {
    if (existsSync(candidate)) return { cmd: candidate, args: opts?.args ? [...opts.args] : [] };
  }
  return null;
}

/** One pending request awaiting its response line. */
interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  method: string;
}

/** The stdio client. Requests are strictly serialized (the agent is
 *  single-threaded per command), one line in → one line out. */
export class RustHelperClient {
  private proc: ChildProcess | null = null;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private spawnError: string | null = null;
  private exited = false;

  constructor(private opts: HelperSpawnOptions = {}) {}

  /** True when a helper process is alive (diagnostics/status). */
  get running(): boolean {
    return !!this.proc && !this.exited && this.proc.exitCode === null;
  }

  private ensureSpawned(): ChildProcess {
    if (this.proc && !this.exited) return this.proc;
    if (this.spawnError) {
      throw new Error(
        `the Digby Windows helper failed to start earlier this run (${this.spawnError}) — computer use is unavailable; ` +
        `reinstall Digby (the agent bundle ships digby-win-helper.exe) or set DIGBY_WIN_HELPER to its path`,
      );
    }
    const cmd = resolveHelperCommand(this.opts);
    if (!cmd) {
      this.spawnError = 'helper executable not found';
      throw new Error(
        'the Digby Windows helper (digby-win-helper.exe) was not found beside the agent or via DIGBY_WIN_HELPER — ' +
        'computer use needs the W3 agent bundle (reinstall Digby) or a manual DIGBY_WIN_HELPER path',
      );
    }
    try {
      this.proc = spawn(cmd.cmd, cmd.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e: any) {
      this.spawnError = e?.message || String(e);
      throw new Error(`failed to spawn the Digby Windows helper ("${cmd.cmd}"): ${this.spawnError}`);
    }
    this.exited = false;
    this.proc.stdout!.setEncoding('utf8');
    this.proc.stdout!.on('data', (chunk: string) => this.onStdout(chunk));
    this.proc.stderr!.setEncoding('utf8');
    this.proc.stderr!.on('data', (chunk: string) => {
      // The helper's own diagnostics — forwarded for visibility, never protocol.
      if (chunk.trim()) console.error(`[helper] ${chunk.trim()}`);
    });
    this.proc.on('error', (e) => this.failAll(`helper process error: ${e.message}`));
    this.proc.on('exit', (code) => {
      this.exited = true;
      this.proc = null;
      this.failAll(`helper process exited (code ${code}) — a later computer command will respawn it`);
    });
    return this.proc;
  }

  private failAll(msg: string): void {
    for (const [, p] of this.pending) p.reject(new HelperProtocolError(HELPER_CODES.INTERNAL, msg));
    this.pending.clear();
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        console.error(`[helper] unparseable response line (${line.slice(0, 120)}…) — ignored`);
        continue;
      }
      const id = typeof parsed?.id === 'number' ? parsed.id : null;
      const waiter = id !== null ? this.pending.get(id) : undefined;
      if (!waiter) continue; // a response to something we already gave up on
      this.pending.delete(id);
      if (parsed?.ok === true) {
        waiter.resolve(parsed.result ?? {});
      } else {
        const code = String(parsed?.error?.code || HELPER_CODES.INTERNAL);
        const message = String(parsed?.error?.message || 'helper returned an error with no message');
        waiter.reject(new HelperProtocolError(code, message));
      }
    }
  }

  /** Call one helper method. Serialized: a second call waits for the first. */
  async call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const proc = this.ensureSpawned();
    const id = this.nextId++;
    const line = JSON.stringify({ id, method, params }) + '\n';
    const written = await new Promise<void>((resolve, reject) => {
      proc.stdin!.write(line, (e) => (e ? reject(new HelperProtocolError(HELPER_CODES.INTERNAL, `helper stdin write failed: ${e.message}`)) : resolve()));
    });
    void written;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      // Safety net: a helper that never answers must not hang the agent.
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new HelperProtocolError(HELPER_CODES.INTERNAL, `helper method ${method} timed out after 15s`));
        }
      }, 15_000);
      const wrap = <A extends any[]>(fn: (...a: A) => void) => (...a: A) => {
        clearTimeout(timer);
        fn(...a);
      };
      const p = this.pending.get(id)!;
      this.pending.set(id, {
        resolve: wrap(p.resolve as (v: any) => void),
        reject: wrap(p.reject),
        method: p.method,
      });
    });
  }

  /** Stop the helper (agent shutdown / tests). */
  async dispose(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve();
      }, 1500);
      proc.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      try {
        proc.stdin!.end();
      } catch {
        /* already closed */
      }
    });
  }
}

// ── The seam implementation ─────────────────────────────────────────────────

/** Win32Surface via the helper. Capture is a TWO-call sequence internally
 *  (capture_bgra → encode in TS) but ONE seam call. */
export class HelperWin32Surface implements Win32Surface {
  /** Populated by the last capture (the DRM heuristic needs the frame). */
  lastCapture: { bgra: Buffer; width: number; height: number; backend: string; drmSuspected: boolean | null } | null = null;

  constructor(private client: RustHelperClient) {}

  async monitorSize(): Promise<{ width: number; height: number }> {
    const r = await this.client.call<{ width: number; height: number }>('monitor_size');
    return { width: r.width, height: r.height };
  }

  async captureJpeg(maxDim: number, quality: number): Promise<{ base64: string; width: number; height: number }> {
    const r = await this.client.call<{ bgra_b64: string; width: number; height: number; backend: string; drm_suspected?: boolean }>('capture_bgra');
    const bgra = Buffer.from(r.bgra_b64, 'base64');
    this.lastCapture = {
      bgra,
      width: r.width,
      height: r.height,
      backend: r.backend,
      // null when the helper predates the field (older bundles/tests).
      drmSuspected: typeof r.drm_suspected === 'boolean' ? r.drm_suspected : null,
    };
    return encodeJpegFromBgra(bgra, r.width, r.height, maxDim, quality);
  }

  async frontmost(): Promise<{ app: string; window: string } | null> {
    const r = await this.client.call<{ app: string; window: string } | null>('frontmost');
    return r ?? null;
  }

  async geometry(): Promise<VirtualScreenGeometry | null> {
    const r = await this.client.call<VirtualScreenGeometry | null>('geometry');
    if (!r || typeof r.width !== 'number') return null;
    const monitors: MonitorRect[] = Array.isArray((r as any).monitors)
      ? (r as any).monitors
      : [];
    return { x: r.x, y: r.y, width: r.width, height: r.height, monitors };
  }
}

/** Win32Input via the helper — one helper call per seam call. */
export class HelperWin32Input implements Win32Input {
  constructor(private client: RustHelperClient) {}

  async cursorPos(): Promise<{ x: number; y: number } | null> {
    const r = await this.client.call<{ x: number; y: number } | null>('cursor_pos');
    return r ?? null;
  }

  async moveTo(x: number, y: number): Promise<void> {
    await this.client.call('move_to', { x, y });
  }

  async mouseDown(button: 'left' | 'right'): Promise<void> {
    await this.client.call('mouse_down', { button });
  }

  async mouseUp(button: 'left' | 'right'): Promise<void> {
    await this.client.call('mouse_up', { button });
  }

  async scroll(amount: number): Promise<void> {
    await this.client.call('scroll', { amount });
  }

  async keyDown(spec: WinKeySpec): Promise<void> {
    await this.client.call('key_down', { vk: spec.vk, scan: spec.scan, extended: !!spec.extended, shift: !!spec.shift });
  }

  async keyUp(spec: WinKeySpec): Promise<void> {
    await this.client.call('key_up', { vk: spec.vk, scan: spec.scan, extended: !!spec.extended, shift: !!spec.shift });
  }

  async unicodeChar(ch: string): Promise<void> {
    await this.client.call('unicode_char', { ch });
  }

  async clearModifiers(): Promise<void> {
    await this.client.call('clear_modifiers');
  }

  async open(target: string): Promise<void> {
    await this.client.call('open', { target });
  }
}

// ── UIA seam-level capabilities (new in W3 — consumed by commands.ts) ────────

export interface UiaTreeParams {
  root?: 'foreground' | 'desktop';
  max_depth?: number;
  max_nodes?: number;
}

export interface UiaTreeResult {
  ok: true;
  tree: unknown;
  text: string;
  node_count: number;
}

export interface UiaInvokeParams {
  runtime_id: number[];
  pattern: 'invoke' | 'toggle' | 'expand' | 'select' | 'focus' | 'set_value';
  value?: string;
}

/** uia_tree — param validation mirrors the helper's clamp_tree_params. */
export async function uiaTree(client: RustHelperClient, p: UiaTreeParams): Promise<UiaTreeResult> {
  const root = p.root ?? 'foreground';
  if (root !== 'foreground' && root !== 'desktop') {
    throw new HelperProtocolError(HELPER_CODES.PARAMS, `invalid root: ${root} (expected 'foreground' or 'desktop')`);
  }
  const params: Record<string, unknown> = { root };
  if (p.max_depth !== undefined) {
    if (!Number.isFinite(p.max_depth) || p.max_depth < 1 || p.max_depth > 32) {
      throw new HelperProtocolError(HELPER_CODES.PARAMS, 'max_depth must be a number 1..32');
    }
    params.max_depth = Math.floor(p.max_depth);
  }
  if (p.max_nodes !== undefined) {
    if (!Number.isFinite(p.max_nodes) || p.max_nodes < 1 || p.max_nodes > 2000) {
      throw new HelperProtocolError(HELPER_CODES.PARAMS, 'max_nodes must be a number 1..2000');
    }
    params.max_nodes = Math.floor(p.max_nodes);
  }
  return client.call<UiaTreeResult>('uia_tree', params);
}

/** uia_invoke — set_value requires value; runtime_id must be a non-empty
 *  number array. The backend driver follows up with computer_screenshot
 *  exactly as after click/type (the helper does NOT capture on invoke). */
export async function uiaInvoke(client: RustHelperClient, p: UiaInvokeParams): Promise<{ ok: true }> {
  if (!Array.isArray(p.runtime_id) || p.runtime_id.length === 0 || !p.runtime_id.every((n) => Number.isFinite(n))) {
    throw new HelperProtocolError(HELPER_CODES.PARAMS, 'runtime_id must be a non-empty number[]');
  }
  const patterns = ['invoke', 'toggle', 'expand', 'select', 'focus', 'set_value'];
  if (!patterns.includes(p.pattern)) {
    throw new HelperProtocolError(HELPER_CODES.PARAMS, `invalid pattern: ${p.pattern} (invoke|toggle|expand|select|focus|set_value)`);
  }
  if (p.pattern === 'set_value' && (typeof p.value !== 'string' || p.value === '')) {
    throw new HelperProtocolError(HELPER_CODES.PARAMS, 'set_value requires a non-empty value string');
  }
  const params: Record<string, unknown> = {
    runtime_id: p.runtime_id.map((n) => Math.trunc(n)),
    pattern: p.pattern,
  };
  if (p.value !== undefined) params.value = p.value;
  return client.call<{ ok: true }>('uia_invoke', params);
}

/** environment_check — secure-desktop + elevated-foreground + foreground
 *  exe/rect (the agent-side safety preflights + the DRM heuristic input). */
export interface EnvironmentCheck {
  secure_desktop: boolean;
  elevated_foreground: boolean;
  foreground_exe: string;
  foreground_title: string;
  foreground_rect: { x: number; y: number; w: number; h: number };
  foreground_pid: number;
}

export async function environmentCheck(client: RustHelperClient): Promise<EnvironmentCheck> {
  return client.call<EnvironmentCheck>('environment_check');
}
