/**
 * provider-class.ts — seat governance VISIBILITY for the 2026-09-22
 * no-frontier doctrine (audit finding E3, 2026-09-27; review fixer the same
 * day). Pins the deterministic class derivation: frontier vendor HOSTS,
 * CLOSED-weight frontier MODEL-ID families behind a proxy (the
 * `api-anthropic-claude-fable-5-1` case on the Project Supervisor seat), the
 * open-weight families that carry a vendor's name (gpt-oss, gpt-2/j/neox,
 * cerebras-gpt, grok-1/2, gemma) staying OPEN, unparseable URLs failing open,
 * and the OPT-IN refusal switch FRONTIER_SEATS_REFUSE=1 (default observe-only).
 */

import {
  endpointProviderClass, modelIdIsFrontier, modelProviderClass, frontierSeatsAllowed, frontierSeatsRefuse, specIsFrontier,
  FRONTIER_HOST_PATTERNS, FRONTIER_MODEL_ID_PATTERNS, OPEN_WEIGHT_EXEMPT_RE,
} from './provider-class';

describe('specIsFrontier — the pickers\' spec-only fallback (frontier hard rule, owner 2026-10-06 late)', () => {
  it('classifies the MODEL id of a `<label>:<modelId>` spec (the label is a gateway name), built-ins stay open', () => {
    expect(specIsFrontier('cql-litellm:api-anthropic-claude-fable-5-1')).toBe(true);
    expect(specIsFrontier('cql-litellm:api-openai-gpt-6-astra')).toBe(true);
    expect(specIsFrontier('cql-litellm:api-xai-grok-5')).toBe(true);
    expect(specIsFrontier('claude-gateway:api-optimize-zai-glm-5.3')).toBe(false); // a label naming a vendor says nothing
    expect(specIsFrontier('cql-litellm:gpt-oss-120b')).toBe(false);
    for (const b of ['kimi-k3', 'glm-5.3', 'deepseek-flash', 'qwen3.6-27b']) expect(specIsFrontier(b)).toBe(false);
    expect(specIsFrontier('')).toBe(false);
    expect(specIsFrontier(null)).toBe(false);
  });
});

describe('endpointProviderClass — host-derived', () => {
  it.each([
    ['https://api.anthropic.com/v1', 'frontier'],
    ['https://api.openai.com/v1', 'frontier'],
    ['https://my-rg.openai.azure.com/openai/v1', 'frontier'],
    ['https://generativelanguage.googleapis.com/v1beta/openai', 'frontier'],
    ['https://us-central1-aiplatform.googleapis.com/v1', 'frontier'],
    ['https://api.x.ai/v1', 'frontier'],
    ['http://192.168.1.50:11434/v1', 'open'],
    ['https://api.studio.nebius.com/v1', 'open'],
    ['https://llm.example.com/v1', 'open'],
    ['https://openrouter.ai/api/v1', 'open'],
    ['https://api.deepseek.com', 'open'],
  ])('%s → %s', (url, expected) => {
    expect(endpointProviderClass(url)).toBe(expected);
  });

  it('a suffix match is by hostname label, never a substring (notopenai.com is open; x.ai needs the dot boundary)', () => {
    expect(endpointProviderClass('https://notopenai.com/v1')).toBe('open');
    expect(endpointProviderClass('https://box.ai/v1')).toBe('open');
    expect(endpointProviderClass('https://anthropic.com.evil.example/v1')).toBe('open');
  });

  it('fails open on an unparseable URL', () => {
    expect(endpointProviderClass('')).toBe('open');
    expect(endpointProviderClass('not a url')).toBe('open');
  });

  it('every host pattern is END-anchored (a vendor host can never be a prefix of an unrelated domain)', () => {
    for (const re of FRONTIER_HOST_PATTERNS) expect(re.source.endsWith('$')).toBe(true);
    expect(endpointProviderClass('https://api.openai.com.example.net/v1')).toBe('open');
  });
});

