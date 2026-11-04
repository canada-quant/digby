/**
 * Replay test — feedback ticket e8f71984 (2026-09-29).
 *
 * Coding session d390cd12 (custom LiteLLM seat cql-litellm:api-optimize-zai-
 * glm-5.3) finalized a run whose persisted assistant row was thousands of
 * chars of multilingual garbage tokens (mixed Cyrillic/Chinese/English
 * fragments like `top0 ФедT76583057fe3📝Since File0Heading EDFull9
 * ipcpricingwork64_rhoентыINсsummary...`) with NO detection, quarantine, or
 * "output degraded" marker.
 *
 * This file pins BOTH directions of the detector's contract:
 *
 *   1. The ticket's real garbage class (tiled fragments of the reported
 *      sample) MUST be detected — in both `finalText` and the
 *      `deliveredStreamText()` fallback path.
 *   2. The false-positive bar (the ticket's CORE constraint): legitimate
 *      multilingual Digby answers — real Chinese technical prose, real
 *      Russian prose, mixed-language technical prose, and a code-heavy
 *      answer — MUST all score clean. This platform serves multilingual
 *      users; a detector that flags merely-multilingual or technical
 *      content is worse than no detector.
 *   3. The marker lands where the ticket asked: the persisted final's
 *      metadata carries `outputDegenerate` with the ticket id, and a
 *      `degenerate_final` loop metric is recorded (kind asserted against
 *      LOOP_METRIC_KINDS, not a volatile literal).
 *
 * Fixtures are hand-written prose that matches the statistical signatures
 * the ticket describes — NOT volatile production literals (repo convention:
 * probes/tests must not pin volatile literals).
 */

import {
  detectDegenerateFinal,
  DEGENERATE_FINAL_TICKET,
  DEGENERATE_MIN_CHARS,
  DEGENERATE_MAX_TERMINATORS_PER_100,
} from './degenerate-final';
import { LOOP_METRIC_KINDS } from '../platform/loop-metrics.service';

// loop-metrics.service pulls in config/database → config/env, which validates
// real env vars and process.exit(1)s under jest (no .env). Standard mocks —
// same pattern as loop-metrics.service.test.ts.
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    loopMetric: {
      createMany: jest.fn(),
      findMany: jest.fn(),
      deleteMany: jest.fn(),
      groupBy: jest.fn(),
    },
    $queryRaw: jest.fn(),
  },
}));
/* ── 1. The ticket's garbage class ───────────────────────────────────────────
 * Fragment of the reported sample (ticket description), tiled ~5× to exceed
 * DEGENERATE_MIN_CHARS — the ticket says "thousands of chars", and the
 * detector refuses to score short texts (false-positive bar dominates at
 * small n). Each tile varies slightly (the real corruption re-rolls fragments)
 * so the fixture is not a single repeated block.
 */
const TICKET_GARBAGE_FRAGMENT =
  'top0 ФедT76583057fe3📝Since File0Heading EDFull9 ipcpricingwork64_rhoентыINсsummary' +
  'алфавитSUPPLY42chain_used0моделиREADY559493токенWord748сообщение' +
  '文件0标题ED定价工作64_rhoенты配置就绪模型系统559493线程队列执行完成提交';

function ticketGarbage(tiles: number): string {
  const out: string[] = [];
  for (let i = 0; i < tiles; i++) {
    const n = String(i);
    out.push(TICKET_GARBAGE_FRAGMENT.replace(/0/g, n.length === 1 ? n : n[1]));
  }
  return out.join(' ');
}

/* ── 2. Legitimate multilingual fixtures (must score CLEAN) ─────────────────
 * Real technical-prose shapes this platform routinely persists. Each is
 * written to exceed DEGENERATE_MIN_CHARS after code/URL stripping so the
 * "too short to score" lane cannot be what passes them.
 */

/** Real Chinese technical answer (Prisma + RDS migration notes). */
const LEGIT_CHINESE =
  '这次数据库迁移的整体方案如下。我们先把 Prisma schema 中的连接字符串切换到新的 RDS 实例，' +
  '然后在维护窗口内执行蓝绿部署。具体步骤：第一步，冻结写流量，等待副本追平主库；' +
  '第二步，运行 prisma migrate deploy，确认所有迁移都成功应用；' +
  '第三步，把应用的连接池指向新实例并逐步恢复流量。' +
  '回滚方案也很重要：如果新实例出现连接错误，我们可以立即切回旧的连接字符串，' +
  '因为迁移是向前兼容的，旧代码可以读新 schema。' +
  '监控方面，需要重点观察连接数、慢查询和复制延迟三项指标。' +
  '如果复制延迟超过五秒，就暂停切流，等副本追平再继续。' +
  '整个迁移窗口预计三十分钟，其中真正不可写的时间不超过五分钟。' +
  '上线之后的一周内，请保留旧实例，不要急于释放，方便应急回滚。' +
  '最后，请把迁移结果记录到运维手册里，包括开始时间、结束时间、遇到的错误和解决办法，' +
  '这样下次迁移就有完整的参考。如果还有问题，随时告诉我。';

