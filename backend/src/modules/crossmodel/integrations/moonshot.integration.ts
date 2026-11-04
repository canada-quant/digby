/**
 * Kimi Integration — via Moonshot direct API
 *
 * Model: kimi-k3 (Kimi K3) — always reasons before outputting content.
 *
 * WHY ALL calls must be STREAMED:
 *   kimi-k3 ALWAYS reasons before outputting content. Non-streaming waits for ALL
 *   reasoning tokens before returning — 100+ seconds in the worst case. In streaming
 *   mode, delta.reasoning_content flows during thinking (we skip it) and delta.content
 *   appears once reasoning completes (we collect it). This applies to BOTH fast and
 *   thinking modes since k2-instruct (non-thinking) is no longer available.
 *
 * Provider: Moonshot direct API (https://api.moonshot.ai/v1/chat/completions)
 *   kimi-k3 is natively multimodal (vision-capable) on the direct API.
 */

import axios from 'axios';
import logger from '../../../utils/logger';
import { ModelResponse, ThinkingEvent } from '../types';
import { ConversationMessage } from '../context.service';
import { Attachment } from '../upload.controller';
import { searchWithBrightData, SEARCH_UNAVAILABLE_NOTE } from '../mcp-search';
import { ToolCache, TOOL_DEFINITIONS, processToolCalls } from '../tool-executor';
import { stripToolCallMarkup, containsToolCallLeak } from '../sanitize-model-output';
import { isWebSearchMeaningful } from './synthesis-prompts';
import { utilityChat, UTILITY_MODEL_NAME, sanitizeStatusLine } from '../../../utils/utility-llm';
// 2026-06-15: Shared follow-up rewriter — single source of truth
// 2026-06-17: Import retryOnModelNotFound to handle daily ~6am UTC provider maintenance window
// where Kimi returns 404 "model not found" for 30-60s. Previously defined but never wired.
import { rewriteFollowUp, retryOnModelNotFound, isLeakedReasoningFollowUp } from '../langgraph/pipeline-utils';
import { stripLeadingMachineHeaders } from '../platform/agent-send-header';
import { stripParentContextDigest } from '../coding/parent-context-block';

// Moonshot direct API — sole provider for Kimi K3 (OpenAI-compatible).
// kimi-k3 always reasons before content — ALL calls must be streamed.
// NOTE: use the international host (api.moonshot.ai); api.moonshot.cn 401s with this key.
const MOONSHOT_API_KEY   = process.env.MOONSHOT_API_KEY;
const MOONSHOT_BASE_URL  = 'https://api.moonshot.ai/v1/chat/completions';
const KIMI_MODEL         = 'kimi-k3';

// Utility model for structured JSON tasks (titles, follow-ups, consolidation, commentary)
// Uses DeepSeek V4 Flash via utility-llm.ts — fast, cheap, stable model IDs.
// Previous: Cohere Command-A (removed May 2026), Llama-3.3-70B on Fireworks (removed April 2026).
const TITLE_MODEL = UTILITY_MODEL_NAME;

export class MoonshotIntegration {

  // ─── Kimi K3 as a parallel QUERY model (Open Source mode) ──────────────

  /**
   * Query Kimi K3 as one of the 3 parallel models.
   * ALWAYS streamed — kimi-k3 reasons before content; non-streaming blocks 100+ seconds.
   * K3 contract (mirrors coding/coding-model.ts): sampling params are FIXED
   * server-side — temperature/top_p must be OMITTED (K3 rejects out-of-contract
   * params with a 400) — and the output cap is max_completion_tokens
   * (max_tokens is the K2.x param).
   * Web search: BrightData MCP context injection or agentic tool calling.
   */
  async query(
    message: string,
    mode: 'fast' | 'thinking' | 'deep_research',
    webSearch: boolean = false,
    conversationHistory: ConversationMessage[] = [],
    attachment?: Attachment,
    systemContext?: string,
    toolCache?: ToolCache
  ): Promise<{ response: string; time: number; modelUsed: string; webSearchUsed: boolean; toolCalls?: Array<{ name: string; args: Record<string, string> }> }> {
    const startTime = Date.now();

    try {
      const useWebSearch = String(webSearch) === 'true';
      const useAgenticTools = useWebSearch && !!toolCache;
      logger.debug(`Kimi query: mode=${mode}, webSearch=${useWebSearch}, agentic=${useAgenticTools}, attachment=${attachment?.type}`);

      // ── Web search — agentic loop (tools) when a ToolCache is present, else inject ──
      // With a ToolCache the model runs the agentic tool loop (search → read results →
      // search more → answer) in ALL modes, including thinking. The loop uses the
      // non-streaming tool-call path, so there is no raw tool-token leak. Only when
      // there is NO ToolCache (e.g. single-model tiers) do we fall back to one-shot
      // context injection so the model still gets grounded results.
      let webSearchContext = '';
      if (useWebSearch && !toolCache) {
        webSearchContext = await searchWithBrightData(message, 'google', conversationHistory);
      }

      // ── System context ─────────────────────────────────────────────────────
      let finalSystemContext: string;
      if (useWebSearch && webSearchContext) {
        const webInstruction = 'INSTRUCTION: Web search results are provided below. Use them as your PRIMARY source to answer the user\'s question directly. Do not substitute your training knowledge or user context for the search results.\n\n';
        const userCtx = systemContext || '';
        finalSystemContext = `${webInstruction}${webSearchContext}${userCtx ? `\n\n${userCtx}` : ''}`;
      } else if (useWebSearch && !toolCache) {
        // Empty injected search → explicit note so the model answers from
        // knowledge instead of narrating a phantom search (prod 2026-07-13).
        const userCtx = systemContext || '';
        finalSystemContext = `${SEARCH_UNAVAILABLE_NOTE}${userCtx ? `\n\n${userCtx}` : ''}`;
      } else {
        finalSystemContext = systemContext || '';
      }

      // ── Messages ───────────────────────────────────────────────────────────
      const messages: Array<{ role: string; content: any }> = [];

      if (finalSystemContext) {
        messages.push({ role: 'system', content: finalSystemContext });
      }

      for (const h of conversationHistory) {
        messages.push({ role: h.role, content: h.content });
      }

      // Build user content with optional attachment
      let userContent: string | any[] = message;

      if (attachment) {
        if (attachment.type === 'image') {
          const imageCount = 1 + (attachment.additionalFiles ?? []).filter(f => f.type === 'image').length;
          const label = imageCount > 1 ? `${imageCount} images attached` : `Image attached: ${attachment.filename || 'image'}`;
          userContent = `[${label} — image content not directly processable, answering from context]\n\nUser question: ${message}`;

        } else if (attachment.extractedText) {
          const allText = [
            `[${attachment.filename}${attachment.uploadId ? ` (uploadId: ${attachment.uploadId})` : ''}]\n${attachment.extractedText}`,
            ...(attachment.additionalFiles ?? [])
              .filter(f => f.extractedText)
              .map(f => `[${f.filename}]\n${f.extractedText}`),
          ].join('\n\n');
          userContent = `${allText}\n\nUser question: ${message}`;

        } else if (attachment.type === 'pdf') {
          userContent = `[PDF: "${attachment.filename}"${attachment.uploadId ? ` (uploadId: ${attachment.uploadId})` : ''} — content unavailable]\n\nUser question: ${message}`;
        }
      }

      messages.push({ role: 'user', content: userContent });

      // ── Route: agentic tool loop (all modes — incl. thinking — when a ToolCache exists) ─
      if (useAgenticTools) {
        const agenticResult = await this._agenticLoop(messages, toolCache!, message);
        if (agenticResult.content) {
          const time = Date.now() - startTime;
          const actuallySearchedAgentic = (agenticResult.toolCalls || []).some((tc: any) => tc.name.includes('search'));
          logger.info(`Kimi K3 (agentic, Moonshot) responded in ${time}ms [actuallySearched=${actuallySearchedAgentic}]`);
          return { response: agenticResult.content, time, modelUsed: KIMI_MODEL, webSearchUsed: actuallySearchedAgentic, toolCalls: agenticResult.toolCalls };
        }
        logger.warn(`Kimi K3: agentic loop produced no content, falling back to streaming`);
      }

      // ── Streaming query (both fast and thinking modes) ───────────────────
      // K3 contract: sampling is fixed server-side (no temperature/top_p) and
      // thinking is always on, so fast/thinking share one config. Reasoning
      // tokens consume the completion budget — keep the cap generous.
      const isThinking = mode === 'thinking' || mode === 'deep_research';
      const streamConfig = { max_completion_tokens: 16384 };

      const modeLabel = isThinking ? 'thinking' : 'fast';
      logger.info(`Kimi K3 (streaming, ${modeLabel}): querying${useWebSearch ? ' + web search' : ''}`);

      let collectedContent = '';

      // ── Moonshot direct API (kimi-k3) ──
      if (MOONSHOT_API_KEY) {
        try {
          // 2026-06-17: Wrap with retryOnModelNotFound for daily ~6am maintenance window
          collectedContent = await retryOnModelNotFound(
            () => this._streamKimiQuery(messages, streamConfig, MOONSHOT_BASE_URL, MOONSHOT_API_KEY, KIMI_MODEL, 290000),
            'Kimi K3 query',
          );
        } catch (moonshotErr: any) {
          const msErr = moonshotErr.response?.data?.error?.message || moonshotErr.message || 'unknown';
          logger.error(`Kimi K3: Moonshot direct API failed (${msErr})`);
        }
      }

      const time = Date.now() - startTime;
      if (!collectedContent) {
        // Graceful degradation: return an error marker instead of throwing.
        // This allows the remaining 2 models in Open Source mode to still synthesize.
        // Previously, throwing here caused the entire Kimi slot to show a hard error;
        // now the pipeline treats it as an empty response and proceeds with DeepSeek + GLM.
        logger.error(`Kimi K3: no content from Moonshot (${time}ms) — returning graceful error`);
        return {
          response: '',
          time,
          modelUsed: KIMI_MODEL,
          webSearchUsed: false,  // No content = web search didn't help
        };
      }
      // Kimi streaming doesn't perform web search itself — it's injected via webSearchContext.
      // 2026-06-14: Use isWebSearchMeaningful() content quality check instead of naive length
      // threshold. Fixes false-positive web search badge when BrightData returns error pages.
      const actuallySearchedWeb = useWebSearch && isWebSearchMeaningful(webSearchContext);
      logger.info(`Kimi K3 (${modeLabel}, Moonshot) responded in ${time}ms [actuallySearched=${actuallySearchedWeb}]`);
      return { response: collectedContent, time, modelUsed: KIMI_MODEL, webSearchUsed: actuallySearchedWeb };

    } catch (error: any) {
      const time = Date.now() - startTime;
      const errMsg = error.response?.data?.error?.message || error.response?.data || error.message || 'unknown error';
      logger.error(`Kimi K3 query error (${time}ms): ${errMsg}`);
      throw {
        response: `Kimi Error: ${errMsg}`,
        time,
      };
    }
  }

