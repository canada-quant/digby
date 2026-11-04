/**
 * sweep-doctrine-rebuild.test.ts — the doctrine-never-absent pin suite for the
 * trigger-keyed sweep-doctrine rebuild (R&D stream 3, test-bench experiment
 * #2, 2026-09-18; owner-gate oq_33a72186 cleared GO).
 *
 * The dedup: the standing doctrine (the standing directives + the lane's
 * precedence rule [+ the scope rule on project lanes]) left the STORED sweep
 * bodies (~4855c/~1150 cl100k tokens fleet, ~6243c/~1473t project, paid per
 * firing) because it already rides the lanes' SYSTEM prompts (the cached
 * prefix every wake pays for anyway). The invariant that must never break:
 * NO WAKE RUNS DOCTRINE-LESS. This suite pins it for every wake class:
 *   - trigger-keyed sweep wake: rebuildSweepPromptDoctrine modes + the
 *     composed union (system prompt + firing message) always carries the
 *     lane's full doctrine set;
 *   - cold wake: both stock lane system prompts carry the full doctrine set
 *     verbatim (the system prompt is messages[0] on the first turn);
 *   - post-compaction wake: the coding-loop compactMessages keeps messages[0]
 *     (the system prompt) verbatim — the doctrine survives compaction
 *     (plain-chat history windowing never touches the system prompt at all —
 *     it is rebuilt from the DB every run);
 *   - transition window: a legacy pre-heal stored body (doctrine still
 *     inline) is fired unchanged, never double-injected.
 *
 * LAYERED PROMPTS (2026-09-27): the doctrine set is `sweepDoctrineBlocks(cls)`
 * — the GENERIC core sections (core-doctrine.ts). (The pre-layering constants
 * and PROMPT_LAYERING_DISABLED were deleted in build 2026-10-08 S-2.) The
 * probe marker is unchanged.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string, public isOperational = true) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));
jest.mock('../crossmodel.service', () => ({
  __esModule: true,
  default: { getChatAccess: jest.fn() },
}));
jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  emitScheduleDisabled: jest.fn(async () => undefined),
}));
// compaction's boundaries (same mocks compaction.test.ts uses) — the
// post-compaction pin exercises the REAL compactMessages.
jest.mock('../../../utils/utility-llm', () => ({
  __esModule: true,
  utilityChat: jest.fn(async () => 'RECAP: explored the repo, edited a.ts, ran tests (green).'),
}));
jest.mock('../coding/coding-retrieval.service', () => ({
  __esModule: true,
  storeFindings: jest.fn(async () => 1),
}));

import { SWEEP_PROMPT_OPENER, PROJECT_SWEEP_PROMPT_OPENER, DOCTRINE_PROBE_MARKER } from './supervisor-doctrine';
import { CORE_STANDING_DIRECTIVES, corePrecedenceRule, CORE_SCOPE_RULE } from './core-doctrine';
import {
  classifySweepPrompt,
  sweepDoctrineBlock,
  sweepDoctrineBlocks,
  rebuildSweepPromptDoctrine,
} from './sweep-doctrine-rebuild';
import { buildFleetSupervisorPrompt, buildFleetSweepPrompt } from './supervisor.service';
import { buildProjectSupervisorPrompt, buildProjectSupervisorSweepPrompt } from './project-supervisor.service';
import { machineWakePreamble } from '../chat-agent/machine-wake';
import { compactMessages, clipOversizedMessages } from '../coding/compaction';

const PROJ = { projectName: 'crossmodel', projectId: 'proj_test000', fleetSupervisorChatId: 'chat_fleet000' };

// A stored body written by the pre-layering builders (deleted in build 2026-10-08 S-2)
// still opens its inline doctrine with the probe marker — frozen fixture of that shape.
const LEGACY_INLINE_DOCTRINE = `${DOCTRINE_PROBE_MARKER} (bind every wake — read before acting)\n- legacy standing directives (frozen fixture)\n## Precedence (who decides what)\n- legacy fleet precedence rule (frozen fixture)`;

describe('classifySweepPrompt — the trigger key', () => {
  it('keys fleet and project stock sweeps on their opener prefixes, nothing else', () => {
    expect(classifySweepPrompt(`${SWEEP_PROMPT_OPENER} — a GOAL LEDGER diff…`)).toBe('fleet');
    expect(classifySweepPrompt(`${PROJECT_SWEEP_PROMPT_OPENER} for "crossmodel" (projectId p) — …`)).toBe('project');
    expect(classifySweepPrompt('Nightly supervisor loop: review fleet state and report.')).toBeNull();
    // A hook-wake envelope is NOT a sweep — never touched by the rebuild.
    expect(classifySweepPrompt('[MACHINE-TRIGGERED RUN — EVENT HOOK …]\nsome event')).toBeNull();
    // A customized sweep prompt that dropped the opener is never matched
    // (same non-clobber rule as the stale-prompt heals).
    expect(classifySweepPrompt('My custom fleet sweep — do things differently')).toBeNull();
    expect(classifySweepPrompt('' as any)).toBeNull();
    expect(classifySweepPrompt(undefined as any)).toBeNull();
  });
});

describe('the doctrine probe marker', () => {
  it('is a verbatim prefix of the standing-directives section (layered core)', () => {
    expect(CORE_STANDING_DIRECTIVES.startsWith(DOCTRINE_PROBE_MARKER)).toBe(true);
  });
});

describe('sweepDoctrineBlock — the rebuilt doctrine matches the lane\'s doctrine SHAPE', () => {
  it('LAYERED (default): fleet = core standing + fleet precedence; project = + scope rule; joined \\n\\n', () => {
    expect(sweepDoctrineBlocks('fleet')).toEqual([CORE_STANDING_DIRECTIVES, corePrecedenceRule('fleet')]);
    expect(sweepDoctrineBlocks('project')).toEqual([CORE_STANDING_DIRECTIVES, corePrecedenceRule('project'), CORE_SCOPE_RULE]);
    expect(sweepDoctrineBlock('fleet')).toBe(`${CORE_STANDING_DIRECTIVES}\n\n${corePrecedenceRule('fleet')}`);
    expect(sweepDoctrineBlock('project')).toBe(`${CORE_STANDING_DIRECTIVES}\n\n${corePrecedenceRule('project')}\n\n${CORE_SCOPE_RULE}`);
    expect(sweepDoctrineBlock('fleet')).not.toContain(CORE_SCOPE_RULE);
  });
});

describe('rebuildSweepPromptDoctrine — the modes', () => {
  const slimFleet = `${SWEEP_PROMPT_OPENER} — a GOAL LEDGER diff, not a status bulletin.\n1. PULL the ledger: goal_list…\n2. DIFF…`;
  const slimProject = `${PROJECT_SWEEP_PROMPT_OPENER} for "crossmodel" (projectId p) — a GOAL LEDGER diff.\n\n1. PULL the ledger: goal_list…`;
  const doctrineSys = `You are the Fleet Supervisor.\n\n${CORE_STANDING_DIRECTIVES}\n\n…rest…`;

  it('not-sweep: a non-sweep firing is returned byte-identical', () => {
    const p = 'check back on the outage';
    expect(rebuildSweepPromptDoctrine({ prompt: p, systemPrompt: null })).toEqual({ prompt: p, mode: 'not-sweep' });
  });

  it('system-prompt: slim body + doctrine-carrying system prompt fires the slim body unchanged (the dedup win)', () => {
    const r = rebuildSweepPromptDoctrine({ prompt: slimFleet, systemPrompt: doctrineSys });
    expect(r.mode).toBe('system-prompt');
    expect(r.prompt).toBe(slimFleet);
    expect(r.prompt).not.toContain(DOCTRINE_PROBE_MARKER);
  });

  it('inlined-fallback: slim body + doctrine-LESS system prompt rebuilds the doctrine at the END of the body (opener at offset 0, doctrine clip-safe)', () => {
    for (const [cls, body] of [['fleet', slimFleet], ['project', slimProject]] as const) {
      const r = rebuildSweepPromptDoctrine({ prompt: body, systemPrompt: 'a customized system prompt with no doctrine' });
      expect(r.mode).toBe('inlined-fallback');
      // Opener still at offset 0 (heal keys + UI classifier read the head).
      expect(r.prompt.startsWith(body.split('\n')[0])).toBe(true);
      for (const b of sweepDoctrineBlocks(cls)) expect(r.prompt).toContain(b);
      // Placement (test-bench #3, review finding C6): the doctrine is the body
      // SUFFIX — after every duty — so the user-role clip's retained 7,000c
      // tail keeps it whole (the exp #2 after-opener placement let the clip
      // elide it mid-block).
      expect(r.prompt.endsWith(sweepDoctrineBlock(cls))).toBe(true);
      expect(r.prompt.indexOf(DOCTRINE_PROBE_MARKER)).toBeGreaterThan(r.prompt.indexOf('1. PULL'));
    }
  });

  it('inlined-fallback on a NULL system prompt (probe read error) — uncertainty resolves TOWARD doctrine', () => {
    const r = rebuildSweepPromptDoctrine({ prompt: slimFleet, systemPrompt: null });
    expect(r.mode).toBe('inlined-fallback');
    for (const b of sweepDoctrineBlocks('fleet')) expect(r.prompt).toContain(b);
  });

  it('already-inline: a legacy pre-heal stored body is fired unchanged — never double-injected (even forced)', () => {
    const legacy = `${SWEEP_PROMPT_OPENER} — a GOAL LEDGER diff.\n${LEGACY_INLINE_DOCTRINE}\n1. PULL the ledger…`;
    for (const sys of [doctrineSys, null, 'no doctrine here']) {
      expect(rebuildSweepPromptDoctrine({ prompt: legacy, systemPrompt: sys }).mode).toBe('already-inline');
    }
    expect(rebuildSweepPromptDoctrine({ prompt: legacy, systemPrompt: null, forceInline: true })).toEqual({ prompt: legacy, mode: 'already-inline' });
  });

  it('inlined-forced: SWEEP_DOCTRINE_FORCE_INLINE restores the pre-dedup firing shape even when the system prompt has the doctrine', () => {
    const r = rebuildSweepPromptDoctrine({ prompt: slimProject, systemPrompt: doctrineSys, forceInline: true });
    expect(r.mode).toBe('inlined-forced');
    for (const b of sweepDoctrineBlocks('project')) expect(r.prompt).toContain(b);
    expect(r.prompt.endsWith(sweepDoctrineBlock('project'))).toBe(true); // C6 suffix placement
  });
});

describe('NO WAKE RUNS DOCTRINE-LESS — the composed invariant on the REAL builders', () => {
  it('the stored sweep bodies are now SLIM (the dedup itself) but keep their heal-key openers + close markers', () => {
    const fleet = buildFleetSweepPrompt();
    const project = buildProjectSupervisorSweepPrompt(PROJ);
    // Dedup: the doctrine no longer rides the stored body…
    expect(fleet).not.toContain(DOCTRINE_PROBE_MARKER);
    expect(project).not.toContain(DOCTRINE_PROBE_MARKER);
    for (const b of sweepDoctrineBlocks('fleet')) expect(fleet).not.toContain(b);
    for (const b of sweepDoctrineBlocks('project')) expect(project).not.toContain(b);
    // …but the heal key and the harness-classifier close markers survive.
    expect(fleet.startsWith(SWEEP_PROMPT_OPENER)).toBe(true);
    expect(project.startsWith(PROJECT_SWEEP_PROMPT_OPENER)).toBe(true);
    expect(fleet).toContain('SWEEP: no-op — nothing moved on any project since last sweep');
    expect(project).toContain('SWEEP: no-op — nothing moved in crossmodel since last sweep');
    expect(fleet).toContain('ACTIONS TAKEN');
    expect(project).toContain('ACTIONS TAKEN');
  });

  it('COLD WAKE: both stock lane system prompts carry the lane’s FULL doctrine set verbatim (messages[0] on turn one)', () => {
    const fleetSys = buildFleetSupervisorPrompt();
    for (const b of sweepDoctrineBlocks('fleet')) expect(fleetSys).toContain(b);
    const projectSys = buildProjectSupervisorPrompt(PROJ);
    for (const b of sweepDoctrineBlocks('project')) expect(projectSys).toContain(b);
  });

  it('TRIGGER-KEYED SWEEP WAKE: slim body + stock system prompt → system-prompt mode; union carries the full doctrine set', () => {
    const fleetSys = buildFleetSupervisorPrompt();
    const fleetFire = rebuildSweepPromptDoctrine({ prompt: buildFleetSweepPrompt(), systemPrompt: fleetSys });
    expect(fleetFire.mode).toBe('system-prompt');
    const fleetUnion = `${fleetSys}\n${fleetFire.prompt}`;
    for (const b of [...sweepDoctrineBlocks('fleet'), CORE_SCOPE_RULE]) expect(fleetUnion).toContain(b);

    const projectSys = buildProjectSupervisorPrompt(PROJ);
    const projectFire = rebuildSweepPromptDoctrine({ prompt: buildProjectSupervisorSweepPrompt(PROJ), systemPrompt: projectSys });
    expect(projectFire.mode).toBe('system-prompt');
    const projectUnion = `${projectSys}\n${projectFire.prompt}`;
    for (const b of sweepDoctrineBlocks('project')) expect(projectUnion).toContain(b);

    // …and if the lane’s system prompt ever loses the doctrine, the firing
    // message itself carries it — the union is doctrine-laden either way.
    const fallback = rebuildSweepPromptDoctrine({ prompt: buildProjectSupervisorSweepPrompt(PROJ), systemPrompt: null });
    expect(fallback.mode).toBe('inlined-fallback');
    for (const b of sweepDoctrineBlocks('project')) expect(fallback.prompt).toContain(b);
  });

  it('POST-COMPACTION WAKE: the WHOLE system prompt survives compactMessages byte-identical at messages[0] (role-aware clip, test-bench #3)', async () => {
    // SUPERSEDED INVARIANT (exp #2 shape): pre-fix, clipOversizedMessages
    // head+tail-clipped ANY over-cap message — including messages[0] — to a 7k
    // head + 7k tail, so the doctrine survived ONLY because it sat inside the
    // retained head (offsets pinned here: < CLIP_HEAD). Test-bench #3 made the
    // clip role-aware (system rides SYSTEM_MSG_CHAR_CAP — compaction.ts), so
    // the honest invariant is now the strong one: BYTE-IDENTITY. The 'keep
    // doctrine early' offset constraint is RETIRED (deliberately not re-pinned
    // — preamble text ahead of the doctrine may now grow freely).
    const fleetSys = buildFleetSupervisorPrompt();
    expect(fleetSys.length).toBeGreaterThan(14_000); // the pre-fix clip really engaged
    const projectSys = buildProjectSupervisorPrompt(PROJ);
    expect(projectSys.length).toBeGreaterThan(14_000);

    const sys = { role: 'system', content: fleetSys };
    const asstCall = (name: string) => ({ role: 'assistant', content: '', tool_calls: [{ id: 't', type: 'function', function: { name } }] });
    const toolRes = (t: string) => ({ role: 'tool', tool_call_id: 't', content: t });
    const msgs: any[] = [sys];
    for (let i = 0; i < 12; i++) { msgs.push(asstCall(`tool${i}`)); msgs.push(toolRes(`result ${i} `.repeat(40))); }
    const out = await compactMessages(msgs, undefined, { mode: 'full' });
    expect(out).not.toBeNull();
    expect(out![0].role).toBe('system');
    // The whole prompt — not a 7k head + 7k tail — so the doctrine survives
    // everywhere, and so do AGENTS.md, memory blocks and chat instructions.
    expect(out![0].content).toBe(fleetSys);
    expect(out![0].content).not.toMatch(/clipped .* chars/);
  });

  it('COLD + TRIGGER-KEYED WAKES: an oversize system prompt passes clipOversizedMessages byte-identical, doctrine intact in the union', () => {
    // The agent.ts recovery paths (transient + size-rejection) clip the FULL
    // loop array directly — pin the role-aware exemption at that choke point
    // for both stock lane prompts (cold wake) and a rebuilt firing composite
    // (trigger-keyed wake). The firing message itself stays clip-eligible
    // (user role) — only the system prompt is exempt.
    for (const [label, laneSys] of [
      ['fleet', buildFleetSupervisorPrompt()],
      ['project', buildProjectSupervisorPrompt(PROJ)],
    ] as const) {
      expect(laneSys.length).toBeGreaterThan(14_000);
      const firing = rebuildSweepPromptDoctrine({
        prompt: label === 'fleet' ? buildFleetSweepPrompt() : buildProjectSupervisorSweepPrompt(PROJ),
        systemPrompt: laneSys,
      });
      const out = clipOversizedMessages([
        { role: 'system', content: laneSys },
        { role: 'user', content: firing.prompt },
      ]) as any[];
      expect(out[0].content).toBe(laneSys); // byte-identical — no mid-block slice
      const union = `${out[0].content}\n${out[1].content}`;
      for (const b of sweepDoctrineBlocks(label)) expect(union).toContain(b);
    }
  });

  it('TRIGGER-KEYED FALLBACK/FORCED FIRING: the >14k composite keeps the FULL rebuilt doctrine through the user-role clip (C6 regression pin)', () => {
    // The fallback/forced firing composite exceeds PER_MSG_CHAR_CAP (bench:
    // fleet 14,657c / project 16,022c) and rides role:'user', so
    // clipOversizedMessages retains only its first + last 7,000c. The exp #2
    // after-opener doctrine placement landed in the elided middle (a clipped
    // fleet fallback lost 657c spanning the incident-born halt rule; a clipped
    // project fallback lost SUPERVISOR_PRECEDENCE_RULE verbatim — adversarial
    // review C6, test-bench #3). End-injection keeps the whole block in the
    // retained tail — pin it on the REAL preamble composites, fallback AND
    // forced, so a placement/content regression trips CI.
    const preamble = machineWakePreamble(new Date('2026-09-18T12:00:00.000Z'));
    for (const [cls, slim] of [
      ['fleet', buildFleetSweepPrompt()],
      ['project', buildProjectSupervisorSweepPrompt(PROJ)],
    ] as const) {
      const block = sweepDoctrineBlock(cls);
      const blocks = sweepDoctrineBlocks(cls);
      // The tail-retention budget: the doctrine block must fit the clip's
      // retained 7,000c tail — deliberate doctrine growth trips HERE first.
      expect(block.length).toBeLessThanOrEqual(7_000);
      for (const forced of [false, true]) {
        const composite = preamble + rebuildSweepPromptDoctrine({
          prompt: slim,
          systemPrompt: forced ? buildFleetSupervisorPrompt() : null,
          forceInline: forced,
        }).prompt;
        expect(composite.length).toBeGreaterThan(14_000); // the clip really engages (under the old flat cap)
        // Iteration 10 (2026-09-24): the FIRST user message — the wake itself —
        // is exempt up to FIRST_USER_MSG_CHAR_CAP, so the live path keeps the
        // whole composite. The suffix defense below is pinned with the
        // exemption switched OFF (the kill-switch path must still keep doctrine).
        expect((clipOversizedMessages([{ role: 'user', content: composite }]) as any[])[0].content).toBe(composite);
        // The flat-cap outcome is measured on a NON-first user message: the
        // exemption is keyed on being the run's first user turn, so a
        // later-position message still rides PER_MSG_CHAR_CAP exactly as every
        // user message did before the exemption landed.
        const clipped = (clipOversizedMessages([
          { role: 'user', content: 'prior task' },
          { role: 'user', content: composite },
        ]) as any[])[1].content as string;
        expect(clipped).toMatch(/clipped .* chars/); // the clip really fired
        for (const b of blocks) expect(clipped).toContain(b);
        expect(clipped.endsWith(block)).toBe(true); // the doctrine is the retained suffix
        expect(clipped.slice(0, 7_000)).toContain(cls === 'fleet' ? SWEEP_PROMPT_OPENER : PROJECT_SWEEP_PROMPT_OPENER); // the wake's identity survives in the head
        console.log(`C6 clip-survival: ${cls} ${forced ? 'inlined-forced' : 'inlined-fallback'} composite ${composite.length}c, doctrine ${block.length}c, tail margin ${7_000 - block.length}c`);
      }
    }
  });
});
