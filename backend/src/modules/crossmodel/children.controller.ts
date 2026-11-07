/**
 * Digby Kids — parent-facing management of child sub-accounts.
 *
 * A child is a full User row (own login) flagged isChild with parentId = the
 * parent. The parent creates/edits/removes children here. A 4-6 digit parent PIN
 * (hashed, stored on the parent row) gates every mutation and is also used by the
 * kid UI to authorize leaving the child session. These endpoints sit behind
 * `authenticate` + `rejectChild` (a child can never manage children); the single
 * exception is verify-parent-pin, which a child session may call to unlock logout.
 */
import { Response } from 'express';
import { AuthRequest } from '../../middleware/auth';
import prisma from '../../config/database';
import { hashPassword, comparePassword } from '../../utils/password';
import logger from '../../utils/logger';
// Phase 2 Cloud: the auto-created personal org (todo ea95fa0b leg 1 item 2).
import { ensurePersonalOrg } from './org/org.service';

const PIN_RE = /^\d{4,6}$/;

/** Validate a PIN against a parent's stored hash. Module-level so it never
 * depends on `this` binding (route handlers are passed unbound). */
async function verifyPinForParent(
  parentId: string,
  pin?: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (!pin || !PIN_RE.test(pin)) return { ok: false, status: 400, error: 'A 4–6 digit parent PIN is required.' };
  if (!parentId) return { ok: false, status: 400, error: 'No parent account associated.' };
  const parent = await prisma.user.findUnique({ where: { id: parentId }, select: { parentPinHash: true } });
  if (!parent?.parentPinHash) return { ok: false, status: 400, error: 'No parent PIN has been set yet.' };
  const ok = await comparePassword(pin, parent.parentPinHash);
  if (!ok) return { ok: false, status: 403, error: 'Incorrect parent PIN.' };
  return { ok: true };
}

function childView(u: any) {
  return {
    id: u.id,
    name: u.name || u.firstName || 'Child',
    email: u.email,
    age: u.childAge ?? null,
    guardrails: u.childGuardrails ?? '',
    createdAt: u.createdAt,
  };
}

