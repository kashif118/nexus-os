-- AlterTable
ALTER TABLE "BillingEvent" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "providerCreatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "lastProviderEventAt" TIMESTAMP(3);
