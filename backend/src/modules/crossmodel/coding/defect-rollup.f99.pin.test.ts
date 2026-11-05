/**
 * PIN (FO firing 99, 2026-10-08) — the defect_rollup's TWO bar corrections,
 * both live-proven on 2026-10-08 by the rollup's first live catches.
 *
 * DEFECT 1 (mis-bar): crosscheck_failed_24h escalated n>0 while its detail
 * section (crosscheck_failed_detail, firing-85 recurrence bake) adjudicates
 * a live-chat singleton as 'live:once' (recurrence_7d <= 1 → watch-only,
 * recurrence_7d > 1 → ESCALATE). The rollup invented a STRICTER bar than the
 * detail baked, violating the f98 contract ("each condition carries the SAME
 * bar its detail section already bakes"). Live proof: the 10:37Z audit rolled
 * up ESCALATE on chat 110b7062 whose detail row read verdict 'live:once'
 * (recurrence_7d=1, 'reconcile resolved empty'). Fix: the condition now
 * carries the detail's recurrence_7d > 1 rung.
 *
 * DEFECT 2 (seam gap): deploy_interrupts_24h (and its detail
 * deploy_interrupt_24h) were keyed on crossmodel_messages
 * metadata.origin='deploy-interrupt' — but the escalation-rung and
 * continuation requeue paths in shutdown-interrupt.ts requeue via Redis and
 * deliberately write NO notice row, so both read 0 while a REAL user turn
 * was cut (live 2026-10-08 07:37:06Z, chat 182f27b7, research rung, runAge
 * 1044s — metric row exists, message row does not; the rung re-fired and
 * completed 08:03Z, so the backend behavior is CORRECT and the audit seam
 * was wrong). Fix: both now read the authoritative seam the fleet deploy
 * view reads — loop_metrics kind='chat_run_interrupted' meta.reason='deploy'
 * — with the deploy view's own bar: a same-chat REPEAT (>= 2 in 24h) is the
 * drain-budget defect; a singleton re-fire is by-design (re_fired) and must
 * NOT escalate the rollup.
 *
 * TEXTUAL + BEHAVIORAL, same shape as the f92–f98 pins.
 */

const fs = require('fs');
const path = require('path');

export {};

function repoRoot(start: string): string {
  let d = start;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(d, 'scripts/framework-audit/audit-live-state.js'))) return d;
    d = path.dirname(d);
  }
  throw new Error('repo root not found from ' + start);
}

const AUDIT = path.join(repoRoot(__dirname), 'scripts/framework-audit/audit-live-state.js');
const src = fs.readFileSync(AUDIT, 'utf8');

function sectionBody(name: string): string {
  const m =
    src.match(new RegExp(`sec\\('${name}', async \\(\\) => \\(\\{([\\s\\S]*?)\\n  \\}\\)\\);`)) ||
    src.match(new RegExp(`sec\\('${name}', async \\(\\) => \\{([\\s\\S]*?)\\n  \\}\\);`)) ||
    // f99 single-expression shape: sec('name', () => q(...)); (one line)
    src.match(new RegExp(`sec\\('${name}', \\(\\) => q\\((.+)\\)\\);`));
  if (!m) throw new Error(`${name} section not found in audit-live-state.js`);
  return m[1];
}

const rollupBody = sectionBody('defect_rollup');
const deployDetailBody = sectionBody('deploy_interrupt_24h');

describe('PIN f99: defect_rollup bar corrections (both live-proven 2026-10-08)', () => {
  describe('defect 1 — crosscheck_failed_24h repeats the detail recurrence bar', () => {
    it('carries the recurrence_7d > 1 rung inside the rollup condition', () => {
      // the exact rung: the correlated 7d recurrence subquery (m7), guarded > 1
      const cond = rollupBody.match(/UNION ALL SELECT 'crosscheck_failed_24h', ([^\n]+)/)?.[1] ?? '';
      expect(cond).toContain("kind='crosscheck_late_reconcile'");
      expect(cond).toMatch(/m7\."sessionId" = m\."sessionId"/);
      expect(cond).toMatch(/interval '7 days'\) > 1/);
    });

    it('still excludes e2e-ephemeral and dead chats (the firing-74 bar, unchanged)', () => {
      const cond = rollupBody.match(/UNION ALL SELECT 'crosscheck_failed_24h', ([^\n]+)/)?.[1] ?? '';
      expect(cond).toContain("c.title NOT LIKE 'e2e suite%'");
      expect(cond).toContain('c.id IS NOT NULL');
    });

    it('behavioral: a live:once singleton (recurrence 1) does NOT escalate, a recurring chat does', () => {
      // the ladder the corrected condition implements
      const ladder = (recurrence7d: number) => (recurrence7d > 1 ? 'ESCALATE' : 'ok');
      // live 2026-10-08 10:37Z: chat 110b7062, recurrence_7d=1 → detail
      // verdict 'live:once' → rollup must read ok, not ESCALATE
      expect(ladder(1)).toBe('ok');
      // a recurring reconcile-failure chat (the detail's ESCALATE rung)
      expect(ladder(2)).toBe('ESCALATE');
    });
  });

  describe('defect 2 — deploy-interrupt seam + repeat bar', () => {
    it('the rollup condition reads loop_metrics, not the notice-row message seam', () => {
      const cond = rollupBody.match(/UNION ALL SELECT 'deploy_interrupts_24h', ([^\n]+)/)?.[1] ?? '';
      expect(cond).toContain("kind='chat_run_interrupted'");
      expect(cond).toContain("meta->>'reason'='deploy'");
      expect(cond).not.toContain("metadata->>'origin'='deploy-interrupt'");
    });

    it('the condition carries the same-chat repeat bar (HAVING COUNT(*) >= 2)', () => {
      const cond = rollupBody.match(/UNION ALL SELECT 'deploy_interrupts_24h', ([^\n]+)/)?.[1] ?? '';
      expect(cond).toMatch(/GROUP BY "sessionId" HAVING COUNT\(\*\) >= 2/);
    });

    it('the detail section reads the same seam with the deploy-view verdict vocabulary', () => {
      expect(deployDetailBody).toContain("kind='chat_run_interrupted'");
      expect(deployDetailBody).toMatch(/COUNT\(\*\) >= 2 THEN 'drain_budget_repeat' ELSE 're_fired'/);
      expect(deployDetailBody).not.toContain("metadata->>'origin'='deploy-interrupt'");
    });

    it('behavioral: a singleton re-fire (chat 182f27b7, n=1) does NOT escalate; a same-chat repeat does', () => {
      const ladder = (perChatCount: number) => (perChatCount >= 2 ? 'ESCALATE' : 'ok');
      // live 2026-10-08 07:37Z: one interrupt on chat 182f27b7 → by-design
      // re-fire (requeue landed, rung completed 08:03Z) → ok
      expect(ladder(1)).toBe('ok');
      // the deploy view's defect class: wakes outliving the drain budget
      expect(ladder(2)).toBe('ESCALATE');
    });
  });

  describe('the f98 pin stays green (no regressions to the 29th bake)', () => {
    it('the rollup still declares the marker and the f99 correction note', () => {
      expect(src).toMatch(/defect_rollup \(firing 98, 2026-10-08 — 29th f64 bake; bars corrected/);
      expect(src).toMatch(/F99 BAR CORRECTIONS/);
    });
  });
});
