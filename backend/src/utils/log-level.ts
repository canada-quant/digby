/**
 * Three-way log convention (2026-10-18).
 *
 * Winston's Prisma transport persists warn+error into app_error_logs, and the
 * framework sweeps fingerprint those rows into tickets. There was no policy
 * separating "the detector worked" from "something is broken", so handled
 * outcomes and external blips became tickets.
 *
 *   logHandled  — expected/handled. info. Never persisted (transport is warn+).
 *   logExternal — a dependency we don't control is degraded. warn, tagged
 *                 logClass:'external' so a sweep can ignore it.
 *   logger.error — a genuine internal fault. Untagged, or logClass:'fault'.
 *
 * Do not use these to hide a real failure. A guard that refused a dangerous
 * command is handled (the refusal is the product); the guard staying
 * fail-closed is not optional.
 */
import logger from './logger';

export type LogMeta = Record<string, unknown>;

/**
 * Expected, already-handled outcome. info — the warn+ transport never stores it.
 *
 * Splat note (family 5ae52ca3 review): info rows are never persisted, so the
 * two-arg form is safe here — but see logExternal for why warn-level taxonomy
 * calls MUST use the object form.
 */
export function logHandled(message: string, meta?: LogMeta): void {
  logger.info(message, { ...(meta ?? {}), logClass: 'handled' });
}

/**
 * An external dependency is degraded. warn, tagged logClass:'external' so a
 * sweep can tell it from an internal fault without dropping real errors.
 *
 * SPLAT SAFETY (log-signal family 5ae52ca3, adversarial review F1): this MUST
 * stay the OBJECT form. `logger.warn(message, meta)` passes meta as a winston
 * splat argument — when the message carries a printf token (`%s`, `%d`, `%j`,
 * or a literal `%` from provider error text or SQL), winston.format.splat()
 * formats the META OBJECT INTO THE MESSAGE and the logClass tag (and every
 * other meta key) is destroyed exactly on the most interesting rows: a
 * DashScope body or a pgvector error quoting `LIKE '%foo%'` would un-tag
 * itself and the sweep would keep filing the adjudicated class. The object
 * form carries no splat args, so the message persists verbatim and the tag
 * survives. Pinned by utils/log-level.transport.5ae52ca3.test.ts.
 */
export function logExternal(message: string, meta?: LogMeta): void {
  logger.log({
    level: 'warn',
    message,
    ...(meta ?? {}),
    logClass: 'external',
  });
}
