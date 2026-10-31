-- CreateEnum
CREATE TYPE "ComposeDeploymentStatus" AS ENUM ('NOT_DEPLOYED', 'DEPLOYING', 'RUNNING', 'FAILED', 'STOPPED');

-- AlterTable
ALTER TABLE "ComposeEnvironment"
    ADD COLUMN "deploymentStatus" "ComposeDeploymentStatus" NOT NULL DEFAULT 'NOT_DEPLOYED',
    ADD COLUMN "deploymentProjectName" VARCHAR(63),
    ADD COLUMN "deploymentStartedAt" TIMESTAMP(3),
    ADD COLUMN "deploymentCompletedAt" TIMESTAMP(3),
    ADD COLUMN "lastDeploymentError" VARCHAR(500);

-- CreateIndex
CREATE UNIQUE INDEX "ComposeEnvironment_deploymentProjectName_key" ON "ComposeEnvironment"("deploymentProjectName");
CREATE INDEX "ComposeEnvironment_deploymentStatus_idx" ON "ComposeEnvironment"("deploymentStatus");