describe('modelIdIsFrontier — id-derived (the proxy case)', () => {
  it.each([
    'api-anthropic-claude-fable-5-1', // the E3 evidence id (the owner's Project Supervisor seat on the cql-litellm proxy)
    'claude-sonnet-4-20250514',
    'anthropic/claude-opus-4',
    'gpt-5.6-sol',
    'openai/gpt-5.6-luna',
    'gpt-4o',
    'gpt-4.1-mini',
    'azure-openai-gpt-4.1',
    'chatgpt-4o-latest',
    'gemini-3.1-pro-preview',
    'google/gemini-3.5-flash',
    'grok-4.5',
    'xai/grok-4',
    'grok-3-mini',
    'GPT-5.6', // case-insensitive
  ])('%s is frontier', id => {
    expect(modelIdIsFrontier(id)).toBe(true);
  });

  it.each([
    'qwen3:32b',
    'Qwen/Qwen3-32B',
    'deepseek-flash',
    'glm-5.3',
    'kimi-k3',
    'meta-llama/Llama-4-Maverick',
    'mistralai/Mistral-Large-3',
    'agx-laya',
    'agx-chat',
    '',
  ])('%s is open', id => {
    expect(modelIdIsFrontier(id)).toBe(false);
  });

  it('open-weight families that carry a frontier vendor name stay open (gpt-oss, gemma)', () => {
    expect(modelIdIsFrontier('openai/gpt-oss-120b')).toBe(false);
    expect(modelIdIsFrontier('gpt-oss-20b')).toBe(false);
    expect(modelIdIsFrontier('gpt_oss_120b')).toBe(false);
    expect(modelIdIsFrontier('google/gemma-3-27b-it')).toBe(false);
    expect(modelIdIsFrontier('codegemma-7b')).toBe(false);
  });

  // Review fixer 2026-09-27 (medium): the first cut keyed on VENDOR tokens
  // (openai / xai / gpt / grok) and classified these real open-weight
  // releases as frontier — on a self-hosted vLLM they are ordinary
  // `<label>:<modelId>` specs. Pinned open.
  it.each([
    'xai-org/grok-2',
    'xai-org/grok-1',
    'grok-1',
    'EleutherAI/gpt-j-6b',
    'EleutherAI/gpt-neox-20b',
    'cerebras/Cerebras-GPT-13B',
    'openai-community/gpt2',
    'openai/gpt-2',
    'openai/whisper-large-v3', // a vendor prefix alone never classifies
  ])('%s is an OPEN-WEIGHT release, not frontier', id => {
    expect(modelIdIsFrontier(id)).toBe(false);
  });

  it('matches families at a token boundary — a family name embedded in a longer token is not a hit', () => {
    expect(modelIdIsFrontier('grokking-7b')).toBe(false);
    expect(modelIdIsFrontier('gptq-llama-13b')).toBe(false);
    expect(modelIdIsFrontier('geminiscope')).toBe(false);
    expect(modelIdIsFrontier('claudette-7b')).toBe(false);
  });

  it('the family list names CLOSED lines only — no bare vendor token, and generational floors on gpt / grok', () => {
    const sources = FRONTIER_MODEL_ID_PATTERNS.map(re => re.source);
    for (const vendor of ['openai', 'anthropic', 'xai', 'google']) expect(sources.some(s => s.includes(vendor))).toBe(false);
    expect(sources.some(s => s.includes('gpt[-_ ]?[4-9]'))).toBe(true);
    expect(sources.some(s => s.includes('grok[-_ ]?[3-9]'))).toBe(true);
    expect(OPEN_WEIGHT_EXEMPT_RE.test('cerebras-gpt')).toBe(true);
    expect(OPEN_WEIGHT_EXEMPT_RE.test('grok-2')).toBe(true);
  });
});

describe('modelProviderClass — host OR id', () => {
  it('a frontier host is frontier regardless of the model id', () => {
    expect(modelProviderClass('https://api.openai.com/v1', 'qwen3:32b')).toBe('frontier');
  });
  it('an open host with a frontier model id is frontier (LiteLLM / OpenRouter proxy)', () => {
    expect(modelProviderClass('https://llm.example.com/v1', 'api-anthropic-claude-fable-5-1')).toBe('frontier');
    expect(modelProviderClass('https://openrouter.ai/api/v1', 'openai/gpt-5.6-sol')).toBe('frontier');
  });
  it('an open host with an open id is open', () => {
    expect(modelProviderClass('https://llm.example.com/v1', 'agx-laya')).toBe('open');
    expect(modelProviderClass('http://192.168.1.50:11434/v1', 'qwen3:32b')).toBe('open');
    expect(modelProviderClass('https://api.studio.nebius.com/v1', 'openai/gpt-oss-120b')).toBe('open');
    expect(modelProviderClass('http://vllm.local:8000/v1', 'xai-org/grok-2')).toBe('open');
  });
});

describe('frontierSeatsRefuse / frontierSeatsAllowed — the OPT-IN refusal switch', () => {
  const prev = process.env.FRONTIER_SEATS_REFUSE;
  afterEach(() => {
    if (prev === undefined) delete process.env.FRONTIER_SEATS_REFUSE; else process.env.FRONTIER_SEATS_REFUSE = prev;
  });
  it('refusal is OFF by default (observe-only) and ON only for the literal "1"; allowed is its inverse', () => {
    delete process.env.FRONTIER_SEATS_REFUSE;
    expect(frontierSeatsRefuse()).toBe(false);
    expect(frontierSeatsAllowed()).toBe(true);
    process.env.FRONTIER_SEATS_REFUSE = 'true';
    expect(frontierSeatsRefuse()).toBe(false);
    process.env.FRONTIER_SEATS_REFUSE = '1';
    expect(frontierSeatsRefuse()).toBe(true);
    expect(frontierSeatsAllowed()).toBe(false);
  });
  it('the retired FRONTIER_SEATS_ALLOWED variable is not read (the default is already allowed)', () => {
    process.env.FRONTIER_SEATS_ALLOWED = '0';
    try { expect(frontierSeatsAllowed()).toBe(true); } finally { delete process.env.FRONTIER_SEATS_ALLOWED; }
  });
});
