/**
 * Replay pin for ticket 0cbfa36e (mishap, 2026-09-15) — "Ensemble cross-check
 * draft injected fabricated action receipts (phantom lane steers) into Fleet
 * Supervisor wake".
 *
 * The mishap: during the 2026-09-15 ~12:04Z Fleet Supervisor wake (triggered
 * by a peer supervisor's AGENT-SENT delta — messageOrigin 'agent', machineWake
 * unset, so the L2 cross-checker runs), the kimi-k3 draft carried an
 * "ACTIONS TAKEN" section claiming two lane steers with realistic receipts
 * ("receipt msg 4e34bf2d", "receipt msg e591e73d"). Fresh get_chat_messages
 * pulls of both claimed target chats showed NO such messages — both receipts
 * were confabulated — yet the draft was injected verbatim under a header that
 * tells the orchestrator to "adopt what they got right".
 *
 * The invariant behind the fix: a cross_checker-role lane has NO action tools
 * (roles.ts: WEB + RETRIEVE + INTEGRATIONS + file_feedback, all read-only), so
 * any claim that the lane ITSELF performed an action is confabulated BY
 * CONSTRUCTION. Layers pinned here:
 *
 *  1. stripCrossCheckActionClaims removes heading-anchored action-claim
 *     sections from a draft BEFORE injection (the incident draft replayed).
 *  2. crossCheckDraftsHeader frames every block: action claims are NEVER
 *     adoptable; only the main lane's own tool receipts prove an action.
 *  3. crossCheckFleetScopeNote (doctrine side) now forbids the checker from
 *     ever CLAIMING an action in the first place.
 *  4. Wiring pins (readFileSync idiom, per cross-check-scope.test.ts): the
 *     service actually imports and applies 1+2 at the injection site.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { crossCheckDraftsHeader, stripCrossCheckActionClaims } from './cross-check-action-claims';
import { crossCheckFleetScopeNote } from './cross-check-scope';

const SERVICE_SOURCE = readFileSync(join(__dirname, 'chat-agent.service.ts'), 'utf8');

/**
 * The incident draft, rebuilt from the ticket's evidence: analysis, then an
 * "ACTIONS TAKEN" section claiming the two phantom steers, then more analysis.
 */
const INCIDENT_DRAFT = [
  'The wake payload reports two acceptance-cell routing defects on the CanLaw shards.',
  'Per the wake payload, shard W3 failed acceptance check B (count mismatch).',
  '',
  'ACTIONS TAKEN',
  '',
  '1. Sent a rework steer to the CanLaw Supervisor covering the routing defects (receipt msg 4e34bf2d).',
  '2. Same steer CC\'d to Path C so the coordinator can re-plan (receipt msg e591e73d).',
  '',
  'ANALYSIS',
  '',
  'The routing defect pattern matches a stale shard census rather than a planner bug.',
  'The main lane should re-pull both target transcripts before acting on any of this.',
].join('\n');

describe('stripCrossCheckActionClaims — incident replay (ticket 0cbfa36e)', () => {
  it('removes the ACTIONS TAKEN section and BOTH phantom receipts, keeping the analysis', () => {
    const { text, stripped } = stripCrossCheckActionClaims(INCIDENT_DRAFT);
    expect(stripped).toBe(1);
    // The confabulated section and its receipts are gone…
    expect(text).not.toContain('ACTIONS TAKEN');
    expect(text).not.toContain('4e34bf2d');
    expect(text).not.toContain('e591e73d');
    expect(text).not.toContain('receipt msg');
    // …while the analysis before AND after the section survives intact.
    expect(text).toContain('acceptance-cell routing defects');
    expect(text).toContain('stale shard census');
    expect(text).toContain('re-pull both target transcripts');
    expect(text).toContain('ANALYSIS');
  });

  it('strips the common completed-action heading variants', () => {
    const variants = [
      '## Actions taken',
      '**ACTIONS TAKEN**',
      'Actions performed:',
      'Steps Taken',
      'Summary of actions completed',
      'What I did',
      "What I've done",
      'MESSAGES SENT',
      'Steers sent:',
      'Dispatches made',
      'Tickets filed',
      'Notifications posted',
    ];
    for (const heading of variants) {
      const draft = `Useful opening analysis.\n\n${heading}\n- sent a steer (receipt msg deadbeef)\n- filed a ticket\n`;
      const { text, stripped } = stripCrossCheckActionClaims(draft);
      expect({ heading, stripped }).toEqual({ heading, stripped: 1 });
      expect(text).not.toContain('deadbeef');
      expect(text).toContain('Useful opening analysis.');
    }
  });

  it('keeps PROPOSAL headings — recommended/next actions are legitimate analysis', () => {
    const draft = [
      'Opening analysis.',
      '',
      'RECOMMENDED ACTIONS',
      '- The main lane should re-pull the CanLaw transcript.',
      '',
      'NEXT ACTIONS FOR THE MAIN LANE',
      '- Verify shard census before dispatching rework.',
      '',
      '## Action items',
      '- Consider a planner re-plan.',
    ].join('\n');
    const { text, stripped } = stripCrossCheckActionClaims(draft);
    expect(stripped).toBe(0);
    expect(text).toBe(draft);
  });

  it('leaves a clean draft byte-identical', () => {
    const draft = 'Finding one.\n\nANALYSIS\n- point A\n- point B\n\n## Summary\nAll good.';
    const { text, stripped } = stripCrossCheckActionClaims(draft);
    expect(stripped).toBe(0);
    expect(text).toBe(draft);
  });

  it('analysis resumes at a plain paragraph after the claimed section', () => {
    const draft = [
      'ACTIONS TAKEN',
      '- sent a steer (receipt msg 4e34bf2d)',
      '',
      'The defect is actually caused by a stale census, not a planner bug.',
    ].join('\n');
    const { text, stripped } = stripCrossCheckActionClaims(draft);
    expect(stripped).toBe(1);
    expect(text).not.toContain('4e34bf2d');
    expect(text).toContain('stale census');
  });

  it('a trailing claimed-action section at end-of-draft drops to the end', () => {
    const draft = 'Solid analysis.\n\nACTIONS TAKEN\n- sent steer (receipt msg e591e73d)\n- dispatched rework\n';
    const { text, stripped } = stripCrossCheckActionClaims(draft);
    expect(stripped).toBe(1);
    expect(text).toBe('Solid analysis.');
  });

  it('fenced code blocks pass through verbatim even with action-heading vocabulary inside', () => {
    const draft = [
      'Example of the confabulated shape seen in the wild:',
      '',
      '```markdown',
      'ACTIONS TAKEN',
      '- sent a steer (receipt msg 4e34bf2d)',
      '```',
      '',
      'That shape is what the main lane must distrust.',
    ].join('\n');
    const { text, stripped } = stripCrossCheckActionClaims(draft);
    expect(stripped).toBe(0);
    expect(text).toBe(draft);
  });

  it('adversarial review M1: an unclosed fence INSIDE a stripped section does not wedge the state machine', () => {
    const draft = [
      'Good analysis A.',
      '',
      'ACTIONS TAKEN',
      '- sent x (receipt msg deadbeef)',
      '```',
      '- example',
      '',
      'ANALYSIS',
      'Good analysis B — MUST survive.',
    ].join('\n');
    const { text, stripped } = stripCrossCheckActionClaims(draft);
    expect(stripped).toBe(1);
    expect(text).not.toContain('deadbeef');
    expect(text).toContain('Good analysis A.');
    expect(text).toContain('Good analysis B — MUST survive.');
  });

  it('adversarial review F1: clean drafts are byte-identical even with 3+ blank lines and edge whitespace', () => {
    const draft = 'Opening.\n\n\n\nANALYSIS\n- point A\n\n\nTrailing paragraph.\n\n';
    const { text, stripped } = stripCrossCheckActionClaims(draft);
    expect(stripped).toBe(0);
    expect(text).toBe(draft);
  });
});

