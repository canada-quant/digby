/**
 * Content reports (M2-prep — App Store 1.2/1.4, Play UGC policy).
 *
 * The mobile chat screen's "report content" action files a moderation report
 * against a specific message. These ride the client's normal Bearer + refresh
 * loop — no separate auth surface. Reasons mirror the backend zod enum
 * (reports.routes.ts); keep in sync.
 */

import { DigbyApiClient, ApiEnvelope } from './client';

/** Moderation reason vocabulary (backend REPORT_REASONS — keep in sync). */
export const REPORT_REASONS = [
  'hate_speech',
  'harassment',
  'sexual_content',
  'violence',
  'self_harm',
  'dangerous_acts',
  'misinformation',
  'illegal',
  'spam',
  'other',
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export interface ReportContentArgs {
  /** The chat the reported message lives in. */
  chatId: string;
  /** The reported message. */
  messageId: string;
  reason: ReportReason;
  /** Optional free-text context from the reporter (≤2000). */
  note?: string;
  /** Where the report was filed from (defaults to 'mobile' in the UI). */
  surface?: 'mobile' | 'web';
  /** Client version for triage. */
  appVersion?: string;
}

export function fetchReports(client: DigbyApiClient) {
  return {
    /** POST /api/crossmodel/reports — file a content report. */
    async report(args: ReportContentArgs): Promise<{ reportId: string }> {
      const res = await client.request<ApiEnvelope<{ reportId: string }>>(
        '/api/crossmodel/reports',
        { method: 'POST', body: args }
      );
      return res.data;
    },
  };
}
