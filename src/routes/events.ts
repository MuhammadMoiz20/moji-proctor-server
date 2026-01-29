/**
 * Event Routes
 *
 * Handles signal ingestion from extensions with signature verification.
 * Devices are bound to authenticated users for security.
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../index';
import { verifySignature, getNextSequenceNumber, incrementSequenceNumber } from '../services/signatures';
import {
  detectTampering,
  updateCheckpointState,
  createTamperFlag,
} from '../services/tamperDetection';
import {
  sessionStartPayloadSchema,
  sessionEndPayloadSchema,
  burstFlagPayloadSchema,
  checkpointCreatedPayloadSchema,
  unverifiedChangesPayloadSchema,
  integrityCompromisedPayloadSchema,
  statusUpdatePayloadSchema,
} from '../schemas/signals';

/**
 * Batch upload request
 */
interface BatchUploadRequest {
  signals: Array<{
    event_id: string;
    ts: string;
    session_id: string;
    type: string;
    payload: unknown;
    assignment_id: string;
    course_id?: string;
    commit_sha?: string;
    repo_identifier?: string;
    device_pubkey: string;
    seq: number;
    sig: string;
  }>;
}

/**
 * Batch upload response
 */
interface BatchUploadResponse {
  accepted: number;
  rejected: number;
  rejected_ids?: string[];
}

// Validation schemas per signal type
const payloadSchemas: Record<string, z.ZodSchema> = {
  SESSION_START: sessionStartPayloadSchema,
  SESSION_END: sessionEndPayloadSchema,
  BURST_FLAG: burstFlagPayloadSchema,
  CHECKPOINT_CREATED: checkpointCreatedPayloadSchema,
  UNVERIFIED_CHANGES: unverifiedChangesPayloadSchema,
  INTEGRITY_COMPROMISED: integrityCompromisedPayloadSchema,
  STATUS_UPDATE: statusUpdatePayloadSchema,
};

// Base validation schema
const batchUploadSchema = z.object({
  signals: z.array(
    z.object({
      event_id: z.string().uuid(),
      ts: z.string().datetime(),
      session_id: z.string().uuid(),
      type: z.enum(['SESSION_START', 'SESSION_END', 'BURST_FLAG', 'CHECKPOINT_CREATED', 'UNVERIFIED_CHANGES', 'INTEGRITY_COMPROMISED', 'STATUS_UPDATE']),
      payload: z.unknown(), // Will be validated per type
      assignment_id: z.string().min(1).max(255),
      course_id: z.string().max(255).optional(),
      commit_sha: z.string().max(64).optional(),
      repo_identifier: z.string().max(255).optional(),
      device_pubkey: z.string().regex(/^[0-9a-f]{64}$/),
      seq: z.number().int().positive().max(1_000_000), // Reasonable max
      sig: z.string().regex(/^[0-9a-f]{128}$/),
    })
  ).min(1).max(100), // Max 100 signals per batch
});

/**
 * Register event routes
 */
