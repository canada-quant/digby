import {
  findIncompleteCards,
  findOwnerFrustration,
  findSurvivingMarkers,
} from './framework-signal-detectors';

const hit = (content: string | null, parts: unknown = null) =>
  findSurvivingMarkers({ chatId: 'chat-1', messageId: 'msg-1', content, parts });

describe('surviving markers', () => {
  it('does not flag a well-formed closed SEND_EMAIL draft', () => {
    const found = hit(
      '[SEND_EMAIL to="zachary.seddon@hyperstack.cloud" cc="billing@nexgencloud.com" subject="Re: Hyperstack Cloud - CQL — billing terms (credit vs daily prepay)"] Hi Zac, thanks. [/SEND_EMAIL]',
    );
    expect(found).toEqual([]);
  });

  it('flags a closed block with no to as high / no valid to', () => {
    const [row] = hit('[SEND_EMAIL subject="hi"]body[/SEND_EMAIL]');
    expect(row).toMatchObject({ marker: 'SEND_EMAIL', reason: 'no valid to', high: true });
  });

  it('flags a closed to="" block as high / no valid to', () => {
    const [row] = hit('[SEND_EMAIL to=""]body[/SEND_EMAIL]');
    expect(row).toMatchObject({ marker: 'SEND_EMAIL', reason: 'no valid to', high: true });
  });

  it('flags an unclosed to= marker as high', () => {
    const [row] = hit('[SEND_EMAIL to="secret@example.com"');
    expect(row).toMatchObject({ marker: 'SEND_EMAIL', reason: 'unclosed', high: true });
  });

  it('does not treat spaces around = as a to= attribute', () => {
    const [row] = hit('[SEND_EMAIL to = "a@b.c"]body[/SEND_EMAIL]');
    expect(row).toMatchObject({ marker: 'SEND_EMAIL', reason: 'no valid to', high: false });
  });

  it('flags a subject-only unclosed marker without high', () => {
    const [row] = hit('[SEND_EMAIL subject="hi"');
    expect(row).toMatchObject({ marker: 'SEND_EMAIL', reason: 'unclosed', high: false });
  });

  it('flags lowercase send_email with to= as high', () => {
    const [row] = hit('[send_email to="a@b.c"]body[/send_email]');
    expect(row).toMatchObject({ marker: 'SEND_EMAIL', reason: 'no valid to', high: true });
  });

  it('keeps a leftover WIDGET beside a stripped draft — WIDGET has no renderer, so it is out of scope (d6fdc1df)', () => {
    const found = hit('[WIDGET][SEND_EMAIL to="a@b.c"]x[/SEND_EMAIL]');
    expect(found).toEqual([]);
  });

  it('strips a well-formed draft inside a fence and does not flag it', () => {
    expect(hit('```\n[SEND_EMAIL to="a@b.c"]x[/SEND_EMAIL]\n```')).toEqual([]);
  });

  it('skips a malformed marker inside a fence', () => {
    expect(hit('```\n[WIDGET]\n```')).toEqual([]);
  });

  it('strips FOLLOWUPS and does not flag them', () => {
    expect(hit('[FOLLOWUPS]ask[/FOLLOWUPS]')).toEqual([]);
  });

  it('strips a CANVAS block; a trailing WIDGET has no renderer and stays out of scope', () => {
    const found = hit('[CANVAS title="t"]body[/CANVAS][WIDGET]');
    expect(found).toEqual([]);
  });

  it('a nested leftover inside a stripped canvas has no renderer and stays out of scope', () => {
    const found = hit('[CANVAS][WIDGET][/CANVAS]');
    expect(found).toEqual([]);
  });

  it('keeps the whole message when the first closed to is empty, and flags high', () => {
    const [row] = hit('[SEND_EMAIL to=""]a[/SEND_EMAIL][SEND_EMAIL to="a@b.c"]b[/SEND_EMAIL]');
    expect(row).toMatchObject({ marker: 'SEND_EMAIL', reason: 'no valid to', high: true });
  });

  it('merges a content hit with a text part and keeps the stronger reason', () => {
    const [row] = hit('[SEND_EMAIL subject="hi"]x[/SEND_EMAIL]', [
      { type: 'text', text: '[SEND_EMAIL to="a@b.c"]' },
    ]);
    expect(row).toMatchObject({ marker: 'SEND_EMAIL', reason: 'no valid to', high: true });
  });

  it('does not flag short or lowercase generic tokens', () => {
    expect(hit('[OK] [ETA] [hello]')).toEqual([]);
  });

  // d6fdc1df: the generic [A-Z_]{4,} pass is GONE — a bracketed capitalised
  // word with no renderer (HARNESS evidence-guard blocks, SECRET vault
  // handles, REDACTED placeholders, IMPORTANT/TODO prose) is ordinary text,
  // not a marker that "survived renderer cleaning". Only SEND_EMAIL / CANVAS
  // / FOLLOWUPS have a renderer contract to violate.
  it('does not flag harness blocks, vault handles, redactions or prose caps (d6fdc1df)', () => {
    expect(hit('[HARNESS EVIDENCE GUARD] claims must cite receipts')).toEqual([]);
    expect(hit('[HARNESS] parked')).toEqual([]);
    expect(hit('[SECRET 3]')).toEqual([]);
    expect(hit('[REDACTED]')).toEqual([]);
    expect(hit('[REDACTED: api key]')).toEqual([]);
    expect(hit('[IMPORTANT]')).toEqual([]);
    expect(hit('[TODO]')).toEqual([]);
    expect(hit('[WIDGET]')).toEqual([]);
    expect(hit('[SEND]')).toEqual([]);
    expect(hit('[SECRET 1] [IMPORTANT] [BATCH]')).toEqual([]);
  });

  it('still flags an unclosed [SEND_EMAIL', () => {
    const [row] = hit('[SEND_EMAIL to="a@b.c"');
    expect(row).toMatchObject({ marker: 'SEND_EMAIL', reason: 'unclosed', high: true });
  });

  it('still flags a stray [/CANVAS] close with no opener', () => {
    const [row] = hit('[/CANVAS]');
    expect(row).toMatchObject({ marker: 'CANVAS', reason: 'no renderer', high: false });
  });

  it('still flags a stray [/FOLLOWUPS] close with no opener', () => {
    const [row] = hit('[/FOLLOWUPS]');
    expect(row).toMatchObject({ marker: 'FOLLOWUPS', reason: 'no renderer', high: false });
  });

  it('an unterminated SEND_EMAIL opener with no closing bracket of its own stays out of scope when the WIDGET bracket closes it (d6fdc1df)', () => {
    const found = hit('[SEND_EMAIL to="x" [WIDGET]');
    expect(found).toEqual([]);
  });

  it('strips FOLLOWUPS; a trailing WIDGET has no renderer and stays out of scope', () => {
    const found = hit('[FOLLOWUPS]body[/FOLLOWUPS][WIDGET]');
    expect(found).toEqual([]);
  });

  it('flags a stray close tag', () => {
    expect(hit('[/CANVAS]')[0]).toMatchObject({ marker: 'CANVAS', reason: 'no renderer' });
    expect(hit('[/SEND_EMAIL]')[0]).toMatchObject({ marker: 'SEND_EMAIL', reason: 'unclosed', high: false });
  });

  it('does not flag an unclosed CANVAS with no bracket', () => {
    expect(hit('[CANVAS')).toEqual([]);
  });

  // 868902f9 — INVERTED PIN. This used to assert `['CANVAS']`; the assertion
  // was itself the false positive. The renderer's THIRD canvas rule
  // (plain-session.ts:35) deletes an unterminated `[CANVAS…]` opener to
  // end-of-string, so `[CANVAS title[WIDGET]` renders as the EMPTY string —
  // the user sees nothing, so nothing "survived renderer cleaning". The
  // detector's copy of the strip was missing that rule and convicted text the
  // renderer erases; that is the defect ticket 868902f9 reported. Recall on a
  // marker a user can actually SEE is unchanged (see the DETECTOR-RECALL
  // REPLAY below, which replays the renderer itself).
  it('does not flag an unterminated CANVAS opener the renderer erases, nor the WIDGET bracket it ate (868902f9)', () => {
    expect(hit('[CANVAS title[WIDGET]')).toEqual([]);
    expect(hit('[CANVAS title[WIDGET] tail')).toEqual([]);
  });

  it('does not flag an unclosed SEND_EMAIL with no bracket followed by a later valid draft', () => {
    expect(hit('[SEND_EMAIL to="a@b.c" later [SEND_EMAIL to="b@c.d"]ok[/SEND_EMAIL]')).toEqual([]);
  });

  // DETECTOR-RECALL REPLAY (868902f9): this change makes the detector's
  // canvas strip a faithful copy of the renderer's, which can only REMOVE
  // convictions — so replay every marker the sweep was built to catch and
  // assert it still fires. Each case below pairs the detector verdict with the
  // REAL renderer output for the same text: the invariant is "flag ⟺ the user
  // can still SEE the raw marker", never "flag often". rendererShows() is the
  // frontend's own strip (plain-session.ts stripForStorage, rules 1-3 +
  // FOLLOWUPS), copied verbatim; if the renderer gains a rule, this replay
  // must learn it.
  const rendererShows = (text: string): string =>
    text
      .replace(/\[CANVAS:[^\]]+\][\s\S]*?\[\/CANVAS\]/gi, '')
      .replace(/\[CANVAS\][\s\S]*?\[\/CANVAS\]/gi, '')
      .replace(/\[CANVAS[^\]]*\][\s\S]*/gi, '')
      .replace(/\[FOLLOWUPS\][\s\S]*?\[\/FOLLOWUPS\]/gi, '')
      .replace(/\[FOLLOWUPS\][\s\S]*$/gi, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

  it('DETECTOR-RECALL REPLAY: every prior true positive still fires — the visible-marker convictions survive (868902f9)', () => {
    // True positives: text a reader really sees with the raw marker in it.
    const mustFire: Array<[string, string]> = [
      // unclosed / no-valid-to email drafts (the whole reason the sweep exists)
      ['[SEND_EMAIL to="a@b.c"', 'SEND_EMAIL'],
      ['[SEND_EMAIL subject="hi"]body[/SEND_EMAIL]', 'SEND_EMAIL'],
      ['[SEND_EMAIL to=""]body[/SEND_EMAIL]', 'SEND_EMAIL'],
      ['[SEND_EMAIL to = "a@b.c"]body[/SEND_EMAIL]', 'SEND_EMAIL'],
      // a stray closer with no opener survives on screen, so it still fires
      ['[/CANVAS]', 'CANVAS'],
      ['[/FOLLOWUPS]', 'FOLLOWUPS'],
      ['[/SEND_EMAIL]', 'SEND_EMAIL'],
      // a malformed email marker buried in prose
      ['mail me at x@y.z [SEND_EMAIL subject="x"]b[/SEND_EMAIL]', 'SEND_EMAIL'],
    ];
    for (const [text, marker] of mustFire) {
      const shown = rendererShows(text);
      // The replay's own premise: the marker IS visible after the renderer.
      expect({ text, visible: new RegExp(`\\[/?${marker}`, 'i').test(shown) }).toEqual({ text, visible: true });
      expect({ text, markers: hit(text).map((r) => r.marker) }).toEqual({ text, markers: [marker] });
    }
    // And the complement: text the renderer erases must stay out of scope, so
    // the sweep cannot refill the queue with markers no user ever saw.
    for (const text of ['[CANVAS]hidden[/CANVAS]', '[FOLLOWUPS]ask[/FOLLOWUPS]', 'the draft contains no [CANVAS] or']) {
      expect({ text, shown: rendererShows(text) }).toEqual({ text, shown: expect.not.stringMatching(/\[(\/?)(CANVAS|FOLLOWUPS)/i) });
      expect({ text, markers: hit(text).map((r) => r.marker) }).toEqual({ text, markers: [] });
    }
  });
});

