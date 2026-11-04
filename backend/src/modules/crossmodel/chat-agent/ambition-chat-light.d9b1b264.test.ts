/**
 * Ambition-map tranche 4 pins (A3/A4/A5, 2026-10-15 — ambition-prompt map §2
 * items A3/A4/A5, fourth tranche of the §7 sequencing; map doc
 * docs/AMBITIOUS_PROMPTING_MAP_2026-10-15.md, landed on main via PR #1512;
 * prior tranches #1515 / #1518 / #1520).
 *
 * The "How to be more ambitious" essay's (published 2026-10-13) three light
 * chat touches:
 *   - A3: the LEAD doctrine's artifact-altitude bullet — deliver the asked-for
 *     artifact AND, when the goal behind it is inferable and one step away,
 *     offer the bigger outcome in ONE line (an OFFER, never a substitution);
 *   - A4: the follow-ups line gains ONE altitude-shaped follow-up shape (the
 *     question the user would need answered NEXT to act on this answer) —
 *     hasUser variant only, machine/anonymous variants untouched;
 *   - A5: the home-screen starter-chip SPREAD_SPEC gains slot (f), an optional
 *     ambition chip one level above the user's role/projects.
 *
 * Pins keep every touched string VERBATIM, pin placement (A3 after the
 * search-discipline bullet; A4 inside the hasUser return only; A5 between (e)
 * and STYLE), and pin the map §6 anti-patterns ABSENT from the touched
 * surfaces (no belief-pressure, no roleplay, no silent scope expansion).
 *
 * A3 and A5 pin the SOURCE (readFileSync — the chat-agent.service import graph
 * process.exit()s at import in jest, and suggested-questions pulls the DB
 * config; cf. council-charter-ambition.7cc20a6c.test.ts). A4 imports the pure
 * leaf capability-doctrine directly (no imports of its own).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { followUpsInstruction, FOLLOWUPS_CHAR_BUDGET } from './capability-doctrine';

const SERVICE_SOURCE = readFileSync(join(__dirname, 'chat-agent.service.ts'), 'utf8');
const CHIPS_SOURCE = readFileSync(join(__dirname, '..', 'suggested-questions.service.ts'), 'utf8');

// ── The three map drop-ins, VERBATIM (map §2 A3/A4/A5) ────────────────────────

const A3_BULLET = `- When the request names an artifact (a summary, a deck, a draft), deliver it — and when the goal behind the request is clear and a bigger outcome is one step away, say so in one line and offer it ("this deck exists to get a decision on X — I can also draft the decision memo with options"). Never withhold the asked-for artifact; altitude is an offer, never a substitution.`;

const A4_CLAUSE = `, and when the question clearly sits inside a bigger goal, ONE of the follow-ups may go one level of abstraction up — the question the user would need answered NEXT to act on this answer (e.g. "What would you need to decide before acting on this?")`;

const A5_LINE = `(f) optionally 1 ambition chip that looks one level above the user's role or projects — not "what's new" but "what should I decide / build / change" (e.g. "What should our team stop doing next quarter?").`;

// ── A3 — the lead doctrine's artifact-altitude bullet ─────────────────────────

describe('ambition map tranche 4 · A3 — chatDoctrine artifact-altitude bullet', () => {
  it('the bullet is present VERBATIM in chatDoctrine\'s "How to answer" section', () => {
    expect(SERVICE_SOURCE).toContain(A3_BULLET);
  });

  it('the bullet appears exactly ONCE in the service source (scoped to chatDoctrine — not duplicated into the council lead or colleague doctrines)', () => {
    const occurrences = SERVICE_SOURCE.split(A3_BULLET).length - 1;
    expect(occurrences).toBe(1);
  });

  it('placement: directly after the search-discipline bullet, before the AUTO-mode bullet, inside "How to answer" (the map\'s anchor)', () => {
    const howToAnswer = SERVICE_SOURCE.indexOf('## How to answer');
    const searchDiscipline = SERVICE_SOURCE.indexOf('- Search discipline: use your web tools whenever the question is time-sensitive');
    const altitude = SERVICE_SOURCE.indexOf(A3_BULLET);
    const autoMode = SERVICE_SOURCE.indexOf('- You act in AUTO mode: never ask for confirmation on routine, goal-aligned actions.');
    const councilLead = SERVICE_SOURCE.indexOf('function councilLeadDoctrine');
    expect(howToAnswer).toBeGreaterThan(-1);
    expect(searchDiscipline).toBeGreaterThan(howToAnswer);
    expect(altitude).toBeGreaterThan(searchDiscipline);
    expect(altitude).toBeLessThan(autoMode);
    expect(councilLead).toBeGreaterThan(-1);
    expect(altitude).toBeLessThan(councilLead); // inside chatDoctrine, before the next doctrine begins
  });

  it('the bullet keeps its anti-substitution guardrails: deliver-first + offer-not-substitution (map §6.3)', () => {
    expect(A3_BULLET).toContain('Never withhold the asked-for artifact');
    expect(A3_BULLET).toContain('altitude is an offer, never a substitution');
    // and the surrounding "How to answer" contract the bullet leans on stays intact
    expect(SERVICE_SOURCE).toContain('- Be direct and complete. Format with markdown. Never claim you lack access to public web content.');
  });
});

// ── A4 — the altitude-shaped follow-up (hasUser variant only) ─────────────────

describe('ambition map tranche 4 · A4 — followUpsInstruction altitude clause', () => {
  it('the SIGNED-IN line carries the altitude clause VERBATIM (map §2 A4 drop-in)', () => {
    expect(followUpsInstruction({ hasUser: true })).toContain(A4_CLAUSE);
  });

  it('scoped to the hasUser variant ONLY — anonymous and machine lines stay without it (the map pins "hasUser variant only"; machine runs are questions-only)', () => {
    expect(followUpsInstruction({ hasUser: false })).not.toContain('one level of abstraction up');
    expect(followUpsInstruction({ hasUser: true, machine: true })).not.toContain('one level of abstraction up');
  });

  it('the [FOLLOWUPS] markup shape and the existing action-chip contract survive the append', () => {
    const line = followUpsInstruction({ hasUser: true });
    expect(line.startsWith('- End with 2-4 follow-ups inside a ')).toBe(true);
    expect(line).toContain('[FOLLOWUPS]\\n- q1\\n- q2\\n[/FOLLOWUPS]');
    expect(line).not.toContain('\n'); // one line — no real newlines
    expect(line).toContain('natural next QUESTIONS');
    expect(line).toContain('ONE action chip');
    expect(line).toContain('imperative, ≤ 80 chars');
    expect(line).toContain('"Check this again tomorrow morning and message me on Telegram"');
    expect(line).toContain('One per line, no numbering, no prose.');
  });

  it('the clause stays bounded — ONE altitude follow-up, not a mandate (map §6.3: an offer, never a substitution)', () => {
    expect(A4_CLAUSE).toContain('ONE of the follow-ups may go one level of abstraction up');
    expect(A4_CLAUSE).toContain('when the question clearly sits inside a bigger goal');
  });

  it('the hasUser line stays within FOLLOWUPS_CHAR_BUDGET (measured +4% convention, map §5)', () => {
    for (const line of [
      followUpsInstruction({ hasUser: true }),
      followUpsInstruction({ hasUser: false }),
      followUpsInstruction({ hasUser: true, machine: true }),
      followUpsInstruction({ hasUser: false, machine: true }),
    ]) {
      expect(line.length).toBeLessThanOrEqual(FOLLOWUPS_CHAR_BUDGET);
    }
    expect(FOLLOWUPS_CHAR_BUDGET).toBeGreaterThanOrEqual(followUpsInstruction({ hasUser: true }).length);
  });
});

// ── A5 — the ambition slot in the starter-chip SPREAD_SPEC ────────────────────

describe('ambition map tranche 4 · A5 — SPREAD_SPEC ambition slot (f)', () => {
  it('slot (f) is present VERBATIM in SPREAD_SPEC', () => {
    expect(CHIPS_SOURCE).toContain(A5_LINE);
  });

  it('placement: after slot (e), before the STYLE line (the map\'s anchor inside SPREAD_SPEC)', () => {
    const spread = CHIPS_SOURCE.indexOf('SPREAD — aim for this, and skip a slot rather than force it:');
    const slotE = CHIPS_SOURCE.indexOf('(e) optionally 1 natural next step from a chat active in the last 7 days');
    const slotF = CHIPS_SOURCE.indexOf(A5_LINE);
    const style = CHIPS_SOURCE.indexOf('STYLE: 4–12 words, under ~70 characters');
    expect(spread).toBeGreaterThan(-1);
    expect(slotE).toBeGreaterThan(spread);
    expect(slotF).toBeGreaterThan(slotE);
    expect(slotF).toBeLessThan(style);
  });

  it('the slot stays OPTIONAL and its example is plain — no CHIP_RULES marketing words (map caution: keep the example plain)', () => {
    expect(A5_LINE).toMatch(/^\(f\) optionally 1 ambition chip/);
    for (const marketing of ['fresh', 'angle', 'unlock', 'lurk', 'engaging', 'supercharge', 'elevate', 'leverage']) {
      expect(A5_LINE.toLowerCase()).not.toContain(marketing);
    }
    // the example is a real question in the user's voice, like the spec's STYLE line demands
    expect(A5_LINE).toContain('"What should our team stop doing next quarter?"');
  });

  it('the ambition slot composes with the ground rules it must satisfy — CHIP_RULES stay intact around it (ONE SOURCE, GROUNDED, A QUESTION NOT AN ACTION)', () => {
    const chipRules = CHIPS_SOURCE.indexOf('export const CHIP_RULES');
    const spread = CHIPS_SOURCE.indexOf('SPREAD — aim for this');
    expect(chipRules).toBeGreaterThan(-1);
    expect(spread).toBeGreaterThan(chipRules);
    expect(CHIPS_SOURCE).toContain("'A QUESTION, NOT AN ACTION. A chip never tells Digby to send, post, forward, pay, delete, share, message, or email anything or anyone.'");
    // and the SPREAD_SPEC still embeds into the DRAFT_SYSTEM prompt (the only prompt that carries it)
    const draftSystem = CHIPS_SOURCE.indexOf('const DRAFT_SYSTEM');
    expect(draftSystem).toBeGreaterThan(-1);
    expect(CHIPS_SOURCE.slice(draftSystem)).toContain('${SPREAD_SPEC}');
  });
});

// ── Map §6 anti-patterns stay ABSENT from every touched surface ───────────────

describe('ambition map §6 anti-patterns stay ABSENT from the tranche-4 surfaces', () => {
  it('no belief-pressure, no roleplay, no persona crew (map §6.1/§6.2)', () => {
    for (const text of [SERVICE_SOURCE, CHIPS_SOURCE, followUpsInstruction({ hasUser: true })]) {
      expect(text).not.toMatch(/you can do it/i);
      expect(text).not.toMatch(/the impossible is possible/i);
      expect(text).not.toMatch(/pretend to be/i);
      expect(text).not.toMatch(/short seller persona/i);
    }
  });

  it('altitude stays an OFFER on every touched surface — no unilateral scope expansion (map §6.3)', () => {
    // A3: offer, never a substitution
    expect(SERVICE_SOURCE).toContain('altitude is an offer, never a substitution');
    // A4: ONE follow-up MAY go up — bounded, conditional
    expect(followUpsInstruction({ hasUser: true })).toContain('ONE of the follow-ups may go one level of abstraction up');
    // A5: the ambition slot is optional, skipped rather than forced (SPREAD_SPEC's own header rule)
    expect(CHIPS_SOURCE).toContain('SPREAD — aim for this, and skip a slot rather than force it:');
  });
});
