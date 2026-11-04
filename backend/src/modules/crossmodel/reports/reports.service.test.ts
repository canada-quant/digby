/**
 * Content-reports tests (M2-prep — App Store 1.2/1.4).
 *
 * SERVICE: ownership check (only your own chat), note cap, create shape,
 * queue listing, review flow. HTTP posture (guard + admin gate) is pinned in
 * route-posture.test.ts (the reports router mounts behind the single guard).
 *
 * Hermetic: prisma + logger mocked (push.service.test pattern).
 */

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    crossModelChat: {
      findFirst: jest.fn(),
    },
    contentReport: {
      create: jest.fn().mockResolvedValue({ id: 'r1' }),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
  },
}));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
// error-handler pulls config/env → process.exit without env vars (CI is env-less).
jest.mock('../../../config/env', () => ({
  __esModule: true,
  env: {},
}));

import {
  createContentReport,
  listContentReports,
  resolveContentReport,
  REPORT_REASONS,
} from './reports.service';
import prisma from '../../../config/database';
import { AppError } from '../../../middleware/error-handler';

const mockedPrisma = prisma as unknown as {
  crossModelChat: { findFirst: jest.Mock };
  contentReport: {
    create: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
  };
};

describe('reports.service (M2-prep 1.2/1.4)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('files a report for a chat the reporter owns (ownership checked first)', async () => {
    mockedPrisma.crossModelChat.findFirst.mockResolvedValue({ id: 'c1' });

    const result = await createContentReport({
      userId: 'u1',
      chatId: 'c1',
      messageId: 'm1',
      reason: 'spam',
      surface: 'mobile',
      appVersion: '1.0.0',
    });

    expect(result).toEqual({ id: 'r1' });
    expect(mockedPrisma.crossModelChat.findFirst).toHaveBeenCalledWith({
      where: { id: 'c1', userId: 'u1' },
      select: { id: true },
    });
    expect(mockedPrisma.contentReport.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          reporterId: 'u1',
          chatId: 'c1',
          messageId: 'm1',
          reason: 'spam',
          surface: 'mobile',
          appVersion: '1.0.0',
        }),
      })
    );
  });

  it('404s a report against a chat the reporter does NOT own (not a probe tool)', async () => {
    mockedPrisma.crossModelChat.findFirst.mockResolvedValue(null);

    await expect(
      createContentReport({
        userId: 'u1',
        chatId: 'someone-elses',
        messageId: 'm1',
        reason: 'spam',
      })
    ).rejects.toMatchObject({ statusCode: 404, message: 'Chat not found' });
    expect(mockedPrisma.contentReport.create).not.toHaveBeenCalled();
  });

  it('rejects a note over 2000 chars (400, never a 500)', async () => {
    mockedPrisma.crossModelChat.findFirst.mockResolvedValue({ id: 'c1' });

    await expect(
      createContentReport({
        userId: 'u1',
        chatId: 'c1',
        messageId: 'm1',
        reason: 'other',
        note: 'x'.repeat(2001),
      })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(mockedPrisma.contentReport.create).not.toHaveBeenCalled();
  });

  it('exposes the store-moderation reason vocabulary (guideline 1.2 story)', () => {
    // The mobile UI renders these; the route zod enum enforces them.
    expect(REPORT_REASONS).toContain('spam');
    expect(REPORT_REASONS).toContain('hate_speech');
    expect(REPORT_REASONS).toContain('other');
  });

  it('lists the moderation queue with a bounded limit', async () => {
    await listContentReports({ status: 'open', limit: 500 });
    expect(mockedPrisma.contentReport.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200 })
    );
  });

  it('resolves a report (mark reviewed)', async () => {
    mockedPrisma.contentReport.findUnique.mockResolvedValue({ id: 'r1' });

    const result = await resolveContentReport('r1', 'removed content');

    expect(result).toEqual({ resolved: true });
    expect(mockedPrisma.contentReport.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'r1' },
        data: expect.objectContaining({ status: 'reviewed', reviewAction: 'removed content' }),
      })
    );
  });

  it('404s a review of an unknown report', async () => {
    mockedPrisma.contentReport.findUnique.mockResolvedValue(null);
    await expect(resolveContentReport('gone', 'x')).rejects.toMatchObject({ statusCode: 404 });
  });
});
