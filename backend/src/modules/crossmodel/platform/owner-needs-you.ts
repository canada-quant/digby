/**
 * THE NEEDS-YOU UNION (todo 908f48a7, monitor lesson 5 — 2026-10-16).
 *
 * "Nothing needs the owner" was PROSE counted from OPEN CARDS ALONE across
 * nine Fleet Supervisor notes (chat c0e22e36, 2026-10-16: 970e4dcb, ec93e808,
 * 33e56bf7, d4a3eb4e, 19e43f7f, eb4f8455, 8847b231, ce0c7009, ff3bc329,
 * f561c547) while lane 24f1950e's deploy steps sat blocked on the owner's
 * APPROVED-BUT-NEVER-LANDED Tailscale ACL save (probes denied 14/14 through
 * 10:39Z; the cards were approved 10:31 PM the night before). An open-card
 * count is a PROXY for "work blocked on an owner action"; this module is the
 * computed view over the ledger it stands in for.
 *
 * This leaf is the shared home for the union so every render surface (the
 * project status card, the Fleet Supervisor's wake attention block, the
 * supervisor board digest) reads ONE definition — the model may add words, it
 * may never drop items. It lives in platform/ (NOT chat-agent/) because the
 * deterministic card path is hygienically isolated from chat-agent imports
 * (project-status.service.test.ts pins that boundary).
 */
import prisma from '../../../config/database';
import { isCounterQuestionRow, INLINE_OQ_ID_RE } from './owner-questions';

/**
 * The deduped needs-you union. COUNT semantics (aligned with the project
 * card's 2026-09-15 gate doctrine): an open owner card is ONE item; a
 * todo/goal gated on an OPEN card is SUBSUMED by that card (never a second
 * item — four todos gated on one card is one ask, not five); a row gated on
 * an ANSWERED card that is STILL blocked is an approved-but-never-landed
 * action (the Tailscale-ACL specimen class) — the owner already spoke and the
 * follow-up action has not landed, so it still needs the owner's attention.
 * `ownerBlocked` counts the subsumed rows for TRANSPARENCY (the render names
 * them so the model never drops them); `total` = openCards + answeredUnlanded.
 */
export interface NeedsYouUnion {
  total: number;
  /** open owner cards (OwnerQuestion status 'open') — each one item */
  openCards: number;
  /** todos/goals blocked on an owner action backed by an OPEN gate — subsumed by their cards, listed for transparency */
  ownerBlocked: number;
  /** rows gated on an ANSWERED card and still blocked — approved-but-never-landed actions, each one item */
  answeredUnlanded: number;
}

/** Pure: deduped sum. Never throws; negative/NaN legs read as 0. */
export function computeNeedsYouUnion(input: { openCards: number; ownerBlocked: number; answeredUnlanded: number }): NeedsYouUnion {
  const n = (v: unknown): number => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);
  const openCards = n(input.openCards);
  const ownerBlocked = n(input.ownerBlocked);
  const answeredUnlanded = n(input.answeredUnlanded);
  return { total: openCards + answeredUnlanded, openCards, ownerBlocked, answeredUnlanded };
}

/** '' when nothing needs the owner; else "N item(s) waiting on you (…breakdown…)" for card/update surfaces. */
export function needsYouSummary(u: NeedsYouUnion): string {
  if (!u.total) return '';
  const parts: string[] = [];
  if (u.openCards) parts.push(`${u.openCards} open question${u.openCards === 1 ? '' : 's'}`);
  if (u.answeredUnlanded) parts.push(`${u.answeredUnlanded} approved action${u.answeredUnlanded === 1 ? '' : 's'} not yet landed (yours to do)`);
  if (u.ownerBlocked) parts.push(`${u.ownerBlocked} further item${u.ownerBlocked === 1 ? '' : 's'} blocked on those open cards`);
  return `${u.total} item${u.total === 1 ? '' : 's'} waiting on you (${parts.join(', ')})`;
}

