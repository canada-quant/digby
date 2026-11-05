/**
 * THE switch-registry CI check (build 2026-10-08 S-1; simplify.md §4 stage 0). Scans the REAL
 * repo — every env switch backend/src and the frontend read, what docker-compose.app.yml
 * forwards — and fails on any violation of checks (a)–(d) in
 * src/modules/crossmodel/platform/switch-registry.ts, printing the fix for each. Release
 * switches expiring within 14 days are printed as a warning (they fail on the day after).
 *
 * Plus unit pins for the scanner (comments never count, compose blocks parse) and the sync
 * planner (rows keep hand-edited fields; new rows get the suffix kind and an expiry).
 */
import * as fs from 'fs';
import * as path from 'path';
import { composeForwarding, dockerfileArgs, scanRepo, switchNamesInSource, switchFamiliesInSource, areaOf, areaFor, repoRoot, SCAN_EXCLUDE } from './switch-scan';
import { planSync, renderRegistrySource, appendLedgerLine, rowLine, todayIso, REGISTRY_FILE } from './switches';
import {
  SWITCHES, NF_INERT, EXISTING_RELEASE_EXPIRY_FLOOR, LANE_DEPTH_ROLLBACK_EXPIRY, LANE_DEPTH_ROLLBACK_SWITCHES, RETAINED_ESCAPE_HATCH_EXPIRY, RETAINED_ESCAPE_HATCH_SWITCHES, expiringSoon, staleForwards, switchRegistryViolations,
} from '../src/modules/crossmodel/platform/switch-registry';

