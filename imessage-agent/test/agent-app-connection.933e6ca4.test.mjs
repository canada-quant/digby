/**
 * Ticket 933e6ca4 — "installer update breaks Mac desktop app UI connection;
 * agent/app duality unclear" (owner report, cql-stanne-mbp-1, 2026-10-16).
 *
 * Four linked defects, four fix pins in this suite:
 *
 *  1. THE RESURRECT LOOP (the persistent "update the agent" nag):
 *     install.sh booted out the .app-bundled helper's launchd job but LEFT
 *     its plist in ~/Library/LaunchAgents. launchd loads every plist in
 *     that folder at login → the stale bundled helper came back at every
 *     reboot and polled beside the current agent with the SAME token →
 *     the stored agentVersion flapped → the web card's update hint never
 *     cleared, reading exactly like "the nag tracks the Mac app version".
 *     Pinned here: install.sh now REMOVES the plist (rm -f), and the agent
 *     itself retires it on startup (retire-bundled-helper.ts) so the fix
 *     reaches already-installed Macs via self-update.
 *
 *  2. THE DISCONNECT (UI loses connection on every update run):
 *     install.sh fired an UNCONDITIONAL (sleep 45; launchctl unload; load)
 *     bounce on every installer run — the poll gap crossed the backend's
 *     45s ONLINE_WINDOW_MS and the card flipped Offline. Now: kickstart -k
 *     (no unload/load window) and ONLY when a permission was just granted
 *     (there is something to pick up); an --update-only run with FDA
 *     already granted never bounces the service at all.
 *
 *  3. THE TCC LIE (black degenerate frames while the card shows ✓):
 *     replacing/deleting the helper binary orphans its Screen Recording
 *     grant (new binary = new identity), but screencapture from a
 *     TCC-orphaned process EXITS 0 with a well-formed SOLID-BLACK frame at
 *     full resolution — the probe therefore reported GRANTED while every
 *     capture was blind. Pinned here: the solid-placeholder detector
 *     (isUniformFrame / pngSolidPlaceholder) and its wiring.
 *
 *  4. THE NAMING (which binary holds which permission):
 *     app vs DigbyHelper vs DigbyAgent — the permission hint now names the
 *     actual binary (process.execPath basename) and explains the
 *     replaced-binary grant orphaning.
 *
 * Source-byte pins follow the repo idiom (computer-display.0.6.1.test.mjs):
 * compiled dist/ imports for the pure functions, raw source reads for the
 * installer and the wiring the dist build cannot express.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');

// Compiled pure functions (the build runs before the suite: npm test = build + test).
const { isUniformFrame, pngSolidPlaceholder, pngDimensions, convictAfterCorroboration } = await import('../dist/computer.js');
const { isAppBundledPlist, bundledAgentPlistPath, retireBundledHelper, runningIsBundledHelper, BUNDLED_AGENT_LABEL } =
  await import('../dist/retire-bundled-helper.js');

const read = (p) => readFileSync(join(pkgRoot, p), 'utf8');
const installSh = read('install.sh');
const bootstrap = read('../frontend/public/install-digby-agent.sh');

// ── helpers ───────────────────────────────────────────────────────────────────

function ihdr(w, h, bitDepth, colorType, interlace) {
  // 13-byte IHDR payload: w, h (BE32), bitDepth, colorType, compression,
  // filter, interlace — preceded by a length + type, followed by a CRC
  // (contents irrelevant; the decoder must not verify it).
  const b = Buffer.alloc(13);
  b.writeUInt32BE(w, 0); b.writeUInt32BE(h, 4);
  b[8] = bitDepth; b[9] = colorType; b[10] = 0; b[11] = 0; b[12] = interlace;
  return b;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  return Buffer.concat([head, data, Buffer.alloc(4)]);  // CRC not verified
}

function makePng({ w = 4, h = 4, bpp = 3, fill = [10, 10, 10], filters = null }) {
  const rowBytes = w * bpp;
  const raw = Buffer.alloc((rowBytes + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (rowBytes + 1)] = filters ? filters[y % filters.length] : 0;
    for (let x = 0; x < rowBytes; x++) raw[y * (rowBytes + 1) + 1 + x] = fill[x % bpp];
  }
  const colorType = bpp === 4 ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr(w, h, 8, colorType, 0)),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── 1. THE RESURRECT LOOP ─────────────────────────────────────────────────────

test('933e6ca4: install.sh removes the bundled-agent plist — no resurrect at login', () => {
  // The old code only booted the job out; the plist stayed and launchd
  // re-loaded it at the next login. The fix must delete the file.
  assert.match(installSh, /APP_PLIST="\$HOME\/Library\/LaunchAgents\/ai\.digby\.imessage-agent\.plist"/);
  assert.match(installSh, /rm -f "\$APP_PLIST"/);
  // …and the removal must happen BEFORE our own service loads (the two must
  // never poll side by side), so the ordering of these two lines is pinned.
  const retireAt = installSh.indexOf('rm -f "$APP_PLIST"');
  const loadAt = installSh.indexOf('launchctl load "$PLIST_DEST"');
  assert.ok(retireAt >= 0 && loadAt >= 0, 'both the retire and the load exist');
  assert.ok(retireAt < loadAt, 'the bundled plist is retired BEFORE this service loads');
});

test('933e6ca4 reviewer B3: install.sh retires by CONTENT, never by label alone', () => {
  // The signed .pkg's postinstall writes the SAME label at the SAME path as
  // the desktop app's bundled helper — a blind label delete can never be the
  // mechanism. The installer must read the plist's ProgramArguments and retire
  // by SHAPE: the .app-bundled path (933e6ca4) and the /Library/Digby .pkg
  // prefix (405927c9 — the .pkg never self-updates, so it is retireable too).
  assert.match(installSh, /APP_PROG=/);
  assert.match(installSh, /ProgramArguments<\\\/key>/);
  assert.match(installSh, /"\$APP_PROG" == \*"\.app\/Contents\/Resources\/"\*/);
  assert.match(installSh, /"\$APP_PROG" == "\/Library\/Digby\/"\*/);
  // The unknown shapes still get the leave-alone branch + honest copy.
  assert.match(installSh, /left running/);
  assert.match(installSh, /Only the app-bundled helper and the old \.pkg install are retired/);
  // Ordering: the shape read happens BEFORE any bootout/rm of that plist.
  const readAt = installSh.indexOf('APP_PROG=');
  const rmAt = installSh.indexOf('rm -f "$APP_PLIST"');
  assert.ok(readAt >= 0 && rmAt > readAt, 'the shape is read before the plist is removed');
});

