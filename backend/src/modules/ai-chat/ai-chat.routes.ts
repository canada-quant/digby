import { Router } from 'express';
import { auth } from '../../middleware/auth';
import {
  listChats,
  getChatById,
  createChat,
  addMessage,
  updateChat,
  deleteChat,
} from './ai-chat.controller';

const router = Router();

// All AI chat routes require authentication
router.get('/', auth, listChats);
router.get('/:id', auth, getChatById);
router.post('/', auth, createChat);
router.post('/:id/messages', auth, addMessage);
router.put('/:id', auth, updateChat);
router.delete('/:id', auth, deleteChat);

export default router;
