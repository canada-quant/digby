import { Router } from 'express';
import { auth } from '../../middleware/auth';
import {
  getOverview,
  getUserGrowth,
  getActivityOverview,
  getFeatureUsage,
  getEvents,
  trackEvent,
} from './analytics.controller';

const router = Router();

// All analytics routes require authentication
router.get('/overview', auth, getOverview);
router.get('/user-growth', auth, getUserGrowth);
router.get('/activity', auth, getActivityOverview);
router.get('/feature-usage', auth, getFeatureUsage);
router.get('/events', auth, getEvents);
router.post('/track', auth, trackEvent);

export default router;
