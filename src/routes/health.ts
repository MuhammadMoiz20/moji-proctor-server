/**
 * Health Check Routes
 */

import { FastifyInstance } from 'fastify';

export async function healthRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /
   *
   * Root endpoint - API info
   */
  fastify.get('/', async (request, reply) => {
    return reply.send({
      name: 'Moji Proctor API',
      version: '1.0.0',
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * GET /health
   *
   * Health check endpoint
   */
  fastify.get('/health', async (request, reply) => {
    return reply.send({ status: 'ok', timestamp: new Date().toISOString() });
  });

  /**
   * HEAD /health
   *
   * Lightweight health check
   */
  fastify.head('/health', async (request, reply) => {
    return reply.status(204).send();
  });
}
