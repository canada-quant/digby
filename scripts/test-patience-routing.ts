#!/usr/bin/env node
/**
 * Live end-to-end test for patience-level routing.
 *
 * Hits the SSE stream endpoint with one short query per (patience × modelSet)
 * combination — 8 combos — and asserts the number of `model-response` events
 * matches the documented spec:
 *
 *   L1 'single'         — 1 model, no synthesis
 *   L2 'single_thinking'— 1 model thinking, no synthesis
 *   L3 'thinking'       — 3 models thinking + primary synthesizes
 *   L4 'deep_research'  — agentic across 3 models + primary synthesizes
 *
 * Costs real API tokens. Uses a brief prompt to minimize spend (~$0.10–$0.50 total).
 * webSearch=false everywhere to keep the test cheap & deterministic.
 *
 *   tsx scripts/test-patience-routing.ts
 *   BASE_URL=http://localhost:4000 tsx scripts/test-patience-routing.ts
 */

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const stamp = Date.now();
const USER = { email: `patience+${stamp}@digbytest.local`, password: 'P@ssw0rd1234', name: 'Patience' };
const QUERY = 'Say hi. One short sentence.';

type ModeKey = 'single' | 'single_thinking' | 'thinking' | 'deep_research';
type Spec = {
  mode: ModeKey;
  modelSet: 'frontier' | 'open_source';
  expectModels: number;   // expected count of `model-response` SSE events
  expectSynthesis: boolean; // expect at least one chunk event with content
  maxSeconds: number;
};

const SPECS: Spec[] = [
  { mode: 'single',          modelSet: 'frontier',    expectModels: 1, expectSynthesis: false, maxSeconds: 60  },
  { mode: 'single',          modelSet: 'open_source', expectModels: 1, expectSynthesis: false, maxSeconds: 60  },
  { mode: 'single_thinking', modelSet: 'frontier',    expectModels: 1, expectSynthesis: false, maxSeconds: 120 },
  { mode: 'single_thinking', modelSet: 'open_source', expectModels: 1, expectSynthesis: false, maxSeconds: 120 },
  { mode: 'thinking',        modelSet: 'frontier',    expectModels: 3, expectSynthesis: true,  maxSeconds: 240 },
  { mode: 'thinking',        modelSet: 'open_source', expectModels: 3, expectSynthesis: true,  maxSeconds: 240 },
  // Deep research only valid when authenticated and quota is available; skip by default
  // unless RUN_DEEP=1 is set, since it's slow + costly.
  ...(process.env.RUN_DEEP === '1'
    ? [
        { mode: 'deep_research' as const, modelSet: 'frontier' as const,    expectModels: 3, expectSynthesis: true, maxSeconds: 720 },
        { mode: 'deep_research' as const, modelSet: 'open_source' as const, expectModels: 3, expectSynthesis: true, maxSeconds: 720 },
      ]
    : []),
];

async function http(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, json, text };
}

async function register() {
  const r = await http('POST', '/api/auth/register', { body: USER });
  if (r.status !== 201) throw new Error(`register failed: ${r.status} ${r.text.slice(0, 200)}`);
  return { token: r.json.data.accessToken as string, userId: r.json.data.user.id as string };
}

async function setModelSet(token: string, modelSet: 'frontier' | 'open_source') {
  const r = await http('PUT', '/api/crossmodel/preferences', { token, body: { modelSet } });
  if (r.status !== 200) throw new Error(`setModelSet failed: ${r.status} ${r.text.slice(0, 200)}`);
}

type SseSummary = {
  modelResponseEvents: Array<{ model: string; modelUsed?: string; time?: number }>;
  deepResearchPhases: string[];
  chunkBytes: number;
  finalSummaryLength: number;
  errorEvents: string[];
  durationMs: number;
  completed: boolean;
};

