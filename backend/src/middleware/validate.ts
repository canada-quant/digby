import { Request, Response, NextFunction } from 'express';
import { ZodError, type ZodType } from 'zod';

// zod v4 dropped AnyZodObject. Every route schema here is a
// z.object({ body?, query?, params? }) whose parsed OUTPUT carries those
// pieces; ZodType is covariant in Output, so all of them assign to this.
export const validate = (schema: ZodType<{ body?: unknown; query?: unknown; params?: unknown }>) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      });
      // Write transformed/coerced values back to the request so controllers
      // receive the correct types (e.g. query strings transformed to numbers).
      if (parsed.body !== undefined) req.body = parsed.body;
      if (parsed.query !== undefined) {
        // Express 5: req.query is a prototype getter that re-parses on every
        // access — Object.assign(req.query, …) writes into a throwaway object
        // and the transform is silently lost (Express 4's req.query was a
        // plain object). Shadow the getter with an instance data property
        // holding the raw query merged with the transformed values.
        const merged = { ...(req.query as Record<string, unknown>), ...(parsed.query as Record<string, unknown>) };
        Object.defineProperty(req, 'query', {
          value: merged,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
      if (parsed.params !== undefined) Object.assign(req.params, parsed.params);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        next(error);
      } else {
        next(error);
      }
    }
  };
};
