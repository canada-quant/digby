'use client';

/**
 * useResizable — THE pointer-drag width controller for the app's two resizable
 * rails (owner UI pass 2026-09-07): the left sidebar and the right workspace
 * panel. One hook + one handle component (ResizeHandle) so the surfaces can't
 * drift on behavior:
 *
 *   - drag clamps to [minWidth, maxWidth]; the final width persists to
 *     localStorage under the surface's key ('digby.sidebar.w' / 'digby.panel.w');
 *   - double-click (or Enter on the focused handle) resets to the default and
 *     clears the stored value;
 *   - arrow keys nudge the width (keyboard accessibility);
 *   - SSR-safe: the server renders defaultWidth; the stored width is read in a
 *     mount effect (getLocalStorage() returns null without a window), clamped
 *     before use so a stale/hand-edited value can't blow up the layout.
 *
 * The pure pieces (clampWidth / resolveStoredWidth / dragWidth /
 * getLocalStorage) are exported for the node-environment vitest — the hook
 * itself is a thin React shell over them.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface ResizableConfig {
  /** Per-surface localStorage key ('digby.sidebar.w' / 'digby.panel.w'). */
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  /** Which edge of the SURFACE carries the handle: 'right' = left sidebar
   *  (dragging right widens); 'left' = right panel (dragging left widens). */
  edge: 'left' | 'right';
  /** Older keys read (then superseded) so pre-2026-09-07 widths keep working. */
  legacyKeys?: string[];
}

/** Keyboard nudge step for the handle's arrow keys (px). */
export const RESIZE_KEY_STEP = 16;

/** Clamp a width to the surface's range. Non-finite input → the min bound. */
export function clampWidth(w: number, min: number, max: number): number {
  if (!Number.isFinite(w)) return min;
  return Math.max(min, Math.min(max, w));
}

/**
 * Resolve a raw stored string into a usable width: null/absent/garbage → the
 * default; a number → clamped (stored values are UNTRUSTED — an old key from a
 * wider clamp range, or a hand-edited value, must not escape the bounds).
 */
export function resolveStoredWidth(
  raw: string | null | undefined,
  cfg: { defaultWidth: number; minWidth: number; maxWidth: number },
): number {
  if (raw == null || raw.trim() === '') return cfg.defaultWidth;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return cfg.defaultWidth;
  return clampWidth(n, cfg.minWidth, cfg.maxWidth);
}

/**
 * The drag math, pure: width for a pointer at clientX given the drag's start
 * state. edge 'right' (handle on the surface's right edge — the left sidebar):
 * pointer moving right widens. edge 'left' (handle on the surface's left edge —
 * the right panel): pointer moving left widens.
 */
export function dragWidth(
  startWidth: number,
  startX: number,
  clientX: number,
  edge: 'left' | 'right',
  min: number,
  max: number,
): number {
  const delta = clientX - startX;
  return clampWidth(startWidth + (edge === 'right' ? delta : -delta), min, max);
}

/** SSR guard: localStorage or null (no window / storage access denied). */
export function getLocalStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null; // privacy mode / storage disabled
  }
}

/** Read the persisted width for a config (first key that holds a value wins). */
export function readStoredWidth(
  storage: Pick<Storage, 'getItem'> | null,
  cfg: ResizableConfig,
): number {
  if (!storage) return cfg.defaultWidth;
  let raw: string | null = null;
  try {
    raw = storage.getItem(cfg.storageKey);
    if (raw == null) {
      for (const k of cfg.legacyKeys ?? []) {
        raw = storage.getItem(k);
        if (raw != null) break;
      }
    }
  } catch {
    raw = null;
  }
  return resolveStoredWidth(raw, cfg);
}

/** Reset persistence: clear the surface's key AND its legacy keys, so the
 *  default wins on the next mount too (pure — exported for tests). */
export function clearStoredWidth(
  storage: Pick<Storage, 'removeItem'> | null,
  cfg: Pick<ResizableConfig, 'storageKey' | 'legacyKeys'>,
): void {
  if (!storage) return;
  try {
    storage.removeItem(cfg.storageKey);
    for (const k of cfg.legacyKeys ?? []) storage.removeItem(k);
  } catch {
    /* best-effort */
  }
}

export interface Resizable {
  /** Current width in px — feed it to the surface's style/CSS var. */
  width: number;
  /** PointerDown handler for the grab strip. */
  startResize: (e: React.PointerEvent) => void;
  /** Reset to defaultWidth and clear the stored value (double-click/Enter). */
  reset: () => void;
  /** Keyboard nudge in POINTER space (px moved right); the hook applies the
   *  edge direction, clamps, and persists. */
  nudge: (deltaX: number) => void;
  /** True while a pointer drag is in progress — surfaces that animate their
   *  width (the Frontier sidebar collapse) drop the transition while it is. */
  resizing?: boolean;
}

export function useResizable(cfg: ResizableConfig): Resizable {
  const { storageKey, defaultWidth, minWidth, maxWidth, edge } = cfg;
  // SSR renders the default; the stored width lands after mount (also keeps
  // server/client markup identical for hydration).
  const [width, setWidth] = useState(defaultWidth);
  const [resizing, setResizing] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  useEffect(() => {
    setWidth(readStoredWidth(getLocalStorage(), cfgRef.current));
    // Re-read only if the surface's key changes (it doesn't in practice).
  }, [storageKey]);

  const persist = useCallback((w: number) => {
    try {
      getLocalStorage()?.setItem(storageKey, String(w));
    } catch {
      /* best-effort */
    }
  }, [storageKey]);

  const startResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = widthRef.current;
    let latest = startW;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    setResizing(true);
    const onMove = (ev: PointerEvent) => {
      latest = dragWidth(startW, startX, ev.clientX, edge, minWidth, maxWidth);
      setWidth(latest);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setResizing(false);
      persist(latest);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [edge, minWidth, maxWidth, persist]);

  const reset = useCallback(() => {
    setWidth(defaultWidth);
    clearStoredWidth(getLocalStorage(), cfgRef.current);
  }, [defaultWidth]);

  const nudge = useCallback((deltaX: number) => {
    setWidth(w => {
      const next = clampWidth(w + (edge === 'right' ? deltaX : -deltaX), minWidth, maxWidth);
      persist(next);
      return next;
    });
  }, [edge, minWidth, maxWidth, persist]);

  return { width, startResize, reset, nudge, resizing };
}
