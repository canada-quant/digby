/**
 * Hourly, DB-only sweep. Files one deduped bug_report per fingerprint when a
 * marker would still show after the chat renderer, an owner card stores almost
 * no context, or an admin message reads as frustration. Log signals are NOT
 * here (ticket d6fdc1df): log-signal-sweep.service.ts alone owns logs.
 * Bounds: ≤ CAP new tickets per pass AND ≤ FRAMEWORK_SIGNAL_TICKETS_PER_DAY
 * (default 10) per UTC day across all workers. Telemetry: one loop_metrics
 * framework_signal_sweep row per pass (counts only).
 * Kill switch FRAMEWORK_SIGNAL_SWEEP_DISABLED=1.
 *
 * ACCEPTANCE-METRIC-BASELINE (2026-10-20): every finding carries
 * context.observedAt (its EVENT time — the message / card / owner turn's
 * createdAt; the 2 h lookback files events that predate a deploy, which
 * TICKET-FAMILY-ROUTING's class-fix absorption reads), every pass records one
 * framework_signal_finding loop_metrics row per finding stamped AT that event
 * time (meta {class, fingerprint}), and a raw-marker ticket carries the default
 * acceptance metric "framework_signal_finding rows for this fingerprint stay
 * at 0 for 24 h" (feedback.service's baseline gate keeps it only when the
 * pre-fix window counted ≥ 1); the fingerprint dedupe then also covers its
 * verifier-owned statuses (awaiting_verification, deployed_verified — both
 * last written ≤ 7 d ago, like done: a fix that never goes live cannot mute
 * a still-firing marker for good).
 * Kill switch AUTOFILER_DEFAULT_METRIC_DISABLED=1 (no rows, no default metric,
 * the d6fdc1df dedupe set; observedAt stays — it is provenance).
 */
import { OPEN_TICKET_STATUSES } from '../feedback/ticket-status';
import { AUTOFILER_DEFAULT_METRIC_SOURCE, autofilerDefaultMetricDisabled, frameworkFindingDefaultMetric } from '../feedback/acceptance-metric-defaults';
import {
  classifyComplaintSurface, missedBugSurfaceRoutingDisabled,
  type ProjectShape, type ResolvedSurface,
} from './complaint-surface';
import {
  findIncompleteCards,
  findOwnerFrustration,
  findSurvivingMarkers,
  type AdminTurn,
  type FrustrationHit,
  type IncompleteCardHit,
  type MarkerHit,
  type MarkerReason,
} from './framework-signal-detectors';
import { refundDayFilingSlot, reserveDayFilingSlot, utcDayStamp, type DaySlot } from './day-filing-budget';

const CAP = 10;
const TWO_H = 2 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

/**
 * Daily NEW-filing budget (2026-10-20, Grok-bot review): the per-pass CAP
 * alone × an hourly cron allowed up to 240 tickets/day. Same Redis INCR-first
 * reservation as the log-signal sweep (day-filing-budget.ts), on a day-named
 * key shared by every worker. A dedup bump / skipped / failed filing refunds
 * its slot; Redis down fails OPEN (feedback's own caps still bound the insert).
 * Override FRAMEWORK_SIGNAL_TICKETS_PER_DAY (0 = no new filings today);
 * kill switch FRAMEWORK_SIGNAL_DAY_CAP_DISABLED=1 (per-pass cap only).
 */
export const FRAMEWORK_SIGNAL_TICKETS_PER_DAY_DEFAULT = 10;
export const FRAMEWORK_SIGNAL_FILED_TTL_SEC = 26 * 3600;
export const FRAMEWORK_SIGNAL_FILED_KEY = (day: string) => `framework-signal-sweep:filed:${day}`;

