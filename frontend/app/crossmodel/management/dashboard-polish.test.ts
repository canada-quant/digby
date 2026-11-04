/**
 * Dashboard polish pins (owner polish pass 2026-09-03) — the fleet-summary
 * hero ordering, the collapsed supervisor row, pulse-tile truncation fixes,
 * and the shared wake-headline classifier wiring.
 *
 * SOURCE-LEVEL pins (the c1-convergence-smoke idiom): DashboardTab is a
 * ~1500-line client component with useRouter + polling effects, so a full
 * render is infeasible in the node-environment vitest setup — pins anchor on
 * stable identifiers (JSX comments, distinctive strings), never line numbers.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const SRC = readFileSync(fileURLToPath(new URL('./DashboardTab.tsx', import.meta.url)), 'utf8');

describe('DashboardTab polish [owner 2026-09-03] hero ordering', () => {
  it('renders pulse strip → supervisor slim row → FleetSummaryCard → Goals, in that order', () => {
    const pulse = SRC.indexOf('── PULSE — one-glance framework digest');
    const supervisorRow = SRC.indexOf('Supervisor — a single slim borderless row');
    const summaryMount = SRC.indexOf('<FleetSummaryCard summary={fleetSummary}');
    const goals = SRC.indexOf('Goals — the live work breakdown');
    expect(pulse).toBeGreaterThanOrEqual(0);
    expect(supervisorRow).toBeGreaterThan(pulse);
    expect(summaryMount).toBeGreaterThan(supervisorRow);
    expect(goals).toBeGreaterThan(summaryMount);
  });

  it('the FleetSummaryCard mounts exactly ONCE (the old below-counts mount is gone)', () => {
    const first = SRC.indexOf('<FleetSummaryCard');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(SRC.lastIndexOf('<FleetSummaryCard')).toBe(first);
  });

  it('keeps the card\'s hero identity (Frontier sweep 2026-10-06: a neutral line-2 border + a 5% ink tint, not indigo)', () => {
    expect(SRC).toContain('border-line-2/40 bg-send/5');
  });
});

describe('DashboardTab polish [owner 2026-09-03] collapsed supervisor row', () => {
  it('the redundant "Fleet Supervisor" card title is gone; the slim row keeps status + queue + click-through', () => {
    // No card whose TITLE is "Fleet Supervisor" wrapping a row that repeats it.
    expect(SRC).not.toMatch(/CardTitle[^>]*>[\s\S]{0,120}?Fleet Supervisor\s*<\/CardTitle>/);
    // Nothing lost: title, running/idle badge, queued badge, coding badge, and
    // an explicit "Open chat" action on the existing onGoSupervisor callback.
    const row = SRC.slice(
      SRC.indexOf('Supervisor — a single slim borderless row'),
      SRC.indexOf('Fleet summary — the supervisor'),
    );
    expect(row).toContain('{supervisor.title}');
    expect(row).toContain('>Idle</Badge>');
    expect(row).toContain('{counts.queuedMessages} queued');
    expect(row).toContain('supervisor.codingStatus');
    expect(row).toContain('onClick={onGoSupervisor}');
    expect(row).toContain('Open chat');
    expect(row).toContain('not configured'); // the unprovisioned state survives too
  });
});

describe('DashboardTab polish [owner 2026-09-03] pulse-tile truncation', () => {
  it('PulseTile sublines WRAP (break-words) instead of truncating mid-word', () => {
    expect(SRC).toContain('text-[10px] text-muted-foreground/80 break-words');
    expect(SRC).not.toContain('text-[10px] text-muted-foreground/80 truncate');
  });

  it('the evidence-guard tile moves the long receipts detail to a title tooltip + short subline', () => {
    expect(SRC).toContain('Receipts last 24h:');
    expect(SRC).toContain('{pulse.guard.receipts.total24h} receipts · {pulse.guard.receipts.failed24h} failed');
    // The old mid-parenthesis subline shape is gone.
    expect(SRC).not.toContain('receipts 24h: {pulse.guard.receipts.total24h} ({pulse.guard.receipts.failed24h} failed)');
  });
});

describe('DashboardTab polish [owner 2026-09-03] clickable count tiles', () => {
  it('Projects tile scrolls to the Projects card (in-page anchor, the ticket-queue idiom)', () => {
    expect(SRC).toContain("document.getElementById('fleet-projects-section')?.scrollIntoView");
    expect(SRC).toContain('id="fleet-projects-section"');
  });

  it('Chats and Queued-messages tiles stay STATIC (no in-page target — never invent routes)', () => {
    expect(SRC).toMatch(/<StatCard icon=\{MessageSquare\} label="Chats" value=\{counts\.chats\} \/>/);
    expect(SRC).toMatch(/<StatCard icon=\{Inbox\} label="Queued messages" value=\{counts\.queuedMessages\} \/>/);
  });
});

describe('DashboardTab polish [owner 2026-09-03] shared wake-headline classifier', () => {
  it('the card tints via classifyWakeHeadline; the local `failed` regex is gone', () => {
    expect(SRC).toContain("import { parseSupervisorWakeNote, classifyWakeHeadline, cleanWakeLabel } from '@/lib/fleet-summary';");
    expect(SRC).toContain('classifyWakeHeadline(headline)');
    expect(SRC).not.toContain('/\\b(fail|error|blocked)\\b/i');
    // Collapsed label is cleaned; the expanded note text stays as parsed.
    expect(SRC).toContain('cleanWakeLabel(headline)');
  });
});

describe('FleetSummaryCard briefing mode [owner 2026-09-04] plain-English owner briefings', () => {
  // The briefing branch: from the kind gate to the technical parse that starts
  // the wake fallback. Everything friendly lives inside; everything technical
  // (chips, tone tinting, wake parse) must stay OUT of it.
  const gate = SRC.indexOf("if (note.kind === 'briefing')");
  const wakeParse = SRC.indexOf('const { headline, chips, body } = parseSupervisorWakeNote(note.content)');
  const branch = SRC.slice(gate, wakeParse);

  it('branches on note.kind BEFORE the technical wake parse (briefing preferred, wake = fallback)', () => {
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(wakeParse).toBeGreaterThan(gate);
  });

  it('renders a friendly paragraph: line-clamped ~3 collapsed, expanded inline on tap', () => {
    expect(branch).toContain('line-clamp-3');
    expect(branch).toContain('whitespace-pre-wrap');
    expect(branch).toContain('setExpanded');
    expect(branch).toContain('{note.content.trim()}');
  });

  it('NO chips, NO wake-tone tinting, NO markdown-parse chrome in briefing mode', () => {
    expect(branch).not.toContain('<Badge');
    expect(branch).not.toContain('chips.map');
    expect(branch).not.toContain('chips.length');
    expect(branch).not.toContain('classifyWakeHeadline');
    expect(branch).not.toContain('cleanWakeLabel');
    expect(branch).not.toContain('text-destructive');
  });

  it('keeps the hero identity (indigo, relative time) and swaps the footer + action: "your fleet briefing" / Open chat → onGoSupervisor', () => {
    expect(branch).toContain('border-line-2/40 bg-send/5');
    expect(branch).toContain('{relativeTime(note.createdAt)}');
    expect(branch).toContain('your fleet briefing');
    expect(branch).toContain('onClick={onGoSupervisor}');
    expect(branch).toContain('Open chat');
    // The wake-mode footer stays out of the briefing branch…
    expect(branch).not.toContain('from the supervisor transcript');
  });

  it('wake mode is UNCHANGED: transcript footer, Open-wake action, chips render — and the mount passes onGoSupervisor', () => {
    const wakeBranch = SRC.slice(wakeParse);
    expect(wakeBranch).toContain('from the supervisor transcript');
    expect(wakeBranch).toContain('onOpenWake(note.id)');
    expect(wakeBranch).toContain('{chips.map((c, i) => (');
    expect(SRC).toContain('<FleetSummaryCard summary={fleetSummary} onOpenWake={onOpenWake} onGoSupervisor={onGoSupervisor} />');
  });
});
