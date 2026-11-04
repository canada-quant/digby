/**
 * Token + cost accounting for agent runs (orchestrator + subagents).
 *
 * Providers report exact usage in the FINAL stream chunk (stream_options
 * include_usage / ZAI sends it unconditionally). When a provider doesn't,
 * we estimate at ~4 chars/token — the UI marks those totals as estimates.
 * Prices are published vendor list rates (USD per 1M tokens; re-verified
 * 2026-10-08, build Q-1) — the meter is a spend indicator, not an invoice.
 */

export interface TurnUsage {
  promptTokens: number;
  completionTokens: number;
  /** Prompt tokens served from the provider's context cache (Moonshot
   *  `usage.cached_tokens`, billed ~10% of the input rate) — a subset of
   *  promptTokens, tracked so cost records show cache effectiveness. */
  cachedTokens?: number;
  /** true when derived from char counts instead of provider-reported usage */
  estimated: boolean;
}

export interface Price {
  in: number;
  out: number;
  /** USD per 1M CACHE-HIT prompt tokens (usage.cachedTokens). Absent = no
   *  documented cached rate → cached tokens bill at the full input rate
   *  (exactly the pre-cachedIn behavior; never a silent free ride). */
  cachedIn?: number;
} // USD per 1M tokens

/**
 * Exported so the price table is PINNED by a snapshot test (remediation P0
 * item v1#17) — a silent price edit fails CI until the test moves with it.
 */
// build 2026-10-08 Q-1 (pricing): every row below is a vendor LIST price read
// on the vendor's own pricing page on 2026-10-08, including the CACHED-input
// rate where the vendor publishes one:
//   Z.ai      https://docs.z.ai/guides/overview/pricing — GLM-5.3 and GLM-5.2
//             $1.40 in / $0.26 cached / $4.40 out (one flat price at any
//             prompt length); GLM-5.3-Flash $0.15 / $0.03 / $0.50. The old
//             glm rows ($0.60 / $2.20, no cached rate) under-reported GLM ~2x.
//   DeepSeek  https://api-docs.deepseek.com/quick_start/pricing — OFF-PEAK
//             list (the meter's convention; peak = 2x, 01–04 and 06–10 UTC
//             Mon–Fri): V4.1 Flash (and the legacy deepseek-v4-flash id it
//             serves) $0.15 miss / $0.003 hit / $0.60 out; V4 Pro (still
//             listed, V4-Pro-0813) $0.66 / $0.022 / $1.98.
//   Moonshot  https://platform.kimi.ai/docs/pricing/chat — kimi-k3 unchanged.
//   Alibaba   https://www.alibabacloud.com/help/en/model-studio/model-pricing
//             (Singapore, prompt ≤256K tier — the tier this fleet's 60–250k
//             prompts bill at): qwen3.6-flash $0.25 / $1.50, cached $0.025
//             (explicit cache only — 10% of input); qwen3.6-27b $0.60 / $3.60,
//             no cache discount.
// coding-model.ts now reads the cached count for every provider shape
// (prompt-cache-usage.ts, W3-2), so a cachedIn rate is billed on real hits.
// The retired rows stay so legacy-stamped spend rows keep re-pricing on read.
export const PRICES: Record<string, Price> = {
  'glm-5.3': { in: 1.4, out: 4.4, cachedIn: 0.26 },
  'glm-5.2': { in: 1.4, out: 4.4, cachedIn: 0.26 },
  'glm-5.3-flash': { in: 0.15, out: 0.5, cachedIn: 0.03 },
  'deepseek-v4-pro': { in: 0.66, out: 1.98, cachedIn: 0.022 },
  'deepseek-v4-flash': { in: 0.15, out: 0.6, cachedIn: 0.003 },
  // deepseek-flash = DeepSeek V4.1 Flash (cutover 2026-09-10).
  'deepseek-flash': { in: 0.15, out: 0.6, cachedIn: 0.003 },
  // kimi-k3 — VENDOR-SOURCED (moonshot-cache.ts research, verified 2026-09-02
  // against https://platform.kimi.ai/docs/pricing/chat-k3, re-read 2026-10-08):
  // $3.00/M input on a cache miss, $0.30/M on a cache hit (90% off), $15.00/M output.
  'kimi-k3': { in: 3.0, out: 15.0, cachedIn: 0.3 },
  'kimi-k2.6': { in: 0.6, out: 2.5 },
  'qwen3.6-27b': { in: 0.6, out: 3.6 },
  'qwen3.6-flash': { in: 0.25, out: 1.5, cachedIn: 0.025 },
};
export const DEFAULT_PRICE: Price = { in: 0.6, out: 2.4 };

