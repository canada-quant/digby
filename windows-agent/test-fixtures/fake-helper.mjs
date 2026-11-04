/**
 * Fake helper fixture — a plain Node .mjs script implementing the digby-win-
 * helper stdio protocol (line-delimited JSON), scripted per-test via env
 * DIGBY_FAKE_HELPER_MODE. The RustHelperClient spawns THIS through the same
 * code path the real exe takes (helperPath injection), so the client's
 * framing, id-echo, timeout, and error handling are tested on Linux CI
 * WITHOUT the Windows binary.
 *
 * Modes:
 *   ok            — every method answers ok:true with a plausible result
 *   refuse-elevated / refuse-secure / refuse-anticheat —
 *                   environment_check reports that condition; the SAFETY
 *                   GATE tests script these
 *   refuse-uia    — uia_tree/uia_invoke return the frozen UIA_E_* codes
 *   slow          — answers after 20s (the client's 15s timeout fires first)
 *   garbage       — writes non-JSON lines (the client skips them)
 *   die           — exits after the first request (pending calls reject)
 */

import { createInterface } from 'node:readline';

const MODE = process.env.DIGBY_FAKE_HELPER_MODE || 'ok';
let garbageSent = false;

const ENV_NORMAL = {
  secure_desktop: false,
  elevated_foreground: false,
  foreground_exe: 'Notepad.exe',
  foreground_title: 'Untitled - Notepad',
  foreground_rect: { x: 100, y: 100, w: 800, h: 600 },
  foreground_pid: 4321,
};

function environment(mode) {
  if (mode === 'refuse-elevated') return { ...ENV_NORMAL, elevated_foreground: true, foreground_exe: 'AdminApp.exe' };
  if (mode === 'refuse-secure') return { ...ENV_NORMAL, secure_desktop: true };
  if (mode === 'refuse-anticheat') return { ...ENV_NORMAL, foreground_exe: 'vgc.exe' };
  return ENV_NORMAL;
}

function tree() {
  return {
    name: 'Untitled - Notepad',
    role: 'window',
    automation_id: '',
    runtime_id: [42, 7],
    rect: { x: 100, y: 100, w: 800, h: 600 },
    focused: true,
    value: undefined,
    children: [
      {
        name: 'File',
        role: 'menuitem',
        automation_id: 'FileMenu',
        runtime_id: [42, 7, 1001],
        rect: { x: 108, y: 128, w: 40, h: 20 },
        focused: false,
        value: undefined,
        children: [],
      },
      {
        name: 'Edit',
        role: 'edit',
        automation_id: 'textBox1',
        runtime_id: [42, 7, 1002],
        rect: { x: 108, y: 152, w: 780, h: 520 },
        focused: false,
        value: 'hello world',
        children: [],
      },
    ],
  };
}

function linearize(node, indent = 0, out = []) {
  const pad = '  '.repeat(indent);
  let s = `${pad}- ${node.role} "${node.name}"`;
  if (node.automation_id) s += ` [${node.automation_id}]`;
  s += ` (${node.rect.x},${node.rect.y}) ${node.rect.w}x${node.rect.h}`;
  if (node.runtime_id?.length) s += ` #${node.runtime_id.join('.')}`;
  if (node.focused) s += ' *focused*';
  if (node.value) s += ` ="${node.value}"`;
  out.push(s);
  for (const c of node.children || []) linearize(c, indent + 1, out);
  return out;
}

function respond(id, ok, payload) {
  const line = ok
    ? JSON.stringify({ id, ok: true, result: payload })
    : JSON.stringify({ id, ok: false, error: payload });
  process.stdout.write(line + '\n');
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (raw) => {
  const trimmed = raw.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    respond(null, false, { code: 'HELPER_E_PARAMS', message: 'malformed request line' });
    return;
  }
  if (MODE === 'die') {
    process.exit(3);
  }
  if (MODE === 'slow') {
    setTimeout(() => respond(req.id, true, { ok: true }), 20_000);
    return;
  }
  // 'garbage': one junk line before the REAL answer — the client must skip
  // it and still resolve (falls through to normal handling below).
  if (MODE === 'garbage' && !garbageSent) {
    garbageSent = true;
    process.stdout.write('this is not json\n');
  }
  const params = req.params || {};
  switch (req.method) {
    case 'ping':
      respond(req.id, true, { version: '0.9.1', platform: 'fake' });
      return;
    case 'monitor_size':
      respond(req.id, true, { width: 2560, height: 1600 });
      return;
    case 'capture_bgra': {
      // 2x2 BGRA: red, green, blue, white (the jpeg-encode channel-swap input).
      const px = Buffer.alloc(2 * 2 * 4);
      const put = (x, b, g, r) => { const o = x * 4; px[o] = b; px[o + 1] = g; px[o + 2] = r; px[o + 3] = 0xff; };
      put(0, 0x00, 0x00, 0xff);
      put(1, 0x00, 0xff, 0x00);
      put(2, 0xff, 0x00, 0x00);
      put(3, 0xff, 0xff, 0xff);
      respond(req.id, true, { bgra_b64: px.toString('base64'), width: 2, height: 2, backend: 'wgc', vx: 0, vy: 0 });
      return;
    }
    case 'frontmost':
      respond(req.id, true, { app: 'Notepad.exe', window: 'Untitled - Notepad' });
      return;
    case 'geometry':
      respond(req.id, true, {
        x: 0, y: 0, width: 2560, height: 1600,
        monitors: [{ x: 0, y: 0, width: 2560, height: 1600, dpi: 144 }],
      });
      return;
    case 'cursor_pos':
      respond(req.id, true, { x: 1280, y: 800 });
      return;
    case 'move_to':
    case 'mouse_down':
    case 'mouse_up':
    case 'scroll':
    case 'key_down':
    case 'key_up':
    case 'unicode_char':
    case 'clear_modifiers':
    case 'open':
      respond(req.id, true, { ok: true });
      return;
    case 'environment_check':
      respond(req.id, true, environment(MODE));
      return;
    case 'uia_tree': {
      if (MODE === 'refuse-uia') {
        respond(req.id, false, { code: 'UIA_E_UNSUPPORTED', message: 'that pattern is not implemented by this element; inspect its role in the tree and pick a pattern it supports' });
        return;
      }
      const root = params.root === 'desktop' ? 'desktop' : 'foreground';
      const t = tree();
      respond(req.id, true, {
        ok: true,
        tree: t,
        text: linearize(t).join('\n') + '\n',
        node_count: 3,
      });
      void root;
      return;
    }
    case 'uia_invoke': {
      if (MODE === 'refuse-uia') {
        respond(req.id, false, { code: 'UIA_E_NOT_FOUND', message: 'the element is gone (the UI tree changed since the last computer_uia_tree); take a fresh tree and retry with the new runtime_id' });
        return;
      }
      if (params.pattern === 'set_value' && !params.value) {
        respond(req.id, false, { code: 'HELPER_E_PARAMS', message: 'set_value requires a value string' });
        return;
      }
      respond(req.id, true, { ok: true });
      return;
    }
    default:
      respond(req.id, false, { code: 'HELPER_E_PARAMS', message: `unknown method: ${req.method}` });
  }
});
rl.on('close', () => process.exit(0));
