import {
  providerClassForModelId, defaultMaxToolsForClass, resolveMaxTools, OPENAI_MAX_TOOLS, GOOGLE_MAX_TOOLS, PROVIDER_CLASS_TOOL_LIMITS, PROVIDER_CLASSES,
  providerToolLimitDetail,
  learnToolLimit, learnedToolLimit, effectiveToolLimit, toolLimitKey, __resetLearnedToolLimitsForTests,
  parseToolCapFromError, toolTrimTier, trimToolsToLimit, toolTrimSystemNote, TOOL_TRIM_PINNED,
  customEndpointToolsMax, providerToolLimit,
} from './provider-limits';
import { PLATFORM_READ_TOOLS, PLATFORM_MUTATING_TOOLS } from '../platform/platform-tool-names';

const tool = (name: string) => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } });

beforeEach(() => { __resetLearnedToolLimitsForTests(); });

describe('provider class heuristic', () => {
  it('classifies OpenAI-like ids (the incident model) as openai', () => {
    expect(providerClassForModelId('api-openai-gpt-6-astra')).toBe('openai');
    expect(providerClassForModelId('gpt-5.6-sol')).toBe('openai');
    expect(providerClassForModelId('o3-mini')).toBe('openai');
    expect(providerClassForModelId('openai/gpt-4o')).toBe('openai');
  });
  it('classifies anthropic / google / other', () => {
    expect(providerClassForModelId('api-anthropic-claude-fable-5-1')).toBe('anthropic');
    expect(providerClassForModelId('gemini-3.5-flash')).toBe('google');
    expect(providerClassForModelId('spark-llama-4b-helper')).toBe('other');
    expect(providerClassForModelId('')).toBe('other');
    expect(providerClassForModelId(undefined)).toBe('other');
  });
  it('classifies the open-model vendors behind a proxy slug — never as OpenAI-like (the api-optimize-moonshot-kimi-k3 lesson)', () => {
    expect(providerClassForModelId('api-optimize-moonshot-kimi-k3')).toBe('moonshot');
    expect(providerClassForModelId('kimi-k3')).toBe('moonshot');
    expect(providerClassForModelId('api-deepseek-flash')).toBe('deepseek');
    expect(providerClassForModelId('deepseek-v4-pro')).toBe('deepseek');
    expect(providerClassForModelId('zai/glm-5.3')).toBe('zai');
    expect(providerClassForModelId('glm-5.3-flash')).toBe('zai');
    expect(providerClassForModelId('dashscope/qwen-plus')).toBe('dashscope');
    expect(providerClassForModelId('qwen-max')).toBe('dashscope');
    // open-weight Qwen on Ollama / Nebius / vLLM is NOT DashScope (model-endpoints.service.test.ts pins these as other)
    expect(providerClassForModelId('qwen3:32b')).toBe('other');
    expect(providerClassForModelId('Qwen/Qwen3-32B')).toBe('other');
    expect(providerClassForModelId('spark-qwen3-4b-helper')).toBe('other');
  });
  it('the class table carries ONLY documented caps: openai 128, google 512, everyone else unlimited', () => {
    expect(defaultMaxToolsForClass('openai')).toBe(OPENAI_MAX_TOOLS);
    expect(defaultMaxToolsForClass('google')).toBe(GOOGLE_MAX_TOOLS);
    for (const cls of ['anthropic', 'moonshot', 'deepseek', 'zai', 'dashscope', 'other'] as const) expect(defaultMaxToolsForClass(cls)).toBeUndefined();
    expect(Object.keys(PROVIDER_CLASS_TOOL_LIMITS).sort()).toEqual([...PROVIDER_CLASSES].sort());
  });
});