test('933e6ca4 reviewer MAJOR: install.sh preserves an unchanged DigbyAgent binary (TCC grants survive)', () => {
  // cp -f recreated the binary (new inode = new app to TCC) on EVERY run —
  // re-orphaning SR/AX/FDA grants each update, the ticket's own mishap. The
  // guard: only copy when the bytes differ. (21c68e74: the comparison is now
  // against $RUNTIME_SRC — the official self-contained build when the
  // resolved node is keg-coupled, the resolved node itself otherwise.)
  assert.match(installSh, /cmp -s "\$RUNTIME_SRC" "\$DIGBY_AGENT_BIN"/);
  assert.match(installSh, /existing macOS permissions stay valid/);
  assert.match(installSh, /binary changed — macOS may need its permissions re-granted/);
});

test('933e6ca4: install.sh tells the user what was retired and why (naming, fix d)', () => {
  assert.match(installSh, /stopped an old Digby install/);
  assert.match(installSh, /cannot come back at the next login/);
  // The stale DigbyHelper pane entries can be cleaned up by hand.
  assert.match(installSh, /DigbyHelper/);
});

test('933e6ca4: isAppBundledPlist retires ONLY the .app-bundled shape', () => {
  const appPlist = `<?xml version="1.0"?><plist version="1.0"><dict>
    <key>Label</key><string>ai.digby.imessage-agent</string>
    <key>ProgramArguments</key><array>
      <string>/Applications/Digby.app/Contents/Resources/imessage-agent/DigbyHelper</string>
      <string>run</string>
    </array></dict></plist>`;
  const pkgPlist = appPlist.replace(/\/Applications\/Digby\.app\/Contents\/Resources\/imessage-agent\/DigbyHelper/, '/Library/Digby/imessage-agent/DigbyAgent');
  // The .app-bundled copy is the one that retires…
  assert.equal(isAppBundledPlist(appPlist), true);
  // …the signed .pkg install (same label, /Library/Digby path) is NOT touched…
  assert.equal(isAppBundledPlist(pkgPlist), false);
  // …and neither is anything unreadable or unparseable (unknown ⇒ untouched).
  assert.equal(isAppBundledPlist(null), false);
  assert.equal(isAppBundledPlist('<not-a-plist'), false);
  assert.equal(isAppBundledPlist('<plist><dict><key>Label</key><string>x</string></dict></plist>'), false);
});

