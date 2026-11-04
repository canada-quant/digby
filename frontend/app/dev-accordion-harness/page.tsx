'use client';

/**
 * DEV-ONLY accordion verification harness (platform task 2026-09-03 — the
 * #604 mega-accordion fix). Renders a FAITHFULLY SEEDED Fleet-Supervisor-shaped
 * transcript — 5 machine wakes × ~11 rows of wake envelopes / summary notes /
 * verifier chrome / relays, plus owner rows — through the REAL
 * lib/machine-turn-grouping transform and the REAL MachineTurnGroup /
 * MachineWakeBlock / MessageNavigator components, so a real browser can verify
 * the acceptance criteria (zero-click summaries, per-wake accordions,
 * scannable labels, rail, cold-open) without an authenticated session.
 *
 *   ?legacy=1  — the pre-fix #604 behavior (verbatim legacy grouping + legacy
 *                component, inlined below) for an honest before/after.
 *
 * 404 in production: this page is a development/test surface only.
 */

import { useEffect, useRef, useState } from 'react';
import { notFound } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { groupMachineRows, type MachineRowProbe, type MachineTurnItem } from '@/lib/machine-turn-grouping';
import MachineTurnGroup from '@/app/crossmodel/components/MachineTurnGroup';
import MachineWakeBlock from '@/app/crossmodel/components/MachineWakeBlock';
import MessageNavigator, { navPreview } from '@/app/crossmodel/components/MessageNavigator';
import { MarkdownContent } from '@/components/ui/custom/prompt/markdown-content';
import { classifySystemRow } from '@/lib/machine-wake';

/* ── Seed: the supervisor chat's real shapes (fictional content) ─────────── */

type SeedRow = { id: string; role: string; content: string; origin?: string; time: string };

const ENVELOPE = (event: string, source: string) =>
  `[MACHINE-TRIGGERED RUN — EVENT HOOK FIRED — a scheduled/hook firing, NOT a human-typed message]\n\n` +
  `The ${event} event fired from chat '${source}'.\n\n[FRESHNESS CONTRACT — machine-triggered run]\n` +
  `Every completion claim must cite a concrete tool-result artifact observed THIS run.\n\n` +
  `[SUPERVISOR STATE — durable memory follows]\n- directive: keep the waiver lane moving\n- note: digest relayed\n\n` +
  `Event payload:\n{"eventType":"${event}","sourceChatTitle":"${source}","summary":"run completed: 3 tool calls, final answer delivered"}`;

const SUMMARY = (headline: string, rows: [string, string][]) =>
  `**${headline}**\n\n| Item | Status |\n|---|---|\n${rows.map(([a, b]) => `| ${a} | ${b} |`).join('\n')}\n\n` +
  `Details: checked the lane transcripts fresh, confirmed the receipts, and updated the board. Nothing else needs fleet action this hour.`;

const VERIFIER = '[ACTION VERIFIER — ANSWER-QUALITY GATE]\nThe prior note cited id 9f3ab21c without a matching journal row — treated as unverified and struck from the record.';
const WITHHELD = '[System note: an earlier assistant reply in this conversation was withheld after failing automated verification; its claims were not delivered. Treat anything it claimed as not done until re-verified.]';
const RELAY = 'Nightly digest — cycle complete: 1 PR merged, queue open 0 / in_progress 0, deploy green.';

