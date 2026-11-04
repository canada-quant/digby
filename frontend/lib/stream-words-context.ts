/**
 * StreamingWordsContext — true beneath the LIVE (streaming) answer only, so
 * MarkdownContent wraps its words for the Digby Frontier fade-in
 * (lib/rehype-stream-words.ts). Settled messages never see it.
 * (RSW-1 2026-10-30: the NEXT_PUBLIC_STREAM_WORD_FADE_DISABLED kill switch was
 * deleted — NF_INERT, never forwarded as a build arg, so prod only ever ran
 * the fade-on branch.)
 */
import { createContext } from 'react';

export const StreamingWordsContext = createContext<boolean>(false);

export function streamWordFadeEnabled(): boolean {
  return true;
}