describe('switch registry ⇄ the repo (CI: checks a–d)', () => {
  const scan = scanRepo();

  it('every switch the code reads is registered, forwarded or explained, unexpired, and counted', () => {
    const v = switchRegistryViolations(scan, todayIso());
    if (v.length) {
      const msg = v.map(x => `  ✗ [${x.kind}] ${x.message}`).join('\n');
      throw new Error(`switch registry: ${v.length} violation(s) — fix each (backend/: npm run switches:check / switches:sync):\n${msg}`);
    }
    const soon = expiringSoon(todayIso(), 14);
    if (soon.length) console.warn(`switch registry: ${soon.length} release switch(es) expire within 14 days (CI fails the day after): ${soon.map(s => `${s.name} ${s.expires}`).join(', ')}`);
    const stale = staleForwards(scan);
    if (stale.length) console.warn(`switch registry: docker-compose.app.yml still forwards ${stale.length} switch(es) no code reads — drop those lines: ${stale.join(', ')}`);
  });

  it('the lane-depth flip rollback family (2026-10-20) is re-dated TOGETHER: every name is a registered, forwarded release switch expiring on LANE_DEPTH_ROLLBACK_EXPIRY', () => {
    expect(LANE_DEPTH_ROLLBACK_SWITCHES).toHaveLength(9);
    expect(LANE_DEPTH_ROLLBACK_EXPIRY > EXISTING_RELEASE_EXPIRY_FLOOR).toBe(true);
    for (const name of LANE_DEPTH_ROLLBACK_SWITCHES) {
      const row = SWITCHES.find(s => s.name === name);
      expect(row).toMatchObject({ name, kind: 'release', expires: LANE_DEPTH_ROLLBACK_EXPIRY });
      expect(row!.notForwarded).toBeUndefined();
      expect(scan.compose.backend.has(name) && scan.compose.worker.has(name)).toBe(true);
    }
  });

  // Ticket c5fcbbfb (2026-11-02): RSW-1 cluster 31 hand-excluded SEAT_GOVERNS_SESSIONS_DISABLED and
  // LEAD_SEAT_FALLBACK_DISABLED from its delete cohort because a bare `process.env.<NAME>` grep found
  // ZERO production readers, and read that as "the switch was never wired". It was wrong: both are read
  // through a helper (bracket access in seat-governance.ts, the on() closure in helper-seat.ts), so the
  // grep could not see the reader and the finding was an artefact of the SEARCH SHAPE, not of the code.
  it('every RETAINED_ESCAPE_HATCH_SWITCH has a REAL production reader the AST scanner can name (a name grep can miss it)', () => {
    // Pinned LITERALLY, not just `length >= 6` (adversarial review of c5fcbbfb, finding N1): iterating the
    // list alone would let a future edit DELETE an entry and still pass. These six are the re-bake cohort;
    // dropping one is a decision that must edit this line and its justification, never slip through.
    expect([...RETAINED_ESCAPE_HATCH_SWITCHES].sort()).toEqual([
      'CODING_SEAT_FALLBACK_DISABLED',
      'HELPER_SEAT_FALLBACK_DISABLED',
      'LEAD_SEAT_FALLBACK_DISABLED',
      'SEAT_GOVERNS_SESSIONS_DISABLED',
      'SESSION_TOPOLOGY_DISABLED',
      'VIEW_IMAGE_TOOL_DISABLED',
    ]);
    for (const name of RETAINED_ESCAPE_HATCH_SWITCHES) {
      const row = SWITCHES.find(s => s.name === name);
      expect(row).toMatchObject({ name, kind: 'release', expires: RETAINED_ESCAPE_HATCH_EXPIRY });
      // The repair for the false "zero production reads" finding: the AST scanner must name at least one
      // PRODUCTION file reading it. This fails loudly if a refactor ever really does orphan the reader —
      // which is the delete signal the original grep was reaching for, arrived at honestly.
      expect(scan.backend.get(name)?.length ?? 0).toBeGreaterThan(0);
    }
  });

  // The three seat-family hatches this ticket repaired. Read-but-unforwarded is the opposite of dead
  // config: the kill switch exists while its lever cannot be pulled in prod without a deploy, and the
  // NF_INERT marker ("a deletion candidate") then reads as "nothing reads this" — the sentence that
  // misled RSW-1. Forwarded now, so the lever is real, and no marker (a forwarded row carrying one is a
  // `forwarded_marked` violation).
  it('the seat-family escape hatches are forwarded to backend AND worker (a lever prod can actually pull)', () => {
    for (const name of ['HELPER_SEAT_FALLBACK_DISABLED', 'LEAD_SEAT_FALLBACK_DISABLED', 'SEAT_GOVERNS_SESSIONS_DISABLED']) {
      const row = SWITCHES.find(s => s.name === name);
      expect(row).toMatchObject({ name, kind: 'release', expires: RETAINED_ESCAPE_HATCH_EXPIRY });
      expect(row!.notForwarded).toBeUndefined();
      expect(scan.compose.backend.has(name) && scan.compose.worker.has(name)).toBe(true);
    }
  });

  it('the 2026-10-20 SOTA wave switches are registered release rows forwarded to backend AND worker; the lookup stakes ceiling knob is forwarded too', () => {
    for (const name of ['TASK_KIND_DISABLED', 'MODEL_PICK_KIND_DISABLED', 'MODEL_EVIDENCE_KIND_DISABLED', 'LANE_CHECKER_FOLLOW_UP_DISABLED']) {
      expect(SWITCHES.find(s => s.name === name)).toMatchObject({ kind: 'release', added: '2026-10-20', expires: '2026-12-04' });
      expect(scan.compose.backend.has(name) && scan.compose.worker.has(name)).toBe(true);
    }
    expect(scan.compose.backend.has('TURN_PLAN_QUICK_LOOKUP_STAKES_CEILING') && scan.compose.worker.has('TURN_PLAN_QUICK_LOOKUP_STAKES_CEILING')).toBe(true);
  });

  it('the scan sees the known shapes: process.env.X, env.X, string constants, frontend NEXT_PUBLIC', () => {
    expect(scan.backend.get('DECISION_GATE_DISABLED')).toBeDefined(); // process.env + helper
    // env.X off a parameter (meta-capi.ts) — and the instance setup leaf reads the same switch for its analytics-isolation row (2026-10-20).
    expect(scan.backend.get('META_CAPI_DISABLED')).toEqual(['backend/src/modules/auth/meta-capi.ts', 'backend/src/modules/crossmodel/platform/instance-setup.ts']);
    expect(scan.frontend.get('NEXT_PUBLIC_VISITOR_ANALYTICS_DISABLED')).toBeDefined();
    expect(scan.compose.backend.has('DECISION_GATE_DISABLED')).toBe(true);
    expect(scan.compose.frontendArgs.has('NEXT_PUBLIC_VISITOR_ANALYTICS_DISABLED')).toBe(true);
    expect(scan.frontendDockerArgs.has('NEXT_PUBLIC_VISITOR_ANALYTICS_DISABLED')).toBe(true);
    // the registry itself is the list, never a reader
    expect([...SCAN_EXCLUDE]).toEqual(['backend/src/modules/crossmodel/platform/switch-registry.ts']);
    expect(fs.existsSync(path.join(repoRoot(), [...SCAN_EXCLUDE][0]))).toBe(true);
  });
});

