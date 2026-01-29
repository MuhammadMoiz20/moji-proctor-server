/**
 * Authorization Helpers
 *
 * Role-based access control for API endpoints.
 */

import { FastifyRequest } from 'fastify';
import { prisma } from '../index';

/**
 * User roles
 */
export type UserRole = 'student' | 'instructor';

/**
 * Check if user has instructor role
 *
 * @param userId - User ID to check
 * @returns True if user is an instructor
 */
export async function isInstructor(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });

  return user?.role === 'instructor';
}

/**
 * Get instructor allowlist from environment
 * Format: comma-separated GitHub logins or IDs
 *
 * @returns Array of instructor identifiers
 */
function getInstructorAllowlist(): string[] {
  const allowlist = process.env.INSTRUCTOR_ALLOWLIST || '';
  if (!allowlist.trim()) {
    return [];
  }
  return allowlist.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Check if GitHub login or ID is in instructor allowlist
 *
 * @param githubLogin - GitHub username
 * @param githubId - GitHub ID
 * @returns True if in allowlist
 */
export function isInstructorAllowlisted(githubLogin: string, githubId: string): boolean {
  const allowlist = getInstructorAllowlist();
  if (allowlist.length === 0) {
    return false;
  }

  // Check both login and ID
  return allowlist.includes(githubLogin) || allowlist.includes(githubId);
}

/**
 * Grant instructor role to user if in allowlist
 * Called during OAuth flow
 *
 * @param githubLogin - GitHub username
 * @param githubId - GitHub ID
 * @returns Role to assign
 */
export function getInitialRole(githubLogin: string, githubId: string): UserRole {
  return isInstructorAllowlisted(githubLogin, githubId) ? 'instructor' : 'student';
}

/**
 * Middleware to require instructor role
 *
 * @param request - Fastify request
 * @throws Error if not authorized
 */
export async function requireInstructor(request: FastifyRequest): Promise<void> {
  const payload = request.user as { userId: string };
  if (!payload?.userId) {
    throw new Error('Unauthorized');
  }

  const hasRole = await isInstructor(payload.userId);
  if (!hasRole) {
    throw new Error('Forbidden: instructor role required');
  }
}

/**
 * Get current user's role
 *
 * @param request - Fastify request
 * @returns User role
 */
export async function getUserRole(request: FastifyRequest): Promise<UserRole> {
  const payload = request.user as { userId: string };
  if (!payload?.userId) {
    return 'student';
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { role: true },
  });

  return (user?.role as UserRole) || 'student';
}