/** The one-line ground-truth directive rendered into supervisor wake context: the ONLY basis for any "nothing needs the owner" claim. */
export function needsYouDirectiveLine(u: NeedsYouUnion): string {
  return `NEEDS-YOU UNION (computed this wake — the ONLY basis for any "nothing needs the owner" / "Needs you: nothing" / "zero open questions" claim): ${u.total} item(s) = ${u.openCards} open owner card(s) + ${u.answeredUnlanded} approved action(s) not yet landed (${u.ownerBlocked} further item(s) are blocked on those open cards — subsumed, never extra). Work blocked on an approved-but-never-landed owner action NEEDS the owner even though no card is open — never count open cards alone.`;
}

/** A blocked todo/goal row claiming an owner gate — the classifier's input. */
export interface OwnerGatedRow {
  id: string;
  title: string;
  gateQuestionId?: string | null;
  blockedReason?: string | null;
  blockKind?: string | null;
}

/** An owner-question row flattened for classification. */
export interface OwnerGateCardView {
  id: string;
  status?: string | null;
  answer?: string | null;
  chosenOption?: string | null;
  answeredBy?: string | null;
  /** fea78360: the replacement card that superseded this one — a dismissed
   *  card WITH a successor is still a LIVE owner gate (the decision moved,
   *  it did not resolve); only a successor-less dismissal is the team's own
   *  rule. */
  supersededBy?: string | null;
}

export interface OwnerGatedClassification {
  /** rows gated on an OPEN card — subsumed by their cards (transparency) */
  ownerBlocked: OwnerGatedRow[];
  /** rows gated on an ANSWERED (real decision, non-counter-question) card and still blocked */
  answeredUnlanded: OwnerGatedRow[];
}

/**
 * Pure: classify blocked rows that claim an owner gate, by what backs the
 * claim — the same doctrine the project card renders (2026-09-15): open gate →
 * the owner really is asked (subsumed by the card); answered gate → the owner
 * already spoke and the follow-up action has not landed; no gate / dismissed /
 * counter-question → the team's own rule, NOT an owner item (returned in
 * neither bucket). Rows with no gateQuestionId and no inline oq_ id never
 * classify (a lane-written claim alone is not an owner item).
 */
export function classifyOwnerGatedRows(rows: OwnerGatedRow[] | null | undefined, cardsById: Map<string, OwnerGateCardView>): OwnerGatedClassification {
  const ownerBlocked: OwnerGatedRow[] = [];
  const answeredUnlanded: OwnerGatedRow[] = [];
  for (const r of rows ?? []) {
    if (!r || typeof r.id !== 'string') continue;
    INLINE_OQ_ID_RE.lastIndex = 0;
    const ids = [r.gateQuestionId ? String(r.gateQuestionId) : null, INLINE_OQ_ID_RE.exec(String(r.blockedReason ?? ''))?.[0] ?? null].filter(Boolean) as string[];
    if (!ids.length) continue;
    for (const id of ids) {
      const card = cardsById.get(id);
      if (!card) continue;
      const st = String(card.status ?? 'open'); // prod rows carry status; a partial mock reads as open
      if (st === 'open') { ownerBlocked.push(r); break; }
      // fea78360: a dismissed card superseded by a replacement is still
      // owner-gated — the decision lives on the successor card, so the row
      // keeps asking the owner (never classified as the team's own rule).
      if (st === 'dismissed' && card.supersededBy) { ownerBlocked.push(r); break; }
      if (st === 'answered' && !isCounterQuestionRow(card)) { answeredUnlanded.push(r); break; }
    }
  }
  return { ownerBlocked, answeredUnlanded };
}

/** The render-side union: counts plus the unlanded rows' titles (the lines the wake note must not drop). */
export interface NeedsYouUnionView extends NeedsYouUnion {
  /** titles of the approved-but-never-landed rows, oldest-first, capped */
  unlandedTitles: string[];
  /** titles of the rows gated on OPEN cards (subsumed by their cards) */
  ownerBlockedTitles: string[];
}

