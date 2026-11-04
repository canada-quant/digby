/**
 * Replay pin for ticket ce9ee48d (bug_report, 2026-09-17) — "L2 cross-check
 * draft confabulated a phantom 'Progress Recap' artifact citation".
 *
 * The incident: during the 2026-09-17 00:13Z deploy-recovery wake of the
 * Fleet Supervisor chat (c0e22e36), the L2 cross-check draft (persisted in
 * msg 25e65a98 metadata.models.double_checker) narrated a "Progress Recap
 * (00:13:34Z)" block — shell commands, a curl to https://api.openai.com/v1/
 * credits (not a real OpenAI path) returning "$12.40" (contradicting verified
 * insufficient_quota receipts), YAML edits, "top-up already initiated" — and
 * attributed it to the orchestrator's context. No such block existed on ANY
 * persisted surface (repo-wide, crossmodel_messages content+parts, the whole
 * store table incl. the supervisor thread row — prod SSM probes). The draft
 * had woven REAL fragments (the 00:13:34.936Z wake clock from its own
 * harness-injected context + the oq_77255d6a credits topic) into a FALSE but
 * plausibly-sourced artifact — the complement class of ticket 0cbfa36e
 * (there the claim was TRUE-but-unverifiable; here FALSE-but-plausible).
 *
 * Why the defense is prompt-side (unlike 0cbfa36e's deterministic strip): an
 * artifact citation is NOT false by construction — the lane legitimately
 * quotes what genuinely appears in its own context — so no pattern can strip
 * it without destroying real critique. The two layers pinned here:
 *
 *  1. crossCheckArtifactGroundingRule (doctrine side, EVERY L2 run): quote an
 *     artifact only when present verbatim in the lane's own context, name
 *     where it is read from, and say exactly "not present in my provided
 *     context" instead of reconstructing — fragments are not the artifact.
 *  2. crossCheckDraftsHeader (injection side): artifact citations in a draft
 *     are NOT the orchestrator's evidence — an artifact the main lane cannot
 *     see in ITS context is UNVERIFIED until confirmed with its own tools.
 *
 * Wiring pins use the repo's readFileSync idiom (cross-check-scope.test.ts):
 * they FAIL on the pre-fix service and PASS with the fix.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { crossCheckArtifactGroundingRule } from './cross-check-scope';
import { crossCheckDraftsHeader } from './cross-check-action-claims';

const SERVICE_SOURCE = readFileSync(join(__dirname, 'chat-agent.service.ts'), 'utf8');

/**
 * The phantom artifact from the incident draft, kept as the replay exhibit:
 * a "Progress Recap" block with invented commands/outputs, woven from real
 * fragments (the wake clock + the credits topic).
 */
const PHANTOM_ARTIFACT = [
  'Progress Recap (00:13:34Z)',
  '$ curl https://api.openai.com/v1/credits',
  '{ "balance": "$12.40" }',
  'top-up already initiated',
].join('\n');

describe('crossCheckArtifactGroundingRule — doctrine content (ticket ce9ee48d)', () => {
  const rule = crossCheckArtifactGroundingRule();

  it('mandates the exact hedge phrase for artifacts absent from the lane context', () => {
    expect(rule).toContain('not present in my provided context');
    expect(rule).toContain('say exactly');
  });

  it('restricts quoting to artifacts present verbatim, with a named source', () => {
    expect(rule).toContain('present verbatim in YOUR provided context');
    expect(rule).toContain('message/part id');
  });

  it('names the incident failure mode — real fragments woven into an unseen artifact', () => {
    // The incident draft wove the real wake clock + credits topic into the
    // phantom recap; the rule must forbid that weave explicitly.
    expect(rule).toContain('NOT the artifact');
    expect(rule).toContain('fragments');
    expect(rule).toContain('fabrication');
  });

  it('states the main-assistant context is never visible to the lane', () => {
    // The phantom was attributed to "the orchestrator\'s context" — the rule
    // must tell the lane it cannot see that surface.
    expect(rule).toContain('NEVER visible to you');
  });

  it('cites the ticket for traceability', () => {
    expect(rule).toContain('ce9ee48d');
  });
});

