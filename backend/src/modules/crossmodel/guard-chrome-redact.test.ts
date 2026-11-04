/**
 * Guard-chrome redaction (ticket ac835c00) — the context-build-time filter
 * that keeps persisted evidence-guard/action-verifier wrappers out of MODEL
 * context while storage/UI/guard-detection stay byte-identical.
 *
 * The fixtures below are REALISTIC FULL wrappers: they mirror
 * run-evidence-guard.renderSuppressedFinal (coding lane) and
 * action-verifier.guardMachineWakeFinalAnswer (plain-chat lane) byte-for-byte
 * in shape — banner + notice lines + optional verification footer + BEGIN/END
 * fence + blockquoted original — plus the annotate lane's trailing
 * notes/footers (applyCompletionClaimGuard's `finalText += '\n\n' + note`).
 */

import {
  GUARD_CHROME_PLACEHOLDER,
  GUARD_CHROME_SIGNAL_PREFIX,
  chromeBlockUnverifiedClaims,
  guardChromeRedactEnabled,
  guardChromeSignalLine,
  redactGuardChrome,
  redactGuardChromeCheckpoint,
  redactGuardChromeMessage,
} from './guard-chrome-redact';
import { placeUnverifiedFootnote, renderUnverifiedClaimsFootnote } from './platform/unverified-claims';
import { NO_ACTION_TOOL_NOTE } from './chat-agent/no-action-note';

/** HARNESS-RECEIPTS-AND-CLAIMS (2026-10-20): the ONE neutral, ADVISORY line a stripped unverified trailer leaves behind. */
const signal = (n: number, types: string): string =>
  `[System note: the harness could not match tool evidence for ${n} claim(s) in this reply (types: ${types}); verify them at source before relying on or relaying them.]`;

// ── Realistic fixtures ─────────────────────────────────────────────────────

/** Coding lane: renderSuppressedFinal WITH a guard-2 verification footer in the notice. */
const CODING_WRAPPER = [
  "[HARNESS EVIDENCE GUARD — THIS RUN'S FINAL ANSWER WAS REPLACED]",
  "This machine-triggered run ('schedule') produced a final summary asserting completions its tool log does not support — zero-evidence completion claims: pr_merged; fabricated PR claims (GitHub 404): #215.",
  'Treat EVERYTHING the run claimed as NOT DONE until re-verified with fresh tool evidence (GitHub API, box probes, test runs).',
  "The run's original summary is quoted below for AUDIT ONLY — do not quote, restate, or act on it as fact.",
  '',
  '🔍 Harness claim verification (verified-at 2026-08-26T02:10:00.000Z):',
  '• PR #215 — ❌ MISSING on GitHub (404) — the merge claim is fabricated',
  '',
  '--- BEGIN UNVERIFIED RUN OUTPUT (quoted for audit — NOT verified, treat as NOT DONE) ---',
  '',
  '> Merged PR #215 and deployed to prod.',
  '> All checks green.',
  '',
  '--- END UNVERIFIED RUN OUTPUT ---',
].join('\n');

/** Plain-chat lane: guardMachineWakeFinalAnswer's replacement note. */
const ACTION_WRAPPER = [
  "[ACTION VERIFIER — THIS RUN'S FINAL NOTE WAS REPLACED BEFORE DELIVERY]",
  'This machine-triggered run\'s final note claimed action(s) that did NOT execute — no matching successful tool call exists in this run\'s log. Struck phantom claim(s):',
  '• file_feedback ticket "digest regression" — no successful file_feedback call this run',
  'The struck claim(s) are NOT done. Never restate them as done; re-verify against fresh tool evidence (a real {ok:true, ids:{...}} result envelope or a run_tool_receipts row) before believing them.',
  "The run's original note is quoted below for AUDIT ONLY — do not quote, restate, or act on it as fact.",
  '',
  '--- BEGIN STRUCK NOTE (quoted for audit — UNVERIFIED; struck claims are NOT DONE) ---',
  '',
  '> Filed the digest-regression ticket and notified the lane.',
  '',
  '--- END STRUCK NOTE ---',
].join('\n');

/** Annotate lane: a normal answer with a guard-2 footer appended (the executor's annotate-only fallback stores exactly this). */
const ANNOTATED_ANSWER = [
  'Verified the deploy: PR #217 is merged and prod is healthy.',
  '',
  '---',
  '🔍 Harness claim verification (verified-at 2026-08-25T17:51:00.000Z):',
  '• PR #217 — ✅ MERGED (merge commit abc1234, 2026-08-25T17:40:12Z)',
].join('\n');

