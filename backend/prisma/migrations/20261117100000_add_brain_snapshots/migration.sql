CREATE TABLE "BrainSnapshot" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "sampledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "data" JSONB NOT NULL,
    CONSTRAINT "BrainSnapshot_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BrainSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "BrainSnapshot_userId_sampledAt_idx" ON "BrainSnapshot"("userId", "sampledAt");
