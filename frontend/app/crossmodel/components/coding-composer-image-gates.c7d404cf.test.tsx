/**
 * Ticket c7d404cf — the unified composer (CodeSessionView: plain chats AND
 * coding sessions share it) must NEVER refuse image attachments client-side
 * based on the session model's vision capability.
 *
 * The regression (owner report 2026-09-13, "i cant send images anymore in
 * coding sessions or chats"): BOTH the paperclip/drop path
 * (handleIncomingFiles) and the paste path carried a stale
 * `modelSupportsVision` gate that REFUSED to stage images on text-only
 * models (glm-5.3 — the default coding seat) with a toast demanding a model
 * switch. The gate ALSO fired when no session model was known at all
 * (`!sessionModel`) — which is every PLAIN chat — so images were refused
 * there too, while the Management supervisor composer (its own gate-free
 * implementation) kept working: the exact surface split the owner hit.
 *
 * The gates were stale the day they shipped: the backend has
 * describe-and-injected images for text-only session models since the
 * 2026-09-03 owner wave (coding-stream.controller startRun/steer hands the
 * model a glm-5.3-flash vision description), and plain-chat image sends
 * upgrade the orchestrator to a native-vision model
 * (chat-agent.service.ts VISION_ORCHESTRATOR_MODEL). Refusing client-side
 * just made the paperclip look dead.
 *
 * Fixed by PR #718 (6e13cfb4): attach ALWAYS, then an honest info toast when
 * the model itself won't see pixels. This pin locks the contract in the
 * source-pin idiom (c1-convergence-smoke / desktop-file-picker-pins).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const SRC = readFileSync(
  fileURLToPath(new URL('./CodeSessionView.tsx', import.meta.url)),
  'utf8',
);

describe('c7d404cf — composer never refuses images on text-only models', () => {
  it('the refusal copy is gone from every attach path', () => {
    expect(SRC).not.toContain("This coding model can't use images");
    expect(SRC).not.toContain('to attach screenshots');
  });

  it('paperclip/drop attaches BEFORE any vision check (no refusal possible)', () => {
    const stage = SRC.indexOf('addImageFiles(images);');
    const visionCheck = SRC.indexOf('modelSupportsVision(sessionModel)');
    expect(stage).toBeGreaterThan(-1);
    expect(visionCheck).toBeGreaterThan(-1);
    expect(stage).toBeLessThan(visionCheck);
  });

  it('paste path has no vision-gated early return before addImageFiles', () => {
    const pasteToast = SRC.indexOf("Array.from(e.clipboardData?.items || []).filter(it => it.type.startsWith('image/'))");
    expect(pasteToast).toBeGreaterThan(-1);
    const pasteStage = SRC.indexOf('addImageFiles(pasted.map(');
    expect(pasteStage).toBeGreaterThan(-1);
    // Between the paste detection and the staging call there must be no
    // modelSupportsVision refusal (the old gate sat exactly there).
    const between = SRC.slice(pasteToast, pasteStage);
    expect(between).not.toContain('modelSupportsVision');
  });

  it('text-only models still get the honest describe-and-inject toast (both paths)', () => {
    const toast = "'Attached — Digby will describe the image for this text-only model'";
    // Once on the paperclip/drop path, once on the paste path.
    expect(SRC.split(toast).length - 1).toBe(2);
  });

  it('toast copy never names a retired persona (owner rename 2026-09-15 — Double/Triple Checker)', () => {
    // The describe-and-inject toast description once said "switch the coding
    // model to Digby or The Logician" — a persona that no longer exists
    // anywhere (Account → Coding names engines plainly since the rename).
    expect(SRC).not.toMatch(/The Logician|The Professor|Fact-checker/);
  });

  it('a vision-capability check may only choose the toast, never skip staging', () => {
    // Every modelSupportsVision call site in this file must be followed (within
    // a small window) by the describe toast — never by a bare return.
    const re = /modelSupportsVision\((sessionModel|activeSession\?\.model)\)[\s\S]{0,220}/g;
    const hits = SRC.match(re) || [];
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h).toContain('describe the image');
      expect(h).not.toMatch(/\breturn\b/);
    }
  });
});