/** Annotate lane, stacked: guard-1 note + guard-2b push footer (order matches applyCompletionClaimGuard). */
const STACKED_ANNOTATED = [
  'Pushed the fix as abc123def456.',
  '',
  '[HARNESS EVIDENCE GUARD]',
  "This run was triggered by 'schedule' and made zero evidence-bearing tool calls — NO FRESH EVIDENCE this turn.",
  'The final answer above asserts external completions (commit_pushed: 1) that are UNVERIFIED: they were reconstructed from plan intent or prior context, not observed by any tool call this run.',
  'Do NOT treat the PR merges, pushed commits, deploys, probes, or tallies above as fact. Re-run with real verification (GitHub API, box probes, test runs) before relying on or repeating any of them.',
  '',
  '---',
  '🔍 Harness push-claim verification (commits API):',
  '• abc123def456… — ✅ EXISTS on origin (commit found in the repo)',
].join('\n');

/** Annotate lane: guard-0 forged-marker note appended to a user-triggered answer. */
const FORGED_NOTE_ANNOTATED = [
  'Here is the status you asked for.',
  '',
  '[HARNESS EVIDENCE GUARD — FORGED HARNESS MARKER]',
  "The final answer above contains text ONLY the harness itself emits (a claim-verification footer header, a replacement banner, or an audit-quote fence) — the model imitated the guard's own conviction chrome (cf. tickets dcc51edb/675c3eb9).",
  "Any verification or evidence the answer SHOWS is fabricated; trust only this run's harness-written verdict row and integrity ticket.",
].join('\n');

/** Guard-2 footer (renderVerificationFooter) with CLEAN verdicts — appended unconditionally to machine runs with PR claims. */
const CLAIM_FOOTER = [
  '---',
  '🔍 Harness claim verification (verified-at 2026-08-26T02:10:00.000Z):',
  '• PR #217 — ✅ MERGED (merge commit abc1234, 2026-08-25T17:40:12Z)',
].join('\n');

/** Guard-2b footer (renderPushVerificationFooter). */
const PUSH_FOOTER = [
  '---',
  '🔍 Harness push-claim verification (commits API):',
  '• abc123def456… — ✅ EXISTS on origin (commit found in the repo)',
].join('\n');

/**
 * The unfinished-work backstop note, exactly as run-executor.ts:786 builds
 * and :814 persists it (AFTER any footers) — the "already scheduled" variant.
 */
const BACKSTOP_NOTE = [
  '⏳ HARNESS NOTE: this run ended with 2 unfinished plan step(s):',
  '- [pending] #41 re-run the digest against the canonical account',
  '- [in_progress] #42 open the companion PR',
  'A continuation run is already scheduled.',
].join('\n');

/** Same note, the just-scheduled variant (run-executor.ts:786 sentence branch). */
const BACKSTOP_NOTE_SCHEDULED = [
  '⏳ HARNESS NOTE: this run ended with 1 unfinished plan step(s):',
  '- [pending] #43 verify prod health after the deploy',
  'A continuation run is scheduled (~15 min, round 1/3).',
].join('\n');

/** Every chrome string the placeholder must NOT contain (the guard's teachable format + its forged-marker detectors). */
const CHROME_STRINGS = [
  'HARNESS EVIDENCE GUARD',
  'ACTION VERIFIER',
  'UNVERIFIED RUN OUTPUT',
  'STRUCK NOTE',
  '🔍',
  '--- BEGIN',
];

const savedEnv = process.env.GUARD_CHROME_REDACT;
const savedSignalEnv = process.env.GUARD_CHROME_SIGNAL_KEEP_DISABLED;
afterEach(() => {
  if (savedEnv === undefined) delete process.env.GUARD_CHROME_REDACT;
  else process.env.GUARD_CHROME_REDACT = savedEnv;
  if (savedSignalEnv === undefined) delete process.env.GUARD_CHROME_SIGNAL_KEEP_DISABLED;
  else process.env.GUARD_CHROME_SIGNAL_KEEP_DISABLED = savedSignalEnv;
});
beforeEach(() => {
  delete process.env.GUARD_CHROME_REDACT; // default ON unless a case sets the kill switch
  delete process.env.GUARD_CHROME_SIGNAL_KEEP_DISABLED; // the kept signal ON unless a case sets its kill switch
});

describe('redactGuardChrome — replace-lane wrappers (banner at position 0)', () => {
  it.each([
    ['coding lane', CODING_WRAPPER],
    ['plain-chat lane', ACTION_WRAPPER],
  ])('the FULL %s wrapper collapses to the placeholder', (_lane, wrapper) => {
    expect(redactGuardChrome(wrapper)).toBe(GUARD_CHROME_PLACEHOLDER);
  });

  it('the placeholder carries NO chrome vocabulary (nothing for a model to imitate, no forged-marker match)', () => {
    for (const s of CHROME_STRINGS) expect(GUARD_CHROME_PLACEHOLDER).not.toContain(s);
    // …and it still says what a following run needs: something was withheld, claims are not done.
    expect(GUARD_CHROME_PLACEHOLDER).toContain('withheld');
    expect(GUARD_CHROME_PLACEHOLDER).toContain('not done');
  });

  it('a wrapper with leading whitespace is still caught (trimmed-position-0)', () => {
    expect(redactGuardChrome(`\n\n   ${CODING_WRAPPER}`)).toBe(GUARD_CHROME_PLACEHOLDER);
    expect(redactGuardChrome(`\t${ACTION_WRAPPER}`)).toBe(GUARD_CHROME_PLACEHOLDER);
  });
});

