import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { WebSocket, type RawData } from 'ws';
import { z } from 'zod';
import { executeLocalAgentOperation, isAllowedLocalAgentOperation, safeAgentError } from './operations.js';

const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const configSchema = z.object({
  apiBaseUrl: z.string().url(),
  agentId: z.string().uuid(),
  userId: z.string().uuid(),
  name: z.string().min(1).max(100),
  credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();
const incomingRequestSchema = z.object({
  type: z.literal('request'),
  id: z.string().uuid(),
  userId: z.string().uuid(),
  operation: z.string().min(1).max(100),
  payload: z.unknown(),
  expiresAt: z.number().int().positive(),
}).strict();

type AgentConfig = z.infer<typeof configSchema>;
const configPath = process.env.DOCKERPILOT_AGENT_CONFIG?.trim() || join(homedir(), '.dockerpilot', 'agent.json');

function apiBaseUrl(): string {
  const value = process.env.DOCKERPILOT_AGENT_API_URL?.trim() || 'https://dockerpilot-api.onrender.com/api';
  const parsed = new URL(value);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Agent API URL must be an HTTP(S) URL without credentials, query strings, or fragments.');
  }
  if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
    throw new Error('The local agent requires HTTPS for remote API connections.');
  }
  return value.replace(/\/$/, '');
}

function websocketUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}/agents/connect`;
  return parsed.toString();
}

async function saveConfig(config: AgentConfig): Promise<void> {
  const directory = dirname(configPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(configPath, 0o600).catch(() => undefined);
}

async function loadConfig(): Promise<AgentConfig> {
  const content = await readFile(configPath, 'utf8');
  if (process.platform !== 'win32') {
    const { mode } = await import('node:fs/promises').then(({ stat }) => stat(configPath));
    if ((mode & 0o077) !== 0) throw new Error(`Agent credentials are readable by other users. Restrict permissions on ${configPath} to owner only.`);
  }
  const parsed = configSchema.safeParse(JSON.parse(content));
  if (!parsed.success) throw new Error(`Agent credentials file is invalid: ${configPath}`);
  return parsed.data;
}

async function pairingCodeFromPrompt(): Promise<string> {
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    const code = (await terminal.question('Paste the one-time DockerPilot pairing code: ')).trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(code)) throw new Error('Pairing code format is invalid. Generate a fresh code on the DockerPilot site.');
    return code;
  } finally {
    terminal.close();
  }
}

async function pair(): Promise<AgentConfig> {
  const baseUrl = apiBaseUrl();
  const code = await pairingCodeFromPrompt();
  const response = await fetch(`${baseUrl}/agents/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, name: `DockerPilot on ${process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'this computer'}` }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => null) as {
    error?: string;
    agent?: { id: string; userId: string; name: string };
    credential?: string;
  } | null;
  if (!response.ok || !body?.agent || !body.credential) {
    throw new Error(body?.error ?? 'Could not pair this computer. Generate a fresh code and try again.');
  }
  const config = configSchema.parse({
    apiBaseUrl: baseUrl,
    agentId: body.agent.id,
    userId: body.agent.userId,
    name: body.agent.name,
    credential: body.credential,
  });
  await saveConfig(config);
  console.info(`Paired ${config.name}. Credentials saved privately in ${configPath}.`);
  return config;
}

function sendJson(socket: WebSocket, value: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  const message = JSON.stringify(value);
  if (Buffer.byteLength(message, 'utf8') > MAX_MESSAGE_BYTES) {
    throw new Error('Agent response exceeded its size limit.');
  }
  socket.send(message);
}

