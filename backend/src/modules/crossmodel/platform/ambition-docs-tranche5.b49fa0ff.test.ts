/**
 * Ambition-map tranche 5 pins (B4/C4, 2026-10-15 — ambition-prompt map §3 B4 +
 * §4 C4, the fifth and FINAL tranche of the §7 sequencing; map doc
 * docs/AMBITIOUS_PROMPTING_MAP_2026-10-15.md, landed on main via PR #1512;
 * prior tranches #1515 / #1518 / #1520 / #1523).
 *
 *   - B4: a short "Ambition levers" bullet cluster in AGENTS.md Conventions
 *     recording B1's brief contract (raw material + proof condition — landed
 *     via #1520) and B2's altitude-offer rule (final-report suggestion, never
 *     silent scope expansion — landed via #1520). The map gives the spec, not
 *     literal text; the cluster follows Conventions style.
 *   - C4: README.md:19/:273 and docs/DEPTH_AND_DIG_DEEPER.md still described
 *     the retired per-message depth picker ("four patience levels", "Choose a
 *     patience level", the Account → Advanced "Default depth" radios, and the
 *     NEXT_PUBLIC_DEPTH_UX_DISABLED switch that "brings the composer picker
 *     back") — all retired 2026-10-06 (roster B-3, commit 5cc0b2fc4;
 *     AdvancedTab showed one read-only DEPTH_AUTO_LINE; the switch was never
 *     forwarded into the frontend build and its paths are deleted).
 *     FOLLOW-UP ticket c99b404a (2026-10-27): the Account → Advanced TAB was
 *     removed outright — the DEPTH pins below assert the post-removal copy,
 *     and the AdvancedTab / DEPTH_AUTO_LINE cross-anchors are gone with it.
 *
 * Pins keep every touched doc string verbatim, pin the placement (B4 inside
 * AGENTS.md Conventions; the DEPTH section heading the help manifest keys on),
 * pin the STALE claims absent (no "four patience levels", no "Choose a
 * patience level", no Default-depth radios table, no picker-restoring switch),
 * and cross-anchor the docs to the live code constants they cite (the
 * DIGBY_PLATFORM_IDENTITY depth line in chat-context.ts since c99b404a —
 * originally DEPTH_AUTO_LINE in frontend/lib/depth-ux.ts, removed with the tab).
 *
 * Doc-only tranche — no runtime prompt strings touched; B3 stays out (the map:
 * incident-driven ledger only). Source-pinned via readFileSync + REPO_ROOT
 * (cf. lesson-writer.test.ts): no service import graphs.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { isExportTree, readDroppedFile } from '../../../utils/export-mode';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');

// AGENTS.md is a DROPPED-PRIVATE path: the public export does not ship it, so
// the B4 pins below cannot run there. `readDroppedFile` returns null for a
// genuine export (licensing the skip) and THROWS when the file is missing from
// any other kind of tree, so a damaged private checkout still fails loudly
// instead of silently skipping its own pins.
const AGENTS: string | null = readDroppedFile('AGENTS.md', REPO_ROOT);
const IN_EXPORT = isExportTree(REPO_ROOT);

const README = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
const DEPTH = readFileSync(join(REPO_ROOT, 'docs', 'DEPTH_AND_DIG_DEEPER.md'), 'utf8');
const ENV_EXAMPLE = readFileSync(join(REPO_ROOT, '.env.example'), 'utf8');
const DEPTH_MIRROR = readFileSync(
  join(REPO_ROOT, 'frontend', 'content', 'help', 'depth.md'),
  'utf8',
);
const MANIFEST = readFileSync(
  join(REPO_ROOT, 'frontend', 'content', 'help', 'manifest.json'),
  'utf8',
);

// ── B4 — the Ambition levers bullet cluster in AGENTS.md Conventions ─────────
//
// Skipped in a PUBLIC EXPORT: AGENTS.md is dropped-private doctrine and the
// export correctly does not ship it. The absence is ASSERTED below, so the
// skip is a verified fact about the tree rather than a swallowed error.
const b4Describe = AGENTS === null ? describe.skip : describe;

b4Describe('ambition map tranche 5 · B4 — AGENTS.md Conventions "Ambition levers" cluster', () => {
  // Non-null in every branch this describe actually runs in (null => skipped).
  const AGENTS_TXT: string = AGENTS ?? '';
  const B4_BULLET_START = '- **Ambition levers (2026-10-15, ambition map B1/B2 — landed via PR #1520):**';
  // normalize wrapping so the pins survive a re-wrap of the markdown
  const bulletFlat = (): string => {
    const start = AGENTS_TXT.indexOf(B4_BULLET_START);
    const end = AGENTS_TXT.indexOf('- **Self-hosting', start);
    return AGENTS_TXT.slice(start, end).replace(/\s+/g, ' ');
  };

  it('the cluster is present, inside the Conventions section (not a stray top-of-file bullet)', () => {
    const conventions = AGENTS_TXT.indexOf('## Conventions');
    expect(conventions).toBeGreaterThan(-1);
    const bullet = AGENTS_TXT.indexOf(B4_BULLET_START);
    expect(bullet).toBeGreaterThan(conventions);
    // still before the next major section break after Conventions' start
    const tail = AGENTS_TXT.indexOf('\n## ', conventions + 1);
    expect(bullet).toBeLessThan(tail);
  });

  it('records B1 — delegate briefs carry the RAW material and the proof condition (the landed rule, map §3 B1)', () => {
    const bullet = bulletFlat();
    expect(bullet).toContain('delegate');
    expect(bullet).toContain('RAW material to start from (files, logs, URLs — not pre-digested');
    expect(bullet).toContain('what would PROVE the answer right or wrong');
    expect(bullet).toContain('B1');
  });

  it('records B2 — altitude offers are final-report suggestions, never silent scope expansion (the landed rule, map §3 B2)', () => {
    const bullet = bulletFlat();
    expect(bullet).toContain('names it in ONE line of its final as a suggestion with the concrete next command');
    expect(bullet).toContain('never silently expands scope');
    expect(bullet).toContain('B2');
  });

  it('cites the surfaces + pin suite the rules live in (docs move with the code)', () => {
    const bullet = bulletFlat();
    expect(bullet).toContain('coding/roles.ts orchestratorRoleGuidance');
    expect(bullet).toContain('coding/agent.ts systemPrompt');
    expect(bullet).toContain('ambition-briefs.8ce699aa.test.ts');
    expect(bullet).toContain('docs/AMBITIOUS_PROMPTING_MAP_2026-10-15.md');
  });

  it('§6 anti-patterns stay OUT of the cluster (no belief pressure, no roleplay)', () => {
    const bullet = bulletFlat();
    expect(bullet).not.toMatch(/you can do it/i);
    expect(bullet).not.toMatch(/the impossible is possible/i);
    expect(bullet).not.toMatch(/pretend to be/i);
    expect(bullet).not.toMatch(/short seller/i);
  });
});

// ── C4 — README: the retired picker language is gone ─────────────────────────

describe('ambition map tranche 5 · C4 — README picker-retirement staleness fixed', () => {
  it('line 19: no "four patience levels" — the feature bullet describes Digby picking the shape + Dig deeper', () => {
    expect(README).not.toContain('four patience levels');
    expect(README).toContain('Digby picks the shape per message');
    expect(README).toContain('**Dig deeper**');
  });

  it('How to Use step 3: no "Choose a patience level" — depth is automatic', () => {
    expect(README).not.toContain('Choose a patience level');
    expect(README).toContain('**Depth is automatic**');
    expect(README).toContain('tap **Dig deeper** under an answer to go further');
  });

  it('no other README claim tells users to pick a patience/depth level', () => {
    expect(README).not.toMatch(/choose a (patience|depth) level/i);
    expect(README).not.toMatch(/patience picker/i);
  });
});

// ── C4 — DEPTH_AND_DIG_DEEPER.md: the post-retirement truth ──────────────────

describe('ambition map tranche 5 · C4 — DEPTH doc "Choosing a default depth" rewritten', () => {
  it('the stale Default-depth radios section is GONE (heading, table, and the "not gone — it moved" claim)', () => {
    expect(DEPTH).not.toContain('## Choosing a default depth');
    expect(DEPTH).not.toContain('The old level picker is not gone');
    expect(DEPTH).not.toContain('| **Auto** (recommended) |');
    expect(DEPTH).not.toContain('| **1 · Quick** |');
    expect(DEPTH).not.toContain('| **2 · Ensemble** |');
    expect(DEPTH).not.toContain('| **3 · Research** |');
  });

  it('the replacement section states there is no depth setting at all and names the ONE control (Dig deeper)', () => {
    expect(DEPTH).toContain('## Depth settings');
    expect(DEPTH).toContain('There is no depth setting.');
    expect(DEPTH).toContain('that is the only depth control');
    // Ticket c99b404a (2026-10-27): the Account → Advanced TAB was removed
    // outright — the section records the removal instead of pointing at it.
    expect(DEPTH).toContain('was removed outright on');
    expect(DEPTH).toContain('ticket c99b404a');
  });

  it('the doc carries the live "no depth setting" copy, cross-anchored to the platform-identity constant', () => {
    expect(DEPTH).toContain('Digby picks the shape per message');
    // the same string the model doctrine renders — drift between doc and code fails here
    const chatContext = readFileSync(join(REPO_ROOT, 'backend', 'src', 'modules', 'crossmodel', 'chat-agent', 'chat-context.ts'), 'utf8');
    expect(chatContext).toContain('• There is no depth setting: Digby picks depth and models per message — never tell a user to pick a level.');
  });

  it('the admin always-Auto switch is described as admin-only with its real name', () => {
    expect(DEPTH).toContain('Admin → Settings → "Depth policy"');
    expect(DEPTH).toContain('`patience_auto_only`');
    expect(DEPTH).toContain('admin-only');
    // and no longer claims a user's Advanced choice "applies again when that changes"
    expect(DEPTH).not.toContain('applies again when that changes');
  });

  it('the retired NEXT_PUBLIC_DEPTH_UX_DISABLED switch is no longer offered as restoring the picker', () => {
    expect(DEPTH).not.toContain('which brings the');
    expect(DEPTH).not.toMatch(/brings the\s+composer picker back/);
    expect(DEPTH).toContain('retired with the picker');
    expect(DEPTH).toContain('never');
    expect(DEPTH).toContain('forwarded into the frontend build');
  });
});

// ── C4 — .env.example: the retired switch line ───────────────────────────────

describe('ambition map tranche 5 · C4 — .env.example retired-switch line', () => {
  it('the line no longer offers NEXT_PUBLIC_DEPTH_UX_DISABLED=1 as restoring the picker', () => {
    expect(ENV_EXAMPLE).not.toContain('# NEXT_PUBLIC_DEPTH_UX_DISABLED=1  # restores the composer');
    expect(ENV_EXAMPLE).toContain('# NEXT_PUBLIC_DEPTH_UX_DISABLED  # RETIRED with the depth picker');
    expect(ENV_EXAMPLE).toContain('never forwarded into the frontend');
  });
});

// ── Help mirror — the re-synced twins (help-sync guard, same commit) ─────────

describe('ambition map tranche 5 · C4 — help mirror re-synced with the source doc', () => {
  it('frontend/content/help/depth.md mirrors the rewritten section (byte-twin, not a stale copy)', () => {
    expect(DEPTH_MIRROR).toContain('## Depth settings');
    expect(DEPTH_MIRROR).toContain('There is no depth setting.');
    expect(DEPTH_MIRROR).not.toContain('## Choosing a default depth');
    expect(DEPTH_MIRROR).not.toContain('| **1 · Quick** |');
  });

  it('manifest.json carries the NEW section heading (the search index matches the doc)', () => {
    expect(MANIFEST).toContain('"text": "Depth settings"');
    expect(MANIFEST).not.toContain('"text": "Depth settings (Account → Advanced)"');
    expect(MANIFEST).not.toContain('"text": "Choosing a default depth');
  });
});
