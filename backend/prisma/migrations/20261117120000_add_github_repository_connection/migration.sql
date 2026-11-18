ALTER TABLE "Project"
  ADD COLUMN "repositoryOwner" VARCHAR(100),
  ADD COLUMN "repositoryName" VARCHAR(100),
  ADD COLUMN "repositoryDefaultBranch" VARCHAR(255),
  ADD COLUMN "repositoryStatus" VARCHAR(24) NOT NULL DEFAULT 'disconnected',
  ADD COLUMN "repositoryError" VARCHAR(300),
  ADD COLUMN "repositoryVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "githubTokenEncrypted" TEXT;

UPDATE "Project"
SET "repositoryStatus" = 'pending'
WHERE "repositoryUrl" IS NOT NULL;
