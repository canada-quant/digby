/**
 * PROVIDER QUOTA / USAGE-LIMIT rejections are TRANSIENT (2026-09-29).
 *
 * Owner: "i thought the api optimize rotates through both coding plans and pay
 * per use we should never run out of token budgets". The owner's LiteLLM
 * gateway (llm.example.com `api-optimize-*` model groups) rotates each group across
 * coding-plan keys and pay-per-use keys, but a deployment that hits its plan
 * window answers HTTP 403 "You've reached your weekly (7-day) usage limit …"
 * and LiteLLM passes that 403 through instead of failing over (its router
 * fails over on 429 / 5xx; the deployment is cooled down only after repeated
 * failures). Digby then classified the 403 as a SIZE/MALFORMED rejection:
 * clip + compact, retry, and give up — prod 2026-09-29 23:xxZ, the
 * `api-optimize-moonshot-kimi-k3` group (Project Supervisor + Triple Checker
 * seats): 148 rejections, 100 needless shrinks, 48 runs given up, all inside
 * one hour; the next calls a minute later were served by a healthy key.
 *
 * Rule: a 402 / 403 / 429 whose text names a usage limit / quota / balance /
 * rate limit is TRANSIENT — back off and retry the SAME request (never shrink),
 * and on a lead seat it fails over exactly like a 429. A 403 without that
 * wording (bad key, forbidden model) is untouched. Pure leaf, no imports.
 */

/** Usage-limit / quota / balance / rate-limit wording (LiteLLM, OpenAI, Anthropic, DashScope, ZAI, Moonshot phrasings). */
export const PROVIDER_QUOTA_RE = /usage limit|reached your (?:weekly|daily|monthly|hourly|\d+[- ]?(?:day|hour))|quota (?:exceeded|reached|exhausted|will reset)|exceeded (?:your )?(?:current )?quota|exceeded_current_quota|insufficient[_ ](?:balance|quota|credits?)|credits? (?:exhausted|depleted)|rate[_ ]limit|too many requests|limit reached|plan limit/i;

/** Pure: is this failed turn a provider quota / usage-limit rejection (402 / 403 / 429 + quota wording)? */
export function isProviderQuotaRejection(turn: { errorStatus?: number; errorMessage?: string; providerError?: string }): boolean {
  const st = turn?.errorStatus;
  if (st !== 402 && st !== 403 && st !== 429) return false;
  return PROVIDER_QUOTA_RE.test(`${turn?.providerError ?? ''} ${turn?.errorMessage ?? ''}`);
}
