/**
 * Process tag on loop_metrics rows (todo c0c0c52a, 2026-11-01).
 *
 * The gap this closes: loop_metrics has no host/process column and
 * sessionId/runId are null on every rag_rerank_call row, so two 9,002 ms
 * one-rung rerank rows (de56970c / 15de190c) could not be tied to a box.
 * The rerank bar was certified (p95 1,616 ms, n=41) while 71% of the remaining
 * dead wait stayed unattributable.
 *
 * What these tests pin:
 *   1. the tag shape host[/colour]@sha and its fallbacks;
 *   2. `@NOSHA` is reported, never omitted — a process with no DEPLOY_SHA
 *      passthrough is the exact blind spot that hid admin-relay-green from the
 *      4/4 ancestry gate;
 *   3. the sha rule never drifts from fleet/infra-watch's deploySha();
 *   4. on a REAL rag_* row, `proc` is the FIRST meta key — because the fleet
 *      telemetry view truncates meta at 240 chars, so a last-placed key is
 *      invisible on the surface the supervisor reads.
 */

import { processTag, processTagMeta, shortDeploySha } from './process-tag';

describe('processTag', () => {
  it('is host/colour@sha from BOX_NAME, BG_COLOR and DEPLOY_SHA', () => {
    expect(processTag({ BOX_NAME: 'box-a', BG_COLOR: 'green', DEPLOY_SHA: '3efeac28c9eef791bf150500b17ef0423d54450b' } as any))
      .toBe('box-a/green@3efeac28');
  });

  it('omits the colour when BG_COLOR is unset, but keeps the sha', () => {
    expect(processTag({ BOX_NAME: 'box-c', DEPLOY_SHA: '2531d1d096' } as any)).toBe('box-c@2531d1d0');
  });

  it('falls back to the 12-char container hostname when BOX_NAME is unset (infra-watch rule)', () => {
    expect(processTag({} as any, 'deadbeefcafe1234')).toBe('deadbeefcafe@NOSHA');
  });

  it('reports @NOSHA rather than omitting the sha — the admin-relay-green blind spot', () => {
    // admin-relay-green carries the RAG stack but reports DEPLOY_SHA=NONE, so it
    // was invisible to a gate built on "processes that report a sha". A named
    // NOSHA makes that visible in the data instead of hiding it.
    expect(processTag({ BOX_NAME: 'box-a', DEPLOY_SHA: 'NONE' } as any)).toBe('box-a@NOSHA');
    expect(processTag({ BOX_NAME: 'box-a', DEPLOY_SHA: '' } as any)).toBe('box-a@NOSHA');
    expect(processTag({ BOX_NAME: 'box-a' } as any)).toBe('box-a@NOSHA');
  });

  it('rejects a non-sha DEPLOY_SHA instead of stamping garbage (the compose "dev" default)', () => {
    expect(processTag({ BOX_NAME: 'box-b', DEPLOY_SHA: 'dev' } as any)).toBe('box-b@NOSHA');
  });

  it('never yields an empty host', () => {
    expect(processTag({} as any, '')).toBe('unknown@NOSHA');
  });

  it('processTagMeta is the spreadable first-key fragment', () => {
    const meta = processTagMeta({ BOX_NAME: 'box-b', DEPLOY_SHA: '3efeac28' } as any);
    expect(meta).toEqual({ proc: 'box-b@3efeac28' });
    expect(Object.keys(meta)).toEqual(['proc']);
  });
});

describe('shortDeploySha — the ONE sha rule shared with fleet deploySha()', () => {
  // fleet/infra-watch.service.ts deploySha() now DELEGATES here, so this is the
  // single definition rather than two that could drift. infra-watch.service.test.ts
  // still pins the delegated behaviour from the fleet side.
  const cases: Array<[string, string | undefined]> = [
    ['3efeac28c9eef791bf150500b17ef0423d54450b', '3efeac28'],
    ['2531d1d0', '2531d1d0'],
    ['deadbeef', 'deadbeef'],
    ['  6cb78fee  ', '6cb78fee'],
    ['dev', undefined],
    ['', undefined],
    ['NONE', undefined],
    ['zzzzzzz', undefined],
  ];
  it.each(cases)('shortDeploySha(%p) -> %p', (raw, expected) => {
    expect(shortDeploySha({ DEPLOY_SHA: raw } as any)).toBe(expected);
  });

  it('agrees with the tag it feeds', () => {
    const raw = '3efeac28c9eef791bf150500b17ef0423d54450b';
    expect(processTag({ BOX_NAME: 'x', DEPLOY_SHA: raw } as any).split('@')[1]).toBe(shortDeploySha({ DEPLOY_SHA: raw } as any));
  });
});

describe('rag_* metric rows carry proc first (truncation budget)', () => {
  it('the rule defends the live TELEMETRY_META_CHARS budget', () => {
    // Read the constant from SOURCE, not by import: fleet-telemetry pulls
    // config/database → config/env, which process.exit(1)s in a keyless jest env.
    // This still fails if the budget is raised/removed without revisiting the
    // "proc goes first" rule.
    const src = require('fs').readFileSync(require.resolve('../fleet/fleet-telemetry'), 'utf8');
    const m = /export const TELEMETRY_META_CHARS = (\d+);/.exec(src);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(240);
  });

  it('a full rag meta object keeps proc inside the first 240 chars', () => {
    // The real shape rag.service emits: proc first, then the per-attempt fields
    // plus the caller's extra (embed roll-ups add batchAttempts/batchFailures).
    const meta = {
      proc: 'box-a/green@3efeac28',
      target: 'dashscope:qwen3-rerank',
      ok: false,
      ms: 9002,
      errorKind: 'timeout',
      status: 504,
      lane: 'dashscope',
      batch: 3,
      unit: 'attempt',
      batchAttempts: 10,
      batchFailures: 4,
    };
    const serialized = JSON.stringify(meta);
    expect(serialized.slice(0, 240)).toContain('"proc":"box-a/green@3efeac28"');
    expect(Object.keys(meta)[0]).toBe('proc');
  });
});