/**
 * EXPLICIT-GRANT-ONLY mirror pin (ticket d53eed71, owner ruling oq_d45410a4).
 *
 * `create_chat_webhook` MINTS A BEARER (#32), so the owner ruled it may be
 * card-free ONLY where autonomy was EXPLICITLY granted, never on mode-derived
 * authority. That is expressed as two hand-maintained constants that must agree:
 *
 *   autonomy.service.ts   EXPLICIT_GRANT_ONLY_TOOLS  (the authority: what
 *                         setChatAutonomy ACCEPTS via GRANTABLE_TOOL_NAMES and
 *                         what every auto-provisioning spread must NOT contain)
 *   platform-tools.ts     EXPLICIT_GRANT_ONLY_TOOLS  (the enforcement: which
 *                         tool names take the narrow manual-grant-only limb
 *                         INSTEAD of the mode-inferred bypasses below it)
 *
 * Drift fails SILENTLY and in the PERMISSIVE direction in the one case that
 * matters: a name present in autonomy.service but missing from platform-tools
 * is accepted by set_chat_autonomy, written to a 'manual' row, and then STILL
 * STAGES a card forever — a grant that promises autonomy it never delivers
 * (invisible to the user, who checked the box). The reverse makes a name
 * unreachable by any grant.
 *
 * This reads SOURCE TEXT on purpose (the same discipline as
 * isolation-chokepoints.c75b5f34.test.ts): the two sets live in modules with
 * heavy static graphs, and importing both would need the union of every mock
 * in the repo just to compare two string arrays.
 */
import * as fs from 'fs';
import * as path from 'path';

const PLATFORM_DIR = __dirname;

function readSource(file: string): string {
  return fs.readFileSync(path.join(PLATFORM_DIR, file), 'utf8');
}

/** Every quoted tool name inside the LAST `NAME = [...] as const`-style literal. */
function quotedNamesIn(text: string, decl: RegExp): string[] {
  const m = decl.exec(text);
  if (!m) throw new Error(`declaration not found: ${decl}`);
  const body = m[1];
  return [...body.matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]);
}

describe('EXPLICIT_GRANT_ONLY_TOOLS mirror (d53eed71 / oq_d45410a4)', () => {
  const autonomySrc = readSource('autonomy.service.ts');
  const toolsSrc = readSource('platform-tools.ts');

  it('the authority set and the enforcement set name EXACTLY the same tools', () => {
    const authority = quotedNamesIn(
      autonomySrc,
      /export const EXPLICIT_GRANT_ONLY_TOOLS\s*=\s*\[([\s\S]*?)\]\s*as const/,
    );
    const enforcement = quotedNamesIn(
      toolsSrc,
      /const EXPLICIT_GRANT_ONLY_TOOLS\s*=\s*new Set<string>\(\[([\s\S]*?)\]\)/,
    );
    // Set-compare (order is not load-bearing; membership is).
    expect([...enforcement].sort()).toEqual([...authority].sort());
    // Guard the pin itself: an empty/renamed literal must not pass vacuously.
    expect(authority.length).toBeGreaterThan(0);
    expect(authority).toContain('create_chat_webhook');
  });

  it('create_chat_webhook is NOT auto-provisionable (absent from AUTONOMY_GRANTABLE_TOOLS)', () => {
    // The core of the ruling: four paths spread AUTONOMY_GRANTABLE_TOOLS
    // wholesale (grantFullAutonomy, syncAutonomyWithAgentMode, and both
    // modeAuthority verdict legs). Membership there == card-free for every
    // auto-mode lane and both supervisor seats, which is the inverse of
    // "only where you explicitly granted it".
    const autoGrantable = quotedNamesIn(
      autonomySrc,
      /export const AUTONOMY_GRANTABLE_TOOLS\s*=\s*\[([\s\S]*?)\]\s*as const/,
    );
    expect(autoGrantable).not.toContain('create_chat_webhook');
    expect(autoGrantable.length).toBeGreaterThan(0);
  });

  it('GRANTABLE_TOOL_NAMES is the union (so the owner CAN type it into a grant)', () => {
    expect(autonomySrc).toMatch(
      /export const GRANTABLE_TOOL_NAMES\s*=\s*\[\.\.\.AUTONOMY_GRANTABLE_TOOLS,\s*\.\.\.EXPLICIT_GRANT_ONLY_TOOLS\]\s*as const/,
    );
    // setChatAutonomy must validate against the UNION, not the auto-grantable
    // subset — otherwise an explicit-only tool is unreachable by any grant.
    expect(autonomySrc).toContain('const grantable = new Set<string>(GRANTABLE_TOOL_NAMES)');
    // …and the rejection message must name the union the caller can actually use.
    expect(autonomySrc).toContain('allowedTools must be a subset of: ${GRANTABLE_TOOL_NAMES.join');
    // The supervisor DELEGATION verdict must keep the NARROW set: an
    // explicit-only tool may only ever be named by the owner, never handed on
    // by a supervisor whose own authority over it is itself auto-provisioned.
    // (Slice from the declaration to its own `tool not grantable` refusal — a
    // brace-balanced regex is brittle because the opts TYPE closes first.)
    const dStart = autonomySrc.indexOf('export async function supervisorDelegationVerdict');
    const dEnd = autonomySrc.indexOf('tool not grantable', dStart);
    expect(dStart).toBeGreaterThan(-1);
    expect(dEnd).toBeGreaterThan(dStart);
    const delegation = autonomySrc.slice(dStart, dEnd);
    expect(delegation).toContain('new Set<string>(AUTONOMY_GRANTABLE_TOOLS)');
    expect(delegation).not.toContain('GRANTABLE_TOOL_NAMES');
  });

  it('the gate limb requires BOTH a manual source and a literal name (no mode authority)', () => {
    // Pin the enforcement conjuncts so a later refactor cannot quietly drop
    // the source check and hand the tool back to mode-derived authority.
    const limb = /if \(EXPLICIT_GRANT_ONLY_TOOLS\.has\(name\)\)\s*\{([\s\S]*?)\n    \} else if/.exec(toolsSrc)?.[1] ?? '';
    expect(limb).not.toBe('');
    expect(limb).toContain("row.source === (autonomyMod.AUTONOMY_SOURCE_MANUAL ?? 'manual')");
    expect(limb).toContain('row.allowedTools.includes(name)');
    // The tool is no longer in the always-card set (it takes the limb above).
    const neverAutonomous = /const NEVER_AUTONOMOUS_TOOLS = new Set\(\[([\s\S]*?)\]\)/.exec(toolsSrc)?.[1] ?? '';
    expect(neverAutonomous).not.toContain('create_chat_webhook');
    // …but it IS still consequential, so the default remains a card.
    const consequential = /export const CONSEQUENTIAL_PLATFORM_TOOLS = new Set\(\[([\s\S]*?)\]\)/.exec(toolsSrc)?.[1] ?? '';
    expect(consequential).toContain('create_chat_webhook');
  });
});