/**
 * Test Helper for Server Integration Tests
 *
 * Provides utilities for building and testing the Fastify server.
 */

import { FastifyInstance } from 'fastify';
import { createServer } from '../index';

let server: FastifyInstance | null = null;

/**
 * Build a test server instance
 */
export async function build() {
  if (server) {
    return server;
  }

  // Set test environment variables
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.JWT_SECRET = 'test-secret-key-that-is-at-least-32-chars-long';
  process.env.GITHUB_CLIENT_ID = 'test-client-id';
  process.env.GITHUB_CLIENT_SECRET = 'test-client-secret';
  process.env.NODE_ENV = 'test';

  server = await createServer();

  return server;
}

/**
 * Clean up test server
 */
export async function teardown() {
  if (server) {
    await server.close();
    server = null;
  }
}

/**
 * Generate a valid JWT token for testing
 */
export async function generateTestToken(server: FastifyInstance, userId: string): Promise<string> {
  return server.jwt.sign({ userId });
}

/**
 * Create a mock device public key
 */
export function mockDevicePublicKey(): string {
  return 'a'.repeat(64); // 64 hex chars
}

/**
 * Create a mock signature
 */
export function mockSignature(): string {
  return 'b'.repeat(128); // 128 hex chars
}

/**
 * Create a mock signal
 */
export function createMockSignal(overrides = {}) {
  return {
    event_id: '00000000-0000-0000-0000-000000000001',
    ts: new Date().toISOString(),
    session_id: '00000000-0000-0000-0000-000000000002',
    type: 'SESSION_START',
    payload: { workspace_name: 'test-workspace' },
    assignment_id: 'test-assignment',
    device_pubkey: mockDevicePublicKey(),
    seq: 1,
    sig: mockSignature(),
    ...overrides,
  };
}
