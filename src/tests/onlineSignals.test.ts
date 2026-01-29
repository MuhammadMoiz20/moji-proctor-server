import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { build, teardown } from './helper';
import { prisma } from '../index';

const verifySignatureMock = vi.fn();
const getNextSequenceNumberMock = vi.fn().mockResolvedValue(0);
const incrementSequenceNumberMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/signatures', () => ({
  verifySignature: (...args: any[]) => verifySignatureMock(...args),
  getNextSequenceNumber: (...args: any[]) => getNextSequenceNumberMock(...args),
  incrementSequenceNumber: (...args: any[]) => incrementSequenceNumberMock(...args),
}));

const detectTamperingMock = vi.fn().mockResolvedValue({
  isTampered: false,
  updatedState: null,
  tamperType: null,
  description: null,
  previousCheckpointId: null,
});

vi.mock('../services/tamperDetection', () => ({
  detectTampering: (...args: any[]) => detectTamperingMock(...args),
  updateCheckpointState: vi.fn(),
  createTamperFlag: vi.fn(),
}));

describe('Online Signals - Smoke Tests', () => {
  let server: any;

  beforeAll(async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('login/device/code')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            device_code: 'device-code',
            user_code: 'ABCD-EFGH',
            verification_uri: 'https://github.com/login/device',
            verification_uri_complete: 'https://github.com/login/device?user_code=ABCD-EFGH',
            expires_in: 600,
            interval: 5,
          }),
          text: async () => '',
        };
      }
      if (url.includes('login/oauth/access_token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'gh-access-token',
          }),
          text: async () => '',
        };
      }
      if (url.includes('api.github.com/user')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 1,
            login: 'octo',
            name: 'Octo',
            email: 'octo@example.com',
          }),
          text: async () => '',
        };
      }
      return {
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => 'error',
      };
    });

    vi.stubGlobal('fetch', fetchMock);

    server = await build();

    vi.spyOn(prisma.user, 'upsert').mockResolvedValue({
      id: 'user-1',
      githubId: '1',
      githubLogin: 'octo',
      githubName: 'Octo',
      githubEmail: 'octo@example.com',
      role: 'student',
    } as any);

    vi.spyOn(prisma.refreshToken, 'create').mockResolvedValue({ id: 'rt-1' } as any);
    vi.spyOn(prisma.refreshToken, 'findMany').mockResolvedValue([]);
    vi.spyOn(prisma.refreshToken, 'deleteMany').mockResolvedValue({ count: 1 } as any);
    vi.spyOn(prisma.refreshToken, 'findUnique').mockResolvedValue({
      id: 'rt-1',
      userId: 'user-1',
      token: 'refresh-token',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      revokedAt: null,
    } as any);
    vi.spyOn(prisma.refreshToken, 'delete').mockResolvedValue({} as any);

    vi.spyOn(prisma.device, 'upsert').mockResolvedValue({
      id: 'device-1',
      userId: 'user-1',
      publicKey: 'a'.repeat(64),
    } as any);

    vi.spyOn(prisma.signal, 'findUnique').mockResolvedValue(null as any);

    vi.spyOn(prisma, '$transaction').mockImplementation(async (fn: any) => {
      const tx = {
        signal: { create: vi.fn().mockResolvedValue({}) },
        deviceCheckpoint: { upsert: vi.fn().mockResolvedValue({}) },
        tamperFlag: { create: vi.fn().mockResolvedValue({}) },
      };
      return fn(tx);
    });
  });

  afterAll(async () => {
    await teardown();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('device flow start responds with codes', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/auth/device/start',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.device_code).toBe('device-code');
    expect(body.user_code).toBe('ABCD-EFGH');
  });

  it('device flow complete issues tokens', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/auth/device/complete',
      payload: { device_code: 'device-code' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();
  });

  it('logout revokes refresh token', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/auth/logout',
      payload: { refresh_token: 'refresh-token' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);
  });

  it('accepts properly signed batch payload', async () => {
    verifySignatureMock.mockReturnValue(true);
    const token = server.jwt.sign({ userId: 'user-1' });

    const response = await server.inject({
      method: 'POST',
      url: '/api/events/batch',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        signals: [
          {
            event_id: '00000000-0000-0000-0000-000000000001',
            ts: new Date().toISOString(),
            session_id: '00000000-0000-0000-0000-000000000002',
            type: 'SESSION_START',
            payload: { workspace_name: 'test-workspace' },
            assignment_id: 'assignment-1',
            device_pubkey: 'a'.repeat(64),
            seq: 1,
            sig: 'b'.repeat(128),
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.accepted).toBe(1);
    expect(body.rejected).toBe(0);
  });

  it('rejects mismatched signature', async () => {
    verifySignatureMock.mockReturnValue(false);
    const token = server.jwt.sign({ userId: 'user-1' });

    const response = await server.inject({
      method: 'POST',
      url: '/api/events/batch',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        signals: [
          {
            event_id: '00000000-0000-0000-0000-000000000003',
            ts: new Date().toISOString(),
            session_id: '00000000-0000-0000-0000-000000000004',
            type: 'SESSION_START',
            payload: { workspace_name: 'test-workspace' },
            assignment_id: 'assignment-1',
            device_pubkey: 'a'.repeat(64),
            seq: 1,
            sig: 'b'.repeat(128),
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.accepted).toBe(0);
    expect(body.rejected).toBe(1);
  });
});
