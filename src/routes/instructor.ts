/**
 * Instructor Dashboard Routes
 *
 * API endpoints for instructors to view student signals.
 * Requires instructor role.
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../index';
import { requireInstructor } from '../services/authz';
import { getTamperFlagsForAssignment, getTamperFlags, markTamperFlagReviewed } from '../services/tamperDetection';

/**
 * Register instructor routes
 */
export async function instructorRoutes(fastify: FastifyInstance): Promise<void> {
  // All instructor routes require authentication AND instructor role
  fastify.addHook('onRequest', async (request, reply) => {
    try {
      await request.jwtVerify();
      // Check for instructor role
      await requireInstructor(request);
    } catch (error) {
      if ((error as Error).message === 'Forbidden: instructor role required') {
        return reply.status(403).send({ error: 'Forbidden: instructor role required' });
      }
      return reply.status(401).send({ error: 'Unauthorized' });
    }
  });

  /**
   * GET /instructor/assignments
   *
   * Get list of assignments with signal data
   */
  fastify.get('/assignments', async (request, reply) => {
    // Get unique assignments from signals
    const assignments = await prisma.signal.groupBy({
      by: ['assignmentId', 'courseId'],
      _count: {
        id: true,
      },
    });

    return reply.send({
      assignments: assignments.map((a) => ({
        assignment_id: a.assignmentId,
        course_id: a.courseId,
        signal_count: a._count.id,
      })),
    });
  });

  /**
   * GET /instructor/assignments/:id/students
   *
   * Get list of students for an assignment
   */
  fastify.get('/assignments/:id/students', async (request, reply) => {
    const { id } = request.params as { id: string };

    // Get students (devices) with signals for this assignment
    const students = await prisma.signal.findMany({
      where: { assignmentId: id },
      include: {
        device: {
          include: {
            user: {
              select: {
                githubLogin: true,
                githubName: true,
                githubEmail: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
      distinct: ['deviceId'],
    });

    // Group by device/student
    const studentMap = new Map<string, {
      device_id: string;
      user: { login: string; name?: string; email?: string } | null;
      first_seen: Date;
      last_seen: Date;
      signal_count: number;
      sessions: string[];
      tamper_flag_count: number;
      has_discontinuity: boolean;
    }>();

    for (const signal of students) {
      const existing = studentMap.get(signal.deviceId);
      if (existing) {
        existing.last_seen = signal.createdAt;
        existing.signal_count++;
        if (!existing.sessions.includes(signal.sessionId)) {
          existing.sessions.push(signal.sessionId);
        }
      } else {
        studentMap.set(signal.deviceId, {
          device_id: signal.deviceId,
          user: signal.device.user ? {
            login: signal.device.user.githubLogin,
            name: signal.device.user.githubName ?? undefined,
            email: signal.device.user.githubEmail ?? undefined,
          } : null,
          first_seen: signal.createdAt,
          last_seen: signal.createdAt,
          signal_count: 1,
          sessions: [signal.sessionId],
          tamper_flag_count: 0,
          has_discontinuity: false,
        });
      }
    }

    // Get tamper flags for all students in this assignment
    const tamperFlags = await prisma.tamperFlag.findMany({
      where: { assignmentId: id },
    });

    // Get device checkpoint states for discontinuity info
    const deviceCheckpoints = await prisma.deviceCheckpoint.findMany({
      where: { assignmentId: id },
    });

    // Add tamper flag counts and discontinuity info to students
    for (const flag of tamperFlags) {
      const student = studentMap.get(flag.deviceId);
      if (student) {
        student.tamper_flag_count++;
      }
    }

    for (const checkpoint of deviceCheckpoints) {
      const student = studentMap.get(checkpoint.deviceId);
      if (student && checkpoint.hasDiscontinuity) {
        student.has_discontinuity = true;
      }
    }

    return reply.send({
      assignment_id: id,
      students: Array.from(studentMap.values()).map((s) => ({
        device_id: s.device_id,
        user: s.user,
        first_seen: s.first_seen,
        last_seen: s.last_seen,
        signal_count: s.signal_count,
        session_count: s.sessions.length,
        integrity: {
          tamper_flag_count: s.tamper_flag_count,
          has_discontinuity: s.has_discontinuity,
        },
      })),
    });
  });

  /**
   * GET /instructor/assignments/:id/students/:studentId/timeline
   *
   * Get timeline of signals for a specific student
   */
  fastify.get('/assignments/:id/students/:studentId/timeline', async (request, reply) => {
    const { id, studentId } = request.params as { id: string; studentId: string };
    const query = request.query as { type?: string; limit?: string };

    const limit = query.limit ? parseInt(query.limit, 10) : 100;

    const where: any = {
      assignmentId: id,
      deviceId: studentId,
    };

    if (query.type) {
      where.type = query.type;
    }

    const signals = await prisma.signal.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: limit,
    });

    return reply.send({
      assignment_id: id,
      device_id: studentId,
      signals: signals.map((s) => ({
        event_id: s.eventId,
        ts: s.timestamp.toISOString(),
        session_id: s.sessionId,
        type: s.type,
        payload: s.payload,
      })),
    });
  });

  /**
   * GET /instructor/assignments/:id/summary
   *
   * Get summary statistics for an assignment
   */
  fastify.get('/assignments/:id/summary', async (request, reply) => {
    const { id } = request.params as { id: string };

    // Count signals by type
    const signalCounts = await prisma.signal.groupBy({
      by: ['type'],
      where: { assignmentId: id },
      _count: { id: true },
    });

    // Count unique students
    const uniqueDevices = await prisma.signal.findMany({
      where: { assignmentId: id },
      distinct: ['deviceId'],
      select: { deviceId: true },
    });

    // Count unique sessions
    const uniqueSessions = await prisma.signal.findMany({
      where: { assignmentId: id },
      distinct: ['sessionId'],
      select: { sessionId: true },
    });

    // Get time range
    const timeRange = await prisma.signal.aggregate({
      where: { assignmentId: id },
      _min: { timestamp: true },
      _max: { timestamp: true },
    });

    // Count tamper flags
    const tamperFlagCount = await prisma.tamperFlag.count({
      where: { assignmentId: id },
    });

    // Count students with tamper flags
    const studentsWithTamperFlags = await prisma.tamperFlag.findMany({
      where: { assignmentId: id },
      distinct: ['deviceId'],
      select: { deviceId: true },
    });

    return reply.send({
      assignment_id: id,
      total_signals: signalCounts.reduce((sum, s) => sum + s._count.id, 0),
      unique_students: uniqueDevices.length,
      unique_sessions: uniqueSessions.length,
      signals_by_type: signalCounts.map((s) => ({
        type: s.type,
        count: s._count.id,
      })),
      time_range: {
        earliest: timeRange._min.timestamp?.toISOString() ?? null,
        latest: timeRange._max.timestamp?.toISOString() ?? null,
      },
      integrity: {
        tamper_flag_count: tamperFlagCount,
        students_with_flags: studentsWithTamperFlags.length,
      },
    });
  });

  /**
   * GET /instructor/assignments/:id/tamper-flags
   *
   * Get all tamper flags for an assignment
   */
  fastify.get('/assignments/:id/tamper-flags', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { reviewed?: string };

    const where: any = { assignmentId: id };
    if (query.reviewed !== undefined) {
      where.reviewed = query.reviewed === 'true';
    }

    const tamperFlags = await prisma.tamperFlag.findMany({
      where,
      include: {
        device: {
          include: {
            user: {
              select: {
                githubLogin: true,
                githubName: true,
                githubEmail: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return reply.send({
      assignment_id: id,
      tamper_flags: tamperFlags.map((flag) => ({
        id: flag.id,
        type: flag.type,
        description: flag.description,
        detected_at_seq: flag.detectedAtSeq,
        signal_id: flag.signalId,
        previous_checkpoint_id: flag.previousCheckpointId,
        new_checkpoint_id: flag.newCheckpointId,
        reviewed: flag.reviewed,
        created_at: flag.createdAt.toISOString(),
        device: {
          device_id: flag.deviceId,
          user: flag.device.user ? {
            login: flag.device.user.githubLogin,
            name: flag.device.user.githubName,
            email: flag.device.user.githubEmail,
          } : null,
        },
      })),
    });
  });

  /**
   * PATCH /instructor/tamper-flags/:flagId/review
   *
   * Mark a tamper flag as reviewed
   */
  fastify.patch('/tamper-flags/:flagId/review', async (request, reply) => {
    const { flagId } = request.params as { flagId: string };

    await markTamperFlagReviewed(prisma, flagId);

    return reply.send({ message: 'Tamper flag marked as reviewed' });
  });

  /**
   * GET /instructor/assignments/:id/students/:studentId/report
   *
   * Get detailed report statistics for a specific student
   */
  fastify.get('/assignments/:id/students/:studentId/report', async (request, reply) => {
    const { id, studentId } = request.params as { id: string; studentId: string };

    // Get all signals for this student and assignment
    const signals = await prisma.signal.findMany({
      where: {
        assignmentId: id,
        deviceId: studentId,
      },
      orderBy: { timestamp: 'asc' },
    });

    // Get device checkpoint state
    const deviceCheckpoint = await prisma.deviceCheckpoint.findUnique({
      where: {
        deviceId_assignmentId: {
          deviceId: studentId,
          assignmentId: id,
        },
      },
    });

    // Get tamper flags for this student
    const tamperFlags = await prisma.tamperFlag.findMany({
      where: {
        deviceId: studentId,
        assignmentId: id,
      },
      orderBy: { createdAt: 'desc' },
    });

    // Calculate statistics from signals
    let totalFocusedSeconds = 0;
    let totalActiveSeconds = 0;
    const sessions = new Set<string>();
    let burstCount = 0;
    const burstBySeverity = { low: 0, medium: 0, high: 0 };
    let checkpointCount = 0;
    let unverifiedChangesCount = 0;
    let integrityCompromised = false;
    const integrityIssues: Array<{ type: string; description: string }> = [];
    let firstSessionStart: Date | null = null;
    let lastSessionEnd: Date | null = null;

    for (const signal of signals) {
      // Track sessions
      sessions.add(signal.sessionId);

      // Calculate time from SESSION_END events (contains total session time)
      // SESSION_END is more accurate than accumulating TIME_TICK deltas
      if (signal.type === 'SESSION_END' && signal.payload) {
        const payload = signal.payload as any;
        if (typeof payload.focused_seconds === 'number') {
          totalFocusedSeconds += payload.focused_seconds;
        }
        if (typeof payload.active_seconds === 'number') {
          totalActiveSeconds += payload.active_seconds;
        }
      }

      // Count burst events
      if (signal.type === 'BURST_FLAG' && signal.payload) {
        burstCount++;
        const payload = signal.payload as any;
        if (payload.severity && burstBySeverity[payload.severity as keyof typeof burstBySeverity] !== undefined) {
          burstBySeverity[payload.severity as keyof typeof burstBySeverity]++;
        }
      }

      // Count checkpoints
      if (signal.type === 'CHECKPOINT_CREATED') {
        checkpointCount++;
      }

      // Count unverified changes - these also compromise integrity
      if (signal.type === 'UNVERIFIED_CHANGES' && signal.payload) {
        const payload = signal.payload as any;
        // Calculate total unverified changes from individual counters
        const filesChanged = (payload.files_added || 0) + (payload.files_modified || 0) + (payload.files_deleted || 0);
        if (filesChanged > 0) {
          unverifiedChangesCount += filesChanged;
          // Unverified changes indicate missing checkpoints - integrity issue
          integrityCompromised = true;
          integrityIssues.push({
            type: 'missing_checkpoint',
            description: `${filesChanged} unverified file change(s) detected between sessions. These changes were made without active telemetry tracking.`,
          });
        }
      }

      // Check integrity
      if (signal.type === 'INTEGRITY_COMPROMISED' && signal.payload) {
        integrityCompromised = true;
        const payload = signal.payload as any;
        integrityIssues.push({
          type: payload.reason || 'unknown',
          description: payload.description || 'Integrity compromised',
        });
      }

      // Track session start/end times
      if (signal.type === 'SESSION_START') {
        if (!firstSessionStart || signal.timestamp < firstSessionStart) {
          firstSessionStart = signal.timestamp;
        }
      }
      if (signal.type === 'SESSION_END') {
        if (!lastSessionEnd || signal.timestamp > lastSessionEnd) {
          lastSessionEnd = signal.timestamp;
        }
      }
    }

    // Add tamper flags to integrity issues
    if (tamperFlags.length > 0) {
      integrityCompromised = true;
      for (const flag of tamperFlags) {
        integrityIssues.push({
          type: `tamper_flag_${flag.type}`,
          description: flag.description,
        });
      }
    }

    return reply.send({
      assignment_id: id,
      device_id: studentId,
      integrity: {
        passed: !integrityCompromised,
        issues: integrityIssues,
        tamper_flags: {
          count: tamperFlags.length,
          flags: tamperFlags.map((flag) => ({
            id: flag.id,
            type: flag.type,
            description: flag.description,
            detected_at_seq: flag.detectedAtSeq,
            reviewed: flag.reviewed,
            created_at: flag.createdAt.toISOString(),
          })),
        },
        checkpoint_state: deviceCheckpoint ? {
          last_checkpoint_id: deviceCheckpoint.lastCheckpointId,
          has_discontinuity: deviceCheckpoint.hasDiscontinuity,
          session_count: deviceCheckpoint.sessionCount,
          state_hash: deviceCheckpoint.stateHash,
        } : null,
      },
      time: {
        total_focused_seconds: totalFocusedSeconds,
        total_active_seconds: totalActiveSeconds,
        session_count: sessions.size,
        first_session_start: firstSessionStart?.toISOString() ?? null,
        last_session_end: lastSessionEnd?.toISOString() ?? null,
      },
      bursts: {
        total_count: burstCount,
        by_severity: burstBySeverity,
      },
      checkpoints: {
        count: checkpointCount,
        latest_checkpoint_id: deviceCheckpoint?.lastCheckpointId ?? null,
      },
      unverified_changes: unverifiedChangesCount,
    });
  });
}
