-- CreateTable
CREATE TABLE "device_checkpoints" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "lastCheckpointId" TEXT,
    "stateHash" TEXT NOT NULL DEFAULT '',
    "seq" INTEGER NOT NULL DEFAULT 0,
    "sessionCount" INTEGER NOT NULL DEFAULT 0,
    "totalFocusedSeconds" INTEGER NOT NULL DEFAULT 0,
    "hasDiscontinuity" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tamper_flags" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "detectedAtSeq" INTEGER NOT NULL,
    "signalId" TEXT,
    "previousCheckpointId" TEXT,
    "newCheckpointId" TEXT,
    "reviewed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tamper_flags_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "device_checkpoints_deviceId_idx" ON "device_checkpoints"("deviceId");

-- CreateIndex
CREATE INDEX "device_checkpoints_assignmentId_idx" ON "device_checkpoints"("assignmentId");

-- CreateIndex
CREATE UNIQUE INDEX "device_checkpoints_deviceId_assignmentId_key" ON "device_checkpoints"("deviceId", "assignmentId");

-- CreateIndex
CREATE INDEX "tamper_flags_deviceId_idx" ON "tamper_flags"("deviceId");

-- CreateIndex
CREATE INDEX "tamper_flags_assignmentId_idx" ON "tamper_flags"("assignmentId");

-- CreateIndex
CREATE INDEX "tamper_flags_reviewed_idx" ON "tamper_flags"("reviewed");

-- AddForeignKey
ALTER TABLE "device_checkpoints" ADD CONSTRAINT "device_checkpoints_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tamper_flags" ADD CONSTRAINT "tamper_flags_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
