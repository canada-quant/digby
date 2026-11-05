/**
 * The ONE source of truth for the published pricing row (owner ruling
 * 2026-10-30 on the digby.ai copy layer: "no names models and it's free").
 *
 * ── THE MODEL HALF IS SETTLED, AND IT IS NOT A PLACEHOLDER ────────────────
 * "no names models" is a RULING, not a pending decision: every named
 * model-variant row comes off the site. This module used to export `MODEL_LINE`
 * (a null placeholder for a Digby-branded model line, e.g. "Digby fast / Digby
 * deep / Digby research"). That lever is RESOLVED — the placeholder is DELETED,
 * not left sitting at `null`, because a null placeholder is an invitation for a
 * later lane to fill it in. `pricing.test.ts` pins its absence, and the existing
 * `content.test.ts` vendor pin keeps model vendor names (Kimi, GLM, DeepSeek,
 * Qwen …) out of visible copy too.
 *
 * ── THE PRICE HALF IS NOT OURS TO PUBLISH ─────────────────────────────────
 * Putting a number on a public page — including "$0" — is the owner's call.
 * The decision card is open:
 *
 *   oq_88a750bc  OPEN, the live card. Three options: publish "Free / $0 CAD"
 *                outright · publish a $0 entry point and quote larger
 *                engagements · publish no number yet.
 *   oq_bc1d12fe  DISMISSED by the system as SUPERSEDED by the card above. That
 *                is not an owner ruling — never cite it as a decision, and
 *                never treat its dismissal as clearance to publish.
 *
 * WHO CONFIRMS IT: the owner (Paul) answers that card. Until then this constant
 * stays `null` and every price surface renders the unpublished/quote-on-request
 * wording.
 *
 * ── PUBLISHING IT IS ONE LINE ─────────────────────────────────────────────
 * Set `PUBLISHED_PRICE_CAD_PER_MONTH` to the confirmed per-seat CAD figure.
 * That single edit flips, consistently and at once:
 *   · the Digby cell of the price row on every /digby-vs-* page (`PRICING_ROW_VALUE`)
 *   · the visible cost FAQ on /private-ai and on all 30 city pages (`pricingAnswer()`)
 *   · the FAQPage `acceptedAnswer` for "how much does private Canadian AI cost"
 *     (same function — the visible answer and the structured data cannot drift)
 *   · the `Service.offers` node in the JSON-LD (`pricingOfferPrice()` /
 *     `pricingOfferDescription()`)
 * Never hard-code a price anywhere else. If a number appears on the site it
 * comes from here or it is unconfirmed.
 */

/**
 * THE PUBLISHED PRICE — owner ruling, 2026-10-30.
 *
 * Owner answered card `oq_88a750bc` verbatim: **"Free to start — publish a $0
 * entry point and keep larger engagements on 'contact us'"**. That is a decided
 * question, not a pending one: this constant is PUBLISHED at `0` and must not be
 * turned back into a null placeholder or re-asked as an owner question.
 *
 * What the ruling does and does not permit:
 *  · `0` IS published as the headline number — "free to start" is now a true,
 *    owned claim, not something we may not say.
 *  · Anything ABOVE $0 is unpriced and routed to "Contact us". So: **no named
 *    tiers, no dollar figures above $0, no Pro/Max/Enterprise price ladder.**
 *    Augure's CAD tier ladder is exactly what this ruling does not copy; a
 *    figure above $0 would be a price the owner has not given us.
 *
 * `null` remains a supported value (the row falls back to "Quoted on request")
 * so this stays one line to change in either direction — but today it is `0`.
 *
 * Predecessor card `oq_bc1d12fe` was DISMISSED by the system as superseded and
 * was never a ruling; `oq_88a750bc` is the one that decided this.
 *
 *   DONE(oq_88a750bc, answered 2026-10-30): published at $0, entry point only.
 */
export const PUBLISHED_PRICE_CAD_PER_MONTH: number | null = 0;

/**
 * True once a price is published. Since the owner's ruling this is `true`:
 * the site publishes the $0 entry point.
 */
export const PRICING_PUBLISHED = PUBLISHED_PRICE_CAD_PER_MONTH !== null;

/** What we say for anything above the published entry point. */
export const PRICING_ABOVE_ENTRY_CTA = 'Contact us';

/** The price rendered as a CAD amount ("CAD $0", "CAD $20"). */
function cad(n: number): string {
  return `CAD $${n}`;
}

/**
 * The price ROW's value for a given published price — the Digby cell in a
 * comparison-table price row.
 *
 * Published at 0 (today): **"Free to start"** with everything above it routed
 * to "Contact us" — the owner's exact shape, and deliberately not a tier
 * ladder. Published above 0: a from-price, which is what a buyer comparing
 * tiers can actually use. Unpublished: a plain invitation, no number.
 */
export function pricingRowValueAt(price: number | null): string {
  if (price === null) return 'Quoted on request';
  return price === 0 ? `Free to start; ${PRICING_ABOVE_ENTRY_CTA} for larger engagements` : `From ${cad(price)} a month`;
}

export const PRICING_ROW_VALUE: string = pricingRowValueAt(PUBLISHED_PRICE_CAD_PER_MONTH);

