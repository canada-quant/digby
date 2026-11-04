/**
 * fleet.validation query-schema tests. Pure zod — no mocks needed.
 * Pins the includeMachine text-coercion contract (PR #291 adversarial review:
 * z.coerce.boolean() maps the STRING 'false' → true, so the opt-in's negative
 * form must be parsed explicitly).
 */
import { ZodError } from 'zod';
import { fleetSendMessageSchema, fleetThreadQuerySchema, FLEET_MESSAGE_MAX_CHARS } from './fleet.validation';

describe('fleetThreadQuerySchema includeMachine coercion', () => {
  const parse = (q: Record<string, unknown>) => fleetThreadQuerySchema.parse({ query: q }).query;

  it("'true' → true (the pane's opt-in)", () => {
    expect(parse({ includeMachine: 'true' }).includeMachine).toBe(true);
  });

  it("'false' → false (the negative form z.coerce.boolean() inverts)", () => {
    expect(parse({ includeMachine: 'false' }).includeMachine).toBe(false);
  });

  it('absent → undefined (default stays filtered); page-query defaults intact', () => {
    const q = parse({});
    expect(q.includeMachine).toBeUndefined();
    expect(q.limit).toBe(50); // fleetPageQuery default
  });

  it('rejects a non-literal value', () => {
    expect(() => parse({ includeMachine: 'yes' })).toThrow();
  });
});

describe('fleetSendMessageSchema content limit (ticket eb7a3919 — opaque "Validation error")', () => {
  const parse = (content: string) => fleetSendMessageSchema.parse({ body: { content } });

  it('accepts content exactly at the limit', () => {
    expect(parse('x'.repeat(FLEET_MESSAGE_MAX_CHARS)).body.content).toHaveLength(FLEET_MESSAGE_MAX_CHARS);
    // 2026-09-12 (ticket df145eb3): human-typed messages cap at 100,000
    // (machine-origin limits — schedule_self 8000, webhook 20_000 — unchanged).
    expect(FLEET_MESSAGE_MAX_CHARS).toBe(100_000);
  });

  it('an over-limit message fails with a HUMAN message naming the 100,000-char limit', () => {
    try {
      parse('x'.repeat(FLEET_MESSAGE_MAX_CHARS + 1));
      throw new Error('expected a ZodError');
    } catch (err) {
      expect(err).toBeInstanceOf(ZodError);
      // The error handler ships issues as { error: 'Validation error',
      // details } and the client toasts details[0].message — so THIS text is
      // what the user reads. It must name the limit, not just "too big".
      const message = (err as ZodError).issues[0].message;
      expect(message).toContain('100,000');
      expect(message).toContain('too long');
    }
  });

  it('empty content still fails with its own message', () => {
    try {
      parse('');
      throw new Error('expected a ZodError');
    } catch (err) {
      expect((err as ZodError).issues[0].message).toBe('content is required');
    }
  });
});
