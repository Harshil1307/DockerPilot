-- Store account-owned local agents and single-use pairing challenges.
-- Credentials and pairing codes are stored only as SHA-256 hashes.
CREATE TABLE "LocalAgent" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "credentialHash" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "LocalAgent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LocalAgent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "LocalAgent_credentialHash_key" ON "LocalAgent"("credentialHash");
CREATE INDEX "LocalAgent_userId_revokedAt_createdAt_idx" ON "LocalAgent"("userId", "revokedAt", "createdAt");

CREATE TABLE "LocalAgentPairingChallenge" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "codeHash" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "LocalAgentPairingChallenge_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LocalAgentPairingChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "LocalAgentPairingChallenge_codeHash_key" ON "LocalAgentPairingChallenge"("codeHash");
CREATE INDEX "LocalAgentPairingChallenge_userId_createdAt_idx" ON "LocalAgentPairingChallenge"("userId", "createdAt");
CREATE INDEX "LocalAgentPairingChallenge_expiresAt_idx" ON "LocalAgentPairingChallenge"("expiresAt");