async function runOne(token: string, mode: ModeKey): Promise<SseSummary> {
  const summary: SseSummary = {
    modelResponseEvents: [],
    deepResearchPhases: [],
    chunkBytes: 0,
    finalSummaryLength: 0,
    errorEvents: [],
    durationMs: 0,
    completed: false,
  };

  const url = new URL(`${BASE}/api/crossmodel/stream`);
  url.searchParams.set('message', QUERY);
  url.searchParams.set('mode', mode);
  url.searchParams.set('webSearch', 'false');
  url.searchParams.set('token', token);

  const startMs = Date.now();
  const res = await fetch(url.toString(), { headers: { Accept: 'text/event-stream' } });
  if (!res.body) throw new Error('no body on SSE response');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) continue;
      const payload = dataLine.slice(6).trim();
      if (!payload) continue;
      try {
        const evt = JSON.parse(payload);
        switch (evt.type) {
          case 'model-response':
            summary.modelResponseEvents.push({
              model: evt.data?.model,
              modelUsed: evt.data?.modelUsed,
              time: evt.data?.time,
            });
            break;
          case 'deep-research-phase':
            // Deep research emits phase progress events instead of model-response.
            // Each phase corresponds to plan / execute / reflect / verify / synth.
            if (evt.data?.phase) summary.deepResearchPhases.push(evt.data.phase);
            break;
          case 'chunk':
            summary.chunkBytes += (evt.data?.content?.length ?? 0);
            break;
          case 'complete':
            summary.finalSummaryLength = evt.data?.summary?.length ?? 0;
            summary.completed = true;
            break;
          case 'error':
            summary.errorEvents.push(evt.data?.message ?? 'unknown');
            break;
        }
      } catch {}
    }
  }
  summary.durationMs = Date.now() - startMs;
  return summary;
}

async function main() {
  console.log(`\nPatience routing live test against ${BASE}\n${'─'.repeat(70)}`);

  const { token } = await register();
  console.log(`Registered ${USER.email}\n`);

  let fails = 0;
  for (const spec of SPECS) {
    await setModelSet(token, spec.modelSet);
    process.stdout.write(`▸ ${spec.mode.padEnd(18)} × ${spec.modelSet.padEnd(12)}  →  `);
    let s: SseSummary;
    try {
      s = await runOne(token, spec.mode);
    } catch (e: any) {
      console.log(`\x1b[31mFAIL\x1b[0m ${e.message}`);
      fails++;
      continue;
    }

    // Deep research uses 'deep-research-phase' events instead of 'model-response'.
    const isDeep = spec.mode === 'deep_research';
    const okModels = isDeep
      ? s.deepResearchPhases.length >= 3   // at least plan/execute/synth
      : s.modelResponseEvents.length === spec.expectModels;
    const okSynth  = spec.expectSynthesis
      ? (s.chunkBytes > 50 || s.finalSummaryLength > 50)
      : true;
    const okTime   = s.durationMs <= spec.maxSeconds * 1000;
    const okErr    = s.errorEvents.length === 0;
    const okComp   = s.completed;
    const allOk    = okModels && okSynth && okTime && okErr && okComp;

    const detail = isDeep
      ? `phases=${s.deepResearchPhases.length}`
      : `models=${s.modelResponseEvents.length}/${spec.expectModels}`;
    const modelsList = s.modelResponseEvents.map((m) => `${m.model}(${m.modelUsed ?? '?'}, ${(m.time ?? 0).toFixed(1)}s)`).join(', ');
    console.log(
      `${allOk ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ` +
      `${detail} ` +
      `${s.chunkBytes ? `syn=${s.chunkBytes}b ` : ''}` +
      `final=${s.finalSummaryLength}b ` +
      `t=${(s.durationMs / 1000).toFixed(1)}s/${spec.maxSeconds}s ` +
      `err=${s.errorEvents.length}` +
      `${!allOk && !isDeep ? '\n         models: ' + modelsList : ''}` +
      `${!allOk && isDeep ? '\n         phases: ' + s.deepResearchPhases.join(' / ') : ''}` +
      (s.errorEvents.length ? '\n         errors: ' + s.errorEvents.join(' / ') : ''),
    );
    if (!allOk) fails++;
  }

  console.log(`\n${'─'.repeat(70)}\n${SPECS.length - fails}/${SPECS.length} combos passed`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