describe('switch scanner', () => {
  it('reads string literals, template parts, property access and destructuring — never comments', () => {
    const src = [
      '// RETIRED_THING_DISABLED=1 restored the old path (retired)',
      '/* BLOCK_COMMENT_DISABLED */',
      "const a = process.env.ALPHA_DISABLED === '1';",
      "const b = (env: NodeJS.ProcessEnv) => env.BETA_ENFORCE;",
      "const C = 'GAMMA_ENABLED';",
      'const d = `DELTA_DISABLED=1 restores ${x}; also EPSILON_DISABLED`;',
      'const { ZETA_DISABLED } = process.env;',
      "const notASwitch = 'LOWER_disabled';",
    ].join('\n');
    expect(switchNamesInSource('x.ts', src).sort()).toEqual(['ALPHA_DISABLED', 'BETA_ENFORCE', 'DELTA_DISABLED', 'EPSILON_DISABLED', 'GAMMA_ENABLED', 'ZETA_DISABLED']);
  });

  it('families: a template literal that renders to a switch-shaped name with interpolations', () => {
    const src = [
      'const a = `DECISION_GATE_${p.toUpperCase()}_ACT_CAP_DISABLED`;',
      'const b = `${x}_ENABLED`;',
      'const c = `not a ${switch} here`;',
      'const d = `HELLO_${x}`;',
    ].join('\n');
    expect(switchFamiliesInSource('x.ts', src).sort()).toEqual(['<*>_ENABLED', 'DECISION_GATE_<*>_ACT_CAP_DISABLED']);
  });

  it('compose: backend / worker environment and the frontend BUILD ARGS only', () => {
    const yml = [
      'services:',
      '  backend:',
      '    build:',
      '      args:',
      '        - BUILD_ONLY_DISABLED=${BUILD_ONLY_DISABLED:-0}',
      '    environment:',
      '      - NODE_ENV=production',
      '      # A_DISABLED in a comment does not count',
      '      - A_DISABLED=${A_DISABLED:-}',
      '  worker:',
      '    environment:',
      '      B_DISABLED: "${B_DISABLED:-}"',
      '  frontend:',
      '    build:',
      '      args:',
      '        - NEXT_PUBLIC_C_DISABLED=${NEXT_PUBLIC_C_DISABLED:-}',
      '    environment:',
      '      - NEXT_PUBLIC_D_DISABLED=1',
      'networks:',
      '  x:',
      '    environment:',
      '      - E_DISABLED=1',
    ].join('\n');
    const f = composeForwarding(yml);
    expect([...f.backend]).toEqual(['NODE_ENV', 'A_DISABLED']);
    expect([...f.worker]).toEqual(['B_DISABLED']);
    expect([...f.frontendArgs]).toEqual(['NEXT_PUBLIC_C_DISABLED']);
    expect([...dockerfileArgs('FROM x\nARG NEXT_PUBLIC_C_DISABLED=\nENV NEXT_PUBLIC_C_DISABLED=$NEXT_PUBLIC_C_DISABLED\n  ARG Y_DISABLED\n')]).toEqual(['NEXT_PUBLIC_C_DISABLED', 'Y_DISABLED']);
  });

  it('areas come from the module directory; the most common area wins', () => {
    expect(areaOf('backend/src/modules/crossmodel/coding/agent.ts')).toBe('coding');
    expect(areaOf('backend/src/modules/crossmodel/serp-redirects.ts')).toBe('crossmodel');
    expect(areaOf('backend/src/modules/auth/meta-capi.ts')).toBe('auth');
    expect(areaOf('backend/src/worker.ts')).toBe('worker');
    expect(areaOf('backend/src/utils/logger.ts')).toBe('utils');
    expect(areaOf('frontend/lib/x.ts')).toBe('frontend');
    expect(areaFor(['backend/src/modules/crossmodel/chat-agent/a.ts', 'backend/src/modules/crossmodel/platform/b.ts', 'backend/src/modules/crossmodel/platform/c.ts'])).toBe('platform');
  });
});

