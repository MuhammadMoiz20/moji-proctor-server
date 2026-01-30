/**
 * Signature Verification Service
 *
 * Verifies Ed25519 signatures from client devices.
 * Manages sequence numbers per device+assignment for replay protection.
 */

import * as crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { prisma } from '../prisma';

/**
 * Canonical JSON stringify (must match client implementation)
 */
function canonicalStringify(value: unknown): string {
  return JSON.stringify(value, canonicalReplacer, 0);
}

/**
 * Replacer for canonical JSON (sorted keys)
 */
function canonicalReplacer(key: string, value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) =>
      typeof item === 'object' && item !== null
        ? JSON.parse(canonicalStringify(item))
        : item
    );
  }

  const sortedKeys = Object.keys(value).sort();
  const sortedObj: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    const v = (value as Record<string, unknown>)[k];
    sortedObj[k] =
      typeof v === 'object' && v !== null
        ? JSON.parse(canonicalStringify(v))
        : v;
  }
  return sortedObj;
}

/**
 * Verify Ed25519 signature using Node's built-in crypto module
 *
 * @param payload - Object that was signed
 * @param signatureHex - Signature (hex encoded, 64 bytes)
 * @param publicKeyHex - Public key (hex encoded, 32 bytes)
 * @returns True if signature is valid
 */
export function verifySignature(
  payload: object,
  signatureHex: string,
  publicKeyHex: string
): boolean {
  try {
    const canonicalPayload = canonicalStringify(payload);
    console.log('[Signatures] Verifying signature for payload:', canonicalPayload.substring(0, 200) + '...');
    console.log('[Signatures] Public key:', publicKeyHex.substring(0, 20) + '...');
    console.log('[Signatures] Signature:', signatureHex.substring(0, 40) + '...');
    
    const message = Buffer.from(canonicalPayload, 'utf8');
    const signature = Buffer.from(signatureHex, 'hex');
    const publicKeyRaw = Buffer.from(publicKeyHex, 'hex');

    // Create DER-encoded SPKI for Ed25519 public key
    // Ed25519 OID: 1.3.101.112
    const oidEd25519 = Buffer.from([
      0x30, 0x2a, // SEQUENCE, 42 bytes
      0x30, 0x05, // SEQUENCE, 5 bytes (algorithm identifier)
      0x06, 0x03, // OID, 3 bytes
      0x2b, 0x65, 0x70, // 1.3.101.112 (Ed25519)
      0x03, 0x21, // BIT STRING, 33 bytes
      0x00, // unused bits
    ]);
    const derKey = Buffer.concat([oidEd25519, publicKeyRaw]);

    const keyObject = crypto.createPublicKey({
      key: derKey,
      format: 'der',
      type: 'spki',
    });

    return crypto.verify(null, message, keyObject, signature);
  } catch {
    return false;
  }
}

/**
 * Get current sequence number for device+assignment
 *
 * @param deviceId - Device ID
 * @param assignmentId - Assignment ID
 * @returns Current sequence number
 */
export async function getNextSequenceNumber(
  deviceId: string,
  assignmentId: string
): Promise<number> {
  const seq = await prisma.deviceSequence.findUnique({
    where: {
      deviceId_assignmentId: {
        deviceId,
        assignmentId,
      },
    },
  });

  return seq?.lastSeq ?? 0;
}

/**
 * Increment sequence number for device+assignment
 *
 * @param tx - Prisma transaction
 * @param deviceId - Device ID
 * @param assignmentId - Assignment ID
 * @param newSeq - New sequence number
 */
export async function incrementSequenceNumber(
  tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>,
  deviceId: string,
  assignmentId: string,
  newSeq: number
): Promise<void> {
  await tx.deviceSequence.upsert({
    where: {
      deviceId_assignmentId: {
        deviceId,
        assignmentId,
      },
    },
    update: { lastSeq: newSeq },
    create: {
      deviceId,
      assignmentId,
      lastSeq: newSeq,
    },
  });
}
