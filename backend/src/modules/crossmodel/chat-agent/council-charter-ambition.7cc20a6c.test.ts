/**
 * Council-colleague charter ambition pins (map A2, 2026-10-15 — ambition-prompt
 * map §2 A2, tranche 2 of the §7 sequencing; map doc
 * docs/AMBITIOUS_PROMPTING_MAP_2026-10-15.md, analysis PR #1512).
 *
 * The deep-research council's AUTONOMY CHARTER gained two bullets from the
 * "How to be more ambitious" essay (published 2026-10-13):
 *   - the INSTRUMENTS rule ("same instruments as the best" — actual computation,
 *     tables, primary sources; never a decorative summary of expertise), and
 *   - the NEW-KNOWLEDGE rule (spend part of the budget on what nobody asked
 *     about — earliest signal, blind spot, shared assumption — and report it
 *     separately).
 * These pins keep both bullets verbatim, keep them inside the Autonomy charter
 * (not in the mission header or the report contract), and keep the charter's
 * existing load-bearing lines intact so a future edit cannot quietly trade the
 * essay's additions for the original tools/done/report contract.
 *
 * Anti-pattern guard (map §6): the charter stays a FUNCTIONAL research mandate.
 * The bullets name what a top researcher DOES (instruments, blind spots), never
 * a persona or a "you can do it" pressure line — the pin set below enforces
 * that boundary on the changed surface.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SERVICE_SOURCE = readFileSync(join(__dirname, 'chat-agent.service.ts'), 'utf8');

describe('council colleague charter — the ambition-map depth + range bullets (A2, 2026-10-15)', () => {
  it('both bullets are present verbatim in councilColleagueDoctrine', () => {
    expect(SERVICE_SOURCE).toContain(`- Insist on the field's real instruments, not its vocabulary: when the mission involves data, use actual computation, tables, and primary sources — never a decorative summary of what an expert would say.`);
    expect(SERVICE_SOURCE).toContain(`- When you are deep in the material, spend part of your budget looking for what nobody asked about: the earliest signal, the blind spot, the assumption the sources share. Report it separately if you find it.`);
  });

  it('the bullets live inside the Autonomy charter, between the plan bullet and the tools bullet — not in the mission header or the report contract', () => {
    const charterStart = SERVICE_SOURCE.indexOf('## Autonomy charter');
    const reportLine = SERVICE_SOURCE.indexOf('- END with your full structured report');
    expect(charterStart).toBeGreaterThan(-1);
    expect(reportLine).toBeGreaterThan(charterStart);
    const charter = SERVICE_SOURCE.slice(charterStart, reportLine);
    expect(charter).toContain(`- Plan your own approach. Start broad, then narrow. Prefer authoritative sources over SEO farms.`);
    expect(charter).toContain(`- Insist on the field's real instruments, not its vocabulary`);
    expect(charter).toContain(`- When you are deep in the material, spend part of your budget looking for what nobody asked about`);
    expect(charter).toContain('- web_pipe({query or urls, focus}) for bulk ingestion');
    // ordering: plan → instruments → new-knowledge → tools (the essay's bullets slot in
    // after the approach bullet and before the tool guidance, keeping the cluster shape)
    const plan = charter.indexOf('- Plan your own approach');
    const instruments = charter.indexOf(`- Insist on the field's real instruments`);
    const newKnowledge = charter.indexOf('- When you are deep in the material');
    const tools = charter.indexOf('- web_pipe({query or urls, focus})');
    expect(plan).toBeLessThan(instruments);
    expect(instruments).toBeLessThan(newKnowledge);
    expect(newKnowledge).toBeLessThan(tools);
  });

  it('the pre-existing charter contract is intact (tools / clones / notes / done / report)', () => {
    const charterStart = SERVICE_SOURCE.indexOf('## Autonomy charter');
    const machineWakeLine = SERVICE_SOURCE.indexOf('${args.imageBlock}${args.machineWake');
    const charter = SERVICE_SOURCE.slice(charterStart, machineWakeLine);
    expect(charter).toContain('- Share significant findings, surprises, or questions mid-flight with send_note');
    expect(charter).toContain('- You are done ONLY when you judge the mission answered — there is no time pressure.');
    expect(charter).toContain('- END with your full structured report (your final message IS the deliverable): findings with source URLs, confidence notes, and open questions.');
    // the machine-wake exemption template cross-check-scope.test.ts pins stays untouched
    expect(SERVICE_SOURCE).toContain("${args.imageBlock}${args.machineWake ? `\\n\\n${crossCheckFleetScopeNote()}` : ''}");
  });

  it('clone colleagues get the SAME charter (the two bullets are literal template lines, outside the clone-only spawnLine conditional)', () => {
    // The new bullets are unconditional template text in the returned charter — they
    // render for every colleague INCLUDING clones (the clone variant only drops the
    // spawn_self bullet, which the spawnLine conditional injects between the tools
    // bullet and the send_note bullet). A colleague asked to "look for what nobody
    // asked about" is exactly as ambition-relevant on a clone leg as on the main leg.
    const fnStart = SERVICE_SOURCE.indexOf('function councilColleagueDoctrine');
    const bodyStart = SERVICE_SOURCE.indexOf('return `You are ${args.persona}', fnStart);
    const bodyEnd = SERVICE_SOURCE.indexOf('${args.imageBlock}', fnStart);
    expect(fnStart).toBeGreaterThan(-1);
    expect(bodyStart).toBeGreaterThan(fnStart);
    expect(bodyEnd).toBeGreaterThan(bodyStart);
    const body = SERVICE_SOURCE.slice(bodyStart, bodyEnd);
    expect(body).toContain(`- Insist on the field's real instruments`);
    expect(body).toContain('- When you are deep in the material');
    // the clone conditional is computed BEFORE the return and gates ONLY the
    // spawn_self bullet — neither ambition bullet may ever move into it
    const cloneCond = SERVICE_SOURCE.slice(fnStart, bodyStart);
    expect(cloneCond).toContain('spawn_self (up to ${MAX_CLONES_PER_COLLEAGUE} clones)');
    expect(cloneCond).not.toContain(`field's real instruments`);
    expect(cloneCond).not.toContain('When you are deep in the material');
  });

  it('map §6 anti-patterns: no persona language and no belief-pressure language entered the charter', () => {
    const charterStart = SERVICE_SOURCE.indexOf('## Autonomy charter');
    const machineWakeLine = SERVICE_SOURCE.indexOf('${args.imageBlock}${args.machineWake');
    const charter = SERVICE_SOURCE.slice(charterStart, machineWakeLine);
    // §6.2 no roleplay crew: the essay's own caveat — find fields and techniques,
    // never cast characters. A "short seller persona" line would be a regression.
    expect(charter).not.toMatch(/persona of|act as a |pretend to be|imagine you are/i);
    // §6.1 no "you can do it" doctrine: belief pressure fights claim discipline.
    expect(charter).not.toMatch(/you can do|believe in|nothing is impossible|the impossible is possible/i);
  });
});
