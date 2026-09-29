-- CreateEnum
CREATE TYPE "AIExecutionKind" AS ENUM ('GENERATE', 'STREAM', 'EMBED', 'TOOL');

-- CreateEnum
CREATE TYPE "AIExecutionStatus" AS ENUM ('SUCCEEDED', 'FAILED', 'REFUSED', 'BUDGET_EXCEEDED');

-- CreateEnum
CREATE TYPE "AIInsightKind" AS ENUM ('OVERDUE_INVOICES', 'STALLED_DEALS', 'AT_RISK_PROJECTS', 'WORKLOAD_IMBALANCE', 'EXPENSE_BACKLOG', 'UNBILLED_WORK');

-- CreateEnum
CREATE TYPE "AIInsightSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateTable
CREATE TABLE "AIExecution" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "AIExecutionKind" NOT NULL,
    "status" "AIExecutionStatus" NOT NULL,
    "purpose" TEXT NOT NULL,
    "model" TEXT,
    "provider" TEXT,
    "toolName" TEXT,
    "actorId" TEXT,
    "actorType" TEXT NOT NULL DEFAULT 'USER',
    "conversationId" TEXT,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "costMicros" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIUsageCounter" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "costMicros" INTEGER NOT NULL DEFAULT 0,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AIUsageCounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIInsight" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "AIInsightKind" NOT NULL,
    "severity" "AIInsightSeverity" NOT NULL DEFAULT 'INFO',
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "requiredPermission" TEXT,
    "dismissedAt" TIMESTAMP(3),
    "dismissedByMembershipId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIInsight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIConversation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "title" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "AIConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIMessage" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "toolCalls" JSONB,
    "citations" JSONB,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AIExecution_organizationId_createdAt_idx" ON "AIExecution"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "AIExecution_organizationId_purpose_createdAt_idx" ON "AIExecution"("organizationId", "purpose", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AIUsageCounter_organizationId_periodStart_key" ON "AIUsageCounter"("organizationId", "periodStart");

-- CreateIndex
CREATE INDEX "AIInsight_organizationId_severity_computedAt_idx" ON "AIInsight"("organizationId", "severity", "computedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AIInsight_organizationId_dedupeKey_key" ON "AIInsight"("organizationId", "dedupeKey");

-- CreateIndex
CREATE INDEX "AIConversation_organizationId_membershipId_updatedAt_idx" ON "AIConversation"("organizationId", "membershipId", "updatedAt");

-- CreateIndex
CREATE INDEX "AIMessage_organizationId_conversationId_createdAt_idx" ON "AIMessage"("organizationId", "conversationId", "createdAt");

-- AddForeignKey
ALTER TABLE "AIExecution" ADD CONSTRAINT "AIExecution_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIUsageCounter" ADD CONSTRAINT "AIUsageCounter_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIInsight" ADD CONSTRAINT "AIInsight_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIInsight" ADD CONSTRAINT "AIInsight_dismissedByMembershipId_fkey" FOREIGN KEY ("dismissedByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIConversation" ADD CONSTRAINT "AIConversation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIConversation" ADD CONSTRAINT "AIConversation_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIMessage" ADD CONSTRAINT "AIMessage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIMessage" ADD CONSTRAINT "AIMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AIConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