describe('switches CLI (sync)', () => {
  const fakeScan = (backend: Record<string, string[]>, frontend: Record<string, string[]> = {}) => ({
    backend: new Map(Object.entries(backend)), frontend: new Map(Object.entries(frontend)),
    compose: { backend: new Set<string>(), worker: new Set<string>(), frontendArgs: new Set<string>() }, frontendDockerArgs: new Set<string>(),
  });

  it('keeps hand-edited rows, adds new ones by suffix with an expiry, drops unread ones, sorts', () => {
    const current = [
      { name: 'KEEP_DISABLED', area: 'fleet', kind: 'ops' as const, added: '2026-09-01', notForwarded: 'kept by hand — a real reason' },
      { name: 'GONE_DISABLED', area: 'coding', kind: 'release' as const, added: '2026-09-01', expires: '2026-11-12' },
    ];
    const plan = planSync(current, fakeScan({ KEEP_DISABLED: ['backend/src/modules/crossmodel/fleet/x.ts'], NEW_ENFORCE: ['backend/src/modules/crossmodel/coding/y.ts'], ANOTHER_DISABLED: ['backend/src/worker.ts'] }, { NEXT_PUBLIC_Z_DISABLED: ['frontend/lib/z.ts'] }), '2026-10-08');
    expect(plan.removed).toEqual(['GONE_DISABLED']);
    expect(plan.rows.map(r => r.name)).toEqual(['ANOTHER_DISABLED', 'KEEP_DISABLED', 'NEW_ENFORCE', 'NEXT_PUBLIC_Z_DISABLED']);
    expect(plan.rows[1]).toEqual(current[0]);
    expect(plan.rows.find(r => r.name === 'ANOTHER_DISABLED')).toEqual({ name: 'ANOTHER_DISABLED', area: 'worker', kind: 'release', added: '2026-10-08', expires: '2026-10-29' });
    expect(plan.rows.find(r => r.name === 'NEW_ENFORCE')).toEqual({ name: 'NEW_ENFORCE', area: 'coding', kind: 'opt-in', added: '2026-10-08' });
    expect(plan.rows.find(r => r.name === 'NEXT_PUBLIC_Z_DISABLED')).toMatchObject({ area: 'frontend', side: 'frontend' });
    // sync never decides forwarding
    expect(plan.added.every(r => r.notForwarded === undefined)).toBe(true);
  });

  it('renders rows (shared reasons by constant name) and appends ledger lines without touching the rest of the file', () => {
    expect(rowLine({ name: 'A_DISABLED', area: 'x', kind: 'release', added: '2026-10-01', expires: '2026-11-12', notForwarded: NF_INERT }))
      .toBe("  { name: 'A_DISABLED', area: 'x', kind: 'release', added: '2026-10-01', expires: '2026-11-12', notForwarded: NF_INERT },");
    expect(rowLine({ name: 'B_DISABLED', area: 'x', kind: 'ops', added: '2026-10-01', notForwarded: "edge's own reason" }))
      .toBe("  { name: 'B_DISABLED', area: 'x', kind: 'ops', added: '2026-10-01', notForwarded: 'edge\\'s own reason' },");
    const src = fs.readFileSync(REGISTRY_FILE, 'utf8');
    expect(renderRegistrySource(src, SWITCHES)).toBe(src); // the shipped block is exactly what sync renders
    const appended = appendLedgerLine(src, { on: '2026-10-09', count: 1, why: 'removed: X' });
    expect(appended).toContain("  { on: '2026-10-09', count: 1, why: 'removed: X' },\n];");
    expect(appended.replace("\n  { on: '2026-10-09', count: 1, why: 'removed: X' },", '')).toBe(src);
  });

  it('SWITCH_REGISTRY_TODAY overrides today (rehearse an expiry); junk is ignored', () => {
    expect(todayIso({ SWITCH_REGISTRY_TODAY: '2026-11-13' } as NodeJS.ProcessEnv)).toBe('2026-11-13');
    expect(todayIso({ SWITCH_REGISTRY_TODAY: 'soon' } as NodeJS.ProcessEnv)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