/**
 * The answer behind the cost FAQ for a given published price — used for the
 * VISIBLE answer AND the FAQPage JSON-LD `acceptedAnswer` at once, so the two
 * can never disagree.
 *
 * Deliberately contains no figure of any kind while unpublished: a number here
 * would be published the moment the page rendered, which is exactly what the
 * open owner card exists to prevent.
 *
 * Takes the price as an argument so `pricing.test.ts` can prove BOTH published
 * branches are well-formed without editing the shipped constant — the "this is
 * a one-line change" promise is tested, not merely claimed.
 */
export function pricingAnswerAt(price: number | null): string {
  if (price === null) {
    return 'Guest chat needs no account, so you can try it before any conversation about cost. Pricing for teams is quoted rather than published: tell us the size of the team and the deployment you need, and a person replies with a written number for your organisation. We would rather send a real quote than print a figure that could be wrong for your case.';
  }
  if (price === 0) {
    // Owner's option 2, not option 1: "$0 entry point" + larger engagements to
    // Contact us. NOT "free, full stop" — that was the option they did not pick,
    // and the difference is a commercial claim we must not overshoot.
    return 'Free to start, billed in Canadian dollars: the entry point is CAD $0 and no account is needed to begin. For larger engagements — more seats, more volume or a dedicated deployment — pricing is set with you rather than listed here, so contact us and a person replies with a written number. Heavier features such as deep research have daily limits.';
  }
  return `${cad(price)} per seat per month, billed in Canadian dollars, with no separate charge for the models that answer. Guest chat needs no account.`;
}

export function pricingAnswer(): string {
  return pricingAnswerAt(PUBLISHED_PRICE_CAD_PER_MONTH);
}

/**
 * French answer for the same cost question on the fr-CA page
 * (`/ia-souveraine-canada`). Behind the SAME constant as the English one, so
 * the two languages can never publish different numbers — and neither can
 * publish one before the owner answers.
 *
 * This replaced a "Digby est-il gratuit ? … Oui" entry: that page answered the
 * price question in the affirmative while the price is the owner's open card.
 */
export function pricingAnswerFrAt(price: number | null): string {
  if (price === null) {
    return 'La discussion invitée ne demande aucun compte : vous pouvez donc essayer avant toute conversation sur le coût. Le tarif pour les équipes est établi sur devis plutôt que publié : indiquez-nous la taille de l’équipe et le déploiement dont vous avez besoin, et une personne vous répond avec un montant écrit pour votre organisation. Nous préférons vous envoyer un vrai devis que d’afficher un chiffre qui pourrait ne pas correspondre à votre situation.';
  }
  if (price === 0) {
    return 'Gratuit pour commencer, facturé en dollars canadiens : le point d’entrée est de 0 $ CA et aucun compte n’est requis pour commencer. Pour les engagements plus importants — plus de sièges, plus de volume ou un déploiement dédié — le tarif est établi avec vous plutôt qu’affiché ici : contactez-nous et une personne vous répond avec un montant écrit. Certaines fonctions avancées, comme la recherche approfondie, ont des limites quotidiennes.';
  }
  return `${cad(price)} par siège et par mois, facturé en dollars canadiens, sans frais supplémentaires pour les modèles qui répondent. La discussion invitée ne demande aucun compte.`;
}

export function pricingAnswerFr(): string {
  return pricingAnswerFrAt(PUBLISHED_PRICE_CAD_PER_MONTH);
}

/** French version of the cost question, so the FAQ key flips with the answer. */
export const PRICING_FAQ_QUESTION_FR = 'Combien coûte une IA privée canadienne ?';

/** One-line offer description for the `Service.offers` schema node. */
export function pricingOfferDescriptionAt(price: number | null): string {
  if (price === null) return 'Pricing is quoted for the team and deployment you need; no list price is published yet.';
  if (price === 0) return 'Free to start at CAD $0; larger engagements are quoted on request.';
  return `From ${cad(price)} per seat per month.`;
}

export function pricingOfferDescription(): string {
  return pricingOfferDescriptionAt(PUBLISHED_PRICE_CAD_PER_MONTH);
}

/**
 * The `Service.offers` money properties for a given price.
 *
 * Published (today, per the owner's ruling): a real `price: '0'` with
 * `priceCurrency: 'CAD'` — now an OWNED claim, so it is correct for the
 * structured data to carry it. Unpublished (`null`): no money property at all,
 * because a schema Offer with `price: '0'` while nobody had decided would have
 * been a $0 claim published by accident.
 */
export function pricingOfferPriceAt(price: number | null): { price: string; priceCurrency: string } | Record<string, never> {
  if (price === null) return {};
  return { price: String(price), priceCurrency: 'CAD' };
}

export function pricingOfferPrice(): { price: string; priceCurrency: string } | Record<string, never> {
  return pricingOfferPriceAt(PUBLISHED_PRICE_CAD_PER_MONTH);
}

/**
 * The question the pricing FAQPage entry answers — one string, so the visible
 * FAQ and the structured data are generated from the same source.
 */
export const PRICING_FAQ_QUESTION = 'How much does private Canadian AI cost?';