export function frameworkSignalTicketsPerDay(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(String(env.FRAMEWORK_SIGNAL_TICKETS_PER_DAY ?? ''), 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : FRAMEWORK_SIGNAL_TICKETS_PER_DAY_DEFAULT;
}

export function frameworkSignalDayCapDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FRAMEWORK_SIGNAL_DAY_CAP_DISABLED === '1';
}

/** Counts-only pass summary — the loop_metrics row's meta. */
export interface FrameworkSignalPassCounts {
  messages: number;
  questions: number;
  users: number;
  found: number;
  deduped: number;
  filed: number;
  capped: number;
  dayCapped: number;
  dayCap: number | null;
  noAuthor: boolean;
  /** SURFACE ROUTING (a2540aaa): findings routed to a product project. */
  routed: number;
}

export interface SignalFinding {
  fingerprint: string;
  title: string;
  description: string;
  priority: number;
  context: Record<string, unknown>;
}

export interface TicketArgs {
  userId: string;
  type: 'bug_report';
  title: string;
  description: string;
  priority: number;
  area: 'framework';
  context: Record<string, unknown>;
}

export interface FrameworkSignalSweepDeps {
  loadMessages(): Promise<Array<{ id: string; chatId: string; content: string | null; parts: unknown; createdAt?: Date | string }>>;
  loadQuestions(): Promise<Array<{ id: string; question: string | null; context: string | null; consoleAction?: unknown; options?: unknown; createdAt?: Date | string }>>;
  loadUserMessages(): Promise<AdminTurn[]>;
  loadAssistants(chatIds: string[]): Promise<AdminTurn[]>;
  loadAdminAuthor(): Promise<string | null>;
  loadOpenFingerprints(): Promise<Set<string>>;
  fileTicket(args: TicketArgs): Promise<unknown>;
  normalizeTitle(title: string): string;
  /** Daily budget seam (default: Redis INCR-first on FRAMEWORK_SIGNAL_FILED_KEY).
   *  Omitted on injected deps ⇒ no day budget ('unknown', fail open). */
  reserveDaySlot?(cap: number): Promise<DaySlot>;
  refundDaySlot?(): Promise<void>;
  /** Telemetry seam (default: one loop_metrics framework_signal_sweep row). */
  recordPass?(counts: FrameworkSignalPassCounts): void;
  /** SURFACE ROUTING (ticket a2540aaa): project rows for the missed-bug
   *  complaint-surface classifier — each chat's own project + the owner's
   *  repo-bound non-platform projects. Omitted on injected deps ⇒ no
   *  resolution (every complaint files platform, today's behavior). */
  loadSurfaceProjects?(chatIds: string[]): Promise<{
    chatProjects: Map<string, ProjectShape | null>;
    candidates: ProjectShape[];
  }>;
  /** ACCEPTANCE-METRIC-BASELINE seam (default: one framework_signal_finding row per
   *  finding at its event time, flushed before any filing so the filing's
   *  baseline gate counts it). Omitted on injected deps ⇒ no rows. */
  recordFindings?(findings: SignalFinding[]): Promise<void>;
}

/** Per-pass cap on framework_signal_finding rows (a flood class never floods telemetry). */
export const FRAMEWORK_SIGNAL_FINDING_ROWS_MAX = 100;

/** The finding CLASS a fingerprint belongs to ('raw-marker' | 'incomplete-card' | 'missed-bug'). Pure. */
export function signalFindingClass(fingerprint: string): string {
  const i = fingerprint.indexOf(':');
  return i > 0 ? fingerprint.slice(0, i) : fingerprint;
}

