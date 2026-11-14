import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '../config/prisma.js';
import { AppError } from '../errors/app-error.js';

const PAIRING_TTL_MS = 5 * 60 * 1000;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export const localAgentService = {
  async createPairingChallenge(userId: string) {
    const code = randomBytes(32).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS);

    await prisma.$transaction([
      prisma.localAgentPairingChallenge.deleteMany({ where: { OR: [{ userId }, { expiresAt: { lte: now } }] } }),
      prisma.localAgentPairingChallenge.create({
        data: { userId, codeHash: sha256(code), expiresAt },
        select: { id: true },
      }),
    ]);

    return { code, expiresAt };
  },

  async pair(code: string, name: string) {
    const credential = randomBytes(32).toString('base64url');
    const codeHash = sha256(code);
    const now = new Date();

    const agent = await prisma.$transaction(async (transaction) => {
      const challenge = await transaction.localAgentPairingChallenge.findUnique({
        where: { codeHash },
        select: { id: true, userId: true, expiresAt: true, consumedAt: true },
      });
      if (!challenge || challenge.consumedAt || challenge.expiresAt <= now) {
        throw new AppError('Pairing code is invalid or expired.', 400, 'PAIRING_CODE_INVALID');
      }

      const claimed = await transaction.localAgentPairingChallenge.updateMany({
        where: { id: challenge.id, consumedAt: null, expiresAt: { gt: now } },
        data: { consumedAt: now },
      });
      if (claimed.count !== 1) {
        throw new AppError('Pairing code is invalid or expired.', 400, 'PAIRING_CODE_INVALID');
      }

      return transaction.localAgent.create({
        data: { userId: challenge.userId, name, credentialHash: sha256(credential) },
        select: { id: true, userId: true, name: true, createdAt: true },
      });
    });

    return { agent, credential };
  },

  async list(userId: string) {
    return prisma.localAgent.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, createdAt: true, lastSeenAt: true, revokedAt: true },
    });
  },

  async revoke(userId: string, agentId: string): Promise<void> {
    const result = await prisma.localAgent.updateMany({
      where: { id: agentId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count !== 1) throw new AppError('Local agent not found.', 404, 'LOCAL_AGENT_NOT_FOUND');
  },

  async authenticate(credential: string) {
    return prisma.localAgent.findFirst({
      where: { credentialHash: sha256(credential), revokedAt: null },
      select: { id: true, userId: true },
    });
  },

  async markSeen(agentId: string): Promise<void> {
    await prisma.localAgent.updateMany({ where: { id: agentId, revokedAt: null }, data: { lastSeenAt: new Date() } });
  },
};
