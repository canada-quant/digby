/**
 * Todo 87b020c4 (owner ruling oq_7af5537b, 2026-10-25): the per-model imagesUrl
 * knob — the seat-side tailnet-direct flip for the long-running image class —
 * must survive the HTTP validation layer. The 04c8ffd1 lesson (see the sibling
 * suite): zod's z.object STRIPS unknown keys and middleware/validate.ts writes
 * the parsed body back (req.body = parsed.body), so a POST/PATCH carrying a
 * member the schema lacks silently loses it before createEndpoint/updateEndpoint
 * ever runs. This suite pins the VALIDATION layer (the service-level tests
 * bypass validate() entirely — they cannot catch this class).
 */
import { createModelEndpointSchema, updateModelEndpointSchema } from './model-endpoints.validation';

describe('87b020c4 — imagesUrl survives the zod validation layer (POST/PATCH)', () => {
  it('CREATE: the field passes through createModelEndpointSchema', () => {
    const parsed = createModelEndpointSchema.safeParse({
      body: {
        label: 'llm-cql',
        providerShape: 'openai_chat',
        baseUrl: 'https://llm.cql.ca',
        models: [{ id: 'qwen-image-2.1-turbo', image: true, imageTimeoutMs: 720_000, imagesUrl: 'http://100.64.0.1:4001/v1' }],
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
    expect(parsed.data.body.models[0]).toMatchObject({
      id: 'qwen-image-2.1-turbo', image: true, imageTimeoutMs: 720_000, imagesUrl: 'http://100.64.0.1:4001/v1',
    });
  });

  it('UPDATE: the field passes through updateModelEndpointSchema; absent stays absent (present-only — clearing = an update without the key)', () => {
    const parsed = updateModelEndpointSchema.safeParse({
      body: {
        models: [
          { id: 'qwen-image-2.1-turbo', image: true, imagesUrl: 'http://100.64.0.1:4001/v1' },
          { id: 'qwen-image-2.1', image: true }, // absent stays absent
        ],
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
    expect(parsed.data.body.models![0]).toMatchObject({ id: 'qwen-image-2.1-turbo', imagesUrl: 'http://100.64.0.1:4001/v1' });
    expect(parsed.data.body.models![1]).not.toHaveProperty('imagesUrl');
  });
});
