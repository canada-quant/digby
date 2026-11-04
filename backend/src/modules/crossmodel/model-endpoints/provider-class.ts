/**
 * Provider CLASS of a custom endpoint model — seat governance VISIBILITY for
 * the 2026-09-22 no-frontier doctrine (audit finding E3, 2026-09-27; review
 * fixer the same day).
 *
 * The doctrine deleted every frontier integration, but a custom endpoint
 * carried no provider class at all: model-endpoints.service validated URL
 * SHAPE only, so a LiteLLM-style proxy listing `api-anthropic-claude-fable-5-1`
 * next to open-weight ids is seated on the Project Supervisor with nothing on
 * the admin page saying what class it is. The seat itself is an OWNER setting
 * (deliberately swapped there; the supervisor doctrine tells lanes to probe a
 * seat with `test_model_role` before re-seating it) — so this leaf derives
 * the class DETERMINISTICALLY from what the admin already typed and the
 * default posture is OBSERVE-ONLY: badge + telemetry, never a refusal.
 *
 *  - endpointProviderClass(baseUrl): 'frontier' when the HOST is a frontier
 *    vendor's API (Anthropic / OpenAI incl. Azure OpenAI / Google Gemini and
 *    Vertex / xAI); 'open' otherwise (Ollama, vLLM, Nebius, LiteLLM, …).
 *  - modelProviderClass(baseUrl, modelId): the endpoint class, OR 'frontier'
 *    when the MODEL ID names a CLOSED-weight frontier family (claude / gemini /
 *    chatgpt / gpt-4 and up / grok-3 and up) — the proxy case above. Vendor
 *    names alone (`openai/…`, `xai-org/…`, `anthropic/…`) never classify: the
 *    same vendors publish open weights (gpt-oss, gpt-2/j/neox, grok-1/2,
 *    gemma), and those stay 'open' — pinned in provider-class.test.ts.
 *
 * Consumers: model-endpoints.service stamps `providerClass` on the endpoint
 * summary + `frontierModelIds`, and `providerClass:'frontier'` on a registry
 * resolution (present ONLY when frontier, like the `image` flag, so every
 * existing resolution pin stays byte-identical); model-roles.service
 * assertAssignable records ONE loop_metrics `seat_governance` row per
 * frontier-class assignment on the governed chat / supervisor seats
 * (outcome 'observed' by default) and listModelRoles badges a seat whose
 * EFFECTIVE model is frontier-class. Refusal is OPT-IN: FRONTIER_SEATS_REFUSE=1
 * makes the SAVE path (PUT /admin/model-roles, seats + custom fallbacks) 400
 * on such a spec; a PROBE (POST /admin/model-roles/test, the in-loop
 * `test_model_role`) is read-only and is never refused, and an owner-confirmed
 * `set_model_role_fallback` card passes even under refusal
 * (outcome 'allowed_by_owner'). The RUN PATH never consults this.
 */

export type ProviderClass = 'frontier' | 'open';

/** Opt-in enforcement: FRONTIER_SEATS_REFUSE=1 makes the admin SAVE path refuse
 *  a frontier-class endpoint model on the governed chat / supervisor seats.
 *  Default OFF = observe-only (badge + `seat_governance` telemetry; the owner's
 *  seat choice stands). Probes are never refused. */
export function frontierSeatsRefuse(): boolean {
  return process.env.FRONTIER_SEATS_REFUSE === '1';
}

/** The admin-facing view of the same switch: true (the default) = a
 *  frontier-class model may be saved on a governed seat (governance is
 *  observe-only); false = FRONTIER_SEATS_REFUSE=1 is set on this instance. */
export function frontierSeatsAllowed(): boolean {
  return !frontierSeatsRefuse();
}

/**
 * Hostnames that ARE a frontier vendor's API — the vendor's apex or any
 * subdomain (Vertex AI regional hosts are `<region>-aiplatform.googleapis.com`,
 * hence the dash boundary on that one entry). Kept to the vendors' own hosts:
 * a proxy in front of them (LiteLLM, OpenRouter) is classified per MODEL ID
 * instead, never by host. Anchored on a label boundary so `notopenai.com` or
 * `box.ai` never match.
 */