describe('resolveMaxTools precedence', () => {
  it('model > endpoint > class > none', () => {
    expect(resolveMaxTools({ modelId: 'api-openai-gpt-6-astra' })).toEqual({ limit: 128, source: 'class', providerClass: 'openai' });
    expect(resolveMaxTools({ modelId: 'api-openai-gpt-6-astra', endpointMaxTools: 100 })).toEqual({ limit: 100, source: 'endpoint', providerClass: 'openai' });
    expect(resolveMaxTools({ modelId: 'api-openai-gpt-6-astra', endpointMaxTools: 100, maxTools: 64 })).toEqual({ limit: 64, source: 'model', providerClass: 'openai' });
    expect(resolveMaxTools({ modelId: 'api-anthropic-claude-fable-5-1' })).toEqual({ source: 'none', providerClass: 'anthropic' });
    expect(resolveMaxTools({ modelId: 'api-optimize-moonshot-kimi-k3' })).toEqual({ source: 'none', providerClass: 'moonshot' });
    expect(resolveMaxTools({ modelId: 'gemini-3.5-flash' })).toEqual({ limit: 512, source: 'class', providerClass: 'google' });
  });
  it('an admin providerClass override beats the id heuristic', () => {
    expect(resolveMaxTools({ modelId: 'mystery-model', providerClass: 'openai' })).toEqual({ limit: 128, source: 'class', providerClass: 'openai' });
    expect(resolveMaxTools({ modelId: 'gpt-4o', providerClass: 'other' })).toEqual({ source: 'none', providerClass: 'other' });
    expect(resolveMaxTools({ modelId: 'gpt-4o', providerClass: 'bogus' }).providerClass).toBe('openai'); // invalid override ignored
  });
  it('ignores non-positive / non-numeric caps', () => {
    expect(resolveMaxTools({ modelId: 'x', maxTools: 0, endpointMaxTools: -3 })).toEqual({ source: 'none', providerClass: 'other' });
    expect(resolveMaxTools({ modelId: 'x', maxTools: 12.7 }).limit).toBe(12);
  });
});

describe('learned caps', () => {
  it('learns the smaller cap and folds it into the effective limit', () => {
    const key = toolLimitKey('https://llm.example.com/v1/chat/completions', 'api-openai-gpt-6-astra');
    expect(learnedToolLimit(key)).toBeUndefined();
    expect(learnToolLimit(key, 128)).toBe(128);
    expect(learnToolLimit(key, 200)).toBe(128); // never widens
    expect(learnToolLimit(key, 64)).toBe(64);
    expect(effectiveToolLimit({ url: 'https://LLM.example.com/v1/chat/completions', model: 'api-openai-gpt-6-astra' })).toBe(64);
    expect(effectiveToolLimit({ url: 'https://llm.example.com/v1/chat/completions', model: 'api-openai-gpt-6-astra', maxTools: 32 })).toBe(32);
    expect(effectiveToolLimit({ url: 'https://llm.example.com/v1/chat/completions', model: 'other', maxTools: 32 })).toBe(32);
    expect(effectiveToolLimit({ url: 'https://llm.example.com/v1/chat/completions', model: 'other' })).toBeUndefined();
  });
});

describe('parseToolCapFromError', () => {
  it('reads the incident body', () => {
    expect(parseToolCapFromError("litellm.BadRequestError: OpenAIException - Invalid 'tools': array too long. Expected an array with maximum length 128, but got an array with length 195.")).toBe(128);
  });
  it('reads other phrasings and refuses to guess', () => {
    expect(parseToolCapFromError('at most 64 tools are supported')).toBe(64);
    expect(parseToolCapFromError('maximum of 100 functions')).toBe(100);
    expect(parseToolCapFromError('tools limit is 50')).toBe(50);
    expect(parseToolCapFromError('too many tools')).toBeNull();
    expect(parseToolCapFromError('')).toBeNull();
    expect(parseToolCapFromError(undefined)).toBeNull();
  });
});

