-- Add retryable Compose resource cleanup state and persist exact Engine identifiers.
ALTER TYPE "ComposeDeploymentStatus" ADD VALUE IF NOT EXISTS 'CLEANING';
ALTER TYPE "ComposeDeploymentStatus" ADD VALUE IF NOT EXISTS 'CLEANUP_FAILED';
ALTER TYPE "ComposeDeploymentStatus" ADD VALUE IF NOT EXISTS 'REMOVED';

ALTER TABLE "ComposeEnvironment"
    ADD COLUMN "deploymentContainerIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "deploymentNetworkIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
