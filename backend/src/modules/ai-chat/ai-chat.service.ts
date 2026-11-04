import prisma from '../../config/database';
import { AppError } from '../../middleware/error-handler';
import { CreateChatInput, AddMessageInput, UpdateChatInput, ListChatsQuery } from './ai-chat.validation';
import logger from '../../utils/logger';

/** How many prior turns ride into the Utility-seat call (oldest dropped first). */
export const AI_CHAT_HISTORY_MESSAGES = 12;
/** Per-message clip on the way to the model (the table stores the full text). */
export const AI_CHAT_MESSAGE_MAX_CHARS = 4_000;
/** The honest answer when no model can serve the turn — never a canned reply. */
export const AI_CHAT_UNAVAILABLE_NOTICE = 'The assistant is unavailable right now (no utility model answered). Your message was saved; try again in a moment.';
export const AI_CHAT_SYSTEM_PROMPT = 'You are Digby, answering inside the admin dashboard\'s single-model chat. Reply directly and concisely in plain prose or short Markdown; say plainly when you do not know something. No tools are available in this chat.';

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
}

export class AIChatService {
  /**
   * Generate the assistant reply on the Utility seat (utilityChat — the admin
   * "Utility" model role, DeepSeek → DashScope fallback chain). Until
   * 2026-09-28 this returned one of eight canned strings after a fake 500 ms
   * delay (a pre-CrossModel stub with a "TODO: OpenAI" marker) — an admin who
   * opened Dashboard → AI Chat got fabricated replies. The window is bounded
   * (the last AI_CHAT_HISTORY_MESSAGES turns) and every failure answers with
   * an honest one-line notice instead of throwing or inventing text.
   */
  private async generateAIResponse(messages: Message[]): Promise<string> {
    const window = messages
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-AI_CHAT_HISTORY_MESSAGES)
      .map((m) => ({ role: m.role, content: m.content.slice(0, AI_CHAT_MESSAGE_MAX_CHARS) }));
    if (!window.length) return AI_CHAT_UNAVAILABLE_NOTICE;
    try {
      const { utilityChat } = await import('../../utils/utility-llm');
      const reply = await utilityChat(
        [{ role: 'system', content: AI_CHAT_SYSTEM_PROMPT }, ...window],
        { maxTokens: 700, temperature: 0.4, timeout: 45_000, contentOnly: true },
      );
      const text = String(reply ?? '').trim();
      return text || AI_CHAT_UNAVAILABLE_NOTICE;
    } catch (err: any) {
      logger.warn(`ai-chat: utility reply failed: ${err?.message ?? err}`);
      return AI_CHAT_UNAVAILABLE_NOTICE;
    }
  }

  /**
   * List user's chats with pagination
   */
  async listChats(userId: string, query: ListChatsQuery) {
    const { page = 1, limit = 10 } = query;
    const skip = (page - 1) * limit;

    const [chats, total] = await Promise.all([
      prisma.aIChat.findMany({
        where: { userId },
        skip,
        take: limit,
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true,
          title: true,
          createdAt: true,
          updatedAt: true,
          messages: true,
        },
      }),
      prisma.aIChat.count({ where: { userId } }),
    ]);

    // Parse messages and get message count
    const chatsWithCount = chats.map(chat => {
      const messages = Array.isArray(chat.messages) ? chat.messages as unknown as Message[] : [];
      return {
        ...chat,
        messageCount: messages.length,
        lastMessage: messages.length > 0 ? messages[messages.length - 1].content.substring(0, 50) + '...' : null,
      };
    });

    return {
      chats: chatsWithCount,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get chat by ID with all messages
   */
  async getChatById(chatId: string, userId: string) {
    const chat = await prisma.aIChat.findUnique({
      where: { id: chatId },
      select: {
        id: true,
        title: true,
        messages: true,
        userId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!chat) {
      throw new AppError(404, 'Chat not found');
    }

    // Check ownership
    if (chat.userId !== userId) {
      throw new AppError(403, 'Unauthorized access to this chat');
    }

    return {
      ...chat,
      messages: Array.isArray(chat.messages) ? chat.messages as unknown as Message[] : [],
    };
  }

  /**
   * Create new chat
   */
  async createChat(userId: string, data: CreateChatInput) {
    const chat = await prisma.aIChat.create({
      data: {
        title: data.title,
        user: {
          connect: { id: userId }
        },
        messages: [],
      },
      select: {
        id: true,
        title: true,
        messages: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return {
      ...chat,
      messages: [],
    };
  }

  /**
   * Add message to chat and get AI response
   */
  async addMessage(chatId: string, userId: string, data: AddMessageInput) {
    // Get chat
    const chat = await this.getChatById(chatId, userId);

    // Create user message
    const userMessage: Message = {
      role: 'user',
      content: data.content,
      timestamp: new Date().toISOString(),
    };

    // Get AI response
    const messages = chat.messages;
    messages.push(userMessage);
    
    const aiResponse = await this.generateAIResponse(messages);

    // Create AI message
    const aiMessage: Message = {
      role: 'assistant',
      content: aiResponse,
      timestamp: new Date().toISOString(),
    };

    messages.push(aiMessage);

    // Update chat
    const updatedChat = await prisma.aIChat.update({
      where: { id: chatId },
      data: {
        messages: messages as any,
        updatedAt: new Date(),
      },
      select: {
        id: true,
        title: true,
        messages: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return {
      ...updatedChat,
      messages: Array.isArray(updatedChat.messages) ? updatedChat.messages as unknown as Message[] : [],
    };
  }

  /**
   * Update chat title
   */
  async updateChat(chatId: string, userId: string, data: UpdateChatInput) {
    // Check ownership
    await this.getChatById(chatId, userId);

    const chat = await prisma.aIChat.update({
      where: { id: chatId },
      data: { title: data.title },
      select: {
        id: true,
        title: true,
        messages: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return {
      ...chat,
      messages: Array.isArray(chat.messages) ? chat.messages as unknown as Message[] : [],
    };
  }

  /**
   * Delete chat
   */
  async deleteChat(chatId: string, userId: string) {
    // Check ownership
    await this.getChatById(chatId, userId);

    await prisma.aIChat.delete({
      where: { id: chatId },
    });

    return { message: 'Chat deleted successfully' };
  }
}

export default new AIChatService();