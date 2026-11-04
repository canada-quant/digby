'use client';

import { useState, useEffect, useCallback } from 'react';

export type ChatTextSize = 'small' | 'medium' | 'large';
export type SidebarDefault = 'open' | 'closed';
// P4 (unification plan, design Q (d)): 3 patience levels + the Auto detent.
// 'auto' is a per-message routing preference — never a chat's stored mode.
// 'deep_research_all' (old L4) and 'code' (old notch 5) remain in the type ONLY
// so legacy stored prefs parse; normalizePatienceMode migrates them on read.
export type PatienceMode = 'single' | 'single_thinking' | 'fast' | 'thinking' | 'deep_research' | 'deep_research_all' | 'code' | 'auto';

export interface Preferences {
  chatTextSize: ChatTextSize;
  sidebarDefault: SidebarDefault;
  patienceMode: PatienceMode;
}

const DEFAULTS: Preferences = {
  chatTextSize: 'medium',
  sidebarDefault: 'open',
  // P4: Auto is the default ONLY when the user has no stored level preference
  // (new users). A stored preference — even a legacy one — always wins.
  patienceMode: 'auto',
};

const STORAGE_KEY = 'cm_prefs';

// 2026-06-21: The fast single-model tier was retired. Patience L1 is now
// `single_thinking`, so any persisted legacy value (`single` or `fast`) is
// migrated forward on read — otherwise a returning user would be stuck on a
// mode the slider can no longer represent.
// P4: the slider collapsed to 3 notches + the Auto detent. Migrate the retired
// stops on read: old L4 `deep_research_all` → `deep_research` (L3); old notch 5
// `code` → `thinking` (L2) — coding is now the Code chip on the composer, not a
// patience level (the page shows a one-time toast about the move).
// The levels the slider/Auto can actually route to after normalization.
// normalizePatienceMode returns this narrower type so send paths can pass its
// result straight to APIs that don't accept legacy stops (e.g. createChat
// rejects 'code' — coding is the composer chip now, not a patience mode).
export type ActivePatienceMode = 'single_thinking' | 'thinking' | 'deep_research' | 'auto';

export function normalizePatienceMode(mode: unknown): ActivePatienceMode {
  if (mode === 'single' || mode === 'fast') return 'single_thinking';
  if (mode === 'deep_research_all') return 'deep_research';
  if (mode === 'code') return 'thinking';
  if (mode === 'single_thinking' || mode === 'thinking' || mode === 'deep_research' || mode === 'auto') {
    return mode;
  }
  // Unknown/missing value → Auto (the new-user default), NOT L1: Auto routes
  // each message to a concrete level server-side.
  return 'auto';
}

export function loadPrefs(): Preferences {
  if (typeof window === 'undefined') return DEFAULTS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const merged = { ...DEFAULTS, ...JSON.parse(raw) };
    return { ...merged, patienceMode: normalizePatienceMode(merged.patienceMode) };
  } catch {
    return DEFAULTS;
  }
}

function savePrefs(prefs: Preferences) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

export function usePreferences() {
  const [prefs, setPrefs] = useState<Preferences>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setPrefs(loadPrefs());
    setLoaded(true);
  }, []);

  const update = useCallback((partial: Partial<Preferences>) => {
    setPrefs(prev => {
      const next = { ...prev, ...partial };
      savePrefs(next);
      return next;
    });
  }, []);

  return { prefs, update, loaded };
}

// Maps chatTextSize to Tailwind classes for every text element in the chat UI
export interface TextSizeClasses {
  p: string;
  li: string;
  chatTitle: string;
  userMsg: string;
  h1: string;
  h2: string;
  h3: string;
  h4: string;
  th: string;
  td: string;
}

// Maps chatTextSize to Tailwind classes for every text element in the chat UI.
// Heading scale deliberately sits ONE notch below classic document hierarchy
// (feedback da7dc5ea: "big bold ugly formatting") — in-chat headings organize
// an answer, they don't shout over it.
export const TEXT_SIZE_MAP: Record<ChatTextSize, TextSizeClasses> = {
  // Owner 2026-10-06: chat answers use the CODING typeface (Geist sans, the
  // same family + heading hierarchy as coding transcripts) — the Frontier
  // design's Newsreader answer serif is gone. Small is the coding transcript's
  // exact measure (text-sm / leading-6); medium + large scale it up.
  small: {
    p: 'text-sm leading-6',
    li: 'text-sm leading-6',
    chatTitle: 'text-[12.5px]',
    userMsg: 'text-[14px] leading-[1.5]',
    h1: 'text-base mt-5 mb-2',
    h2: 'text-[15px] mt-5 mb-2',
    h3: 'text-sm mt-5 mb-2',
    h4: 'text-sm mt-5 mb-2',
    th: 'text-xs leading-5 font-semibold break-words',
    td: 'text-xs leading-5 break-words',
  },
  medium: {
    p: 'text-[15.5px] leading-[1.65]',
    li: 'text-[15.5px] leading-[1.65]',
    chatTitle: 'text-[13.5px]',
    userMsg: 'text-[15px] leading-[1.55]',
    h1: 'text-lg mt-[22px] mb-2',
    h2: 'text-base mt-[22px] mb-2',
    h3: 'text-[15px] mt-[22px] mb-2',
    h4: 'text-sm mt-[22px] mb-2',
    th: 'text-sm leading-6 font-semibold break-words',
    td: 'text-sm leading-6 break-words',
  },
  large: {
    p: 'text-[17px] leading-[1.7]',
    li: 'text-[17px] leading-[1.7]',
    chatTitle: 'text-[14.5px]',
    userMsg: 'text-[16.5px] leading-[1.55]',
    h1: 'text-xl mt-6 mb-2',
    h2: 'text-lg mt-6 mb-2',
    h3: 'text-[17px] mt-6 mb-2',
    h4: 'text-base mt-6 mb-2',
    th: 'text-base leading-7 font-semibold break-words',
    td: 'text-base leading-7 break-words',
  },
};
