/**
 * @digby/api — typed Digby API client.
 *
 * Pure TypeScript (no React, no platform APIs). Extracted from the web client
 * so the mobile apps share it (roadmap §3.2 item 5). Instantiate with a
 * baseUrl + injectable fetch; hosts own token persistence (web: localStorage +
 * httpOnly cookie; mobile: expo-secure-store, sending the refresh token in
 * the refresh body since it can't read the httpOnly cookie).
 */

export {
  DigbyApiClient,
  ApiError,
  NO_REFRESH_DEFAULT,
} from './client';
export type {
  FetchLike,
  ApiEnvelope,
  DigbyApiOptions,
} from './client';
export { fetchAuth, fetchChats, fetchCrossModelChats } from './endpoints';
export { fetchPush } from './push';
export type { RegisterPushArgs, PushTransports } from './push';
export { fetchReports, REPORT_REASONS } from './reports';
export type { ReportContentArgs, ReportReason } from './reports';
export * from './types';
export {
  SseParser,
  openStream,
  sendMessageStream,
  attachChatStream,
  uploadImage,
} from './streaming';
export type {
  SseEvent,
  SseChunkEvent,
  SseProgressEvent,
  SseModelResponseEvent,
  SseChatTitleEvent,
  SseCompleteEvent,
  SseErrorEvent,
  SseInitEvent,
  SseReplayEndEvent,
  SseThinkingSummaryEvent,
  SseAgentActivityEvent,
  ParsedFrame,
  StreamHandlers,
  StreamHandle,
  SendMessageParams,
  SendMessageResult,
  StreamReader,
} from './streaming';
