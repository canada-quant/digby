/**
 * Topic-feeds retirement (ticket 43c24152, owner directive 2026-10-20) —
 * source-level pins that the whole feed subsystem stays DEAD. The owner
 * retired feeds outright ("we dont want that anymore as digby is much more
 * evolved"): a topic digest is a schedule on a real chat now (schedule_message
 * — full agent turn, memory, tools, delta-gating), and every existing feed was
 * migrated to a schedule on its own chat by 20261020190000_retire_topic_feeds.
 *
 * Pins, at the source level (this suite's established idiom — readFileSync,
 * no runtime imports of the tool registry):
 *   1. The five feed tools are absent from EVERY registry surface: the
 *      platform-tool-names leaf (READ/MUTATING/ASK-ONLY lists), the account
 *      tool list, the housekeeping tool list, the work-tools table, the coding
 *      tool-groups account group and the provider-limits trim pins.
 *   2. The chat doctrine routes "keep me posted / follow this topic / daily
 *      digest" to schedule_message and never to create_feed.
 *   3. The /feeds routes are 410 tombstones (no controller handlers).
 *   4. The feed scheduler cron is gone from the worker.
 *   5. The feeds→schedules migration exists, converts every feed with a chat,
 *      keeps a paused feed paused (enabled=false), and drops the feed tables.
 *   6. The Feeds tab is gone from the account page and the feedsApi client
 *      from the frontend API module.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
// here = frontend/app/crossmodel → repo root is three levels up.
const repoRoot = join(here, '../../..');
const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8');

const TOOL_NAMES = read('backend/src/modules/crossmodel/platform/platform-tool-names.ts');
const ACCOUNT_TOOLS = read('backend/src/modules/crossmodel/platform/account-tools.ts');
const HOUSEKEEPING = read('backend/src/modules/crossmodel/platform/housekeeping-tools.ts');
const PLATFORM_TOOLS = read('backend/src/modules/crossmodel/platform/platform-tools.ts');
const WORK_TOOLS = read('backend/src/modules/crossmodel/platform/work-tools.ts');
const TOOL_GROUPS = read('backend/src/modules/crossmodel/coding/tool-groups.ts');
const AGENT = read('backend/src/modules/crossmodel/coding/agent.ts');
const PROVIDER_LIMITS = read('backend/src/modules/crossmodel/coding/provider-limits.ts');
const DOCTRINE = read('backend/src/modules/crossmodel/chat-agent/capability-doctrine.ts');
const ROUTES = read('backend/src/modules/crossmodel/crossmodel.routes.ts');
const CONTROLLER = read('backend/src/modules/crossmodel/crossmodel.controller.ts');
const WORKER = read('backend/src/worker.ts');
const SCHEMA = read('backend/prisma/schema.prisma');
const ACCOUNT_PAGE = read('frontend/app/crossmodel/account/page.tsx');
const FE_API = read('frontend/lib/api/crossmodel.ts');
const SUGGESTED = read('backend/src/modules/crossmodel/suggested-questions.service.ts');
const BACKFILL = read('backend/src/scripts/backfill-user-space.ts');

const FEED_TOOLS = ['create_feed', 'list_feeds', 'set_feed', 'refresh_feed', 'delete_feed'];

describe('feeds retirement (43c24152) — the tool surface', () => {
  it('no feed tool appears in the platform-tool-names leaf (any list)', () => {
    // The leaf is the source of truth every registry derives from: a feed tool
    // string here would resurrect it in the model-facing tool list.
    for (const tool of FEED_TOOLS) {
      expect(TOOL_NAMES).not.toContain(`'${tool}'`);
    }
  });

  it('no feed tool appears in the account / housekeeping / platform tool modules', () => {
    for (const [label, src] of [
      ['account-tools', ACCOUNT_TOOLS],
      ['housekeeping-tools', HOUSEKEEPING],
      ['platform-tools', PLATFORM_TOOLS],
      ['work-tools', WORK_TOOLS],
      ['tool-groups', TOOL_GROUPS],
      ['agent', AGENT],
      ['provider-limits', PROVIDER_LIMITS],
    ] as const) {
      for (const tool of FEED_TOOLS) {
        // Allow the ticket-citation COMMENTS that record the retirement, but
        // never a live schema entry, case label or table key.
        for (const line of src.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
          expect(`${label}: ${line}`).not.toContain(`'${tool}'`);
        }
      }
    }
  });

  it('the feed.service module is deleted', () => {
    expect(existsSync(join(repoRoot, 'backend/src/modules/crossmodel/feed.service.ts'))).toBe(false);
  });

  it('the doctrine routes topic-digest asks to schedule_message, never create_feed', () => {
    expect(DOCTRINE).toContain('keep me posted / follow this topic / daily digest / topic digest → schedule_message');
    expect(DOCTRINE).not.toMatch(/→\s*create_feed/);
  });
});

describe('feeds retirement (43c24152) — routes, worker, schema', () => {
  it('every /feeds route is a 410 tombstone with the feeds_retired code', () => {
    expect(ROUTES).toContain('feeds_retired');
    expect(ROUTES).toContain("res.status(410)");
    for (const verb of ["router.post('/feeds'", "router.get('/feeds'", "router.put('/feeds/:id'", "router.delete('/feeds/:id'", "router.post('/feeds/:id/refresh'", "router.post('/feeds/enhance'"]) {
      expect(ROUTES).toContain(`${verb}, feedRetired)`);
    }
  });

  it('the controller no longer defines any feed handler', () => {
    for (const handler of ['createFeed', 'listFeeds', 'getFeed', 'deleteFeed', 'updateFeed', 'enhanceFeedTopic', 'refreshFeed']) {
      expect(CONTROLLER).not.toContain(`async ${handler}(`);
    }
  });

  it('the feed-refresh cron is gone from the worker', () => {
    expect(WORKER).not.toContain("'feed-refresh'");
    expect(WORKER).not.toContain('runFeedSweepOnce');
    expect(WORKER).not.toContain('runFeedStartupMaintenanceOnce');
  });

  it('the UserFeed / UserFeedEntry models are gone from the prisma schema', () => {
    expect(SCHEMA).not.toContain('model UserFeed');
    expect(SCHEMA).not.toContain('model UserFeedEntry');
    expect(SCHEMA).not.toContain('user_feeds');
    expect(SCHEMA).not.toContain('user_feed_entries');
  });
});

describe('feeds retirement (43c24152) — the no-cliff migration', () => {
  const MIGRATION = 'backend/prisma/migrations/20261020190000_retire_topic_feeds/migration.sql';
  let sql: string;
  it('exists', () => {
    expect(existsSync(join(repoRoot, MIGRATION))).toBe(true);
    sql = read(MIGRATION);
  });

  it('converts every feed WITH a chat into a recurring schedule on that chat', () => {
    expect(sql).toContain('INSERT INTO "coding_schedules"');
    expect(sql).toContain('FROM "user_feeds" f');
    expect(sql).toContain("f.\"chatId\" IS NOT NULL");
    expect(sql).toContain("'recurring'");
    // cadence = the feed's interval (minutes → seconds)
    expect(sql).toMatch(/GREATEST\(60, f\."intervalMinutes"\) \* 60/);
    // the prompt carries the topic (the digest ask)
    expect(sql).toContain('f."topic"');
  });

  it('a PAUSED feed stays paused (enabled=false — never silently re-subscribe)', () => {
    expect(sql).toContain('(f."status" <> \'paused\')');
  });

  it('posts one visible deprecation notice into each feed chat', () => {
    expect(sql).toContain('This feed has been retired');
    expect(sql).toContain('INSERT INTO "crossmodel_messages"');
  });

  it('drops the feed tables (entries first — FK order)', () => {
    const entriesIdx = sql.indexOf('DROP TABLE IF EXISTS "user_feed_entries"');
    const feedsIdx = sql.indexOf('DROP TABLE IF EXISTS "user_feeds"');
    expect(entriesIdx).toBeGreaterThan(0);
    expect(feedsIdx).toBeGreaterThan(entriesIdx);
  });

  it('is idempotent (a re-run cannot double-create schedules or notices)', () => {
    const inserts = sql.match(/INSERT INTO "coding_schedules"[\s\S]*?;/)?.[0] ?? '';
    expect(inserts).toContain('NOT EXISTS');
    const notice = sql.match(/INSERT INTO "crossmodel_messages"[\s\S]*?;/)?.[0] ?? '';
    expect(notice).toContain('NOT EXISTS');
  });
});

describe('feeds retirement (43c24152) — the frontend surface', () => {
  it('no Feeds tab, no FeedsTab import, no feeds render case in Settings', () => {
    expect(ACCOUNT_PAGE).not.toContain("label: 'Feeds'");
    expect(ACCOUNT_PAGE).not.toContain("import { FeedsTab } from './FeedsTab'");
    expect(ACCOUNT_PAGE).not.toContain('<FeedsTab />');
  });

  it('FeedsTab.tsx and the feedsApi client are deleted', () => {
    expect(existsSync(join(repoRoot, 'frontend/app/crossmodel/account/FeedsTab.tsx'))).toBe(false);
    expect(FE_API).not.toContain('export const feedsApi');
    expect(FE_API).not.toContain('interface UserFeed ');
  });
});

describe('feeds retirement (43c24152) — dead-pointer sweep (adversarial-review finding 1)', () => {
  // The UserFeed models are gone from the prisma schema (pinned above), so any
  // surviving `feed: { … }` filter on CrossModelChat is a DEAD POINTER:
  // PrismaClientValidationError at runtime, invisible to tsc (the filter is
  // hoisted into a const, so no excess-property check fires) and to the
  // prisma-mocking suites — the old suggested-questions pins even asserted the
  // dead shape. Found by the adversarial review of 287308d7c; pinned so the
  // class can never return with a relation-dropping migration.
  it('no live Prisma filter on the dropped CrossModelChat.feed relation', () => {
    expect(SUGGESTED).not.toContain('feed: {');
    expect(BACKFILL).not.toContain('feed: {');
    expect(BACKFILL).toContain('const UNFILED = { projectId: null, isSupervisor: false } as const;');
  });

  it('the migration notice uses E-strings, so \\n renders as a line break (not backslash-n)', () => {
    // Postgres standard_conforming_strings=on (default since 9.1) renders '\n'
    // inside a plain literal as two characters; E'' is what breaks the line.
    const sql = read('backend/prisma/migrations/20261020190000_retire_topic_feeds/migration.sql');
    expect(sql).toContain("E'📡 **This feed has been retired**");
    expect(sql).toContain("|| E'**Nothing is lost**");
    expect(sql).toContain("|| E'*Topic: '");
    // no plain (non-E) concatenated literal still carries an escape sequence
    expect(sql.match(/\|\| '[^']*\\n/)).toBeNull();
  });

  it('the user-facing API docs no longer promise feed tools or /feeds routes', () => {
    for (const doc of [read('frontend/content/help/platform-api.md'), read('docs/DIGBY_PLATFORM_API.md')]) {
      for (const tool of FEED_TOOLS) expect(doc).not.toContain(`\`${tool}\``);
      expect(doc).not.toContain('/feeds');
    }
  });
});
