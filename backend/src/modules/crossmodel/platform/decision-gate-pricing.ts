/**
 * Decision-gate SPEND rows (owner 2026-09-28: "did you make sure to add jev to
 * api costs as well" — verified in prod: NO. 13,743 `decision_gate` rows /
 * 12.27M input tokens in 24 h and ZERO run_spend / run_tokens_* rows for any
 * decision backend, so Account → Admin → API costs showed nothing for Jev).
 *
 * Every decision-gate CALL that answered — the primary leg (whichever leg in
 * the chain answered, so a fallback counts), every challenger, the admin probe
 * — now mints the rows the cost explorer already understands, from
 * `recordDecisionRow` in decision-gate.ts:
 *   - run_tokens_in   value = prompt tokens (the backend's reported usage, else
 *                     the prefill's own ~4 chars/token estimate, `estimated:true`)
 *   - run_tokens_out  value = output tokens, only when > 0 (Jev answers with 0;
 *                     the logprob readout spends one token per question)
 *   - run_spend       ONE row, value = USD from the price table below,
 *                     meta.model = the backend's model id (`jev-1.13.0`,
 *                     `cql-litellm:agx-laya`, `deepseek-flash`),
 *                     meta.profile = 'decision', meta.purpose / backend /
 *                     backendSpec / decisionId, meta.challenger on challenger rows.
 * Memo hits (E3b) record NOTHING — no backend was called. Rows ride
 * `recordLoopMetrics` (the batch entry of loop-metrics.service), never the
 * decision row's own `recordLoopMetric` call, so the decision row stays the
 * first row an ask writes (the readiness pairing and the suites read it first).
 *
 * Attribution: `sessionId` = the chat / run the decision served when the
 * consumer passed one (DecideOpts.sessionId), else the synthetic session
 * `decision-gate` so the fleet totals still sum (the per-user rollup excludes
 * the synthetic id — it is framework overhead, not a user's spend).
 *
 * PRICES (USD per 1M tokens):
 *   - TypeSafe Jev — VENDOR LIST PRICE, docs.typesafe.ai/models (fetched
 *     2026-09-27): "$42 per billion input tokens" = $0.042 / M input; output
 *     tokens are not metered ($0). TYPESAFE_USD_PER_MTOK_IN / _OUT override
 *     the list price (a prepaid pack, a gateway markup).
 *   - A registry backend (`<label>:<modelId>` — Laya on cql-litellm) is priced
 *     by the endpoint registry: the model entry's `usdPerMTokIn/Out`, else the
 *     endpoint's `settings.usdPerMTokIn/Out`, else $0 flagged `self_hosted`
 *     (the panel shows a "self-hosted" badge, never a silent $0).
 *   - The DeepSeek logprob readout prices at the coding cost table's
 *     deepseek-flash list rate (coding/cost.ts PRICES).
 *   - Anything else is `unpriced` ($0 + a note) — the panel says so.
 */
import { PRICES } from '../coding/cost';
import type { LoopMetricInput } from './loop-metrics.service';

/** loop-metrics.service is loaded at CALL time, never at import: it boots the Prisma client, and this module is
 *  reached from the admin controllers (whose unit suites boot no database). A synchronous require keeps the row
 *  order deterministic (the decision row is already buffered when the spend batch lands) and honours jest mocks. */
function loopMetrics(): { recordLoopMetrics?: (rows: LoopMetricInput[]) => void } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('./loop-metrics.service');
}

export const DECISION_SPEND_PROFILE = 'decision';
/** The synthetic run_spend.sessionId for a decision that served no known chat / run. */
export const DECISION_GATE_SYNTHETIC_SESSION = 'decision-gate';
/** docs.typesafe.ai/models (2026-09-27): "$42 per billion input tokens"; output is not metered. */
export const TYPESAFE_LIST_USD_PER_MTOK_IN = 0.042;
export const TYPESAFE_LIST_USD_PER_MTOK_OUT = 0;
export const TYPESAFE_PRICE_SOURCE_URL = 'https://docs.typesafe.ai/models';
export const TYPESAFE_PRICE_ENV_IN = 'TYPESAFE_USD_PER_MTOK_IN';
export const TYPESAFE_PRICE_ENV_OUT = 'TYPESAFE_USD_PER_MTOK_OUT';
export type DecisionPriceSource = 'list' | 'env' | 'registry' | 'self_hosted' | 'unpriced';

