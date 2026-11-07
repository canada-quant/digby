import { Router } from 'express';
import authController from './auth.controller';
import { authenticate } from '../../middleware/auth';

const router = Router();

/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     summary: Register a new user
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *               firstName:
 *                 type: string
 *               lastName:
 *                 type: string
 */
router.post('/register', authController.register);

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Login user
 *     tags: [Auth]
 */
router.post('/login', authController.login);

/**
 * @swagger
 * /api/auth/refresh:
 *   post:
 *     summary: Refresh access token
 *     tags: [Auth]
 */
router.post('/refresh', authController.refresh);

/**
 * @swagger
 * /api/auth/logout:
 *   post:
 *     summary: Logout user
 *     tags: [Auth]
 */
router.post('/logout', authController.logout);

/**
 * @swagger
 * /api/auth/me:
 *   get:
 *     summary: Get current user
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 */
router.get('/me', authenticate, authController.me);

/**
 * @swagger
 * /api/auth/change-password:
 *   post:
 *     summary: Change the current user's password
 *     description: >
 *       Re-auths with the current password, stores the new one (same length
 *       rule as register), revokes every refresh token of the user (all
 *       devices) and cuts off every access token issued before the change.
 *       The caller gets a fresh token pair (cookies + accessToken in the
 *       body, like login), so the tab that changed it stays signed in. A
 *       wrong current password answers 400; child accounts answer 403.
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - currentPassword
 *               - newPassword
 *             properties:
 *               currentPassword:
 *                 type: string
 *               newPassword:
 *                 type: string
 */
router.post('/change-password', authenticate, authController.changePassword);

/**
 * @swagger
 * /api/auth/account:
 *   delete:
 *     summary: Permanently delete the current user's account
 *     description: >
 *       App Store 5.1.1(v) / Play Data-deletion compliance surface. Requires
 *       the account password in the body (re-auth — a stolen bearer token
 *       alone cannot delete the account). Hard-deletes the user row; every FK
 *       is Cascade, so chats, messages, runs, receipts, refresh tokens, push
 *       tokens, and memory go with it.
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 */
router.delete('/account', authenticate, authController.deleteAccount);

/**
 * @swagger
 * /api/auth/verify-email:
 *   post:
 *     summary: Consume an email-verification token
 *     description: >
 *       Public on purpose — the emailed link is opened in whatever browser the
 *       user reads mail in. The token is the credential (32 random bytes,
 *       stored only as sha256, single-use, 24 h). A repeat use of a burned
 *       token answers success when the account is already verified, and is
 *       refused when it is not.
 *     tags: [Auth]
 */
router.post('/verify-email', authController.verifyEmail);

/**
 * @swagger
 * /api/auth/resend-verification:
 *   post:
 *     summary: Re-send the verification link to the signed-in user
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 */
router.post('/resend-verification', authenticate, authController.resendVerification);

export default router;
