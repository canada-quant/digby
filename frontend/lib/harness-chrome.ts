/**
 * Harness chrome split (owner ask 2026-09-14, screenshots: machine finals must
 * be "formatted neatly like other machine messages").
 *
 * A delivered assistant final can END with several HARNESS-AUTHORED sections
 * that are plumbing, not answer prose — today they render as raw paragraphs
 * and a JSON code block under every evidence-carrying report:
 *
 *   ```claims … ```                                  the claim manifest (claims-block.ts)
 *   ✓ Auto-verify passed (lint, tsc).                coding/agent.ts auto-verify line
 *   [HARNESS EVIDENCE GUARD] …paragraph…             run-evidence-guard renderEvidenceGuardNote
 *   [HARNESS EVIDENCE GUARD — …] …paragraph…         the guard's other annotate-lane notes
 *   ---
 *   🔍 Harness claim verification (verified-at …):    renderVerificationFooter
 *   • PR #134 — ✅ VERIFIED MERGED …
 *   ---
 *   🔍 Harness push-claim verification (commits API): renderPushVerificationFooter
 *   • 3f2a1b9c0d1e… — ✅ EXISTS on origin …
 *
 * This pure helper walks the TAIL of the text and peels those sections off,
 * one trailing block at a time, until the tail is ordinary prose. The visible
 * `body` renders as markdown; `chrome` renders as ONE collapsed
 * <VerificationFooter/> (chips + chevron). COLLAPSE, never filter: every
 * peeled section is returned verbatim, one click away. Display-layer only —
 * nothing here changes what is stored or sent to any model.
 *
 * Discipline (mirrors backend/src/modules/crossmodel/guard-chrome-redact.ts,
 * the model-context redactor for the same shapes):
 *  - only TRAILING blocks qualify — a quoted "[HARNESS EVIDENCE GUARD]" mid-
 *    answer followed by real prose stops the walk and stays in the body;
 *  - footers are header + only '• ' lines; notes are header line + paragraph;
 *  - the `⏳ HARNESS NOTE:` unfinished-work block is HONEST content the owner
 *    must read — it is TRANSPARENT to the walk (kept in the body, chrome
 *    before it still peels), exactly like the backend's redactor;
 *  - the claims fence is peeled via claims-block.ts (EXTENDED, not
 *    duplicated) — it can now sit UNDER later footers, the shape that
 *    defeated the trailing-only chip in the owner's screenshots.
 */

import { splitTrailingClaimsBlock } from './claims-block';

export interface HarnessVerification {
  /** Human label for the section ("Claim verification" / "Push-claim verification"). */
  label: string;
  /** The raw header line, verbatim. */
  header: string;
  /** ISO verified-at stamp when the header carries one. */
  verifiedAt?: string;
  /** Verdict lines with the leading '• ' stripped, verbatim otherwise. */
  items: string[];
}

export interface HarnessClaims {
  /** Raw inner JSON of the manifest fence. */
  json: string;
  /** Parsed entry count (0 when unparseable). */
  entryCount: number;
}

export interface HarnessChrome {
  /** The auto-verify line ("✓ Auto-verify passed (…)." / "⚠︎ Auto-verify is UNVERIFIED: …"). */
  autoVerify?: string;
  /** The [HARNESS EVIDENCE GUARD…] note — header line + body, verbatim. */
  evidenceGuard?: string;
  /** 🔍 verification footers in document order. */
  verifications: HarnessVerification[];
  /** The trailing claim manifest, when present. */
  claims?: HarnessClaims;
}

export interface HarnessSplit {
  /** Visible prose (trimEnd'd), with any transparent ⏳ HARNESS NOTE re-attached. */
  body: string;
  chrome: HarnessChrome;
  /** True iff at least one chrome section was peeled. */
  hasChrome: boolean;
}

/** Header prefixes of the 🔍 footers — byte-parity with guard-chrome-redact TRAILING_FOOTER_HEADERS. */
export const CLAIM_VERIFICATION_HEADER = '🔍 Harness claim verification (verified-at';
export const PUSH_VERIFICATION_HEADER = '🔍 Harness push-claim verification (commits API):';
/** Position-0 prefix shared by every evidence-guard note header. */
export const EVIDENCE_GUARD_PREFIX = '[HARNESS EVIDENCE GUARD';
/** The transparent unfinished-work note (kept in the body). */
export const HARNESS_NOTE_PREFIX = '⏳ HARNESS NOTE:';

