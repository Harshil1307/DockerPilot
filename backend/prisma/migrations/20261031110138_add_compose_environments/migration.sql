-- CreateEnum
CREATE TYPE "ComposeValidationStatus" AS ENUM ('NOT_VALIDATED', 'VALID', 'INVALID');

-- CreateTable
CREATE TABLE "ComposeEnvironment" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "composeYaml" TEXT NOT NULL,
    "validationStatus" "ComposeValidationStatus" NOT NULL DEFAULT 'NOT_VALIDATED',
    "projectId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComposeEnvironment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ComposeEnvironment_projectId_updatedAt_idx" ON "ComposeEnvironment"("projectId", "updatedAt");

-- AddForeignKey
ALTER TABLE "ComposeEnvironment" ADD CONSTRAINT "ComposeEnvironment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
