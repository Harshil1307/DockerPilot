-- Add private, append-only account activity history.
CREATE TYPE "ActivityStatus" AS ENUM ('SUCCEEDED', 'FAILED');

CREATE TABLE "Activity" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "projectId" UUID,
    "actionType" VARCHAR(64) NOT NULL,
    "resourceType" VARCHAR(32) NOT NULL,
    "resourceId" VARCHAR(128),
    "resourceName" VARCHAR(255),
    "status" "ActivityStatus" NOT NULL,
    "summary" VARCHAR(500) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Activity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Activity_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "Activity_userId_createdAt_id_idx" ON "Activity"("userId", "createdAt", "id");
CREATE INDEX "Activity_projectId_createdAt_idx" ON "Activity"("projectId", "createdAt");