const AUTO_VERIFY_RE = /^(?:✓ Auto-verify passed \([^\n]*\)\.?|⚠[︎️]? ?Auto-verify is UNVERIFIED:[^\n]*)$/;

/** Defensive cap on the peel loop (each round shrinks the text, so it always terminates). */
const MAX_ROUNDS = 12;

/** Trailing-block helpers: the text is split at the LAST blank-line gap. */
function lastParagraph(text: string): { head: string; tail: string } {
  const idx = text.search(/\n[ \t]*\n(?![\s\S]*\n[ \t]*\n)/);
  if (idx < 0) return { head: '', tail: text };
  const gap = text.slice(idx).match(/^\n[ \t]*\n/)![0].length;
  return { head: text.slice(0, idx), tail: text.slice(idx + gap) };
}

function verificationLabel(header: string): string {
  if (header.startsWith(PUSH_VERIFICATION_HEADER)) return 'Push-claim verification';
  if (header.startsWith(CLAIM_VERIFICATION_HEADER)) return 'Claim verification';
  return 'Harness verification';
}

/**
 * Try to peel a 🔍 footer off the tail: optional '---' line, the header, then
 * ONLY '• ' lines to the end. Returns null when the tail is not a footer.
 */
function peelVerification(text: string): { rest: string; section: HarnessVerification } | null {
  const lines = text.split('\n');
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  let i = end - 1;
  const items: string[] = [];
  while (i >= 0 && lines[i].startsWith('• ')) { items.unshift(lines[i].slice(2)); i--; }
  if (i < 0) return null;
  const header = lines[i];
  if (!header.startsWith(CLAIM_VERIFICATION_HEADER) && !header.startsWith(PUSH_VERIFICATION_HEADER)) return null;
  let start = i;
  if (start > 0 && lines[start - 1].trim() === '---') start--;
  const rest = lines.slice(0, start).join('\n');
  const stamp = header.match(/\(verified-at ([^)]+)\)/);
  return {
    rest,
    section: { label: verificationLabel(header), header, ...(stamp ? { verifiedAt: stamp[1] } : {}), items },
  };
}

/**
 * Peel an evidence-guard note: the LAST paragraph of the tail whose first
 * line starts with EVIDENCE_GUARD_PREFIX. Anything from that header to the
 * end is the note (the walk only reaches here once every later block was
 * chrome), so multi-paragraph note bodies survive intact.
 */
function peelEvidenceGuard(text: string): { rest: string; note: string } | null {
  const { head, tail } = lastParagraph(text);
  if (!tail.trimStart().startsWith(EVIDENCE_GUARD_PREFIX)) {
    // The header may open an EARLIER paragraph with the body spilling into
    // later ones — look for the last line-start header and take from there,
    // but only when every line in between belongs to a bracketed guard note
    // (no blank-line-separated ordinary prose after it).
    const m = text.match(/(?:^|\n)(\[HARNESS EVIDENCE GUARD[^\n]*\][\s\S]*)$/);
    if (!m) return null;
    const note = m[1];
    if (/\n[ \t]*\n/.test(note)) return null; // prose after the note — not chrome
    return { rest: text.slice(0, text.length - note.length), note };
  }
  return { rest: head, note: tail.trimEnd() };
}

/** Peel the auto-verify one-liner (last non-empty line, alone in its paragraph). */
function peelAutoVerify(text: string): { rest: string; line: string } | null {
  const { head, tail } = lastParagraph(text);
  const t = tail.trim();
  if (!AUTO_VERIFY_RE.test(t)) {
    // Also accept the line glued to the previous paragraph by a single newline.
    const nl = text.lastIndexOf('\n');
    const last = text.slice(nl + 1).trim();
    if (nl >= 0 && AUTO_VERIFY_RE.test(last)) return { rest: text.slice(0, nl), line: last };
    return null;
  }
  return { rest: head, line: t };
}

