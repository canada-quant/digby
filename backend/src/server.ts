import app from './app';
import { env } from './config/env';
import { connectRedis } from './config/redis';
import prisma from './config/database';
import logger from './utils/logger';
import { cleanupStaleTmpFiles } from './modules/crossmodel/upload.controller';
import { startCodingScheduleSweeper } from './modules/crossmodel/coding/schedule.service';
import { startChatOrphanSweeper, drainDeployRequeue } from './modules/crossmodel/chat-agent/orphan-recovery';
import { startOwnerGateSweeper } from './modules/crossmodel/platform/owner-gate-sweeper';
import { startFirstPromptRecoverySweeper } from './modules/crossmodel/platform/first-prompt-recovery';
import { sweepOrphanedRunningSessions } from './modules/crossmodel/coding/coding-data.service';
import { reconcileOrphanedRuns } from './modules/crossmodel/coding/run-state';
import { startCloudLinkTunnelIfLinked } from './cloud-link/tunnel-client';

const PORT = parseInt(env.PORT, 10);

const startServer = async () => {
  try {
    // Connect to Redis
    await connectRedis();

    // Test database connection
    await prisma.$connect();
    logger.info('✅ Database connected');

    // Clean up stale /tmp upload files from any previous server instance.
    // The in-process setTimeout cleanup is lost on restart, so files can accumulate.
    cleanupStaleTmpFiles();

    // Infra watch (owner 2026-09-18 — the fleet supervisor as framework
    // operator): the web process reports its box's disk / memory / load every
    // 15 min as a box_health row (box B has no worker, so this is its only
    // reporter); the attention watchdog raises [INFRA ALERT] wakes from them.
    // Kill-switch INFRA_WATCH_DISABLED=1 (read inside).
    try {
      const { startBoxHealthReporter } = await import('./modules/crossmodel/fleet/infra-watch.service');
      startBoxHealthReporter('web');
    } catch (err: any) {
      // Isolation boundary (ticket c75b5f34, review F12): the boot hard-fail
      // must NOT be demoted to a warn by this non-fatal catch. A non-prod
      // instance configured to watch the PRODUCTION repo refuses to serve —
      // rethrow → startServer's outer catch exits 1, the SAME hard fail the
      // worker's static import produces (worker.ts imports the module at top
      // level, so its boot crashes already). Anything else (transient boot
      // failure) keeps the historical non-fatal warn.
      if (err?.name === 'IsolationBoundaryError') throw err;
      logger.warn(`infra-watch: box health reporter did not start (non-fatal): ${err?.message ?? err}`);
    }

    // Durable cron (Phase 3): the five recurring background sweeps that used
    // to start here as in-process setIntervals — news prefetch, feed refresh,
    // memory dream cycle, container reaper, worktree reaper — now live in the
    // WORKER (worker.ts → cron.service.ts), claimed out of the cron_jobs table
    // with misfire catch-up, so they survive deploys/crashes like coding runs
    // do. The start* exports remain in their modules for reference/manual use.

    // Digby Code: heal sessions orphaned at status='running' by a hard-killed
    // instance (no lock held + no claimable agent_runs row ⇒ nothing is or will
    // be running them — the Phase-2 worker claim loop owns rows that do exist).
    // One boot-time pass; the SSE attach path handles the live cases.
    void sweepOrphanedRunningSessions().catch(() => {});

    // Durability Phase 1: mark durable agent-runs left 'running' by a
    // hard-killed instance as 'interrupted' (stale heartbeat / expired lease ⇒
    // nothing is running them) so their checkpoints stay resumable.
    void reconcileOrphanedRuns().catch(() => {});

    // Digby Code self-scheduler: fire due coding-session schedules (60s sweep,
    // DB-backed + Redis-NX-locked so only one blue/green instance fires a row).
    // Lets the orchestrator restart its own session over days (schedule_self).
    startCodingScheduleSweeper();

    // Plain-chat orphan recovery (ticket 68bc5aec): plain-chat runs have no
    // durable state, so a deploy/restart vanishes them mid-turn — corpse-queued
    // pending messages never drain and unanswered user rows sit forever. This
    // per-web-instance sweep re-fires/escalates them (blue-green safe via
    // startDetachedChatRun's atomic claim; coding chats are excluded — the
    // run-reaper owns those).
    startChatOrphanSweeper();

    // Self-host setup hardening (2026-10-20): keep the instance-setup leaf's
    // admin-store web-search note fresh (a process with BRIGHTDATA_API_TOKEN
    // never polls — production is untouched).
    import('./modules/crossmodel/platform/search-provider-config')
      .then((m) => m.startWebSearchStorePrimer())
      .catch((err) => logger.warn(`web-search store primer did not start: ${err?.message || err}`));

    // Owner-gate backstop (ticket 356d21bb): an owner answer resolves ALL
    // derived gates inline (owner-questions fan-out) — this 5-min sweep reaps
    // whatever the inline path missed (deploy mid-answer, crash between flip
    // and fan-out): todos/goals blocked on answered gate questions, OPEN
    // duplicate rows of answered decisions, and stale live ask_user pendings
    // matching an answered question. All writes are conditional one-shot
    // flips, so the two blue/green instances converge. Kill switch:
    // OWNER_GATE_SWEEPER_DISABLED=1.
    startOwnerGateSweeper();

    // Deploy-interrupt requeue (feedback 56159c5a): the OLD color's SIGTERM
    // ritual RPUSHed its in-flight chat turns onto a durable Redis list on its
    // way down — drain it NOW at boot (the incoming color re-fires those turns
    // within seconds instead of the owner waiting out the orphan grace). The
    // 2-min sweep also drains it; this immediate pass is the whole point of
    // the requeue. Idempotent: every entry re-verifies the turn is still
    // unanswered before re-firing (a run that finished anyway voids its entry).
    void drainDeployRequeue().catch((err) => logger.warn('deploy requeue boot-drain failed:', err));

    // First-prompt recovery (nightly finding 2026-08-28: three spawned batch
    // sessions sat ready-and-empty forever — startCodingSession's fire-and-
    // forget first-prompt delivery died with the process and the prompt was
    // never persisted). Per-web-instance sweep delivering the Redis-stashed
    // pending prompt to ready-but-empty coding sessions (blue-green safe via
    // the per-session Redis delivery lock).
    startFirstPromptRecoverySweeper();

    // Digby Edge (Phase 3): if this instance is paired TO a cloud (a cloud_link
    // row with state='linked'), hold the outbound WSS tunnel to the cloud's
    // relay so the cloud can proxy requests down here. No-op when unpaired or
    // CLOUD_LINK_DISABLED is set.
    void startCloudLinkTunnelIfLinked().catch((err) => {
      logger.warn('cloud-link: tunnel boot failed:', err);
    });

    // Decision-gate caches primed BEFORE traffic (audit 2026-09-26 gate-runtime-1):
    // the first Auto-routed send of every fresh web process used to run the
    // heuristic (store 'act' read as the env default 'shadow'). Bounded 1.5 s,
    // fail-open to the env chain.
    {
      const { primeDecisionModesOnce } = await import('./modules/crossmodel/platform/decision-gate');
      const { refreshDecisionBackends } = await import('./modules/crossmodel/platform/decision-gate-backends');
      await Promise.allSettled([primeDecisionModesOnce(), Promise.race([refreshDecisionBackends(), new Promise(res => setTimeout(res, 1500).unref())])]);
    }

    // Start server
    const httpServer = app.listen(PORT, '0.0.0.0', () => {
      logger.info(`🚀 Server running on port ${PORT}`);
      // Warm the per-turn model-pick evidence (2026-10-05) so the first human turns after a deploy still get a pick
      // (platform/model-evidence.ts — cached 10 min per process). Fire-and-forget; never blocks or fails the boot.
      void import('./modules/crossmodel/platform/model-evidence').then((m) => m.loadModelEvidence()).catch(() => {});
      logger.info(`📚 API Documentation: http://localhost:${PORT}/api-docs`);
      logger.info(`Environment: ${env.NODE_ENV}`);
    });

    const gracefulShutdown = async (signal: string) => {
      logger.info(`${signal} received, shutting down gracefully`);
      // Forced exit is armed FIRST so nothing below can hang the shutdown.
      setTimeout(() => {
        logger.warn('Forced shutdown after 25s timeout');
        process.exit(1);
      }, 25000);
      // Deploy-interrupt ritual (feedback 56159c5a): the web process OWNS the
      // detached chat runs (they die with it) — before closing HTTP, persist an
      // honest interrupt row + durable Redis requeue entry for every active
      // chat run's unanswered turn so the incoming color re-fires it (and emit
      // the chat_run_interrupted telemetry, flushed in-line). Bounded at 8s:
      // docker's stop grace is 30s and the forced exit above fires at 25s.
      // SUBSUMES main's requeueInflightHumanTurnsForShutdown() call site: that
      // 5s path re-queued only HUMAN turns to pending_chat_messages; this ritual
      // covers every active chat run's unanswered turn with the transcript row,
      // telemetry, and a DB Rule-C backstop — running both would double-requeue
      // and double-answer a turn (the exported helper itself is kept, unused here).
      // Coding runs need nothing here (Phase-2 worker tier — worker.ts drains
      // its own SIGTERM with checkpoints retained). Closing HTTP ends any SSE
      // tailers, whose EventSource clients auto-reconnect to the new color and
      // keep tailing from Postgres.
      // (2026-09-18) The same bounded window also closes any in-flight LATE
      // cross-check reconcile honestly (pendingCrossCheck → false, outcome
      // 'interrupted') so no client polls a revision this process can no longer write.
      const ritual = Promise.race([
        Promise.all([
          import('./modules/crossmodel/chat-agent/shutdown-interrupt').then((m) => m.interruptActiveChatRunsForShutdown('deploy')),
          import('./modules/crossmodel/chat-agent/late-crosscheck').then((m) => m.abandonPendingLateCrossChecks('deploy')),
        ]).then(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
      ]).catch((err) => logger.warn('deploy-interrupt ritual failed (continuing shutdown):', err));
      void ritual.finally(() => {
        httpServer.close(async () => {
          // Receipt-write flush (todo 1e356736 item 2, 2026-10-16): the web
          // process owns the chat runs (supervisor wakes included), and every
          // receipted tool call persists its row fire-and-forget through
          // recordRunReceiptAsync. Before this await, $disconnect raced those
          // in-flight INSERTs — the 08:09–08:32Z #1568 deploy window left two
          // update_supervisor_state saves durable in supervisor_states with NO
          // receipt rows (the audit's drain-loss specimens). Bounded 10 s
          // (docker's stop grace is 30 s; the forced exit above fires at 25 s),
          // inside the same registry the worker's shutdown already awaits.
          try {
            const { awaitBackgroundTasks, pendingBackgroundCount } = await import('./utils/background-tasks');
            const pendingAtClose = pendingBackgroundCount();
            const flushed = await awaitBackgroundTasks(10_000);
            if (flushed.timedOut || flushed.remaining > 0) {
              logger.warn(`shutdown: ${flushed.remaining} background task(s) still in flight after 10s (${flushed.remainingLabels.join(', ')}) — disconnecting anyway`);
            } else if (pendingAtClose > 0) {
              logger.info(`shutdown: flushed ${pendingAtClose} background task(s) (receipts/hooks) before Prisma disconnect`);
            }
          } catch (err: any) {
            logger.warn(`shutdown: background-task flush failed (continuing): ${err?.message ?? err}`);
          }
          logger.info('HTTP server closed, disconnecting Prisma');
          await prisma.$disconnect();
          process.exit(0);
        });
      });
    };

    process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
    process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });
  } catch (error) {
    logger.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', {
    message: error.message,
    stack: error.stack,
    source: 'uncaughtException',
  });
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason: any, _promise) => {
  logger.error('Unhandled Rejection:', {
    message: reason?.message || String(reason),
    stack: reason?.stack,
    source: 'unhandledRejection',
  });
  // Don't exit in development - just log the error
  if (env.NODE_ENV === 'production') {
    process.exit(1);
  }
});

startServer();
