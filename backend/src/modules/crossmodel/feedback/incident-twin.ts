/**
 * Same-chat INCIDENT TWINS (audit 2026-10-08 W5-2, goals.md F4).
 *
 * The incident: in chat 21faf114 the L2 lead filed 59a4407b ("web_pipe ingests
 * Bright Data SERP error docs as source — backend failure masquerades as 'no
 * data'") and, 136 s later, the cross-checker filed 9b944f30 ("web_pipe
 * returns the search provider's own docs / unrelated pages instead of query
 * results …") — the same defect in other words. The fuzzy dedupe compares
 * TITLE word sets only (Jaccard 0.21 here, bar 0.6), so both rows opened, the
 * fresh-lane dispatcher gave each its own lane, and the two lanes ran 2.5 h in
 * parallel into competing PRs #1339 / #1340 (~$19 wasted).
 *
 * The rule: an agent filing from the SAME chat/session as an open agent ticket
 * filed within INCIDENT_TWIN_WINDOW_MS is the same incident when the two
 * TEXTS (title + description) overlap — 3-word shingle overlap ≥ 0.15, or two
 * shared evidence anchors (a URL / a quoted span) with some title overlap, or
 * ≥ 6 shared evidence ids (run / commit / chat ids, PR numbers) covering ≥ 60 %
 * of the smaller id set. The later filing is stored as a LINKED duplicate
 * (context.duplicateOf, status done, autoDispatch:false) — recorded, never
 * dispatched — so ONE lane runs. Calibrated on the 51 same-session agent-ticket
 * pairs of the 21 days before the audit: the incident pair scores shingle 0.18
 * / 2 anchors; the Fleet Supervisor's re-filing of one frozen-deploy incident
 * (e1ccaa80 → 4b432e90, 12 min) shares 13 ids (87 %); every DISTINCT pair
 * inside 30 min scores ≤ 0.08 shingle, ≤ 1 anchor and ≤ 4 shared ids.
 *
 * Harness filings (verifier / class stamps) never take part — they have their
 * own class dedupe. Kill switch FEEDBACK_INCIDENT_TWIN_DEDUPE_DISABLED=1.
 *
 * STRICT (INCIDENT-TWIN-STRICT, 2026-10-20): the shingle leg alone over-linked
 * in prod — a sample of 7 twin links showed 7/7 joining DIFFERENT asks at 0
 * shared evidence anchors (a burst of findings from one review run shares its
 * boilerplate: "WHAT HAPPENED … EVIDENCE … SUGGESTED FIX"), and the linked row
 * is closed and never dispatched, so the second ask silently died. Now (1) a
 * shingle-only match also needs title Jaccard ≥ INCIDENT_TWIN_SHINGLE_TITLE_JACCARD_MIN
 * OR ≥ 1 shared evidence anchor (the 59a4407b/9b944f30 incident pair shares
 * 2 anchors and still twins; the anchors / ids legs are unchanged); (2) a
 * same-run BURST is never twinned — the same filer (run id + worker role)
 * within INCIDENT_TWIN_BURST_WINDOW_MS, or both filings carrying differing
 * series markers ("fix 2 of 5", "part 3", "finding 1"); (3) the ticket lane
 * brief lists every linked twin (ticket-dispatch buildTicketLaneBrief), so a
 * wrongly linked ask is at least read by the lane carrying it. Kill switch
 * INCIDENT_TWIN_STRICT_DISABLED=1 restores all three.
 *
 * LEAF: pure helpers only.
 */

import { isHarnessTicketContext } from './harness-ticket';

export const INCIDENT_TWIN_WINDOW_MS = 30 * 60_000;
export const INCIDENT_TWIN_SHINGLE_MIN = 0.15;
/** STRICT: a shingle-only match needs this title Jaccard … */
export const INCIDENT_TWIN_SHINGLE_TITLE_JACCARD_MIN = 0.3;
/** … or this many shared evidence anchors (a URL / a quoted span). */
export const INCIDENT_TWIN_SHINGLE_ANCHORS_MIN = 1;
export const INCIDENT_TWIN_ANCHORS_MIN = 2;
export const INCIDENT_TWIN_ANCHOR_TITLE_JACCARD_MIN = 0.2;
export const INCIDENT_TWIN_IDS_MIN = 6;
export const INCIDENT_TWIN_ID_OVERLAP_MIN = 0.6;
/** STRICT: two filings by the same filer (run id + worker role) this close are one run's burst of findings, never twins. */
export const INCIDENT_TWIN_BURST_WINDOW_MS = 120_000;
const TEXT_MAX = 3000;

export function incidentTwinDedupeDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|on|yes)$/i.test(String(env.FEEDBACK_INCIDENT_TWIN_DEDUPE_DISABLED ?? '').trim());
}