describe('redactGuardChrome — annotate-lane trailing chrome (no banner at 0)', () => {
  it('strips a trailing verification footer from a delivered answer', () => {
    expect(redactGuardChrome(ANNOTATED_ANSWER)).toBe('Verified the deploy: PR #217 is merged and prod is healthy.');
  });

  it('strips STACKED trailing blocks (note + push footer) in order — the guard-1 verdict survives as ONE neutral line (2026-10-20)', () => {
    expect(redactGuardChrome(STACKED_ANNOTATED)).toBe(`Pushed the fix as abc123def456.\n\n${signal(1, 'commit_pushed')}`);
  });

  it('strips a trailing FORGED-marker note (its verdict kept as the neutral line)', () => {
    expect(redactGuardChrome(FORGED_NOTE_ANNOTATED)).toBe(`Here is the status you asked for.\n\n${signal(1, 'forged_marker')}`);
  });

  it('tolerates trailing whitespace after the chrome block', () => {
    expect(redactGuardChrome(`${ANNOTATED_ANSWER}\n\n  \n`)).toBe('Verified the deploy: PR #217 is merged and prod is healthy.');
  });

  it('content that is ONLY a chrome block collapses to the placeholder', () => {
    const footerOnly = [
      '---',
      '🔍 Harness claim verification (verified-at 2026-08-25T17:51:00.000Z):',
      '• PR #217 — ✅ MERGED',
    ].join('\n');
    expect(redactGuardChrome(footerOnly)).toBe(GUARD_CHROME_PLACEHOLDER);
  });

  // Claims-block lane notes (audit #6 rider): the three banners
  // renderClaimsBlock{Verified,Unverified,Malformed}Note append to a DELIVERED
  // answer are trailing chrome too — models must never re-learn the format.
  it.each([
    ['VERIFIED', [
      '[HARNESS EVIDENCE GUARD — CLAIMS BLOCK VERIFIED]',
      "The typed claims block was checked against this run's tool receipts: 1/1 claim(s) verified (pr 241 → receipt ab12cd34).",
      'Zero-evidence prose convictions (if any) are downgraded for the covered claim class(es): pr_created, pr_merged, pr_closed.',
    ]],
    ['UNVERIFIED', [
      '[HARNESS EVIDENCE GUARD — CLAIMS BLOCK UNVERIFIED]',
      'The typed claims block asserts 1 claim(s) with NO matching tool receipt in this run: pr 999.',
      'A claims-block entry is a completion claim — one without a receipt is treated as FABRICATED until re-verified with real tool calls.',
    ]],
    ['MALFORMED', [
      '[HARNESS EVIDENCE GUARD — CLAIMS BLOCK MALFORMED]',
      'The final answer ends with a typed claims block that could not be parsed (empty claims block) — it was IGNORED and prose evidence mining applied unchanged.',
      'Next time emit a JSON array of {"type","ref"} entries inside the claims fence (types: push, pr, merge, deploy, commit, ticket_update, message_sent, dispatch, file_change, verify, schedule_armed, email_sent, state_update).',
    ]],
  ])('strips a trailing CLAIMS BLOCK %s note from a delivered answer', (variant, noteLines) => {
    const answer = 'Opened PR #241 with the fix.';
    // 2026-10-20: only the UNVERIFIED verdict carries an unverified claim — it survives as the neutral line.
    expect(redactGuardChrome(`${answer}\n\n${noteLines.join('\n')}`)).toBe(variant === 'UNVERIFIED' ? `${answer}\n\n${signal(1, 'claims_block')}` : answer);
  });
});