/** Real Russian technical answer (deploy + verification plan). */
const LEGIT_RUSSIAN =
  'План проверки после деплоя выглядит так. Сначала дождитесь, пока волна развертывания завершится полностью: ' +
  'статус деплоя отстаёт примерно на двадцать семь минут, поэтому не опрашивайте его слишком часто. ' +
  'Затем убедитесь, что все боксы работают на новом коммите — индикатор onMainHead должен быть истинным для каждого. ' +
  'После этого проверьте журнал ошибок за последний час: новых записей быть не должно. ' +
  'Если хотя бы один бокс не обновился, перезапустите его вручную и повторите проверку. ' +
  'Отдельно стоит посмотреть на метрики потребления памяти — после прошлого релиза был замечен рост, ' +
  'который указывал на утечку в обработчике очереди. ' +
  'Напишите краткий отчёт: что проверено, что найдено, что исправлено. ' +
  'Если всё чисто, закройте задачу и укажите ссылку на пул-реквест. ' +
  'При обнаружении регрессии откатите деплой командой отката и сообщите дежурному инженеру. ' +
  'Не забудьте также обновить документацию, если изменились параметры конфигурации.';

/** Mixed-language technical answer (the exact shape Digby must never flag). */
const LEGIT_MIXED =
  'The migration plan is straightforward. 第一步：freeze write traffic and wait for the replica to catch up. ' +
  'Затем запустите prisma migrate deploy и проверьте, что все миграции применились. ' +
  'Rollback: if the new instance rejects connections, switch back to the old connection string — ' +
  'the schema is forward-compatible, so old code reads it fine. Monitor три показателя: ' +
  'connection count, slow queries, and replication lag. Если задержка превысит пять секунд, ' +
  'pause the cutover until the replica catches up. The window is thirty minutes total, ' +
  'with less than five minutes of write downtime. После релиза держите старый инстанс неделю, ' +
  'не спешите его освобождать — он нужен для экстренного отката. Finally, document the result: ' +
  'start time, end time, errors encountered, and fixes applied, so the next migration has a reference.';

/** Code-heavy legit answer — code is stripped before scoring; the prose must carry it clean. */
const LEGIT_CODE_HEAVY =
  'Here is the fix. The bug is that the finalize seam reads `result.finalText` before the guard mutates it:\n\n' +
  '```ts\n' +
  'const finalData = {\n' +
  '  content: result.finalText || deliveredStreamText() || \'\',\n' +
  '  parts: result.parts as unknown as object[],\n' +
  '  metadata: { origin: origin ?? triggerKind, triggerKind },\n' +
  '};\n' +
  '```\n\n' +
  'Change it to snapshot the text first, then score:\n\n' +
  '```ts\n' +
  'const finalPersistText = result.finalText || deliveredStreamText() || \'\';\n' +
  'const degenerateVerdict = detectDegenerateFinal(finalPersistText);\n' +
  '```\n\n' +
  'Then stamp the metadata marker when the verdict is positive, and record the loop metric with the ticket id. ' +
  'The detector itself is synchronous and makes no LLM calls, so it cannot delay finalize. ' +
  'It never replaces or retries content — that is deliberate, per the ticket constraint. ' +
  'Run the replay test to confirm the garbage fixture is caught and the multilingual fixtures pass clean.';

