import type { ShotKey } from './content';

/**
 * Product screenshots for the public site (2026-10-16 site review: "show the
 * product"). Captured from the live app on the prod test account at 1280×820
 * @2x (desktop) and 390×600 @3x (phone), in light and dark, then encoded to
 * WebP — files at /site/shots/<key>-<light|dark>-<desktop|mobile>.webp.
 * Re-capture when the app's look changes; keep internal settings, model names
 * and harness notices out of frame (claims discipline in content.ts).
 */
export interface Shot { alt: string; caption: string }

export const SHOTS: Record<ShotKey, Shot> = {
  answer: {
    alt: 'Digby answering a question about what PIPEDA requires of a Canadian business using an AI chatbot, with its web research shown',
    caption: 'A real Digby answer: it searched the web, read official guidance and showed its work.',
  },
  sources: {
    alt: 'The end of a Digby answer: a list of cited sources, the “How Digby answered” panel and the “Dig deeper” button',
    caption: 'Every answer lists its sources. “Dig deeper” starts an independent check or a full research pass.',
  },
  memory: {
    alt: 'Digby’s memory settings listing saved facts, each with edit and delete buttons',
    caption: 'Settings → Memory: every fact Digby has saved, each one editable and deletable.',
  },
  integrations: {
    alt: 'Digby’s integrations settings with options to connect a Mac, Google Workspace and GitHub',
    caption: 'Settings → Integrations: connect your Mac, Google Workspace, GitHub, Slack and more.',
  },
  coding: {
    alt: 'A Digby Code task: the request, a six-step plan and the finished file handed back to the chat',
    caption: 'Digby Code: a plan that updates as it works, and the finished file handed back to the chat.',
  },
};

export const SHOT_SIZE = { desktop: { width: 2560, height: 1640 }, mobile: { width: 1170, height: 1800 } } as const;

export const shotSrc = (key: ShotKey, scheme: 'light' | 'dark', form: 'desktop' | 'mobile') => `/site/shots/${key}-${scheme}-${form}.webp`;
