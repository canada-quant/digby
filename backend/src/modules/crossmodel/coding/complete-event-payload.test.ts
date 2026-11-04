/**
 * audit 2026-10-06 T8-7 (crosscutting X3): the coding run's `complete` event
 * omits an oversized `parts` (the final row is persisted first; the client
 * reads it over REST). Small runs, unpersisted finals and the kill switch keep
 * today's payload byte-for-byte.
 */
import { buildCompleteEventPayload, completeEventPartsMaxBytes, COMPLETE_EVENT_PARTS_MAX_BYTES_DEFAULT } from './complete-event-payload';

const SMALL = [{ type: 'text', text: 'done' }];
const BIG = [{ type: 'tool_result', name: 'run_command', result: 'x'.repeat(300 * 1024) }, { type: 'text', text: 'done' }];
const base = { finalText: 'done', stopped: false, origin: 'schedule', triggerKind: 'schedule', messageId: 'msg-1', finalPersisted: true };

afterEach(() => {
  delete process.env.COMPLETE_EVENT_PARTS_OMIT_DISABLED;
  delete process.env.COMPLETE_EVENT_PARTS_MAX_BYTES;
});

describe('buildCompleteEventPayload (audit 2026-10-06 T8-7)', () => {
  it('a small run keeps today\'s payload exactly (key order included, no messageId added)', () => {
    const r = buildCompleteEventPayload({ ...base, parts: SMALL });
    expect(r.omitted).toBe(false);
    expect(JSON.stringify(r.payload)).toBe(JSON.stringify({ finalText: 'done', parts: SMALL, stopped: false, origin: 'schedule', triggerKind: 'schedule' }));
    expect(r.partsBytes).toBe(Buffer.byteLength(JSON.stringify(SMALL)));
  });

  it('parts above the threshold are omitted: partsOmitted + partsBytes + messageId, no parts key', () => {
    const r = buildCompleteEventPayload({ ...base, parts: BIG });
    expect(r.omitted).toBe(true);
    expect(r.payload).toEqual({ finalText: 'done', partsOmitted: true, partsBytes: r.partsBytes, messageId: 'msg-1', stopped: false, origin: 'schedule', triggerKind: 'schedule' });
    expect('parts' in r.payload).toBe(false);
    expect(r.partsBytes).toBeGreaterThan(COMPLETE_EVENT_PARTS_MAX_BYTES_DEFAULT);
  });

  it('an unpersisted final always carries its parts (the REST read would serve a stale row)', () => {
    const r = buildCompleteEventPayload({ ...base, parts: BIG, finalPersisted: false });
    expect(r.omitted).toBe(false);
    expect(r.payload.parts).toBe(BIG);
  });

  it('the threshold is env-tunable; junk falls back to 256 KB', () => {
    expect(completeEventPartsMaxBytes()).toBe(256 * 1024);
    process.env.COMPLETE_EVENT_PARTS_MAX_BYTES = '10';
    expect(buildCompleteEventPayload({ ...base, parts: SMALL }).omitted).toBe(true);
    process.env.COMPLETE_EVENT_PARTS_MAX_BYTES = 'nope';
    expect(completeEventPartsMaxBytes()).toBe(256 * 1024);
  });

  it('a missing messageId is simply absent', () => {
    const r = buildCompleteEventPayload({ ...base, parts: BIG, messageId: null });
    expect(r.omitted).toBe(true);
    expect('messageId' in r.payload).toBe(false);
  });

  it('COMPLETE_EVENT_PARTS_OMIT_DISABLED=1 restores today\'s payload byte-for-byte', () => {
    process.env.COMPLETE_EVENT_PARTS_OMIT_DISABLED = '1';
    const r = buildCompleteEventPayload({ ...base, parts: BIG });
    expect(r.omitted).toBe(false);
    expect(r.partsBytes).toBeNull();
    expect(JSON.stringify(r.payload)).toBe(JSON.stringify({ finalText: 'done', parts: BIG, stopped: false, origin: 'schedule', triggerKind: 'schedule' }));
  });
});
