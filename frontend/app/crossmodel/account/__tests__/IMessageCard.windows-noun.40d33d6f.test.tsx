/**
 * Ticket 40d33d6f — "Paired Windows PC (cql-stanne-msi-win) displays as a Mac in
 * the device list" (owner report 2026-10-23 ~23:00Z: "it says my PC is a mac").
 *
 * What happened: the agents list (Account → Integrations → iMessage, the
 * per-device rows) rendered several strings with a hardcoded "Mac" noun even
 * for a device whose row says platform:'windows' — the iMessage tile said
 * "offline" for a Windows PC that can never have iMessage (it read as a broken
 * Mac instead of a Windows PC without iMessage), the tile tooltip said "start
 * the Digby agent on this Mac", the Browser tile said "available on this Mac",
 * the default-device hint said "Reading from this Mac"/"Use this Mac for
 * conversations", and the rename tooltip said "Rename this Mac".
 *
 * The fix: each device row derives its OS noun from ITS OWN platform
 * ('windows' → "PC", else "Mac") and the iMessage tile states "not on Windows"
 * rather than showing a fake-offline iMessage bridge.
 *
 * Node-environment vitest constraints (no jsdom, no effects — the
 * IMessageCard.pairing-code.4b413b07.test.tsx idiom): SOURCE-LEVEL pins on
 * IMessageCard.tsx for the effectful per-device row rendering.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const CARD = readFileSync(fileURLToPath(new URL('../IMessageCard.tsx', import.meta.url)), 'utf8');

/** The per-device row block (agents.map((a) => ...) through the row's closing). */
const ROW = (() => {
  const start = CARD.indexOf('{agents.map((a) => {');
  const end = CARD.indexOf(')})}', start);
  return CARD.slice(start, end);
})();

describe('IMessageCard per-device rows — the OS noun follows the device platform (40d33d6f)', () => {
  it('derives the OS noun from the device row itself', () => {
    expect(ROW).toContain("const isWin = a.platform === 'windows';");
    expect(ROW).toContain("const osNoun = isWin ? 'PC' : 'Mac';");
  });

  it('the iMessage tile never shows a Windows PC as an OFFLINE MAC — it says "not on Windows"', () => {
    // The dot must go grey for a Windows device (iMessage cannot exist there).
    expect(ROW).toContain('cnDot(a.online && !isWin)');
    // The label states the platform fact, not a fake offline status.
    expect(ROW).toContain("isWin ? 'not on Windows' : a.online ? 'online' : 'offline'");
    // The tooltip no longer tells the user to "start the Digby agent on this Mac".
    expect(ROW).toContain("'Not available on Windows'");
  });

  it('the Browser tile, device hint and rename tooltip use the per-device noun', () => {
    expect(ROW).toContain('available on this ${osNoun}');
    expect(ROW).toContain('`Reading from this ${osNoun}`');
    expect(ROW).toContain('`Use this ${osNoun} for conversations`');
    expect(ROW).toContain('`Rename this ${osNoun}`');
  });

  it('the fallback name keeps its platform split (a label-less row never becomes "Mac")', () => {
    expect(ROW).toContain("a.name || a.label || a.deviceName || (isWin ? 'PC' : 'Mac')");
  });
});
