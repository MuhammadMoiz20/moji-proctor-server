/**
 * Vercel Serverless Handler
 * Wraps the Fastify server for Vercel's serverless environment
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { FastifyInstance } from 'fastify';

let serverInstance: FastifyInstance | null = null;
let initError: Error | null = null;

async function initialize(): Promise<FastifyInstance> {
  if (initError) {
    throw initError;
  }
  if (!serverInstance) {
    try {
      console.log('Starting server initialization...');
      console.log('NODE_ENV:', process.env.NODE_ENV);
      console.log('DATABASE_URL exists:', !!process.env.DATABASE_URL);
      console.log('JWT_SECRET exists:', !!process.env.JWT_SECRET);
      console.log('GITHUB_CLIENT_ID exists:', !!process.env.GITHUB_CLIENT_ID);
      
      // Dynamic import to catch module-level errors
      const { createServer } = await import('../src/index');
      console.log('createServer imported successfully');
      
      serverInstance = await createServer();
      console.log('Server instance created');
      
      // Wait for Fastify to be ready (plugins loaded, routes registered)
      await serverInstance.ready();
      console.log('Server ready');
    } catch (err) {
      initError = err instanceof Error ? err : new Error(String(err));
      console.error('Server initialization error:', initError.message);
      console.error('Stack:', initError.stack);
      throw initError;
    }
  }
  return serverInstance;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const server = await initialize();
    
    // Build the full URL for Fastify inject
    const url = req.url || '/';
    
    // Convert headers to simple object format
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') {
        headers[key] = value;
      } else if (Array.isArray(value)) {
        headers[key] = value.join(', ');
      }
    }
    
    // Use Fastify's inject method which properly routes through the framework
    const response = await server.inject({
      method: req.method as any,
      url,
      headers,
      payload: req.body,
    });
    
    // Copy response headers
    const responseHeaders = response.headers;
    for (const [key, value] of Object.entries(responseHeaders)) {
      if (value !== undefined) {
        res.setHeader(key, value as string);
      }
    }
    
    // Send the response
    res.status(response.statusCode).send(response.payload);
  } catch (error) {
    console.error('Request handler error:', error);
    
    // If response hasn't been sent yet, send error
    if (!res.headersSent) {
      res.status(500).json({ 
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: process.env.NODE_ENV !== 'production' ? (error instanceof Error ? error.stack : undefined) : undefined
      });
    }
  }
}
