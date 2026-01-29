/**
 * Authentication Routes
 *
 * Implements GitHub OAuth Device Flow:
 * - POST /device/start - Initiate device flow
 * - POST /device/complete - Poll for authorization completion
 * - POST /refresh - Refresh access token with rotation
 * - POST /logout - Revoke refresh token
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../index';
import { generateTokenPair, verifyRefreshToken, revokeRefreshToken } from '../services/auth';
import { getInitialRole } from '../services/authz';

/**
 * Device flow start response
 */
interface DeviceFlowStartResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

/**
 * Token response
 */
interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user?: {
    id: string;
    login: string;
    name?: string;
    email?: string;
  };
}

// Validation schemas
const deviceStartSchema = z.object({
  client_id: z.string().optional(),
});

const deviceCompleteSchema = z.object({
  device_code: z.string(),
});

const refreshSchema = z.object({
  refresh_token: z.string(),
});

/**
 * Register authentication routes
 */
export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /auth/device/start
   *
   * Start GitHub OAuth Device Flow
   */
  fastify.post('/device/start', async (request, reply) => {
    // In a real implementation, this would call GitHub's device flow API
    // For development/MVP, we'll use a simplified flow

    const clientId = process.env.GITHUB_CLIENT_ID;
    if (!clientId) {
      return reply.status(500).send({ error: 'GitHub client not configured' });
    }

    // Start GitHub device flow
    const githubResponse = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Moji-Proctor-Server',
      },
      body: JSON.stringify({
        client_id: clientId,
        scope: 'read:user user:email',
      }),
    });

    if (!githubResponse.ok) {
      const error = await githubResponse.text();
      fastify.log.error({ status: githubResponse.status, error, clientId }, 'GitHub device flow start failed');
      return reply.status(500).send({ error: `GitHub API error: ${githubResponse.status}` });
    }

    const githubData = await githubResponse.json();

    const response: DeviceFlowStartResponse = {
      device_code: githubData.device_code,
      user_code: githubData.user_code,
      verification_uri: githubData.verification_uri,
      verification_uri_complete: githubData.verification_uri_complete,
      expires_in: githubData.expires_in,
      interval: githubData.interval,
    };

    // Store device code with expiration
    // In production, use Redis for this
    return reply.send(response);
  });

  /**
   * POST /auth/device/complete
   *
   * Poll for authorization completion
   */
  fastify.post('/device/complete', async (request, reply) => {
    const { device_code } = deviceCompleteSchema.parse(request.body);

    const clientId = process.env.GITHUB_CLIENT_ID;
    const clientSecret = process.env.GITHUB_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return reply.status(500).send({ error: 'GitHub client not configured' });
    }

    // Poll GitHub for authorization
    const githubResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Moji-Proctor-Server',
      },
      body: JSON.stringify({
        client_id: clientId,
        device_code: device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });

    const githubData = await githubResponse.json();

    // Handle pending/slow_down
    if (githubData.error === 'authorization_pending') {
      return reply.status(202).send({ error: 'authorization_pending' });
    }

    if (githubData.error === 'slow_down') {
      return reply.status(202).send({ error: 'slow_down' });
    }

    if (githubData.error) {
      return reply.status(400).send({ error: githubData.error });
    }

    // Success - get user info and create/update user
    const userResponse = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${githubData.access_token}`,
        'User-Agent': 'Moji-Proctor-Server',
      },
    });

    const githubUser = await userResponse.json();

    // Determine role from allowlist for new users
    const initialRole = getInitialRole(githubUser.login, String(githubUser.id));

    // Create or update user in database
    const user = await prisma.user.upsert({
      where: { githubId: String(githubUser.id) },
      update: {
        githubLogin: githubUser.login,
        githubName: githubUser.name,
        githubEmail: githubUser.email,
        // Update role if user is now in allowlist (for existing users)
        role: initialRole,
      },
      create: {
        githubId: String(githubUser.id),
        githubLogin: githubUser.login,
        githubName: githubUser.name,
        githubEmail: githubUser.email,
        role: initialRole,
      },
    });

    // Generate JWT tokens
    const tokens = await generateTokenPair(fastify, prisma, user.id);

    const response: TokenResponse = {
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expires_in: 15 * 60, // 15 minutes
      user: {
        id: user.id,
        login: user.githubLogin,
        name: user.githubName ?? undefined,
        email: user.githubEmail ?? undefined,
      },
    };

    return reply.send(response);
  });

  /**
   * POST /auth/refresh
   *
   * Refresh access token using refresh token with rotation
   */
  fastify.post('/refresh', async (request, reply) => {
    const { refresh_token: refreshToken } = refreshSchema.parse(request.body);

    try {
      // Verify and rotate tokens
      const tokens = await verifyRefreshToken(prisma, refreshToken, fastify);

      const response: TokenResponse = {
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expires_in: 15 * 60,
      };

      return reply.send(response);
    } catch (error) {
      fastify.log.error({ error }, 'Token refresh failed');
      return reply.status(401).send({ error: 'Invalid refresh token' });
    }
  });

  /**
   * POST /auth/logout
   *
   * Revoke refresh token
   */
  fastify.post('/logout', async (request, reply) => {
    const { refresh_token: refreshToken } = refreshSchema.parse(request.body);

    try {
      await revokeRefreshToken(prisma, refreshToken);
      return reply.send({ success: true });
    } catch (error) {
      fastify.log.error({ error }, 'Logout failed');
      // Always return success to avoid leaking information
      return reply.send({ success: true });
    }
  });
}
