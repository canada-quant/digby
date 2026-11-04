/**
 * audit 2026-10-08 W2-11 — the frontier-council agreement line compares the
 * DIAGNOSIS lines too (stemmed key-word overlap / shared anchors), not only
 * whole NEXT STEP sentences. Before the fix every council since launch (5 / 5)
 * read "the advisors prescribe DIFFERENT next steps", including run 0134595f
 * (session 521edf42, 2026-10-08 09:32Z) where all three advisors named the
 * SAME cause. The REPLAY below is that council's real DIAGNOSIS / NEXT STEP
 * lines (framework-repo content: the stale supervisor-state test on a
 * 867-commit-stale session branch).
 */
import {
  agreementLine, councilAgreementV2Disabled, diagnosisAgreement, keyWords, overlapCoefficient, stemWord,
  compactCouncilResult, formatCouncilResult,
} from './frontier-council';

const CLAUDE = 'cql-litellm:api-anthropic-claude-opus-4-8';
const GPT = 'cql-litellm:api-openai-gpt-5.6-sol';
const GROK = 'cql-litellm:api-xai-grok-4.6';

// Run 0134595f — the three advisors' answers (head lines verbatim; supporting bullets trimmed).
const R_CLAUDE = [
  'DIAGNOSIS: The verify chain is deterministically red on a pre-existing, time-bomb test (`supervisor-state.service.test.ts:879`, hard-coded `NOW6 = 2026-09-19`) that main already fixed with a relative date — it is unrelated to the reviewed commit and no retry will turn it green.',
  '',
  'NEXT STEP: Apply main\'s existing fix to the stale test on the session branch — change `NOW6` to `Date.now() - 60_000` in `supervisor-state.service.test.ts` (or rebase the branch onto origin/main tip), then re-run `test:related`.',
  '',
  '- The dossier shows both failures are the identical `d-1d-39` vs `d-1d-9` assertion — one deterministic cause, not two.',
].join('\n');
const R_GPT = [
  'DIAGNOSIS: Both failures are the same deterministic stale-session-branch test bug: auto-verify tests the session worktree, whose frozen `NOW6 = 2026-09-19` causes real-clock archival and the `d-1d-39`→`d-1d-9` mismatch, rather than testing reviewed commit `0e124cf93`.',
  'NEXT STEP: Do not retry or modify this report-only review; finish by reporting the verify chain as deterministically blocked by the stale test fixture at `supervisor-state.service.test.ts:802/879`, noting that the suite passes at reviewed commit parent `99c613869c`.',
  '',
  '- The agent’s diagnosis is substantially correct.',
].join('\n');
const R_GROK = [
  'DIAGNOSIS: Auto-verify is deterministically failing on this session branch’s stale `supervisor-state.service.test.ts` (frozen `NOW6=2026-09-19` vs real-clock `archiveStaleDirectives`), not on commit `0e124cf9`; retries cannot pass and the report-only brief forbids a fix.',
  'NEXT STEP: Do not re-run verify or edit any test; treat the numbered findings already written as the final deliverable and stop.',
  '- Same assertion twice (`d-1d-39` vs `d-1d-9` at supervisor-state.service.test.ts:879) is clock-archive truncation, not flakiness.',
].join('\n');

const OLD_LINE = 'Agreement: the advisors prescribe DIFFERENT next steps — compare their NEXT STEP lines against your own evidence before acting.';

describe('REPLAY run 0134595f — three advisors, one diagnosis, three next steps', () => {
  const answers = [{ model: CLAUDE, text: R_CLAUDE }, { model: GPT, text: R_GPT }, { model: GROK, text: R_GROK }];

  it('reports the shared diagnosis and the differing next steps', () => {
    const line = agreementLine(answers);
    expect(line).toMatch(/^Agreement: all 3 advisors give the same diagnosis \(overlap ≥ \d\.\d\d\), but they prescribe DIFFERENT next steps/);
    expect(line).not.toBe(OLD_LINE);
    // the telemetry row keeps the first 200 chars — the verdict fits.
    expect(line.slice(0, 200)).toContain('same diagnosis');
    expect(line.slice(0, 200)).toContain('DIFFERENT next steps');
  });

  it('every diagnosis pair shares the stale-test anchors (now6 + 2026-09-19)', () => {
    const pairs: Array<[string, string]> = [[R_CLAUDE, R_GPT], [R_CLAUDE, R_GROK], [R_GPT, R_GROK]];
    const diag = (t: string) => /DIAGNOSIS:\s*(.+)/.exec(t)![1];
    for (const [a, b] of pairs) {
      const r = diagnosisAgreement(diag(a), diag(b));
      expect(r.agree).toBe(true);
      expect(r.anchors).toBeGreaterThanOrEqual(2);
    }
  });

  it('formatCouncilResult and compactCouncilResult carry the v2 line', () => {
    const calls = answers.map((a) => ({ model: a.model, ok: true, text: a.text, ms: 1000, inTokens: 1, outTokens: 1, tokensEstimated: false, usd: 0, priced: true }));
    expect(formatCouncilResult({ calls, chosenBy: 'harness', latencyMs: 35_000 })).toContain('give the same diagnosis');
    expect(compactCouncilResult({ calls })).toContain('give the same diagnosis');
  });

  it('kill switch FRONTIER_COUNCIL_AGREEMENT_V2_DISABLED=1 restores the v1 line byte-for-byte', () => {
    const prev = process.env.FRONTIER_COUNCIL_AGREEMENT_V2_DISABLED;
    process.env.FRONTIER_COUNCIL_AGREEMENT_V2_DISABLED = '1';
    try {
      expect(councilAgreementV2Disabled()).toBe(true);
      expect(agreementLine(answers)).toBe(OLD_LINE);
    } finally {
      if (prev === undefined) delete process.env.FRONTIER_COUNCIL_AGREEMENT_V2_DISABLED; else process.env.FRONTIER_COUNCIL_AGREEMENT_V2_DISABLED = prev;
    }
  });
});

