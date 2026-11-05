// verify-ttrd-schema-e2e.js — deployed-surface E2E for the verify-chain object-form fix
// (dispatched platform task 23:49Z 2026-10-01: verify tool ignored .digby/config.json in
// canada-quant/tt-rd). READ-ONLY against production: requires the DEPLOYED dist module
// inside the live backend container and calls its PURE functions; the only filesystem
// write is a throwaway mkdtemp under the container's /tmp, removed on exit. No DB, no
// network. Runs via prodq.sh so it exercises the dist actually serving traffic.
//
// Answers the three dispatched questions with live receipts:
//   (1) schema/location — .digby/config.json `verify[]` accepts BOTH the canonical
//       string form (keys into commands.*) and the hand-authored object form
//       [{name?, command?}] (resolveVerifyChain, verify.service.ts);
//   (2) `verified:false` does NOT gate discovery — proven behaviorally by flipping it;
//   (3) the pre-fix defect (object entry → "[object Object]" lookup → silently
//       dropped → "No verify chain configured") is gone on the deployed surface.
const fs = require('fs');
const os = require('os');
const path = require('path');
function out(k, v) { console.log(k + '=' + JSON.stringify(v)); }

// The EXACT tt-rd config from the dispatch (belt-and-braces: commands.* AND object-form
// verify[]; verified:false, docsHash and null-valued commands all present).
const TT_RD_CONFIG = {
  version: 1, defaultBranch: 'main', stack: null,
  commands: { install: null, dev: null, build: null,
    test: 'python3 -m pytest tests/ -q',
    testOne: 'python3 -m pytest tests/test_verify_chain.py -q',
    typecheck: 'python3 scripts/verify/check_py_compile.py',
    lint: 'bash scripts/verify/check_sh_syntax.sh' },
  verify: [ { name: 'typecheck', command: 'python3 scripts/verify/check_py_compile.py' },
            { name: 'lint', command: 'bash scripts/verify/check_sh_syntax.sh' },
            { name: 'test', command: 'python3 -m pytest tests/ -q' } ],
  docsHash: '...', verified: false,
  loop: { maxAutoVerifyIterations: 3, resumeStepBudget: 8, perCommandTimeoutMs: 300000,
          sameFailureStop: 2, oscillationWindow: 4, gatePullRequest: true },
  ignore: '.digbyignore',
};

(async () => {
  let fails = 0;
  const check = (name, cond, detail) => {
    if (!cond) fails++;
    out(name, cond ? 'PASS' : 'FAIL' + (detail ? ' ' + detail : ''));
  };
  const distPath = '/app/dist/modules/crossmodel/coding/verify.service.js';

  // (0) the deployed dist is the fixed build — surface its mtime for the wave correlation.
  try { out('dist_mtime', fs.statSync(distPath).mtime.toISOString()); } catch {}

  const svc = require(distPath);
  check('dist_exports_resolveVerifyChain', typeof svc.resolveVerifyChain === 'function');
  check('dist_exports_readDigbyConfig', typeof svc.readDigbyConfig === 'function');

  // (1) THE DEFECT: the exact tt-rd config must resolve a 3-stage chain (pre-fix: []).
  const chain = svc.resolveVerifyChain(TT_RD_CONFIG);
  check('ttrd_chain_len_3', chain.length === 3, 'got ' + JSON.stringify(chain.map(s => s.key)));
  check('ttrd_keys_order', JSON.stringify(chain.map(s => s.key)) === JSON.stringify(['typecheck', 'lint', 'test']),
        JSON.stringify(chain.map(s => s.key)));
  check('ttrd_typecheck_cmd', !!chain[0] && chain[0].command === 'python3 scripts/verify/check_py_compile.py');
  check('ttrd_lint_cmd', !!chain[1] && chain[1].command === 'bash scripts/verify/check_sh_syntax.sh');
  check('ttrd_test_cmd', !!chain[2] && chain[2].command === 'python3 -m pytest tests/ -q');

  // (2) verified:false does NOT gate chain discovery (flip it; chain must be identical).
  const flipped = JSON.parse(JSON.stringify(TT_RD_CONFIG)); flipped.verified = true;
  check('verified_flag_irrelevant',
        JSON.stringify(svc.resolveVerifyChain(TT_RD_CONFIG)) === JSON.stringify(svc.resolveVerifyChain(flipped)));

  // (3) full file path: .digby/config.json in a temp worktree → readDigbyConfig → chain.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttrd-verify-'));
  try {
    fs.mkdirSync(path.join(dir, '.digby'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.digby', 'config.json'), JSON.stringify(TT_RD_CONFIG, null, 2));
    const cfg = await svc.readDigbyConfig(dir);
    check('readDigbyConfig_parses', !!cfg && !!cfg.commands);
    const fileChain = svc.resolveVerifyChain(cfg);
    check('file_chain_len_3', fileChain.length === 3, 'got ' + JSON.stringify(fileChain.map(s => s.key)));
    check('loop_overrides_merge', svc.loopConfig(cfg).perCommandTimeoutMs === 300000,
          String(svc.loopConfig(cfg).perCommandTimeoutMs));
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }

  // (4) `only:['test']` filtering works over the object form (stage ids are stable).
  const onlyTest = svc.resolveVerifyChain(TT_RD_CONFIG, ['test']);
  check('only_test_single', onlyTest.length === 1 && onlyTest[0].key === 'test',
        JSON.stringify(onlyTest.map(s => s.key)));

  // (5) mixed forms dedupe by key; nameless inline entries reverse-map to commands.* keys.
  const mixed = svc.resolveVerifyChain({
    commands: TT_RD_CONFIG.commands,
    verify: ['lint',
             { name: 'lint', command: 'bash scripts/verify/check_sh_syntax.sh' },
             { name: 'test', command: 'python3 -m pytest tests/ -q' },
             { name: 'nope' },
             { command: 'python3 -m pytest tests/test_verify_chain.py -q' }],
  });
  check('mixed_dedupe_keys',
        JSON.stringify(mixed.map(s => s.key)) === JSON.stringify(['lint', 'test', 'testOne']),
        JSON.stringify(mixed.map(s => s.key)));

  // (6) legacy string-only form regression guard (the scaffolded canonical shape).
  const legacy = svc.resolveVerifyChain({ commands: { typecheck: 'tsc --noEmit', test: 'jest' },
                                          verify: ['typecheck', 'test', 'missing'] });
  check('legacy_string_form', JSON.stringify(legacy.map(s => s.key)) === JSON.stringify(['typecheck', 'test']),
        JSON.stringify(legacy.map(s => s.key)));

  // (7) degenerate configs still resolve EMPTY (the honest "No verify chain configured").
  check('empty_when_no_commands', svc.resolveVerifyChain({ verify: TT_RD_CONFIG.verify }).length === 0);
  check('empty_when_all_null', svc.resolveVerifyChain({ commands: { build: null }, verify: ['build'] }).length === 0);

  out('verdict', fails === 0 ? 'E2E_PASS' : 'E2E_FAIL(' + fails + ')');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { out('verdict', 'E2E_ERROR ' + (e && e.message)); process.exit(2); });