function handleMessage(socket: WebSocket, config: AgentConfig, raw: RawData, seenRequests: Set<string>): void {
  const data = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(new Uint8Array(raw as ArrayBuffer));
  if (data.byteLength > MAX_MESSAGE_BYTES) {
    socket.close(1009, 'Message too large');
    return;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(data.toString('utf8')); } catch {
    socket.close(1007, 'Invalid JSON');
    return;
  }
  const request = incomingRequestSchema.safeParse(parsed);
  if (!request.success) {
    socket.close(1008, 'Invalid request');
    return;
  }
  const message = request.data;
  if (seenRequests.has(message.id)) {
    socket.close(1008, 'Duplicate request');
    return;
  }
  seenRequests.add(message.id);
  if (seenRequests.size > 2048) seenRequests.delete(seenRequests.values().next().value!);

  void (async () => {
    try {
      if (message.userId !== config.userId) throw new Error('Request account does not match this paired agent.');
      if (message.payload && typeof message.payload === 'object' && !Array.isArray(message.payload)) {
        const payload = message.payload as { userId?: unknown; identity?: { ownerId?: unknown } };
        if ((typeof payload.userId === 'string' && payload.userId !== config.userId)
          || (typeof payload.identity?.ownerId === 'string' && payload.identity.ownerId !== config.userId)) {
          throw new Error('Request account does not match this paired agent.');
        }
      }
      if (message.expiresAt <= Date.now()) throw new Error('This Docker request expired.');
      if (!isAllowedLocalAgentOperation(message.operation)) throw new Error('This Docker operation is not permitted.');
      const result = await executeLocalAgentOperation(message.operation, message.payload, (progress) => {
        sendJson(socket, { type: 'progress', id: message.id, data: progress });
      }, config.userId);
      sendJson(socket, { type: 'response', id: message.id, ok: true, result });
    } catch (error) {
      const safeError = error instanceof Error && error.message === 'Request account does not match this paired agent.'
        ? { message: error.message, statusCode: 403, code: 'AGENT_ACCOUNT_MISMATCH' }
        : error instanceof Error && error.message === 'This Docker request expired.'
          ? { message: error.message, statusCode: 408, code: 'AGENT_REQUEST_EXPIRED' }
          : error instanceof Error && error.message === 'This Docker operation is not permitted.'
            ? { message: error.message, statusCode: 403, code: 'AGENT_OPERATION_NOT_ALLOWED' }
            : safeAgentError(error);
      sendJson(socket, { type: 'response', id: message.id, ok: false, error: safeError });
    }
  })();
}

async function connectOnce(config: AgentConfig): Promise<'retry' | 'stop'> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(websocketUrl(config.apiBaseUrl), {
      headers: { Authorization: `Bearer ${config.credential}` },
      maxPayload: MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
      handshakeTimeout: 15_000,
    });
    const seenRequests = new Set<string>();
    let opened = false;
    socket.once('open', () => {
      opened = true;
      console.info(`Connected to DockerPilot as ${config.name}. Keep this terminal open while using the hosted site.`);
    });
    socket.on('message', (raw) => handleMessage(socket, config, raw, seenRequests));
    socket.once('error', (error) => {
      if (!opened) reject(error);
    });
    socket.once('close', (code) => {
      if (code === 4003 || code === 4009) {
        console.error(code === 4003 ? 'This agent was revoked. Pair this computer again to reconnect.' : 'Another computer is already connected to this account. Disconnect it before retrying.');
        resolve('stop');
        return;
      }
      resolve('retry');
    });
  });
}

export async function runAgent(): Promise<void> {
  const config = await loadConfig();
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let backoffMs = 1_000;
  try {
    while (!stopping) {
      let result: 'retry' | 'stop';
      try { result = await connectOnce(config); }
      catch (error) {
        console.error(`Could not connect to DockerPilot: ${error instanceof Error ? error.message : 'connection error'}`);
        result = 'retry';
      }
      if (result === 'stop') return;
      if (stopping) return;
      console.info('Connection lost. Retrying shortly.');
      await delay(backoffMs + Math.floor(Math.random() * 500));
      backoffMs = Math.min(backoffMs * 2, 30_000);
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'pair') {
    await pair();
    await runAgent();
    return;
  }
  if (command === 'start') {
    await runAgent();
    return;
  }
  console.info('Usage: npm run agent --workspace @dockerpilot/backend -- pair|start');
  process.exitCode = 2;
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('/agent/client.ts')
  || process.argv[1]?.replace(/\\/g, '/').endsWith('/agent/client.js')) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'The DockerPilot agent failed to start.');
    process.exitCode = 1;
  });
}