test('933e6ca4: retireBundledHelper end-to-end on a scratch HOME (bootout + rm)', () => {
  const home = join(pkgRoot, 'test', '.scratch-933e6ca4');
  rmSync(home, { recursive: true, force: true });
  const agents = join(home, 'Library', 'LaunchAgents');
  mkdirSync(agents, { recursive: true });
  const plist = join(agents, 'ai.digby.imessage-agent.plist');
  writeFileSync(plist, `<?xml version="1.0"?><plist version="1.0"><dict>
    <key>Label</key><string>ai.digby.imessage-agent</string>
    <key>ProgramArguments</key><array>
      <string>/Applications/Digby.app/Contents/Resources/imessage-agent/DigbyHelper</string>
      <string>run</string>
    </array></dict></plist>`);
  // bundledAgentPlistPath is pure w.r.t. its home argument.
  assert.equal(bundledAgentPlistPath(home), plist);
  // retireBundledHelper is best-effort: launchctl may be absent on the CI box
  // (the spawnSync must not throw), and what MUST happen regardless is the
  // plist's removal — that is what ends the resurrect-at-login loop.
  let r;
  try { r = retireBundledHelper(home); } catch (e) { assert.fail(`retireBundledHelper threw: ${e}`); }
  assert.equal(r.present, true);
  assert.equal(r.retired, true);
  assert.equal(existsSync(plist), false, 'the plist file must be gone');
  // A second call (every startup) is a no-op — no state, no error.
  const r2 = retireBundledHelper(home);
  assert.equal(r2.present, false);
  assert.equal(r2.retired, false);
  rmSync(home, { recursive: true, force: true });
});

