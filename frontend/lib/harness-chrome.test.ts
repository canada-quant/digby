/**
 * Pins for lib/harness-chrome.ts — the tail-walk that peels harness-authored
 * sections off an assistant final (owner ask 2026-09-14, screenshots). The
 * fixtures below are the EXACT shapes the backend emits:
 *   coding/agent.ts                  "✓ Auto-verify passed (lint, tsc)."
 *   coding/run-evidence-guard.ts     renderEvidenceGuardNote / renderVerificationFooter /
 *                                    renderPushVerificationFooter
 *   coding/claims-block.ts           the ```claims manifest fence
 * COLLAPSE, never filter: every peeled section comes back verbatim.
 */

import { describe, expect, it } from 'vitest';
import { splitHarnessChrome, summarizeHarnessChrome, verdictTone } from './harness-chrome';

const PROSE = 'Final report — PR #134 merged and deployed.\n\nDetails of the work.';
const CLAIMS = '```claims\n[{"type":"pr","ref":"134"}]\n```';
const AUTO_VERIFY = '✓ Auto-verify passed (lint, tsc).';
const GUARD =
  '[HARNESS EVIDENCE GUARD]\n' +
  "This run was triggered by 'schedule' and made zero evidence-bearing tool calls — NO FRESH EVIDENCE this turn.\n" +
  'The final answer above asserts external completions (pr_merged: 1) that are UNVERIFIED: they were reconstructed from plan intent or prior context, not observed by any tool call this run.\n' +
  'Do NOT treat the PR merges, pushed commits, deploys, probes, or tallies above as fact. Re-run with real verification (GitHub API, box probes, test runs) before relying on or repeating any of them.';
const CLAIM_FOOTER =
  '---\n' +
  '🔍 Harness claim verification (verified-at 2026-09-14T02:11:09.000Z):\n' +
  '• PR #134 — ✅ VERIFIED MERGED (merged 2026-09-14T01:58:00Z)\n' +
  '• PR #135 — ❌ UNVERIFIED: PR is OPEN, not merged\n' +
  '• PR #136 — ⚠︎ could not verify (GitHub HTTP 502)';
const PUSH_FOOTER =
  '---\n' +
  '🔍 Harness push-claim verification (commits API):\n' +
  '• 3f2a1b9c0d1e… — ✅ EXISTS on origin (commit found in the repo)';

/** The owner's screenshot: prose, manifest, auto-verify, guard note, both footers. */
const SCREENSHOT = [PROSE, CLAIMS, AUTO_VERIFY, GUARD, CLAIM_FOOTER, PUSH_FOOTER].join('\n\n');

describe('splitHarnessChrome — the screenshot shape', () => {
  it('peels every harness section and leaves ONLY the prose in the body', () => {
    const out = splitHarnessChrome(SCREENSHOT);
    expect(out.hasChrome).toBe(true);
    expect(out.body).toBe(PROSE);
  });

  it('returns the claims manifest (a fence UNDER later footers — the shape the trailing-only chip missed)', () => {
    const { chrome } = splitHarnessChrome(SCREENSHOT);
    expect(chrome.claims).toEqual({ json: '[{"type":"pr","ref":"134"}]', entryCount: 1 });
  });

  it('returns the auto-verify line verbatim', () => {
    expect(splitHarnessChrome(SCREENSHOT).chrome.autoVerify).toBe(AUTO_VERIFY);
  });

  it('returns the evidence-guard note verbatim (header + body)', () => {
    expect(splitHarnessChrome(SCREENSHOT).chrome.evidenceGuard).toBe(GUARD);
  });

  it('returns both 🔍 footers in document order with labels, verified-at, and de-bulleted items', () => {
    const { chrome } = splitHarnessChrome(SCREENSHOT);
    expect(chrome.verifications).toHaveLength(2);
    const [claim, push] = chrome.verifications;
    expect(claim.label).toBe('Claim verification');
    expect(claim.verifiedAt).toBe('2026-09-14T02:11:09.000Z');
    expect(claim.header).toBe('🔍 Harness claim verification (verified-at 2026-09-14T02:11:09.000Z):');
    expect(claim.items).toEqual([
      'PR #134 — ✅ VERIFIED MERGED (merged 2026-09-14T01:58:00Z)',
      'PR #135 — ❌ UNVERIFIED: PR is OPEN, not merged',
      'PR #136 — ⚠︎ could not verify (GitHub HTTP 502)',
    ]);
    expect(push.label).toBe('Push-claim verification');
    expect(push.verifiedAt).toBeUndefined();
    expect(push.items).toEqual(['3f2a1b9c0d1e… — ✅ EXISTS on origin (commit found in the repo)']);
  });

  it('summarizes into the chip line: verified / unverified / auto-verify / guard / claims', () => {
    const s = summarizeHarnessChrome(splitHarnessChrome(SCREENSHOT).chrome);
    expect(s.verified).toBe(2);
    expect(s.unverified).toBe(2);
    expect(s.autoVerify).toBe('passed');
    expect(s.hasGuard).toBe(true);
    expect(s.claims).toBe(1);
    expect(s.chips).toEqual(['✅ 2 verified', '⚠ 2 unverified', '✓ auto-verify', '⚠ evidence guard', '1 claim']);
  });
});