/** Peel a transparent ⏳ HARNESS NOTE block (kept — re-attached to the body). */
function peelHarnessNote(text: string): { rest: string; note: string } | null {
  const { head, tail } = lastParagraph(text);
  if (!tail.trimStart().startsWith(HARNESS_NOTE_PREFIX)) return null;
  return { rest: head, note: tail.trimEnd() };
}

export function splitHarnessChrome(content: string): HarnessSplit {
  const chrome: HarnessChrome = { verifications: [] };
  let text = (content || '').replace(/\s+$/, '');
  let hasChrome = false;
  const keptNotes: string[] = [];

  for (let round = 0; round < MAX_ROUNDS && text.length > 0; round++) {
    // A stray '---' left standing alone at the tail (separator of a footer
    // already peeled) is chrome residue.
    if (/(?:^|\n)---$/.test(text)) {
      text = text.replace(/\n?---$/, '').replace(/\s+$/, '');
      continue;
    }
    const v = peelVerification(text);
    if (v) { chrome.verifications.unshift(v.section); text = v.rest.replace(/\s+$/, ''); hasChrome = true; continue; }

    const note = peelHarnessNote(text);
    if (note) { keptNotes.unshift(note.note); text = note.rest.replace(/\s+$/, ''); continue; }

    const g = peelEvidenceGuard(text);
    if (g) { chrome.evidenceGuard = g.note; text = g.rest.replace(/\s+$/, ''); hasChrome = true; continue; }

    const a = peelAutoVerify(text);
    if (a) { chrome.autoVerify = a.line; text = a.rest.replace(/\s+$/, ''); hasChrome = true; continue; }

    // ONE manifest per final (backend parity: the LAST ```claims fence is the
    // manifest, wherever it sits — claims-block.ts). Peel it once; an earlier
    // fence is the model quoting the format and stays in the body, so the peel
    // must not run again on the next round and swallow it (review B1).
    if (!chrome.claims) {
      const c = splitTrailingClaimsBlock(text);
      if (c.claimsJson !== null) {
        chrome.claims = { json: c.claimsJson, entryCount: c.entryCount };
        text = c.clean.replace(/\s+$/, '');
        hasChrome = true;
        continue;
      }
    }
    break;
  }

  const body = [text, ...keptNotes].filter((s) => s.length > 0).join('\n\n');
  return { body, chrome, hasChrome };
}

export interface HarnessChromeSummary {
  /** '✅' verdict lines across all footers. */
  verified: number;
  /** '❌' + '⚠' verdict lines across all footers. */
  unverified: number;
  autoVerify: 'passed' | 'unverified' | null;
  claims: number;
  hasGuard: boolean;
  /** Chip labels in display order — the collapsed footer's single summary line. */
  chips: string[];
}

/** Tally the chrome for the collapsed summary line — counts only, never fabricated. */
export function summarizeHarnessChrome(chrome: HarnessChrome): HarnessChromeSummary {
  let verified = 0;
  let unverified = 0;
  for (const v of chrome.verifications) {
    for (const item of v.items) {
      if (item.includes('✅')) verified++;
      else if (item.includes('❌') || item.includes('⚠')) unverified++;
    }
  }
  const autoVerify: HarnessChromeSummary['autoVerify'] = !chrome.autoVerify
    ? null
    : chrome.autoVerify.startsWith('✓') ? 'passed' : 'unverified';
  const claims = chrome.claims?.entryCount ?? 0;
  const hasGuard = !!chrome.evidenceGuard;
  const chips: string[] = [];
  if (verified > 0) chips.push(`✅ ${verified} verified`);
  if (unverified > 0) chips.push(`⚠ ${unverified} unverified`);
  if (autoVerify === 'passed') chips.push('✓ auto-verify');
  if (autoVerify === 'unverified') chips.push('⚠ auto-verify unverified');
  if (hasGuard) chips.push('⚠ evidence guard');
  if (chrome.claims) chips.push(claims === 1 ? '1 claim' : `${claims} claims`);
  return { verified, unverified, autoVerify, claims, hasGuard, chips };
}

/** Verdict tone of one footer line — drives the per-item color in the expanded footer. */
export function verdictTone(item: string): 'ok' | 'bad' | 'warn' | 'neutral' {
  if (item.includes('✅')) return 'ok';
  if (item.includes('❌')) return 'bad';
  if (item.includes('⚠')) return 'warn';
  return 'neutral';
}