/** ISO event time of a row's createdAt, or undefined. Pure. */
function isoOf(v: unknown): string | undefined {
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

const id8 = (id: string) => id.slice(0, 8);

/**
 * Raw-marker findings fingerprint by MARKER TYPE, not per chat (ticket
 * d6fdc1df): one flood class was `raw-marker:${chatId}:${marker}` — the same
 * [HARNESS …] bracketed word in N chats filed N tickets an hour. Dedup now
 * keys on the marker alone; chatId/messageId stay in context as the example
 * occurrence.
 */
const markerFinding = (h: MarkerHit, observedAt?: string): SignalFinding => ({
  fingerprint: `raw-marker:${h.marker}`,
  title: h.high
    ? `Raw marker ${h.marker} (high) survived in chat ${id8(h.chatId)}`
    : `Raw marker ${h.marker} survived in chat ${id8(h.chatId)}`,
  description: `A ${h.marker} marker survived renderer cleaning (${h.reason}).`,
  priority: h.high ? 1 : 2,
  context: {
    sessionId: `framework-sweep:raw-marker:${h.marker}`,
    surface: 'system',
    origin: 'framework-sweep',
    about: 'digby_platform',
    fingerprint: `raw-marker:${h.marker}`,
    chatId: h.chatId,
    messageId: h.messageId,
    marker: h.marker,
    reason: h.reason,
    ...(h.high ? { severity: 'high' } : {}),
    ...(observedAt ? { observedAt } : {}),
  },
});

const cardFinding = (h: IncompleteCardHit, observedAt?: string): SignalFinding => ({
  fingerprint: `incomplete-card:${h.questionId}`,
  title: `Incomplete owner card ${id8(h.questionId)}`,
  description: `Owner card ${h.questionId} asks for steps or a paste but stores ${h.contextLength} characters of context.`,
  priority: 2,
  context: {
    sessionId: `framework-sweep:incomplete-card:${h.questionId}`,
    surface: 'system',
    origin: 'framework-sweep',
    about: 'digby_platform',
    fingerprint: `incomplete-card:${h.questionId}`,
    questionId: h.questionId,
    ...(observedAt ? { observedAt } : {}),
  },
});

const frustrationFinding = (h: FrustrationHit, observedAt?: string): SignalFinding => ({
  fingerprint: `missed-bug:${h.chatId}:${h.userMessageId}`,
  title: `Missed bug: owner frustration in chat ${id8(h.chatId)}`,
  description: h.excerpt,
  priority: 2,
  context: {
    sessionId: `framework-sweep:missed-bug:${h.chatId}:${h.userMessageId}`,
    surface: 'system',
    origin: 'framework-sweep',
    about: 'digby_platform',
    fingerprint: `missed-bug:${h.chatId}:${h.userMessageId}`,
    kind: 'missed-bug',
    class: 'missed-bug',
    chatId: h.chatId,
    userMessageId: h.userMessageId,
    assistantMessageId: h.assistantMessageId,
    ...(observedAt ? { observedAt } : {}),
  },
});

/** The LATER of two ISO event times (a merged finding is as recent as its newest event). Pure. */
function laterIso(a: unknown, b: unknown): string | undefined {
  const ta = Date.parse(String(a ?? ''));
  const tb = Date.parse(String(b ?? ''));
  if (!Number.isFinite(ta)) return Number.isFinite(tb) ? String(b) : undefined;
  if (!Number.isFinite(tb)) return String(a);
  return ta >= tb ? String(a) : String(b);
}

const REASON_RANK: Record<MarkerReason, number> = { 'no valid to': 3, unclosed: 2, 'no renderer': 1 };

const isHigh = (f: SignalFinding) => f.context.severity === 'high' || f.priority === 1;

/** Same fingerprint: keep the stronger severity and the better reason. */
export function mergeSignalFindings(rows: SignalFinding[]): SignalFinding[] {
  const by = new Map<string, SignalFinding>();
  for (const incoming of rows) {
    const prev = by.get(incoming.fingerprint);
    if (!prev) {
      by.set(incoming.fingerprint, incoming);
      continue;
    }
    const base = isHigh(incoming) && !isHigh(prev) ? incoming : prev;
    const reasons = [prev, incoming, base]
      .map((r) => r.context.reason)
      .filter((r): r is MarkerReason => r === 'no valid to' || r === 'unclosed' || r === 'no renderer');
    const reason = reasons.sort((a, b) => REASON_RANK[b] - REASON_RANK[a])[0];
    const description = reason
      ? base.description.replace(/\((?:unclosed|no valid to|no renderer)\)/, `(${reason})`)
      : base.description;
    let title = base.title;
    if (isHigh(base) && !title.includes('(high)')) title = title.replace(' survived', ' (high) survived');
    // ACCEPTANCE-METRIC-BASELINE / TICKET-FAMILY-ROUTING: a merged finding is
    // as recent as its NEWEST event (a sighting with any post-fix event must
    // never read as predating that fix).
    const observedAt = laterIso(prev.context.observedAt, incoming.context.observedAt);
    by.set(incoming.fingerprint, {
      ...base,
      title,
      description,
      priority: isHigh(base) ? 1 : base.priority,
      context: {
        ...base.context,
        ...(reason ? { reason } : {}),
        ...(isHigh(base) ? { severity: 'high' } : {}),
        ...(observedAt ? { observedAt } : {}),
      },
    });
  }
  return [...by.values()];
}

export function signalTicketArgs(
  f: SignalFinding,
  author: string,
  env: NodeJS.ProcessEnv = process.env,
  surface?: ResolvedSurface,
): TicketArgs {
  const context = { ...f.context };
  if (context.kind !== 'missed-bug') delete context.assistantMessageId;
  // SURFACE ROUTING (ticket a2540aaa): a complaint classified to a product
  // project files as the PRODUCT's surface — about='user_project' +
  // context.userProjectId (the dispatcher's per-ticket lane home) — with the
  // why in context.surfaceRoute. Everything else keeps the platform stamp.
  // The kill switch (checked by the resolver in run()) restores the
  // platform-only stamp byte-for-byte.
  if (surface?.surface === 'user_project' && surface.userProjectId) {
    context.about = 'user_project';
    context.userProjectId = surface.userProjectId;
    context.surfaceRoute = {
      tier: surface.tier,
      ...(surface.repoSlug ? { repoSlug: surface.repoSlug } : {}),
      ...(surface.evidence ? { evidence: surface.evidence } : {}),
    };
  } else if (surface && surface.tier === null) {
    // An explicitly classified platform surface records WHY it stayed here —
    // the routing's audit trail without changing the filing.
    context.surfaceRoute = { tier: null };
  }
  // ACCEPTANCE-METRIC-BASELINE: an instance-keyed class (raw-marker:<MARKER>)
  // carries the default metric — its finding rows stay at 0 for 24 h after the
  // fix. feedback.service's baseline gate drops it if the pre-fix window
  // counted nothing (then the ticket is flagged missing a metric as before).
  if (!autofilerDefaultMetricDisabled(env) && !context.acceptanceMetric) {
    const metric = frameworkFindingDefaultMetric(f.fingerprint);
    if (metric) {
      context.acceptanceMetric = metric;
      context.acceptanceMetricSource = AUTOFILER_DEFAULT_METRIC_SOURCE;
    }
  }
  return {
    userId: author,
    type: 'bug_report',
    title: f.title.slice(0, 140),
    description: f.description.slice(0, 8000),
    priority: f.priority,
    area: 'framework',
    context,
  };
}

export function classifyFileResult(
  result: unknown,
  requestedTitle: string,
  normalize: (title: string) => string,
): 'filed' | 'deduped' | 'skipped' {
  if (!result || typeof result !== 'object') return 'skipped';
  const r = result as { error?: unknown; queued?: unknown; deduped?: unknown; ticket?: { title?: string } };
  if (r.error) return 'skipped';
  if (r.queued === true) return 'filed';
  if (r.deduped === true) {
    const got = typeof r.ticket?.title === 'string' ? r.ticket.title : '';
    return normalize(got) === normalize(requestedTitle) ? 'deduped' : 'skipped';
  }
  if (r.deduped === false) return 'filed';
  return 'skipped';
}

function collectFindings(input: {
  messages: Array<{ id: string; chatId: string; content: string | null; parts: unknown; createdAt?: Date | string }>;
  questions: Array<{ id: string; question: string | null; context: string | null; consoleAction?: unknown; options?: unknown; createdAt?: Date | string }>;
  users: AdminTurn[];
  assistants: AdminTurn[];
}): SignalFinding[] {
  // Event times (ACCEPTANCE-METRIC-BASELINE): each finding's context.observedAt.
  const questionAt = new Map(input.questions.map((q) => [q.id, isoOf(q.createdAt)]));
  const userAt = new Map(input.users.map((u) => [u.id, isoOf(u.createdAt)]));
  return mergeSignalFindings([
    ...input.messages.flatMap((m) =>
      findSurvivingMarkers({ chatId: m.chatId, messageId: m.id, content: m.content, parts: m.parts }).map((h) => markerFinding(h, isoOf(m.createdAt))),
    ),
    ...findIncompleteCards(input.questions.map((q) => ({ ...q, question: q.question ?? '' }))).map((h) => cardFinding(h, questionAt.get(h.questionId))),
    ...findOwnerFrustration(input.users, input.assistants).map((h) => frustrationFinding(h, userAt.get(h.userMessageId))),
  ]);
}

/**
 * The framework_signal_finding rows of one pass (ACCEPTANCE-METRIC-BASELINE):
 * one per finding, stamped at its EVENT time, meta {class, fingerprint}.
 * Capped at FRAMEWORK_SIGNAL_FINDING_ROWS_MAX. Pure — exported for tests.
 */
export function findingMetricRows(findings: ReadonlyArray<SignalFinding>): Array<{ kind: string; at?: Date; meta: { class: string; fingerprint: string } }> {
  return findings.slice(0, FRAMEWORK_SIGNAL_FINDING_ROWS_MAX).map((f) => {
    const t = Date.parse(String(f.context.observedAt ?? ''));
    return {
      kind: 'framework_signal_finding',
      ...(Number.isFinite(t) ? { at: new Date(t) } : {}),
      meta: { class: signalFindingClass(f.fingerprint), fingerprint: f.fingerprint },
    };
  });
}

function defaultDeps(): FrameworkSignalSweepDeps {
  const since = (ms: number) => new Date(Date.now() - ms);
  // One day key per pass: a refund must hit the counter its reservation hit.
  const dayKey = FRAMEWORK_SIGNAL_FILED_KEY(utcDayStamp(new Date()));
  const db = async () => (await import('../../../config/database')).default;
  return {
    async loadMessages() {
      const prisma = await db();
      return prisma.crossModelMessage.findMany({
        where: { role: 'assistant', createdAt: { gte: since(TWO_H) } },
        orderBy: { createdAt: 'desc' },
        take: 2000,
        select: { id: true, chatId: true, content: true, parts: true, createdAt: true },
      });
    },
    async loadQuestions() {
      const prisma = await db();
      return prisma.ownerQuestion.findMany({
        where: { createdAt: { gte: since(TWO_H) } },
        orderBy: { createdAt: 'desc' },
        take: 1000,
        // Ticket 84b11946: the consoleAction spec is the skip-signal for
        // findIncompleteCards (a consoleAction card composes payload+steps
        // into `question`; empty `context` is by design) — without it every
        // such card files a false-positive ticket.
        // Ticket 65cfec1b: options feeds the same detector's background-gap
        // admission (a card with typed options is complete on the options
        // axis even when its context column is empty).
        // Ticket 90a5b127: optionalAsk + expectedAnswerType feed the
        // options-axis STRUCTURE legs — a card its own flagger declared
        // optional, or declared yes_no, is complete by declaration; the
        // sweep must apply the same admission the write-time path does.
        select: { id: true, question: true, context: true, consoleAction: true, options: true, optionalAsk: true, expectedAnswerType: true, createdAt: true },
      });
    },
    async loadUserMessages() {
      const prisma = await db();
      return prisma.crossModelMessage.findMany({
        where: { role: 'user', createdAt: { gte: since(TWO_H) }, chat: { user: { role: 'ADMIN' } } },
        orderBy: { createdAt: 'asc' },
        take: 500,
        // e7c533d3: metadata.origin is the machine-sent stamp
        // (schedule/hook/machine/agent/webhook) — findOwnerFrustration must
        // distinguish the owner's words from machine wakes and inter-agent
        // relays that persist as role:'user' rows.
        select: { id: true, chatId: true, content: true, createdAt: true, metadata: true },
      });
    },
    async loadAssistants(chatIds) {
      const prisma = await db();
      return prisma.crossModelMessage.findMany({
        where: { role: 'assistant', chatId: { in: chatIds } },
        orderBy: { createdAt: 'desc' },
        take: 2000,
        select: { id: true, chatId: true, content: true, createdAt: true },
      });
    },
    // SURFACE ROUTING (ticket a2540aaa): each complaint chat's own project +
    // the owner's repo-bound non-platform projects — the classifier's rows.
    async loadSurfaceProjects(chatIds) {
      const prisma = await db();
      const projectSelect = { id: true, name: true, repoUrl: true, userId: true };
      const [chatRows, candidates] = await Promise.all([
        chatIds.length
          ? prisma.crossModelChat.findMany({ where: { id: { in: chatIds } }, select: { id: true, projectId: true } })
          : Promise.resolve([] as Array<{ id: string; projectId: string | null }>),
        prisma.crossModelProject.findMany({
          where: { repoUrl: { not: null } },
          select: projectSelect,
          // Deterministic order: the take:500 window must not depend on heap
          // order. Account-scope note: candidates are NOT author-filtered —
          // a foreign repo-bound project can only ever BLOCK routing into
          // ambiguity (conservative), never receive a ticket (ticketRouteProject
          // requires userId === home.userId). Filtering by author here would
          // need the admin author threaded through this seam (banked follow-up).
          orderBy: { createdAt: 'asc' },
          take: 500,
        }),
      ]);
      const projectIds = [...new Set(chatRows.map((c) => c.projectId).filter((v): v is string => !!v))];
      const chatProjectRows = projectIds.length
        ? await prisma.crossModelProject.findMany({ where: { id: { in: projectIds } }, select: projectSelect })
        : [];
      const byId = new Map(chatProjectRows.map((p) => [p.id, p]));
      const chatProjects = new Map<string, ProjectShape | null>(
        chatRows.map((c) => [c.id, c.projectId ? byId.get(c.projectId) ?? null : null]),
      );
      return { chatProjects, candidates: candidates as ProjectShape[] };
    },
    async loadAdminAuthor() {
      try {
        const { adminFleetSupervisors } = await import('./infra-watch.service');
        const rows = await adminFleetSupervisors();
        return rows[0]?.userId ?? null;
      } catch {
        return null;
      }
    },
    async loadOpenFingerprints() {
      const prisma = await db();
      const rows = await prisma.userFeatureRequest.findMany({
        where: {
          // d6fdc1df: a ticket closed 'done' in the last 7 days must still
          // dedup its fingerprint — otherwise the hour after a lane closes a
          // fix the sweep re-files the same finding (the closed-tickets-
          // reopen class). Legacy closed spellings stay out: the brief's
          // bar is exactly status 'done'.
          // ACCEPTANCE-METRIC-BASELINE (r2 interactions): a raw-marker ticket
          // now carries the default metric, so its lane's close lands in
          // 'awaiting_verification' (the verifier owns it — a post-deploy
          // recurrence REOPENS it, and this sweep's finding rows are what it
          // counts) and then 'deployed_verified'. Both must dedup like an
          // owed / done row, or the sweep re-files and re-lanes a merged fix.
          // BOTH ride the done arm's 7-day window (r2 review): the verifier
          // only measures — and so only reopens — once the fix is LIVE, and a
          // close whose fix never goes live (replay-test-only / no commitSha,
          // a squash-merged or bisect-dropped head) answers 'waiting' forever,
          // so an unbounded arm would mute a still-firing marker for good. Its
          // last write is the close / waiting stamp (once) or the live anchor,
          // so 7 d covers the deploy lag and the default 24 h metric window.
          OR: [
            { status: { in: [...OPEN_TICKET_STATUSES] } },
            { status: 'done', updatedAt: { gte: since(7 * DAY) } },
            ...(autofilerDefaultMetricDisabled() ? [] : [
              { status: 'awaiting_verification', updatedAt: { gte: since(7 * DAY) } },
              { status: 'deployed_verified', updatedAt: { gte: since(7 * DAY) } },
            ]),
          ],
          context: { path: ['origin'], equals: 'framework-sweep' },
        },
        // Deterministic order (d6fdc1df): no implicit sort between runs.
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        take: 200,
        select: { context: true },
      });
      const out = new Set<string>();
      for (const row of rows) {
        const fp = (row.context as { fingerprint?: unknown } | null)?.fingerprint;
        if (typeof fp === 'string' && fp) out.add(fp);
      }
      return out;
    },
    async fileTicket(args) {
      const { fileFeedbackTicket } = await import('../feedback/feedback.service');
      return fileFeedbackTicket(args);
    },
    normalizeTitle(title) {
      return title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    },
    async reserveDaySlot(cap) {
      const redis = (await import('../../../config/redis')).default;
      return reserveDayFilingSlot(redis as any, dayKey, cap, FRAMEWORK_SIGNAL_FILED_TTL_SEC);
    },
    async refundDaySlot() {
      const redis = (await import('../../../config/redis')).default;
      await refundDayFilingSlot(redis as any, dayKey);
    },
    recordPass(counts) {
      void import('../platform/loop-metrics.service')
        .then(({ LOOP_METRIC_KINDS, recordLoopMetric }) => recordLoopMetric({
          kind: LOOP_METRIC_KINDS.FRAMEWORK_SIGNAL_SWEEP,
          value: counts.filed,
          unit: 'tickets',
          meta: { ...counts },
        }))
        .catch(() => { /* telemetry never blocks the sweep */ });
    },
    async recordFindings(findings) {
      // ACCEPTANCE-METRIC-BASELINE: one event-time row per finding, FLUSHED
      // before any filing so a raw-marker ticket's baseline gate counts it.
      if (autofilerDefaultMetricDisabled() || !findings.length) return;
      try {
        const lm = await import('../platform/loop-metrics.service');
        for (const row of findingMetricRows(findings)) lm.recordLoopMetric(row);
        if (typeof lm.flushLoopMetrics === 'function') await lm.flushLoopMetrics();
      } catch { /* telemetry never blocks the sweep */ }
    },
  };
}

export async function runFrameworkSignalSweepOnce(deps?: FrameworkSignalSweepDeps): Promise<string> {
  if (process.env.FRAMEWORK_SIGNAL_SWEEP_DISABLED === '1') return 'sweep: disabled';
  const d = deps ?? defaultDeps();
  const [messages, questions, users, author] = await Promise.all([
    d.loadMessages(),
    d.loadQuestions(),
    d.loadUserMessages(),
    d.loadAdminAuthor(),
  ]);
  const chatIds = [...new Set(users.map((u) => u.chatId))];
  const assistants = chatIds.length ? await d.loadAssistants(chatIds) : [];
  const findings = collectFindings({ messages, questions, users, assistants });
  // ACCEPTANCE-METRIC-BASELINE: the per-finding telemetry rows (detection, not
  // filing — recorded whatever the dedupe / author / caps decide below).
  try { await d.recordFindings?.(findings); } catch { /* telemetry never blocks the sweep */ }
  const scanned = `${messages.length}/${questions.length}/${users.length}`;
  const dayCapOn = !frameworkSignalDayCapDisabled();
  const counts: FrameworkSignalPassCounts = {
    messages: messages.length, questions: questions.length, users: users.length,
    found: findings.length, deduped: 0, filed: 0, capped: 0, dayCapped: 0,
    dayCap: dayCapOn ? frameworkSignalTicketsPerDay() : null, noAuthor: !author,
    routed: 0,
  };
  const record = () => { try { d.recordPass?.(counts); } catch { /* telemetry never blocks the sweep */ } };
  if (!author) {
    record();
    return `sweep: scanned ${scanned}, found ${findings.length}, no admin author`;
  }
  if (findings.length === 0) {
    record();
    return `sweep: scanned ${scanned}, found 0, deduped 0, filed 0, capped 0`;
  }
  const open = await d.loadOpenFingerprints();
  // SURFACE ROUTING (ticket a2540aaa): classify each missed-bug complaint's
  // surface ONCE per pass — the project rows come from the deps seam (omitted
  // on injected deps ⇒ every complaint keeps today's platform filing); the
  // kill switch restores the platform-only stamp byte-for-byte.
  let surfaceByFp: Map<string, ResolvedSurface> | null = null;
  if (!missedBugSurfaceRoutingDisabled() && d.loadSurfaceProjects) {
    try {
      const usersAll = users; // every AdminTurn carries chatId
      const chatIds = [...new Set(usersAll.map((u) => u.chatId))];
      if (chatIds.length) {
        const { chatProjects, candidates } = await d.loadSurfaceProjects(chatIds);
        surfaceByFp = new Map();
        for (const f of findings) {
          if (f.context?.kind !== 'missed-bug') continue;
          const chatId = String(f.context.chatId ?? '');
          const text = `${f.title}\n${f.description}`;
          const route = classifyComplaintSurface({
            text,
            chatProject: chatProjects.get(chatId) ?? null,
            candidateProjects: candidates,
          });
          surfaceByFp.set(f.fingerprint, route);
          if (route.surface === 'user_project') counts.routed++;
        }
      }
    } catch { /* routing never blocks the sweep — platform fallback stays */ }
  }
  for (const f of findings) {
    if (open.has(f.fingerprint)) {
      counts.deduped++;
      continue;
    }
    if (counts.filed >= CAP) {
      counts.capped++;
      continue;
    }
    // Daily budget: reserve INCR-first, refund unless a NEW ticket landed.
    let reserved = false;
    if (counts.dayCap !== null && d.reserveDaySlot) {
      const slot = await d.reserveDaySlot(counts.dayCap).catch((): DaySlot => 'unknown');
      if (slot === 'capped') {
        counts.dayCapped++;
        continue;
      }
      reserved = slot === 'reserved';
    }
    let klass: 'filed' | 'deduped' | 'skipped';
    try {
      klass = classifyFileResult(await d.fileTicket(signalTicketArgs(f, author, process.env, surfaceByFp?.get(f.fingerprint))), f.title, d.normalizeTitle);
    } catch {
      klass = 'skipped';
    }
    if (reserved && klass !== 'filed') await d.refundDaySlot?.().catch(() => {});
    if (klass === 'filed') counts.filed++;
    else if (klass === 'deduped') counts.deduped++;
  }
  record();
  const dayNote = counts.dayCapped ? `, day-capped ${counts.dayCapped} (${counts.dayCap}/day)` : '';
  return `sweep: scanned ${scanned}, found ${findings.length}, deduped ${counts.deduped}, filed ${counts.filed}, capped ${counts.capped}${dayNote}`;
}