/**
 * build 2026-10-08 Q-1: a GATEWAY model ('cql-litellm:api-optimize-zai-glm-5.3',
 * bare 'api-alibaba-qwen3.8-max', …) is priced by its model FAMILY — the vendor
 * list price of the model line it names, whoever hosts it. Before this, every
 * gateway id that was not exactly a built-in id fell to DEFAULT_PRICE
 * ($0.60 / $2.40, no cached rate): the owner's gateway GLM lanes metered at
 * less than half their list price and the frontier Project Supervisor seat
 * (claude-fable-5-1, $10 / $50) at 6% of it. Ordered, first match wins; every
 * pattern is anchored on a separator so a routing prefix ("api-optimize-zai-",
 * "api-alibaba-") is skipped and a longer model name (a "-flash" / "-max" /
 * dated snapshot of another line) never inherits the wrong row. Families with
 * no published per-token price (kimi-for-coding is a subscription; the
 * qwen3.8-open route; self-hosted RL checkpoints) are deliberately absent and
 * stay on DEFAULT_PRICE. Sources (read 2026-10-08):
 *   Alibaba  model-pricing (Singapore, ≤256K tier) + /context-cache: qwen3.8-max
 *            $2 / $6 and qwen3.8-flash $0.15 / $0.47 (their cached rate is shown
 *            only in the console — named exceptions to the 20% rule — so no
 *            cachedIn: hits bill at the full input rate); qwen3.7-max $2.5 / $7.5,
 *            qwen3.7-plus $0.40 / $1.60 (list, promo ignored) — implicit cache
 *            hits at 20% of input.
 *   Anthropic https://platform.claude.com/docs/en/about-claude/pricing — cache
 *            hits 0.1x input (0.025x on Fable 5.1, 0.05x on Opus / Sonnet 5.5).
 *   xAI      https://docs.x.ai/docs/models — grok-4.6 (<200K) $2 / $0.50 / $6.
 *   OpenAI   https://developers.openai.com/api/docs/pricing — gpt-5.6-sol
 *            (≤272K, promotional through at least 2026-11-21) $4 / $0.40 / $20.
 * A registry price (the endpoint entry's usdPerMTokIn/Out) still wins over all
 * of these. Kill switch SPEND_FAMILY_PRICING_DISABLED=1 restores the pre-change
 * lookup (exact id → bare id of a spec → DEFAULT_PRICE).
 */