describe('trim tiers', () => {
  it('pins core + doctrine tools, tiers platform reads/actions, connectors last', () => {
    expect(toolTrimTier('read_file')).toBe(0);
    expect(toolTrimTier('update_supervisor_state')).toBe(0);
    expect(toolTrimTier('get_account_overview')).toBe(0);
    expect(toolTrimTier('list_session_files')).toBe(1);   // platform read, not pinned
    expect(toolTrimTier('create_canvas')).toBe(2);        // platform action, not pinned
    expect(toolTrimTier('gmail_search')).toBe(3);
    expect(toolTrimTier('gmail_send_email')).toBe(4);
    expect(toolTrimTier('slack_post_message')).toBe(4);
    expect(toolTrimTier('x_get_trends')).toBe(3);
    expect(toolTrimTier('totally_unknown_tool')).toBe(2);
    expect(toolTrimTier('')).toBe(2);
  });
  it('every pinned name is a real tool (platform list, coding workspace tool, web/document tool or delegate) — no typos in the pin list', () => {
    // The non-platform names, as tools.ts BASE_CODING_TOOL_SCHEMA + the chat
    // web/document tools + the delegate schemas define them (agent.ts).
    const codingAndWeb = new Set<string>([
      // view_image (2026-10-01): the coding vision read (coding/view-image.ts) — pinned so a capped seat keeps it.
      'read_file', 'view_image', 'list_dir', 'glob', 'grep', 'ast_search', 'ast_rewrite', 'write_file', 'edit_file', 'rewind_to_step', 'run_command',
      'git_status', 'git_diff', 'git_log', 'git_show', 'git_commit', 'git_push', 'open_pull_request', 'check_ci', 'merge_pull_request',
      // MERGE-INTENT-AWAIT (2026-10-20): the harness-side wait (coding/await-condition.ts) — pinned so a capped seat keeps it.
      'await_condition',
      'update_plan', 'verify', 'search_memory', 'search_code_semantic', 'web_pipe', 'youtube_pipe', 'start_background_process',
      'read_process_output', 'wait_for_process_output', 'list_processes', 'stop_process', 'ask_user', 'schedule_self',
      'search_engine', 'scrape_as_markdown', 'browser_task', 'computer_task', 'create_document', 'read_document', 'update_document',
      'list_files', 'fill_pdf_form', 'generate_image', 'delegate', 'delegate_parallel', 'delegate_status', 'load_tool_group', 'list_tool_groups', 'load_tools',
    ]);
    const known = new Set<string>([...PLATFORM_READ_TOOLS, ...PLATFORM_MUTATING_TOOLS, ...codingAndWeb]);
    const missing = TOOL_TRIM_PINNED.filter((n) => !known.has(n));
    expect(missing).toEqual([]);
  });
});

