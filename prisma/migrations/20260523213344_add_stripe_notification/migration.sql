/*
  Warnings:

  - Added the required column `updatedAt` to the `Package` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Package" ADD COLUMN     "stripePriceId" TEXT,
ADD COLUMN     "stripeProductId" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- CreateTable
CREATE TABLE "NotificationLog" (
    "id" TEXT NOT NULL,
    "eventId" TEXT,
    "recipientType" TEXT NOT NULL,
    "recipientEmail" TEXT,
    "channel" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NotificationLog_eventId_trigger_idx" ON "NotificationLog"("eventId", "trigger");

-- CreateIndex
CREATE INDEX "Event_stripeSessionId_idx" ON "Event"("stripeSessionId");
