import prisma from '../../config/database';
import { hashPassword } from '../../utils/password';
import { AppError } from '../../middleware/error-handler';
import { CreateUserInput, UpdateUserInput, ListUsersQuery } from './users.validation';
// Phase 2 Cloud: the auto-created personal org (todo ea95fa0b leg 1 item 2)
// and the logger its failure path reports through.
import { ensurePersonalOrg } from '../crossmodel/org/org.service';
import logger from '../../utils/logger';

export class UsersService {
  /**
   * List users with pagination, search, and filtering
   */
  async listUsers(query: ListUsersQuery) {
    const { page = 1, limit = 10, search, role } = query;
    const skip = (page - 1) * limit;

    // Build where clause
    const where: any = {
      deletedAt: null, // Only show non-deleted users
    };

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (role) {
      where.role = role;
    }

    // Get users and total count
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take: limit,
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          createdAt: true,
          updatedAt: true,
          _count: {
            select: {
              aiChats: true,
              content: true,
              crmContacts: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.user.count({ where }),
    ]);

    return {
      users,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get single user by ID
   */
  async getUserById(id: string) {
    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
        updatedAt: true,
        deletedAt: true,
        _count: {
          select: {
            accounts: true,
            aiChats: true,
            content: true,
            kanbanBoards: true,
            crmContacts: true,
            activities: true,
          },
        },
      },
    });

    if (!user) {
      throw new AppError(404, 'User not found');
    }

    if (user.deletedAt) {
      throw new AppError(410, 'User has been deleted');
    }

    return user;
  }

  /**
   * Create new user
   */
  async createUser(data: CreateUserInput) {
    // Check if email already exists
    const existingUser = await prisma.user.findUnique({
      where: { email: data.email },
    });

    if (existingUser) {
      throw new AppError(400, 'Email already in use');
    }

    // Hash password
    const hashedPassword = await hashPassword(data.password);

    // Create user and account
    const user = await prisma.user.create({
      data: {
        email: data.email,
        name: data.name,
        password: hashedPassword,
        role: data.role || 'USER',
        accounts: {
          create: {
            type: 'credentials',
            provider: 'credentials',
          },
        },
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // Personal org (Phase 2 Cloud): every user-creation path satisfies the
    // one-default-org invariant. Non-fatal — the send guard self-heals lazily
    // (org.service.ts ensurePersonalOrgForUser).
    try {
      await ensurePersonalOrg(user.id, user.email, user.name);
    } catch (err: any) {
      logger.warn(`createUser: personal org creation failed for ${user.id} (send path will self-heal): ${err?.message ?? err}`);
    }

    return user;
  }

  /**
   * Update user
   */
  async updateUser(id: string, data: UpdateUserInput) {
    // Check if user exists
    const existingUser = await prisma.user.findUnique({
      where: { id },
    });

    if (!existingUser) {
      throw new AppError(404, 'User not found');
    }

    if (existingUser.deletedAt) {
      throw new AppError(400, 'Cannot update deleted user');
    }

    // Check if email is being changed and is available
    if (data.email && data.email !== existingUser.email) {
      const emailTaken = await prisma.user.findUnique({
        where: { email: data.email },
      });

      if (emailTaken) {
        throw new AppError(400, 'Email already in use');
      }
    }

    // Update user
    const user = await prisma.user.update({
      where: { id },
      data: {
        ...(data.name && { name: data.name }),
        ...(data.email && { email: data.email }),
        ...(data.role && { role: data.role }),
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return user;
  }

  /**
   * Soft delete user
   */
  async deleteUser(id: string) {
    // Check if user exists
    const user = await prisma.user.findUnique({
      where: { id },
    });

    if (!user) {
      throw new AppError(404, 'User not found');
    }

    if (user.deletedAt) {
      throw new AppError(400, 'User already deleted');
    }

    // Soft delete (set deletedAt timestamp)
    await prisma.user.update({
      where: { id },
      data: {
        deletedAt: new Date(),
      },
    });

    return { message: 'User deleted successfully' };
  }

  /**
   * Change user role
   */
  async changeUserRole(id: string, role: 'ADMIN' | 'USER') {
    // Check if user exists
    const user = await prisma.user.findUnique({
      where: { id },
    });

    if (!user) {
      throw new AppError(404, 'User not found');
    }

    if (user.deletedAt) {
      throw new AppError(400, 'Cannot change role of deleted user');
    }

    // Update role
    const updatedUser = await prisma.user.update({
      where: { id },
      data: { role },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return updatedUser;
  }
}

export default new UsersService();