test('933e6ca4 → 405927c9: retireBundledHelper now RETIRES a .pkg-install plist too', () => {
  // 933e6ca4 (original policy): the .pkg install was a supported install and
  // was left completely alone. 405927c9 REVERSED that policy deliberately:
  // the .pkg never self-updates (root-owned payload, no bundled npm), the
  // SERVED .pkg froze agent 0.1.0 from June 2026 to October 2026, and a .pkg
  // install polling beside a self-managed agent with the same token flaps the
  // stored agentVersion forever — the ticket's "still says I have old 0.63".
  // The self-managed agent (the only shape that CAN update) now retires it.
  const home = join(pkgRoot, 'test', '.scratch-933e6ca4-pkg');
  rmSync(home, { recursive: true, force: true });
  const agents = join(home, 'Library', 'LaunchAgents');
  mkdirSync(agents, { recursive: true });
  const plist = join(agents, 'ai.digby.imessage-agent.plist');
  // Both postinstall generations: the current one names DigbyAgent …
  writeFileSync(plist, `<?xml version="1.0"?><plist version="1.0"><dict>
    <key>Label</key><string>ai.digby.imessage-agent</string>
    <key>ProgramArguments</key><array>
      <string>/Library/Digby/imessage-agent/DigbyAgent</string>
      <string>run</string>
    </array></dict></plist>`);
  const r = retireBundledHelper(home);
  assert.equal(r.present, true);
  assert.equal(r.retired, true, 'a .pkg install is retired by the self-managed agent (405927c9)');
  assert.equal(existsSync(plist), false, 'the .pkg plist is removed');
  assert.match(r.program, /\/Library\/Digby\/imessage-agent\/DigbyAgent/);
  // … and the June 2026 generation wrote a plain "node" — matched by the
  // /Library/Digby/ PATH PREFIX, never by binary name.
  writeFileSync(plist, `<?xml version="1.0"?><plist version="1.0"><dict>
    <key>Label</key><string>ai.digby.imessage-agent</string>
    <key>ProgramArguments</key><array>
      <string>/Library/Digby/imessage-agent/node</string>
      <string>run</string>
    </array></dict></plist>`);
  const rJune = retireBundledHelper(home);
  assert.equal(rJune.retired, true, 'the June-2026 .pkg shape (…/node) is retired too');
  assert.equal(existsSync(plist), false);
  rmSync(home, { recursive: true, force: true });
});

test('933e6ca4: the agent itself retires the bundled helper at startup (fleet delivery)', () => {
  // The already-installed fleet (mbp-1 et al.) must get the fix without the
  // owner re-running the installer — the self-update path delivers agent
  // 0.9.1 and every startup thereafter keeps the plist gone.
  const src = read('src/index.ts');
  assert.match(src, /retireBundledHelper\(\)/);
  assert.match(src, /never fatal/);
  assert.match(src, /from '\.\/retire-bundled-helper'/);
});

test('933e6ca4 reviewer B1: the bundled helper NEVER retires its own job (identity guard)', () => {
  // build-app.sh builds the .app-bundled agent from THIS tree, so a future
  // app bundle runs agent 0.9.1+ — without this guard its own runLoop would
  // boot out and rm ITS OWN launchd job seconds after pairing.
  const src = read('src/retire-bundled-helper.ts');
  assert.match(src, /runningIsBundledHelper/);
  assert.match(src, /if \(runningIsBundledHelper\(\)\)/);
  assert.match(src, /self: true/);
  // The pure predicate: a bundled execPath self-identifies, self-managed and
  // .pkg paths do not.
  assert.equal(runningIsBundledHelper('/Applications/Digby.app/Contents/Resources/imessage-agent/DigbyHelper'), true);
  assert.equal(runningIsBundledHelper('/Library/Digby/imessage-agent/DigbyAgent'), false);
  assert.equal(runningIsBundledHelper('/Users/example/Library/Application Support/Digby/bin/DigbyAgent'), false);
  // And the startup wiring logs the self case instead of retiring (the source
  // escapes the apostrophe: app\'s).
  const idx = read('src/index.ts');
  assert.match(idx, /r\.self/);
  assert.match(idx, /running as a bundled\/\.pkg install/);
});

// ── 2. THE DISCONNECT ─────────────────────────────────────────────────────────

test('933e6ca4: install.sh bounce is conditional (FDA gate) and gap-free (kickstart)', () => {
  // The old line bounced the service unconditionally on EVERY installer run.
  // The fix: only when a permission was still missing at probe time (the user
  // may grant it during the 45s window), and via kickstart -k (single-step
  // replace; no unload/load window) with unload/load only as a fallback.
  assert.match(installSh, /if \[\[ "\$FDA_OK" != "1" \]\]/);
  assert.match(installSh, /launchctl kickstart -k "gui\/\$\(id -u\)\/\$LABEL"/);
  assert.match(installSh, /unconditionally/);
  // The unconditional single-line bounce must be gone.
  const oldLine = /\( sleep 45; launchctl unload "\$PLIST_DEST" 2>\/dev\/null; launchctl load "\$PLIST_DEST" 2>\/dev\/null \)/;
  assert.doesNotMatch(installSh, oldLine);
});