export interface FamilyPrice { key: string; price: Price }
const SEP = '(?:^|[^a-z0-9.])';
const fam = (src: string, key: string, price: Price): readonly [RegExp, FamilyPrice] => [new RegExp(SEP + src, 'i'), { key, price }];
export const FAMILY_PRICES: ReadonlyArray<readonly [RegExp, FamilyPrice]> = [
  // Z.ai GLM
  fam('glm-5\\.3-flashx(?![a-z0-9.-])', 'glm-5.3-flashx', { in: 0.37, out: 1.25, cachedIn: 0.075 }),
  fam('glm-5\\.3-flash(?![a-z0-9.-])', 'glm-5.3-flash', PRICES['glm-5.3-flash']),
  fam('glm-5\\.[23](?![0-9.])(?!-flash)(?!-(?:air|mini|lite|nano|tiny|small))', 'glm-5.3', PRICES['glm-5.3']),
  // Moonshot Kimi
  fam('kimi-k3(?![a-z0-9.-])', 'kimi-k3', PRICES['kimi-k3']),
  // DeepSeek (off-peak list; a 4-digit snapshot suffix like "-0731" is the same line)
  fam('deepseek-(?:v4\\.1-flash|v4-1-flash|flash|v4-flash)(?:-\\d{4})?(?![a-z0-9.-])', 'deepseek-flash', PRICES['deepseek-flash']),
  fam('deepseek-v4-pro(?:-\\d{4})?(?![a-z0-9.-])', 'deepseek-v4-pro', PRICES['deepseek-v4-pro']),
  // Alibaba Qwen (hosted SKUs; a dated snapshot "-2026-05-26" is the same line; -next / -open / size tags are not)
  fam('qwen3\\.8-max(?:-\\d{4}-\\d{2}-\\d{2})?(?![a-z0-9.-])', 'qwen3.8-max', { in: 2.0, out: 6.0 }),
  fam('qwen3\\.8-flash(?:-\\d{4}-\\d{2}-\\d{2})?(?![a-z0-9.-])', 'qwen3.8-flash', { in: 0.15, out: 0.47 }),
  fam('qwen3\\.7-max(?:-\\d{4}-\\d{2}-\\d{2})?(?![a-z0-9.-])', 'qwen3.7-max', { in: 2.5, out: 7.5, cachedIn: 0.5 }),
  fam('qwen3\\.7-plus(?:-\\d{4}-\\d{2}-\\d{2})?(?![a-z0-9.-])', 'qwen3.7-plus', { in: 0.4, out: 1.6, cachedIn: 0.08 }),
  fam('qwen3\\.6-flash(?:-\\d{4}-\\d{2}-\\d{2})?(?![a-z0-9.-])', 'qwen3.6-flash', PRICES['qwen3.6-flash']),
  fam('qwen3\\.6-27b(?![a-z0-9.-])', 'qwen3.6-27b', PRICES['qwen3.6-27b']),
  // Anthropic Claude (ids use "-" or "." between version digits)
  fam('claude-fable-5[-.]1(?![0-9])', 'claude-fable-5.1', { in: 10, out: 50, cachedIn: 0.25 }),
  fam('claude-fable-5(?![-.]?[0-9])', 'claude-fable-5', { in: 10, out: 50, cachedIn: 1 }),
  fam('claude-opus-5[-.]5(?![0-9])', 'claude-opus-5.5', { in: 4, out: 20, cachedIn: 0.2 }),
  fam('claude-opus-5(?![-.]?[0-9])', 'claude-opus-5', { in: 5, out: 25, cachedIn: 0.5 }),
  fam('claude-opus-4[-.][5-8](?![0-9])', 'claude-opus-4.5+', { in: 5, out: 25, cachedIn: 0.5 }),
  fam('claude-sonnet-5[-.]5(?![0-9])', 'claude-sonnet-5.5', { in: 2, out: 10, cachedIn: 0.1 }),
  fam('claude-sonnet-5(?![-.]?[0-9])', 'claude-sonnet-5', { in: 2, out: 10, cachedIn: 0.2 }),
  // xAI / OpenAI (reflection-council frontier advisors)
  fam('grok-4[-.]6(?![0-9])', 'grok-4.6', { in: 2, out: 6, cachedIn: 0.5 }),
  fam('gpt-5[-.]6-sol(?![a-z0-9])', 'gpt-5.6-sol', { in: 4, out: 20, cachedIn: 0.4 }),
];

