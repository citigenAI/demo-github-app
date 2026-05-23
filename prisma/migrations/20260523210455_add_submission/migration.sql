-- CreateEnum
CREATE TYPE "SubmissionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'FLAGGED');

-- CreateTable
CREATE TABLE "Submission" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "contributorName" TEXT NOT NULL,
    "relationship" TEXT NOT NULL,
    "email" TEXT,
    "textMessage" TEXT,
    "funnyMemory" TEXT,
    "advice" TEXT,
    "professionalNote" TEXT,
    "consentGiven" BOOLEAN NOT NULL,
    "consentAt" TIMESTAMP(3) NOT NULL,
    "status" "SubmissionStatus" NOT NULL DEFAULT 'PENDING',
    "adminNote" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,

    CONSTRAINT "Submission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Submission_eventId_status_idx" ON "Submission"("eventId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Submission_eventId_email_key" ON "Submission"("eventId", "email");

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
