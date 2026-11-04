import { Request, Response, NextFunction } from 'express';
import aiChatService from './ai-chat.service';
import {
  createChatSchema,
  addMessageSchema,
  updateChatSchema,
  listChatsQuerySchema,
  chatIdSchema,
} from './ai-chat.validation';

/**
 * @swagger
 * /api/ai-chats:
 *   get:
 *     summary: List user's AI chats
 *     tags: [AI Chat]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *         description: Items per page
 *     responses:
 *       200:
 *         description: List of chats
 */
export const listChats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.userId;
    const query = listChatsQuerySchema.parse(req.query);
    const result = await aiChatService.listChats(userId, query);
    
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @swagger
 * /api/ai-chats/{id}:
 *   get:
 *     summary: Get chat by ID with messages
 *     tags: [AI Chat]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Chat ID
 *     responses:
 *       200:
 *         description: Chat details with messages
 *       404:
 *         description: Chat not found
 */
export const getChatById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.userId;
    const { id } = chatIdSchema.parse(req.params);
    const chat = await aiChatService.getChatById(id, userId);
    
    res.json({
      success: true,
      data: chat,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @swagger
 * /api/ai-chats:
 *   post:
 *     summary: Create new chat
 *     tags: [AI Chat]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - title
 *             properties:
 *               title:
 *                 type: string
 *     responses:
 *       201:
 *         description: Chat created successfully
 */
export const createChat = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.userId;
    const data = createChatSchema.parse(req.body);
    const chat = await aiChatService.createChat(userId, data);
    
    res.status(201).json({
      success: true,
      data: chat,
      message: 'Chat created successfully',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @swagger
 * /api/ai-chats/{id}/messages:
 *   post:
 *     summary: Add message to chat and get AI response
 *     tags: [AI Chat]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Chat ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - content
 *             properties:
 *               content:
 *                 type: string
 *     responses:
 *       200:
 *         description: Message added and AI responded
 */
export const addMessage = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.userId;
    const { id } = chatIdSchema.parse(req.params);
    const data = addMessageSchema.parse(req.body);
    const chat = await aiChatService.addMessage(id, userId, data);
    
    res.json({
      success: true,
      data: chat,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @swagger
 * /api/ai-chats/{id}:
 *   put:
 *     summary: Update chat title
 *     tags: [AI Chat]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Chat ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - title
 *             properties:
 *               title:
 *                 type: string
 *     responses:
 *       200:
 *         description: Chat updated successfully
 */
export const updateChat = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.userId;
    const { id } = chatIdSchema.parse(req.params);
    const data = updateChatSchema.parse(req.body);
    const chat = await aiChatService.updateChat(id, userId, data);
    
    res.json({
      success: true,
      data: chat,
      message: 'Chat updated successfully',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @swagger
 * /api/ai-chats/{id}:
 *   delete:
 *     summary: Delete chat
 *     tags: [AI Chat]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Chat ID
 *     responses:
 *       200:
 *         description: Chat deleted successfully
 */
export const deleteChat = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.userId;
    const { id } = chatIdSchema.parse(req.params);
    const result = await aiChatService.deleteChat(id, userId);
    
    res.json({
      success: true,
      message: result.message,
    });
  } catch (error) {
    next(error);
  }
};