import { z } from 'zod';

/**
 * z.string().uuid() EXACTLY as zod v3 behaved it (zod v4 bump,
 * GHSA-mrhx-c7xc-m3w5): an 8-4-4-4-12 hex SHAPE check, case-insensitive —
 * no RFC 9562 version/variant-bit enforcement.
 *
 * Why this leaf exists: zod v4's `.uuid()` / `z.uuid()` tightened to RFC 9562
 * and now rejects variant-invalid hex (e.g. `44444444-4444-4444-4444-444444444444`,
 * nibble `4` ∉ {8,9,a,b}) that v3 accepted — a silent client-facing
 * tightening of every public route's id gate that a dependency-security bump
 * must not smuggle in (400 "Invalid ID" where callers used to get past
 * validation). Every production id is a Prisma `@default(uuid())` v4 or a
 * client `crypto.randomUUID()`/NSUUID (RFC-valid either way, and the check
 * stays case-insensitive), so tightening to `z.uuid()` later changes nothing
 * for well-formed callers — it is a deliberate product call for its own PR,
 * made in one place when taken.
 */
export const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The v3 `z.string().uuid(message)` shape check, as a reusable schema. */
export const uuidString = (message = 'Invalid UUID') =>
  z.string().regex(UUID_SHAPE, message);
