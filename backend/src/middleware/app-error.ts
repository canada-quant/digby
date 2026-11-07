/**
 * The application error TYPE, in its own leaf module (2026-11-06).
 *
 * WHY THIS EXISTS: AppError used to live in middleware/error-handler.ts, which
 * also imports config/env (for the client-IP hops and log-level helpers). env.ts
 * runs its zod parse at MODULE LOAD and calls process.exit(1) when the variables
 * are absent — which is the normal condition in a hermetic jest run. So any
 * module that merely wanted the ERROR TYPE and imported it from error-handler
 * dragged the whole env chain in and killed the worker with
 * "process.exit called with 1 / Jest worker encountered 4 child process
 * exceptions". Ten controller suites died that way when the org-quota guard was
 * first imported from a new place (ea95fa0b leg 1).
 *
 * The fix is a one-way split: the type lives here with NO imports, and
 * error-handler re-exports it so every existing
 * `import { AppError } from '.../middleware/error-handler'` keeps working — the
 * class IDENTITY is unchanged, so `instanceof` checks across the codebase are
 * unaffected. New leaf modules should import from here.
 */
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public message: string,
    public isOperational = true
  ) {
    super(message);
    Object.setPrototypeOf(this, AppError.prototype);
  }
}