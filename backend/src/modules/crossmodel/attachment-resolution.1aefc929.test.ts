/**
 * attachment-resolution policy (ticket 1aefc929 — "attached images never
 * arrive… no error is surfaced"): NEVER silently deliver text-only when the
 * caller staged attachments.
 *
 * REPLAY (2026-09-13 18:31:26Z, app_error_logs): the Fleet Supervisor forwarded
 * the owner's 4 screenshot uploadIds ~4.5 min after they last resolved — the
 * Redis blobs had crossed the 15-min TTL and ALL resolved null; the send
 * proceeded text-only (the platform-tools path reported the drop in its tool
 * result, but the /stream and fleet surfaces then still delivered the message
 * with no attachments and no user-facing error). This file pins the new
 * contract: total loss → fatalMessage (callers hard-error); partial loss →
 * survivors + honest annotation.
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { resolveStagedUploads, attachmentDropAnnotation } from './attachment-resolution';
import logger from '../../utils/logger';

const IMG = { type: 'image', filename: 'shot.png', mimeType: 'image/png', base64: 'QUJD' } as const;

describe('resolveStagedUploads (ticket 1aefc929)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('replay: ALL 4 staged blobs expired (the 18:31Z forward scenario) → fatal, no survivors, 4 dropped, 4 warns', async () => {
    const r = await resolveStagedUploads(
      ['2201e778-0a88', '9a9fc557-0766', '587ab65d-646b', 'cff3800c-951a'],
      async () => null,
    );
    expect(r.loaded).toEqual([]);
    expect(r.droppedCount).toBe(4);
    expect(r.fatalMessage).toContain('All 4 attachments expired');
    expect(r.fatalMessage).toMatch(/nothing was sent/i);
    expect(logger.warn).toHaveBeenCalledTimes(4);
  });

  it('a single expired upload gets the singular fatal message', async () => {
    const r = await resolveStagedUploads(['u1'], async () => null);
    expect(r.fatalMessage).toContain('Your attachment expired');
    expect(r.fatalMessage).toMatch(/nothing was sent/i);
    expect(r.droppedCount).toBe(1);
  });

  it('partial loss: survivors load in input order, NO fatal, dropped counted, one warn per lost id', async () => {
    const r = await resolveStagedUploads(['u1', 'u2', 'u3'], async (id) => (id === 'u2' ? null : { ...IMG }));
    expect(r.fatalMessage).toBeUndefined();
    expect(r.loaded.map((l) => l.id)).toEqual(['u1', 'u3']);
    expect(r.droppedCount).toBe(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('all resolve: no fatal, zero dropped, no warns', async () => {
    const r = await resolveStagedUploads(['u1', 'u2'], async () => ({ ...IMG }));
    expect(r.fatalMessage).toBeUndefined();
    expect(r.droppedCount).toBe(0);
    expect(r.loaded).toHaveLength(2);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('no staged ids: empty result, loader never called', async () => {
    const load = jest.fn(async () => null);
    const r = await resolveStagedUploads([], load);
    expect(r).toEqual({ loaded: [], droppedCount: 0 });
    expect(load).not.toHaveBeenCalled();
  });
});

describe('attachmentDropAnnotation (partial-drop honesty)', () => {
  it('singular phrasing', () => {
    expect(attachmentDropAnnotation(1)).toContain('1 attachment(s) expired');
    expect(attachmentDropAnnotation(1)).toContain('re-send it');
  });
  it('plural phrasing', () => {
    expect(attachmentDropAnnotation(3)).toContain('3 attachment(s) expired');
    expect(attachmentDropAnnotation(3)).toContain('re-send them');
  });
});