export const FRONTIER_HOST_PATTERNS: readonly RegExp[] = [
  /(^|\.)anthropic\.com$/,
  /(^|\.)openai\.com$/,
  /(^|\.)openai\.azure\.com$/,
  /^generativelanguage\.googleapis\.com$/,
  /(^|[.-])aiplatform\.googleapis\.com$/,
  /(^|\.)x\.ai$/,
];

/**
 * CLOSED-weight frontier model FAMILIES, matched on the lowercased id at a
 * token boundary. Vendor names are deliberately NOT here — `openai`,
 * `anthropic`, `xai`, `google` prefix open weights too (gpt-oss, gpt-j,
 * grok-2, gemma). The generational floors (`gpt-4`+, `grok-3`+) are what
 * separate the closed lines from the released ones (gpt-2 / gpt-j / gpt-neox /
 * cerebras-gpt / grok-1 / grok-2). `o1`/`o3`-style ids are not listed: too
 * short to be unambiguous and retired since the GPT-5.x line.
 */
export const FRONTIER_MODEL_ID_PATTERNS: readonly RegExp[] = [
  /(^|[^a-z0-9])claude([^a-z0-9]|$)/,
  /(^|[^a-z0-9])gemini([^a-z0-9]|$)/,
  /(^|[^a-z0-9])chatgpt([^a-z0-9]|$)/,
  /(^|[^a-z0-9])gpt[-_ ]?[4-9](?![0-9])/,   // gpt-4o, gpt-4.1, gpt-5.6-sol, gpt5 — not gpt2 / gpt-13b / gpt-oss / gpt-j
  /(^|[^a-z0-9])grok[-_ ]?[3-9](?![0-9])/,  // grok-3, grok-4.5 — not grok-1 / grok-2 / grokking
];

/**
 * Open-weight families that carry a frontier vendor's name — or a frontier
 * family's stem — in their id. An id matching one of these is 'open' even
 * when a family pattern would fire (`openai/gpt-oss-120b` on Nebius;
 * `google/gemma-3-27b` on vLLM; `cerebras/Cerebras-GPT-13B`, `EleutherAI/gpt-j-6b`,
 * `xai-org/grok-2` on a self-hosted server).
 */
export const OPEN_WEIGHT_EXEMPT_RE = /gpt[-_ ]?oss|gemma|codegemma|paligemma|gpt[-_ ]?j\b|gpt[-_ ]?neox?|gpt[-_ ]?2\b|cerebras[-_ ]?gpt|grok[-_ ]?[12]\b/i;

function hostOf(baseUrl: string): string {
  try { return new URL(String(baseUrl || '').trim()).hostname.toLowerCase(); } catch { return ''; }
}

/** The endpoint's class from its HOST alone ('open' for an unparseable URL — fail-open). */
export function endpointProviderClass(baseUrl: string): ProviderClass {
  const host = hostOf(baseUrl);
  if (!host) return 'open';
  return FRONTIER_HOST_PATTERNS.some(re => re.test(host)) ? 'frontier' : 'open';
}

/** True when the MODEL ID alone names a closed-weight frontier family (proxy case). */
export function modelIdIsFrontier(modelId: string): boolean {
  const id = String(modelId || '').toLowerCase();
  if (!id) return false;
  if (OPEN_WEIGHT_EXEMPT_RE.test(id)) return false;
  return FRONTIER_MODEL_ID_PATTERNS.some(re => re.test(id));
}

/** The class of ONE model on an endpoint: frontier host OR frontier model id ⇒ 'frontier'. */
export function modelProviderClass(baseUrl: string, modelId: string): ProviderClass {
  if (endpointProviderClass(baseUrl) === 'frontier') return 'frontier';
  return modelIdIsFrontier(modelId) ? 'frontier' : 'open';
}

/**
 * A model SPEC (a built-in id or `<label>:<modelId>`) names a closed frontier family — the id half only (the label is
 * an admin's name for a gateway and says nothing about the model). The spec-only fallback the automatic pickers use
 * when no catalog card is at hand (frontier-pick rule, owner 2026-10-06 late: "pickers should never choose frontier");
 * a card's own `frontier` flag (which also knows a frontier vendor HOST) wins wherever a card exists. Pure.
 */
export function specIsFrontier(spec: string | null | undefined): boolean {
  const s = String(spec ?? '');
  const i = s.indexOf(':');
  return modelIdIsFrontier(i >= 0 ? s.slice(i + 1) : s);
}
