-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('VIDEO', 'VOICE', 'PHOTO');

-- CreateTable
CREATE TABLE "MediaItem" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "type" "MediaType" NOT NULL,
    "storagePath" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "qualityScore" DOUBLE PRECISION,
    "qualityFlags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "duration" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MediaItem_submissionId_idx" ON "MediaItem"("submissionId");

-- AddForeignKey
ALTER TABLE "MediaItem" ADD CONSTRAINT "MediaItem_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