/** INCIDENT-TWIN-STRICT kill switch: '1' restores shingle-alone twins, no burst exemption, no twins section in the lane brief. */
export function incidentTwinStrictDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|on|yes)$/i.test(String(env.INCIDENT_TWIN_STRICT_DISABLED ?? '').trim());
}

const STOPWORDS = new Set((
  'the a an and or of to in on for is are was were be been it its this that with as at by from not no but if then than so into out up via per '
  + 'has have had do does did can could will would should may might must also only just over under after before about when while which who what '
  + 'where how why their there these those them they we our you your i me my he she his her all any each every some more most other such same own new'
).split(' '));

const norm = (s: unknown): string => String(s ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
const contentTokens = (s: unknown): string[] => norm(s).split(' ').filter((w) => w.length >= 3 && !STOPWORDS.has(w));

/** 3-word shingles over content tokens. Pure. */
export function shingles(text: unknown, n = 3): Set<string> {
  const t = contentTokens(text);
  const out = new Set<string>();
  for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n).join(' '));
  return out;
}

/** Evidence anchors: URLs and quoted spans (12–160 chars), normalized. Pure. */
export function evidenceAnchors(text: unknown): Set<string> {
  const s = String(text ?? '');
  const out = new Set<string>();
  for (const m of s.matchAll(/https?:\/\/[^\s)\]"'`>]+/g)) out.add(m[0].toLowerCase().replace(/[.,;:]+$/, ''));
  for (const m of s.matchAll(/["“]([^"”\n]{12,160})["”]/g)) {
    const q = norm(m[1]);
    if (q) out.add(q);
  }
  return out;
}

/** Evidence ids: 8-hex id prefixes (letters AND digits), 7+ digit run ids, PR numbers. Pure. */
export function evidenceIds(text: unknown): Set<string> {
  const s = String(text ?? '');
  const out = new Set<string>();
  for (const m of s.matchAll(/\b[0-9a-f]{8}(?:[0-9a-f]{0,32}|-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi)) {
    const x = m[0].toLowerCase().slice(0, 8);
    if (/\d/.test(x) && /[a-f]/.test(x)) out.add(x);
  }
  for (const m of s.matchAll(/\b\d{7,}\b/g)) out.add(m[0]);
  for (const m of s.matchAll(/(?:\bPR\s*#?|#)(\d{2,6})\b/gi)) out.add(`pr${m[1]}`);
  return out;
}

const overlapCoefficient = (a: Set<string>, b: Set<string>): number => {
  let i = 0;
  for (const x of a) if (b.has(x)) i++;
  const m = Math.min(a.size, b.size);
  return m ? i / m : 0;
};
const jaccard = (a: Set<string>, b: Set<string>): number => {
  let i = 0;
  for (const x of a) if (b.has(x)) i++;
  const u = a.size + b.size - i;
  return u ? i / u : 0;
};

export interface IncidentText { title: string; description: string }
export interface IncidentTwinScore {
  shingle: number; sharedAnchors: number; titleJaccard: number; sharedIds: number; idOverlap: number; twin: boolean; matchedBy: 'shingle' | 'anchors' | 'ids' | null;
  /** STRICT: the shingle bar alone was met but neither the title nor an anchor corroborated it (and no other leg matched). */
  strictRejected?: boolean;
}

/** Score two filings; `twin` applies the calibrated bar (STRICT by default — see the header). Pure given opts. */
export function scoreIncidentTwin(a: IncidentText, b: IncidentText, opts: { strict?: boolean } = {}): IncidentTwinScore {
  const strict = opts.strict ?? !incidentTwinStrictDisabled();
  const textA = `${a.title ?? ''} ${a.description ?? ''}`.slice(0, TEXT_MAX);
  const textB = `${b.title ?? ''} ${b.description ?? ''}`.slice(0, TEXT_MAX);
  const shingle = overlapCoefficient(shingles(textA), shingles(textB));
  const anchorsA = evidenceAnchors(textA);
  let sharedAnchors = 0;
  for (const x of evidenceAnchors(textB)) if (anchorsA.has(x)) sharedAnchors++;
  const titleJaccard = jaccard(new Set(contentTokens(a.title)), new Set(contentTokens(b.title)));
  const idsA = evidenceIds(textA);
  const idsB = evidenceIds(textB);
  let sharedIds = 0;
  for (const x of idsA) if (idsB.has(x)) sharedIds++;
  const idOverlap = overlapCoefficient(idsA, idsB);
  const shingleBar = shingle >= INCIDENT_TWIN_SHINGLE_MIN;
  // STRICT: shared boilerplate is not shared substance — the shingle leg needs
  // the TITLES to agree or one shared piece of evidence (URL / quoted span).
  const shingleCorroborated = titleJaccard >= INCIDENT_TWIN_SHINGLE_TITLE_JACCARD_MIN || sharedAnchors >= INCIDENT_TWIN_SHINGLE_ANCHORS_MIN;
  const byShingle = shingleBar && (!strict || shingleCorroborated);
  const byAnchors = sharedAnchors >= INCIDENT_TWIN_ANCHORS_MIN && titleJaccard >= INCIDENT_TWIN_ANCHOR_TITLE_JACCARD_MIN;
  const byIds = sharedIds >= INCIDENT_TWIN_IDS_MIN && idOverlap >= INCIDENT_TWIN_ID_OVERLAP_MIN;
  const twin = byShingle || byAnchors || byIds;
  return {
    shingle, sharedAnchors, titleJaccard, sharedIds, idOverlap,
    twin,
    matchedBy: byShingle ? 'shingle' : byAnchors ? 'anchors' : byIds ? 'ids' : null,
    ...(strict && shingleBar && !twin ? { strictRejected: true } : {}),
  };
}

/** Series markers a numbered burst carries ("fix 2 of 5", "part 3", "finding 1"), read from the title + the description's first line. Pure. */
export function seriesMarker(t: IncidentText): string | null {
  const head = `${t.title ?? ''}\n${String(t.description ?? '').split('\n', 1)[0] ?? ''}`.slice(0, 600);
  const fix = /\bfix\s*#?\s*(\d{1,3})\s*(?:of|\/)\s*(\d{1,3})\b/i.exec(head);
  if (fix) return `fix:${Number(fix[1])}`;
  const other = /\b(part|finding)\s*#?\s*(\d{1,3})\b/i.exec(head);
  if (other) return `${other[1].toLowerCase()}:${Number(other[2])}`;
  return null;
}

const ctxRecord = (c: unknown): Record<string, unknown> => (c && typeof c === 'object' ? (c as Record<string, unknown>) : {});

/**
 * STRICT burst exemption: why this candidate/filing pair is one run's BURST of
 * distinct findings rather than one incident told twice — or null. Same filer =
 * the same context.runId (stamped by file_feedback) AND the same worker role
 * (a chat turn's lead and its cross-checker share the turn's run id and are two
 * filers — the 59a4407b/9b944f30 incident shape must still twin), filed within
 * INCIDENT_TWIN_BURST_WINDOW_MS; or both filings carry series markers that
 * differ. Pure.
 */
export function incidentTwinBurstExemption(
  candidate: IncidentText & { createdAt: Date | string; context?: unknown },
  filing: IncidentText & { context?: unknown },
  now: number = Date.now(),
): 'same_run_burst' | 'series_marker' | null {
  const cc = ctxRecord(candidate.context);
  const fc = ctxRecord(filing.context);
  const runC = typeof cc.runId === 'string' ? cc.runId : '';
  const runF = typeof fc.runId === 'string' ? fc.runId : '';
  if (runC && runC === runF && String(cc.role ?? '') === String(fc.role ?? '')) {
    const created = new Date(candidate.createdAt as any).getTime();
    if (Number.isFinite(created) && Math.abs(now - created) <= INCIDENT_TWIN_BURST_WINDOW_MS) return 'same_run_burst';
  }
  const mC = seriesMarker(candidate);
  const mF = seriesMarker(filing);
  if (mC && mF && mC !== mF) return 'series_marker';
  return null;
}

export interface IncidentTwinCandidate extends IncidentText { id: string; createdAt: Date | string; context?: unknown; status?: string }

/**
 * The open same-chat ticket this filing twins, or null. Candidates must already
 * be scoped to the filing's chat/session (the caller's query does that); this
 * applies the window, the harness exclusion and the text bar. The newest twin
 * wins. Pure.
 */
export function findIncidentTwin(
  candidates: ReadonlyArray<IncidentTwinCandidate>,
  filing: IncidentText & { context?: unknown },
  now: number = Date.now(),
): { candidate: IncidentTwinCandidate; score: IncidentTwinScore } | null {
  if (isHarnessTicketContext(filing.context)) return null;
  const strict = !incidentTwinStrictDisabled();
  for (const c of candidates) {
    if (!c || isHarnessTicketContext(c.context)) continue;
    const created = new Date(c.createdAt as any).getTime();
    if (!Number.isFinite(created) || now - created > INCIDENT_TWIN_WINDOW_MS || now - created < 0) continue;
    const ctx = (c.context && typeof c.context === 'object' ? c.context : {}) as Record<string, unknown>;
    if (typeof ctx.duplicateOf === 'string') continue; // a linked record never anchors another link
    if (strict && incidentTwinBurstExemption(c, filing, now)) continue; // one run's burst of distinct findings
    const score = scoreIncidentTwin(c, filing, { strict });
    if (score.twin) return { candidate: c, score };
  }
  return null;
}
