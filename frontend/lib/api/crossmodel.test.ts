/**
 * crossmodel API client — archive/restore fetchers (owner 2026-09-08:
 * "archive projects and bring them back. same with chats"). Pins the exact
 * endpoints + params so the client can't drift from the backend surface:
 *   - POST /chats/:id/archive | /restore, POST /projects/:id/archive | /restore
 *   - the archived-list fetchers pass archived: true (string-compared
 *     server-side — Express query params arrive as strings)
 *   - default listChats sends NO archived param (server default = exclude).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the axios client BEFORE importing crossmodel.ts (coding.test.ts idiom).
vi.mock('../api-client', () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), patch: vi.fn() } }));

import apiClient from '../api-client';
import { crossModelApi, projectsApi } from './crossmodel';

const mockGet = apiClient.get as unknown as ReturnType<typeof vi.fn>;
const mockPost = apiClient.post as unknown as ReturnType<typeof vi.fn>;
const mockPut = apiClient.put as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  mockPut.mockReset();
});

describe('crossModelApi archive/restore', () => {
  it('archiveChat POSTs /crossmodel/chats/:id/archive and unwraps data.data', async () => {
    mockPost.mockResolvedValue({ data: { success: true, data: { id: 'c1', archived: true } } });
    await expect(crossModelApi.archiveChat('c1')).resolves.toEqual({ id: 'c1', archived: true });
    expect(mockPost).toHaveBeenCalledWith('/crossmodel/chats/c1/archive');
  });

  it('restoreChat POSTs /crossmodel/chats/:id/restore', async () => {
    mockPost.mockResolvedValue({ data: { success: true, data: { id: 'c1', archived: false } } });
    await expect(crossModelApi.restoreChat('c1')).resolves.toEqual({ id: 'c1', archived: false });
    expect(mockPost).toHaveBeenCalledWith('/crossmodel/chats/c1/restore');
  });

  it('listArchivedChats requests the Archived view (archived: true) with paging', async () => {
    mockGet.mockResolvedValue({ data: { success: true, data: { chats: [], pagination: { page: 1 } } } });
    await crossModelApi.listArchivedChats({ page: 1, limit: 50 });
    expect(mockGet).toHaveBeenCalledWith('/crossmodel/chats', { params: { page: 1, limit: 50, archived: true } });
  });

  it('default listChats sends NO archived param (the server default excludes archived rows)', async () => {
    mockGet.mockResolvedValue({ data: { success: true, data: { chats: [], pagination: {} } } });
    await crossModelApi.listChats({ page: 1, limit: 30 });
    expect(mockGet).toHaveBeenCalledWith('/crossmodel/chats', { params: { page: 1, limit: 30 } });
  });
});

describe('projectsApi archive/restore', () => {
  it('archive POSTs /crossmodel/projects/:id/archive and unwraps data.data', async () => {
    mockPost.mockResolvedValue({ data: { success: true, data: { id: 'p1', archived: true } } });
    await expect(projectsApi.archive('p1')).resolves.toEqual({ id: 'p1', archived: true });
    expect(mockPost).toHaveBeenCalledWith('/crossmodel/projects/p1/archive');
  });

  it('restore POSTs /crossmodel/projects/:id/restore', async () => {
    mockPost.mockResolvedValue({ data: { success: true, data: { id: 'p1', archived: false } } });
    await expect(projectsApi.restore('p1')).resolves.toEqual({ id: 'p1', archived: false });
    expect(mockPost).toHaveBeenCalledWith('/crossmodel/projects/p1/restore');
  });

  it('listArchived requests the Archived folder view (archived: true), bare-body unwrap', async () => {
    mockGet.mockResolvedValue({ data: { owned: [], shared: [] } });
    await expect(projectsApi.listArchived()).resolves.toEqual({ owned: [], shared: [] });
    expect(mockGet).toHaveBeenCalledWith('/crossmodel/projects', { params: { archived: true } });
  });
});

describe('projectsApi.update autoArchiveIdleDays (ticket bb86cee8)', () => {
  it('PUTs the idle-days window verbatim to /crossmodel/projects/:id', async () => {
    mockPut.mockResolvedValue({ data: { id: 'p1', autoArchiveIdleDays: 30 } });
    await projectsApi.update('p1', { autoArchiveIdleDays: 30 });
    expect(mockPut).toHaveBeenCalledWith('/crossmodel/projects/p1', { autoArchiveIdleDays: 30 });
  });

  it('PUTs null verbatim to switch the feature off (never stripped/omitted)', async () => {
    mockPut.mockResolvedValue({ data: { id: 'p1', autoArchiveIdleDays: null } });
    await projectsApi.update('p1', { autoArchiveIdleDays: null });
    expect(mockPut).toHaveBeenCalledWith('/crossmodel/projects/p1', { autoArchiveIdleDays: null });
  });
});
