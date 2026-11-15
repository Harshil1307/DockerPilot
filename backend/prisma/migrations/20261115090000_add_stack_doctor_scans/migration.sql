CREATE TABLE "StackDoctorScan" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "report" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StackDoctorScan_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StackDoctorScan_projectId_createdAt_idx" ON "StackDoctorScan"("projectId", "createdAt");
ALTER TABLE "StackDoctorScan" ADD CONSTRAINT "StackDoctorScan_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