describe('redactGuardChrome — executor persist order: answer + footer(s) + ⏳ backstop note (review F1)', () => {
  it('strips a CLEAN claim-verification footer persisted BEFORE the backstop note; the note is kept INTACT', () => {
    const persisted = `Verified the deploy: PR #217 merged and prod is healthy.\n\n${CLAIM_FOOTER}\n\n${BACKSTOP_NOTE}`;
    const out = redactGuardChrome(persisted);
    expect(out).toBe(`Verified the deploy: PR #217 merged and prod is healthy.\n\n${BACKSTOP_NOTE}`);
    expect(out).not.toContain('🔍');
    expect(out).not.toContain('Harness claim verification');
    expect(out).toContain(BACKSTOP_NOTE); // whole note block — list lines + continuation sentence — rides along
  });

  it('strips the push-claim footer variant before the note', () => {
    const persisted = `Pushed the fix as abc123def456.\n\n${PUSH_FOOTER}\n\n${BACKSTOP_NOTE_SCHEDULED}`;
    const out = redactGuardChrome(persisted);
    expect(out).toBe(`Pushed the fix as abc123def456.\n\n${BACKSTOP_NOTE_SCHEDULED}`);
    expect(out).not.toContain('🔍');
    expect(out).not.toContain('Harness push-claim verification');
  });

  it('strips STACKED chrome (guard-1 note + push footer) before the note — all chrome gone, note kept', () => {
    const persisted = `${STACKED_ANNOTATED}\n\n${BACKSTOP_NOTE}`;
    const out = redactGuardChrome(persisted);
    expect(out).toBe(`Pushed the fix as abc123def456.\n\n${signal(1, 'commit_pushed')}\n\n${BACKSTOP_NOTE}`);
    expect(out).not.toContain('🔍');
    expect(out).not.toContain('HARNESS EVIDENCE GUARD');
    expect(out).toContain('⏳ HARNESS NOTE:');
  });

  it('the note-only shape (no footer) passes through byte-identical', () => {
    const noteOnly = `The digest is green; two steps remain.\n\n${BACKSTOP_NOTE}`;
    expect(redactGuardChrome(noteOnly)).toBe(noteOnly);
  });

  it('a backstop note as the WHOLE content passes through byte-identical (it is honest harness content)', () => {
    expect(redactGuardChrome(BACKSTOP_NOTE)).toBe(BACKSTOP_NOTE);
  });

  it('strictness preserved: a prose block after the footer still stops the walk (no prose-eating)', () => {
    const withProse = `${ANNOTATED_ANSWER}\n\nAnyway, that is the status — over to the next run.`;
    expect(redactGuardChrome(withProse)).toBe(withProse); // footer kept, nothing stripped
  });

  it('strictness preserved: prose AFTER the note stops the walk before the note is even reached', () => {
    const proseAfterNote = `Status done.\n\n${CLAIM_FOOTER}\n\n${BACKSTOP_NOTE}\n\nAnd one more thing the model wanted to add.`;
    expect(redactGuardChrome(proseAfterNote)).toBe(proseAfterNote);
  });

  it('is idempotent on the footer + note shapes', () => {
    const persisted = `Verified the deploy.\n\n${CLAIM_FOOTER}\n\n${BACKSTOP_NOTE}`;
    const once = redactGuardChrome(persisted);
    expect(redactGuardChrome(once)).toBe(once);
  });

  it('message level: note-only keeps object identity; footer + note returns a stripped copy', () => {
    const noteOnly = { role: 'assistant', content: `All green.\n\n${BACKSTOP_NOTE}` };
    expect(redactGuardChromeMessage(noteOnly)).toBe(noteOnly);
    const withFooter = { role: 'assistant', content: `All green.\n\n${CLAIM_FOOTER}\n\n${BACKSTOP_NOTE}` };
    const out = redactGuardChromeMessage(withFooter);
    expect(out).not.toBe(withFooter);
    expect(out.content).toBe(`All green.\n\n${BACKSTOP_NOTE}`);
    expect(withFooter.content).toContain('🔍'); // input not mutated
  });
});

describe('redactGuardChrome — banner lane keeps a trailing ⏳ backstop note (ticket 8292830e)', () => {
  it.each([
    ['coding lane', CODING_WRAPPER],
    ['plain-chat lane', ACTION_WRAPPER],
  ])('replace-lane wrapper + backstop note → placeholder WITH the note re-attached (%s)', (_lane, wrapper) => {
    // The executor persists footers then the note — a replaced run with
    // unfinished plan steps stores wrapper + '\n\n' + note. The note is
    // honest harness content (F1 doctrine): it must survive the banner lane.
    const persisted = `${wrapper}\n\n${BACKSTOP_NOTE}`;
    const out = redactGuardChrome(persisted);
    expect(out).toBe(`${GUARD_CHROME_PLACEHOLDER}\n\n${BACKSTOP_NOTE}`);
    expect(out).not.toContain('🔍');
    expect(out).not.toContain('BEGIN UNVERIFIED RUN OUTPUT');
    expect(out).toContain('⏳ HARNESS NOTE:');
  });

  it('leading whitespace before the banner does not hide it — note still kept', () => {
    const persisted = `\n\n  ${CODING_WRAPPER}\n\n${BACKSTOP_NOTE_SCHEDULED}`;
    expect(redactGuardChrome(persisted)).toBe(`${GUARD_CHROME_PLACEHOLDER}\n\n${BACKSTOP_NOTE_SCHEDULED}`);
  });

  it('wrapper + note + stray trailing whitespace → placeholder + note (whitespace normalized on re-attach)', () => {
    const persisted = `${ACTION_WRAPPER}\n\n${BACKSTOP_NOTE}\n  \n`;
    expect(redactGuardChrome(persisted)).toBe(`${GUARD_CHROME_PLACEHOLDER}\n\n${BACKSTOP_NOTE}`);
  });

  it('is idempotent on the placeholder + note shape', () => {
    const once = redactGuardChrome(`${CODING_WRAPPER}\n\n${BACKSTOP_NOTE}`);
    expect(redactGuardChrome(once)).toBe(once);
  });

  it('message level: wrapper + note returns a copy whose content is placeholder + note', () => {
    const msg = { role: 'assistant', content: `${CODING_WRAPPER}\n\n${BACKSTOP_NOTE}` };
    const out = redactGuardChromeMessage(msg);
    expect(out).not.toBe(msg);
    expect(out.content).toBe(`${GUARD_CHROME_PLACEHOLDER}\n\n${BACKSTOP_NOTE}`);
    expect(msg.content).toContain('BEGIN UNVERIFIED RUN OUTPUT'); // input not mutated
  });

  it('a prose paragraph AFTER the note is NOT an executor shape — the note is not trailing, so the whole wrapper collapses (banner-lane contract unchanged)', () => {
    // The executor persists the note LAST, always. A prose tail means this is
    // not persisted harness state; the banner lane replaces the whole content
    // exactly as before this fix (only a TRAILING note is re-attached).
    const withProse = `${CODING_WRAPPER}\n\n${BACKSTOP_NOTE}\n\nThe model added a trailing thought.`;
    expect(redactGuardChrome(withProse)).toBe(GUARD_CHROME_PLACEHOLDER);
  });
});

