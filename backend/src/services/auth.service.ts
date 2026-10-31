import { randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { AppError } from '../errors/app-error.js';
import { createSessionToken } from '../auth/session-token.js';

const PASSWORD_HASH_ROUNDS = 12;
const publicUserSelect = {
  id: true,
  name: true,
  email: true,
  createdAt: true,
  updatedAt: true,
} as const;

const dummyPasswordHash = bcrypt.hash(randomBytes(32).toString('hex'), PASSWORD_HASH_ROUNDS);

export type PublicUser = {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
  updatedAt: Date;
};

export const authService = {
  async register(name: string, email: string, password: string): Promise<{ user: PublicUser; token: string }> {
    const existingUser = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existingUser) {
      throw new AppError('Could not create an account with those details.', 409, 'ACCOUNT_CONFLICT');
    }

    const passwordHash = await bcrypt.hash(password, PASSWORD_HASH_ROUNDS);
    try {
      const user = await prisma.user.create({
        data: { name, email, passwordHash },
        select: publicUserSelect,
      });
      return { user, token: createSessionToken(user.id) };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppError('Could not create an account with those details.', 409, 'ACCOUNT_CONFLICT');
      }
      throw error;
    }
  },

  async login(email: string, password: string): Promise<{ user: PublicUser; token: string }> {
    const user = await prisma.user.findUnique({ where: { email } });
    const passwordHash = user?.passwordHash ?? await dummyPasswordHash;
    const passwordMatches = await bcrypt.compare(password, passwordHash);

    if (!user || !passwordMatches) {
      throw new AppError('Email or password is incorrect.', 401, 'INVALID_CREDENTIALS');
    }

    const { passwordHash: _passwordHash, ...safeUser } = user;
    return { user: safeUser, token: createSessionToken(user.id) };
  },

  async getCurrentUser(userId: string): Promise<PublicUser> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: publicUserSelect });
    if (!user) {
      throw new AppError('Authentication required.', 401, 'AUTH_REQUIRED');
    }
    return user;
  },
};