describe('incomplete owner cards', () => {
  const row = (context: string | null, question = 'paste the steps below', consoleAction?: unknown) =>
    findIncompleteCards(consoleAction === undefined
      ? [{ id: 'oq_1', question, context }]
      : [{ id: 'oq_1', question, context, consoleAction }]);

  it('ignores 40 spaces', () => {
    expect(row(' '.repeat(40))).toEqual([]);
  });

  it('flags 39 characters and empty or null context', () => {
    expect(row('x'.repeat(39))[0]).toMatchObject({ questionId: 'oq_1', contextLength: 39 });
    expect(row('')[0].contextLength).toBe(0);
    expect(row(null)[0].contextLength).toBe(0);
  });

  it('ignores a short context with no cue', () => {
    expect(row('short', 'what is the status')).toEqual([]);
  });

  // Ticket 84b11946: a consoleAction card composes its four-element body —
  // ask + what/why-safe + "Paste exactly this" payload + click-by-click
  // steps — INTO the question column (owner-questions
  // composeConsoleActionBody), so its context column is empty BY DESIGN.
  // Specimen oq_2dfb9e9a: the composed body's own "Paste exactly this" /
  // "Click by click" headings matched CARD_RE and the sweep filed a
  // false-positive ticket on a card the owner answered by self-serving the
  // grant 25 minutes later.
  // Ticket 65cfec1b (the specimen 84b11946's replay test deferred here): a
  // NON-consoleAction card whose full payload rides in the question body —
  // background (what is happening / probes tried / what the state proves),
  // the exact move, typed options, even fallback "paste this output"
  // commands. Specimen oq_6c37a254: a 1418-char self-contained ask with 3
  // typed options (expectedAnswerType 'choice') the owner ANSWERED via
  // chosenOption 'restarted' 35 minutes after filing. The empty context
  // column is not a gap — nothing needed it. The sweep now applies the
  // platform's own payload-gap check (detectOwnerCardPayloadGaps, moved to
  // the shared leaf owner-card-gaps.ts): BOTH axes found — background and
  // options — ⇒ complete ⇒ no ticket. (Background alone does NOT complete a
  // card: see the "background present but NO options" pin below.)
  const SELF_CONTAINED_ASK = [
    '[raspi] Pi fleet access is ONE restart away — pass #4 (probes 10:56–11:16 PM PDT / 05:56–06:16Z) proved your grant WORKS: the home Pi is in digby-dev\'s netmap, tagged pi, online, answering at the tailnet layer.',
    'But the Pi\'s tailscaled is wedged — alive, yet silently dropping every OS-level TCP port. Both are fixed by the same 30-second move.',
    'Options:',
    '1. restarted — I run the staged read-only battery immediately.',
    '2. skip — I leave it for later.',
    '3. paste — run the fallback commands and paste the output.',
    'If it STILL fails after the restart, run these two on the Pi and paste the output: journalctl -u tailscaled and ls -l /dev/net/tun.',
  ].join('\n');

  it('skips a self-contained inline ask — background+options in the question body, context empty because nothing needed it (65cfec1b)', () => {
    expect(findIncompleteCards([{
      id: 'oq_6c37a254',
      question: SELF_CONTAINED_ASK,
      context: null,
      options: [
        { id: 'restarted', label: 'I restarted it' },
        { id: 'skip', label: 'Skip for now' },
        { id: 'paste', label: 'I pasted the output' },
      ],
    }])).toEqual([]);
  });

  it('skips on typed options alone — options present satisfies the admission even without body option cues (65cfec1b)', () => {
    expect(findIncompleteCards([{
      id: 'oq_x',
      question: 'restarted the box — paste the output below',
      context: null,
      options: [{ id: 'a', label: 'A' }],
    }])).toEqual([]);
  });

  it('skips when the context field itself carries the background — a SHORT cue-bearing context the old length rule would still flag (65cfec1b)', () => {
    // 'deploy failed' is 13 chars — under the OLD rule this card flagged
    // (context < 40); the gap check finds the background cue in the context
    // column, and 'retry or wait' supplies the options cue, so it now skips.
    expect(findIncompleteCards([{
      id: 'oq_x',
      question: 'paste the steps below',
      context: 'deploy failed; retry or wait',
    }])).toEqual([]);
  });

  it('skips when body cues alone satisfy the admission — background + option wording inline, no context column (65cfec1b)', () => {
    expect(findIncompleteCards([{
      id: 'oq_x',
      question: 'the deploy failed again — paste the output, or pick either fix',
      context: null,
    }])).toEqual([]);
  });

  it('still flags a card the admission rules incomplete — background present but NO options anywhere (65cfec1b)', () => {
    // Full alignment: the sweep fires exactly when the platform's own
    // write-time admission finds a gap. Background alone does not complete a
    // card (the owner's inline-payload directive requires options too) — the
    // write-time metric owner_card_payload_incomplete records the same gap.
    expect(findIncompleteCards([{
      id: 'oq_x',
      question: 'the deploy failed — paste the output below',
      context: null,
    }])[0]).toMatchObject({ questionId: 'oq_x', contextLength: 0 });
  });

  it('DETECTOR-RECALL REPLAY (65cfec1b): prior true positives with NO background cue still fire', () => {
    // The classic TP: cue word, short context, no background anywhere in
    // question or context, no options. The admission rules background
    // missing ⇒ the sweep flag survives.
    expect(findIncompleteCards([{ id: 'oq_x', question: 'paste the steps below', context: 'x'.repeat(39) }])[0])
      .toMatchObject({ questionId: 'oq_x', contextLength: 39 });
    expect(findIncompleteCards([{ id: 'oq_y', question: 'restart tailscaled then paste the output', context: null }])[0])
      .toMatchObject({ questionId: 'oq_y', contextLength: 0 });
    expect(findIncompleteCards([{ id: 'oq_z', question: 'paste the output below', context: ' ' }])[0])
      .toMatchObject({ questionId: 'oq_z', contextLength: 1 });
  });

  it('DETECTOR-RECALL REPLAY (65cfec1b): null consoleAction column on a bare ask still flags (84b11946 pin carries)', () => {
    expect(row(null, 'paste the steps below', null)[0]).toMatchObject({ questionId: 'oq_1', contextLength: 0 });
  });

  it('skips consoleAction cards — payload+steps ride in the question, context is empty by design (84b11946)', () => {
    const composed = [
      '[raspi] Pi access grant: save this ONE line in Tailscale admin → Access Controls.',
      '',
      "**What this does + why it's safe:** Lets only the digby-dev sandbox tag reach SSH.",
      '',
      '**Do this in Tailscale admin console — https://login.tailscale.com/admin/acls**',
      '',
      '**Paste exactly this (Tailscale admin console):**',
      '',
      '```json',
      '{"action":"accept","src":["tag:digby-dev"],"dst":["tag:tagged-devices:22"]}',
      '```',
      '',
      '**Click by click:**',
      '1. Open the Access Controls page.',
      '2. Find the "acls" array.',
      '3. Paste the JSON line as a new entry.',
      '4. Click Save.',
    ].join('\n');
    expect(findIncompleteCards([{
      id: 'oq_2dfb9e9a',
      question: composed,
      context: null,
      consoleAction: {
        consoleName: 'Tailscale admin console',
        consoleUrl: 'https://login.tailscale.com/admin/acls',
        whatAndWhySafe: 'read-only sandbox reach',
        steps: ['Open the Access Controls page.', 'Click Save.'],
      },
    }])).toEqual([]);
  });

  it('treats a null consoleAction column as absent — a non-console card still flags (84b11946)', () => {
    // The Prisma column is nullable: non-consoleAction cards store NULL, and
    // rows selected with the column may read null — only a PRESENT spec skips.
    expect(row(null, 'paste the steps below', null)[0]).toMatchObject({ questionId: 'oq_1', contextLength: 0 });
  });

  // DETECTOR-RECALL REPLAY (ticket 84b11946): the consoleAction skip is a
  // precision fix, not a recall relaxation — replay the detector's PRIOR true
  // positives (the convicting cases above, verbatim shapes) and assert they
  // STILL fire: cue + short context, empty context, null context.
  it('DETECTOR-RECALL REPLAY: prior true positives still fire — 39-char context, empty context, null context, hand-authored paste ask', () => {
    expect(row('x'.repeat(39))[0]).toMatchObject({ questionId: 'oq_1', contextLength: 39 });
    expect(row('')[0]).toMatchObject({ questionId: 'oq_1', contextLength: 0 });
    expect(row(null)[0]).toMatchObject({ questionId: 'oq_1', contextLength: 0 });
    // A HAND-AUTHORED bare ask that mentions a paste with no context at all
    // still flags under BOTH rules: the 84b11946 skip (no consoleAction) and
    // the 65cfec1b gap gate (no background cue, no options anywhere). The
    // LIVE oq_6c37a254 specimen — a full background+options body — is the
    // 65cfec1b skip case pinned above; this bare shape remains the TP.
    expect(findIncompleteCards([{ id: 'oq_x', question: 'restart tailscaled then paste the output', context: null }])[0])
      .toMatchObject({ questionId: 'oq_x', contextLength: 0 });
  });

  // ── Ticket cea10fa4: the explicitly-optional ask. Specimen
  // oq_2d874126 (live row, prod probe 2026-10-19, deployed admission
  // verdict ["options"]): a 1170-char self-contained credential ask —
  // background (gateway live / what's working / what's dark), the exact
  // ask ("paste the key(s) here — any subset is fine"), and a stated
  // decline path ("No rush — the core service is fully live without
  // them"). The options axis is satisfied by the optionality wording
  // itself (detectOwnerCardPayloadGaps, the shared seam): a card that
  // names its own decline path spells out the complete two-outcome
  // decision space in prose. Third FP in the family: 84b11946 (PR #1738,
  // consoleAction) → 65cfec1b (PR #1743, inline background+options) →
  // here. 7-day live census at fix time: exactly 1 detector hit in 83
  // cards — this one; zero true positives in the family's wild history.
  it('skips an explicitly-optional inline ask — the decline path completes the options axis (cea10fa4)', () => {
    const ask = [
      '[ctrl.example.com] Lab gateway is LIVE and public — 5 provider keys are missing on amd-1, so their routes return 401 until you paste them',
      '',
      "The r-2 replacement is live: the LiteLLM gateway now runs on amd-server-1 in the StAnnes lab behind Cloudflare tunnel stanne-lab-amd1, in the CQL Cloudflare account. Public health checks pass from off-box, and the flagship routes answer end-to-end through the public edge.",
      '',
      "What's working: every route whose provider key we already held — XAI, OpenAI, Alibaba (×2), ZAI, Moonshot (×2) — 7 keys mapped onto the box.",
      '',
      "What's dark: routes backed by keys we don't hold — ANTHROPIC, FIREWORKS, ZAI_CODING, XIAOMI_MIMO, STANNE_*. Those models still list in /v1/models (roster shows 51) but return 401 at request time until a real key lands on amd-1.",
      '',
      "If you want them restored: paste the key(s) here — any subset is fine. Each paste is stored encrypted (never echoed back) and my lane places it on the box and reloads the gateway; routes come back one by one as keys land. No rush — the core service is fully live without them.",
    ].join('\n');
    expect(findIncompleteCards([{ id: 'oq_2d874126', question: ask, context: null }])).toEqual([]);
  });

  it('skips short optional asks — optionality wording alone, cue word present, no typed options (cea10fa4)', () => {
    expect(findIncompleteCards([{
      id: 'oq_x', question: 'the deploy lane is idle — restart the box at your convenience, or paste the output if it fails', context: null,
    }])).toEqual([]);
    expect(findIncompleteCards([{
      id: 'oq_y', question: 'paste the key below if you want the route restored — no need otherwise', context: 'route 401 since 03:00Z',
    }])).toEqual([]);
  });

  it('still flags an URGENT paste ask with no optionality wording — a negated dependence is not a decline path (cea10fa4)', () => {
    // "cannot work without" asserts URGENCY — the decline-path guards keep
    // this conviction firing.
    expect(findIncompleteCards([{
      id: 'oq_y', question: 'the lab box cannot work without the key — paste it below', context: 'x'.repeat(20),
    }])[0]).toMatchObject({ questionId: 'oq_y', contextLength: 20 });
    // A bare urgent ask with no cues anywhere still flags.
    expect(findIncompleteCards([{
      id: 'oq_z', question: 'the deploy failed — paste the output below', context: null,
    }])[0]).toMatchObject({ questionId: 'oq_z', contextLength: 0 });
  });

  it('DETECTOR-RECALL REPLAY (cea10fa4): prior true positives still fire after the optionality leg', () => {
    // The 65cfec1b convictions verbatim — background present but no options
    // anywhere (no typed options, no option cue, NO optionality wording).
    expect(findIncompleteCards([{
      id: 'oq_x', question: 'the deploy failed — paste the output below', context: null,
    }])[0]).toMatchObject({ questionId: 'oq_x', contextLength: 0 });
    // The classic TPs: cue + short/null context, no background, no options.
    expect(findIncompleteCards([{ id: 'oq_x', question: 'paste the steps below', context: 'x'.repeat(39) }])[0])
      .toMatchObject({ questionId: 'oq_x', contextLength: 39 });
    expect(findIncompleteCards([{ id: 'oq_y', question: 'restart tailscaled then paste the output', context: null }])[0])
      .toMatchObject({ questionId: 'oq_y', contextLength: 0 });
    expect(row(null, 'paste the steps below', null)[0]).toMatchObject({ questionId: 'oq_1', contextLength: 0 });
  });

  // ── Ticket 90a5b127: options-axis precision — non-adjacent negation,
  // unscoped optionality cues, and the structural legs. Every case below
  // was executed against the PRE-FIX leaf first (the ticket's own
  // reproduction, tmp/90a5b127-repro.ts): the 1.1/1.2 cases wrongly
  // completed the options axis; the 2.1 cases wrongly gapped.
  it('flags a negated dependence whose negation is NOT adjacent to the cue (90a5b127 1.1)', () => {
    // background cue present ('deploy'/'fleet'/'route' are background words),
    // so the ONLY live axis is options — these must flag on it.
    expect(findIncompleteCards([{
      id: 'oq_a', question: 'the deploy will not be fine without the api key - paste it', context: null,
    }])[0]).toMatchObject({ questionId: 'oq_a', contextLength: 0 });
    expect(findIncompleteCards([{
      id: 'oq_b', question: 'the fleet never works without the credential - paste it', context: null,
    }])[0]).toMatchObject({ questionId: 'oq_b', contextLength: 0 });
    expect(findIncompleteCards([{
      id: 'oq_c', question: "the worker isn't going to work without the token - paste it", context: null,
    }])[0]).toMatchObject({ questionId: 'oq_c', contextLength: 0 });
    expect(findIncompleteCards([{
      id: 'oq_d', question: 'the route no longer works without the key - paste it', context: null,
    }])[0]).toMatchObject({ questionId: 'oq_d', contextLength: 0 });
    expect(findIncompleteCards([{
      id: 'oq_e', question: 'does the app work without the key? paste it', context: null,
    }])[0]).toMatchObject({ questionId: 'oq_e', contextLength: 0 });
  });

  it('flags optionality wording that does NOT govern the ask (90a5b127 1.2)', () => {
    expect(findIncompleteCards([{
      id: 'oq_f', question: 'if you want the fix to work, paste the env file', context: null,
    }])[0]).toMatchObject({ questionId: 'oq_f', contextLength: 0 });
    expect(findIncompleteCards([{
      id: 'oq_g', question: 'there is no need to worry - paste the private key now', context: null,
    }])[0]).toMatchObject({ questionId: 'oq_g', contextLength: 0 });
    expect(findIncompleteCards([{
      id: 'oq_h', question: 'feel free to ignore this, but paste the recovery key immediately', context: null,
    }])[0]).toMatchObject({ questionId: 'oq_h', contextLength: 0 });
  });

  it('skips the genuinely-optional asks the wording chase missed (90a5b127 2.1)', () => {
    // Each card carries a background cue ('deploy'/'box'/'run'/'lane') the
    // way real optional asks do — the pinned axis is OPTIONS, which the
    // pre-fix wording-chased cue list wrongly gapped.
    expect(findIncompleteCards([{
      id: 'oq_i', question: "the deploy lane is idle - paste the output whenever you're ready", context: null,
    }])).toEqual([]);
    expect(findIncompleteCards([{
      id: 'oq_j', question: 'restart the box at your discretion', context: null,
    }])).toEqual([]);
    expect(findIncompleteCards([{
      id: 'oq_k', question: 'no obligation, but paste the run log if you can', context: null,
    }])).toEqual([]);
    expect(findIncompleteCards([{
      id: 'oq_l', question: 'the box is idle - paste the output when convenient', context: null,
    }])).toEqual([]);
  });

  it('applies the flagger\'s typed optionalAsk declaration at the sweep (90a5b127 structural)', () => {
    // declared optional → complete on the options axis even with no
    // optionality wording at all ('deploy' carries the background axis).
    expect(findIncompleteCards([{
      id: 'oq_m', question: 'the deploy routes are 401 without the api key - paste it', context: null, optionalAsk: true,
    }])).toEqual([]);
    // declared NOT optional → the prose fallback is suppressed (this card
    // would otherwise skip via its "no rush" wording).
    expect(findIncompleteCards([{
      id: 'oq_n', question: 'no rush - paste the key', context: null, optionalAsk: false,
    }])[0]).toMatchObject({ questionId: 'oq_n', contextLength: 0 });
    // a yes_no declaration completes the options axis.
    expect(findIncompleteCards([{
      id: 'oq_o', question: 'should i proceed with the rollback? background: the deploy failed', context: null, expectedAnswerType: 'yes_no',
    }])).toEqual([]);
    // a credential declaration does NOT complete it.
    expect(findIncompleteCards([{
      id: 'oq_p', question: 'paste the deploy key now', context: 'the deploy is failing', expectedAnswerType: 'credential:DEPLOY_KEY',
    }])[0]).toMatchObject({ questionId: 'oq_p', contextLength: 21 });
  });

  it('DETECTOR-RECALL REPLAY (90a5b127): every prior conviction and skip pin in this describe block still holds', () => {
    // The prior replay's four convictions (65cfec1b/84b11946), verbatim.
    expect(row('x'.repeat(39))[0]).toMatchObject({ questionId: 'oq_1', contextLength: 39 });
    expect(row('')[0]).toMatchObject({ questionId: 'oq_1', contextLength: 0 });
    expect(row(null, 'paste the steps below', null)[0]).toMatchObject({ questionId: 'oq_1', contextLength: 0 });
    expect(findIncompleteCards([{ id: 'oq_x', question: 'restart tailscaled then paste the output', context: null }])[0])
      .toMatchObject({ questionId: 'oq_x', contextLength: 0 });
    // The cea10fa4 conviction (negated dependence) and skip pins.
    expect(findIncompleteCards([{
      id: 'oq_y', question: 'the lab box cannot work without the key — paste it below', context: 'x'.repeat(20),
    }])[0]).toMatchObject({ questionId: 'oq_y', contextLength: 20 });
    expect(findIncompleteCards([{
      id: 'oq_z', question: 'paste the key below if you want the route restored — no need otherwise', context: 'route 401 since 03:00Z',
    }])).toEqual([]);
    expect(findIncompleteCards([{
      id: 'oq_w', question: 'the deploy lane is idle — restart the box at your convenience, or paste the output if it fails', context: null,
    }])).toEqual([]);
  });

  // ── Ticket a3a7dd88: STRUCTURE completes the BACKGROUND axis. Specimen
  // oq_892c91ae (live row, prod probe 2026-10-20, current-main verdict
  // gaps ["background"]): a 1163-char self-contained [ctrl.example.com] choice
  // card — CanLaw live on r-0, Hyperstack floating IP, S3/mail keys — with
  // 4 typed options carrying consequences, expectedAnswerType 'choice',
  // context empty because the whole card rides inline. The owner DISMISSED
  // it (a ruling was made) 16 minutes after filing. Its background is
  // written in domain vocabulary the 65cfec1b cue-list cannot enumerate —
  // the flagger's typed options are the structural signal that the
  // surrounding state is present. Fifth FP in the family
  // (84b11946 → 65cfec1b → cea10fa4 → 90a5b127 → here), every one a
  // vocabulary-chase class; 7-day census at fix time: 87 cards, 2 flagged
  // by the deployed detector — both in this fix's delta class, the two
  // ctrl.example.com typed-options choice asks (this specimen + its post-ruling
  // successor oq_fe4b8b94); zero true positives lost.
  it('skips a typed-options choice card whose background is domain vocabulary (a3a7dd88)', () => {
    const ask = [
      "[ctrl.example.com] CanLaw is LIVE on r-0, tailnet-only — verified 23:31Z from amd-2 (V2_LOCAL_VERIFIED: site, v2 board, bench UI all green) and all 5 provider keys placed (zai legs 200 exact-echo). Four finishing items, one card:",
      '1. NEW floating IP for r-0 — Hyperstack console → rutherford-0 → attach/buy a floating IP (the account hit $0 and released ALL public IPs; the old ones incl. 203.0.113.12 now belong to strangers, so nothing old can be reused). Without one, canlegalbench.com cannot come back publicly. Once it exists I do DNS (the CQL Cloudflare token holds the zone), SSL Full(strict) and the /api/notify* rate-limit rule myself.',
      '2. Read-only S3 key for the CanLaw bucket (~0.48TB checkpoints/packs) — unfreezes corpus recovery. Paste it here; it vaults automatically.',
      '3. Backup target: the handoff recommends the amd-1 backup disk — OK?',
      '4. Mail values for /etc/canlegalbench/web.env (MAIL_* + NOTIFY_ENC_KEY — also copy NOTIFY_ENC_KEY into your password manager). The site serves, but sign-ups 503 until then. Paste them here; they vault.',
      'Already done with nothing needed from you: tailnet ACL (was open), HTTPS certificates, TS_PERMIT_CERT_UID=caddy.',
    ].join('\n');
    expect(findIncompleteCards([{
      id: 'oq_892c91ae',
      question: ask,
      context: null,
      options: [
        { id: 'all', label: "All four — I'll attach the IP and paste both key sets", consequence: 'CanLaw fully finished: public bring-back + corpus recovery + working sign-ups' },
        { id: 'ip-only', label: 'Just the floating IP (public bring-back); keys later', consequence: 'canlegalbench.com comes back publicly; sign-ups stay 503 and corpus stays frozen' },
        { id: 'keys-only', label: 'Stay tailnet-only for now; I\'ll paste the S3 + mail keys', consequence: 'Corpus recovery unfreezes and sign-ups work; site stays tailnet-only' },
        { id: 'defer', label: 'Defer everything — tailnet-only is fine for now', consequence: 'Site keeps working tailnet-only; sign-ups stay 503; corpus stays frozen; no public canlegalbench.com' },
      ],
      expectedAnswerType: 'choice',
    }])).toEqual([]);
  });

  it('typed options also complete a BARE cue-word ask — structure beats vocabulary on both axes (a3a7dd88)', () => {
    // The degenerate shape the review will probe: cue-word ask, typed
    // options, no background cue, no context. The 65cfec1b pin already
    // treats typed options as completing the OPTIONS axis unconditionally;
    // a3a7dd88 extends the same authority to the background axis — one
    // structural signal, both axes. 7-day census at fix time: zero cards of
    // this shape; the family's entire history is 5 FPs, 0 TPs, so precision
    // is the safe direction (the owner still sees and can dismiss the card;
    // only the sweep ticket is suppressed).
    expect(findIncompleteCards([{
      id: 'oq_x', question: 'paste the steps below', context: null,
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    }])).toEqual([]);
  });

  it('DETECTOR-RECALL REPLAY (a3a7dd88): every prior conviction still fires — they all lack typed options', () => {
    // The classic TPs, verbatim, with NO typed options — the fix's structural
    // leg never touches them: bare cue ask + 39-char context, bare ask +
    // null context, hand-authored paste ask, null-consoleAction column.
    expect(findIncompleteCards([{ id: 'oq_x', question: 'paste the steps below', context: 'x'.repeat(39) }])[0])
      .toMatchObject({ questionId: 'oq_x', contextLength: 39 });
    expect(findIncompleteCards([{ id: 'oq_y', question: 'restart tailscaled then paste the output', context: null }])[0])
      .toMatchObject({ questionId: 'oq_y', contextLength: 0 });
    expect(row(null, 'paste the steps below', null)[0]).toMatchObject({ questionId: 'oq_1', contextLength: 0 });
    // The 65cfec1b conviction WITH typed options added: background cue
    // present ('deploy'), so this shape already skipped pre-a3a7dd88 (the
    // options axis) and must keep skipping (now via both axes).
    expect(findIncompleteCards([{
      id: 'oq_w', question: 'the deploy failed — paste the output below', context: null,
      options: [{ id: 'retry', label: 'Retry' }, { id: 'wait', label: 'Wait' }],
    }])).toEqual([]);
  });

  // ── Ticket 8f5989c7: the card's own SCOPE statement completes the
  // options axis. Specimen oq_81ce2c39 (live row, prod probe 2026-10-23,
  // deployed admission verdict ["options"], probe on box A): a 792-char
  // self-contained [cql-agx-orin64] credential ask quoted VERBATIM below —
  // background (Hue power cycle worked, box rebooted 03:58Z, memory leak
  // uncontained, froze twice), the measured blocker ("sudo: a password is
  // required" 01:00Z and 04:03Z), the exact move (paste into the card's
  // credential field → encrypted vault → containment cap over SSH → verify
  // → safe rollback) and the closing scope statement "Nothing else is
  // needed from you." The lane superseded the card itself 52 min after
  // filing (supersededBy oq_63f66cd0, dismissed 05:02:35Z). "One thing
  // only you can supply" + "Nothing else is needed from you" = an
  // ENUMERATED ask with an empty decision space — there is nothing to
  // choose between. Sixth FP in the family
  // (84b11946 → 65cfec1b → cea10fa4 → 90a5b127 → a3a7dd88 → here); 7-day
  // census at fix time (123 cards, prod probe): exactly 1 detector hit =
  // this specimen, 0 after the fix; zero true positives in the family's
  // wild history.
  it('skips an enumerated single-action ask — the scope statement completes the options axis (8f5989c7)', () => {
    const ask = [
      '[cql-agx-orin64] One thing only you can supply: the pcozz sudo password on the AGX. Your Hue power cycle worked — the box rebooted 03:58Z and is healthy (23.6 GiB RAM free, embed + rerank serving) — but the memory leak is uncontained and will re-wedge the box within hours (it froze twice tonight). The lane tried to apply the fix itself per your "you have shell access" reply, but sudo on the AGX requires a password — measured twice tonight: "sudo: a password is required" (01:00Z and 04:03Z). Paste the pcozz password into this card\u2019s credential field; it goes straight to the encrypted vault (never into any chat) and the lane applies the containment cap (44G/48G + auto-restart) over SSH within minutes, verifies, and rolls back safely if anything fails. Nothing else is needed from you.',
    ].join('\n');
    expect(findIncompleteCards([{ id: 'oq_81ce2c39', question: ask, context: null }])).toEqual([]);
  });

  it('skips short scope-statement asks — the cue alone completes an urgent single-action ask (8f5989c7)', () => {
    expect(findIncompleteCards([{
      id: 'oq_x', question: 'the box is wedged — paste the api key to restore the route, that is all', context: null,
    }])).toEqual([]);
    expect(findIncompleteCards([{
      id: 'oq_y', question: 'the deploy is red — paste the runner log, nothing else is needed', context: null,
    }])).toEqual([]);
    // The scope cue in the CONTEXT column completes too (both columns feed
    // the admission, the 65cfec1b seam).
    expect(findIncompleteCards([{
      id: 'oq_z', question: 'restart the box and paste the output below', context: 'box wedged since 03:00Z; no further action',
    }])).toEqual([]);
  });

  it('still flags near-miss wording the scope cue must NOT complete (8f5989c7 precision)', () => {
    // "needed" governed by a WITHHOLDING clause, not a scope statement —
    // the ticket asks for two things and enumerates neither.
    expect(findIncompleteCards([{
      id: 'oq_a', question: 'the api key is needed to restore the route - paste it', context: null,
    }])[0]).toMatchObject({ questionId: 'oq_a', contextLength: 0 });
    // "nothing else" naming what was DONE, not what is asked — the ask
    // ("review the plan") carries no scope statement.
    expect(findIncompleteCards([{
      id: 'oq_b', question: 'the deploy failed - paste the steps, i tried nothing else', context: null,
    }])[0]).toMatchObject({ questionId: 'oq_b', contextLength: 0 });
    // No scope statement at all: the classic TP shape stays convicted.
    expect(findIncompleteCards([{
      id: 'oq_c', question: 'the deploy failed — paste the output below', context: null,
    }])[0]).toMatchObject({ questionId: 'oq_c', contextLength: 0 });
    // ── Review 2026-10-23 (blocking findings): the scope cue is judged
    // CLAUSE-SCOPED with tail guards — a cue phrase inside a clause that
    // re-scopes it to HISTORY or a FOREIGN ACTOR is not a scope
    // declaration, the same clause discipline 90a5b127 imposed on the
    // optionality cues.
    // HISTORY tail: what already happened, not the ask's extent.
    expect(findIncompleteCards([{
      id: 'oq_e', question: 'the box froze twice — paste the journal log; no further action was taken', context: null,
    }])[0]).toMatchObject({ questionId: 'oq_e', contextLength: 0 });
    expect(findIncompleteCards([{
      id: 'oq_f', question: 'the deploy failed — paste the output below; nothing else was tried before the upgrade', context: null,
    }])[0]).toMatchObject({ questionId: 'oq_f', contextLength: 0 });
    // FOREIGN-ACTOR tail: another actor's narration of their own limits.
    expect(findIncompleteCards([{
      id: 'oq_g', question: 'the fleet is red — paste the worker log; that is all we could do from here', context: null,
    }])[0]).toMatchObject({ questionId: 'oq_g', contextLength: 0 });
    // INTERROGATIVE lead: the question itself is the ask, never a scope
    // declaration ("is that all you need?" asks, it does not declare).
    expect(findIncompleteCards([{
      id: 'oq_h', question: 'is that all? the deploy is red — paste the steps below', context: null,
    }])[0]).toMatchObject({ questionId: 'oq_h', contextLength: 0 });
  });

  // ── Cross-review round 2 (2026-10-23, self-audit): clause-scoping alone
  // is not ASK-scoping — one scope clause must not silence a card that
  // goes on to ask something further. Every case below was measured
  // SUPPRESSED by the clause-scoped-only cut; all must flag.
  it('still flags when a scope statement does not CLOSE the ask — object-restricted cues and still-owed state (8f5989c7 round 2)', () => {
    // Contrastive follow-up ask after an object-restricted cue — the
    // 90a5b127 cross-review finding-2 shape.
    expect(findIncompleteCards([{
      id: 'oq_r1', question: 'No further action is needed on the deploy, but the S3 key is still missing — paste it below', context: null,
    }])[0]).toMatchObject({ questionId: 'oq_r1', contextLength: 0 });
    // Scope about a DIFFERENT object (a PR), ask follows.
    expect(findIncompleteCards([{
      id: 'oq_r2', question: 'the deploy is red — no further action needed on PR #1905; paste the runner log below', context: null,
    }])[0]).toMatchObject({ questionId: 'oq_r2', contextLength: 0 });
    // Scope on sentence 1, follow-up ask on sentence 2.
    expect(findIncompleteCards([{
      id: 'oq_r3', question: 'Nothing else is needed from you for the deploy. Now paste the S3 key below.', context: null,
    }])[0]).toMatchObject({ questionId: 'oq_r3', contextLength: 0 });
    // Owed state after the scope statement — the most likely GENUINE
    // incomplete card.
    expect(findIncompleteCards([{
      id: 'oq_r4', question: 'Nothing else is needed from you on the box. Two keys are still owed: paste them below.', context: null,
    }])[0]).toMatchObject({ questionId: 'oq_r4', contextLength: 0 });
  });

  it('still flags tense, actor-narration and conditional scope cues (8f5989c7 round 2 guards)', () => {
    // Past tense inside the cue phrase — history, not a present declaration.
    expect(findIncompleteCards([{
      id: 'oq_r5', question: 'the box is wedged — nothing else was needed yesterday; paste the journal log', context: null,
    }])[0]).toMatchObject({ questionId: 'oq_r5', contextLength: 0 });
    // Actor narration of the lane's own limits ("we know", not "you supply").
    expect(findIncompleteCards([{
      id: 'oq_r6', question: 'the deploy is red — that is all we know; paste the runner log', context: null,
    }])[0]).toMatchObject({ questionId: 'oq_r6', contextLength: 0 });
    // Future tense + actor — a prediction, not the ask's extent.
    expect(findIncompleteCards([{
      id: 'oq_r7', question: 'the box is wedged — nothing else will be needed by the lane; paste the log below', context: null,
    }])[0]).toMatchObject({ questionId: 'oq_r7', contextLength: 0 });
    // Conditional lead — never a declaration (90a5b127 finding 1.2).
    expect(findIncompleteCards([{
      id: 'oq_r8', question: 'the deploy is red — if nothing else is needed ignore this, otherwise paste the steps below', context: null,
    }])[0]).toMatchObject({ questionId: 'oq_r8', contextLength: 0 });
    // "was possible" — a limitation narration, not a scope statement.
    expect(findIncompleteCards([{
      id: 'oq_r9', question: 'the deploy is red; no further action was possible — paste the runner log below', context: null,
    }])[0]).toMatchObject({ questionId: 'oq_r9', contextLength: 0 });
  });

  it('the specimen\u2019s own governed tails still complete — "you can supply" is the ask\u2019s actor, not a foreign one (8f5989c7)', () => {
    // "One thing only you can supply: the password" — the tail names the
    // OWNER (the ask's own actor) with a present-capability verb; the
    // foreign-actor guard rejects only past/limitation modals
    // (could/did/tried/managed), never 'can supply'.
    expect(findIncompleteCards([{
      id: 'oq_i', question: 'the box is wedged — one thing only you can supply: the sudo password. Paste it below.', context: null,
    }])).toEqual([]);
    // "nothing else is needed from you" — 'from you' is the ask's own
    // actor, not a foreign one.
    expect(findIncompleteCards([{
      id: 'oq_j', question: 'the box is wedged — paste the sudo password; nothing else is needed from you.', context: null,
    }])).toEqual([]);
  });

  it('a scope-statement ask declared NOT optional still flags — typed beats prose (8f5989c7)', () => {
    expect(findIncompleteCards([{
      id: 'oq_d', question: 'nothing else is needed - paste the recovery key', context: null, optionalAsk: false,
    }])[0]).toMatchObject({ questionId: 'oq_d', contextLength: 0 });
  });

  it('DETECTOR-RECALL REPLAY (8f5989c7): every prior conviction and skip pin still holds', () => {
    // The classic TPs, verbatim — none carries a scope statement.
    expect(findIncompleteCards([{ id: 'oq_x', question: 'paste the steps below', context: 'x'.repeat(39) }])[0])
      .toMatchObject({ questionId: 'oq_x', contextLength: 39 });
    expect(findIncompleteCards([{ id: 'oq_y', question: 'restart tailscaled then paste the output', context: null }])[0])
      .toMatchObject({ questionId: 'oq_y', contextLength: 0 });
    expect(row(null, 'paste the steps below', null)[0]).toMatchObject({ questionId: 'oq_1', contextLength: 0 });
    // The 65cfec1b conviction: background present, no options anywhere, no
    // scope statement.
    expect(findIncompleteCards([{
      id: 'oq_z', question: 'the deploy failed — paste the output below', context: null,
    }])[0]).toMatchObject({ questionId: 'oq_z', contextLength: 0 });
    // The 90a5b127 conviction: a credential DECLARATION with no scope
    // statement stays gapped (the declaration alone must not complete).
    expect(findIncompleteCards([{
      id: 'oq_p', question: 'paste the deploy key now', context: 'the deploy is failing', expectedAnswerType: 'credential:DEPLOY_KEY',
    }])[0]).toMatchObject({ questionId: 'oq_p', contextLength: 21 });
    // The cea10fa4 skip pins stay skips (they complete via optionality
    // wording before the scope leg is ever reached).
    expect(findIncompleteCards([{
      id: 'oq_w', question: 'the deploy lane is idle — restart the box at your convenience, or paste the output if it fails', context: null,
    }])).toEqual([]);
    expect(findIncompleteCards([{
      id: 'q_skip', question: 'paste the key below if you want the route restored — no need otherwise', context: 'route 401 since 03:00Z',
    }])).toEqual([]);
    // The 90a5b127 skip pins (posture-governed asks) stay skips.
    expect(findIncompleteCards([{
      id: 'oq_j', question: 'restart the box at your discretion', context: null,
    }])).toEqual([]);
    expect(findIncompleteCards([{
      id: 'oq_l', question: 'the box is idle - paste the output when convenient', context: null,
    }])).toEqual([]);
    // The a3a7dd88 typed-options pins stay skips.
    expect(findIncompleteCards([{
      id: 'oq_t', question: 'paste the steps below', context: null,
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    }])).toEqual([]);
  });
});

