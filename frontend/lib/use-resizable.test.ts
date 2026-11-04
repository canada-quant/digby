/**
 * Unit tests for lib/use-resizable.ts — the ONE width controller behind the
 * resizable left sidebar + right workspace panel (owner UI pass 2026-09-07).
 * Node-environment vitest (no jsdom): the hook's React shell can't run here,
 * so the exported PURE pieces carry the contract — clamps, drag math per edge,
 * stored-value hygiene, persistence key handling, and the SSR guard.
 */

import { describe, expect, it } from 'vitest';
import {
  clampWidth,
  clearStoredWidth,
  dragWidth,
  getLocalStorage,
  readStoredWidth,
  resolveStoredWidth,
  type ResizableConfig,
} from './use-resizable';

const CFG = { defaultWidth: 240, minWidth: 200, maxWidth: 480 };

describe('clampWidth', () => {
  it('passes through in-range values and clamps both bounds', () => {
    expect(clampWidth(300, 200, 480)).toBe(300);
    expect(clampWidth(100, 200, 480)).toBe(200);
    expect(clampWidth(9000, 200, 480)).toBe(480);
    expect(clampWidth(200, 200, 480)).toBe(200); // inclusive bounds
    expect(clampWidth(480, 200, 480)).toBe(480);
  });

  it('non-finite input degrades to the min bound (never NaN into layout)', () => {
    expect(clampWidth(NaN, 200, 480)).toBe(200);
    expect(clampWidth(Infinity, 200, 480)).toBe(200);
    expect(clampWidth(-Infinity, 200, 480)).toBe(200);
  });
});

describe('resolveStoredWidth — stored values are untrusted', () => {
  it('absent/blank/garbage → the default', () => {
    expect(resolveStoredWidth(null, CFG)).toBe(240);
    expect(resolveStoredWidth(undefined, CFG)).toBe(240);
    expect(resolveStoredWidth('', CFG)).toBe(240);
    expect(resolveStoredWidth('  ', CFG)).toBe(240);
    expect(resolveStoredWidth('banana', CFG)).toBe(240);
    expect(resolveStoredWidth('NaN', CFG)).toBe(240);
  });

  it('zero/negative stored widths → the default (a collapsed rail is not a width)', () => {
    expect(resolveStoredWidth('0', CFG)).toBe(240);
    expect(resolveStoredWidth('-50', CFG)).toBe(240);
  });

  it('valid numbers clamp to the surface range (legacy keys had WIDER clamps)', () => {
    expect(resolveStoredWidth('300', CFG)).toBe(300);
    expect(resolveStoredWidth('760', CFG)).toBe(480); // old panel max 760 → new max
    expect(resolveStoredWidth('120', CFG)).toBe(200);
  });
});

describe('dragWidth — per-edge direction', () => {
  it("edge 'right' (left sidebar): pointer moving right widens", () => {
    expect(dragWidth(240, 100, 160, 'right', 200, 480)).toBe(300);
    expect(dragWidth(240, 100, 40, 'right', 200, 480)).toBe(200); // clamped at min
  });

  it("edge 'left' (right panel): pointer moving LEFT widens", () => {
    expect(dragWidth(320, 900, 840, 'left', 280, 720)).toBe(380);
    expect(dragWidth(320, 900, 960, 'left', 280, 720)).toBe(280); // dragging away narrows to min
  });

  it('clamps at the max in both directions', () => {
    expect(dragWidth(460, 100, 5000, 'right', 200, 480)).toBe(480);
    expect(dragWidth(700, 900, -5000, 'left', 280, 720)).toBe(720);
  });
});

describe('readStoredWidth — persistence keys + SSR guard', () => {
  const cfg: ResizableConfig = {
    storageKey: 'digby.sidebar.w', defaultWidth: 240, minWidth: 200, maxWidth: 480,
    edge: 'right', legacyKeys: ['digbyChatRailW'],
  };
  const store = (entries: Record<string, string>): Pick<Storage, 'getItem'> => ({
    getItem: (k: string) => (k in entries ? entries[k] : null),
  });

  it('SSR guard: no window here (node env) → getLocalStorage() is null and the default renders', () => {
    expect(typeof window).toBe('undefined');
    expect(getLocalStorage()).toBeNull();
    expect(readStoredWidth(getLocalStorage(), cfg)).toBe(240);
  });

  it('reads the canonical per-surface key first', () => {
    expect(readStoredWidth(store({ 'digby.sidebar.w': '333', digbyChatRailW: '444' }), cfg)).toBe(333);
  });

  it('falls back to a legacy key when the canonical key is empty (pre-migration widths survive)', () => {
    expect(readStoredWidth(store({ digbyChatRailW: '444' }), cfg)).toBe(444);
  });

  it('a stored value outside the clamp range comes back clamped', () => {
    expect(readStoredWidth(store({ 'digby.sidebar.w': '4000' }), cfg)).toBe(480);
  });

  it('nothing stored → default; a throwing storage degrades to the default too', () => {
    expect(readStoredWidth(store({}), cfg)).toBe(240);
    const throwing = { getItem: () => { throw new Error('denied'); } } as Pick<Storage, 'getItem'>;
    expect(readStoredWidth(throwing, cfg)).toBe(240);
  });

  it('reset clears the canonical AND legacy keys (double-click restores the default on the next mount too)', () => {
    const removed: string[] = [];
    clearStoredWidth({ removeItem: (k: string) => removed.push(k) }, cfg);
    expect(removed).toEqual(['digby.sidebar.w', 'digbyChatRailW']);
    // Null storage (SSR) and a throwing storage are both safe no-ops.
    expect(() => clearStoredWidth(null, cfg)).not.toThrow();
    expect(() => clearStoredWidth({ removeItem: () => { throw new Error('denied'); } }, cfg)).not.toThrow();
  });

  it("the panel's config keys/clamps: 'digby.panel.w', 280–720, legacy digby-code-panel-w", () => {
    const panelCfg: ResizableConfig = {
      storageKey: 'digby.panel.w', defaultWidth: 320, minWidth: 280, maxWidth: 720,
      edge: 'left', legacyKeys: ['digby-code-panel-w'],
    };
    expect(readStoredWidth(store({ 'digby-code-panel-w': '760' }), panelCfg)).toBe(720);
    expect(readStoredWidth(store({ 'digby.panel.w': '500' }), panelCfg)).toBe(500);
  });
});
