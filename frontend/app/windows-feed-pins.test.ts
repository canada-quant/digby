/**
 * W3 (2026-09-25) — Windows client update feed pins.
 *
 * The Windows shell (windows-shell/UpdateCheck.cs) polls
 * https://digby.example.com/windows-latest.json — the Windows mirror of the macOS
 * desktop-latest.json feed (same shape: {version, url, notes}) — compares
 * dotted-numeric versions, and on a newer version offers to download the
 * installer at `url`. This suite pins the FEED CONTRACT at the source level
 * (the C# toolchain only exists on Windows runners, so CI pins the files):
 *
 *   • the feed file exists at frontend/public/windows-latest.json and parses
 *   • version/url/notes are all present, url is the Digby-Setup.exe artifact
 *   • the notes name the W3 release content (UIA accessibility tree + agent
 *     bundling) so users know what they are downloading
 *   • the service worker bypasses BOTH the feed and the .exe (a SW-cached
 *     feed would show stale updates; a SW-proxied .exe stream can corrupt the
 *     download — the exact corruption class documented at the desktop-latest
 *     bypass entry in sw.js)
 *   • the .exe glob bypass already covers /Digby-Setup.exe by extension, so
 *     the explicit-entry requirement is only the feed path
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const FEED = JSON.parse(readFileSync(
  fileURLToPath(new URL('../public/windows-latest.json', import.meta.url)),
  'utf8',
)) as { version: string; url: string; notes: string };

const SW = readFileSync(
  fileURLToPath(new URL('../public/sw.js', import.meta.url)),
  'utf8',
);

// Installer-professionalism pass (405927c9 interim directive, 2026-10-25): the
// three Windows version locations must move together — the silent 1.0.0/1.0.1
// drift (learnings 4424ebd6) shipped an installer advertising one version while
// the feed sold another. digby.nsi:85 carries the "keep in sync" comment; this
// guard automates it. (The C# toolchain exists only on Windows runners, so CI
// pins the files at source level.)
const CSPROJ = readFileSync(
  fileURLToPath(new URL('../../windows-shell/Digby.Shell.csproj', import.meta.url)),
  'utf8',
);
const NSI = readFileSync(
  fileURLToPath(new URL('../../windows-shell/installer/digby.nsi', import.meta.url)),
  'utf8',
);
const csprojVersion = (CSPROJ.match(/<Version>(\d+\.\d+\.\d+)<\/Version>/) ?? [])[1];
const nsiVersion = (NSI.match(/!define\s+APPVERSION\s+"([^"]+)"/) ?? [])[1];

describe('W3 — windows-latest.json update feed', () => {
  it('has version, url, and notes (the shape windows-shell UpdateCheck.cs reads)', () => {
    expect(typeof FEED.version).toBe('string');
    expect(FEED.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof FEED.url).toBe('string');
    expect(typeof FEED.notes).toBe('string');
    expect(FEED.notes.length).toBeGreaterThan(0);
  });

  it('points at the Windows installer artifact', () => {
    expect(FEED.url).toBe('https://digby.example.com/Digby-Setup.exe');
  });

  it('the notes name the current release content so users know what they are downloading', () => {
    // The feed's notes follow the release: 1.0.0 named the W3 content (UIA
    // accessibility tree + agent bundling); 1.0.1 named the startup-hang fix
    // (visible startup state, shell.log diagnostics, bounded requests); 1.0.2
    // names the computer-use fix (agent 0.9.1 locates digby-win-helper.exe at
    // the agent bundle root — ticket 4424ebd6). Pin the CURRENT release's
    // content — a notes/release drift fails here.
    expect(FEED.version).toBe('1.0.2');
    expect(FEED.notes).toMatch(/computer use/i);
    expect(FEED.notes).toMatch(/digby-win-helper\.exe/);
  });

  it('the service worker bypasses /windows-latest.json (never SW-cached)', () => {
    expect(SW).toContain("url.pathname === '/windows-latest.json'");
  });

  it('the service worker bypasses the .exe download (extension glob)', () => {
    // The existing extension regex covers /Digby-Setup.exe — pin that it stays:
    // the bypass must be an extension REGEX over the pathname that includes exe.
    expect(SW).toContain('exe|msi');
    expect(SW).toMatch(/\\\.\(pkg\|dmg\|zip\|tar\\\.gz\|tgz\|exe\|msi\)\$/);
  });

  it('the version is at or above the first Windows shell release (1.0.0)', () => {
    const [maj, min, patch] = FEED.version.split('.').map(Number);
    expect(maj).toBeGreaterThanOrEqual(1);
    expect(min).toBeGreaterThanOrEqual(0);
    expect(patch).toBeGreaterThanOrEqual(0);
  });

  it('version sync: feed == csproj <Version> == NSIS APPVERSION (4424ebd6 drift guard)', () => {
    expect(csprojVersion, 'csproj <Version> unreadable').toMatch(/^\d+\.\d+\.\d+$/);
    expect(nsiVersion, 'NSIS APPVERSION unreadable').toMatch(/^\d+\.\d+\.\d+$/);
    expect(csprojVersion).toBe(FEED.version);
    expect(nsiVersion).toBe(FEED.version);
  });
});
