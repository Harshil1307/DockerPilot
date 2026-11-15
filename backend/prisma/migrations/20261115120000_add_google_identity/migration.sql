ALTER TABLE "User" ADD COLUMN "googleSubject" VARCHAR(255);
CREATE UNIQUE INDEX "User_googleSubject_key" ON "User"("googleSubject");
