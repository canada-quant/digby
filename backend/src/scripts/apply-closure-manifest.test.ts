/**
 * scripts/framework-audit/apply-closure-manifest.js — the coordinator's
 * on-demand closure-manifest probe (audit DOI-27): dry run by default (passes
 * dryRun:true to the deployed module), --apply runs the cron's own write once,
 * the report lists the evidence-gated entries + what would close + what is
 * pending, and a bad argument is a usage error.
 */
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const script: any = require(path.resolve(__dirname, '..', '..', '..', 'scripts', 'framework-audit', 'apply-closure-manifest.js'));

function makeManifest(result: any) {
  return {
    CLOSURE_MANIFEST: [
      { idPrefix: 'aaaaaaaa', adminNote: 'plain' },
      { idPrefix: '7acaa7ba', adminNote: 'gated', evidence: { commitSha: 'e18c15c4', deployRunId: '36472901762' } },
      { idPrefix: 'd6110694', adminNote: 'gated dup', evidence: { commitSha: 'e18c15c4' }, duplicateOf: '7acaa7ba' },
    ],
    applyClosureManifest: jest.fn(async () => result),
  };
}

describe('apply-closure-manifest.js', () => {
  it('parseArgs: dry-run default, --apply, usage error on an unknown flag', () => {
    expect(script.parseArgs([])).toEqual({ apply: false, help: false });
    expect(script.parseArgs(['--apply'])).toEqual({ apply: true, help: false });
    expect(() => script.parseArgs(['--nope'])).toThrow(/unknown argument/);
  });

  it('dry run: calls the module with dryRun:true and reports wouldClose / pending / the evidence-gated entries', async () => {
    const manifest = makeManifest({ applied: 0, wouldClose: [{ idPrefix: 'aaaaaaaa', rows: 1 }], pending: [{ idPrefix: '7acaa7ba', reason: 'not merged' }] });
    const report = await script.run({ manifest, argv: [] });
    expect(manifest.applyClosureManifest).toHaveBeenCalledWith({ dryRun: true });
    expect(report).toMatchObject({ dryRun: true, apply: false, entries: 3, applied: 0, modulePath: 'injected' });
    expect(report.wouldClose).toEqual([{ idPrefix: 'aaaaaaaa', rows: 1 }]);
    expect(report.pending).toEqual([{ idPrefix: '7acaa7ba', reason: 'not merged' }]);
    expect(report.evidenceGated).toEqual([
      { idPrefix: '7acaa7ba', evidence: { commitSha: 'e18c15c4', deployRunId: '36472901762' }, duplicateOf: null },
      { idPrefix: 'd6110694', evidence: { commitSha: 'e18c15c4' }, duplicateOf: '7acaa7ba' },
    ]);
  });

  it('--apply: calls the module with dryRun:false (the cron\'s own idempotent write)', async () => {
    const manifest = makeManifest({ applied: 2, wouldClose: [], pending: [] });
    const report = await script.run({ manifest, argv: ['--apply'] });
    expect(manifest.applyClosureManifest).toHaveBeenCalledWith({ dryRun: false });
    expect(report).toMatchObject({ apply: true, dryRun: false, applied: 2 });
  });

  it('a module without applyClosureManifest is an error, never a silent no-op', async () => {
    await expect(script.run({ manifest: { CLOSURE_MANIFEST: [] }, argv: [] })).rejects.toThrow(/no applyClosureManifest export/);
  });
});