function seed(): SeedRow[] {
  const rows: SeedRow[] = [];
  let t = 18; // 6:0x PM start, hourly wakes
  const clock = (h: number, m: string) => `${h > 12 ? h - 12 : h}: ${m} PM`.replace(' ', '');
  const push = (id: string, role: string, content: string, origin: string | undefined, time: string) =>
    rows.push({ id, role, content, origin, time });

  // Wake 1 — full shape: envelope, relay, verifier chrome, summary.
  push('w1', 'user', ENVELOPE('run_completed', 'Nightly Engineer'), 'schedule', clock(t, '05'));
  push('r1', 'user', RELAY, 'agent', clock(t, '05'));
  push('c1', 'assistant', VERIFIER, 'machine', clock(t, '06'));
  push('a1', 'assistant', SUMMARY('Fleet wake — nightly cycle complete, queue empty', [['Nightly Engineer', 'done — digest relayed'], ['Queue', 'open 0 / in_progress 0'], ['Deploy', 'green']]), undefined, clock(t, '07'));
  // Wake 2 — withhold shape: envelope, withheld placeholder, retry summary.
  t += 1;
  push('w2', 'user', ENVELOPE('run_completed', 'Re-Send Path C'), 'schedule', clock(t, '02'));
  push('c2', 'assistant', WITHHELD, 'machine', clock(t, '03'));
  push('a2', 'assistant', SUMMARY('Fleet wake — Path C probe green, one strike contained', [['Path C monitor', 'probe 200 in 41s'], ['Guard strike', 'withheld pre-delivery'], ['Tickets', 'no new filings']]), undefined, clock(t, '04'));
  // Wake 3 — chrome-only run (no summary): envelope + verifier note.
  t += 1;
  push('w3', 'user', ENVELOPE('attention_needed', 'Waiver board'), 'hook', clock(t, '11'));
  push('c3', 'assistant', VERIFIER, 'machine', clock(t, '12'));
  // Owner interjects.
  push('u1', 'user', 'looks good — keep an eye on the waiver lane tonight', undefined, clock(t, '18'));
  push('au1', 'assistant', 'On it. The waiver lane has two owner-side items pending; I will nudge tomorrow morning if the board has not moved.', undefined, clock(t, '18'));
  // Wake 4 — continuation chain: envelope + summary, continuation envelope + summary.
  t += 1;
  push('w4', 'user', ENVELOPE('run_completed', 'Fleet maintenance'), 'schedule', clock(t, '01'));
  push('a4', 'assistant', SUMMARY('Fleet wake — branch hygiene done, 2 provably-merged branches deleted', [['Branch hygiene', '2 deleted, 14 active'], ['Schedules', 'no duplicates']]), undefined, clock(t, '03'));
  push('w4b', 'user', '[HARNESS CONTINUATION r1/3] — not typed by the user. A previous run ended with 2 unfinished plan step(s).', 'schedule', clock(t, '21'));
  push('a4b', 'assistant', SUMMARY('Continuation — deploy watch green, ticket closed with evidence', [['Deploy 33700025', 'completed success'], ['Ticket', 'done — replay test cited']]), undefined, clock(t, '24'));
  // Wake 5 — the newest: envelope, relay, summary (the cold-open target).
  t += 1;
  push('w5', 'user', ENVELOPE('run_completed', 'Nightly Engineer'), 'schedule', clock(t, '04'));
  push('r5', 'user', RELAY, 'agent', clock(t, '04'));
  push('a5', 'assistant', SUMMARY('Fleet wake — 2 lane completions, both no-ops', [['cec340f2 lane', 'no-op tick, probe 200'], ['c9ccf88a lane', 'conviction banked, plan 8/8'], ['Supervisor queue', 'no new tickets']]), undefined, clock(t, '06'));
  push('u2', 'user', 'thanks — and can you check the edge box tomorrow?', undefined, clock(t, '32'));
  push('au2', 'assistant', 'Queued for the morning sweep: edge box build ancestry + picker verification.', undefined, clock(t, '32'));
  // One more wake after the owner row (the current tail).
  t += 1;
  push('w6', 'user', ENVELOPE('run_completed', 'Re-Send Path C'), 'schedule', clock(t, '03'));
  push('a6', 'assistant', SUMMARY('Fleet wake — quiet hour, all lanes idle', [['Path C', 'probe 200 in 38s'], ['Edge box', 'tomorrow, per owner'], ['Schedules', 'next fire 11:51 PM']]), undefined, clock(t, '05'));
  return rows;
}

const ROWS = seed();
const PROJECT_ROWS = seedProjectChat();

const probe = (r: SeedRow): MachineRowProbe => ({ id: r.id, role: r.role, content: r.content, origin: r.origin });

/* ── Legacy (#604) grouping + component — verbatim pre-fix behavior ──────── */