export class ChildrenController {
  /** GET /api/crossmodel/children — list this parent's child accounts. */
  async list(req: AuthRequest, res: Response) {
    const parentId = req.user!.id;
    const children = await prisma.user.findMany({
      where: { parentId, isChild: true, deletedAt: null },
      select: { id: true, name: true, firstName: true, email: true, childAge: true, childGuardrails: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    const parent = await prisma.user.findUnique({ where: { id: parentId }, select: { parentPinHash: true } });
    res.json({ success: true, data: { children: children.map(childView), pinSet: Boolean(parent?.parentPinHash) } });
  }

  /**
   * POST /api/crossmodel/children — create a child account.
   * Body: { name, email, password, age, guardrails?, parentPin }
   * First child sets the parent PIN; afterwards the existing PIN must be supplied.
   */
  async create(req: AuthRequest, res: Response) {
    const parentId = req.user!.id;
    const { name, email, password, age, guardrails, parentPin } = req.body as {
      name?: string; email?: string; password?: string; age?: number; guardrails?: string; parentPin?: string;
    };

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email, and password are required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }
    if (typeof age !== 'number' || age < 2 || age > 17) {
      return res.status(400).json({ error: 'Please enter the child\'s age (2–17).' });
    }
    if (!parentPin || !PIN_RE.test(parentPin)) {
      return res.status(400).json({ error: 'A 4–6 digit parent PIN is required.' });
    }

    const parent = await prisma.user.findUnique({ where: { id: parentId }, select: { parentPinHash: true } });
    if (parent?.parentPinHash) {
      const ok = await comparePassword(parentPin, parent.parentPinHash);
      if (!ok) return res.status(403).json({ error: 'Incorrect parent PIN.' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const existing = await prisma.user.findFirst({ where: { email: { equals: normalizedEmail, mode: 'insensitive' } } });
    if (existing) return res.status(400).json({ error: 'That login email is already taken.' });

    const hashedPassword = await hashPassword(password);

    // Set the parent PIN on first child creation.
    if (!parent?.parentPinHash) {
      const pinHash = await hashPassword(parentPin);
      await prisma.user.update({ where: { id: parentId }, data: { parentPinHash: pinHash } });
    }

    const child = await prisma.user.create({
      data: {
        email: normalizedEmail,
        password: hashedPassword,
        name: name.trim(),
        isChild: true,
        parentId,
        childAge: age,
        childGuardrails: (guardrails || '').trim() || null,
        accounts: { create: { type: 'local', provider: 'email' } },
      },
      select: { id: true, name: true, firstName: true, email: true, childAge: true, childGuardrails: true, createdAt: true },
    });
    logger.info(`Digby Kids: parent ${parentId} created child ${child.id} (age ${age})`);
    // Personal org for the child account too (Phase 2 Cloud): a child is a full
    // User row with its own login, so it must satisfy the same invariant as any
    // other account. Non-fatal — the send guard self-heals lazily.
    try {
      await ensurePersonalOrg(child.id, child.email, child.firstName);
    } catch (err: any) {
      logger.warn(`children: personal org creation failed for ${child.id} (send path will self-heal): ${err?.message ?? err}`);
    }
    res.status(201).json({ success: true, data: childView(child) });
  }

  /**
   * PATCH /api/crossmodel/children/:id — update age / guardrails / password.
   * Requires the parent PIN.
   */
  async update(req: AuthRequest, res: Response) {
    const parentId = req.user!.id;
    const childId = req.params.id;
    const { age, guardrails, password, parentPin } = req.body as {
      age?: number; guardrails?: string; password?: string; parentPin?: string;
    };

    const verified = await verifyPinForParent(parentId, parentPin);
    if (!verified.ok) return res.status(verified.status).json({ error: verified.error });

    const child = await prisma.user.findFirst({ where: { id: childId, parentId, isChild: true, deletedAt: null } });
    if (!child) return res.status(404).json({ error: 'Child account not found.' });

    const data: any = {};
    if (typeof age === 'number') {
      if (age < 2 || age > 17) return res.status(400).json({ error: 'Age must be 2–17.' });
      data.childAge = age;
    }
    if (typeof guardrails === 'string') data.childGuardrails = guardrails.trim() || null;
    if (password) {
      if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
      data.password = await hashPassword(password);
    }

    const updated = await prisma.user.update({
      where: { id: childId },
      data,
      select: { id: true, name: true, firstName: true, email: true, childAge: true, childGuardrails: true, createdAt: true },
    });
    res.json({ success: true, data: childView(updated) });
  }

  /** DELETE /api/crossmodel/children/:id — disable a child account (requires PIN). */
  async remove(req: AuthRequest, res: Response) {
    const parentId = req.user!.id;
    const childId = req.params.id;
    const parentPin = (req.body?.parentPin || req.query?.parentPin) as string | undefined;

    const verified = await verifyPinForParent(parentId, parentPin);
    if (!verified.ok) return res.status(verified.status).json({ error: verified.error });

    const child = await prisma.user.findFirst({ where: { id: childId, parentId, isChild: true, deletedAt: null } });
    if (!child) return res.status(404).json({ error: 'Child account not found.' });

    await prisma.user.update({ where: { id: childId }, data: { isActive: false, deletedAt: new Date() } });
    // Invalidate any active sessions for the removed child.
    await prisma.refreshToken.deleteMany({ where: { userId: childId } });
    logger.info(`Digby Kids: parent ${parentId} removed child ${childId}`);
    res.json({ success: true });
  }

  /**
   * POST /api/crossmodel/children/verify-parent-pin — { pin } → { valid }.
   * Callable by BOTH a parent token (checks own PIN) and a CHILD token (checks the
   * owning parent's PIN), so the kid UI can gate "leave kid mode / log out".
   */
  async verifyParentPin(req: AuthRequest, res: Response) {
    const { pin } = req.body as { pin?: string };
    const ownerId = req.user!.isChild ? (req.user!.parentId || '') : req.user!.id;
    const result = await verifyPinForParent(ownerId, pin);
    res.json({ success: true, data: { valid: result.ok } });
  }
}

export default new ChildrenController();