export interface DecisionPrice {
  /** USD per 1M input tokens. */
  in: number;
  /** USD per 1M output tokens. */
  out: number;
  source: DecisionPriceSource;
  /** One line for the panel (where the number came from / what to set). */
  note: string;
}

/** A finite, non-negative USD/M value from an env var, else undefined. */
function envPrice(name: string): number | undefined {
  const raw = String(process.env[name] ?? '').trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** The TypeSafe Jev price in force: the env override when set, else the vendor list price. */
export function typesafePrice(): DecisionPrice {
  const envIn = envPrice(TYPESAFE_PRICE_ENV_IN);
  const envOut = envPrice(TYPESAFE_PRICE_ENV_OUT);
  if (envIn !== undefined || envOut !== undefined) {
    return {
      in: envIn ?? TYPESAFE_LIST_USD_PER_MTOK_IN,
      out: envOut ?? TYPESAFE_LIST_USD_PER_MTOK_OUT,
      source: 'env',
      note: `${TYPESAFE_PRICE_ENV_IN}${envOut !== undefined ? ` / ${TYPESAFE_PRICE_ENV_OUT}` : ''} override (list: $${TYPESAFE_LIST_USD_PER_MTOK_IN}/M in, $${TYPESAFE_LIST_USD_PER_MTOK_OUT}/M out)`,
    };
  }
  return {
    in: TYPESAFE_LIST_USD_PER_MTOK_IN,
    out: TYPESAFE_LIST_USD_PER_MTOK_OUT,
    source: 'list',
    note: `TypeSafe list price (${TYPESAFE_PRICE_SOURCE_URL}: $42 per billion input tokens; output not metered) — override with ${TYPESAFE_PRICE_ENV_IN} / ${TYPESAFE_PRICE_ENV_OUT}`,
  };
}

/** `jev-1.13.0`, `jev-latest`, `typesafe-ai/jev`, `typesafe/jev-1.13` … — any TypeSafe Jev id. */
export function isJevModelId(model: string | undefined | null): boolean {
  const m = String(model ?? '').trim().toLowerCase();
  if (!m) return false;
  return /^jev(-|$)/.test(m) || /^typesafe(-ai)?\//.test(m) || /(^|\/)jev(-|$)/.test(m);
}

export interface RegistryPriceHint {
  in?: number;
  out?: number;
}

/**
 * The price for a decision backend's model id. `registryPrice` is the resolved
 * `<label>:<modelId>` price (model entry, else endpoint settings) the gate
 * passes for registry backends; a registry model with no price is
 * `self_hosted` ($0, badged), never a silent list-price guess.
 */
export function decisionPriceFor(model: string, opts?: { registryPrice?: RegistryPriceHint | null }): DecisionPrice {
  const m = String(model ?? '').trim();
  if (isJevModelId(m)) return typesafePrice();
  if (m.includes(':')) {
    const rp = opts?.registryPrice;
    const hasIn = typeof rp?.in === 'number' && Number.isFinite(rp.in) && rp.in >= 0;
    const hasOut = typeof rp?.out === 'number' && Number.isFinite(rp.out) && rp.out >= 0;
    if (hasIn || hasOut) {
      return { in: hasIn ? rp!.in! : 0, out: hasOut ? rp!.out! : 0, source: 'registry', note: `endpoint registry price for ${m}` };
    }
    return { in: 0, out: 0, source: 'self_hosted', note: `self-hosted (${m.slice(0, m.indexOf(':'))}) — no registry price set; set usdPerMTokIn / usdPerMTokOut on the model or the endpoint` };
  }
  const listed = PRICES[m];
  if (listed) return { in: listed.in, out: listed.out, source: 'list', note: `coding/cost.ts list price for ${m}` };
  return { in: 0, out: 0, source: 'unpriced', note: `unpriced — no price table entry for ${m}` };
}

/** USD for one call at a price (never NaN / negative). */
export function decisionCallUsd(price: DecisionPrice, inTokens: number, outTokens: number): number {
  const i = Math.max(0, Number(inTokens) || 0);
  const o = Math.max(0, Number(outTokens) || 0);
  const usd = (i * price.in + o * price.out) / 1_000_000;
  return Number.isFinite(usd) && usd > 0 ? usd : 0;
}

/** ~4 chars/token — the same fallback coding/cost.ts uses when a provider omits usage. */
export function estimateDecisionPromptTokens(promptChars: number): number {
  const c = Math.max(0, Number(promptChars) || 0);
  return Math.ceil(c / 4);
}

export interface DecisionSpendInput {
  /** The decision row's meta.id (8 hex) — the idempotency key of the spend rows. */
  decisionId: string;
  purpose: string;
  /** The backend label ('TypeSafe Jev', 'DeepSeek logprob readout', '<label> (systemone)'). */
  backend: string;
  /** The backend spec ('jev' | 'deepseek-flash' | '<label>:<modelId>'). */
  backendSpec?: string;
  backendKind?: string;
  /** The model id the rows are priced under (spendModelFor). */
  model: string;
  sessionId?: string;
  /** The backend's reported usage (absent ⇒ estimated from promptChars). */
  inputTokens?: number;
  outputTokens?: number;
  /** State chars + questions chars actually sent — the estimate's input. */
  promptChars: number;
  challenger?: boolean;
  registryPrice?: RegistryPriceHint | null;
  /** The decision's wall-clock ms (kept on the run_spend row for the p50 readout). */
  ms?: number;
}

/** The provider name stamped on the rows (the explorer groups on it). */
export function decisionProviderOf(model: string, backendSpec?: string): string | undefined {
  if (isJevModelId(model) || backendSpec === 'jev') return 'typesafe';
  const m = String(model ?? '');
  const colon = m.indexOf(':');
  if (colon > 0) return m.slice(0, colon);
  if (m.startsWith('deepseek')) return 'deepseek';
  return undefined;
}

/**
 * The loop_metrics rows one decision call mints (pure — exported for the
 * backfill and the tests). Returns [] when nothing is known to have been
 * spent (no model). The run_spend row is ALWAYS minted for a known model,
 * even at $0 (an unpriced / self-hosted backend still counts as a call).
 */
export function decisionSpendRows(input: DecisionSpendInput): LoopMetricInput[] {
  const model = String(input.model ?? '').trim();
  if (!model || !input.decisionId) return [];
  const reported = typeof input.inputTokens === 'number' && Number.isFinite(input.inputTokens) && input.inputTokens > 0;
  const inTokens = reported ? Math.floor(input.inputTokens as number) : estimateDecisionPromptTokens(input.promptChars);
  const outTokens = typeof input.outputTokens === 'number' && Number.isFinite(input.outputTokens) && input.outputTokens > 0 ? Math.floor(input.outputTokens) : 0;
  const estimated = !reported;
  const price = decisionPriceFor(model, { registryPrice: input.registryPrice });
  const usd = decisionCallUsd(price, inTokens, outTokens);
  const provider = decisionProviderOf(model, input.backendSpec);
  const sessionId = input.sessionId && String(input.sessionId).trim() ? String(input.sessionId).trim() : DECISION_GATE_SYNTHETIC_SESSION;
  const runId = `dg-${input.decisionId}`;
  const common = {
    model,
    ...(provider ? { provider } : {}),
    profile: DECISION_SPEND_PROFILE,
    purpose: input.purpose,
    backend: input.backend,
    ...(input.backendSpec ? { backendSpec: input.backendSpec } : {}),
    ...(input.backendKind ? { backendKind: input.backendKind } : {}),
    decisionId: input.decisionId,
    ...(input.challenger ? { challenger: true } : {}),
    estimated,
  };
  const rows: LoopMetricInput[] = [];
  if (inTokens > 0) rows.push({ kind: 'run_tokens_in', sessionId, runId, value: inTokens, unit: 'tokens', meta: { ...common } });
  if (outTokens > 0) rows.push({ kind: 'run_tokens_out', sessionId, runId, value: outTokens, unit: 'tokens', meta: { ...common } });
  rows.push({
    kind: 'run_spend', sessionId, runId, value: usd, unit: 'usd',
    meta: {
      ...common,
      models: [model],
      turns: 1,
      inTokens, outTokens,
      priceSource: price.source,
      usdPerMTokIn: price.in, usdPerMTokOut: price.out,
      ...(price.source === 'unpriced' || price.source === 'self_hosted' ? { unpriced: true } : {}),
      ...(typeof input.ms === 'number' && Number.isFinite(input.ms) && input.ms >= 0 ? { ms: Math.round(input.ms) } : {}),
    },
  });
  return rows;
}

/** Fire-and-forget: mint the spend rows for one decision call. Never throws. */
export function recordDecisionSpend(input: DecisionSpendInput): void {
  try {
    const rows = decisionSpendRows(input);
    if (!rows.length) return;
    const lm = loopMetrics();
    if (typeof lm.recordLoopMetrics === 'function') lm.recordLoopMetrics(rows);
  } catch {
    /* telemetry never takes the gate down */
  }
}
