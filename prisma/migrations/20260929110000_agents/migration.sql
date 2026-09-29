-- CreateEnum
CREATE TYPE "AgentRunStatus" AS ENUM ('RUNNING', 'AWAITING_CONFIRMATION', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AgentAutonomy" AS ENUM ('SUGGEST', 'AUTONOMOUS');

-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'FAILED');

-- CreateTable
CREATE TABLE "AIAgentConfig" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "agentKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "autonomy" "AgentAutonomy" NOT NULL DEFAULT 'SUGGEST',
    "ownerMembershipId" TEXT,
    "extraInstructions" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AIAgentConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIAgentRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "agentKey" TEXT NOT NULL,
    "status" "AgentRunStatus" NOT NULL DEFAULT 'RUNNING',
    "trigger" TEXT NOT NULL,
    "input" JSONB,
    "summary" TEXT,
    "actingMembershipId" TEXT,
    "startedById" TEXT,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "costMicros" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "AIAgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIAgentStep" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "toolName" TEXT,
    "input" JSONB,
    "output" JSONB,
    "error" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIAgentStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIProposal" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "args" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "status" "ProposalStatus" NOT NULL DEFAULT 'PENDING',
    "decidedByMembershipId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "outcome" JSONB,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "AIProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIMemory" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "agentKey" TEXT NOT NULL,
    "membershipId" TEXT,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "AIMemory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AIAgentConfig_organizationId_agentKey_key" ON "AIAgentConfig"("organizationId", "agentKey");

-- CreateIndex
CREATE INDEX "AIAgentRun_organizationId_agentKey_startedAt_idx" ON "AIAgentRun"("organizationId", "agentKey", "startedAt");

-- CreateIndex
CREATE INDEX "AIAgentRun_organizationId_status_idx" ON "AIAgentRun"("organizationId", "status");

-- CreateIndex
CREATE INDEX "AIAgentStep_organizationId_runId_idx" ON "AIAgentStep"("organizationId", "runId");

-- CreateIndex
CREATE UNIQUE INDEX "AIAgentStep_runId_position_key" ON "AIAgentStep"("runId", "position");

-- CreateIndex
CREATE INDEX "AIProposal_organizationId_status_createdAt_idx" ON "AIProposal"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AIProposal_organizationId_idempotencyKey_key" ON "AIProposal"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "AIMemory_organizationId_agentKey_idx" ON "AIMemory"("organizationId", "agentKey");

-- CreateIndex
CREATE UNIQUE INDEX "AIMemory_organizationId_agentKey_membershipId_key_key" ON "AIMemory"("organizationId", "agentKey", "membershipId", "key");

-- AddForeignKey
ALTER TABLE "AIAgentConfig" ADD CONSTRAINT "AIAgentConfig_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIAgentConfig" ADD CONSTRAINT "AIAgentConfig_ownerMembershipId_fkey" FOREIGN KEY ("ownerMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIAgentRun" ADD CONSTRAINT "AIAgentRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIAgentStep" ADD CONSTRAINT "AIAgentStep_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIAgentStep" ADD CONSTRAINT "AIAgentStep_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AIAgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIProposal" ADD CONSTRAINT "AIProposal_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIProposal" ADD CONSTRAINT "AIProposal_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AIAgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIProposal" ADD CONSTRAINT "AIProposal_decidedByMembershipId_fkey" FOREIGN KEY ("decidedByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIMemory" ADD CONSTRAINT "AIMemory_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIMemory" ADD CONSTRAINT "AIMemory_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

