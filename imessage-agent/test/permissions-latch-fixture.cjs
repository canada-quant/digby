/**
 * Latch fixture for permissions.2f646c10.test.mjs — runs as a FORKED child so
 * each scenario starts from a fresh module state (the dead-input latch is
 * sticky for the process lifetime, which is exactly what these pins assert).
 *
 * Receives a scenario name via IPC, drives the BUILT dist/permissions.js, and
 * reports { tripped } back to the parent.
 */

const { noteMoveResult, latchedDeadInput } = require('../dist/permissions.js');

process.on('message', (scenario) => {
  const seq = {
    'two-then-ok': [false, false, true],
    'three-dead': [false, false, false],
    'three-dead-then-ok': [false, false, false, true],
    'nulls-only': [null, null, null, null, null],
    'two-null-one': [false, false, null, false],
  }[scenario] || [];
  for (const v of seq) noteMoveResult(v);
  process.send({ tripped: latchedDeadInput() });
  process.exit(0);
});
