/**
 * The task-kind twins (2026-10-20): scripts/e2e/model-bench.py carries its OWN copy of the kind vocabulary — `KINDS`
 * (the order matters: it must equal platform/task-kind.ts TASK_KINDS) and `GROUP_KIND` (every bench question group →
 * exactly one kind; must equal BENCH_GROUP_KIND) — because the bench is stdlib Python that runs on a laptop / a CI
 * runner with no backend build. A kind run (--kinds / --per-kind) titles every chat `… k:<kind>` from the question's kind (a corpus
 * entry's kind=<k> flag, else GROUP_KIND) and the ingest files the
 * row's quality under that kind, which the per-turn pick then reads for turns the task_kind decision classified with
 * TASK_KINDS — so a drift between the two lists files evidence under a kind the pick never asks for. This test reads
 * the Python file as TEXT (no interpreter needed in jest) and pins both literals; the Python self-test pins the same
 * pair from the other side (it parses task-kind.ts).
 */
import fs from 'fs';
import path from 'path';
import { BENCH_GROUP_KIND, TASK_KINDS } from '../modules/crossmodel/platform/task-kind';

const BENCH_PY = path.resolve(__dirname, '..', '..', '..', 'scripts', 'e2e', 'model-bench.py');
const src = fs.readFileSync(BENCH_PY, 'utf8');

/** `KINDS = ('a', 'b', …)` → ['a', 'b', …] (null when the literal is gone). */
function pyKinds(text: string): string[] | null {
  const m = text.match(/^KINDS\s*=\s*\(([^)]*)\)/m);
  return m ? [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]) : null;
}

/** `GROUP_KIND = { 'g': 'k', … }` (multi-line) → { g: k } (null when the literal is gone). */
function pyGroupKind(text: string): Record<string, string> | null {
  const m = text.match(/^GROUP_KIND\s*=\s*\{([\s\S]*?)^\}/m);
  if (!m) return null;
  const out: Record<string, string> = {};
  for (const [, g, k] of m[1].matchAll(/'([A-Za-z_]+)'\s*:\s*'([a-z]+)'/g)) out[g] = k;
  return out;
}

describe('model-bench.py task-kind twins', () => {
  it('KINDS equals TASK_KINDS, in order', () => {
    expect(pyKinds(src)).toEqual([...TASK_KINDS]);
  });

  it('GROUP_KIND equals BENCH_GROUP_KIND (same groups, same kinds)', () => {
    expect(pyGroupKind(src)).toEqual({ ...BENCH_GROUP_KIND });
  });

  it('the parsers read a drifted copy as a mismatch (the pin cannot pass vacuously)', () => {
    const drifted = src.replace(/^KINDS\s*=\s*\(/m, "KINDS = ('research', ").replace(/^GROUP_KIND\s*=\s*\{/m, "GROUP_KIND = {\n    'vague': 'writing',");
    expect(pyKinds(drifted)).not.toEqual([...TASK_KINDS]);
    expect(pyGroupKind(drifted)).not.toEqual({ ...BENCH_GROUP_KIND });
    expect(pyKinds('nothing here')).toBeNull();
    expect(pyGroupKind('nothing here')).toBeNull();
  });
});