describe('trimToolsToLimit', () => {
  const list = [
    tool('gmail_send_email'), tool('read_file'), tool('gmail_search'), tool('create_canvas'), tool('list_session_files'),
    tool('update_supervisor_state'), tool('slack_post_message'), tool('x_get_trends'), tool('run_command'), tool('unknown_x'),
  ];
  it('returns the same reference when nothing needs trimming', () => {
    const r = trimToolsToLimit(list, 10);
    expect(r.tools).toBe(list);
    expect(r.dropped).toEqual([]);
    expect(trimToolsToLimit(list, undefined).tools).toBe(list);
    expect(trimToolsToLimit(list, 0).tools).toBe(list);
  });
  it('drops the lowest tiers first, keeps input order among survivors, and is a pure function of its input', () => {
    const r = trimToolsToLimit(list, 6);
    expect(r.from).toBe(10);
    expect(r.to).toBe(6);
    expect(r.tools.map((t) => t.function.name)).toEqual(['read_file', 'create_canvas', 'list_session_files', 'update_supervisor_state', 'run_command', 'unknown_x']);
    expect(r.dropped).toEqual(['gmail_send_email', 'gmail_search', 'slack_post_message', 'x_get_trends']);
    expect(r.droppedGroups).toEqual(['connector writes', 'connector reads']);
    // determinism
    expect(trimToolsToLimit(list, 6)).toEqual(r);
    expect(list.length).toBe(10); // never mutates
  });
  it('trims inside a tier by input order when the limit cuts through it', () => {
    const r = trimToolsToLimit(list, 3);
    expect(r.tools.map((t) => t.function.name)).toEqual(['read_file', 'update_supervisor_state', 'run_command']);
    expect(r.droppedGroups).toEqual(['connector writes', 'connector reads', 'platform actions', 'platform reads']);
  });
  it('the incident shape: 195 tools on a 128-cap model keeps every pinned tool', () => {
    const many = [
      ...TOOL_TRIM_PINNED.map(tool),
      ...Array.from({ length: 40 }, (_, i) => tool(`gmail_thing_${i}`)),
      ...Array.from({ length: 30 }, (_, i) => tool(`slack_post_thing_${i}`)),
      ...Array.from({ length: 10 }, (_, i) => tool(`misc_${i}`)),
    ];
    const r = trimToolsToLimit(many, 128);
    expect(r.to).toBe(128);
    const kept = new Set(r.tools.map((t) => t.function.name));
    for (const p of TOOL_TRIM_PINNED) expect(kept.has(p)).toBe(true);
    expect(r.dropped.every((n) => /^(gmail|slack|misc)_/.test(n))).toBe(true);
  });
  it('renders the one-line system note', () => {
    const note = toolTrimSystemNote({ from: 195, to: 128, droppedGroups: ['connector writes', 'connector reads'] }, 128, 'api-openai-gpt-6-astra');
    expect(note).toContain('at most 128 tools');
    expect(note).toContain('67 of the 195 tools are unavailable THIS turn');
    expect(note).toContain('connector writes, connector reads');
    expect(note.split('\n')).toHaveLength(1);
  });
  it('opts.plain asks for the first-N shape explicitly — never the cap (the b085607e shape)', () => {
    // The env kill switch is GONE (deleted 2026-11-02, RSW-1): first-N is now
    // an explicit caller opt-in only, so this pins the surviving claim — the
    // shape is available on request and the CAP itself never switches off.
    const r = trimToolsToLimit(list, 6, { plain: true });
    expect(r.to).toBe(6);
    expect(r.tools).toEqual(list.slice(0, 6)); // plain first-N in input order
    expect(r.dropped).toEqual(['slack_post_message', 'x_get_trends', 'run_command', 'unknown_x']);
    expect(r.droppedGroups).toEqual(['connector writes', 'connector reads', 'platform actions', 'core']);
    // the default is the priority order — run_command survives, it is core
    expect(trimToolsToLimit(list, 6).tools.map((t) => t.function.name)).toContain('run_command');
    expect(trimToolsToLimit(list, 6, { plain: false }).tools.map((t) => t.function.name)).toContain('run_command');
  });
});