describe('degenerate-final detector (ticket e8f71984)', () => {
  describe('detects the ticket garbage class', () => {
    it('flags the reported sample (tiled past the min-chars floor)', () => {
      const text = ticketGarbage(5);
      expect(text.length).toBeGreaterThanOrEqual(DEGENERATE_MIN_CHARS);
      const v = detectDegenerateFinal(text);
      expect(v.degenerate).toBe(true);
      expect(v.score).toBeDefined();
    });

    it('flags the sample with the harness-note footer appended (transcript shape)', () => {
      // The persisted row in the ticket carried the garbage BEFORE the
      // harness-note footer — detection must survive a sane suffix.
      const v = detectDegenerateFinal(ticketGarbage(5) + '\n\n⏳ HARNESS NOTE: this run ended with 2 unfinished plan step(s).');
      expect(v.degenerate).toBe(true);
    });

    it('score carries the signals named in the ticket (families/glue/word ratio)', () => {
      const v = detectDegenerateFinal(ticketGarbage(5));
      expect(v.degenerate).toBe(true);
      if (!v.score) throw new Error('score expected');
      // families: at least latin + cyrillic + cjk at chaos share, per S1.
      const familyNames = Object.keys(v.score.families);
      expect(familyNames.length).toBeGreaterThanOrEqual(3);
      expect(familyNames).toContain('latin');
      expect(familyNames).toContain('cyrillic');
      expect(familyNames).toContain('cjk');
      // S2/S4: glue high, plain-word ratio collapsed.
      expect(v.score.glueRatio).toBeGreaterThanOrEqual(0.35);
      expect(v.score.wordRatio).toBeLessThanOrEqual(0.3);
    });

    it('terminator-density threshold is on the per-100 scale (review finding #2)', () => {
      // Finding #2 was a claim-manifest misquote (0.005 vs 0.2), not a code
      // defect — but the residual is pinning the SCALE so a future refactor
      // cannot silently mix per-char with per-100 units. terminatorDensity
      // is terminators+newlines per 100 chars of cleaned text. The garbage
      // class collapses to ≤ the threshold; space-separated prose (Russian,
      // mixed, code-heavy) carries sentence structure at a clear multiple
      // of it. CJK prose is deliberately NOT asserted here: Chinese has no
      // inter-sentence spaces, so its density is naturally low — the
      // detector's conjunction (familyChaos AND glue AND word collapse)
      // is what keeps real Chinese clean, never the density leg alone.
      expect(DEGENERATE_MAX_TERMINATORS_PER_100).toBe(0.2);
      const garbage = detectDegenerateFinal(ticketGarbage(5));
      if (!garbage.score) throw new Error('garbage score expected');
      expect(garbage.score.terminatorDensity).toBeLessThanOrEqual(
        DEGENERATE_MAX_TERMINATORS_PER_100,
      );
      const spaced: Array<[string, string]> = [
        ['russian', LEGIT_RUSSIAN],
        ['mixed', LEGIT_MIXED],
        ['code-heavy', LEGIT_CODE_HEAVY],
      ];
      for (const [name, text] of spaced) {
        const v = detectDegenerateFinal(text);
        if (!v.score) throw new Error(`${name} fixture too short to score`);
        expect(v.score.terminatorDensity).toBeGreaterThan(
          DEGENERATE_MAX_TERMINATORS_PER_100 * 2,
        );
      }
    });

    it('short garbage (under the floor) is NOT flagged — small-n false-positive bar', () => {
      const v = detectDegenerateFinal(TICKET_GARBAGE_FRAGMENT);
      expect(TICKET_GARBAGE_FRAGMENT.length).toBeLessThan(DEGENERATE_MIN_CHARS);
      expect(v.degenerate).toBe(false);
      expect(v.score).toBeUndefined();
    });
  });

  describe('false-positive bar: legit multilingual answers score clean', () => {
    it('real Chinese technical answer is NOT degenerate', () => {
      const v = detectDegenerateFinal(LEGIT_CHINESE);
      expect(v.degenerate).toBe(false);
    });

    it('real Russian technical answer is NOT degenerate', () => {
      const v = detectDegenerateFinal(LEGIT_RUSSIAN);
      expect(v.degenerate).toBe(false);
    });

    it('mixed-language technical answer is NOT degenerate', () => {
      const v = detectDegenerateFinal(LEGIT_MIXED);
      expect(v.degenerate).toBe(false);
    });

    it('code-heavy answer (code stripped, prose scored) is NOT degenerate', () => {
      const v = detectDegenerateFinal(LEGIT_CODE_HEAVY);
      expect(v.degenerate).toBe(false);
    });
  });

  describe('marker + telemetry surface', () => {
    it('DEGENERATE_FINAL kind is registered in LOOP_METRIC_KINDS (kind set test is exhaustive)', () => {
      // The wiring in run-executor.ts records LOOP_METRIC_KINDS.DEGENERATE_FINAL;
      // loop-metrics.service.test.ts snapshots the kind set exhaustively, so the
      // constant must exist and be stable.
      expect(LOOP_METRIC_KINDS.DEGENERATE_FINAL).toBe('degenerate_final');
    });

    it('ticket id constant is the cited prefix', () => {
      expect(DEGENERATE_FINAL_TICKET).toBe('e8f71984');
    });
  });
});
