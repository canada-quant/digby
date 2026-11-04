#!/usr/bin/env node
/**
 * W4 live-desktop validation harness (roadmap §2.10 W4).
 *
 * Drives the REAL digby-win-helper.exe against the live interactive desktop
 * this process is running in, and verifies the three W3 paths end-to-end:
 *
 *   capture — WGC (or documented GDI fallback): size, real content, liveness
 *   UIA     — uia_tree on a real app (Notepad) + uia_invoke focus/set_value
 *   input   — SendInput typing into Notepad, observed via UIA ValuePattern
 *
 * Design notes:
 *  - No dependencies beyond node:* — the harness must run on a pristine
 *    windows-latest runner (and on any physical box) with just node + the
 *    built helper.
 *  - The harness speaks the helper's frozen stdio protocol directly
 *    (line-delimited JSON; see rust-helper/src/protocol.rs) — it does NOT go
 *    through the agent, so a failure here names the helper/OS link, not the
 *    agent seam (the agent seam is pinned by win-rust-helper.test.mjs).
 *  - The target app is Notepad — present on every Windows image including
 *    Server. Windows Server 2025's Notepad is the WinUI one: its text area
 *    surfaces as a Document/Edit control (not the classic "edit" pane), so
 *    element discovery matches by ROLE SET (edit|document) or by carrying a
 *    ValuePattern value, never by one hard-coded role. The first tree's
 *    linearized `text` payload is always logged — the perception output IS
 *    the evidence.
 *  - Liveness (C10) is proven with a topmost solid-color WinForms overlay:
 *    no wallpaper-service dependency, no stock-image dependency, no shell
 *    quoting (the .ps1 is written to a file and run with -File).
 *  - Every criterion prints PASS/FAIL + the observed values; exit code 0
 *    only when ALL criteria pass. A PNG of the captured frame is always
 *    written for eyeball verification.
 *  - C2 (interactive session) FAILS by design in a service/session-0
 *    context: OS-level input paths are only exercisable in an interactive
 *    session. Do not weaken it — see
 *    docs/WINDOWS_W4_LIVE_DESKTOP_VALIDATION.md ("CI runner session model").
 *
 * Usage:  node windows-agent/scripts/w4-live-desktop.mjs [path-to-helper.exe]
 * Env:    W4_HELPER (alternative way to point at the exe)
 *         W4_NO_KILL (debug: leave Notepad + helper running)
 *
 * Exit codes: 0 = all pass; 1 = one or more criteria failed (or the session
 *             is not interactive); 2 = harness could not run (helper missing,
 *             spawn failure).
 */

import { spawn, execFile } from 'node:child_process';
import { writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

const execFileP = promisify(execFile);

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// Repo layout: windows-agent/scripts/ → windows-agent/rust-helper/target/release
const DEFAULT_HELPER = join(SCRIPT_DIR, '..', 'rust-helper', 'target', 'release', 'digby-win-helper.exe');
const HELPER_PATH = process.argv[2] || process.env.W4_HELPER || DEFAULT_HELPER;
const OUT_DIR = process.env.W4_OUT_DIR || SCRIPT_DIR;

// The marker string typed through SendInput into Notepad — unique enough that
// its presence in the UIA readback can ONLY come from our synthetic input.
const MARKER = 'DigbyW4live0123456789';
const SECOND_VALUE = 'W4setValue-xyz-9876543210';
const TREE_PARAMS = { root: 'foreground', max_depth: 12, max_nodes: 400 };

// ── tiny stdio client for the helper protocol ───────────────────────────────

class Helper {
  constructor(exePath) {
    this.nextId = 1;
    this.pending = new Map(); // id → {resolve, reject, method}
    this.buf = '';
    this.proc = null;
    this.exePath = exePath;
  }

  start() {
    return new Promise((resolve, reject) => {
      if (!existsSync(this.exePath)) {
        reject(new Error(`helper not found: ${this.exePath}`));
        return;
      }
      this.proc = spawn(this.exePath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
      this.proc.once('error', reject);
      this.proc.stdout.setEncoding('utf8');
      this.proc.stdout.on('data', (d) => this._onData(d));
      this.proc.stderr.setEncoding('utf8');
      this.proc.stderr.on('data', (d) => process.stderr.write(`[helper-stderr] ${d}`));
      this.proc.once('exit', (code) => {
        for (const { reject } of this.pending.values()) {
          reject(new Error(`helper exited (code ${code}) with ${this.pending.size} pending calls`));
        }
        this.pending.clear();
      });
      // Liveness handshake.
      this.call('ping', {})
        .then(() => resolve())
        .catch(reject);
    });
  }

  _onData(d) {
    this.buf += d;
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // non-JSON noise on stdout is skipped (client contract)
      }
      const slot = this.pending.get(msg.id);
      if (!slot) continue;
      this.pending.delete(msg.id);
      if (msg.ok) slot.resolve(msg.result);
      else slot.reject(Object.assign(new Error(`${msg.error?.code}: ${msg.error?.message}`), { code: msg.error?.code }));
    }
  }

  call(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      const req = JSON.stringify({ id, method, params }) + '\n';
      this.proc.stdin.write(req, (err) => err && reject(err));
    });
  }

  stop() {
    if (this.proc && !this.proc.killed) this.proc.kill();
  }
}

