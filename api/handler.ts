/**
 * Vercel Serverless Handler
 * Wraps the Fastify server for Vercel's serverless environment
 */

import 'dotenv/config';
import { createServer } from '../src/index';

let serverInstance: any = null;

async function initialize() {
  if (!serverInstance) {
    serverInstance = await createServer();
  }
  return serverInstance;
}

export default async (req: any, res: any) => {
  try {
    const server = await initialize();
    
    // Use the Fastify server's inject method for testing, or direct routing
    // Fastify.server is the underlying Node http.Server
    if (server.server) {
      server.server.emit('request', req, res);
    } else {
      // Fallback: try to route through the Fastify app directly
      await server(req, res);
    }
  } catch (error) {
    console.error('Request handler error:', error);
    
    // If response hasn't been sent yet, send error
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : 'Unknown error'
      }));
    }
  }
};
