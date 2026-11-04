/**
 * routeSend / classifySteerFailure decision-table pins (ticket 55e9967d).
 *
 * The incident: a coding session wedged with a stale local `live.running`
 * (SSE 'complete' missed across a deploy flip). Every Enter went steer →
 * backend 409 ("no active run") → fallback send() → re-checked the same
 * stale flag → SILENT no-op. The composer could never deliver and the user
 * got zero feedback. The bypass route is the fix; the non-bypass pins keep
 * the original guards intact (a genuinely live run must still own the
 * composer, and the "smash enter" steer-reroute recovery must still fire).
 */

import { describe, it, expect } from 'vitest';
import { routeSend, classifySteerFailure } from './composer-guard';

const base = { hasSession: true, hasContent: true, liveRunning: false, sessionStatus: 'ready' };

describe('routeSend (55e9967d)', () => {
  it('skip: no session', () => {
    expect(routeSend({ ...base, hasSession: false })).toBe('skip');
  });

  it('skip: no content', () => {
    expect(routeSend({ ...base, hasContent: false })).toBe('skip');
  });

  it('skip: a genuinely live run owns the composer (Enter routes to steer)', () => {
    expect(routeSend({ ...base, liveRunning: true })).toBe('skip');
  });

  it('proceed: ready session, not running', () => {
    expect(routeSend(base)).toBe('proceed');
  });

  it('steer-reroute: session row says running, no live stream, NO bypass (owner "smash enter" recovery preserved)', () => {
    expect(routeSend({ ...base, sessionStatus: 'running' })).toBe('steer-reroute');
  });

  it('PROCEED: THE FIX — bypass after a server 409 cuts through BOTH stale flags (no steer → 409 → send → skip loop)', () => {
    expect(routeSend({ liveRunning: true, hasSession: true, hasContent: true, sessionStatus: 'running', bypassRunningGuard: true })).toBe('proceed');
  });

  it('bypass does not rescue a sessionless or contentless send', () => {
    expect(routeSend({ ...base, hasSession: false, bypassRunningGuard: true })).toBe('skip');
    expect(routeSend({ ...base, hasContent: false, bypassRunningGuard: true })).toBe('skip');
  });

  it('queue-until-ready: a provisioning session KEEPS the message (owner 2026-10-14 — no "still provisioning" toast)', () => {
    expect(routeSend({ ...base, sessionStatus: 'provisioning' })).toBe('queue-until-ready');
    expect(routeSend({ ...base, sessionStatus: 'provisioning', bypassRunningGuard: true })).toBe('queue-until-ready');
    // A genuinely live run still owns the composer.
    expect(routeSend({ ...base, sessionStatus: 'provisioning', liveRunning: true })).toBe('skip');
  });

  it('blocked-toast: error / unknown statuses still explain-and-stop, even with bypass', () => {
    expect(routeSend({ ...base, sessionStatus: 'error' })).toBe('blocked-toast');
    expect(routeSend({ ...base, sessionStatus: undefined })).toBe('blocked-toast');
    expect(routeSend({ ...base, sessionStatus: 'error', bypassRunningGuard: true })).toBe('blocked-toast');
  });
});

describe('classifySteerFailure (55e9967d)', () => {
  it('409 = server-authoritative "no active run" → reconcile + fallback send', () => {
    expect(classifySteerFailure(409)).toBe('fallback-send');
  });

  it('everything else → generic toast (400 validation, 404 gone, 500, network-undefined)', () => {
    expect(classifySteerFailure(400)).toBe('toast');
    expect(classifySteerFailure(404)).toBe('toast');
    expect(classifySteerFailure(500)).toBe('toast');
    expect(classifySteerFailure(undefined)).toBe('toast');
  });
});