export function familyPricingDisabled(): boolean {
  const v = String(process.env.SPEND_FAMILY_PRICING_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/** The family price row a model id (bare, or the id half of a spec) belongs to, or null. Pure. */
export function familyPriceFor(model: string | null | undefined): FamilyPrice | null {
  const s = String(model ?? '');
  const colon = s.indexOf(':');
  const id = colon > 0 ? s.slice(colon + 1) : s;
  if (!id) return null;
  for (const [re, fp] of FAMILY_PRICES) if (re.test(id)) return fp;
  return null;
}

/** An admin-set registry price (USD / 1M tokens): the endpoint entry's usdPerMTokIn/Out. */
export interface RegistryPrice { in?: number | null; out?: number | null }

/**
 * Registry prices the run path resolved (coding-model.ts resolveProviderForRun
 * notes every custom endpoint spec it resolves — set when priced, cleared when
 * not), so the synchronous meter can apply them. Process-local; refreshed on
 * every run resolve; bounded by the number of registry specs.
 */
const registryPrices = new Map<string, RegistryPrice>();
export function noteRegistryPrice(spec: string, price: RegistryPrice | null | undefined): void {
  const key = String(spec ?? '').trim();
  if (!key || !key.includes(':')) return;
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (price && (ok(price.in) || ok(price.out))) {
    registryPrices.set(key, { ...(ok(price.in) ? { in: price.in } : {}), ...(ok(price.out) ? { out: price.out } : {}) });
  } else {
    registryPrices.delete(key);
  }
}
/** Test hook. */
export function __resetRegistryPricesForTests(): void { registryPrices.clear(); }

export type PriceSource = 'builtin' | 'registry' | 'family' | 'default';
export interface ResolvedPrice { price: Price; source: PriceSource; family?: string }

/**
 * The price row for a model key + where it came from.
 *   1. an exact built-in id (PRICES) — 'builtin'
 *   2. a spec ('<label>:<modelId>') with a registry price — 'registry' (the
 *      admin's in/out win; a side the admin left unset keeps the family /
 *      default value; cached input bills at the registry input rate — no
 *      documented cached rate is assumed for a typed price)
 *   3. the bare id of a spec in PRICES — 'builtin' (audit 2026-10-08 W3-4)
 *   4. the model id's family (FAMILY_PRICES) — 'family'
 *   5. DEFAULT_PRICE — 'default'
 * `registry` overrides the noted registry price (the API-costs view resolves it
 * from the registry itself). Steps 2 and 4 are skipped under
 * SPEND_FAMILY_PRICING_DISABLED=1 (the pre-change lookup).
 */
export function resolvePrice(model: string, registry?: RegistryPrice | null): ResolvedPrice {
  const direct = PRICES[model];
  if (direct) return { price: direct, source: 'builtin' };
  const m = typeof model === 'string' ? model : '';
  const colon = m.indexOf(':');
  const bareId = colon > 0 ? m.slice(colon + 1) : m;
  const familyOn = !familyPricingDisabled();
  const base = (): ResolvedPrice => {
    const bare = colon > 0 ? PRICES[bareId] : undefined;
    if (bare) return { price: bare, source: 'builtin' };
    const f = familyOn ? familyPriceFor(bareId) : null;
    if (f) return { price: f.price, source: 'family', family: f.key };
    return { price: DEFAULT_PRICE, source: 'default' };
  };
  if (familyOn && colon > 0) {
    const reg = registry !== undefined ? registry : registryPrices.get(m);
    const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
    if (reg && (ok(reg.in) || ok(reg.out))) {
      const b = base();
      const price: Price = {
        in: ok(reg.in) ? reg.in : b.price.in,
        out: ok(reg.out) ? reg.out : b.price.out,
        ...(!ok(reg.in) && typeof b.price.cachedIn === 'number' ? { cachedIn: b.price.cachedIn } : {}),
      };
      return { price, source: 'registry' };
    }
  }
  return base();
}

/**
 * The price row for a model key (see resolvePrice). audit 2026-10-08 W3-4:
 * spend rows key a custom endpoint by its registry spec ('<label>:<modelId>').
 */
export function priceFor(model: string, registry?: RegistryPrice | null): Price {
  return resolvePrice(model, registry).price;
}

/** The compact label a spend row carries for a non-built-in price ('family:glm-5.3' | 'registry' | 'default'); undefined for a built-in. */
export function priceSourceLabel(r: ResolvedPrice): string | undefined {
  if (r.source === 'builtin') return undefined;
  return r.source === 'family' && r.family ? `family:${r.family}` : r.source;
}

export function turnCostUsd(model: string, usage: TurnUsage, registry?: RegistryPrice | null): number {
  return costAtPrice(priceFor(model, registry), usage);
}

/** USD for one turn's usage at a price row. */
export function costAtPrice(p: Price, usage: TurnUsage): number {
  // Cache-hit pricing (v1#17): cachedTokens is a SUBSET of promptTokens —
  // clamp defensively, price the cached share at the cached rate (full input
  // rate when the model has no documented one) and the rest at the miss rate.
  const cached = Math.min(Math.max(usage.cachedTokens ?? 0, 0), usage.promptTokens);
  const cachedRate = p.cachedIn ?? p.in;
  return ((usage.promptTokens - cached) * p.in + cached * cachedRate + usage.completionTokens * p.out) / 1_000_000;
}

/**
 * build 2026-10-08 C: the dollars the provider prompt cache SAVED on one turn —
 * the cached share billed at the documented cached rate instead of the miss
 * rate (0 when the model documents no cached rate: the meter then bills hits
 * at the full rate and nothing was "saved"). run_spend sums it into
 * meta.cacheSavedUsd / noCacheUsd so the cache's value is visible in dollars.
 */
export function cacheSavedUsd(model: string, usage: TurnUsage): number {
  return cacheSavedAtPrice(resolvePrice(model).price, usage);
}

/** The cache saving at an already-resolved price (build 2026-10-08 C + Q-1: the same price the turn was billed at). */
export function cacheSavedAtPrice(p: Price, usage: TurnUsage): number {
  if (p.cachedIn === undefined) return 0;
  const cached = Math.min(Math.max(usage.cachedTokens ?? 0, 0), usage.promptTokens);
  return cached > 0 ? (cached * Math.max(0, p.in - p.cachedIn)) / 1_000_000 : 0;
}

/** ~4 chars/token fallback when the provider omits usage from the stream. */
export function estimateTurnUsage(promptChars: number, completionChars: number): TurnUsage {
  return {
    promptTokens: Math.ceil(promptChars / 4),
    completionTokens: Math.ceil(completionChars / 4),
    estimated: true,
  };
}

export interface AgentUsageRow {
  /** display key: 'Digby' for the orchestrator, worker title/role for subagents */
  agent: string;
  role?: string;
  model: string;
  /** audit 2026-10-08 W3-4: the registry spec ('<label>:<modelId>') a custom-endpoint
   *  model resolved from — the normalized key the spend rows use; absent on built-ins. */
  spec?: string;
  inTokens: number;
  outTokens: number;
  /** Cache-served prompt tokens (subset of inTokens); absent = none reported. */
  cachedTokens?: number;
  /**
   * The LARGEST single-turn prompt_tokens recorded under this row (E5,
   * context_window_used — pydantic-ai 2.51.0's surfaced primitive). inTokens is
   * a SUM across turns, so the loop's transcript size at its peak — the number
   * that a refill/compaction decision needs — is invisible in it. This is the
   * per-model fill numerator; the denominator is the model's context window.
   * Absent when no provider-reported turn landed on the row (estimate-only
   * rows have no trustworthy per-turn peak — they'd be a chars/4 artifact).
   */
  peakPromptTokens?: number;
  costUsd: number;
  /** build 2026-10-08 C: USD the prompt cache saved on this row (cacheSavedUsd); absent = none. */
  cacheSavedUsd?: number;
  /** build 2026-10-08 Q-1: where a NON-built-in price came from ('family:<key>' |
   *  'registry' | 'default') — rides the run_tokens_in row; absent on a built-in. */
  priceSource?: string;
  turns: number;
  estimated: boolean; // any turn estimated → row flagged
}

export interface RunUsage {
  /** Unique per accumulator (= per top-level run). Lets clients treat every
   *  snapshot as idempotent state for that run — SSE replays on reconnect
   *  simply overwrite the same run's entry instead of double-counting. */
  runId: string;
  totalInTokens: number;
  totalOutTokens: number;
  /** Cache-served prompt tokens across all agents (subset of totalInTokens). */
  totalCachedTokens?: number;
  totalCostUsd: number;
  turns: number;
  estimated: boolean;
  agents: AgentUsageRow[];
}

/**
 * One accumulator per top-level run, shared by the orchestrator and every
 * delegated worker (workers record under their own agent key so the sidebar
 * can break the spend out per subagent).
 */
export class UsageAccumulator {
  readonly runId: string;
  private rows = new Map<string, AgentUsageRow>();

  // ── Shared TURN ledger (WI-D, 2026-09-25) ──────────────────────────────────
  // A chat TURN is several agent loops: the lead orchestrator (plus its empty
  // /seat-fallback/leak retries), the Double Checker's full-peer run, council
  // colleagues and the one-shot reconcile pass. Only a top-level loop wrote
  // run_spend, so every non-lead seat metered $0 (prod: 0 deepseek-flash
  // run_tokens rows under profile=chat). In shared mode ONE accumulator rides
  // every loop of the turn; each loop RETAINS it for its lifetime, the caller
  // holds one reference until close(), and the settle callback (the caller's
  // single recordRunSpend) fires exactly once when the LAST hold drops — so a
  // checker that outlives the lead, or a retry after the first loop finished,
  // can never be dropped or double-counted. Plain accumulators (no
  // shareAcrossRuns) are byte-identical to before: retain/release are no-ops.
  private holds = 0;
  private settleFn: ((acc: UsageAccumulator) => void) | null = null;
  private settled = false;

  /** fixedRunId: a RESUMED run reuses its checkpoint's runId so commitRunUsage stays idempotent across processes. */
  constructor(fixedRunId?: string) {
    this.runId = fixedRunId ?? `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Turn this accumulator into a shared turn ledger. The caller takes ONE hold
   * (dropped by close()); `onSettle` runs once, when the last hold drops. A
   * loop that receives a shared ledger skips its own recordRunSpend (agent.ts
   * finalize) — the ledger's settle is the turn's single spend writer.
   */
  shareAcrossRuns(onSettle: (acc: UsageAccumulator) => void): this {
    this.settleFn = onSettle;
    this.holds += 1;
    return this;
  }

  /** true when this accumulator is a shared turn ledger (see shareAcrossRuns). */
  get shared(): boolean {
    return this.settleFn !== null;
  }

  /** Outstanding holds (tests / diagnostics). 0 for a plain accumulator. */
  get holdCount(): number {
    return this.holds;
  }

  /** A participant loop starts recording into the shared ledger. No-op unless shared. */
  retain(): void {
    if (this.settleFn) this.holds += 1;
  }

  /** A participant loop is done. The last release settles the ledger exactly once. No-op unless shared. */
  release(): void {
    if (!this.settleFn) return;
    this.holds = Math.max(0, this.holds - 1);
    if (this.holds === 0 && !this.settled) {
      this.settled = true;
      try { this.settleFn(this); } catch { /* the ledger never throws into a run */ }
    }
  }

  /** The caller drops its own hold (call from a finally — a turn that throws must still settle). */
  close(): void {
    this.release();
  }

  record(agent: string, model: string, usage: TurnUsage, role?: string, spec?: string): void {
    const key = `${agent} ${model}`;
    let row = this.rows.get(key);
    if (!row) {
      row = { agent, role, model, ...(spec ? { spec } : {}), inTokens: 0, outTokens: 0, costUsd: 0, turns: 0, estimated: false };
      this.rows.set(key, row);
    }
    row.inTokens += usage.promptTokens;
    row.outTokens += usage.completionTokens;
    if (usage.cachedTokens) row.cachedTokens = (row.cachedTokens ?? 0) + usage.cachedTokens;
    // E5 context-fill: keep the per-turn PEAK prompt_tokens (provider-reported
    // turns only — an estimated turn's promptTokens is a chars/4 artifact, not
    // a window measurement, and must never mint a peak).
    if (!usage.estimated && usage.promptTokens > (row.peakPromptTokens ?? 0)) {
      row.peakPromptTokens = usage.promptTokens;
    }
    // build 2026-10-08 Q-1: a custom endpoint prices by its spec (registry price >
    // family > default — resolvePrice); a built-in by its id, exactly as before.
    const priced = resolvePrice(spec || model);
    const source = priceSourceLabel(priced);
    if (source) row.priceSource = source;
    row.costUsd += costAtPrice(priced.price, usage);
    const saved = cacheSavedAtPrice(priced.price, usage); // build 2026-10-08 C (priced by Q-1's resolved price)
    if (saved > 0) row.cacheSavedUsd = (row.cacheSavedUsd ?? 0) + saved;
    row.turns += 1;
    row.estimated = row.estimated || usage.estimated;
  }

  snapshot(): RunUsage {
    const agents = [...this.rows.values()].sort((a, b) => b.costUsd - a.costUsd);
    const sum = (f: (r: AgentUsageRow) => number) => agents.reduce((s, r) => s + f(r), 0);
    return {
      runId: this.runId,
      totalInTokens: sum(r => r.inTokens),
      totalOutTokens: sum(r => r.outTokens),
      totalCachedTokens: sum(r => r.cachedTokens ?? 0),
      totalCostUsd: sum(r => r.costUsd),
      turns: sum(r => r.turns),
      estimated: agents.some(r => r.estimated),
      agents,
    };
  }
}
