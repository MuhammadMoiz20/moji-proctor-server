/**
 * Signal Payload Validation Schemas
 *
 * Zod schemas for validating signal payloads.
 * Ensures only safe, expected data is accepted.
 */

import { z } from 'zod';

/**
 * SESSION_START payload schema
 */
export const sessionStartPayloadSchema = z.object({
  workspace_name: z.string().max(255),
});

/**
 * SESSION_END payload schema
 */
export const sessionEndPayloadSchema = z.object({
  focused_seconds: z.number().int().nonnegative().max(24 * 60 * 60), // Max 24 hours
  active_seconds: z.number().int().nonnegative().max(24 * 60 * 60),
  reason: z.enum(['close', 'idle_timeout', 'manual']),
});

/**
 * BURST_FLAG payload schema
 */
export const burstFlagPayloadSchema = z.object({
  severity: z.enum(['low', 'medium', 'high']),
  edit_count: z.number().int().positive().max(10000),
  char_count: z.number().int().nonnegative().max(1_000_000),
  window_ms: z.number().int().positive().max(60000), // Max 1 minute
  file_name: z.string().max(512), // Filename only, no full paths for privacy
  file_extension: z.string().max(100),
});

/**
 * CHECKPOINT_CREATED payload schema
 */
export const checkpointCreatedPayloadSchema = z.object({
  checkpoint_id: z.string().uuid(),
  file_count: z.number().int().nonnegative().max(100_000),
  log_head_hash: z.string().max(128), // SHA-256 hex
});

/**
 * File change info schema
 */
export const fileChangeInfoSchema = z.object({
  path: z.string().max(1024), // Relative path
  change_type: z.enum(['added', 'modified', 'deleted']),
});

/**
 * UNVERIFIED_CHANGES payload schema
 */
export const unverifiedChangesPayloadSchema = z.object({
  files_added: z.number().int().nonnegative().max(1000),
  files_modified: z.number().int().nonnegative().max(1000),
  files_deleted: z.number().int().nonnegative().max(1000),
  lines_added: z.number().int().nonnegative().max(100_000),
  lines_removed: z.number().int().nonnegative().max(100_000),
  last_checkpoint_id: z.string().uuid().nullable(),
  top_paths: z.array(fileChangeInfoSchema).max(50).optional(), // Max 50 paths
});

/**
 * INTEGRITY_COMPROMISED payload schema
 */
export const integrityCompromisedPayloadSchema = z.object({
  reason: z.enum(['missing_log', 'broken_hash_chain', 'missing_checkpoint', 'missing_assignment']),
  description: z.string().max(1000),
});

/**
 * STATUS_UPDATE payload schema
 * Periodic summary of current session state
 */
export const statusUpdatePayloadSchema = z.object({
  total_focused_seconds: z.number().int().nonnegative().max(30 * 24 * 60 * 60), // Max 30 days
  total_active_seconds: z.number().int().nonnegative().max(30 * 24 * 60 * 60),
  session_count: z.number().int().nonnegative().max(10000),
  burst_count: z.number().int().nonnegative().max(10000),
  burst_by_severity: z.object({
    low: z.number().int().nonnegative().max(10000),
    medium: z.number().int().nonnegative().max(10000),
    high: z.number().int().nonnegative().max(10000),
  }),
  checkpoint_count: z.number().int().nonnegative().max(10000),
  unverified_change_count: z.number().int().nonnegative().max(10000),
  integrity_passed: z.boolean(),
  session_active: z.boolean(),
});

/**
 * Union of all signal payload schemas
 */
export const signalPayloadSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('SESSION_START'),
    payload: sessionStartPayloadSchema,
  }),
  z.object({
    type: z.literal('SESSION_END'),
    payload: sessionEndPayloadSchema,
  }),
  z.object({
    type: z.literal('BURST_FLAG'),
    payload: burstFlagPayloadSchema,
  }),
  z.object({
    type: z.literal('CHECKPOINT_CREATED'),
    payload: checkpointCreatedPayloadSchema,
  }),
  z.object({
    type: z.literal('UNVERIFIED_CHANGES'),
    payload: unverifiedChangesPayloadSchema,
  }),
  z.object({
    type: z.literal('INTEGRITY_COMPROMISED'),
    payload: integrityCompromisedPayloadSchema,
  }),
  z.object({
    type: z.literal('STATUS_UPDATE'),
    payload: statusUpdatePayloadSchema,
  }),
]);

/**
 * Validate payload based on signal type
 */
export function validateSignalPayload(type: string, payload: unknown): unknown {
  const schemas: Record<string, z.ZodSchema> = {
    SESSION_START: sessionStartPayloadSchema,
    SESSION_END: sessionEndPayloadSchema,
    BURST_FLAG: burstFlagPayloadSchema,
    CHECKPOINT_CREATED: checkpointCreatedPayloadSchema,
    UNVERIFIED_CHANGES: unverifiedChangesPayloadSchema,
    INTEGRITY_COMPROMISED: integrityCompromisedPayloadSchema,
    STATUS_UPDATE: statusUpdatePayloadSchema,
  };

  const schema = schemas[type];
  if (!schema) {
    throw new Error(`Unknown signal type: ${type}`);
  }

  return schema.parse(payload);
}