describe('crossCheckDraftsHeader — injection-side hedge (ticket ce9ee48d)', () => {
  const header = crossCheckDraftsHeader(2);

  it('frames artifact citations in a draft as UNVERIFIED for the orchestrator', () => {
    expect(header).toContain('ARTIFACT CITATIONS IN A DRAFT ARE NOT YOUR EVIDENCE');
    expect(header).toContain('UNVERIFIED');
    expect(header).toContain('confirm it against your own tool evidence');
  });

  it('keeps the 0cbfa36e action-claims clause intact (no regression)', () => {
    expect(header).toContain('ACTION CLAIMS IN A DRAFT ARE NEVER ADOPTABLE');
    expect(header).toContain('almost certainly confabulated');
  });

  it('keeps the ensemble reconcile contract sentence byte-identical', () => {
    expect(header).toContain(
      'researched and answered the same question with their own live web tools. Verify against them: adopt what they got right, correct what they got wrong, and note real disagreements honestly.',
    );
  });
});

describe('lane wiring — the grounding rule reaches the L2 checker doctrine (ticket ce9ee48d)', () => {
  it('the service imports the rule from the leaf module', () => {
    expect(SERVICE_SOURCE).toContain('crossCheckArtifactGroundingRule');
    expect(SERVICE_SOURCE).toMatch(/import \{[^}]*crossCheckArtifactGroundingRule[^}]*\} from '\.\/cross-check-scope';/);
  });

  it('the rule is composed into the checker doctrine BEFORE the image block + system context', () => {
    // Position pin: the rule says "in YOUR provided context below" — it must
    // precede ${checkerImageBlock} and ${ctx.systemContext} in the template.
    const ruleIdx = SERVICE_SOURCE.indexOf('${crossCheckArtifactGroundingRule()}');
    expect(ruleIdx).toBeGreaterThan(-1);
    const doctrineIdx = SERVICE_SOURCE.indexOf('independent CROSS-CHECKER');
    expect(doctrineIdx).toBeGreaterThan(-1);
    expect(ruleIdx).toBeGreaterThan(doctrineIdx);
    const imageIdx = SERVICE_SOURCE.indexOf('${checkerImageBlock}', doctrineIdx);
    expect(imageIdx).toBeGreaterThan(ruleIdx);
    const sysIdx = SERVICE_SOURCE.indexOf('${ctx.systemContext}', doctrineIdx);
    expect(sysIdx).toBeGreaterThan(ruleIdx);
  });

  it('the rule applies to EVERY L2 run, not only supervisor chats', () => {
    // The composed template must apply the rule unconditionally — only the
    // fleet-scope note stays gated (isSupervisorChat OR machineWake — the
    // same flag the freshness preamble keys on, FS steer on f08fcd6f
    // 2026-10-03; before that gate-alignment it was isSupervisorChat alone).
    expect(SERVICE_SOURCE).toContain(
      // 2026-09-25: the platform-scope rule (cbe682c0) sits between the grounding rule and the image block — still unconditional.
      // 2026-09-28 (cohesive-chat doctrine): the verify-silence rule follows the platform-scope rule — still unconditional.
      '${crossCheckArtifactGroundingRule()}\\n\\n${crossCheckPlatformScopeRule()}\\n\\n${crossCheckVerifySilenceRule()}\\n\\n${checkerImageBlock}\\n${ctx.systemContext}${(isSupervisorChat || args.machineWake) ? `\\n\\n${crossCheckFleetScopeNote()}` : \'\'}',
    );
  });
});

describe('incident replay — the phantom exhibit is what the rule forbids (ticket ce9ee48d)', () => {
  it('the exhibit matches the failure shape the rule names (artifact + fragments)', () => {
    // Self-check of the replay exhibit: it is an "artifact" (a recap block
    // with command output) built from fragments (a timestamp + a topic) —
    // precisely what crossCheckArtifactGroundingRule now forbids narrating.
    expect(PHANTOM_ARTIFACT).toContain('Progress Recap (00:13:34Z)');
    const rule = crossCheckArtifactGroundingRule();
    expect(rule).toContain('recap');
    expect(rule).toContain('command output');
    expect(rule).toContain('timestamp');
  });
});