  async queryStream(
    message: string,
    mode: 'fast' | 'thinking' | 'deep_research',
    webSearch: boolean = false,
    conversationHistory: ConversationMessage[] = [],
    attachment?: Attachment,
    systemContext?: string,
    onEvent?: (event: ThinkingEvent) => void,
    toolCache?: ToolCache,
  ): Promise<{ response: string; time: number; modelUsed: string; webSearchUsed: boolean; toolCalls?: Array<{ name: string; args: Record<string, string> }> }> {
    const startTime = Date.now();

    try {
      const useWebSearch = String(webSearch) === 'true';
      const useAgenticTools = useWebSearch && !!toolCache;
      logger.debug(`Kimi queryStream: mode=${mode}, webSearch=${useWebSearch}, agentic=${useAgenticTools}, attachment=${attachment?.type}`);

      // With a ToolCache the agentic tool loop runs in ALL modes (thinking included) via
      // the non-streaming tool-call path; only inject one-shot search when there is no
      // ToolCache (single-model tiers).
      let webSearchContext = '';
      if (useWebSearch && !toolCache) {
        webSearchContext = await searchWithBrightData(message, 'google', conversationHistory);
      }

      let finalSystemContext: string;
      if (useWebSearch && webSearchContext) {
        const webInstruction = 'INSTRUCTION: Web search results are provided below. Use them as your PRIMARY source to answer the user\'s question directly. Do not substitute your training knowledge or user context for the search results.\n\n';
        finalSystemContext = `${webInstruction}${webSearchContext}${systemContext ? `\n\n${systemContext}` : ''}`;
      } else if (useWebSearch && !toolCache) {
        // Empty injected search → explicit note so the model answers from
        // knowledge instead of narrating a phantom search (prod 2026-07-13).
        finalSystemContext = `${SEARCH_UNAVAILABLE_NOTE}${systemContext ? `\n\n${systemContext}` : ''}`;
      } else {
        finalSystemContext = systemContext || '';
      }

      const messages: Array<{ role: string; content: any }> = [];
      if (finalSystemContext) {
        messages.push({ role: 'system', content: finalSystemContext });
      }
      for (const h of conversationHistory) {
        messages.push({ role: h.role, content: h.content });
      }

      let userContent: string | any[] = message;
      if (attachment) {
        if (attachment.type === 'image') {
          const imageCount = 1 + (attachment.additionalFiles ?? []).filter(f => f.type === 'image').length;
          const label = imageCount > 1 ? `${imageCount} images attached` : `Image attached: ${attachment.filename || 'image'}`;
          userContent = `[${label} — image content not directly processable, answering from context]\n\nUser question: ${message}`;
        } else if (attachment.extractedText) {
          const allText = [
            `[${attachment.filename}${attachment.uploadId ? ` (uploadId: ${attachment.uploadId})` : ''}]\n${attachment.extractedText}`,
            ...(attachment.additionalFiles ?? [])
              .filter(f => f.extractedText)
              .map(f => `[${f.filename}]\n${f.extractedText}`),
          ].join('\n\n');
          userContent = `${allText}\n\nUser question: ${message}`;
        } else if (attachment.type === 'pdf') {
          userContent = `[PDF: "${attachment.filename}"${attachment.uploadId ? ` (uploadId: ${attachment.uploadId})` : ''} — content unavailable]\n\nUser question: ${message}`;
        }
      }
      messages.push({ role: 'user', content: userContent });

      if (useAgenticTools) {
        const agenticResult = await this._agenticLoop(messages, toolCache!, message, onEvent);
        if (agenticResult.content) {
          const time = Date.now() - startTime;
          const actuallySearchedAgentic = (agenticResult.toolCalls || []).some((tc: any) => tc.name.includes('search'));
          logger.info(`Kimi K3 (agentic, Moonshot) responded in ${time}ms [actuallySearched=${actuallySearchedAgentic}]`);
          return { response: agenticResult.content, time, modelUsed: KIMI_MODEL, webSearchUsed: actuallySearchedAgentic, toolCalls: agenticResult.toolCalls };
        }
        logger.warn(`Kimi K3: agentic loop produced no content, falling back to streaming`);
      }

      // K3 contract: sampling is fixed server-side (no temperature/top_p) —
      // see query() above. One config for both fast and thinking.
      const isThinking = mode === 'thinking' || mode === 'deep_research';
      const streamConfig = { max_completion_tokens: 16384 };

      const modeLabel = isThinking ? 'thinking' : 'fast';
      logger.info(`Kimi K3 (queryStream, ${modeLabel}): streaming${useWebSearch ? ' + web search' : ''}`);

      let collectedContent = '';

      if (MOONSHOT_API_KEY) {
        try {
          // 2026-06-17: Wrap with retryOnModelNotFound for daily ~6am maintenance window
          collectedContent = await retryOnModelNotFound(
            () => this._streamKimiQuery(messages, streamConfig, MOONSHOT_BASE_URL, MOONSHOT_API_KEY, KIMI_MODEL, 290000, onEvent),
            'Kimi K3 queryStream',
          );
        } catch (moonshotErr: any) {
          const msErr = moonshotErr.response?.data?.error?.message || moonshotErr.message || 'unknown';
          logger.error(`Kimi K3: Moonshot direct API streaming failed (${msErr})`);
        }
      }

      const time = Date.now() - startTime;
      if (!collectedContent) {
        onEvent?.({ type: 'done' });
        logger.warn(`Kimi K3: queryStream produced no content — falling back to non-streaming query()`);
        return this.query(message, mode, webSearch, conversationHistory, attachment, systemContext, toolCache);
      }

      // Kimi streaming doesn't perform web search itself — it's injected via webSearchContext.
      // 2026-06-14: Use isWebSearchMeaningful() content quality check (see query() comment).
      const actuallySearchedWebStream = useWebSearch && isWebSearchMeaningful(webSearchContext);
      const modelUsed = KIMI_MODEL;
      logger.info(`Kimi K3 (queryStream, ${modeLabel}, Moonshot) responded in ${time}ms [actuallySearched=${actuallySearchedWebStream}]`);
      return { response: collectedContent, time, modelUsed, webSearchUsed: actuallySearchedWebStream };

    } catch (error: any) {
      const time = Date.now() - startTime;
      const errMsg = error.response?.data?.error?.message || error.response?.data || error.message || 'unknown error';
      logger.error(`Kimi K3 queryStream error (${time}ms): ${errMsg}`);
      onEvent?.({ type: 'done' });
      logger.warn(`Kimi K3 queryStream failed — falling back to non-streaming query(): ${errMsg}`);
      return this.query(message, mode, webSearch, conversationHistory, attachment, systemContext, toolCache);
    }
  }

  // ─── Private helpers for Kimi K3 streaming ──────────────────────────────

  /**
   * Stream a query to a Kimi-compatible endpoint.
   * Skips delta.reasoning_content tokens, collects only delta.content.
   * K3 contract: no sampling params, output cap via max_completion_tokens.
   */
  private async _streamKimiQuery(
    messages: Array<{ role: string; content: any }>,
    config: { max_completion_tokens: number },
    url: string,
    apiKey: string,
    model: string,
    timeout: number,
    onEvent?: (event: ThinkingEvent) => void,
  ): Promise<string> {
    const response = await axios.post(url, {
      model,
      messages,
      max_completion_tokens: config.max_completion_tokens,
      stream: true,
    }, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout,
      responseType: 'stream',
    });

    const stream = response.data;
    let buffer = '';
    let collectedContent = '';
    // Once the model starts leaking native tool-call special tokens (｜｜…),
    // stop forwarding content deltas so the markup never flashes in the UI.
    let leaked = false;

