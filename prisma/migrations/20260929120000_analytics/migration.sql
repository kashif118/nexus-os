-- CreateEnum
CREATE TYPE "MetricPeriod" AS ENUM ('DAY', 'WEEK', 'MONTH');

-- CreateTable
CREATE TABLE "MetricSnapshot" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "dimension" TEXT,
    "dimensionId" TEXT,
    "periodType" "MetricPeriod" NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "valueNumeric" DOUBLE PRECISION,
    "valueMinor" BIGINT,
    "currency" CHAR(3),
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetricSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MetricSnapshot_organizationId_metric_periodStart_idx" ON "MetricSnapshot"("organizationId", "metric", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "MetricSnapshot_organizationId_metric_dimension_dimensionId__key" ON "MetricSnapshot"("organizationId", "metric", "dimension", "dimensionId", "periodType", "periodStart");

-- AddForeignKey
ALTER TABLE "MetricSnapshot" ADD CONSTRAINT "MetricSnapshot_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