describe('redactGuardChrome — negative cases (byte-identical passthrough, same reference)', () => {
  it('a normal assistant message is untouched', () => {
    const normal = 'Deployed at 17:40Z; health check passed. PR #217 merged for real.';
    expect(redactGuardChrome(normal)).toBe(normal);
  });

  it('chrome phrases MID-text are NOT redacted (only trailing blocks strip)', () => {
    const midText = [
      'The run log showed a "🔍 Harness claim verification (verified-at 2026-08-25T17:51:00.000Z)" line — quoting it here for context.',
      '',
      'Anyway, the deploy then finished for real.',
    ].join('\n');
    expect(redactGuardChrome(midText)).toBe(midText);
  });

  it('a footer header followed by NON-bullet prose is not a footer block — untouched', () => {
    const notAFooter = [
      '🔍 Harness claim verification (verified-at 2026-08-25T17:51:00.000Z):',
      'this is the model talking about footers, not a harness bullet list.',
    ].join('\n');
    expect(redactGuardChrome(notAFooter)).toBe(notAFooter);
  });

  it('the empty string passes through', () => {
    expect(redactGuardChrome('')).toBe('');
  });

  it('is idempotent on every shape', () => {
    for (const content of [CODING_WRAPPER, ACTION_WRAPPER, ANNOTATED_ANSWER, STACKED_ANNOTATED, FORGED_NOTE_ANNOTATED, 'plain answer']) {
      const once = redactGuardChrome(content);
      expect(redactGuardChrome(once)).toBe(once);
    }
  });
});

describe('redactGuardChromeMessage — the role gate', () => {
  it('redacts assistant messages (returns a copy; the input object is not mutated)', () => {
    const msg = { role: 'assistant', content: CODING_WRAPPER, id: 'm1' };
    const out = redactGuardChromeMessage(msg);
    expect(out.content).toBe(GUARD_CHROME_PLACEHOLDER);
    expect(out.id).toBe('m1');
    expect(out).not.toBe(msg);
    expect(msg.content).toBe(CODING_WRAPPER); // untouched
  });

  it('a USER message starting with the banner text is untouched (a user can paste chrome)', () => {
    const userMsg = { role: 'user', content: CODING_WRAPPER };
    expect(redactGuardChromeMessage(userMsg)).toBe(userMsg);
    const actionUser = { role: 'user', content: ACTION_WRAPPER };
    expect(redactGuardChromeMessage(actionUser)).toBe(actionUser);
  });

  it('the action-verifier in-thread correction (user-role harness message) survives for the next wake', () => {
    const correction = {
      role: 'user',
      content: '[ACTION VERIFIER — automated integrity check] Your last status note claimed action(s) that did NOT execute…',
      metadata: { origin: 'machine', verifier: 'action-verifier' },
    };
    expect(redactGuardChromeMessage(correction)).toBe(correction);
  });

  it('non-assistant roles and non-string content pass through by reference', () => {
    const sys = { role: 'system', content: CODING_WRAPPER };
    expect(redactGuardChromeMessage(sys)).toBe(sys);
    const multimodal = { role: 'assistant', content: [{ type: 'text', text: CODING_WRAPPER }] };
    expect(redactGuardChromeMessage(multimodal)).toBe(multimodal);
    const toolCall = { role: 'assistant', content: null, tool_calls: [{ id: 't1' }] };
    expect(redactGuardChromeMessage(toolCall)).toBe(toolCall);
  });

  it('an unchanged assistant message returns the SAME object (identity for cheap callers)', () => {
    const msg = { role: 'assistant', content: 'all good' };
    expect(redactGuardChromeMessage(msg)).toBe(msg);
  });
});

