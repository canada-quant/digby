/**
 * codingApi.streamUrl tests (0c158104, link 1): the attach URL is where the
 * resume cursor leaves the client — the server replays only events PAST
 * after_seq instead of the whole run log. The default (no cursor) must stay
 * byte-compatible with older servers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the axios client BEFORE importing coding.ts — steerRun's timeout
// config is asserted against the mock's call args.
vi.mock('../api-client', () => ({ default: { post: vi.fn() } }));

import apiClient from '../api-client';
import { codingApi, STEER_TIMEOUT_MS } from './coding';

const mockPost = apiClient.post as unknown as ReturnType<typeof vi.fn>;

describe('codingApi.streamUrl (0c158104)', () => {
  it('builds the unified chat-stream URL with message + token and NO after_seq by default', () => {
    const url = codingApi.streamUrl('s1', 'hello world');
    const u = new URL(url, 'https://test.local');
    expect(u.pathname).toBe('/api/crossmodel/chats/s1/stream');
    expect(u.searchParams.get('message')).toBe('hello world');
    expect(u.searchParams.has('after_seq')).toBe(false);
    expect(u.searchParams.has('token')).toBe(true); // empty string in a node env
  });

  it('appends the composite <runId>:<seq> resume cursor as after_seq', () => {
    const url = codingApi.streamUrl('s1', '', 'r1:40');
    const u = new URL(url, 'https://test.local');
    expect(u.searchParams.get('after_seq')).toBe('r1:40');
    expect(u.searchParams.get('message')).toBe('');
  });
});

describe('codingApi.steerRun (55e9967d)', () => {
  beforeEach(() => mockPost.mockReset());

  it('carries a FINITE timeout — a hung POST must never wedge the composer steering state again', async () => {
    mockPost.mockResolvedValue({});
    await codingApi.steerRun('s1', 'turn left');
    expect(mockPost).toHaveBeenCalledWith(
      '/crossmodel/coding/sessions/s1/steer',
      { message: 'turn left' },
      { timeout: STEER_TIMEOUT_MS },
    );
  });

  it('images ride the body with the same timeout config', async () => {
    mockPost.mockResolvedValue({});
    const images = [{ mediaType: 'image/png', data: 'QUJD', name: 'x.png' }];
    await codingApi.steerRun('s1', 'look', images);
    expect(mockPost).toHaveBeenCalledWith(
      '/crossmodel/coding/sessions/s1/steer',
      { message: 'look', images },
      { timeout: STEER_TIMEOUT_MS },
    );
  });

  it('the timeout is a sane finite ceiling (not 0 = infinite, not absurd)', () => {
    expect(STEER_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
    expect(STEER_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
  });
});
