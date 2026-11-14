import { app } from './app.js';
import { env } from './config/env.js';
import { prisma } from './config/prisma.js';
import { attachLocalAgentRelay } from './services/local-agent-relay.js';

const server = app.listen(env.PORT, '0.0.0.0', () => {
  console.info(`[api] DockerPilot API listening on port ${env.PORT}`);
});
attachLocalAgentRelay(server);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`[api] Received ${signal}; shutting down.`);

  const forceExit = setTimeout(() => {
    console.error('[api] Graceful shutdown timed out.');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  server.close(async (error) => {
    try {
      await prisma.$disconnect();
      if (error) {
        console.error('[api] HTTP server did not close cleanly.');
        process.exitCode = 1;
      }
    } catch {
      console.error('[api] Database connection did not close cleanly.');
      process.exitCode = 1;
    } finally {
      clearTimeout(forceExit);
    }
  });
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