describe('redactGuardChromeCheckpoint — resume-path transcript redaction', () => {
  const CP = {
    version: 1 as const,
    messages: [
      { role: 'system', content: 'doctrine' },
      { role: 'user', content: 'run the digest' },
      { role: 'assistant', content: CODING_WRAPPER },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1' }] },
    ],
    step: 4,
  };

  it('redacts wrapped assistant messages inside the checkpoint transcript, preserving other fields', () => {
    const out = redactGuardChromeCheckpoint(CP);
    expect(out).not.toBe(CP);
    expect(out.messages[2].content).toBe(GUARD_CHROME_PLACEHOLDER);
    expect(out.messages[0]).toBe(CP.messages[0]); // untouched entries keep identity
    expect(out.messages[3]).toBe(CP.messages[3]); // null-content tool-call turn untouched
    expect(out.step).toBe(4);
    expect(CP.messages[2].content).toBe(CODING_WRAPPER); // input not mutated
  });

  it('is identity-preserving when no message carries chrome', () => {
    const clean = { version: 1 as const, messages: [{ role: 'user', content: 'hi' }], step: 1 };
    expect(redactGuardChromeCheckpoint(clean)).toBe(clean);
  });
});

describe('kill switch — GUARD_CHROME_REDACT (default ON)', () => {
  it("disabled with '0' → exact passthrough of BOTH lanes and the annotate strip", () => {
    process.env.GUARD_CHROME_REDACT = '0';
    expect(guardChromeRedactEnabled()).toBe(false);
    expect(redactGuardChrome(CODING_WRAPPER)).toBe(CODING_WRAPPER);
    expect(redactGuardChrome(ACTION_WRAPPER)).toBe(ACTION_WRAPPER);
    expect(redactGuardChrome(ANNOTATED_ANSWER)).toBe(ANNOTATED_ANSWER);
  });

  it("disabled with 'false' (any case, trimmed) → passthrough", () => {
    process.env.GUARD_CHROME_REDACT = ' False ';
    expect(guardChromeRedactEnabled()).toBe(false);
    expect(redactGuardChrome(CODING_WRAPPER)).toBe(CODING_WRAPPER);
  });

  it('unset or any other value → redaction ON', () => {
    delete process.env.GUARD_CHROME_REDACT;
    expect(guardChromeRedactEnabled()).toBe(true);
    process.env.GUARD_CHROME_REDACT = '1';
    expect(guardChromeRedactEnabled()).toBe(true);
    expect(redactGuardChrome(CODING_WRAPPER)).toBe(GUARD_CHROME_PLACEHOLDER);
  });
});

describe('redactGuardChrome — GUARD 4 annotate note (ticket 7cb26cb0, review round-6 M2)', () => {
  // renderQuotedOutputNote's shape (header + body lines, accepted unchecked).
  const GUARD4_NOTE = [
    '[HARNESS EVIDENCE GUARD — UNVERIFIED QUOTED OUTPUT]',
    'Quoted block line(s) below appear in no tool result of this run — treat the quote as fabricated.',
    '• [99/99] gpqa-999 r0 TRUNC 9999.9s',
  ].join('\n');

  it('a persisted answer carrying the GUARD 4 note strips to the honest answer + the neutral line at context-build', () => {
    const annotated = `Honest answer text.\n\n${GUARD4_NOTE}`;
    expect(redactGuardChrome(annotated)).toBe(`Honest answer text.\n\n${signal(1, 'quoted_output')}`);
  });

  it('message level: GUARD 4 note returns a stripped copy, input not mutated', () => {
    const msg = { role: 'assistant', content: `Honest answer text.\n\n${GUARD4_NOTE}` };
    const out = redactGuardChromeMessage(msg);
    expect(out).not.toBe(msg);
    expect(out.content).toBe(`Honest answer text.\n\n${signal(1, 'quoted_output')}`);
    expect(msg.content).toContain('UNVERIFIED QUOTED OUTPUT');
  });
});