/**
 * The needs-you union for one owner scope (a project, or the whole account —
 * exactly one of userId / projectId). Fail-open per leg: ANY read error
 * returns null — the caller then renders nothing rather than a wrong
 * "nothing needs the owner" (the render surfaces keep their existing
 * sections; only the union section is skipped).
 */
export async function loadNeedsYouUnion(input: { userId?: string; projectId?: string | null }): Promise<NeedsYouUnionView | null> {
  // Per-leg fail-soft (the owner-status loader's shape): every read is its own
  // IIFE with an internal catch, so a partial prisma surface can never mint an
  // orphaned rejection (a sibling throwing synchronously mid-array-build).
  const leg = <T,>(body: () => Promise<T>, fallback: T): Promise<T> =>
    (async () => {
      try {
        return await body();
      } catch {
        return fallback;
      }
    })();
  try {
    if (!input.projectId && !input.userId) return null;
    const scope = input.projectId ? { projectId: input.projectId } : { userId: input.userId as string };
    const [openCards, gatedTodos, gatedGoals] = await Promise.all([
      leg(async () => {
        if (!input.projectId) return prisma.ownerQuestion.count({ where: { userId: input.userId as string, status: 'open' } });
        const chats = await prisma.crossModelChat.findMany({ where: { projectId: input.projectId }, select: { id: true } });
        return chats.length ? prisma.ownerQuestion.count({ where: { status: 'open', chatId: { in: chats.map((c: any) => c.id) } } }) : 0;
      }, 0),
      leg(async () => prisma.projectTodo.findMany({
        where: { ...scope, status: 'blocked', OR: [{ gateQuestionId: { not: null } }, { blockKind: 'owner' }] },
        select: { id: true, title: true, gateQuestionId: true, blockedReason: true, blockKind: true, updatedAt: true },
        orderBy: { updatedAt: 'asc' },
        take: 40,
      }), []),
      leg(async () => prisma.projectGoal.findMany({
        where: { ...scope, status: 'blocked', OR: [{ gateQuestionId: { not: null } }, { blockKind: 'owner' }] },
        select: { id: true, title: true, gateQuestionId: true, blockedReason: true, blockKind: true, updatedAt: true },
        orderBy: { updatedAt: 'asc' },
        take: 40,
      }), []),
    ]);
    const rows = [...(gatedTodos ?? []), ...(gatedGoals ?? [])] as unknown as OwnerGatedRow[];
    const gateIds = new Set<string>();
    for (const r of rows) {
      if (r.gateQuestionId) gateIds.add(String(r.gateQuestionId));
      INLINE_OQ_ID_RE.lastIndex = 0;
      const inline = INLINE_OQ_ID_RE.exec(String(r.blockedReason ?? ''))?.[0];
      if (inline) gateIds.add(inline);
    }
    const cardsById = new Map<string, OwnerGateCardView>();
    if (gateIds.size) {
      const cardRows = await prisma.ownerQuestion.findMany({
        where: { id: { in: [...gateIds] } },
        select: { id: true, status: true, answer: true, chosenOption: true, answeredBy: true, supersededBy: true },
      });
      for (const r of cardRows as any[]) cardsById.set(String(r.id), r);
    }
    const classified = classifyOwnerGatedRows(rows, cardsById);
    const union = computeNeedsYouUnion({
      openCards: Number(openCards) || 0,
      ownerBlocked: classified.ownerBlocked.length,
      answeredUnlanded: classified.answeredUnlanded.length,
    });
    return {
      ...union,
      unlandedTitles: classified.answeredUnlanded.map((r) => String(r.title ?? r.id)).slice(0, 6),
      ownerBlockedTitles: classified.ownerBlocked.map((r) => String(r.title ?? r.id)).slice(0, 6),
    };
  } catch {
    return null;
  }
}