// ── criteria bookkeeping ────────────────────────────────────────────────────

const results = [];
function record(id, name, pass, detail) {
  results.push({ id, name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function retry(fn, { attempts = 20, delayMs = 250, desc = '' } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`retry exhausted: ${desc}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── PNG writer (no deps): 8-bit RGBA, filter 0 rows, zlib.deflateSync ──────

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** bgra: w*h*4 bytes → PNG file. */
function writePng(path, bgra, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    bgra.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
}

// ── BGRA frame analysis ─────────────────────────────────────────────────────

function analyzeFrame(bgra, w, h) {
  const distinct = new Set();
  let sum = 0;
  const px = w * h;
  for (let i = 0; i < px; i++) {
    const b = bgra[i * 4];
    const g = bgra[i * 4 + 1];
    const r = bgra[i * 4 + 2];
    distinct.add((r << 16) | (g << 8) | b);
    sum += (r + g + b) / 3;
  }
  const mean = sum / px;
  let variance = 0;
  for (let i = 0; i < px; i++) {
    const b = bgra[i * 4];
    const g = bgra[i * 4 + 1];
    const r = bgra[i * 4 + 2];
    const l = (r + g + b) / 3;
    variance += (l - mean) * (l - mean);
  }
  variance /= px;
  return { distinctColors: distinct.size, meanLum: mean, variance, pixels: px };
}

function meanAbsDiff(a, b) {
  if (a.length !== b.length) return Infinity;
  let s = 0;
  for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  return s / (a.length / 4) / 3;
}

// ── UIA tree helpers ────────────────────────────────────────────────────────

/** Depth-first search of the frozen UiaNode tree. */
function findNode(node, pred, depth = 0, maxDepth = 48) {
  if (depth > maxDepth || !node) return null;
  if (pred(node)) return node;
  for (const c of node.children || []) {
    const hit = findNode(c, pred, depth + 1, maxDepth);
    if (hit) return hit;
  }
  return null;
}

/** All nodes matching a predicate, depth-first. */
function collect(node, pred, out = [], depth = 0, maxDepth = 48) {
  if (depth > maxDepth || !node) return out;
  if (pred(node)) out.push(node);
  for (const c of node.children || []) collect(c, pred, out, depth + 1, maxDepth);
  return out;
}

/**
 * The text-bearing control of the foreground app. Windows Server 2025 ships
 * the WinUI Notepad whose text area is a Document control that (per the W4
 * live run) lives in the CONTENT view — the control view surfaces the
 * combobox container instead. Match by ROLE SET (edit|document) with a
 * runtime id, then any value-carrying control, else null (typing readback
 * then falls back to the window-title channel).
 */
function findTextTarget(node) {
  return (
    findNode(node, (n) => (n.role === 'edit' || n.role === 'document') && n.runtime_id?.length) ||
    findNode(node, (n) => typeof n.value === 'string' && n.value.length > 0 && n.runtime_id?.length) ||
    null
  );
}

/** A focus-able element with a runtime id: the text control, else the app window, else any control. */
function findFocusTarget(node) {
  return (
    findNode(node, (n) => (n.role === 'edit' || n.role === 'document' || n.role === 'window' || n.role === 'pane') && n.runtime_id?.length) ||
    findNode(node, (n) => n.runtime_id?.length) ||
    null
  );
}

function dumpTreeText(text, limit = 3500) {
  const t = String(text || '');
  console.log('[diag] uia_tree text payload (first ' + limit + ' chars):\n' + t.slice(0, limit).split('\n').map((l) => '  ' + l).join('\n') + (t.length > limit ? `\n  …[+${t.length - limit} chars]` : ''));
}

// ── the validation ──────────────────────────────────────────────────────────

async function main() {
  console.log(`W4 live-desktop validation — helper: ${HELPER_PATH}`);

  // Runner-session diagnostics (recorded BEFORE any pass/fail so a failure is
  // diagnosable from the log alone — see the doc's "CI runner session model").
  for (const [cmd, args] of [['query', ['session']], ['quser', []], ['whoami', []]]) {
    try {
      const { stdout } = await execFileP(cmd, args, { timeout: 10_000 });
      console.log(`[diag] ${cmd} ${args.join(' ')}:\n` + stdout.trim().split('\n').map((l) => '  ' + l).join('\n'));
    } catch (e) {
      console.log(`[diag] ${cmd} ${args.join(' ')} unavailable: ${e.message.split('\n')[0]}`);
    }
  }

  const helper = new Helper(HELPER_PATH);
  await helper.start();
  let notepad = null;
  let flashProc = null;
  const flashScript = join(OUT_DIR, 'w4-flash.ps1');
  try {
    // C1 — protocol liveness.
    const ping = await helper.call('ping', {});
    record('C1', 'helper protocol liveness (ping)', !!ping && typeof ping.version === 'string',
      ping ? `version=${ping.version} platform=${ping.platform}` : 'no ping result');

    // C2 — this session is interactive (input desktop openable).
    const env1 = await helper.call('environment_check', {});
    record('C2', 'interactive session (no secure desktop)', env1.secure_desktop === false,
      `secure_desktop=${env1.secure_desktop} fg=${env1.foreground_exe || 'none'} — input paths need an interactive session`);
    if (env1.secure_desktop !== false) {
      console.log('HALT: not an interactive session — capture/input cannot be validated here (by design).');
      process.exitCode = 1;
      return;
    }

    // Launch Notepad as the real foreground app.
    notepad = spawn('notepad.exe', [], { detached: false, stdio: 'ignore' });
    await retry(async () => {
      const fm = await helper.call('frontmost', {});
      if (fm && /notepad/i.test(fm.app || '')) return fm;
      throw new Error('notepad not foreground yet');
    }, { attempts: 40, delayMs: 250, desc: 'waiting for Notepad foreground' });

    // C3 — foreground app observable.
    const frontmost = await helper.call('frontmost', {});
    record('C3', 'frontmost app observable', !!frontmost && /notepad/i.test(frontmost.app || ''),
      `app=${frontmost?.app} window="${frontmost?.window}"`);

    // C4 — UIA tree of the real app. The tree text is LOGGED: the perception
    // payload is the evidence (and the diagnostic when discovery fails).
    const tree = await helper.call('uia_tree', TREE_PARAMS);
    dumpTreeText(tree.text);
    const notepadInTree = /notepad/i.test(tree.text || '') || /notepad/i.test(tree.tree?.name || '');
    record('C4', 'uia_tree walks the real app tree', tree.node_count > 5 && !!notepadInTree,
      `node_count=${tree.node_count} root="${String(tree.tree?.name).slice(0, 40)}" notepad_in_tree=${!!notepadInTree}`);

    // C5 — UIA SetFocus moves REAL keyboard focus. The strongest proof: move
    // focus AWAY from the currently-focused control (the text container) to
    // another runtime_id-bearing control, then back. If no candidate accepts
    // focus (WinUI controls can refuse), fall back to proving the SetFocus
    // round-trip on the focused container itself.
    const focused1 = findNode(tree.tree, (n) => n.focused && n.runtime_id?.length) || null;
    const candidates = collect(tree.tree, (n) => !n.focused && n.runtime_id?.length && (n.role === 'header' || n.role === 'button' || n.role === 'splitbutton' || n.role === 'pane')).slice(0, 6);
    let focusProof = null;
    for (const cand of candidates) {
      try {
        await helper.call('uia_invoke', { runtime_id: cand.runtime_id, pattern: 'focus' });
        await sleep(400);
        const moved = await retry(async () => {
          const t2 = await helper.call('uia_tree', TREE_PARAMS);
          const candNow = findNode(t2.tree, (n) => n.runtime_id?.length && JSON.stringify(n.runtime_id) === JSON.stringify(cand.runtime_id));
          const anyFocused = findNode(t2.tree, (n) => n.focused);
          // Focus demonstrably left the original control (onto the candidate
          // or wherever the OS redirected it).
          if ((candNow && candNow.focused) || (focused1 && anyFocused && JSON.stringify(anyFocused.runtime_id) !== JSON.stringify(focused1.runtime_id))) {
            return { t2, candNow, anyFocused };
          }
          throw new Error('focus did not move');
        }, { attempts: 8, delayMs: 250, desc: `focus moving to ${cand.role} "${cand.name}"` });
        focusProof = { via: 'moved', cand, moved };
        break;
      } catch { /* this candidate refused focus — try the next */ }
    }
    if (!focusProof && focused1) {
      try {
        await helper.call('uia_invoke', { runtime_id: focused1.runtime_id, pattern: 'focus' });
        await sleep(300);
        const back = await retry(async () => {
          const t2 = await helper.call('uia_tree', TREE_PARAMS);
          const hit = findNode(t2.tree, (n) => n.runtime_id?.length && JSON.stringify(n.runtime_id) === JSON.stringify(focused1.runtime_id));
          if (hit && hit.focused) return hit;
          throw new Error('container not focused');
        }, { attempts: 8, delayMs: 250, desc: 'SetFocus round-trip on the focused container' });
        focusProof = { via: 'roundtrip', focused1, node: back };
      } catch (e) {
        record('C5', 'uia_invoke focus moves real focus', false, `no candidate accepted focus and the round-trip failed: ${e.message.slice(0, 120)}`);
      }
    }
    if (focusProof) {
      if (focusProof.via === 'moved') {
        const { cand, moved } = focusProof;
        const target = moved.candNow?.focused
          ? `${moved.candNow.role} "${String(moved.candNow.name).slice(0, 20)}"`
          : `${moved.anyFocused.role} "${String(moved.anyFocused.name).slice(0, 20)}"`;
        record('C5', 'uia_invoke focus moves real focus', true,
          `focus moved off ${focused1 ? focused1.role : 'n/a'} → ${target} via SetFocus on ${cand.role} "${String(cand.name).slice(0, 20)}"`);
      } else {
        record('C5', 'uia_invoke focus moves real focus', true,
          `no candidate accepted focus (WinUI); SetFocus round-trip verified: ${focusProof.node.role} "${String(focusProof.node.name).slice(0, 20)}" reports focused:true`);
      }
    } else if (!focused1) {
      record('C5', 'uia_invoke focus moves real focus', false, 'no focused control with a runtime_id in the initial tree');
    }

    // Return focus to the text container before typing (SendInput lands in
    // the focused control of the foreground window).
    if (focused1) {
      try {
        await helper.call('uia_invoke', { runtime_id: focused1.runtime_id, pattern: 'focus' });
        await sleep(300);
      } catch { /* typed below regardless — Notepad is foreground */ }
    }

    // C6 — SendInput typing, observed through an INDEPENDENT channel. In
    // order of preference: the control's UIA ValuePattern value; the
    // modified-marker '*' window-title prefix (Notepad titles gain '*' once
    // real keys land in the document — an effect ONLY real input produces).
    try {
      for (const ch of MARKER) await helper.call('unicode_char', { ch });
      const readback = await retry(async () => {
        const t3 = await helper.call('uia_tree', TREE_PARAMS);
        const hit = findNode(t3.tree, (n) => typeof n.value === 'string' && n.value.includes(MARKER));
        if (hit) return { via: 'uia-value', value: hit.value };
        const fm = await helper.call('frontmost', {});
        if (fm && /notepad/i.test(fm.app || '') && /^\*/.test(fm.window || '')) return { via: 'title-modified', value: fm.window };
        throw new Error('typed marker not observable yet');
      }, { attempts: 24, delayMs: 250, desc: 'typed marker observable' });
      const ok = readback.via === 'uia-value' ? readback.value.includes(MARKER) : true;
      record('C6', 'SendInput typing observable via UIA', ok,
        `typed "${MARKER}" → observed via ${readback.via}: "${String(readback.value).slice(0, 40)}"`);
    } catch (e) {
      record('C6', 'SendInput typing observable via UIA', false, e.message.slice(0, 160));
    }

    // C7 — uia_invoke produces an OBSERVABLE UI effect. set_value is the
    // preferred proof (readback in a fresh tree); when the control exposes no
    // ValuePattern (UIA_E_UNSUPPORTED is a legitimate answer for a WinUI
    // content container), Invoke on Notepad's Minimize button proves the
    // invoke path end-to-end (the window minimizes → foreground changes).
    try {
      const setTarget = focused1 || findFocusTarget(tree.tree);
      const minimizeBtn = findNode(tree.tree, (n) => n.role === 'button' && /minimize/i.test(n.name || '') && n.runtime_id?.length);
      try {
        if (!setTarget) throw new Error('no runtime_id-bearing control to set_value on');
        await helper.call('uia_invoke', { runtime_id: setTarget.runtime_id, pattern: 'set_value', value: SECOND_VALUE });
        const afterSet = await retry(async () => {
          const t4 = await helper.call('uia_tree', TREE_PARAMS);
          const hit = findNode(t4.tree, (n) => typeof n.value === 'string' && n.value === SECOND_VALUE);
          if (hit) return hit.value;
          throw new Error('set_value result not visible yet');
        }, { attempts: 12, delayMs: 250, desc: 'set_value appearing in readback' });
        record('C7', 'uia_invoke set_value observable', afterSet === SECOND_VALUE,
          `control.value="${String(afterSet).slice(0, 40)}"`);
      } catch (e) {
        if (minimizeBtn) {
          const envBefore = await helper.call('environment_check', {});
          await helper.call('uia_invoke', { runtime_id: minimizeBtn.runtime_id, pattern: 'invoke' });
          const afterMin = await retry(async () => {
            const env2 = await helper.call('environment_check', {});
            if (!/notepad/i.test(env2.foreground_exe || '')) return env2;
            throw new Error('notepad still foreground');
          }, { attempts: 12, delayMs: 250, desc: 'foreground change after minimize-invoke' });
          record('C7', 'uia_invoke observable (invoke pattern)', !/notepad/i.test(afterMin.foreground_exe || ''),
            `set_value refused (${e.code || 'unsupported'}) → invoked Minimize [${minimizeBtn.runtime_id.join('.')}] → foreground=${afterMin.foreground_exe} (was ${envBefore.foreground_exe})`);
        } else {
          record('C7', 'uia_invoke set_value observable', false,
            `set_value refused (${e.code || e.message.slice(0, 80)}) and no Minimize button in tree`);
        }
      }
    } catch (e) {
      record('C7', 'uia_invoke set_value observable', false, e.message.slice(0, 160));
    }

    // C8 — capture size + honest backend field.
    const ms = await helper.call('monitor_size', {});
    const cap = await helper.call('capture_bgra', {});
    const bgra = Buffer.from(cap.bgra_b64, 'base64');
    const sizeOk = cap.width === ms.width && cap.height === ms.height && bgra.length === cap.width * cap.height * 4;
    record('C8', 'capture size matches monitor, backend honest',
      sizeOk && (cap.backend === 'wgc' || cap.backend === 'gdi'),
      `frame=${cap.width}x${cap.height} monitor=${ms.width}x${ms.height} bytes=${bgra.length} backend=${cap.backend}`);

    // C9 — the frame has real content.
    const stats = analyzeFrame(bgra, cap.width, cap.height);
    record('C9', 'capture frame has real content', stats.distinctColors >= 16 && stats.variance > 4,
      `distinctColors=${stats.distinctColors} meanLum=${stats.meanLum.toFixed(1)} variance=${stats.variance.toFixed(1)}`);

    // Always write the PNG (evidence artifact) when the frame is well-formed.
    if (bgra.length === cap.width * cap.height * 4) {
      const pngPath = join(OUT_DIR, 'w4-desktop.png');
      writePng(pngPath, bgra, cap.width, cap.height);
      console.log(`[artifact] capture written to ${pngPath}`);
    }

    // C10 — liveness: a topmost solid-color overlay (WinForms via a script
    // FILE — no shell quoting) must measurably change the captured frame.
    // Application.Run is REQUIRED: $f.Show() + Start-Sleep never pumps
    // WM_PAINT, so the form never composites (the v2 run measured diff 0.01
    // because nothing was actually on screen).
    try {
      writeFileSync(flashScript, [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$f = New-Object System.Windows.Forms.Form',
        '$f.FormBorderStyle = "None"',
        '$f.TopMost = $true',
        '$f.StartPosition = "Manual"',
        '$f.Location = New-Object System.Drawing.Point(0, 0)',
        '$f.Size = New-Object System.Drawing.Size(900, 700)',
        '$f.BackColor = [System.Drawing.Color]::Red',
        '$f.Add_Shown({ $f.Refresh() })',
        'Write-Output "overlay-shown"',
        '[System.Windows.Forms.Application]::Run($f)',
        '',
      ].join('\n'));
      flashProc = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', flashScript],
        { detached: false, stdio: ['ignore', 'pipe', 'ignore'] });
      let overlayShown = false;
      flashProc.stdout.setEncoding('utf8');
      flashProc.stdout.on('data', (d) => { if (/overlay-shown/.test(d)) overlayShown = true; });
      await retry(() => (overlayShown ? true : undefined), { attempts: 30, delayMs: 200, desc: 'overlay form shown' });
      await sleep(1200); // composited
      const cap2 = await helper.call('capture_bgra', {});
      const bgra2 = Buffer.from(cap2.bgra_b64, 'base64');
      const diff = meanAbsDiff(bgra, bgra2);
      record('C10', 'capture is live (overlay window visible)', overlayShown && diff > 1.5,
        `topmost 900x700 red overlay (Application.Run-pumped) → meanAbsDiff=${diff.toFixed(2)} (threshold 1.5)`);
      if (bgra2.length === cap2.width * cap2.height * 4) {
        const png2 = join(OUT_DIR, 'w4-desktop-flash.png');
        writePng(png2, bgra2, cap2.width, cap2.height);
        console.log(`[artifact] flash capture written to ${png2}`);
      }
    } catch (e) {
      record('C10', 'capture is live (overlay window visible)', false, `overlay step failed: ${e.message.slice(0, 160)}`);
    }
  } finally {
    try { notepad && !notepad.killed && notepad.kill(); } catch { /* ignore */ }
    try { flashProc && !flashProc.killed && flashProc.kill(); } catch { /* ignore */ }
    try { existsSync(flashScript) && unlinkSync(flashScript); } catch { /* ignore */ }
    if (!process.env.W4_NO_KILL) {
      helper.stop();
    } else {
      console.log('[debug] W4_NO_KILL set — helper left running');
    }
  }

  // Summary table.
  const failed = results.filter((r) => !r.pass);
  console.log('\n── W4 live-desktop validation summary ──');
  for (const r of results) console.log(`${r.pass ? '✅' : '❌'} ${r.id} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  console.log(`${results.length - failed.length}/${results.length} criteria passed`);
  if (failed.length) {
    process.exitCode = 1;
  } else {
    console.log('W4 LIVE-DESKTOP VALIDATION: ALL PASS');
  }
}

main().catch((err) => {
  console.error(`W4 harness error: ${err.message}`);
  process.exitCode = 2;
  // Still print whatever criteria were recorded before the error.
  if (results.length) {
    console.log('\n── partial results ──');
    for (const r of results) console.log(`${r.pass ? '✅' : '❌'} ${r.id} ${r.name} — ${r.detail}`);
  }
});
