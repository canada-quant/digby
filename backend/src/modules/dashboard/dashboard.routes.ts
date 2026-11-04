import { Router } from 'express';
import { auth } from '../../middleware/auth';
import { getStats, getRecentActivities } from './dashboard.controller';

const router = Router();

// All dashboard routes require authentication
router.get('/stats', auth, getStats);
router.get('/activities', auth, getRecentActivities);

export default router;