describe('agreement v2 — the other shapes', () => {
  const A = 'cql-litellm:a-model';
  const B = 'cql-litellm:b-model';
  const C = 'cql-litellm:c-model';

  it('both dimensions agree', () => {
    const line = agreementLine([
      { model: A, text: 'DIAGNOSIS: the ticket ids are invented.\nNEXT STEP: call list_feedback to read real ticket ids before update_feedback.' },
      { model: B, text: 'DIAGNOSIS: invented ticket ids.\nNEXT STEP: read real ticket ids with list_feedback, then update_feedback.' },
    ]);
    expect(line).toMatch(/^Agreement: all 2 advisors prescribe a similar next step \(overlap ≥ \d\.\d\d\) and give the same diagnosis\.$/);
  });

  it('similar next step, different causes', () => {
    const line = agreementLine([
      { model: A, text: 'DIAGNOSIS: the network to the gateway is down.\nNEXT STEP: restart the dev container tailnet.' },
      { model: B, text: 'DIAGNOSIS: the provider key expired yesterday.\nNEXT STEP: restart the dev container tailnet now.' },
    ]);
    expect(line).toMatch(/^Agreement: all 2 advisors prescribe a similar next step .*on the cause: their diagnoses differ/);
  });

  it('nothing agrees — the v1 wording plus "their diagnoses differ"', () => {
    const line = agreementLine([
      { model: A, text: 'DIAGNOSIS: the network to the gateway is down.\nNEXT STEP: restart the tailnet.' },
      { model: B, text: 'DIAGNOSIS: a missing database migration.\nNEXT STEP: run prisma migrate deploy on box A.' },
    ]);
    expect(line).toBe('Agreement: the advisors prescribe DIFFERENT next steps and their diagnoses differ — compare their NEXT STEP lines against your own evidence before acting.');
  });

  it('a pair agrees on the cause, the third does not', () => {
    const line = agreementLine([
      { model: A, text: 'DIAGNOSIS: stale fixture in billing.service.test.ts pins 2026-09-19.\nNEXT STEP: rebase onto main.' },
      { model: B, text: 'DIAGNOSIS: billing.service.test.ts hard-codes 2026-09-19 as now.\nNEXT STEP: report it blocked.' },
      { model: C, text: 'DIAGNOSIS: the gateway is rate limiting.\nNEXT STEP: wait ten minutes.' },
    ]);
    expect(line).toMatch(/^Agreement: a-model and b-model give the same diagnosis \(overlap \d\.\d\d\); c-model diagnoses differently; the advisors prescribe DIFFERENT next steps/);
  });

  it('no DIAGNOSIS lines → next-step comparison only (v1 shape)', () => {
    expect(agreementLine([{ model: A, text: 'restart the tailnet' }, { model: B, text: 'run the migration' }])).toBe(OLD_LINE);
  });

  it('0 / 1 answers keep the v1 lines', () => {
    expect(agreementLine([])).toBe('Agreement: no advisor answered.');
    expect(agreementLine([{ model: A, text: 'DIAGNOSIS: x.\nNEXT STEP: y.' }])).toBe('Agreement: only a-model answered — no second opinion to compare.');
  });
});

describe('stemming + overlap helpers', () => {
  it('stems plurals / tenses, keeps identifiers whole', () => {
    expect(stemWord('tests')).toBe(stemWord('test'));
    expect(stemWord('testing')).toBe(stemWord('test'));
    expect(stemWord('failures')).toBe(stemWord('failure'));
    expect(stemWord('deterministically')).toBe(stemWord('deterministic'));
    expect(stemWord('fixes')).toBe('fix');
    expect(stemWord('supervisor-state.service.test.ts')).toBe('supervisor-state.service.test.ts');
    expect(stemWord('2026-09-19')).toBe('2026-09-19');
  });
  it('keyWords splits on punctuation, drops stop words, keeps anchors', () => {
    const k = keyWords('the `NOW6=2026-09-19` in supervisor-state.service.test.ts:879');
    expect(k.has('now6')).toBe(true);
    expect(k.has('2026-09-19')).toBe(true);
    expect(k.has('supervisor-state.service.test.ts')).toBe(true);
    expect(k.has('879')).toBe(true);
    expect(k.has('the')).toBe(false);
  });
  it('overlapCoefficient', () => {
    expect(overlapCoefficient(new Set(['a1', 'b2']), new Set(['a1', 'b2', 'c3', 'd4']))).toBe(1);
    expect(overlapCoefficient(new Set(), new Set(['x']))).toBe(0);
  });
});
