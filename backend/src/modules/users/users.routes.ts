import { Router } from 'express';
import { auth } from '../../middleware/auth';
import {
  listUsers,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
  changeUserRole,
} from './users.controller';

const router = Router();

// Middleware to check if user is admin
const adminOnly = (req: any, res: any, next: any) => {
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({
      error: 'Access denied. Admin privileges required.',
    });
  }
  next();
};

// Routes — ALL admin-only (this is the admin user-management module; a normal
// user edits their OWN profile via /crossmodel profile endpoints, never here).
// PUT /:id accepts `role` + `email`, so leaving it non-admin was a privilege-
// escalation + account-takeover hole (2026-07-21 pre-launch audit). Every read
// also exposes all users' PII, so list/get are admin-only too.
router.get('/', auth, adminOnly, listUsers);
router.get('/:id', auth, adminOnly, getUserById);
router.post('/', auth, adminOnly, createUser);
router.put('/:id', auth, adminOnly, updateUser);
router.delete('/:id', auth, adminOnly, deleteUser);
router.patch('/:id/role', auth, adminOnly, changeUserRole);

export default router;
