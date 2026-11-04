/**
 * Ticket 04c8ffd1 (review blocker, revised verdict 01:32Z): the per-model
 * imageTimeoutMs knob was unshippable through the HTTP surface — zod's
 * z.object STRIPS unknown keys and middleware/validate.ts writes the parsed
 * body back (req.body = parsed.body), so a POST/PATCH carrying imageTimeoutMs
 * silently lost the field before createEndpoint/updateEndpoint ever ran. The
 * admin UI saved, reload showed no timeout; only the env fallback worked.
 *
 * This suite pins the VALIDATION layer (the service-level tests bypass
 * validate() entirely — they cannot catch this class). It replays the
 * reviewer's exact reproduction: parse create/update bodies carrying the field
 * and assert it SURVIVES the parse.
 */
import { createModelEndpointSchema, updateModelEndpointSchema } from './model-endpoints.validation';

describe('04c8ffd1 — imageTimeoutMs survives the zod validation layer (POST/PATCH)', () => {
  it('CREATE: the field passes through createModelEndpointSchema (pre-fix: stripped)', () => {
    const parsed = createModelEndpointSchema.safeParse({
      body: {
        label: 'my-comfy',
        providerShape: 'openai_chat',
        baseUrl: 'http://10.0.0.5:8188/v1',
        models: [{ id: 'sdxl', image: true, imageTimeoutMs: 480_000 }],
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
    expect(parsed.data.body.models[0]).toMatchObject({ id: 'sdxl', image: true, imageTimeoutMs: 480_000 });
  });

  it('UPDATE: the field passes through updateModelEndpointSchema (pre-fix: stripped)', () => {
    const parsed = updateModelEndpointSchema.safeParse({
      body: {
        models: [
          { id: 'qwen-image-2.1', image: true, imageTimeoutMs: 600_000 },
          { id: 'chat-model' }, // absent stays absent (present-only semantics)
        ],
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
    expect(parsed.data.body.models![0]).toMatchObject({ id: 'qwen-image-2.1', imageTimeoutMs: 600_000 });
    expect(parsed.data.body.models![1]).not.toHaveProperty('imageTimeoutMs');
  });

  it('the member is SHAPE-only: a sub-floor value parses (the SERVICE clamps [30 s, 720 s] — a zod min would 400 it instead, breaking the tested clamp-raise behavior)', () => {
    const parsed = createModelEndpointSchema.safeParse({
      body: {
        label: 'my-comfy',
        providerShape: 'openai_chat',
        baseUrl: 'http://10.0.0.5:8188/v1',
        models: [{ id: 'sdxl', image: true, imageTimeoutMs: 1_000 }], // service raises to the 30 s floor
      },
    });
    expect(parsed.success).toBe(true);
    // A non-integer / non-positive value is rejected at the SHAPE layer (never
    // reaches the service's garbage-drop branch — the two layers are additive).
    const bad = createModelEndpointSchema.safeParse({
      body: {
        label: 'my-comfy',
        providerShape: 'openai_chat',
        baseUrl: 'http://10.0.0.5:8188/v1',
        models: [{ id: 'sdxl', image: true, imageTimeoutMs: 'abc' as any }],
      },
    });
    expect(bad.success).toBe(false);
  });
});