// ── 3. THE TCC LIE — the solid-placeholder detector ───────────────────────────

test('933e6ca4: isUniformFrame detects the solid-black placeholder frame', () => {
  const black = Buffer.alloc(3 * 64, 5);               // solid near-black
  assert.equal(isUniformFrame(black, 3), true);
  const transparent = Buffer.alloc(4 * 64, 0);          // fully transparent
  assert.equal(isUniformFrame(transparent, 4), true);
});

test('933e6ca4: isUniformFrame NEVER convicts a real frame', () => {
  // A real desktop has non-uniform pixels…
  const real = Buffer.alloc(3 * 64, 5);
  real[99] = 200; real[100] = 240; real[101] = 255;
  assert.equal(isUniformFrame(real, 3), false);
  // …and a solid NON-black colour (a real blank screen) is NOT a denial —
  // the detector only fires on black/transparent, never an arbitrary colour.
  const solidBlue = Buffer.alloc(3 * 64);
  for (let i = 0; i < solidBlue.length; i += 3) { solidBlue[i] = 60; solidBlue[i + 1] = 90; solidBlue[i + 2] = 220; }
  assert.equal(isUniformFrame(solidBlue, 3), false);
  // Tiny/garbage input is a no-verdict, never a conviction.
  assert.equal(isUniformFrame(Buffer.alloc(6), 3), null);
  assert.equal(isUniformFrame(Buffer.alloc(64), 2), null);
  assert.equal(isUniformFrame(null), null);
  assert.equal(isUniformFrame(Buffer.alloc(3 * 64, 5), 5), null);
});

test('933e6ca4: pngSolidPlaceholder decodes a real solid-black PNG (the mishap shape)', () => {
  const png = makePng({ w: 16, h: 16, bpp: 3, fill: [12, 12, 12] });
  // The decoder itself is exercised (header parse + inflate + unfilter).
  assert.equal(pngDimensions(png)?.width, 16);
  assert.equal(pngSolidPlaceholder(png), true);
});

test('933e6ca4: pngSolidPlaceholder decodes with PNG filters 0–4 (screencapture uses them)', () => {
  // Real screencapture PNGs are filtered; a solid frame filtered with any
  // of the five standard filter types must still decode to "uniform black".
  // Build the DECODED rows first (solid near-black), then ENCODE each row
  // with the filter (reverse of the decoder's reconstruction) — a constant
  // raw byte is NOT a constant decoded pixel under filters 1–4.
  const W = 4, H = 4, bpp = 3, VAL = 12;
  const rowBytes = W * bpp;
  const decoded = Buffer.alloc(rowBytes * H, VAL);
  const encoded = Buffer.alloc((rowBytes + 1) * H);
  for (let f = 0; f <= 4; f++) {
    for (let y = 0; y < H; y++) {
      encoded[y * (rowBytes + 1)] = f;
      for (let x = 0; x < rowBytes; x++) {
        const cur = decoded[y * rowBytes + x];
        const left = x >= bpp ? decoded[y * rowBytes + x - bpp] : 0;
        const up = y > 0 ? decoded[(y - 1) * rowBytes + x] : 0;
        const upLeft = y > 0 && x >= bpp ? decoded[(y - 1) * rowBytes + x - bpp] : 0;
        let rawByte;
        switch (f) {
          case 0: rawByte = cur; break;
          case 1: rawByte = (cur - left) & 0xff; break;
          case 2: rawByte = (cur - up) & 0xff; break;
          case 3: rawByte = (cur - ((left + up) >> 1)) & 0xff; break;
          case 4: {
            const p = left + up - upLeft;
            const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
            const pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
            rawByte = (cur - pred) & 0xff;
            break;
          }
        }
        encoded[y * (rowBytes + 1) + 1 + x] = rawByte;
      }
    }
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr(W, H, 8, 2, 0)),
      chunk('IDAT', deflateSync(encoded)),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    assert.equal(pngSolidPlaceholder(png), true, `filter ${f} must decode as solid`);
  }
});

