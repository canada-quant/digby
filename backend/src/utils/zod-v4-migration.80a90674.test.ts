import { z } from 'zod';
import { changePasswordSchema } from '../modules/auth/auth.validation';
import { listChatsQuerySchema } from '../modules/ai-chat/ai-chat.validation';
import { dateRangeSchema, trackEventSchema } from '../modules/analytics/analytics.validation';
import { updateModelRolesSchema } from '../modules/crossmodel/model-endpoints/model-endpoints.validation';
import { updateChatScheduleSchema } from '../modules/crossmodel/crossmodel.validation';

describe('zod v4 migration behavior probes', () => {
  it('string->Number pipes default to the OUTPUT type (numbers)', () => {
    expect(listChatsQuerySchema.parse({})).toEqual({ page: 1, limit: 10 });
    expect(listChatsQuerySchema.parse({ page: '3' })).toEqual({ page: 3, limit: 10 });
    expect(dateRangeSchema.parse({})).toEqual({ days: 30 });
  });
  it('required_error preserved via error fn (missing vs wrong-type messages)', () => {
    const missing = changePasswordSchema.safeParse({});
    expect(missing.success).toBe(false);
    if (!missing.success) {
      const msgs = missing.error.issues.map(i => i.message);
      expect(msgs).toContain('Current password is required');
      expect(msgs).toContain('New password is required');
    }
    const wrongType = changePasswordSchema.safeParse({ currentPassword: 42, newPassword: 'longenough1' });
    expect(wrongType.success).toBe(false); // wrong type still rejected (default message)
    if (!wrongType.success) {
      expect(wrongType.error.issues[0].message).not.toBe('Current password is required');
    }
    const trimFloor = changePasswordSchema.safeParse({ currentPassword: 'oldpassword1', newPassword: '   ' });
    expect(trimFloor.success).toBe(false);
  });
  it('enabled: missing vs non-boolean messages preserved', () => {
    const m = updateChatScheduleSchema.safeParse({ params: { id: 'b3ea2574-6d5e-4f3a-9c1d-2e5f6a7b8c9d', scheduleId: 'b3ea2574-6d5e-4f3a-9c1d-2e5f6a7b8c9d' }, body: {} });
    expect(m.success).toBe(false);
    if (!m.success) expect(m.error.issues.some(i => i.message === 'enabled is required')).toBe(true);
    const w = updateChatScheduleSchema.safeParse({ params: { id: 'b3ea2574-6d5e-4f3a-9c1d-2e5f6a7b8c9d', scheduleId: 'b3ea2574-6d5e-4f3a-9c1d-2e5f6a7b8c9d' }, body: { enabled: 'yes' } });
    expect(w.success).toBe(false);
    if (!w.success) expect(w.error.issues.some(i => i.message === 'enabled must be a boolean')).toBe(true);
  });
  it('two-arg z.record validates VALUES (v3 semantics preserved), keys unvalidated', () => {
    const longVal = updateModelRolesSchema.safeParse({ body: { roles: { seat: 'x'.repeat(301) } } });
    expect(longVal.success).toBe(false); // value max(300) enforced (was the v3 VALUE schema)
    const longKey = updateModelRolesSchema.safeParse({ body: { roles: { ['k'.repeat(400)]: 'ok' } } });
    expect(longKey.success).toBe(true); // key unvalidated, same as v3
  });
  it('z.record(z.string(), z.any()) properties accepts arbitrary objects (analytics track)', () => {
    expect(trackEventSchema.safeParse({ event: 'e', properties: { any: { nested: [1, 2] } } }).success).toBe(true);
  });
  it('z.email() rejects invalid and transforms', () => {
    const bad = z.email('Invalid email address').safeParse('not-an-email');
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues[0].message).toBe('Invalid email address');
  });
  it('.strict() objects still reject unknown keys in v4', () => {
    const s = z.object({ a: z.string() }).strict();
    expect(s.safeParse({ a: 'x', b: 'y' }).success).toBe(false);
    expect(s.safeParse({ a: 'x' }).success).toBe(true);
  });
});

import { UUID_SHAPE, uuidString } from './zod-uuid';

describe('zod v4 migration: uuid shape (GHSA-mrhx-c7xc-m3w5, todo 80a90674)', () => {
  it('uuidString preserves the v3 SHAPE check (no RFC 9562 variant enforcement)', () => {
    // v4's own .uuid() rejects these (variant nibble ∉ {8,9,a,b}); v3 accepted
    // them, and the API contract this migration must preserve is v3's.
    const variantInvalid = [
      '44444444-4444-4444-4444-444444444444',
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
    ];
    for (const id of variantInvalid) {
      expect(uuidString().safeParse(id).success).toBe(true);
      expect(UUID_SHAPE.test(id)).toBe(true);
    }
  });
  it('uuidString still rejects malformed shapes', () => {
    for (const bad of ['not-a-real-id', '444444444444444444444444444444444444', 'b3ea2574-6d5e-4f3a-9c1d-2e5f6a7b8c9', '', null, 42]) {
      expect(uuidString().safeParse(bad).success).toBe(false);
    }
  });
  it('uuidString accepts RFC-valid uuids in either case (uppercase included)', () => {
    expect(uuidString().safeParse('b3ea2574-6d5e-4f3a-9c1d-2e5f6a7b8c9d').success).toBe(true);
    expect(uuidString().safeParse('B3EA2574-6D5E-4F3A-9C1D-2E5F6A7B8C9D').success).toBe(true);
    expect(uuidString().safeParse('e9c6c6f0-2a11-11d1-b498-00a0c914e8c8').success).toBe(true);
  });
  it('custom message is carried (non-string inputs keep the default message)', () => {
    const r = uuidString('Invalid chat ID').safeParse('nope');
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toBe('Invalid chat ID');
    const n = uuidString('Invalid chat ID').safeParse(42);
    expect(n.success).toBe(false);
    if (!n.success) expect(n.error.issues[0].message).toBe('Invalid input: expected string, received number');
  });
});
