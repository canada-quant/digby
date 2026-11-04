/**
 * The leading-<think> stream router, a pure leaf (moved out of coding-model.ts 2026-10-04 so the Digby Kids stream —
 * integrations/qwen-kid.integration.ts — can keep a child from ever seeing a model's reasoning live; coding-model.ts
 * re-exports it unchanged).
 */

/**
 * GLM-5.2 streamed its chain-of-thought as a leading <think>…</think> block INSIDE
 * delta.content (not reasoning_content — per the project gotcha); GLM-5.3's stream
 * shape is UNCONFIRMED, so the parser accepts BOTH shapes for glm models: this
 * router handles a leading <think> in content, while the runModelTurn loop below
 * independently routes any delta.reasoning_content to reasoning. The router
 * splits streamed content into ANSWER text and THINK reasoning incrementally,
 * tolerating tags split across chunks, so the think block is never shown/persisted
 * as the answer nor counted by the degeneration guard. For non-GLM models it's a
 * pass-through (everything is answer; they use reasoning_content properly).
 * Exported + pure (callback-driven) so it can be unit-tested.
 */
export function createThinkRouter(
  model: string,
  cb: { onAnswer: (s: string) => void; onThink: (s: string) => void },
) {
  const OPEN_TAG = '<think>';
  const CLOSE_TAG = '</think>';
  // UNIVERSAL since 2026-09-08 (owner: custom Qwen helper leaked its chain-of-
  // thought as a worker report): any model may stream a leading <think> block
  // inside content when the serving stack has no reasoning parser — custom
  // endpoints most of all. 'open' is a no-op for models that never emit the
  // tag (the first non-whitespace char that isn't '<think>' flips to 'closed'),
  // so built-ins that use reasoning_content are byte-identical. `model` stays
  // in the signature for callers/tests; it no longer gates the router.
  void model;
  let mode: 'open' | 'inside' | 'closed' = 'open';
  let carry = '';
  return {
    feed(chunk: string) {
      if (!chunk) return;
      if (mode === 'closed') { cb.onAnswer(chunk); return; }
      carry += chunk;
      while (true) {
        if (mode === 'open') {
          const lead = carry.replace(/^\s+/, '');
          if (!lead) return;                      // only whitespace so far — wait
          if (OPEN_TAG.startsWith(lead)) return;  // partial "<thi…" — wait for more
          if (lead.startsWith(OPEN_TAG)) {
            carry = carry.slice(carry.indexOf(OPEN_TAG) + OPEN_TAG.length);
            mode = 'inside';
            continue;
          }
          mode = 'closed'; cb.onAnswer(carry); carry = ''; return; // no think block → all answer
        }
        const idx = carry.indexOf(CLOSE_TAG);
        if (idx >= 0) {
          if (idx) cb.onThink(carry.slice(0, idx));
          carry = carry.slice(idx + CLOSE_TAG.length);
          mode = 'closed';
          if (carry) { cb.onAnswer(carry); carry = ''; }
          return;
        }
        const hold = CLOSE_TAG.length - 1; // keep a tail that might be a partial "</think"
        if (carry.length > hold) { cb.onThink(carry.slice(0, carry.length - hold)); carry = carry.slice(carry.length - hold); }
        return;
      }
    },
    flush() {
      if (!carry) return;
      if (mode === 'inside') cb.onThink(carry); else cb.onAnswer(carry);
      carry = '';
    },
  };
}