describe('owner frustration', () => {
  const user = {
    id: 'u1',
    chatId: 'c1',
    content: "this is still broken and you didn't give me the steps",
    createdAt: '2026-10-16T02:00:00Z',
  };

  it('pairs the newest preceding assistant', () => {
    const [row] = findOwnerFrustration([user], [
      { id: 'a-old', chatId: 'c1', content: 'older', createdAt: '2026-10-16T00:00:00Z' },
      { id: 'a-new', chatId: 'c1', content: 'newer', createdAt: '2026-10-16T01:00:00Z' },
      { id: 'a-after', chatId: 'c1', content: 'after', createdAt: '2026-10-16T03:00:00Z' },
    ]);
    expect(row.assistantMessageId).toBe('a-new');
    expect(row.userMessageId).toBe('u1');
  });

  it('redacts secrets in the excerpt with the SHARED scanner, not a 3-pattern filter (review of #1656)', () => {
    // A GitHub token and a Z.ai id.secret key — neither matches the old sk- / Bearer / key= trio.
    const leak = 'this is still broken, here is my token ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8 and zai 0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp';
    const [row] = findOwnerFrustration([{ ...user, content: leak }], []);
    expect(row.excerpt).not.toContain('ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');
  });

  it('leaves the assistant empty when none precedes', () => {
    const [row] = findOwnerFrustration([user], []);
    expect(row.assistantMessageId).toBeNull();
  });

  it('ignores a calm admin message', () => {
    expect(findOwnerFrustration([{ ...user, content: 'thanks, that worked' }], [])).toEqual([]);
  });

  // ── e7c533d3: machine-sent "user" rows are not the owner ───────────────────
  // Prod evidence (2026-10-18, read-only probe): the sweep flagged Fleet
  // Supervisor wake 3c0024eb (metadata {origin:'schedule', machineMessage:true})
  // because 'frustrat' matched at offset 6491 inside the [SUPERVISOR STATE]
  // block — quoting the sweep's OWN ticket titles ("Missed bug: owner
  // frustration in chat daee2916") back at it. 24h window: 10/10 regex matches
  // were machine rows (schedule/hook/agent), 0 human. A ticket flood class.

  it('ignores a scheduled machine wake whose supervisor-state block quotes frustration ticket titles (e7c533d3)', () => {
    const wake = {
      ...user,
      id: '3c0024eb',
      content:
        '[MACHINE-TRIGGERED RUN — no user is on this turn. Current time: 2026-10-18T06:16:39.538Z — this is the ONLY trustworthy clock; never reconstruct times or dates from earlier notes.]\n' +
        '[FRESHNESS CONTRACT — mandatory:]\n1. Cite NO fleet state from memory.\n' +
        '…\n' +
        '[SUPERVISOR STATE — your durable memory]\n' +
        'Tickets: 2d9589c8 "Missed bug: owner frustration in chat daee2916" filed open; 84b11946 "Incomplete owner card oq_2dfb9" filed open\n',
      metadata: { origin: 'schedule', machineMessage: '…' },
    };
    expect(findOwnerFrustration([wake], [])).toEqual([]);
  });

  it('ignores a hook wake even with no origin stamp (content prefix is enough — mapStoredMessages dropped origins)', () => {
    const wake = {
      ...user,
      id: 'bc0aeed5',
      content: '[MACHINE-TRIGGERED RUN — no user is on this turn. Current time: 2026-10-18T10:14:55.094Z — …]\nwhy do I have to keep re-filing this?',
      // no metadata at all — the frontend pick-list class
    };
    expect(findOwnerFrustration([wake], [])).toEqual([]);
  });

  it('ignores an agent-sent relay quoting the owner (e7c533d3 sibling: [AGENT-SENT MESSAGE] row, origin agent)', () => {
    const relay = {
      ...user,
      id: 'b0ef1351',
      content:
        '[AGENT-SENT MESSAGE — from another Digby agent chat (id unknown), another Digby agent, NOT the owner. …]\n' +
        'Owner said this is still broken in the deploy pipeline.',
      metadata: { origin: 'agent' },
    };
    expect(findOwnerFrustration([relay], [])).toEqual([]);
  });

  it('ignores agent-sent relays on every machine origin stamp', () => {
    for (const origin of ['schedule', 'hook', 'machine', 'agent', 'webhook']) {
      const row = { ...user, content: 'this is still broken, so frustrating', metadata: { origin } };
      expect(findOwnerFrustration([row], [])).toEqual([]);
    }
  });

  it('still flags the OWNER typing frustration with no machine stamp (a genuine human hit is never suppressed)', () => {
    const human = { ...user, content: 'this is still broken and it is so annoying', metadata: undefined };
    expect(findOwnerFrustration([human], [])).toHaveLength(1);
  });

  it('still flags the owner whose message merely QUOTES a wake mid-string (mid-string prefixes are not machine rows)', () => {
    const human = {
      ...user,
      content:
        'You keep sending me "[MACHINE-TRIGGERED RUN — …]" walls and this is still broken. Fix it.',
    };
    const [row] = findOwnerFrustration([human], []);
    expect(row.userMessageId).toBe('u1');
  });

  it('DETECTOR-RECALL REPLAY: prior true positives still fire — the original 2026-10-16 human frustration turn, and a human row with metadata but no origin', () => {
    // The pre-e7c533d3 suite's canonical true positive, verbatim.
    const [row] = findOwnerFrustration(
      [{ id: 'u1', chatId: 'c1', content: "this is still broken and you didn't give me the steps", createdAt: '2026-10-16T02:00:00Z' }],
      [{ id: 'a1', chatId: 'c1', content: 'older', createdAt: '2026-10-16T01:00:00Z' }],
    );
    expect(row).toMatchObject({ userMessageId: 'u1', assistantMessageId: 'a1', chatId: 'c1' });
    // A human-typed row can carry metadata (model responses, timing) WITHOUT
    // an origin stamp — that is not machine-sent either.
    const [row2] = findOwnerFrustration(
      [{ ...user, content: 'why do I have to ask twice? still broken', metadata: { timing: { ms: 12 } } }],
      [],
    );
    expect(row2.userMessageId).toBe('u1');
  });
});
