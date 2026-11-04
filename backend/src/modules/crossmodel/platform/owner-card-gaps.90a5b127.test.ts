/**
 * Ticket 90a5b127 — owner-card options-axis precision at the LEAF
 * (detectOwnerCardPayloadGaps). Every case below was first executed against
 * the pre-fix committed leaf (the ticket's own reproduction, verified again
 * in tmp/90a5b127-repro.ts before the fix landed): findings 1.1 and 1.2
 * wrongly COMPLETED the options axis; finding 2.1's genuinely-optional asks
 * wrongly GAPped. The sweep-level replay pins (CARD_RE gate, context length
 * rule, DETECTOR-RECALL REPLAY of prior true positives) live in
 * fleet/framework-signal-detectors.test.ts; this file pins the ADMISSION
 * itself, both axes, with no sweep gating.
 */
import { detectOwnerCardPayloadGaps } from './owner-card-gaps';

const gaps = (input: Parameters<typeof detectOwnerCardPayloadGaps>[0]) => detectOwnerCardPayloadGaps(input);

describe('owner-card-gaps options axis (90a5b127)', () => {
  // ── Finding 1.1: non-adjacent negation must NOT complete the options axis.
  it.each([
    ['the deploy will not be fine without the api key - paste it'],
    ['the fleet never works without the credential - paste it'],
    ["the worker isn't going to work without the token - paste it"],
    ['the route no longer works without the key - paste it'],
  ])('a negated dependence is URGENCY, not a decline path: %s', (question) => {
    expect(gaps({ question, context: null })).toContain('options');
  });

  it('a question about working without the key is the ask itself, not a decline path', () => {
    expect(gaps({ question: 'does the app work without the key? paste it', context: null })).toContain('options');
  });

  // ── Finding 1.2: optionality wording that does NOT govern the ask must
  // not complete the options axis.
  it('a conditional of OUTCOME is urgency, not optionality', () => {
    expect(gaps({ question: 'if you want the fix to work, paste the env file', context: null })).toContain('options');
  });

  it('a posture cue governing a DIFFERENT action (worry) is not optionality', () => {
    expect(gaps({ question: 'there is no need to worry - paste the private key now', context: null })).toContain('options');
  });

  it('a posture cue governing a DIFFERENT action (ignore) is not optionality', () => {
    expect(gaps({ question: 'feel free to ignore this, but paste the recovery key immediately', context: null })).toContain('options');
  });

  // ── Finding 2.1: the wording-chase cases the ticket predicts would recur.
  it.each([
    ["paste the output whenever you're ready"],
    ['restart the box at your discretion'],
    ['no obligation, but paste the log if you can'],
    ['paste the output when convenient'],
  ])('a genuinely optional ask completes the options axis: %s', (question) => {
    expect(gaps({ question, context: null })).not.toContain('options');
  });

  // ── The structural legs (finding 2.1's durable fix): the flagger DECLARES
  // optionality; the detector stops guessing it from prose.
  it('optionalAsk:true completes the options axis by declaration — even urgent wording', () => {
    expect(gaps({ question: 'paste the api key - the routes are 401 without it', context: null, optionalAsk: true }))
      .not.toContain('options');
  });

  it('optionalAsk:false suppresses the prose-optionality fallback', () => {
    expect(gaps({ question: 'no rush - paste the key', context: null, optionalAsk: false })).toContain('options');
  });

  it('optionalAsk:false does NOT suppress typed options (structure beats prose)', () => {
    expect(gaps({ question: 'pick a fix', context: null, optionalAsk: false, options: [{ id: 'a', label: 'A' }] }))
      .not.toContain('options');
  });

  it('expectedAnswerType yes_no completes the options axis (a ruling declares its decision space)', () => {
    expect(gaps({ question: 'should i proceed with the rollback? background: the deploy failed', context: null, expectedAnswerType: 'yes_no' }))
      .not.toContain('options');
  });

  it('expectedAnswerType credential does NOT complete (a credential ask is a single urgent action)', () => {
    expect(gaps({ question: 'paste the deploy key now', context: 'the deploy is failing', expectedAnswerType: 'credential:DEPLOY_KEY' }))
      .toContain('options');
  });

  it('expectedAnswerType free and choice-without-options do NOT complete', () => {
    expect(gaps({ question: 'paste the output below', context: null, expectedAnswerType: 'free' })).toContain('options');
    expect(gaps({ question: 'paste the output below', context: null, expectedAnswerType: 'choice' })).toContain('options');
  });

  it('optionalAsk:false does not suppress a yes_no declaration (structure beats prose)', () => {
    expect(gaps({ question: 'proceed? background: deploy failed', context: null, optionalAsk: false, expectedAnswerType: 'yes_no' }))
      .not.toContain('options');
  });

  // ── Prior conviction pins: the cea10fa4 / 65cfec1b true positives.
  it('DETECTOR-RECALL REPLAY (90a5b127): prior true positives still fire at the leaf', () => {
    // cea10fa4 conviction: negated dependence is urgency.
    expect(gaps({ question: 'the lab box cannot work without the key - paste it below', context: 'x'.repeat(20) }))
      .toContain('options');
    // 65cfec1b conviction: background present, no options anywhere.
    expect(gaps({ question: 'the deploy failed - paste the output below', context: null })).toContain('options');
    // The classic bare-ask TP.
    expect(gaps({ question: 'restart tailscaled then paste the output', context: null })).toContain('options');
  });

  it('DETECTOR-RECALL REPLAY (90a5b127): prior SKIP pins still skip at the leaf', () => {
    // cea10fa4 skip pin oq_y.
    expect(gaps({ question: 'paste the key below if you want the route restored - no need otherwise', context: 'route 401 since 03:00Z' }))
      .not.toContain('options');
    // cea10fa4 skip pin oq_x.
    expect(gaps({ question: 'the deploy lane is idle - restart the box at your convenience, or paste the output if it fails', context: null }))
      .not.toContain('options');
  });

  // ── The live specimen (oq_2d874126) — the cea10fa4 false positive that
  // started this family; it must keep skipping.
  it('the cea10fa4 specimen (optional credential ask with stated decline path) still skips', () => {
    const ask = [
      '[ctrl.example.com] Lab gateway is LIVE and public - 5 provider keys are missing on amd-1, so their routes return 401 until you paste them',
      '',
      "The r-2 replacement is live: the LiteLLM gateway now runs on amd-server-1 in the StAnnes lab behind Cloudflare tunnel stanne-lab-amd1, in the CQL Cloudflare account. Public health checks pass from off-box, and the flagship routes answer end-to-end through the public edge.",
      '',
      "What's working: every route whose provider key we already held - XAI, OpenAI, Alibaba (x2), ZAI, Moonshot (x2) - 7 keys mapped onto the box.",
      '',
      "What's dark: routes backed by keys we don't hold - ANTHROPIC, FIREWORKS, ZAI_CODING, XIAOMI_MIMO, STANNE_*. Those models still list in /v1/models (roster shows 51) but return 401 at request time until a real key lands on amd-1.",
      '',
      "If you want them restored: paste the key(s) here - any subset is fine. Each paste is stored encrypted (never echoed back) and my lane places it on the box and reloads the gateway; routes come back one by one as keys land. No rush - the core service is fully live without them.",
    ].join('\n');
    expect(gaps({ question: ask, context: null })).not.toContain('options');
    // …and the same card declared optionalAsk:true via the new param.
    expect(gaps({ question: ask, context: null, optionalAsk: true })).not.toContain('options');
    // …while declaring it NOT optional (it was optional — but if a flagger
    // says so, the declaration wins over the prose).
    expect(gaps({ question: ask, context: null, optionalAsk: false })).toContain('options');
  });

  // ── Edge pins the adversarial review will try.
  it('negated dependence in a DIFFERENT clause than the ask stays urgent', () => {
    expect(gaps({ question: 'the box is dark - it cannot work without the key. paste the key below', context: null }))
      .toContain('options');
  });

  it('a bare posture disclaimer completes (tone words never override a stated decline path)', () => {
    expect(gaps({ question: 'no obligation, but paste the recovery key immediately', context: null }))
      .not.toContain('options');
  });

  it('a posture cue governing the ask verb itself completes (no need to paste)', () => {
    expect(gaps({ question: 'no need to paste the key', context: null })).not.toContain('options');
  });

  it('background axis is untouched: a cue-less short ask still gaps background too', () => {
    expect(gaps({ question: 'paste the api key - the routes are 401 without it', context: null }))
      .toEqual(expect.arrayContaining(['background']));
  });

  // ── Review F1 (session 55bf415a): optional phrasings the OLD leaf
  // completed must keep completing — sentence-final punctuation, tails,
  // and the wider ask-verb set.
  it.each([
    ['No rush. Paste the key when you can.'],
    ['No rush! Paste the key.'],
    ['no rush on this one'],
    ['no rush today'],
    ['no rush this week'],
    ['no rush at all'],
    ['no rush for now'],
    ['no need for now'],
    ['no rush to upload the log'],
    ['no rush to share the log'],
    ['no rush to submit the log'],
    ['no rush to drop the log'],
    ['at your convenience provide the api key'],
  ])('review F1 optional phrasing still completes: %s', (question) => {
    expect(gaps({ question, context: null })).not.toContain('options');
  });

  // ── Review F2: a negation in a coordinated TAIL does not void a true
  // decline path (it governs a different verb).
  it.each([
    ['the core service is fully live without them and has no errors - paste keys if you want the routes back'],
    ['the box works without the token and cannot lose data - paste it if you want telemetry'],
  ])('review F2 negated-tail decline path still completes: %s', (question) => {
    expect(gaps({ question, context: null })).not.toContain('options');
  });

  it('review F2 control: negation BEFORE the cue still voids (finding 1.1 pins hold)', () => {
    expect(gaps({ question: 'the deploy will not be fine without the api key - paste it', context: null }))
      .toContain('options');
    expect(gaps({ question: 'the route no longer works without the key - paste it', context: null }))
      .toContain('options');
  });

  // ── Review AMENDMENT F2 (session 55bf415a, msg 3c8e4ebe, MERGE-BLOCKED at
  // 98c7ac3c7): CLAUSE_NEGATION's optional-apostrophe contraction branch
  // `[a-z]+n'?t` matched EVERYDAY "nt" words (current/account/client/front/
  // tenant/important/agent — even "incident", a backgroundCues word) and
  // false-gapped true decline paths. Fixed by requiring the apostrophe
  // (`n['’]t`). Both positions pinned: after-cue tails (already repaired by
  // the span fix) and BEFORE-cue subjects (the positions that were live on
  // main until this fix).
  it.each([
    ['the current lane is fully live without them - paste keys if you want the routes back'],
    ['the client routes are fine without the key - paste it if you want them restored'],
    ['the front tier works without the token - paste it if you want telemetry'],
    ['this account is fine without the credential - paste it if you want the route back'],
    ['the tenant routes are fully live without them - paste keys if you want them back'],
    ['the important route is fine without the key - paste it if you want it restored'],
    ['the agent lane works without the token - paste it if you want telemetry'],
    ['the incident box is fully live without the extra key - paste it if you want the route back'],
    ['the core service is fully live without them for the current lane - paste keys if you want the routes back'],
    ['the service is fine without the credential in this account - paste it if you want the route back'],
  ])('amendment F2 everyday-"nt" vocabulary does NOT void a true decline path: %s', (question) => {
    expect(gaps({ question, context: null })).not.toContain('options');
  });

  it('amendment F2: true contractions still void (apostrophe required, ASCII and curly)', () => {
    expect(gaps({ question: "the current lane isn't fine without the api key - paste it", context: null }))
      .toContain('options');
    expect(gaps({ question: 'the box can’t work without the key - paste it', context: null }))
      .toContain('options');
  });

  // ── Cross-review findings 1-3 (deepseek-flash, 2026-10-20): residuals of
  // this ticket's own classes, confirmed on the LANDED leaf before fixing.
  it.each([
    ['the box isnt fine without the key - paste it'],
    ['the routes dont work without the credential - paste it'],
    ['the worker doesnt work without the token - paste it'],
    ['the deploy wasnt fine without the key - paste it'],
    ['the lane couldnt work without the key - paste it'],
  ])('xreview F1: un-apostrophed contraction before a decline-path cue is URGENCY: %s', (question) => {
    expect(gaps({ question, context: null })).toContain('options');
  });

  it('xreview F1 control: the everyday-"nt" words stay clean (the amendment pins hold)', () => {
    expect(gaps({ question: 'the current lane is fully live without them - paste keys if you want the routes back', context: null }))
      .not.toContain('options');
    expect(gaps({ question: 'the incident box is fully live without the extra key - paste it if you want the route back', context: null }))
      .not.toContain('options');
  });

  it.each([
    ['there is no need to worry but paste the private key now'],
    ['no need to worry just paste the private key now'],
  ])('xreview F2: a foreign-action verb BEFORE the ask voids the posture (no separator): %s', (question) => {
    expect(gaps({ question, context: null })).toContain('options');
  });

  it('xreview F2 control: ask-FIRST in the clause still completes even with a foreign verb later', () => {
    // Same clause, no separator: "paste" (ask) at index 0, "worry" (foreign)
    // later — the ask governs, the trailing reassurance does not void it.
    expect(gaps({ question: 'paste the key when you can and there is no need to worry', context: null }))
      .not.toContain('options');
  });

  it('xreview F3: an interrogative-lead clause is a question even without a terminal "?"', () => {
    expect(gaps({ question: 'does the app work without the key - paste it', context: null }))
      .toContain('options');
  });

  it('xreview F3 control: a statement-lead auxiliary clause still completes', () => {
    // "was" leads a STATEMENT here (subject first: "the route") — not interrogative.
    expect(gaps({ question: 'the route was fine without the key - paste it only if you want telemetry', context: null }))
      .not.toContain('options');
  });

  // ── Ticket a3a7dd88: the BACKGROUND axis gets the same structural leg
  // 90a5b127 gave the options axis — the flagger's TYPED OPTIONS complete
  // background by declaration. Specimen oq_892c91ae (live row, prod probe
  // 2026-10-20, pre-fix verdict gaps ["background"]): a 1163-char
  // self-contained choice card whose background rides in domain vocabulary
  // the 65cfec1b cue-list cannot match. Fifth FP in the family; every prior
  // ticket was a vocabulary-chase class on one axis or the other.
  it('typed options complete the BACKGROUND axis — the a3a7dd88 specimen gaps nowhere', () => {
    const ask = [
      "[ctrl.example.com] CanLaw is LIVE on r-0, tailnet-only — verified 23:31Z from amd-2 (V2_LOCAL_VERIFIED: site, v2 board, bench UI all green) and all 5 provider keys placed (zai legs 200 exact-echo). Four finishing items, one card:",
      '',
      '1. NEW floating IP for r-0 — Hyperstack console → rutherford-0 → attach/buy a floating IP (the account hit $0 and released ALL public IPs; the old ones incl. 203.0.113.12 now belong to strangers, so nothing old can be reused). Without one, canlegalbench.com cannot come back publicly. Once it exists I do DNS (the CQL Cloudflare token holds the zone), SSL Full(strict) and the /api/notify* rate-limit rule myself.',
      '',
      '2. Read-only S3 key for the CanLaw bucket (~0.48TB checkpoints/packs) — unfreezes corpus recovery. Paste it here; it vaults automatically.',
      '',
      '3. Backup target: the handoff recommends the amd-1 backup disk — OK?',
      '',
      '4. Mail values for /etc/canlegalbench/web.env (MAIL_* + NOTIFY_ENC_KEY — also copy NOTIFY_ENC_KEY into your password manager). The site serves, but sign-ups 503 until then. Paste them here; they vault.',
      '',
      'Already done with nothing needed from you: tailnet ACL (was open), HTTPS certificates, TS_PERMIT_CERT_UID=caddy.',
    ].join('\n');
    const options = [
      { id: 'all', label: "All four — I'll attach the IP and paste both key sets" },
      { id: 'ip-only', label: 'Just the floating IP (public bring-back); keys later' },
      { id: 'keys-only', label: "Stay tailnet-only for now; I'll paste the S3 + mail keys" },
      { id: 'defer', label: 'Defer everything — tailnet-only is fine for now' },
    ];
    expect(gaps({ question: ask, context: null, options, expectedAnswerType: 'choice' })).toEqual([]);
    // Without the typed options the pre-fix verdict returns (the background
    // chase is the only axis the options leg completes).
    expect(gaps({ question: ask, context: null, expectedAnswerType: 'choice' })).toEqual(['background']);
  });

  it('typed options COMPLETE a bare cue-less ask too — one structural signal, both axes (a3a7dd88)', () => {
    // Review finding 4 (backwards title corrected): the typed options ARE
    // the decision space and the ask itself is the whole card, so both axes
    // read complete. The sweep-level context-length gate no longer flags
    // this shape either — 65cfec1b's own "skips on typed options alone" pin
    // already treated typed options as completing the options axis
    // unconditionally; a3a7dd88 extends that authority to background.
    // 7-day census at fix time: zero stored cards of this shape.
    expect(gaps({ question: 'paste the steps below', context: null, options: [{ id: 'a', label: 'A' }] }))
      .toEqual([]);
  });

  it('DELIBERATE ACCEPTANCE (a3a7dd88 review advisory): a non-empty options array completes both axes — length only, no per-entry validation', () => {
    // Cross-review advisory A7: hasTypedOptions trusts Array.isArray +
    // length > 0, so a junk array (e.g. [{}]) also completes both axes.
    // Deliberate: the write path (owner-questions.ts) normalizes options
    // before they reach storage (id+label shape), and the 7d census at fix
    // time found zero junk arrays in 27 typed-options rows — the FP
    // suppression direction is safe (the owner still sees the card; only
    // the sweep ticket is suppressed). Pinned so a future tightening knows
    // this is the accepted contract, not an oversight.
    expect(gaps({ question: 'paste the steps below', context: null, options: [{}] as any }))
      .toEqual([]);
  });

  it('axis scope (a3a7dd88 fidelity): yes_no and optionalAsk complete OPTIONS only — background still needs a cue or context', () => {
    // The cross-family review's finding 1: a cue-free card carrying ONLY
    // optionalAsk:true (or only expectedAnswerType 'yes_no') still gaps on
    // background by design — those declarations complete the options axis
    // alone. This is the designed true-positive shape for a lane to know.
    expect(gaps({ question: 'paste the steps below', context: null, optionalAsk: true }))
      .toEqual(['background']);
    expect(gaps({ question: 'paste the steps below', context: null, expectedAnswerType: 'yes_no' }))
      .toEqual(['background']);
    // With a background cue or context the same cards are complete.
    expect(gaps({ question: 'the deploy failed — paste the output below', context: null, optionalAsk: true }))
      .toEqual([]);
    expect(gaps({ question: 'paste the steps below', context: 'the lane is stalled since 02:00Z', optionalAsk: true }))
      .toEqual([]);
  });

  it('DETECTOR-RECALL REPLAY (a3a7dd88): prior background-axis true positives still gap at the leaf', () => {
    // The 65cfec1b classic TPs: no background cue, no options, no context.
    // The a3a7dd88 leg never touches them — they carry no typed options.
    expect(gaps({ question: 'paste the steps below', context: null })).toContain('background');
    expect(gaps({ question: 'restart tailscaled then paste the output', context: null })).toContain('background');
  });

  it('a context column carrying the background cue is the non-gap control (a3a7dd88 replay companion)', () => {
    // Review finding 5 (misleading pin split out): a short cue-bearing
    // context completes the background axis under both main and the diff —
    // this is the control leg of the replay, not one of its true positives.
    expect(gaps({ question: 'paste the output below', context: 'x'.repeat(20) })).not.toContain('background');
  });
});