test('933e6ca4 reviewer MEASURED: a 1920×1080 black frame with ONE bright pixel is NOT a conviction', () => {
  // The reviewer's cross-family round measured exactly this shape convicted
  // by the old ≤8192-sample cap (~1 pixel checked per 253): a black wallpaper
  // + cursor IS a real desktop. The exhaustive verdict must read every byte.
  const W = 1920, H = 1080, bpp = 3, VAL = 8;
  const rowBytes = W * bpp;
  const decoded = Buffer.alloc(rowBytes * H, VAL);
  // ONE bright pixel (a cursor) in the middle of the frame.
  const midY = Math.floor(H / 2), midX = Math.floor(rowBytes / 2);
  decoded[midY * rowBytes + midX] = 240;
  decoded[midY * rowBytes + midX + 1] = 240;
  decoded[midY * rowBytes + midX + 2] = 240;
  // Filter 0 rows (screencapture's shape for flat regions).
  const enc = Buffer.alloc((rowBytes + 1) * H);
  for (let y = 0; y < H; y++) {
    enc[y * (rowBytes + 1)] = 0;
    decoded.copy(enc, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr(W, H, 8, 2, 0)),
    chunk('IDAT', deflateSync(enc)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  assert.equal(pngSolidPlaceholder(png), false, 'one bright pixel in a black frame = a real frame');
});

test('933e6ca4 reviewer MAJOR: corroboration is required before a conviction (never one frame)', () => {
  // A sleeping display / black wallpaper produces legitimately black frames
  // with TCC granted: a single solid capture must NOT convict.
  assert.equal(convictAfterCorroboration(true, null), false);   // no second frame
  assert.equal(convictAfterCorroboration(true, false), false);  // second frame has content
  assert.equal(convictAfterCorroboration(null, true), false);   // first undecodable
  assert.equal(convictAfterCorroboration(true, true), true);    // both solid ⇒ convicted
  // The live paths corroborate (probe + capture), via caffeinate + a second
  // capture — pinned on the wiring.
  const src = read('src/computer.ts');
  assert.match(src, /async function corroboratingCapture/);
  assert.match(src, /caffeinate', \['-u', '-t', '2'\]/);
  assert.match(src, /convictAfterCorroboration\(first, second\)/);
  assert.match(src, /convictAfterCorroboration\(solidCapture, second\)/);
});

test('933e6ca4: pngSolidPlaceholder exonerates a real frame and refuses to guess', () => {
  // A real (non-uniform) PNG.
  const rowBytes = 4 * 3;
  const raw = Buffer.alloc((rowBytes + 1) * 4);
  for (let y = 0; y < 4; y++) {
    raw[y * (rowBytes + 1)] = 0;
    for (let x = 0; x < rowBytes; x++) raw[y * (rowBytes + 1) + 1 + x] = (x + y * 7) & 0xff;
  }
  const real = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr(4, 4, 8, 2, 0)),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  assert.equal(pngSolidPlaceholder(real), false);
  // Solid non-black (a real blank-coloured screen): NOT a denial.
  assert.equal(pngSolidPlaceholder(makePng({ fill: [250, 250, 250] })), false);
  // Things the decoder cannot judge: null, never true.
  assert.equal(pngSolidPlaceholder(Buffer.alloc(10)), null);
  assert.equal(pngSolidPlaceholder(Buffer.from('garbage')), null);
  // 16-bit / palette PNGs: bail (null), never guess.
  const palettePng = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr(4, 4, 8, 3, 0)),
    chunk('IDAT', deflateSync(Buffer.alloc((4 + 1) * 4))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  assert.equal(pngSolidPlaceholder(palettePng), null);
  // Interlaced: bail.
  const interlaced = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr(4, 4, 8, 2, 1)),
    chunk('IDAT', deflateSync(Buffer.alloc((4 * 3 + 1) * 4))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  assert.equal(pngSolidPlaceholder(interlaced), null);
  // Truncated IDAT (declared h taller than the data): no verdict.
  const trunc = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr(4, 100, 8, 2, 0)),
    chunk('IDAT', deflateSync(Buffer.alloc((4 * 3 + 1) * 4))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  assert.equal(pngSolidPlaceholder(trunc), null);
});

test('933e6ca4: the probe and the live capture both gate on the detector (wiring pins)', () => {
  const src = read('src/computer.ts');
  // probeScreenRecording: exit-0 + solid black (corroborated) ⇒ NOT granted
  // (the card must stop advertising ✓ while blind).
  assert.match(src, /try \{ first = pngSolidPlaceholder\(readFileSync\(tmp\)\); \} catch \{ first = null; \}/);
  assert.match(src, /if \(convictAfterCorroboration\(first, second\)\) \{\s*\n\s*noteCaptureResult\(false\);\s*\n\s*return false;/);
  // The live screenshot path: corroborated solid black ⇒ the honest permission
  // block, carrying the replaced-binary explanation (not a black "observation").
  assert.match(src, /try \{ solidCapture = pngSolidPlaceholder\(readFileSync\(png\)\); \} catch \{ solidCapture = null; \}/);
  assert.match(src, /if \(convictAfterCorroboration\(solidCapture, second\)\) \{\s*\n\s*noteCaptureResult\(false\);\s*\n\s*return permissionBlock\(\['screen'\], \{ solidCapture: true \}\);/);
});

test('933e6ca4: the permission hint names the REAL binary and explains grant orphaning', () => {
  const src = read('src/computer.ts');
  // (d) name the actual binary, never a hardcoded "DigbyHelper".
  assert.match(src, /const binaryName = basename\(process\.execPath\)/);
  assert.doesNotMatch(src, /add "DigbyHelper" under System Settings/);
  // (c) the solid-black case explains the stale pane entry + the fix.
  assert.match(src, /grant for a PREVIOUS/);
  assert.match(src, /remove the stale entry, re-add/);
});

// ── 4. THE NAMING — the served bootstrap + the card ──────────────────────────

test('933e6ca4: the served bootstrap installer warns about TCC + binary replacement', () => {
  // The one-liner the card shows pipes THIS file from digby.ai. It must warn
  // BEFORE replacing the binary (fix c) and name the components (fix d).
  // Line-break-tolerant: the sentences span the installer's echo line breaks.
  assert.match(bootstrap, /updates the BACKGROUND AGENT only/);
  assert.match(bootstrap, /grants may be invalidated/);
  assert.match(bootstrap, /invalidated[\s\S]*?Privacy &[\s\S]*?Security/);
  assert.match(bootstrap, /quit and relaunch Digby/);
});

test('933e6ca4: the frontend hint distinguishes app vs agent (wiring pins)', () => {
  const card = read('../frontend/app/crossmodel/account/IMessageCard.tsx');
  assert.match(card, /Mac agent update available/);
  // Whitespace-tolerant: the source wraps the sentence across lines.
  assert.match(card, /not the Digby desktop\s*\n\s*app/);
  assert.match(card, /tied to the old helper binary/);
  // (b) the live reconnect poll exists (paused when hidden).
  assert.match(card, /intervalMs: 15_000/);
  assert.match(card, /pauseWhenHidden: true/);
});

// ── version stamp ────────────────────────────────────────────────────────────

test('933e6ca4 → 405927c9: the fix is stamped — tree current (single-agent-convergence line 0.9.x)', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.version, '0.9.24');
  assert.match(read('src/config.ts'), /AGENT_VERSION = '0\.9\.24'/);
  assert.match(read('src/config.ts'), /933e6ca4/);
  assert.match(read('src/config.ts'), /405927c9/);
});