describe('the provider limit — NO blanket default (2026-09-27 late: "who said 128 is the limit??")', () => {
  const custom = { url: 'https://llm.example.com/v1/chat/completions', model: 'api-openai-gpt-6-astra', label: 'cql-litellm (custom endpoint)' };
  const kimiProxy = { url: 'https://llm.example.com/v1/chat/completions', model: 'api-optimize-moonshot-kimi-k3', label: 'api-optimize (custom endpoint)' };
  const builtin = { url: 'https://api.z.ai/api/paas/v4/chat/completions', model: 'glm-5.3', label: 'ZAI direct' };
  afterEach(() => { delete process.env.CUSTOM_ENDPOINT_TOOLS_MAX; });

  it('CUSTOM_ENDPOINT_TOOLS_MAX is OPT-IN: unset / invalid / non-positive ⇒ no blanket; a positive integer sets one', () => {
    expect(customEndpointToolsMax()).toBeUndefined();
    process.env.CUSTOM_ENDPOINT_TOOLS_MAX = 'not-a-number';
    expect(customEndpointToolsMax()).toBeUndefined();
    process.env.CUSTOM_ENDPOINT_TOOLS_MAX = '0';
    expect(customEndpointToolsMax()).toBeUndefined();
    process.env.CUSTOM_ENDPOINT_TOOLS_MAX = '-5';
    expect(customEndpointToolsMax()).toBeUndefined();
    process.env.CUSTOM_ENDPOINT_TOOLS_MAX = '50.9';
    expect(customEndpointToolsMax()).toBe(50);
    process.env.CUSTOM_ENDPOINT_TOOLS_MAX = '200';
    expect(customEndpointToolsMax()).toBe(200);
  });

  it('a proxy Kimi with no registry / endpoint / class / learned cap is UNLIMITED — no trim, no note (0 tools-too-long 400s ever in prod)', () => {
    expect(providerToolLimit(kimiProxy)).toBeUndefined();
    expect(providerToolLimitDetail(kimiProxy)).toEqual({ source: 'none' });
    const many = Array.from({ length: 196 }, (_, i) => tool(`t_${i}`));
    const r = trimToolsToLimit(many, providerToolLimit(kimiProxy));
    expect(r.tools).toBe(many);
    expect(r.dropped).toEqual([]);
  });

  it('providerToolLimit: built-ins never capped; custom endpoints take the specific cap (registry / learned), else the OPT-IN blanket, else none', () => {
    expect(providerToolLimit(builtin)).toBeUndefined();
    expect(providerToolLimit({ ...builtin, maxTools: 10 })).toBeUndefined();
    expect(providerToolLimit(custom)).toBeUndefined();                     // an OpenAI-like id with NO registry cap: the class cap is the registry's to resolve
    process.env.CUSTOM_ENDPOINT_TOOLS_MAX = '200';
    expect(providerToolLimit(custom)).toBe(200);                          // opt-in blanket
    expect(providerToolLimit({ ...custom, maxTools: 64 })).toBe(64);      // a specific cap beats the blanket
    learnToolLimit(toolLimitKey(custom.url, custom.model), 32);
    expect(providerToolLimit({ ...custom, maxTools: 64 })).toBe(32);      // a learned cap tightens it
  });

  it('the source is HONEST: model / endpoint / class / learned / blanket / none — never "learned" unless a 400 body taught it', () => {
    expect(providerToolLimitDetail({ ...custom, maxTools: 128, maxToolsSource: 'class' })).toEqual({ limit: 128, source: 'class' });
    expect(providerToolLimitDetail({ ...custom, maxTools: 100, maxToolsSource: 'endpoint' })).toEqual({ limit: 100, source: 'endpoint' });
    expect(providerToolLimitDetail({ ...custom, maxTools: 64, maxToolsSource: 'model' })).toEqual({ limit: 64, source: 'model' });
    expect(providerToolLimitDetail({ ...custom, maxTools: 64 })).toEqual({ limit: 64, source: 'model' }); // no source stamp ⇒ the registry's own
    process.env.CUSTOM_ENDPOINT_TOOLS_MAX = '150';
    expect(providerToolLimitDetail(custom)).toEqual({ limit: 150, source: 'blanket' });
    delete process.env.CUSTOM_ENDPOINT_TOOLS_MAX;
    learnToolLimit(toolLimitKey(custom.url, custom.model), 64);
    expect(providerToolLimitDetail({ ...custom, maxTools: 128, maxToolsSource: 'class' })).toEqual({ limit: 64, source: 'learned' }); // learned < configured
    learnToolLimit(toolLimitKey(custom.url, custom.model), 64);
    expect(providerToolLimitDetail({ ...custom, maxTools: 32, maxToolsSource: 'model' })).toEqual({ limit: 32, source: 'model' });   // configured < learned
    expect(providerToolLimitDetail(builtin)).toEqual({ source: 'none' });
  });
});
