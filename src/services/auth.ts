/**
 * Authentication Service
 *
 * Handles JWT token generation and verification.
 * Manages refresh token lifecycle with rotation and reuse detection.
 */

import { PrismaClient } from '@prisma/client';
import { FastifyInstance } from 'fastify';
import * as crypto from 'crypto';

/**
 * Token pair
 */
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

/**
 * Generate access and refresh tokens
 *
 * @param fastify - Fastify instance with JWT plugin
 * @param prisma - Prisma client
 * @param userId - User ID
 * @returns Token pair
 */
export async function generateTokenPair(
  fastify: FastifyInstance,
  prisma: PrismaClient,
  userId: string
): Promise<TokenPair> {
  // Generate access token (JWT)
  const accessToken = fastify.jwt.sign({ userId });

  // Generate refresh token (cryptographically random)
  const refreshTokenId = crypto.randomBytes(32).toString('hex');

  // Store refresh token in database (expires in 30 days)
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await prisma.refreshToken.create({
    data: {
      userId,
      token: refreshTokenId,
      expiresAt,
    },
  });

  // Clean up old refresh tokens for this user (keep only last 5)
  const oldTokens = await prisma.refreshToken.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    skip: 5,
    select: { id: true },
  });

  if (oldTokens.length > 0) {
    await prisma.refreshToken.deleteMany({
      where: {
        id: { in: oldTokens.map(t => t.id) },
      },
    });
  }

  return {
    accessToken,
    refreshToken: refreshTokenId,
  };
}

/**
 * Verify refresh token and return user ID with rotation support
 *
 * @param prisma - Prisma client
 * @param token - Refresh token
 * @param fastify - Fastify instance for JWT generation
 * @returns Token pair with rotated tokens
 * @throws Error if token is invalid or reuse detected
 */
export async function verifyRefreshToken(
  prisma: PrismaClient,
  token: string,
  fastify: FastifyInstance
): Promise<TokenPair> {
  const refreshToken = await prisma.refreshToken.findUnique({
    where: { token },
  });

  if (!refreshToken) {
    throw new Error('Invalid refresh token');
  }

  if (refreshToken.expiresAt < new Date()) {
    await prisma.refreshToken.delete({ where: { token } });
    throw new Error('Refresh token expired');
  }

  // Detect token reuse - if token was already revoked, this is suspicious
  if (refreshToken.revokedAt) {
    // Token reuse detected - invalidate all tokens for this user as a security measure
    await prisma.refreshToken.deleteMany({
      where: { userId: refreshToken.userId },
    });
    throw new Error('Token reuse detected - all tokens invalidated');
  }

  // Rotate: delete old token, issue new one
  await prisma.refreshToken.delete({ where: { id: refreshToken.id } });

  return generateTokenPair(fastify, prisma, refreshToken.userId);
}

/**
 * Revoke a refresh token (for logout)
 *
 * @param prisma - Prisma client
 * @param token - Refresh token to revoke
 */
export async function revokeRefreshToken(
  prisma: PrismaClient,
  token: string
): Promise<void> {
  await prisma.refreshToken.deleteMany({
    where: { token },
  });
}

/**
 * Clean up expired refresh tokens
 *
 * Called periodically to remove expired tokens
 */
export async function cleanupExpiredTokens(prisma: PrismaClient): Promise<void> {
  await prisma.refreshToken.deleteMany({
    where: {
      expiresAt: {
        lt: new Date(),
      },
    },
  });
}
