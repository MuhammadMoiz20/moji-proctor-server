/**
 * Vercel Serverless Handler
 * Wraps the Fastify server for Vercel's serverless environment
 */

import 'dotenv/config';
import type { IncomingMessage, ServerResponse } from 'http';
import { createServer } from '../src/index';
import type { FastifyInstance } from 'fastify';

// Vercel extends IncomingMessage with parsed body
interface VercelRequest extends IncomingMessage {
  body?: any;
}

let serverInstance: FastifyInstance | null = null;

async function initialize(): Promise<FastifyInstance> {
  if (!serverInstance) {
    serverInstance = await createServer();
    // Wait for Fastify to be ready (plugins loaded, routes registered)
    await serverInstance.ready();
  }
  return serverInstance;
}

export default async (req: VercelRequest, res: ServerResponse) => {
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
    res.statusCode = response.statusCode;
    res.end(response.payload);
  } catch (error) {
    console.error('Request handler error:', error);
    
    // If response hasn't been sent yet, send error
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ 
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : 'Unknown error'
      }));
    }
  }
};
