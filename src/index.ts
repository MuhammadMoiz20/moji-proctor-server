/**
 * Moji Proctor Online Signals Server
 *
 * Fastify server for:
 * - GitHub OAuth Device Flow authentication
 * - Signal ingestion with Ed25519 signature verification
 * - Instructor dashboard API
 */

import 'dotenv/config';
import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { PrismaClient } from '@prisma/client';
import { authRoutes } from './routes/auth';
import { eventRoutes } from './routes/events';
import { instructorRoutes } from './routes/instructor';
import { healthRoutes } from './routes/health';

export const prisma = new PrismaClient();

/**
 * Validate required environment variables
 */
function validateEnv(): void {
  const required = ['DATABASE_URL', 'JWT_SECRET', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'];
  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  // Warn if JWT_SECRET is default-like
  const jwtSecret = process.env.JWT_SECRET!;
  if (jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters for security');
  }

  // Validate CORS origin is not wildcard in production
  const corsOrigin = process.env.CORS_ORIGIN;
  const nodeEnv = process.env.NODE_ENV;
  if (nodeEnv === 'production' && (!corsOrigin || corsOrigin === '*')) {
    throw new Error('CORS_ORIGIN must be explicitly set in production (no wildcard allowed)');
  }
}

/**
 * Create and configure the Fastify server
 */
export async function createServer(): Promise<FastifyInstance> {
  // Validate environment before starting
  validateEnv();

  const server = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
    },
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'reqId',
    // Add body limit to prevent large payload attacks
    bodyLimit: 1024 * 1024 * 10, // 10MB max
  });

  // CORS configuration
  // In development with Vite proxy, requests appear same-origin, but we still need CORS for direct API calls
  const corsOrigin = process.env.CORS_ORIGIN;
  const isDevelopment = process.env.NODE_ENV !== 'production';
  
  // Determine CORS origin: explicit string, wildcard (true), or default based on environment
  let origin: boolean | string;
  if (corsOrigin && corsOrigin !== '') {
    origin = corsOrigin === '*' ? true : corsOrigin;
  } else {
    origin = isDevelopment ? true : false;
  }
  
  // Credentials enabled only if origin is set and not wildcard
  const credentials = Boolean(corsOrigin && corsOrigin !== '*' && corsOrigin !== '');
  
  await server.register(cors, {
    origin,
    credentials,
  });

  // JWT configuration with proper settings
  await server.register(jwt, {
    secret: process.env.JWT_SECRET!,
    sign: {
      expiresIn: '15m', // Short-lived access tokens
      issuer: 'moji-proctor-server',
      audience: 'moji-proctor-client',
    },
    verify: {
      maxAge: '15m',
      issuer: 'moji-proctor-server',
      audience: 'moji-proctor-client',
      // Allow 30 second clock skew
      clockTolerance: 30,
    },
  } as any); // Cast to any to work around type definition issues

  // Rate limiting
  await server.register(rateLimit, {
    max: 100, // 100 requests per window
    timeWindow: '1 minute',
    continueExceeding: false,
    skipOnError: true,
  });

  // Register routes
  await server.register(healthRoutes, { prefix: '/' });
  await server.register(authRoutes, { prefix: '/api/auth' });
  await server.register(eventRoutes, { prefix: '/api' });
  await server.register(instructorRoutes, { prefix: '/api/instructor' });

  // Global error handler
  server.setErrorHandler((error, request, reply) => {
    request.log.error(error);

    // Handle validation errors
    if (error.validation) {
      reply.status(400).send({
        error: 'Validation Error',
        details: error.validation,
      });
      return;
    }

    // Handle rate limit errors
    if (error.statusCode === 429) {
      reply.status(429).send({
        error: 'Too Many Requests',
        retryAfter: '60s',
      });
      return;
    }

    // Generic error
    reply.status(error.statusCode ?? 500).send({
      error: error.message ?? 'Internal Server Error',
    });
  });

  // 404 handler
  server.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: 'Not Found',
      path: request.url,
    });
  });

  // Graceful shutdown
  const gracefulShutdown = async () => {
    server.log.info('Shutting down gracefully...');
    await server.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);

  return server;
}

/**
 * Start the server
 */
export async function startServer(port: number = 3000): Promise<void> {
  const server = await createServer();

  try {
    await server.listen({ port, host: '0.0.0.0' });
    console.log(`Server listening on http://0.0.0.0:${port}`);
  } catch (error) {
    server.log.error(error);
    process.exit(1);
  }
}

// Start server if run directly
// In ES modules, check if the file is the main module using import.meta.url
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  const port = parseInt(process.env.PORT ?? '3000', 10);
  startServer(port);
}

// Export for testing
export { createServer as buildServer };