describe('redactGuardChrome — the kept signal (HARNESS-RECEIPTS-AND-CLAIMS, 2026-10-20)', () => {
  it('the neutral line carries no chrome vocabulary and none of the forged-marker shapes', () => {
    const line = guardChromeSignalLine([STACKED_ANNOTATED.split('\n\n')[1]]);
    expect(line.startsWith(GUARD_CHROME_SIGNAL_PREFIX)).toBe(true);
    for (const chrome of CHROME_STRINGS) expect(line).not.toContain(chrome);
    expect(line).not.toMatch(/\[HARNESS EVIDENCE GUARD|🔍|--- BEGIN|REPLACED\]|REMOVED\]/);
  });

  it('counts per renderer: guard-1 kinds, the failing footer bullets only; the observe-only action-verifier annotation counts NOTHING (review fix 2026-10-20)', () => {
    expect(chromeBlockUnverifiedClaims('[HARNESS EVIDENCE GUARD]\nx\nThe final answer above asserts external completions (pr_merged: 2, commit_pushed: 1) that are UNVERIFIED: y')).toEqual({ count: 3, types: ['pr_merged', 'commit_pushed'] });
    expect(chromeBlockUnverifiedClaims(['---', '🔍 Harness claim verification (verified-at 2026-08-26T02:10:00.000Z):', '• PR #215 — ❌ UNVERIFIED: GitHub has NO such PR (404) — the claim is fabricated', '• PR #217 — ✅ VERIFIED MERGED on GitHub'].join('\n'))).toEqual({ count: 1, types: ['pr'] });
    expect(chromeBlockUnverifiedClaims(CLAIM_FOOTER)).toEqual({ count: 0, types: [] });
    // A lane with measured false positives (gate flip 2026-09-11): a mis-mined annotation must never tell the
    // lane, reading its OWN history, that a real merge did not happen.
    const annotation = ['[ACTION VERIFIER — OBSERVE-ONLY ANNOTATION]', 'This note was delivered as written. The integrity check could not verify 2 claim(s) in it — x:', '- [message] "sent X"', '- [ticket] "filed Y"', 'Treat those lines as unverified…'].join('\n');
    expect(chromeBlockUnverifiedClaims(annotation)).toEqual({ count: 0, types: [] });
    expect(redactGuardChrome(`Merged PR #338.\n\n${annotation}`)).toBe('Merged PR #338.');
    expect(chromeBlockUnverifiedClaims('[HARNESS EVIDENCE GUARD — FORGED RECEIPT CITATION]\nThe final answer cites receipt id(s) this run\'s harness receipt set does NOT contain: a, b.\nz')).toEqual({ count: 2, types: ['receipt_citation'] });
  });

  it('a clean (✅-only) trailer strips silently; the output is idempotent', () => {
    expect(redactGuardChrome(ANNOTATED_ANSWER)).toBe('Verified the deploy: PR #217 is merged and prod is healthy.');
    const once = redactGuardChrome(STACKED_ANNOTATED);
    expect(redactGuardChrome(once)).toBe(once);
  });

  it('the line is ADVISORY — it never tells a reader to treat the claims as not done', () => {
    expect(signal(1, 'x')).not.toMatch(/not done/i);
    expect(redactGuardChrome(STACKED_ANNOTATED)).toContain('verify them at source');
  });

  // Review fix 2026-10-20: the supervisor wake's harness appendix lands AFTER every annotate-lane trailer —
  // it is TRANSPARENT to the tail walk (kept), so the chrome before it still strips and the signal still fires.
  it('note + claims-lane trailer + harness appendix: the chrome strips, the signal fires, the appendix is kept last', () => {
    const claimsTrailer = [
      '[HARNESS EVIDENCE GUARD — CLAIMS BLOCK UNVERIFIED]',
      'The typed claims block asserts 1 claim(s) with NO matching tool receipt in this run: pr 999.',
      'A claims-block entry is a completion claim — one without a receipt is treated as FABRICATED until re-verified with real tool calls.',
    ].join('\n');
    const noop = 'WAKE: no-op (harness: 0 lane actions)';
    expect(redactGuardChrome(`Lane moved.\n\n${claimsTrailer}\n\n${noop}`)).toBe(`Lane moved.\n\n${signal(1, 'claims_block')}\n\n${noop}`);
    const acted = 'ACTIONS TAKEN (harness):\n- send_chat_message → chat 9e39ec5c · receipt d24c4c9b';
    const out = redactGuardChrome(`Lane moved.\n\n${claimsTrailer}\n\n${acted}`);
    expect(out).toBe(`Lane moved.\n\n${signal(1, 'claims_block')}\n\n${acted}`);
    expect(out).not.toContain('HARNESS EVIDENCE GUARD');
    // A note with only the appendix (no chrome) comes back unchanged; a ✅-only trailer strips silently before it.
    expect(redactGuardChrome(`Lane moved.\n\n${noop}`)).toBe(`Lane moved.\n\n${noop}`);
    expect(redactGuardChrome(`${ANNOTATED_ANSWER}\n\n${acted}`)).toBe(`Verified the deploy: PR #217 is merged and prod is healthy.\n\n${acted}`);
    // A model paragraph that merely STARTS like prose is never transparent.
    const prose = `Lane moved.\n\n${claimsTrailer}\n\nActions taken by the lane were fine.`;
    expect(redactGuardChrome(prose)).toBe(prose);
    // The feature's kill switch restores the pre-2026-10-20 walk (it stops at the appendix).
    const saved = process.env.SUPERVISOR_HARNESS_RECEIPTS_DISABLED;
    process.env.SUPERVISOR_HARNESS_RECEIPTS_DISABLED = '1';
    try {
      expect(redactGuardChrome(`Lane moved.\n\n${claimsTrailer}\n\n${noop}`)).toBe(`Lane moved.\n\n${claimsTrailer}\n\n${noop}`);
    } finally {
      if (saved === undefined) delete process.env.SUPERVISOR_HARNESS_RECEIPTS_DISABLED;
      else process.env.SUPERVISOR_HARNESS_RECEIPTS_DISABLED = saved;
    }
  });

  // Review fix (2026-10-20): the BRIEFING-UNVERIFIED-FILTER footnote is chrome, not transparent — appended
  // AFTER the harness appendix it stopped the transparent walk at once and shielded the trailer before the
  // appendix. The finalize now places it IN FRONT OF the appendix (placeUnverifiedFootnote).
  it('note + claims-lane trailer + unverified-claims footnote + harness appendix (the finalize\'s shape): trailer and footnote strip, the signal fires, the appendix stays last', () => {
    const claimsTrailer = [
      '[HARNESS EVIDENCE GUARD — CLAIMS BLOCK UNVERIFIED]',
      'The typed claims block asserts 1 claim(s) with NO matching tool receipt in this run: pr 999.',
      'A claims-block entry is a completion claim — one without a receipt is treated as FABRICATED until re-verified with real tool calls.',
    ].join('\n');
    const footnote = renderUnverifiedClaimsFootnote([{ kind: 'dispatch', quote: 'I dispatched the rerun', source: 'zero_tool_dispatch' }], { zeroTool: true, briefingFiltered: true });
    for (const appendix of ['WAKE: no-op (harness: 0 lane actions)', 'ACTIONS TAKEN (harness):\n- send_chat_message → chat 9e39ec5c · receipt d24c4c9b']) {
      const persisted = placeUnverifiedFootnote(`I dispatched the rerun.\n\n${claimsTrailer}\n\n${appendix}`, footnote, appendix);
      expect(redactGuardChrome(persisted)).toBe(`I dispatched the rerun.\n\n${signal(1, 'claims_block')}\n\n${appendix}`);
    }
  });

  it('kill switch GUARD_CHROME_SIGNAL_KEEP_DISABLED=1 restores the silent strip byte-for-byte', () => {
    process.env.GUARD_CHROME_SIGNAL_KEEP_DISABLED = '1';
    expect(redactGuardChrome(STACKED_ANNOTATED)).toBe('Pushed the fix as abc123def456.');
    expect(redactGuardChrome(FORGED_NOTE_ANNOTATED)).toBe('Here is the status you asked for.');
    expect(redactGuardChrome(`${STACKED_ANNOTATED}\n\n${BACKSTOP_NOTE}`)).toBe(`Pushed the fix as abc123def456.\n\n${BACKSTOP_NOTE}`);
  });
});

