/**
 * Vercel Serverless Handler
 * Wraps the Fastify server for Vercel's serverless environment
 */

import 'dotenv/config';
import { createServer } from '../src/index';

let serverInstance: any = null;

export default async (req: any, res: any) => {
  // Create server instance once and reuse it
  if (!serverInstance) {
    try {
      serverInstance = await createServer();
    } catch (error) {
      console.error('Failed to create server:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        error: 'Server initialization failed',
        message: error instanceof Error ? error.message : 'Unknown error'
      }));
      return;
    }
  }

  // Use Fastify's native request handling
  serverInstance.routing(req, res);
};