export async function eventRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /events/batch
   *
   * Upload a batch of signals
   */
  fastify.post('/events/batch', async (request, reply) => {
    // Verify JWT
    try {
      const authHeader = request.headers.authorization;
      fastify.log.info({ authHeader: authHeader ? `${authHeader.substring(0, 30)}...` : 'none' }, 'Verifying JWT');
      await request.jwtVerify();
    } catch (error) {
      const err = error as Error;
      fastify.log.error({ 
        errorName: err.name, 
        errorMessage: err.message,
        errorCode: (err as any).code,
        stack: err.stack?.split('\n').slice(0, 3).join('\n')
      }, 'JWT verification failed');
      return reply.status(401).send({ error: 'Unauthorized', details: err.message });
    }

    const userId = (request.user as any)?.userId;
    if (!userId) {
      fastify.log.error('No userId in JWT');
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    fastify.log.info({ userId, signalCount: (request.body as any)?.signals?.length }, 'Batch upload request received');

    const body = batchUploadSchema.safeParse(request.body);
    if (!body.success) {
      fastify.log.error({ error: body.error }, 'Batch validation failed');
      return reply.status(400).send({ error: 'Validation failed', details: body.error });
    }

    const { signals } = body.data;

    // Process each signal
    const accepted: string[] = [];
    const rejected: string[] = [];

    fastify.log.info({ totalSignals: signals.length }, 'Processing signals batch');

    for (const signal of signals) {
      try {
        fastify.log.info({
          eventId: signal.event_id,
          type: signal.type,
          assignmentId: signal.assignment_id,
          seq: signal.seq,
          devicePubKey: signal.device_pubkey.substring(0, 16) + '...'
        }, 'Processing signal');

        fastify.log.debug({
          signalPayload: JSON.stringify(signal.payload).substring(0, 200)
        }, 'Signal payload');

        // 1. Validate payload based on type
        const payloadSchema = payloadSchemas[signal.type];
        if (!payloadSchema) {
          fastify.log.warn({ eventId: signal.event_id, type: signal.type }, 'Unknown signal type');
          rejected.push(signal.event_id);
          continue;
        }

        const validatedPayload = payloadSchema.safeParse(signal.payload);
        if (!validatedPayload.success) {
          fastify.log.warn({
            signalId: signal.event_id,
            type: signal.type,
            error: validatedPayload.error,
          }, 'Payload validation failed');
          rejected.push(signal.event_id);
          continue;
        }

        // 2. Verify signature FIRST (before any DB operations)
        // IMPORTANT: Use original payload for signature verification, not validated one
        // The client signs the original payload, so we must verify against the same data
        const payloadToVerify = {
          event_id: signal.event_id,
          ts: signal.ts,
          session_id: signal.session_id,
          type: signal.type,
          payload: signal.payload, // Use ORIGINAL payload for signature verification
          assignment_id: signal.assignment_id,
          course_id: signal.course_id,
          commit_sha: signal.commit_sha,
          repo_identifier: signal.repo_identifier,
        };

        fastify.log.debug({
          eventId: signal.event_id,
          payloadToVerify: JSON.stringify(payloadToVerify).substring(0, 300)
        }, 'Verifying signature');

        const isValid = verifySignature(
          payloadToVerify,
          signal.sig,
          signal.device_pubkey
        );

        if (!isValid) {
          // Log detailed info for debugging
          const payloadJson = JSON.stringify(payloadToVerify);
          fastify.log.error({
            eventId: signal.event_id,
            devicePubKey: signal.device_pubkey.substring(0, 16) + '...',
            signaturePrefix: signal.sig.substring(0, 32) + '...',
            payloadLength: payloadJson.length,
            payloadPreview: payloadJson.substring(0, 200),
          }, 'SIGNATURE VERIFICATION FAILED');
          rejected.push(signal.event_id);
          continue;
        }
        
        fastify.log.info({ eventId: signal.event_id }, 'Signature verified successfully');

        // 3. Get or create device AFTER signature verification
        // Device is bound to the authenticated user
        const device = await prisma.device.upsert({
          where: { publicKey: signal.device_pubkey },
          update: { lastSeenAt: new Date() },
          create: {
            publicKey: signal.device_pubkey,
            userId: userId, // Bind to authenticated user
          },
        });

        // 4. Verify device belongs to authenticated user
        if (device.userId !== userId) {
          fastify.log.warn({
            deviceUserId: device.userId,
            requestUserId: userId,
            devicePubKey: signal.device_pubkey,
          }, 'Device belongs to different user');
          rejected.push(signal.event_id);
          continue;
        }

        // 5. Verify sequence number atomically
        const currentSeq = await getNextSequenceNumber(device.id, signal.assignment_id);
        fastify.log.debug({
          eventId: signal.event_id,
          signalSeq: signal.seq,
          currentSeq,
          expectedSeq: currentSeq + 1
        }, 'Checking sequence number');

        if (signal.seq <= currentSeq) {
          // Replay or out of order
          fastify.log.warn({
            eventId: signal.event_id,
            signalSeq: signal.seq,
            currentSeq,
          }, 'Sequence number replay/out-of-order');
          rejected.push(signal.event_id);
          continue;
        }

        // Allow gap if this is the first signal for this device/assignment
        // This handles the case where the extension has been running but the server
        // database is fresh (or was reset)
        const isFirstSignal = currentSeq === 0;
        if (signal.seq !== currentSeq + 1 && !isFirstSignal) {
          // Gap in sequence - reject to prevent replay
          fastify.log.warn({
            eventId: signal.event_id,
            signalSeq: signal.seq,
            currentSeq,
            expectedSeq: currentSeq + 1
          }, 'Sequence number gap');
          rejected.push(signal.event_id);
          continue;
        }

        if (isFirstSignal && signal.seq !== 1) {
          fastify.log.info({
            eventId: signal.event_id,
            signalSeq: signal.seq,
          }, 'Accepting first signal with non-1 sequence (initial sync)');
        }

        // 6. Check for duplicate event_id
        const existing = await prisma.signal.findUnique({
          where: {
            eventId_assignmentId: {
              eventId: signal.event_id,
              assignmentId: signal.assignment_id,
            },
          },
        });

        if (existing) {
          rejected.push(signal.event_id);
          continue;
        }

        // 7. Perform tamper detection BEFORE storing the signal
        // Extract checkpoint_id from payload if available (for UNVERIFIED_CHANGES)
        let checkpointId: string | null = null;
        if (signal.type === 'UNVERIFIED_CHANGES' && validatedPayload.data) {
          const payload = validatedPayload.data as { last_checkpoint_id?: string | null };
          checkpointId = payload.last_checkpoint_id || null;
        }

        const tamperResult = await detectTampering(
          prisma,
          device.id,
          signal.assignment_id,
          {
            eventId: signal.event_id,
            type: signal.type,
            timestamp: signal.ts,
            seq: signal.seq,
            sessionId: signal.session_id,
            checkpointId,
          },
          validatedPayload.data
        );

        // 8. Store signal with sequence update in transaction
        await prisma.$transaction(async (tx) => {
          // Re-check sequence in transaction to prevent race conditions
          const txSeq = await getNextSequenceNumber(device.id, signal.assignment_id);
          const isInitialSync = txSeq === 0 && signal.seq > 1;
          if (signal.seq !== txSeq + 1 && !isInitialSync) {
            throw new Error('Sequence number mismatch in transaction');
          }

          // Create signal record
          await tx.signal.create({
            data: {
              eventId: signal.event_id,
              deviceId: device.id,
              assignmentId: signal.assignment_id,
              courseId: signal.course_id,
              sessionId: signal.session_id,
              type: signal.type,
              timestamp: new Date(signal.ts),
              payload: validatedPayload.data, // Use validated payload
              seq: signal.seq,
              signature: signal.sig,
              devicePubKey: signal.device_pubkey,
            },
          });

          // Increment sequence
          await incrementSequenceNumber(tx, device.id, signal.assignment_id, signal.seq);

          // Update checkpoint state for tamper detection
          if (tamperResult.updatedState) {
            await tx.deviceCheckpoint.upsert({
              where: {
                deviceId_assignmentId: {
                  deviceId: device.id,
                  assignmentId: signal.assignment_id,
                },
              },
              update: {
                lastCheckpointId: tamperResult.updatedState.lastCheckpointId,
                stateHash: tamperResult.updatedState.stateHash,
                seq: tamperResult.updatedState.seq,
                sessionCount: tamperResult.updatedState.sessionCount,
                totalFocusedSeconds: tamperResult.updatedState.totalFocusedSeconds,
                hasDiscontinuity: tamperResult.updatedState.hasDiscontinuity,
              },
              create: {
                deviceId: device.id,
                assignmentId: signal.assignment_id,
                lastCheckpointId: tamperResult.updatedState.lastCheckpointId,
                stateHash: tamperResult.updatedState.stateHash,
                seq: tamperResult.updatedState.seq,
                sessionCount: tamperResult.updatedState.sessionCount,
                totalFocusedSeconds: tamperResult.updatedState.totalFocusedSeconds,
                hasDiscontinuity: tamperResult.updatedState.hasDiscontinuity,
              },
            });
          }

          // Create tamper flag if detected
          if (tamperResult.isTampered && tamperResult.tamperType && tamperResult.description) {
            await tx.tamperFlag.create({
              data: {
                deviceId: device.id,
                assignmentId: signal.assignment_id,
                type: tamperResult.tamperType,
                description: tamperResult.description,
                detectedAtSeq: signal.seq,
                signalId: signal.event_id,
                previousCheckpointId: tamperResult.previousCheckpointId,
                newCheckpointId: checkpointId,
              },
            });

            fastify.log.warn({
              deviceId: device.id,
              assignmentId: signal.assignment_id,
              signalId: signal.event_id,
              tamperType: tamperResult.tamperType,
              description: tamperResult.description,
            }, 'Tampering detected');
          }
        });

        accepted.push(signal.event_id);
      } catch (error) {
        const err = error as Error;
        fastify.log.error({ 
          errorMessage: err.message,
          errorName: err.name,
          errorStack: err.stack?.split('\n').slice(0, 5).join('\n'),
          signalId: signal.event_id 
        }, 'Failed to process signal');
        rejected.push(signal.event_id);
      }
    }

    const response: BatchUploadResponse = {
      accepted: accepted.length,
      rejected: rejected.length,
      rejected_ids: rejected.length > 0 ? rejected : undefined,
    };

    return reply.send(response);
  });
}