describe('splitHarnessChrome — each section alone', () => {
  it('a trailing claims fence alone (the 295068fa chip case) still splits', () => {
    const out = splitHarnessChrome(`${PROSE}\n\n${CLAIMS}`);
    expect(out.body).toBe(PROSE);
    expect(out.chrome.claims?.entryCount).toBe(1);
    expect(out.chrome.verifications).toEqual([]);
    expect(summarizeHarnessChrome(out.chrome).chips).toEqual(['1 claim']);
  });

  it('an auto-verify line alone (its own text part) yields an EMPTY body and the line', () => {
    const out = splitHarnessChrome(AUTO_VERIFY);
    expect(out.body).toBe('');
    expect(out.chrome.autoVerify).toBe(AUTO_VERIFY);
    expect(out.hasChrome).toBe(true);
  });

  it('the UNVERIFIED auto-verify variant is recognised and summarised as unverified', () => {
    const line = '⚠︎ Auto-verify is UNVERIFIED: stage(s) tsc skipped (tool not installed) — the chain did not fully run, so this is not a verified pass.';
    const out = splitHarnessChrome(`${PROSE}\n\n${line}`);
    expect(out.body).toBe(PROSE);
    expect(out.chrome.autoVerify).toBe(line);
    expect(summarizeHarnessChrome(out.chrome).chips).toEqual(['⚠ auto-verify unverified']);
  });

  it('an auto-verify line glued to the prose by a single newline still peels', () => {
    const out = splitHarnessChrome(`${PROSE}\n${AUTO_VERIFY}`);
    expect(out.body).toBe(PROSE);
    expect(out.chrome.autoVerify).toBe(AUTO_VERIFY);
  });

  it('a claim footer alone (with its --- separator) peels including the separator', () => {
    const out = splitHarnessChrome(`${PROSE}\n\n${CLAIM_FOOTER}`);
    expect(out.body).toBe(PROSE);
    expect(out.chrome.verifications).toHaveLength(1);
    expect(out.chrome.verifications[0].items).toHaveLength(3);
  });

  it('a footer WITHOUT the --- separator peels too', () => {
    const noSep = CLAIM_FOOTER.replace(/^---\n/, '');
    const out = splitHarnessChrome(`${PROSE}\n\n${noSep}`);
    expect(out.body).toBe(PROSE);
    expect(out.chrome.verifications[0].label).toBe('Claim verification');
  });

  it('an evidence-guard note alone peels; a "— VARIANT" header peels too', () => {
    expect(splitHarnessChrome(`${PROSE}\n\n${GUARD}`).body).toBe(PROSE);
    const variant = '[HARNESS EVIDENCE GUARD — CLAIMS BLOCK VERIFIED]\nAll 1 manifest entries matched journal receipts.';
    const out = splitHarnessChrome(`${PROSE}\n\n${variant}`);
    expect(out.body).toBe(PROSE);
    expect(out.chrome.evidenceGuard).toBe(variant);
    expect(summarizeHarnessChrome(out.chrome).chips).toEqual(['⚠ evidence guard']);
  });
});