function groupMachineRowsLegacy(rows: SeedRow[]): any[] {
  const items: any[] = [];
  let runRows: SeedRow[] = [];
  const flush = () => {
    if (!runRows.length) return;
    const first = runRows[0];
    const firstAssistant = runRows.find(r => r.role === 'assistant');
    items.push({
      kind: 'machineGroup',
      key: `mtg-${first.id}`,
      rows: runRows,
      count: runRows.length,
      summary: "run_completed from 'Nightly Engineer'",
      preview: firstAssistant ? (firstAssistant.content.split('\n').map(l => l.replace(/^[#>*\s\-]+/, '').trim()).find(l => l.length > 0 && !l.startsWith('[')) || '').slice(0, 90) : '',
      timeLabel: first.time,
    });
    runRows = [];
  };
  for (const row of rows) {
    if (row.role === 'user') {
      const sys = classifySystemRow({ role: row.role, content: row.content, metadata: { origin: row.origin } });
      if (sys) { runRows.push(row); } else { flush(); items.push({ kind: 'row', row }); }
      continue;
    }
    if (row.role === 'assistant') {
      if (runRows.length > 0) { runRows.push(row); }
      else if (row.content.startsWith('[ACTION VERIFIER') || row.content.startsWith('[System note') || row.origin === 'machine') { runRows.push(row); }
      else { items.push({ kind: 'row', row }); }
      continue;
    }
    flush(); items.push({ kind: 'row', row });
  }
  flush();
  return items;
}

function LegacyMachineTurnGroup({ count, summary, preview, timeLabel, children }: any) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="w-full min-w-0">
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(v => !v)}
        className={cn('flex w-full min-w-0 items-start gap-1.5 rounded-lg border bg-muted/40 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/70', expanded && 'rounded-b-none')}>
        <ChevronRight className={cn('mt-0.5 h-3.5 w-3.5 shrink-0 transition-transform duration-200', expanded && 'rotate-90')} aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5">
            <span className="shrink-0 font-medium">⚙ {count} machine turn{count === 1 ? '' : 's'}</span>
            {summary && <span className="min-w-0 truncate">— {summary}</span>}
            {timeLabel && <span className="ml-auto shrink-0 text-[10px] opacity-70">{timeLabel}</span>}
          </span>
          {!expanded && preview && <span className="block truncate text-[11px] italic opacity-80">“{preview}”</span>}
        </span>
      </button>
      {expanded && <div className="space-y-3 rounded-b-lg border border-t-0 bg-muted/20 px-3 py-3">{children}</div>}
    </div>
  );
}

/* ── Project-chat scene (Issue 2): the SAME collapse behavior in a plain
 *  project/coding chat — owner turns and teammate messages never fold, each
 *  scheduled/hook wake folds with its note into one pill. ?scene=project ── */

function seedProjectChat(): SeedRow[] {
  const rows: SeedRow[] = [];
  const push = (id: string, role: string, content: string, origin: string | undefined, time: string) =>
    rows.push({ id, role, content, origin, time });
  // Owner kicks off work.
  push('p1', 'user', 'can you add the retry-with-backoff to the webhook sender?', undefined, '9:14 AM');
  push('p2', 'assistant', 'Done — the sender now retries 3× with exponential backoff (1s/4s/16s) and logs each attempt. Tests: 4 new pins in webhook-retry.test.ts, all green.', undefined, '9:16 AM');
  // A scheduled wake fires INSIDE the project chat.
  push('p3', 'user', '[MACHINE-TRIGGERED RUN — SCHEDULED MESSAGE FIRED — a scheduled firing, NOT a human-typed message]\n\nThe scheduled message fired: "check the staging deploy and report".', 'schedule', '10:00 AM');
  push('p4', 'assistant', '**Deploy check — staging green**\n\n- Build 8842 completed success in 3m 12s\n- Health probe 200 in 380ms\n- No new errors in the last hour', undefined, '10:02 AM');
  // Owner continues — the wake above renders as one collapsed pill.
  push('p5', 'user', 'nice — ship it to prod when the window opens', undefined, '10:09 AM');
  push('p6', 'assistant', 'Queued for the 14:00 window. I will watch the canary for 10 minutes post-promotion and report back here.', undefined, '10:10 AM');
  // Second wake: a hook fires with verifier chrome + a final note.
  push('p7', 'user', '[MACHINE-TRIGGERED RUN — EVENT HOOK FIRED — a scheduled/hook firing, NOT a human-typed message]\n\nThe run_completed event fired from chat \'Deploy watcher\'.', 'hook', '2:14 PM');
  push('p8', 'assistant', '[ACTION VERIFIER — ANSWER-QUALITY GATE]\nAll completion claims cited artifacts; answer released.', 'machine', '2:15 PM');
  push('p9', 'assistant', '**Prod deploy complete — canary clean**\n\n- Run 90317 completed success\n- Canary error rate 0.0% over 10m\n- Rollback armed, not needed', undefined, '2:16 PM');
  // A TEAMMATE message (human, non-owner origin) — must NEVER collapse.
  push('p10', 'user', 'jumping in from the shared project — the canary graph looks great', 'teammate', '2:20 PM');
  push('p11', 'assistant', 'Agreed — holding the watch for another 20 minutes, then I will close the loop.', undefined, '2:21 PM');
  return rows;
}

/* ── Row renderer (mirrors SupervisorChatTab.renderThreadRow) ────────────── */

function SeedThreadRow({ m }: { m: SeedRow }) {
  const sysKind = m.role === 'user'
    ? classifySystemRow({ role: m.role, content: m.content, metadata: { origin: m.origin } })
    : null;
  return (
    <div
      {...(m.role === 'user' && !sysKind ? { 'data-nav-msg': m.id, 'data-nav-preview': navPreview(m.content) } : {})}
      className={cn('flex', m.role === 'user' && !sysKind ? 'justify-end' : 'justify-start')}
    >
      {sysKind ? (
        <MachineWakeBlock kind={sysKind} origin={m.origin} content={m.content} timeLabel={m.time} />
      ) : m.role === 'user' ? (
        <div className="max-w-[85%] rounded-2xl px-3.5 py-2 text-sm bg-bubble text-ink">
          <span className="whitespace-pre-wrap break-words">{m.content}</span>
          <div className="text-[10px] mt-1 text-ink-2 text-right">{m.time}</div>
        </div>
      ) : (
        <div className="min-w-0 flex-1 text-sm" data-summary-note={m.id}>
          <MarkdownContent textSizeCls="text-sm leading-6" h1Cls="text-lg" h2Cls="text-base" h3Cls="text-sm" h4Cls="text-sm" thCls="text-xs" tdCls="text-xs">
            {m.content}
          </MarkdownContent>
          <div className="text-[10px] mt-1 text-muted-foreground">{m.time}</div>
        </div>
      )}
    </div>
  );
}

/* ── Page ────────────────────────────────────────────────────────────────── */

export default function DevAccordionHarness() {
  if (process.env.NODE_ENV === 'production') notFound();
  // SSR/hydration-safe legacy flag: SSR renders nothing, the client decides
  // after mount (a useState window initializer would hydrate-mismatch and
  // never flip).
  const [legacy, setLegacy] = useState<boolean | null>(null);
  const [scene, setScene] = useState<'supervisor' | 'project' | null>(null);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    setLegacy(p.has('legacy'));
    setScene(p.get('scene') === 'project' ? 'project' : 'supervisor');
  }, []);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Cold-open: land at the bottom (the newest summary note) and STAY pinned
  // while async content (markdown, highlighting) grows the scroll height —
  // a MutationObserver re-pin mirrors the real transcript's pinned-bottom.
  useEffect(() => {
    if (legacy === null) return;
    const el = scrollerRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const pin = () => { el.scrollTop = el.scrollHeight; };
    pin();
    const mo = new MutationObserver(pin);
    mo.observe(content, { childList: true, subtree: true });
    const t1 = setTimeout(pin, 500);
    const t2 = setTimeout(() => { pin(); mo.disconnect(); }, 3000);
    return () => { mo.disconnect(); clearTimeout(t1); clearTimeout(t2); };
  }, [legacy, scene]);

  if (legacy === null || scene === null) return null;

  const rows = scene === 'project' ? PROJECT_ROWS : ROWS;
  const items: any[] = legacy
    ? groupMachineRowsLegacy(rows)
    : groupMachineRows(rows, { probe, timeOf: r => r.time });

  return (
    <div className="mx-auto flex h-screen max-w-3xl flex-col gap-2 p-4">
      <div className="shrink-0 rounded-md border border-warn/40 bg-warn/10 px-3 py-1.5 text-xs text-warn-ink dark:bg-warn/15">
        DEV HARNESS — seeded {scene === 'project' ? 'PROJECT-CHAT' : 'supervisor'}-shaped transcript ({rows.length} rows, {legacy ? 'LEGACY #604 grouping' : 'FIXED per-wake grouping'}) · ?scene=project · ?legacy=1
      </div>
      <div className="relative flex-1 min-h-0">
        <div ref={scrollerRef} className="h-full overflow-y-auto rounded-md border border-border bg-muted/20 px-3 py-3">
          <div ref={contentRef} className="space-y-3">
            {items.map(item =>
              item.kind === 'machineGroup' ? (
                legacy ? (
                  <LegacyMachineTurnGroup key={item.key} count={item.count} summary={item.summary} preview={item.preview} timeLabel={item.timeLabel}>
                    {item.rows.map((r: SeedRow) => <SeedThreadRow key={r.id} m={r} />)}
                  </LegacyMachineTurnGroup>
                ) : (
                  <MachineTurnGroup key={item.key} count={item.count} summary={item.summary} headline={item.headline} timeLabel={item.timeLabel}>
                    {item.rows.map((r: SeedRow) => <SeedThreadRow key={r.id} m={r} />)}
                  </MachineTurnGroup>
                )
              ) : (
                <SeedThreadRow key={(item as MachineTurnItem<SeedRow> & { kind: 'row' }).row.id ?? (item as any).row.id} m={(item as any).row} />
              ),
            )}
          </div>
        </div>
        <MessageNavigator scrollerRef={scrollerRef} contentRef={contentRef} />
      </div>
    </div>
  );
}