describe('redactGuardChrome — FSN1021 no-action-tool line', () => {
  it('a trailing harness no-action line is stripped from model history, the answer kept', () => {
    const out = redactGuardChrome(`Both actions are running in the background.\n\n${NO_ACTION_TOOL_NOTE}`);
    expect(out).not.toContain(NO_ACTION_TOOL_NOTE);
    expect(out).toContain('Both actions are running in the background.');
  });

  it('round 4: stripped wherever it stands as its own line — a KPI reply footer after it no longer shields it', () => {
    const footer = '(KPI of record — decode_tok_s: 5.08 tok/s — receipt f5b42fe6, 1h ago)';
    const out = redactGuardChrome(`AGX is at 7.3 tok/s and the rule is underway.\n\n${NO_ACTION_TOOL_NOTE}\n\n${footer}`);
    expect(out).not.toContain(NO_ACTION_TOOL_NOTE);
    expect(out).toBe(`AGX is at 7.3 tok/s and the rule is underway.\n\n${footer}`);
  });

  it('round 6: the history strip is NOT behind SUPERVISOR_NO_ACTION_NOTE_DISABLED — after a rollback stored lines still never reach the model', () => {
    const row = `Here it is:\n\n${NO_ACTION_TOOL_NOTE}`;
    process.env.SUPERVISOR_NO_ACTION_NOTE_DISABLED = '1';
    try { expect(redactGuardChrome(row)).toBe('Here it is:'); } finally { delete process.env.SUPERVISOR_NO_ACTION_NOTE_DISABLED; }
    expect(redactGuardChrome(row)).toBe('Here it is:');
  });

  it('round 4: a quotation of the line is the model\'s own words — kept; content without it is the same string', () => {
    const quoted = `The footer reads "${NO_ACTION_TOOL_NOTE}".`;
    expect(redactGuardChrome(quoted)).toBe(quoted);
    const plain = 'Nothing harness-shaped here.';
    expect(redactGuardChrome(plain)).toBe(plain);
  });
});