    for await (const chunk of stream) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') break;
          try {
            const parsed = JSON.parse(data);
            const reasoning = parsed.choices[0]?.delta?.reasoning_content;
            if (reasoning) { onEvent?.({ type: 'reasoning_delta', text: reasoning }); }
            const content = parsed.choices[0]?.delta?.content;
            if (content) {
              collectedContent += content;
              if (!leaked && containsToolCallLeak(collectedContent)) leaked = true;
              if (!leaked) onEvent?.({ type: 'content_delta', text: content });
            }
          } catch { /* skip invalid JSON */ }
        }
      }
    }

    onEvent?.({ type: 'done' });
    // Defensive net: strip any leaked tool-call markup from the final content.
    const cleaned = stripToolCallMarkup(collectedContent);
    if (cleaned !== collectedContent) {
      logger.warn(`Kimi K3: stripped leaked tool-call markup from streamed content (${collectedContent.length} -> ${cleaned.length} chars)`);
    }
    return cleaned;
  }

  /**
   * Agentic tool-calling loop for Kimi K3.
   * Uses non-streaming calls (Moonshot direct function calling).
   * Includes storm detection, deadline timeout, and non-agentic fallback.
   */
  private async _agenticLoop(
    messages: Array<{ role: string; content: any }>,
    toolCache: ToolCache,
    originalMessage: string,
    onEvent?: (event: ThinkingEvent) => void,
  ): Promise<{ content: string; toolCalls: Array<{ name: string; args: Record<string, string> }> | undefined }> {
    const MAX_TOOL_ITERATIONS = 2;
    // 2026-06-27 ("up timeouts a lot more"): 45s→120s. Kimi k2.6 always reasons before
    // content and its agentic web research on long-form tasks easily exceeds 45s — the
    // old cap forced a fallback (or a draft-deadline kill at 180s). 120s lets the agentic
    // answer finish well within the 300s draft deadline.
    const AGENTIC_LOOP_TIMEOUT_MS = 120000;
    const loopDeadline = Date.now() + AGENTIC_LOOP_TIMEOUT_MS;

    // Agentic calls go to Moonshot direct (kimi-k3 supports OpenAI-style tool calling)
    const agenticUrl = MOONSHOT_BASE_URL;
    const agenticKey = MOONSHOT_API_KEY!;
    const agenticModel = KIMI_MODEL;

    const payload: any = {
      model: agenticModel,
      messages: [...messages],
      // K3 contract (coding/coding-model.ts): sampling params are fixed
      // server-side — temperature/top_p must be omitted (unlike K2.6's
      // required temperature:1) — and the output cap is max_completion_tokens.
      // Reasoning shares the budget, so the old 4096 K2.6 cap could burn
      // entirely on K3's always-on thinking before any tool call emerges.
      max_completion_tokens: 16384,
      tools: TOOL_DEFINITIONS,
      tool_choice: 'auto',
    };

    let finalContent = '';
    const trackedToolCalls: Array<{ name: string; args: Record<string, string> }> = [];
    const originalMessages = [...messages];
    let lastToolKey = '';

    const timeoutPromise = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), AGENTIC_LOOP_TIMEOUT_MS)
    );

    const agenticLoopPromise = (async (): Promise<'done'> => {
      const p = { ...payload, messages: [...payload.messages] };
      for (let iteration = 0; iteration <= MAX_TOOL_ITERATIONS; iteration++) {
        if (Date.now() > loopDeadline) {
          logger.warn(`Kimi: agentic loop deadline exceeded (${AGENTIC_LOOP_TIMEOUT_MS}ms), breaking early at iteration ${iteration + 1}`);
          break;
        }

        const response = await axios.post(agenticUrl, p, {
          headers: {
            'Authorization': `Bearer ${agenticKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 150000,
        });

        const choice = response.data.choices?.[0];
        const assistantMsg = choice?.message;
        // Live status: surface this turn's reasoning (drives the thinking-summary helper).
        if (assistantMsg?.reasoning_content) {
          onEvent?.({ type: 'reasoning_delta', text: assistantMsg.reasoning_content });
        }

        if (assistantMsg?.tool_calls?.length > 0 && iteration < MAX_TOOL_ITERATIONS) {
          const newCalls = assistantMsg.tool_calls.map((tc: any) => {
            try { return { name: tc.function.name, args: JSON.parse(tc.function.arguments) }; } catch { return { name: tc.function.name, args: {} }; }
          });

          // Consecutive storm detection
          const firstNewKey = newCalls.length > 0
            ? `${newCalls[0].name}::${JSON.stringify(newCalls[0].args)}`
            : '';
          if (firstNewKey && firstNewKey === lastToolKey) {
            logger.warn(`Kimi: consecutive tool-call storm detected (${newCalls[0].name}), breaking loop`);
            break;
          }

          // Duplicate detection
          const isDuplicate = newCalls.some((nc: { name: string; args: Record<string, string> }) =>
            trackedToolCalls.some(tc => tc.name === nc.name && JSON.stringify(tc.args) === JSON.stringify(nc.args))
          );
          if (isDuplicate) {
            logger.warn(`Kimi: tool storm — same tool+args called twice, breaking loop`);
            break;
          }

          lastToolKey = firstNewKey;

          // Live status: announce the web search(es) this round (with the first query).
          const kSearchCalls = newCalls.filter((c: any) => /search/i.test(c.name));
          if (kSearchCalls.length > 0) {
            onEvent?.({ type: 'web_search_start', text: String(kSearchCalls[0].args?.query || ''), count: kSearchCalls.length });
          }
          logger.info(`Kimi: tool_calls in iteration ${iteration + 1} — ${assistantMsg.tool_calls.length} call(s)`);
          for (const nc of newCalls) { trackedToolCalls.push(nc); }
          const toolMessages = await processToolCalls(assistantMsg, toolCache);
          for (const msg of toolMessages) { p.messages.push(msg as any); }
          if (iteration === MAX_TOOL_ITERATIONS - 1) { delete p.tools; delete p.tool_choice; }
          continue;
        }

        // Strip leaked native tool-call markup (same defensive net as the
        // streaming path — the agentic loop's final turn can emit raw tool
        // tokens as content when tools were removed but the model still
        // wants to call one, e.g. during a search outage).
        finalContent = stripToolCallMarkup(assistantMsg?.content || '');
        if (finalContent !== (assistantMsg?.content || '')) {
          logger.warn(`Kimi: stripped leaked tool-call markup from agentic final content`);
          // 2026-07-13: a stripped remainder this short is a narration stub
          // ("Let me look that up…"), not an answer — the model was still
          // mid-research. Treat as no content so the grounded fallback below
          // produces a real answer instead of shipping the stub.
          if (finalContent.length < 200) {
            logger.warn(`Kimi: stripped agentic final is a ${finalContent.length}-char stub — treating as no content`);
            finalContent = '';
          }
        }
        break;
      }
      return 'done';
    })();

    const raceResult = await Promise.race([agenticLoopPromise, timeoutPromise]);
    if (raceResult === 'timeout') {
      logger.warn(`Kimi: agentic loop hit ${AGENTIC_LOOP_TIMEOUT_MS}ms timeout`);
    }

    // Fallback: non-agentic retry with clean messages (use same primary provider)
    if (!finalContent) {
      logger.warn(`Kimi K3: agentic loop produced no content, retrying without tools`);
      try {
        // 2026-07-13: GROUND the no-tools retry with a one-shot search (same
        // pattern as DeepSeek's fallback). Without it the retry answered from
        // stale training data — prod resume chat: Kimi's agentic loop timed out,
        // the ungrounded retry had no web context, and it confidently mis-stated
        // what it could and couldn't look up.
        const fallbackMessages = [...originalMessages];
        try {
          const lastUserText = [...originalMessages].reverse().find((m: any) => m.role === 'user')?.content;
          if (typeof lastUserText === 'string' && lastUserText) {
            const fbCtx = await searchWithBrightData(lastUserText, 'google');
            if (fbCtx) {
              if (fallbackMessages[0]?.role === 'system') {
                fallbackMessages[0] = { ...fallbackMessages[0], content: `${fbCtx}\n\n${fallbackMessages[0].content}` };
              } else {
                fallbackMessages.unshift({ role: 'system', content: fbCtx } as any);
              }
            }
          }
        } catch { /* grounding is best-effort — proceed ungrounded rather than fail */ }
        // Streamed (K3 always reasons — non-streaming blocks on the full
        // reasoning phase) and on the K3 contract via _streamKimiQuery, which
        // also strips leaked tool-call markup from the collected content.
        finalContent = await this._streamKimiQuery(
          fallbackMessages,
          { max_completion_tokens: 16384 },
          agenticUrl,
          agenticKey,
          agenticModel,
          150000,
        );
        if (finalContent) logger.info(`Kimi K3: non-agentic fallback succeeded (${finalContent.length} chars)`);
      } catch (fallbackErr: any) {
        logger.warn(`Kimi K3 fallback failed: ${fallbackErr.message}`);
      }
    }

    return {
      content: finalContent,
      toolCalls: trackedToolCalls.length > 0 ? trackedToolCalls : undefined,
    };
  }

  /** Get the Kimi API config — Moonshot direct API (kimi-k3) */
  private _getKimiAPI(): { url: string; apiKey: string; model: string; label: string } {
    return { url: MOONSHOT_BASE_URL, apiKey: MOONSHOT_API_KEY!, model: KIMI_MODEL, label: 'Moonshot' };
  }

  /** Static helper for external callers (e.g. deep-research.pipeline.ts) */
  static getKimiAPIConfig(): { url: string; apiKey: string; model: string; label: string } {
    return { url: MOONSHOT_BASE_URL, apiKey: MOONSHOT_API_KEY!, model: KIMI_MODEL, label: 'Moonshot' };
  }

  async synthesize(
    originalQuery: string,
    modelResponses: { [key: string]: ModelResponse },
    conversationHistory: ConversationMessage[] = []
  ): Promise<{ summary: string; time: number }> {
    const startTime = Date.now();

    try {
      const responsesText = Object.entries(modelResponses)
        .filter(([_, response]) => !response.error)
        .map(([model, response]) => `### ${model.toUpperCase()} Response (${response.time}ms):\n${response.response}\n`)
        .join('\n');

      const contextBlock = conversationHistory.length > 0
        ? `\n**Conversation History (for context):**\n${conversationHistory
            .slice(-4)
            .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.substring(0, 300)}${m.content.length > 300 ? '...' : ''}`)
            .join('\n')}\n`
        : '';

      const synthesisPrompt = this._buildSynthesisPrompt(originalQuery, responsesText, contextBlock);

      const api = this._getKimiAPI();
      // Streamed on the K3 contract (no sampling params, max_completion_tokens
      // cap) — K3 always reasons before content, so a non-streaming call would
      // block on the entire reasoning phase. Timeout matches the 240s synthesis
      // budget (reasoning shares the completion budget).
      const collected = await this._streamKimiQuery(
        [{ role: 'user', content: synthesisPrompt }],
        { max_completion_tokens: 16384 },
        api.url,
        api.apiKey,
        api.model,
        240000,
      );

      const summary = collected || 'Unable to synthesize responses';
      const time = Date.now() - startTime;
      logger.info(`Digby (Kimi K3 via ${api.label}) synthesized in ${time}ms`);
      return { summary, time };

    } catch (error: any) {
      const time = Date.now() - startTime;
      const errMsg = error.response?.data?.error?.message || error.response?.data || error.message || 'unknown error';
      logger.error(`Synthesis error (${time}ms): ${errMsg}`);
      const fallback = Object.values(modelResponses)
        .filter(r => !r.error)
        .map(r => r.response)
        .join('\n\n---\n\n') || 'Unable to get responses from any model.';
      return { summary: fallback, time };
    }
  }

  /**
   * Stream synthesized response in real-time (Digby).
   * K3 thinking is always on: delta.reasoning_content flows first (skipped),
   * then delta.content streams once reasoning completes.
   */
  async *synthesizeStream(
    originalQuery: string,
    modelResponses: { [key: string]: ModelResponse },
    conversationHistory: ConversationMessage[] = [],
    userMemoryContext?: string
  ): AsyncGenerator<string> {

    try {
      const responsesText = Object.entries(modelResponses)
        .filter(([_, response]) => !response.error)
        .map(([model, response]) => `### ${model.toUpperCase()} Response (${response.time}ms):\n${response.response}\n`)
        .join('\n');

      const contextBlock = conversationHistory.length > 0
        ? `\n**Conversation History (for context):**\n${conversationHistory
            .slice(-4)
            .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.substring(0, 300)}${m.content.length > 300 ? '...' : ''}`)
            .join('\n')}\n`
        : '';

      const synthesisPrompt = this._buildSynthesisPrompt(originalQuery, responsesText, contextBlock, userMemoryContext);

      const api = this._getKimiAPI();
      const response = await axios.post(
        api.url,
        {
          model: api.model,
          messages: [{ role: 'user', content: synthesisPrompt }],
          // K3 contract: no temperature/top_p (fixed server-side); reasoning
          // shares the completion budget with the synthesis output.
          max_completion_tokens: 16384,
          stream: true,
        },
        {
          headers: {
            'Authorization': `Bearer ${api.apiKey}`,
            'Content-Type': 'application/json',
          },
          // K3 always reasons before content — match the 240s synthesis budget.
          timeout: 240000,
          responseType: 'stream',
        }
      );

      const stream = response.data;
      let buffer = '';

      for await (const chunk of stream) {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') return;
            try {
              const parsed = JSON.parse(data);
              // K3 reasoning phase: delta.reasoning_content flows first (we
              // skip it); delta.content appears once reasoning completes.
              // Only yield delta.content.
              const content = parsed.choices[0]?.delta?.content;
              if (content) yield content;
            } catch { /* skip invalid JSON */ }
          }
        }
      }
    } catch (error: any) {
      const errMsg = error.response?.data?.error?.message || error.message;
      logger.error(`synthesizeStream error: ${errMsg}`);
      const fallback = Object.values(modelResponses)
        .filter(r => !r.error)
        .map(r => r.response)
        .join('\n\n---\n\n');
      if (fallback) yield fallback;
      else yield 'Unable to get responses from any model.';
    }
  }

  // ─── Profile interview ─────────────────────────────────────────────────────

  /**
   * Shared K3 streaming for the profile interview paths.
   *
   * K3 contract (mirrors coding/coding-model.ts): sampling params are fixed
   * server-side — temperature/top_p must be omitted — and the output cap is
   * max_completion_tokens (max_tokens is the K2.x param, which K3 400s on).
   * K3's thinking is ALWAYS ON: delta.reasoning_content streams first (skipped,
   * like every other Kimi path) and the visible reply follows, so the old K2.6
   * "instant mode" 30s deadline is replaced by a longer overall timeout plus an
   * idle watchdog — a healthy K3 stream emits reasoning deltas continuously, so
   * sustained silence means the stream is dead, not thinking.
   */
  private async *_streamProfileReply(
    messages: Array<{ role: string; content: string }>,
  ): AsyncGenerator<string> {
    // The profile interview runs on the DIGBY seat (model role chat_orchestrator)
    // since 2026-09-22 — it used to pin Kimi K3 regardless of the admin's lineup.
    // Provider payload contract: extras first, our output budget wins (reasoning
    // shares the completion budget — the old K2.6 1024 cap could burn entirely
    // on thinking before any reply emerges), omitParams stripped, Kimi's
    // max_completion_tokens honored. Reasoning deltas are skipped below.
    const { resolveProviderForRun, resolveRoleModelForRun } = await import('../coding/coding-model');
    const seatSpec = await resolveRoleModelForRun('chat_orchestrator', KIMI_MODEL);
    const provider = await resolveProviderForRun(seatSpec);
    if (!provider.apiKey && !provider.label.endsWith('(custom endpoint)')) {
      throw new Error(`Digby seat unavailable for the profile interview: ${provider.model} needs ${provider.envKey || 'its provider API key'} on this instance`);
    }
    const extra: Record<string, any> = { ...(provider.extra ?? {}) };
    delete extra.max_tokens;
    delete extra.max_completion_tokens;
    const payload: Record<string, any> = {
      ...extra,
      model: provider.model,
      messages,
      max_tokens: 4096,
      stream: true,
    };
    if ((provider.omitParams ?? []).includes('max_tokens')) payload.max_completion_tokens = 4096;
    for (const k of provider.omitParams ?? []) delete payload[k];
    const response = await axios.post(
      provider.url,
      payload,
      {
        headers: {
          ...(provider.apiKey ? { 'Authorization': `Bearer ${provider.apiKey}` } : {}),
          'Content-Type': 'application/json',
        },
        timeout: 120000,
        responseType: 'stream',
      }
    );

    const stream = response.data;
    // Idle watchdog: destroy the stream if NO deltas (reasoning included)
    // arrive for this long — the for-await then rejects into the caller's
    // fallback instead of hanging the onboarding interview.
    const IDLE_TIMEOUT_MS = 30000;
    const idleTimer = setTimeout(() => {
      stream.destroy(new Error(`${provider.model} profile stream idle > ${IDLE_TIMEOUT_MS}ms`));
    }, IDLE_TIMEOUT_MS);

    try {
      let buffer = '';
      for await (const chunk of stream) {
        idleTimer.refresh();
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') return;
            try {
              const parsed = JSON.parse(data);
              // Skip delta.reasoning_content — yield only the visible reply.
              const content = parsed.choices[0]?.delta?.content;
              if (content) yield content;
            } catch { /* skip */ }
          }
        }
      }
    } finally {
      clearTimeout(idleTimer);
    }
  }

  /**
   * Profile interview stream — Digby acts as a friendly interviewer.
   * Streamed on the Digby seat's model (see _streamProfileReply).
   */
  async *profileStream(
    userMessage: string,
    conversationHistory: ConversationMessage[] = []
  ): AsyncGenerator<string> {
    const PROFILER_PROMPT = `You are Digby, a warm, perceptive AI assistant conducting a profile interview for Digby — a multi-model AI chat platform that answers with its lead model, cross-checks harder questions with independent AI researchers, and convenes a full multi-model research council for deep research, blending everything into one synthesized answer.

Digby learns who you are and remembers you across sessions, keeps long-running coding sessions, schedules follow-ups and digests, connects to tools like Slack, Google, GitHub, and more, and gives you live web search — so the better it knows you, the more useful every answer becomes.

Your goal: have a genuine, friendly conversation to understand this person deeply — their background, expertise, communication style, and goals — so every AI response they receive feels made for them specifically.

═══ INTERVIEW QUESTIONS (ask in order, one at a time) ═══

1. NAME — "What should I call you?"

2. LIFE STAGE & OCCUPATION — "Are you a student, working professional, entrepreneur, freelancer, or something else? Tell me a bit about what you do."
   (Extract both life_stage AND occupation from their answer)

3. LOCATION — "Whereabouts in the world are you based?"

4. USE CASE — "What's bringing you to Digby? What do you mainly want to use it for — research, coding, writing, decision-making, learning, something else?"

5. TECH COMFORT — "How would you rate your comfort with technical topics? Are you more of a beginner, quite comfortable with tech, or would you call yourself an expert?"
   (Extract: novice / intermediate / expert)

6. INTERESTS — "What topics or subjects genuinely fascinate you — work-related or personal? Anything you love geeking out about?"

7. RESPONSE STYLE — "Last one: when you get an AI response, do you prefer detailed answers with full context and examples, or short punchy answers that get straight to the point?"

8. OPEN-ENDED (optional) — "Is there anything else you'd like Digby to keep in mind about you — your goals, how you think, or how you like to communicate? No pressure if not!"
   (If they skip this or say nothing, that's fine — move to persona assignment)

═══ MEMORY TAG FORMAT ═══

After EACH user response, immediately embed the extracted facts using this EXACT format (hidden from user, saved to memory):

[MEMORY:name=Paul]
[MEMORY:life_stage=working professional]
[MEMORY:occupation=software developer]
[MEMORY:location=Vancouver, Canada]
[MEMORY:use_case=research, coding help, brainstorming]
[MEMORY:tech_level=expert]
[MEMORY:interests=AI, distributed systems, philosophy]
[MEMORY:response_style=concise and direct]
[MEMORY:goals=build better AI products, stay current with the field]
[MEMORY:communication_style=casual, technical banter]

═══ PERSONA ASSIGNMENT (at interview end) ═══

After gathering sufficient information (at least questions 1–7), assign ONE persona that best represents this person based on common demographic patterns. Add these two memory tags:

Available personas:
- tech_professional → software engineers, developers, data scientists, DevOps, IT professionals, ML engineers
- business_executive → managers, executives, business owners, entrepreneurs running companies, C-suite
- creative_professional → designers, marketers, writers, photographers, content creators, brand strategists
- student_learner → university/college students, bootcamp learners, people actively changing careers or self-teaching
- researcher_analyst → academics, researchers, data analysts, scientists, policy analysts, PhD students
- curious_explorer → curious generalists, lifelong learners, people who don't fit neatly into one category, retirees exploring new things

Assign the persona BEFORE emitting [PROFILE_COMPLETE]:
[MEMORY:persona=tech_professional]
[MEMORY:persona_label=Tech Professional]

═══ CRITICAL OUTPUT FORMAT — MANDATORY ═══

Every single response MUST follow this exact structure:
  PART 1 (REQUIRED): Your conversational message — what the user reads on screen
  PART 2 (OPTIONAL): [MEMORY:key=value] tags — placed at the VERY END only

Rules:
- ALWAYS write conversational text FIRST
- [MEMORY:] tags come LAST — after all conversational text
- NEVER respond with only memory tags and no conversational message
- NEVER place a [MEMORY:] tag before your conversational message

✅ CORRECT:  "Great to meet you, Paul! What do you do for work?\n\n[MEMORY:name=Paul]"
❌ WRONG:    "[MEMORY:name=Paul]"  ← no conversational text = broken UI
❌ WRONG:    "[MEMORY:name=Paul]\nGreat to meet you!" ← tags before text = wrong order

═══ CONVERSATION RULES ═══

- Be genuinely warm, curious, and conversational — not robotic or clinical
- Acknowledge their answer authentically before moving to the next question
- Keep each message under 90 words (concise!)
- Ask ONE question per message only
- If their answer covers multiple upcoming questions, skip those and adapt
- Use light humour where natural — you're a friendly AI, not an HR interviewer
- When all key questions are done, give a warm, personalised 2–3 sentence summary that references their specific answers (e.g. what they do, what they want to use Digby for). Do NOT mention any category name, label, or "type" — just speak naturally about what you've learned about them. End with [PROFILE_COMPLETE]`;

    const messages = [
      { role: 'system' as const, content: PROFILER_PROMPT },
      ...conversationHistory.map(m => ({ role: m.role, content: m.content })),
      { role: 'user' as const, content: userMessage },
    ];

    try {
      yield* this._streamProfileReply(messages);
    } catch (error: any) {
      logger.error(`profileStream error: ${error.message}`);
      yield "I'm having trouble connecting right now. Please try again in a moment.";
    }
  }

  // ─── Profile continuation (for returning users who already have a profile) ──

  /**
   * Profile continuation stream — Digby already knows the user, helps them
   * update or expand their profile in a casual conversation.
   * Streamed on the K3 contract (see _streamProfileReply).
   */
  async *profileStreamContinuation(
    userMessage: string,
    existingFacts: Record<string, string>,
    conversationHistory: ConversationMessage[] = []
  ): AsyncGenerator<string> {
    // Build a brief summary of what Digby already knows
    const HIDDEN_KEYS = new Set(['persona', 'persona_label', '__contextState']);
    const knownFacts = Object.entries(existingFacts)
      .filter(([k]) => !HIDDEN_KEYS.has(k) && !k.startsWith('__'))
      .map(([k, v]) => `- ${k}: ${v}`)
      .join('\n') || '(none yet)';

    const CONTINUATION_PROMPT = `You are Digby, a warm and perceptive AI companion for Digby — the multi-model AI chat platform that remembers you across sessions and cross-checks deeper questions with independent AI researchers. You already know this user from a previous profile interview.

What you know about this user:
${knownFacts}

Your goal: Have a warm, casual conversation to help the user update, expand, or refine their profile. You might:
- Fill in missing details (use_case, tech_level, interests, response_style, goals, location if not known)
- Update anything they've changed (new job, new location, new interests)
- Refine existing facts if they're vague or outdated
- Chat about what they want from Digby today

═══ WHAT'S POTENTIALLY MISSING ═══

Check these profile keys and if any are absent or vague, ask about them naturally (one at a time):
- name, life_stage, occupation, location, use_case, tech_level, interests, response_style, goals, communication_style

═══ MEMORY TAG FORMAT ═══

When the user shares new or updated information, embed it at the VERY END of your message:
[MEMORY:key=value]

═══ CRITICAL OUTPUT FORMAT — MANDATORY ═══

Every single response MUST follow this exact structure:
  PART 1 (REQUIRED): Your conversational message — what the user reads on screen
  PART 2 (OPTIONAL): [MEMORY:key=value] tags — placed at the VERY END only

Rules:
- ALWAYS write conversational text FIRST — never start with a memory tag
- [MEMORY:] tags go at the very END, after your full conversational message
- NEVER respond with ONLY memory tags — that breaks the UI
- Keep responses warm, natural, under 100 words

✅ CORRECT: "Oh nice, Vancouver! I'll update that. What's drawing you to Digby lately — coding, research, something else?\n\n[MEMORY:location=Vancouver, Canada]"
❌ WRONG: "[MEMORY:location=Vancouver, Canada]" ← no conversational text

═══ PERSONA ASSIGNMENT ═══

If you have enough info and no persona is set yet (not in the known facts above), assign one at the end:
[MEMORY:persona=tech_professional]
[MEMORY:persona_label=Tech Professional]

Available: tech_professional, business_executive, creative_professional, student_learner, researcher_analyst, curious_explorer

If profile feels complete (all key fields known), you may end with [PROFILE_COMPLETE] after a warm closing message.`;

    const messages = [
      { role: 'system' as const, content: CONTINUATION_PROMPT },
      ...conversationHistory.map(m => ({ role: m.role, content: m.content })),
      { role: 'user' as const, content: userMessage },
    ];

    try {
      yield* this._streamProfileReply(messages);
    } catch (error: any) {
      logger.error(`profileStreamContinuation error: ${error.message}`);
      yield "I'm having trouble connecting right now. Please try again in a moment.";
    }
  }

  // ─── Memory consolidation ──────────────────────────────────────────────────

  /**
   * Review and improve the user's memory profile.
   * Uses the DeepSeek utility model (via utilityChat) — not Kimi.
   */
  async consolidateMemory(
    existingFacts: Record<string, string>,
    recentChatTitles: string[]
  ): Promise<Record<string, string>> {
    const factsText = Object.entries(existingFacts).map(([k, v]) => `${k}: ${v}`).join('\n') || '(none yet)';
    const titlesText = recentChatTitles.slice(0, 10).join(', ') || '(no conversations yet)';

    const prompt = `You are reviewing a user profile to improve and consolidate it.

Current profile facts:
${factsText}

Recent conversation topics (infer interests from these):
${titlesText}

Task: Create an improved profile. Rules:
- Keep all genuinely useful facts
- Infer new facts from conversation topics if confident
- Merge/clean duplicates
- Standardize values (e.g. "software dev" → "software developer")

Return ONLY a valid JSON object like: {"name": "Paul", "occupation": "developer", "interests": "AI, tech"}
No other text — just the JSON object.`;

    try {
      // Use DeepSeek V4 Flash for structured JSON output (via utility-llm.ts).
      // kimi-k2p6 always reasons first which consumes tokens and can corrupt JSON output
      // when token budget is exhausted before the final answer starts.
      const content = await utilityChat(
        [{ role: 'user', content: prompt }],
        { maxTokens: 512, temperature: 0.3, timeout: 30000 }
      );

      if (!content) return existingFacts;
      const jsonStr = content.replace(/```json\n?|\n?```/g, '').trim();
      const parsed = JSON.parse(jsonStr);
      if (typeof parsed === 'object' && parsed !== null) return parsed;
      return existingFacts;
    } catch (err: any) {
      logger.error(`consolidateMemory error: ${err.message}`);
      return existingFacts;
    }
  }

  // ─── Follow-up question generation ────────────────────────────────────────

  /**
   * Rewrite AI-perspective follow-ups into user-perspective commands.
   * 2026-06-15: Delegates to shared rewriteFollowUp() from pipeline-utils.ts
   * to eliminate duplication across 3 files (was also in query-pipeline.ts and
   * deep-research.pipeline.ts). Any fix to the rewrite logic now applies everywhere.
   */
  private _rewriteFollowUp(text: string): string {
    return rewriteFollowUp(text);
  }

  /**
   * Generate follow-up questions using the fast Llama model.
   * Called as a fallback when Kimi's synthesis didn't produce [FOLLOWUPS] tags.
   */
  async generateFollowUps(question: string, synthesis: string, memoryContext?: string): Promise<string[]> {
    // Extract user context for personalized suggestions
    let userContextHint = '';
    if (memoryContext) {
      const nameMatch = memoryContext.match(/[-\s]name:\s*([^\n]+)/i);
      const occupationMatch = memoryContext.match(/[-\s]occupation:\s*([^\n]+)/i);
      const interestsMatch = memoryContext.match(/[-\s]interests:\s*([^\n]+)/i);
      const goalsMatch = memoryContext.match(/[-\s]goals:\s*([^\n]+)/i);
      const parts: string[] = [];
      if (nameMatch) parts.push(`Name: ${nameMatch[1].trim()}`);
      if (occupationMatch) parts.push(`Occupation: ${occupationMatch[1].trim()}`);
      if (interestsMatch) parts.push(`Interests: ${interestsMatch[1].trim()}`);
      if (goalsMatch) parts.push(`Goals: ${goalsMatch[1].trim()}`);
      if (parts.length > 0) {
        userContextHint = `\n\nUser context (background only — use ONLY if directly relevant to this Q&A topic):\n${parts.join('\n')}`;
      }
    }

    const prompt = `Based on this Q&A, generate 4 follow-up suggestions to keep the user engaged. You are Digby, a proactive AI assistant.

IMPORTANT: Mix these types:
- 1-2 deeper or tangential follow-up QUESTIONS the user might want to explore
- 1-2 PROACTIVE TASK OFFERS — things you (Digby) can DO for the user right now. Frame as helpful offers like "Draft a summary of...", "Compare X vs Y for me", "Create a checklist for...", "Research [related topic] for me" — make the user think "oh, that would actually be useful"
- ALL suggestions must stay on the topic of THIS Q&A. Only connect a suggestion to the user context below if that context is DIRECTLY relevant to this topic — NEVER drag the user's occupation/interests/goals into an unrelated topic just to personalize${userContextHint}

CRITICAL PHRASING RULE: Every suggestion MUST be written as something the USER would say or type. These become clickable buttons — when clicked, the text is sent as the user's next message. So write them from the user's perspective:
✅ CORRECT: "What are the best times to schedule meetings this week?" (user asking)
✅ CORRECT: "Show me tomorrow's calendar events" (user command)
✅ CORRECT: "Draft a reminder email about the skating lesson" (user requesting action)
❌ WRONG: "Would you like me to check your schedule?" (AI asking user)
❌ WRONG: "Do you want more details about this event?" (AI asking user)
❌ WRONG: "I could look into that for you" (AI offering — not a user message)

ONE QUESTION PER SUGGESTION: Each suggestion MUST be a SINGLE focused question or request. NEVER combine multiple questions into one line.
❌ WRONG: "What are the costs, timeline, and requirements for getting started?"
✅ CORRECT: "What are the typical costs?"

Question: ${question.substring(0, 200)}

Answer: ${synthesis.substring(0, 600)}

Return ONLY the suggestions, one per line, no numbering, no bullets, no extra text:`;

    try {
      // 2026-06-20: Pass retryNotFound so the DeepSeek utility call retries (short
      // backoff) on a "model not found"/404 before falling through to the DashScope
      // fallback. Production logs showed repeated "generateFollowUps unavailable …
      // 404" warnings in bursts during the daily ~6am UTC provider maintenance window
      // (the same window that hits GLM/DeepSeek/Kimi). Follow-ups run in the
      // post-synthesis task batch (answer already streamed), so the brief retry delay
      // is invisible to the user.
      // contentOnly: true is CRITICAL here. The DeepSeek utility model emits
      // `reasoning_content` (raw chain-of-thought) BEFORE `content`. Without
      // contentOnly, a too-tight budget that truncates before content emerges
      // makes utilityLLM fall back to returning the raw reasoning — which then
      // leaks into the suggestion buttons as e.g. "We need to generate 4
      // follow-up suggestions for the user. The user is 'Rome' based on
      // context… I'll follow the context…" (reported 2026-06-22 thumbs-down).
      // With contentOnly the call falls through to the non-reasoning DashScope
      // model instead of leaking. maxTokens raised from 200 → 700 to leave the
      // reasoning model real headroom so clean `content` actually emerges.
      const raw = await utilityChat(
        [{ role: 'user', content: prompt }],
        { maxTokens: 700, temperature: 0.8, timeout: 12000, retryNotFound: true, contentOnly: true }
      );
      if (!raw) {
        logger.warn(`generateFollowUps: ${TITLE_MODEL} returned empty content`);
        return [];
      }

      // Defense-in-depth: even with contentOnly, reject any line that reads like
      // the model's own meta-reasoning or a prompt echo rather than a user-facing
      // suggestion (e.g. "We need to generate 4 follow-up suggestions…",
      // "I'll follow the context: the user is Rome…", lines naming the prompt's
      // own context fields). Mirrors sanitizeStatusLine's guard in utility-llm.ts.
      // A real suggestion is a first-person user message ("Show me…", "What is…"),
      // so it would never refer to "the user", "the context", "the Q&A", or the
      // prompt's own scaffolding. Those phrases are high-signal CoT/prompt-echo
      // markers. Note `the user'?s?` (apostrophe-tolerant) and `the context` are
      // added to catch lines the old pattern missed — e.g. the reported
      // "Possibly the user's name is Rome?" and "Or the context is separate?".
      // 2026-06-23: Also reject lines that OPEN with a reasoning hedge/conjunction.
      // A genuine user-perspective suggestion always opens with a question word or an
      // action verb (enforced by the include-filter below); a CoT fragment opens with
      // "Possibly…", "Maybe…", "Or…", "Perhaps…", "Wait…", "Hmm…", "Actually…", "So…".
      // These slipped through the keyword regex (e.g. the reported "Possibly the user's
      // name is Rome?" partially matched, but "Or the answer is…" did not).
      // 2026-06-24: Extended with `or|alternatively|actually` — pure reasoning
      // hedges/conjunctions that open a CoT fragment ("Or the answer is…",
      // "Alternatively, the context…", "Actually the user…") but never a genuine
      // user-facing suggestion (those are caught by the action/question include-filter
      // below). The earlier comment flagged "Or the answer is…" as a known miss.
      // 2026-07-04: The meta-reasoning + structural-prose guards were extracted to
      // the shared, unit-tested isLeakedReasoningFollowUp() in pipeline-utils.ts so
      // the recurring reasoning-leak patterns are covered by regression tests and
      // can't silently drift. Behavior is identical to the previous inline closures.
      const questions = raw
        .split('\n')
        .map((line: string) => line.replace(/^[-•*\d.)]+\s*/, '').trim())
        .filter((line: string) => line.length > 10 && (line.includes('?') || /^(show me|tell me|give me|list|draft|create|compare|check|research|find|summarize|explain|what|how|why|when|where|who|can you|help me|look up|search for|want me to|i could|i can|should i|let me|shall i)/i.test(line)))
        .filter((line: string) => !isLeakedReasoningFollowUp(line))
        .map((line: string) => this._rewriteFollowUp(line))
        .slice(0, 5);

      logger.info(`generateFollowUps (${TITLE_MODEL}): ${questions.length} questions`);
      return questions;
    } catch (err: any) {
      // Include HTTP status in log for debugging 404/401/429 errors
      const status = err.response?.status || '';
      logger.warn(`generateFollowUps unavailable (${TITLE_MODEL}${status ? ` HTTP ${status}` : ''}): ${err.message}`);
      return [];
    }
  }

  // ─── Title generation ──────────────────────────────────────────────────────

  /**
   * Generate a short 4-6 word title for a conversation.
   * Uses the DeepSeek utility model (via utilityChat) — not Kimi.
   */
  async generateTitle(question: string, answer: string): Promise<string> {
    // A machine header at position 0 (agent-send / machine-firing chrome) is
    // never the subject of the conversation — title the task, not the plumbing
    // (rollout watch 2026-09-14: "CanLaw Supervisor Agent Message Received" ×4).
    // Ticket 161d39e9: the spawned-child [PARENT SESSION CONTEXT] digest is
    // the same class — its body is the PARENT's run outcomes, and seeding the
    // title chain from it manufactured verdict-phrase titles. Strip the digest
    // FIRST (headers-first would strand the digest's outcome body), then the
    // position-0 headers.
    question = stripLeadingMachineHeaders(stripParentContextDigest(question || '')) || question || '';
    const localTitle = this._smartLocalTitle(question, answer);

    const prompt = `Based on this Q&A, write a 4-6 word title. No quotes, no period at end, title case.

Q: ${question.substring(0, 150)}
A: ${answer.substring(0, 200)}

Title:`;

    try {
      // DeepSeek V4 Flash — sub-2s, concise titles.
      // CRITICAL: DeepSeek V4 Flash in non-streaming mode returns its entire
      // chain-of-thought reasoning within `message.content`, not in a separate
      // `reasoning_content` field. For a prompt as short as this one the model
      // will spend most of its budget thinking out loud ("We need to generate
      // a 4-6 word title... let me consider...") before proposing the actual
      // answer. We therefore need a larger budget so the model has room to
      // finish its reasoning AND emit the clean title at the end.
      //
      // We also add a system message telling the model to answer ONLY with
      // the title — no reasoning — as a defense-in-depth layer. Even with the
      // system message some reasoning models still think out loud, so the
      // extraction heuristic (below) is the primary defense.
      const raw = await utilityChat(
        [
          { role: 'system', content: 'Output ONLY the title. No reasoning, no explanation, no commentary — just the title.' },
          { role: 'user', content: prompt },
        ],
        // contentOnly:true is CRITICAL — deepseek-flash is a reasoning model. Without this, when
        // its chain-of-thought consumes the token budget and `content` is empty, utilityLLM falls
        // back to `reasoning_content` (raw "We need to generate a 4-6 word title…") and that leaks
        // into the title. With contentOnly, empty content instead falls through to the non-reasoning
        // Fireworks fallback (clean title), then to the local fallback — reasoning never becomes a title.
        // 2026-08-08: maxTokens 512 → 1536. Prod telemetry (feedback 0222d8f9,
        // "chat title not working again") shows recurring 'returned empty
        // content' warns: the DeepSeek flash model's chain-of-thought regularly burns
        // the whole 512 budget before emitting any content, so the title
        // degraded to the raw-question local fallback. 1536 gives the CoT room
        // to finish AND emit the title; maxTokens is a cap, not a target.
        // 2026-08-13 (audit p10): timeout 8000 → 15000. utilityChat is
        // NON-streaming, so the whole CoT must generate inside the axios
        // wall-clock — at 8s the raised token budget just converted 'empty
        // content' into ECONNABORTED for the long-CoT tail the bump targeted,
        // landing on the same local fallback. 15s gives ~1k reasoning tokens
        // room to finish; the caller-side race (chat-agent up-front title)
        // is sized to cover it, and the fallback chain is unchanged.
        { maxTokens: 1536, temperature: 0.7, timeout: 15000, contentOnly: true }
      );
      if (!raw) {
        logger.warn(`generateTitle: ${TITLE_MODEL} returned empty content, using local fallback: "${localTitle}"`);
        return localTitle;
      }

      const title = this._extractTitleFromRaw(raw);
      // Defense-in-depth: if the extracted text still reads like meta-reasoning or is far too long
      // to be a title, discard it and use the local (question-derived) fallback instead.
      if (!title || this._looksLikeReasoning(title)) {
        logger.warn(`generateTitle: extracted text looked like reasoning ("${title}"), using local fallback: "${localTitle}"`);
        return localTitle;
      }
      logger.info(`generateTitle (${TITLE_MODEL}): "${title}"`);
      return title.substring(0, 60) || localTitle;
    } catch (err: any) {
      logger.warn(`generateTitle (${TITLE_MODEL}) unavailable, using local fallback: "${localTitle}" — ${err.message}`);
      return localTitle;
    }
  }

  /**
   * GHOST title (ticket de60115d, 2026-10-23 — "ghost mode chat title not
   * working"): the same 4-6 word title every other chat gets, WITHOUT ever
   * touching a cloud model. The original ghost skip (owner 2026-10-22) dropped
   * title generation entirely because generateTitle ships the message text to
   * the utility chain (Moonshot/DeepSeek) — the privacy intent is right, but
   * the placeholder it left behind ("the first 60 characters of the question…"
   * or "New chat", forever) reads as broken.
   *
   * Two legs, both privacy-preserving:
   *   spec       the admin-designated ghost endpoint, when one is live — the
   *              model that ALREADY sees the whole conversation, so a one-line
   *              title prompt to it exposes nothing new. Non-streaming, one
   *              call, same extraction + reasoning guards as generateTitle.
   *   local      the hardened local fallback generateTitle itself uses
   *              (_smartLocalTitle → cleanQuestionForTitle) — no network at
   *              all. Used when no designation is live (unset / disabled /
   *              unresolvable) or the endpoint leg fails in any way.
   *
   * NEVER the utilityChat chain: the documented promise ("nothing about a
   * ghost conversation ever routes through a model the admin did not
   * designate", docs/GHOST_MODE.md) holds for titles too.
   */
  async generateGhostTitle(question: string, answer: string, spec: string | null): Promise<string> {
    // Same header stripping as generateTitle: a machine-send header or a
    // [PARENT SESSION CONTEXT] digest is never the subject of the chat.
    const q = stripLeadingMachineHeaders(stripParentContextDigest(question || '')) || question || '';
    const localTitle = this._smartLocalTitle(q, answer);
    if (!spec) return localTitle;
    const prompt = `Based on this Q&A, write a 4-6 word title. No quotes, no period at end, title case.\n\nQ: ${q.substring(0, 150)}\nA: ${answer.substring(0, 200)}\n\nTitle:`;
    try {
      // Resolve the designation's own provider and call it directly — the
      // shared non-streaming helper (thinking-off directive for custom
      // endpoints, <think> stripping, diagnostic throw on empty). Dynamic
      // imports: utility-llm's own override leg uses the same seam, and this
      // keeps moonshot.integration's static module graph unchanged.
      const { resolveProviderForRun } = await import('../coding/coding-model');
      const p = await resolveProviderForRun(spec);
      // A colon spec that silently fell back to built-ins would route the
      // prompt to a cloud provider — refuse instead (same guard as the
      // utility override leg).
      if (spec.includes(':') && !p.label.endsWith('(custom endpoint)')) {
        logger.warn(`generateGhostTitle: spec "${spec}" resolved to a built-in provider — using local fallback`);
        return localTitle;
      }
      const { postNonStreamingCompletion, extractNonStreamingAnswer } = await import('../coding/helper-completion');
      const payload: Record<string, any> = {
        ...p.extra,
        model: p.model,
        messages: [
          { role: 'system', content: 'Output ONLY the title. No reasoning, no explanation, no commentary — just the title.' },
          { role: 'user', content: prompt },
        ],
        // 1536, not 512 (review finding 1, ticket de60115d): a thinking
        // designated model can burn 512 tokens on CoT and return empty —
        // the exact failure that pushed the utility chain's budget to 1536
        // (feedback 0222d8f9). A cap is not a target; the budget only gives
        // reasoning room to FINISH and emit the title. Applies after
        // ...p.extra so a provider default cannot shrink it.
        max_tokens: 1536,
        temperature: 0.7,
      };
      for (const k of p.omitParams ?? []) delete payload[k];
      const resp = await postNonStreamingCompletion(p, payload, { timeout: 15000 });
      const answer_ = extractNonStreamingAnswer(resp.data?.choices?.[0]);
      const raw = answer_.text;
      if (!raw) {
        logger.warn(`generateGhostTitle: ghost endpoint "${spec}" returned empty content, using local fallback: "${localTitle}"`);
        return localTitle;
      }
      const title = this._extractTitleFromRaw(raw);
      if (!title || this._looksLikeReasoning(title)) {
        logger.warn(`generateGhostTitle: ghost endpoint "${spec}" output looked like reasoning ("${title}"), using local fallback: "${localTitle}"`);
        return localTitle;
      }
      logger.info(`generateGhostTitle (${spec}): "${title}"`);
      return title.substring(0, 60) || localTitle;
    } catch (err: any) {
      logger.warn(`generateGhostTitle (${spec}) unavailable, using local fallback: "${localTitle}" — ${err?.message ?? err}`);
      return localTitle;
    }
  }

  /**
   * Extract the actual title from a potentially verbose model response.
   *
   * DeepSeek V4 Flash (and other reasoning models) may return the full
   * chain-of-thought reasoning in `content`, e.g.:
   *   "We need to generate a 4-6 word title... let me consider...
   *    I'll propose: \"Six Days to Deadline\" - exactly 4 words."
   *
   * Strategy (try each, first match wins):
   *   1. If the response is short (≤80 chars), clean and return it directly.
   *   2. Extract the first quoted string that looks like a title (3-8 words).
   *   3. Look for "I'll propose:", "My title:", "Final title:" patterns.
   *   4. Take the last sentence (after the final period).
   *   5. Fall back to the original cleaning pipeline.
   */
  private _extractTitleFromRaw(rawInput: string): string {
    // ── Step 0: strip leaked reasoning blocks ──────────────────────────────
    // 2026-07-08: "chat title generation broken again" feedback. Reasoning models
    // (deepseek-flash utility) occasionally emit their chain-of-thought inside the
    // CONTENT field as a <think>…</think> (or <reasoning>…</reasoning>) block, which
    // contentOnly:true cannot filter (it only drops the separate reasoning_content
    // channel). Without stripping, the block bled into the title. Remove any such
    // block, plus a dangling unterminated "<think> …" tail, before extraction.
    // 2026-07-09: harden against MISMATCHED and UNTERMINATED reasoning tags.
    //  • The backreference `\1` only strips exactly-matched pairs (<think>…</think>),
    //    so a model that emits <think>…</thinking> (mismatched close, which some do)
    //    slipped through — the second .replace() then removed only the tags and left
    //    the reasoning content as the title.
    //  • An unterminated <think>… (closing tag beyond the 512-token budget) also leaked
    //    the whole chain-of-thought. Now: strip any opening reasoning tag to the FIRST
    //    reasoning close regardless of which of the three it is, then strip a dangling
    //    opener to end-of-string, then mop up any stray tags.
    const raw = rawInput
      // 1. properly-matched blocks (fast path, exact pair)
      .replace(/<(think|reasoning|thinking)>[\s\S]*?<\/\1>/gi, '')
      // 2. mismatched pairs: any reasoning-open → nearest reasoning-close of ANY kind
      .replace(/<(?:think|reasoning|thinking)>[\s\S]*?<\/(?:think|reasoning|thinking)>/gi, '')
      // 3. dangling/unterminated opener with no close → strip to end of string
      .replace(/<(?:think|reasoning|thinking)>[\s\S]*$/i, '')
      // 4. mop up any stray tags left behind
      .replace(/<\/?(?:think|reasoning|thinking)>/gi, '')
      .trim();

    // ── Step 1: short response → likely clean, use directly ────────────────
    if (raw.length <= 80) {
      return this._cleanTitle(raw);
    }

    // ── Step 2: quoted title candidates (e.g. "Six Days to Deadline") ─────
    const quoted = raw.match(/"([^"]{8,60})"/g);
    if (quoted) {
      for (const q of quoted) {
        const inner = this._cleanTitle(q.replace(/^"|"$/g, ''));
        // Must be 3-8 words and not a full sentence (no ending period, not
        // excessively long, looks like title case)
        const words = inner.split(/\s+/);
        if (words.length >= 3 && words.length <= 8 && !inner.endsWith('.') && !inner.includes('?')) {
          return inner;
        }
      }
    }

    // ── Step 3: explicit proposal markers ──────────────────────────────────
    const proposeMatch = raw.match(/(?:I'll propose|I propose|My title|Final title|Best title)[:\s]+(.+?)(?:$|\.\s|\s+-\s+\d)/im);
    if (proposeMatch?.[1]) {
      const candidate = this._cleanTitle(proposeMatch[1]);
      const words = candidate.split(/\s+/);
      if (words.length >= 2 && words.length <= 10) {
        return candidate;
      }
    }

    // ── Step 4: last sentence (after final period) ─────────────────────────
    const sentences = raw.split(/(?<=\.)\s+/);
    for (let i = sentences.length - 1; i >= 0; i--) {
      const s = this._cleanTitle(sentences[i]!);
      const words = s.split(/\s+/);
      if (words.length >= 2 && words.length <= 10 && s.length < 80) {
        return s;
      }
    }

    // ── Step 5: fallback — standard cleaning on last 80 chars ──────────────
    return this._cleanTitle(raw.substring(Math.max(0, raw.length - 120)));
  }

  /**
   * Normalize a title candidate into clean plain text. Chat titles render as
   * plain text in the sidebar, so ANY leaked markup shows up literally
   * ("**Six Days to Deadline**", "## Roadmap", "`config`"). This strips, in
   * order: a leading "Title:"/"Here's the title:" label, markdown heading (#)
   * and list (-, *, 1.) markers, surrounding markdown emphasis (**, __, *, _),
   * backticks, surrounding quotes, a trailing period, and collapses whitespace.
   * Applied to EVERY return path of _extractTitleFromRaw so no formatting slips
   * through regardless of which extraction branch matched.
   */
  private _cleanTitle(candidate: string): string {
    return candidate
      .replace(/^\s*(?:title:|here(?:'s| is)(?: the)? title:?\s*)/i, '') // leading label
      .replace(/^\s*#{1,6}\s*/, '')            // markdown heading markers
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '') // markdown/numbered list markers
      .replace(/`/g, '')                        // inline code backticks
      .replace(/\*\*([^*]+)\*\*/g, '$1')        // bold **text** (stripped first)
      .replace(/__([^_]+)__/g, '$1')            // bold __text__ (stripped first)
      // Italic emphasis. Bold delimiters are already removed above, so any
      // remaining single * / _ pairs are italics or strays. Avoid negative
      // lookbehind ((?<!...)) here — it throws a SyntaxError on Safari < 16.4
      // (iOS 15-), silently falling back to raw output with visible *markdown*.
      .replace(/\*([^*]+)\*/g, '$1')            // italic *text*
      .replace(/_([^_]+)_/g, '$1')              // italic _text_
      .replace(/^["'*_\s]+|["'*_\s]+$/g, '')    // stray leading/trailing quotes, emphasis, spaces
      .replace(/\.$/, '')                        // trailing period
      .replace(/\s+/g, ' ')                      // collapse whitespace
      .trim();
  }

  /**
   * True when a candidate "title" is actually leaked model reasoning / prompt echo, or is far too
   * long to be a 4-6 word title. Used to reject bad titles in favor of the local fallback.
   */
  private _looksLikeReasoning(s: string): boolean {
    const t = s.trim();
    if (!t) return true;
    if (t.split(/\s+/).length > 10) return true; // titles are 4-6 words; >10 is prose/reasoning
    return /\b(we need to|we should|we can|i need to|i should|let me|i'?ll propose|i propose|the user (just )?(asked|wants|said|is)|based on (the|this)\b|here'?s (a|the|my)|here is (a|the|my)|a (good|possible|suitable|concise) title|the q\s*&\s*a|the question|chain of thought|reasoning|let'?s (write|craft|create))\b/i.test(t);
  }

  /**
   * Generate a meaningful title locally without API calls.
   * Strategy: question-first (most reliable), then synthesis heading, then raw question.
   */
  private _smartLocalTitle(question: string, answer: string): string {
    const cleanedQuestion = cleanQuestionForTitle(question);

    // 2026-06-17: Reject titles that look like Gmail metadata / subject lines
    const EMAIL_LIKE_TITLES = [
      /^(External|Inbox|Sent|Draft|Starred|Important|Spam|Trash|All Mail)$/i,
      /^AI Overview$/i,
      /^(You sent|Shannon sent|.+ sent)\b/i,
      /^(Re|Fwd|FW):/i,
      /^By,?\s*$/i,
    ];
    const looksLikeEmail = EMAIL_LIKE_TITLES.some(p => p.test(cleanedQuestion));

    if (!looksLikeEmail && cleanedQuestion.length >= 4) {
      return cleanedQuestion.substring(0, 60);
    }

    if (answer) {
      const headingMatch = answer.match(/^#{1,3}\s+(.+)$/m);
      if (headingMatch) {
        const heading = headingMatch[1].replace(/[#*_`]/g, '').trim();
        if (heading.length >= 4 && heading.length <= 70) {
          return heading.substring(0, 60);
        }
      }
    }

    // Last resort: the CLEANED question — never the raw one, which can carry
    // emails/UUIDs straight into the sidebar (reviewer catch, 2026-08-08).
    return cleanedQuestion.substring(0, 60) || 'New Conversation';
  }

  // ─── Synthesis prompt builder (shared) ────────────────────────────────────

  /**
   * Build the synthesis prompt. If userMemoryContext is provided, parse the
   * user's persona and inject a persona-specific Digby companion tone.
   */
  private _buildSynthesisPrompt(
    originalQuery: string,
    responsesText: string,
    contextBlock: string,
    userMemoryContext?: string
  ): string {
    let personaToneBlock = '';
    if (userMemoryContext) {
      const personaMatch = userMemoryContext.match(/[-\s]persona:\s*(\w+)/i);
      const techMatch    = userMemoryContext.match(/[-\s]tech_level:\s*([^\n]+)/i);
      const styleMatch   = userMemoryContext.match(/[-\s]response_style:\s*([^\n]+)/i);
      const nameMatch    = userMemoryContext.match(/[-\s]name:\s*([^\n]+)/i);

      const persona      = personaMatch?.[1]?.trim().toLowerCase() || '';
      const techLevel    = techMatch?.[1]?.trim() || '';
      const stylePrefs   = styleMatch?.[1]?.trim() || '';
      const userName     = nameMatch?.[1]?.trim() || '';

      const personaTones: Record<string, string> = {
        tech_professional:
          'You are talking to a technical peer. Skip over-explaining basics. ' +
          'Use precise technical vocabulary freely. Be direct and sharp — they can handle it. ' +
          'Occasional dry wit is welcome. Assume they know common concepts and frameworks.',

        business_executive:
          'You are talking to a busy decision-maker. Lead with the key insight or recommendation first. ' +
          'Be concise and decisive. Frame everything in terms of outcomes, trade-offs, and business impact. ' +
          'Cut fluff — every sentence should earn its place.',

        creative_professional:
          'You are talking to a creative thinker. Be expressive and a bit imaginative in your language. ' +
          'Appreciate the aesthetic, narrative, and conceptual angles of topics. ' +
          'Be inspiring, not just informative. Connect ideas in interesting ways.',

        student_learner:
          'You are talking to someone who is actively learning. Be patient, encouraging, and clear. ' +
          'Use analogies and concrete examples to anchor abstract concepts. ' +
          'Celebrate good questions. Build from first principles when needed. ' +
          'Make it feel like a smart tutor who genuinely wants them to succeed.',

        researcher_analyst:
          'You are talking to someone who values precision and evidence. Be methodical and thorough. ' +
          'Acknowledge uncertainty and caveats honestly. Value accuracy over simplicity. ' +
          'Cite important nuances, edge cases, and assumptions. ' +
          'They prefer rigour over hand-waving.',

        curious_explorer:
          'You are talking to a curious, wide-ranging thinker. Be warm and enthusiastic. ' +
          'Connect ideas across domains and share interesting angles they might not have considered. ' +
          'Make it feel like a rich conversation between two people who love ideas. ' +
          'Tangents are welcome when they are interesting.',
      };

      const toneInstruction = persona && personaTones[persona] ? personaTones[persona] : '';

      const styleInstruction = stylePrefs
        ? (stylePrefs.toLowerCase().includes('concise') || stylePrefs.toLowerCase().includes('short') || stylePrefs.toLowerCase().includes('direct')
          ? 'This user prefers concise, direct answers — avoid over-explaining or padding.'
          : 'This user appreciates detailed answers with context and examples.')
        : '';

      const techInstruction = techLevel
        ? (techLevel.toLowerCase().includes('novice') || techLevel.toLowerCase().includes('beginner')
          ? 'Avoid assuming background knowledge — define jargon when you use it.'
          : techLevel.toLowerCase().includes('expert')
          ? 'You can assume strong technical background — no need to define standard terms.'
          : '')
        : '';

      const nameLine = userName ? `You are speaking with ${userName}.` : '';

      const toneParts = [nameLine, toneInstruction, styleInstruction, techInstruction].filter(Boolean);
      if (toneParts.length > 0) {
        personaToneBlock = `\n**YOUR COMPANION VOICE FOR THIS USER:**\n${toneParts.join(' ')}\n`;
      }
    }

    return `You are an expert AI synthesizer named Digby. Multiple AI models have answered the following question, and your job is to combine their insights into ONE unified, coherent answer.
${personaToneBlock}${contextBlock}
**User's Current Question:**
${originalQuery}

**Model Responses to Consider:**
${responsesText}

**CRITICAL INSTRUCTIONS:**
1. Create a SINGLE unified answer - DO NOT label or attribute parts to individual models
2. DO NOT use formats like "**OPENAI:** ..." or "**GROK:** ..." or "**GEMINI:** ..."
3. **NEVER mention any AI model or brand by name** — never say OpenAI, ChatGPT, GPT, Grok, Gemini, Claude, Kimi, DeepSeek, Llama, Mistral, Together AI, or any other AI model/brand. You are Digby, a unified intelligence. There is no "combining Model A's X with Model B's Y" — just synthesize seamlessly without attribution.
4. Synthesize ALL insights from all responses into one comprehensive, seamless answer — incorporate ALL specific data points, numbers, comparisons, and insights from each response that are relevant to the user's question. Do NOT drop specific data that only one response provided.
5. If models agree, present the consensus confidently
6. If models disagree on facts, use the response with actual sources/data as the primary basis. If models disagree on SPECIFICITY (one is detailed, another is vague), include the MORE specific response's data — never generalize specific data into vague summaries.
7. If this is a follow-up question, answer it in context of the conversation history — BUT if the user is CORRECTING a previous misunderstanding (phrases like "I meant", "no I was asking about", "not that", "I'm talking about", "I said"), treat the corrected topic as the ONLY subject. Discard prior context that conflicts with the correction. The user's latest message always overrides prior conversation context.
8. Add context and clarity where helpful
9. Keep tone professional and direct
10. **FORMATTING FOR READABILITY**: Structure responses so they are easy to scan. Use **bold** for key terms (not every sentence). Use bullet points or numbered lists when presenting multiple items, features, options, or steps — NEVER list capabilities or features in a run-on paragraph. Use ## headings for major sections in longer answers. Short answers (1-3 sentences) need no special formatting. Medium answers should use bold key terms and bullet lists. Longer answers should use section headings. Proper spacing between sections is essential.
11. Avoid over-formatting — do NOT bold entire sentences or every heading. Natural paragraph structure is preferred for explanatory text, but lists of items MUST use bullet points or numbers.
12. Use headings (##) for major sections, but keep most text as regular paragraphs
13. **FACTUAL CONTENT RULE — CRITICAL**: The companion voice above adapts your TONE and COMMUNICATION STYLE only. It does NOT mean you should replace factual content with user-specific context. If any model returned real web search results (actual headlines, sources, dates), those MUST form the primary basis of your answer — synthesize the actual facts first.
14. **REAL-TIME QUESTIONS**: For questions about current events, news, prices, or live information — synthesize the ACTUAL search results from the models that found them. Do not substitute user project context for real news. If one model found real results and others did not, build from the model that has factual data.
15. **CONTEXT IS BACKGROUND**: User memory/context tells you WHO you're talking to and HOW to communicate — it is never the answer to a news or factual question.
16. **NUMERICAL ACCURACY — CRITICAL**: NEVER fabricate, round, average, or approximate numbers, statistics, percentages, prices, dates, quantities, or any numerical data. If you cite a number, it must appear EXACTLY as stated in the model responses or web search results. Do NOT combine numbers from different model responses by averaging them. Do NOT invent statistics to sound authoritative. If you perform a calculation, show your working so the user can verify. If model responses disagree on a number, state the discrepancy and cite which response each number comes from rather than picking one silently. Getting numbers wrong destroys user trust immediately.
17. **NEVER FABRICATE PRODUCT FEATURES**: Do NOT invent specific menu items, navigation paths, settings, tabs, buttons, or UI elements in any software product. If you are unsure whether a feature exists at a specific location (e.g. "go to Tools > Assessments"), say "I'm not certain of the exact navigation path — please check your product's documentation or settings" rather than guessing. Fabricated step-by-step instructions that reference non-existent UI elements are harmful and erode user trust. Only describe features and paths you are confident exist based on the model responses or well-established knowledge.
18. **UNCERTAINTY IS OK**: If the model responses lack specific details about a product's interface or features, it is better to say "I don't have confirmed details about that specific feature" than to fill the gap with plausible-sounding but unverified information. Users prefer honesty over confident-sounding fabrication.
19. **STRUCTURED DATA = DIRECT ANSWER**: When the system context includes structured data from Google Workspace (calendar events, emails, Drive files), Xero, Slack, Asana, or any other integration — your FIRST priority is to DIRECTLY present that data in a clear, organized way. Do NOT ask clarifying questions when the data is already available. For calendar queries: list the events with times, dates, and details. For email queries: summarize the messages. The user asked a question and the system already fetched the relevant data — just answer it. Only ask follow-up questions if the data is genuinely ambiguous or incomplete.
20. **CALENDAR DATE ACCURACY**: When describing calendar events relative to the current date (e.g., "today", "tomorrow", "this Thursday"), ALWAYS use the USER LOCAL date/time from the datetime block — NOT the UTC date. If the user's local date is Monday March 30 and an event is on Tuesday March 31, that event is "tomorrow" — regardless of what the UTC date says. Getting the day wrong erodes trust immediately.
21. **CONTENT DELIVERY — CRITICAL**: When the user asks you to CREATE, WRITE, DRAFT, or GENERATE content (a document, one-pager, email, plan, report, letter, template, guide, checklist, etc.) — produce the ACTUAL COMPLETE content. NEVER respond with only a preamble describing what you plan to create (e.g. "I'll create a comprehensive one-pager..." or "Let me draft a report covering..."). The user wants the finished product, not a preview of your intentions. Produce the full content immediately.
22. **USER EXPLICIT REJECTION — CRITICAL**: When the user explicitly rejects a topic, assumption, or personal attribute (e.g. "stop talking about my joint health", "I'm not plant based", "I told you many times", "I don't", "I never said that"), you MUST immediately and permanently stop referencing the rejected topic. The user's explicit denial ALWAYS overrides anything in user memory, context, or conversation history. Do NOT argue, do NOT bring it up again, do NOT reference it even indirectly. Accept the correction, apologize briefly if appropriate, and move on. Repeating a rejected topic after the user has told you to stop is the fastest way to destroy trust.
23. **CONVERSATION CONTINUITY — CRITICAL**: When conversation history is present, the "User's Current Question" above is the CURRENT question you must answer NOW. Previous conversation messages are background context only — they tell you what was discussed before. Do NOT confuse previous assistant responses with the current model responses listed under "Model Responses to Consider". Those model responses are the ONLY inputs for your synthesis of the CURRENT question. If the previous conversation covered a completely different topic, that is fine — answer the current question on its own merits. The user may change topics between messages.
24. **SELF-REFERENTIAL FOLLOW-UP — CRITICAL**: When the user asks a short question like "what's X?", "what is X?", "explain X", or "tell me more about X" — and X is a term that appeared in YOUR previous response or in the model responses — the user is asking about X in the context of THIS conversation. Do NOT answer about a completely different entity that happens to share the same name. If a [FOLLOW-UP REFERENCE CONTEXT] block is present in the system context, it contains the exact passage where the term was used — use it as the primary reference. For example, if the previous response mentioned "Teranet" as a colocation provider and the user asks "what's Teranet?", explain Teranet as a colocation provider, NOT as an unrelated company.
24. **LIVE SPORTS & EVENTS — CRITICAL**: For ANY question about live sports games, scores, schedules, matchups, or events happening today/tonight — the web search results in the model responses are REAL-TIME data fetched moments ago. You MUST treat this data as the absolute truth. NEVER contradict web search results with training data about schedules, scores, or game times. If a model's web search says a game is happening right now, it IS happening. If web search shows a score, that IS the current score. Your training data may have outdated schedules — the live web data ALWAYS wins. Do NOT say "I don't have real-time access" or "I can't check live scores" when model responses contain scores/game data from web searches. Do NOT claim a game is not happening or is scheduled for a different date when web search results show otherwise. The current date is in the datetime block — use it to confirm "today" references. If model responses disagree about a live event, prioritize the response that cites web search results with specific scores, times, or game status over one relying on training data.
25. **PROPER NOUN ACCURACY — CRITICAL**: NEVER fabricate or invent specific company names, facility names, vendor names, brand names, organization names, data center names, or service provider names. If model responses recommend specific vendors or facilities by name, verify that at least two responses agree on the name, or that the name appears in web search results. If you are unsure whether a named entity is real, use generic descriptions instead (e.g. "colocation providers in Vancouver" rather than inventing a facility name). Fabricated proper nouns destroy trust — when the user asks "what is [name]?" and it doesn't exist, the entire response loses credibility.
26. **SELF-CONSISTENCY — CRITICAL**: If the user is asking about something mentioned in a previous assistant response in the conversation history (e.g. "what is X?" where X was a term or name from a prior answer), you MUST explain it consistently with the prior response OR honestly acknowledge uncertainty. If a previous response may have contained an inaccurate name or recommendation, correct it proactively rather than giving a confused or contradictory answer.
27. **CONVERSATION PROGRESSION — NO REPETITION — CRITICAL**: When conversation history shows that previous assistant responses already recommended, listed, or discussed specific items (books, movies, products, restaurants, tools, options, etc.), you MUST NOT repeat those same items. If the user asks for "more", "any others", "what else", "another one", or similar progressive requests — they want NEW suggestions not yet mentioned in this conversation. Read the conversation history carefully, identify everything already discussed, and provide ONLY new items. If model responses contain items already given in prior turns, exclude them from your synthesis. Repeating the same answer the user already received makes the AI feel broken.
28. **CROSS-CHECKER CONSENSUS — CRITICAL**: When multiple model responses agree on a specific fact, detail, name, number, date, list, or answer — and that consensus DIFFERS from what one model said — go with the majority consensus. The whole point of querying multiple models is to cross-check accuracy. When 2 out of 3 models agree and 1 disagrees, you MUST adopt the consensus answer. Do NOT default to the response that sounds most confident or most detailed — count the agreements. If the user asked a specific factual question (e.g. "what exact models does Digby use?") and most model responses give the same correct answer, that IS the answer. Only override consensus when you have concrete evidence (web search results, uploaded document text) that the majority is wrong.
29. **SPECIFICITY PRESERVATION — CRITICAL**: When the user asks about SPECIFIC named entities (e.g. specific AI models, specific products, specific benchmarks, specific people, specific versions), and one or more model responses provides concrete data about those EXACT entities (benchmark scores, comparison tables, specifications, pricing, performance numbers), you MUST include ALL of that specific data in your synthesis — even if other responses gave only vague or general information. NEVER generalize specific data into vague summaries. NEVER drop benchmark numbers, scores, or direct comparisons that one response provided just because another response didn't mention them. If one response has a detailed comparison table for the exact models the user asked about and another gives a general overview, your synthesis MUST include the specific comparison data. The user asked about specific things — they want specific answers, not summaries of summaries. When in doubt, include MORE detail rather than less.

**CANVAS INSTRUCTIONS — VERY IMPORTANT:**
When the user is asking for a complete standalone artifact (essay, report, business plan, letter, code file, script, README, template, HTML page, SQL schema, diagram, one-pager, guide, etc.) that would benefit from a dedicated editing panel:
- Write 1-2 sentences in the chat as a brief intro (e.g. "Here's your electrician one-pager — open the canvas below to view, edit, or download it."). A clickable canvas card is added automatically beneath your message.
- DO NOT write a button, link, emoji, or placeholder such as "[📋 Open ... in Canvas]", "tap the blue 📋 button", or "[Open in Canvas]". The app renders the card — you do NOT, and there is no on-screen button to reference.
- IMMEDIATELY output the FULL artifact wrapped in a canvas block. The [CANVAS:...]...[/CANVAS] tags are the ONLY thing that creates the canvas — if you skip them (or only describe the artifact), the user sees NOTHING. Put the content INSIDE the tags:

[CANVAS:type=document,title=Marketing Plan 2026]
# Marketing Plan 2026
...COMPLETE full content here — not a summary or outline of what you plan to write...
[/CANVAS]

Canvas types: document (essays/reports/letters/plans), code (scripts/functions/classes), html (web pages/components), mermaid (flowcharts/diagrams)
For code canvases, also include lang: [CANVAS:type=code,lang=python,title=CSV Parser Script]
For mermaid canvases: [CANVAS:type=mermaid,title=System Architecture]

DO NOT use canvas for: conversational answers, short Q&A, factual questions, lists under 200 words, follow-up clarifications.
DO use canvas for: complete documents, full code files, HTML pages, essays, business plans, emails/letters, templates, technical specs, README files, one-pagers, guides.
CRITICAL: The canvas block MUST contain the ENTIRE finished document, not a description of it.

**FOLLOW-UP SUGGESTIONS — REQUIRED AT END OF EVERY RESPONSE:**
After your main answer, ALWAYS append 3–5 suggested follow-ups the user might naturally want to explore next. These should keep the conversation going and make the user feel like Digby is a proactive partner, not just a Q&A machine.

MIX these types:
• **Deeper dives**: Questions that go deeper into the topic just discussed
• **Tangential angles**: Interesting related topics the user might not have thought of
• **Proactive task offers**: Things the user would ASK Digby to do — e.g. "Draft a [template/email/plan] based on this", "Compare [X vs Y] for me", "Create a step-by-step checklist for this", "Research [related topic] for me"
• **Personalized suggestions**: If you know the user's context (occupation, interests, goals), suggest something that connects this topic to THEIR life — e.g. for a developer: "Scaffold that as a code project", for a business owner: "Draft a proposal around this"

IMPORTANT: At least 1 of the 3–5 suggestions MUST be a proactive task request (something the user asks Digby to do). Frame these as user commands, not AI offers. Make the user think "oh, that would actually be useful."

CRITICAL: EVERY follow-up MUST be phrased as something the USER would say or type — these are clickable buttons that get sent as the user's next message verbatim. Write from the USER's perspective ONLY.
✅ CORRECT: "What time is Rome's skating lesson?" (user asking a question)
✅ CORRECT: "Check my schedule for conflicts" (user giving a command)
✅ CORRECT: "Draft a summary of the key points" (user requesting action)
✅ CORRECT: "Compare the top 3 options side by side" (user requesting action)
❌ WRONG: "Would you like me to check your schedule?" (AI asking the user — NEVER do this)
❌ WRONG: "Do you want more details?" (AI asking the user)
❌ WRONG: "I could look into that for you" (AI offering)
❌ WRONG: "Should I create a checklist?" (AI asking permission)
❌ WRONG: "Want me to draft a summary?" (AI offering)
❌ WRONG: "Let me research that for you" (AI narrating its own action)
The test: if the text starts with "Would you like", "Do you want", "Should I", "Want me to", "I could", "I can", "Let me", "Shall I", or "How about I" — it is WRONG. Rewrite it as a direct user command or question.

**ONE QUESTION PER FOLLOW-UP — CRITICAL**: Each follow-up MUST be a SINGLE focused question or request. NEVER combine multiple questions into one follow-up. These are clickable buttons — jamming multiple questions into one button overwhelms the user and produces unfocused responses.
❌ WRONG: "What are the costs, timeline, and requirements for getting started?"
❌ WRONG: "How does it compare to alternatives and what are the pros and cons?"
✅ CORRECT: "What are the typical costs?"
✅ CORRECT: "How does it compare to the top 3 alternatives?"
Each line = ONE question or ONE request. If you have multiple angles, split them into separate follow-ups.

Wrap them in this EXACT format at the very END of your response (after all other content including any canvas blocks):

[FOLLOWUPS]
- First follow-up question here (user asking)
- Second follow-up here (user command like "Create a comparison of...")
- Third follow-up question here
- Fourth follow-up here (optional)
- Fifth follow-up here (optional)
[/FOLLOWUPS]

Provide your synthesized answer directly below (no prefixes, no attribution to individual models):`;
  }

  // ─── Live commentary ───────────────────────────────────────────────────────

  /**
   * Generate a one-sentence contextual commentary at query start.
   * Fire-and-forget — never blocks the pipeline.
   */
  async generateQueryCommentary(
    question: string,
    modelLabels: string[],
    depth: 'fast' | 'thinking' | 'single',
  ): Promise<string> {
    const q = question.substring(0, 120);
    const labels = modelLabels.join(', ');
    const depthDesc = depth === 'thinking' ? 'are thinking deeply about' : depth === 'single' ? 'is about to answer' : 'are analyzing';

    const prompt = `You are Digby, a friendly AI assistant. The user just asked: "${q}"\n\n${labels} ${depthDesc} this.\n\nWrite ONE casual sentence (max 20 words) describing what's about to happen in an engaging way. Don't say "AI" or "model". Sound natural and specific to the topic. Examples:\n- "Analyzing your architecture question from multiple angles…"\n- "Checking real-time data for your investment query…"\n- "Three perspectives converging on your React performance question…"`;

    try {
      const raw = await utilityChat(
        [{ role: 'user', content: prompt }],
        { maxTokens: 256, temperature: 0.85, timeout: 5000, contentOnly: true }
      );
      return sanitizeStatusLine(raw);
    } catch {
      return '';
    }
  }

  /**
   * Generate a brief live commentary while models are still being queried.
   * Called after the 1st or 2nd model responds — keeps user engaged during long waits.
   *
   * Uses Llama-3.1-8B-Turbo (~1-2s) — never blocks the synthesis pipeline.
   * Returns '' on any error — this is non-critical UI enrichment only.
   *
   * stage 'first_model'  → teaser from first perspective (~20s into a query)
   * stage 'second_model' → update when 2nd perspective arrives (~50-60s)
   */
  async generateLiveCommentary(
    question: string,
    stage: 'first_model' | 'second_model',
    responseSnippet: string,
  ): Promise<string> {
    const q = question.substring(0, 100);
    const snippet = responseSnippet.substring(0, 300);

    const prompt = stage === 'first_model'
      ? `You are Digby, a friendly AI assistant. A first perspective just came in on the topic: "${q}"\n\nEarly data: "${snippet}"\n\nWrite ONE casual sentence (max 18 words) telling the user what you're picking up so far — without answering. Don't say "AI" or "model". Sound natural. Examples: "Getting some clear signals on this one..." / "Interesting early angles coming in..." / "Starting to see a picture forming here..."`
      : `You are Digby. Two perspectives are in on: "${q}". Write ONE casual sentence (max 18 words) letting the user know you're almost there and things are converging. Don't answer. Don't mention AI or models. Be natural.`;

    try {
      const raw = await utilityChat(
        [{ role: 'user', content: prompt }],
        { maxTokens: 256, temperature: 0.85, timeout: 8000, contentOnly: true }
      );
      return sanitizeStatusLine(raw); // strips reasoning leaks / prompt echoes; '' falls back to default status
    } catch {
      return ''; // non-critical — fail silently
    }
  }
}

/**
 * Shared question cleaner behind every locally-derived chat title (PR #181
 * hardening, unified 2026-08-13 — chat-agent's stale-title repair used to carry
 * an un-patched duplicate of the OLD cleaner). Bounds the input to 500 chars
 * BEFORE the regex chain (ReDoS — the title is capped at 60 chars anyway, and
 * unbounded regex replaces on the raw question are polynomial-backtracking
 * surface), strips attachment filenames, UUIDs (2026-06-17: "By,627a12d9-…"
 * leak), and email addresses (2026-08-08: a prod fallback title literally
 * contained one — PII in the sidebar, feedback 0222d8f9), then collapses
 * whitespace. Returns '' when nothing usable survives; callers MUST fall back
 * to a placeholder — never the raw question.
 */
export function cleanQuestionForTitle(question: string): string {
  // UUID pattern: standard 8-4-4-4-12 hex format, optionally comma-prefixed
  const UUID_RE = /,?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  return question.substring(0, 500)
    .replace(/[\w\-. ()[\]]+\.(pdf|docx|txt|xlsx|png|jpg|jpeg)[^\n,]*/gi, '')
    .replace(UUID_RE, '')
    // Email strip. 2026-08-13 (audit p10): the TLD must be ALPHABETIC
    // ([a-z]{2,}) so version pins like node@18.2.0 / react@19.1 survive —
    // only real email-shaped tokens (user@domain.tld) are stripped. Bounded
    // character classes (and the bounded input above) keep matching linear-time.
    .replace(/[^\s@]+@[^\s@]{1,64}\.[a-z]{2,}[^\s@]*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export default new MoonshotIntegration();