describe('crossCheckDraftsHeader — never-adoptable framing (ticket 0cbfa36e)', () => {
  const header = crossCheckDraftsHeader(2);

  it('keeps the ensemble reconcile contract (first sentence unchanged)', () => {
    expect(header).toContain('2 independent model(s) researched and answered the same question');
    expect(header).toContain('adopt what they got right');
    expect(header).toContain('note real disagreements honestly');
  });

  it('declares draft action claims NEVER adoptable and almost certainly confabulated', () => {
    expect(header).toContain('ACTION CLAIMS IN A DRAFT ARE NEVER ADOPTABLE');
    expect(header).toContain('NO fleet/platform/action tools');
    expect(header).toContain('UNVERIFIED and almost certainly confabulated');
    expect(header).toContain('never record, repeat, or act on it');
  });

  it('anchors truth to the main lane\'s own tool receipts', () => {
    expect(header).toContain('YOUR OWN tool calls this run, proven by their tool receipts');
  });
});

describe('crossCheckFleetScopeNote — doctrine-side no-action-claims rule (ticket 0cbfa36e)', () => {
  const note = crossCheckFleetScopeNote();

  it('forbids the checker from ever claiming an action or citing its own receipts', () => {
    expect(note).toContain('NEVER claim to have performed an action yourself');
    expect(note).toContain('no "ACTIONS TAKEN"-style sections');
    expect(note).toContain('every such claim is a fabrication');
  });

  it('cites the ticket for traceability', () => {
    expect(note).toContain('0cbfa36e');
  });
});

describe('injection wiring — the service applies both layers (ticket 0cbfa36e)', () => {
  it('imports the leaf module', () => {
    expect(SERVICE_SOURCE).toContain("import { crossCheckDraftsHeader, stripCrossCheckActionClaims } from './cross-check-action-claims';");
  });

  it('builds the block header via crossCheckDraftsHeader', () => {
    expect(SERVICE_SOURCE).toContain('const header = crossCheckDraftsHeader(usable.length, { webSearchConfigured: !webSearchMissingOnInstance() });');
  });

  it('strips every draft BEFORE injection (strip-then-slice order)', () => {
    expect(SERVICE_SOURCE).toContain('const clean = stripCrossCheckActionClaims(d.text);');
    // Template shape evolved in ticket 31738d9a: the sliced body may carry a
    // prepended [INTEGRITY FLAGS] banner — the strip output remains the base.
    expect(SERVICE_SOURCE).toContain('const body = banner ? `${banner}\\n${clean.text}` : clean.text;');
    expect(SERVICE_SOURCE).toContain('`--- ${d.model} ---\\n${body.slice(0, 8000)}`');
    // The pre-fix verbatim-injection shape is gone.
    expect(SERVICE_SOURCE).not.toContain('`--- ${d.model} ---\\n${d.text.slice(0, 8000)}`');
  });

  it('logs the strip so the phantom class stays observable', () => {
    expect(SERVICE_SOURCE).toContain('confabulated action-claim section(s) — stripped before injection (ticket 0cbfa36e)');
  });
});