describe('splitHarnessChrome — discipline (never over-strip)', () => {
  it('ordinary prose is untouched: no chrome, body identical', () => {
    const out = splitHarnessChrome(PROSE);
    expect(out.hasChrome).toBe(false);
    expect(out.body).toBe(PROSE);
    expect(out.chrome).toEqual({ verifications: [] });
  });

  it('a QUOTED guard header mid-answer followed by real prose stays in the body', () => {
    const text = `The guard note looks like this:\n\n[HARNESS EVIDENCE GUARD]\nThis run made zero tool calls.\n\nSo that is the format, and here is my actual answer.`;
    const out = splitHarnessChrome(text);
    expect(out.hasChrome).toBe(false);
    expect(out.body).toBe(text);
  });

  it('a single claims fence followed by prose is the manifest (owner 2026-09-18) — chip + both prose halves kept', () => {
    const text = `The contract looks like this:\n\n${CLAIMS}\n\nand that is how receipts are verified.`;
    const out = splitHarnessChrome(text);
    expect(out.hasChrome).toBe(true);
    expect(out.body).toBe('The contract looks like this:\n\nand that is how receipts are verified.');
    expect(out.chrome.claims?.entryCount).toBe(1);
  });

  it('a quoted fence + a later real manifest: only the LAST collapses, the quoted one stays in the body (review B1)', () => {
    const text = `Format:\n\n${CLAIMS}\n\nCorrection follows.\n\n\`\`\`claims\n[{"type":"pr","ref":"135"}]\n\`\`\``;
    const out = splitHarnessChrome(text);
    expect(out.body).toBe(`Format:\n\n${CLAIMS}\n\nCorrection follows.`);
    expect(out.chrome.claims).toEqual({ json: '[{"type":"pr","ref":"135"}]', entryCount: 1 });
  });

  it('the owner screenshot 2026-09-18: manifest with a GLUED closer, then footers — everything peels, the glued sentence stays visible', () => {
    const glued = 'Progress.\n\n```claims\n[{"type":"file_change","ref":"1a4a218"}]\n```Step 8 is done — remaining: a smoke check.';
    const out = splitHarnessChrome(`${glued}\n\n${AUTO_VERIFY}`);
    expect(out.body).toBe('Progress.\n\nStep 8 is done — remaining: a smoke check.');
    expect(out.chrome.claims?.entryCount).toBe(1);
    expect(out.chrome.autoVerify).toBe(AUTO_VERIFY);
  });

  it('a bulleted list that is NOT under a 🔍 header is prose, not a footer', () => {
    const text = `Findings:\n\n• first\n• second`;
    const out = splitHarnessChrome(text);
    expect(out.hasChrome).toBe(false);
    expect(out.body).toBe(text);
  });

  it('the ⏳ HARNESS NOTE is TRANSPARENT: kept in the body, chrome before it still peels', () => {
    const note = '⏳ HARNESS NOTE: this run ended with 2 unfinished plan step(s):\n- [pending] #3 write tests\nA continuation run is already scheduled.';
    const out = splitHarnessChrome(`Report body.\n\n${CLAIM_FOOTER}\n\n${note}`);
    expect(out.body).toBe(`Report body.\n\n${note}`);
    expect(out.chrome.verifications).toHaveLength(1);
    expect(out.hasChrome).toBe(true);
  });

  it('a stray trailing --- (separator residue) is dropped from the body', () => {
    const out = splitHarnessChrome(`${PROSE}\n\n---\n\n${AUTO_VERIFY}`);
    expect(out.body).toBe(PROSE);
    expect(out.chrome.autoVerify).toBe(AUTO_VERIFY);
  });

  it('empty / null-ish input is safe', () => {
    expect(splitHarnessChrome('')).toEqual({ body: '', chrome: { verifications: [] }, hasChrome: false });
    expect(splitHarnessChrome(undefined as unknown as string).body).toBe('');
  });
});

describe('verdictTone', () => {
  it('maps the verdict glyphs to tones', () => {
    expect(verdictTone('PR #1 — ✅ VERIFIED MERGED')).toBe('ok');
    expect(verdictTone('PR #2 — ❌ UNVERIFIED')).toBe('bad');
    expect(verdictTone('sha… — ⚠︎ receipt-cited sha NOT on origin')).toBe('warn');
    expect(verdictTone('plain')).toBe('neutral');
  });
});
