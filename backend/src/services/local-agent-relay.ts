import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { currentAuthenticatedUserId } from '../auth/request-context.js';
import { AppError } from '../errors/app-error.js';
import { localAgentService } from './local-agent.service.js';

const CONNECT_PATH = '/api/agents/connect';
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_PER_AGENT = 16;
const HEARTBEAT_INTERVAL_MS = 25_000;
const responseEnvelopeSchema = z.object({
  type: z.literal('response'),
  id: z.string().uuid(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.object({
    message: z.string().max(500),
    statusCode: z.number().int().min(400).max(599),
    code: z.string().regex(/^[A-Z0-9_]{1,64}$/),
  }).optional(),
}).strict();
const progressEnvelopeSchema = z.object({ type: z.literal('progress'), id: z.string().uuid(), data: z.unknown() }).strict();

interface ConnectedAgent {
  agentId: string;
  userId: string;
  socket: WebSocket;
}

interface PendingRequest {
  agentId: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  onProgress?: (data: unknown) => void;
}

const agents = new Map<string, ConnectedAgent>();
const userConnections = new Map<string, string>();
const pendingRequests = new Map<string, PendingRequest>();

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  if (socket.destroyed) return;
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function bearerCredential(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
  return match?.[1] ?? null;
}

function failPending(agentId: string, error: Error): void {
  for (const [id, pending] of pendingRequests) {
    if (pending.agentId !== agentId) continue;
    clearTimeout(pending.timeout);
    pendingRequests.delete(id);
    pending.reject(error);
  }
}

function reviveBuffers(_key: string, value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const candidate = value as { type?: unknown; data?: unknown };
  if (candidate.type === 'Buffer' && Array.isArray(candidate.data)
    && candidate.data.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    return Buffer.from(candidate.data as number[]);
  }
  return value;
}

function removeAgentConnection(agentId: string, socket: WebSocket): void {
  const connection = agents.get(agentId);
  if (!connection || connection.socket !== socket) return;
  agents.delete(agentId);
  if (userConnections.get(connection.userId) === agentId) userConnections.delete(connection.userId);
  failPending(agentId, new AppError('The local Docker agent disconnected.', 503, 'LOCAL_AGENT_DISCONNECTED'));
}

function connectAuthenticatedAgent(server: WebSocketServer, request: IncomingMessage, socket: Duplex, head: Buffer): void {
  void (async () => {
    try {
      // Browser-originated sockets are never part of the protocol. Only the
      // separately installed agent may connect, using its revocable credential.
      if (request.headers.origin) {
        rejectUpgrade(socket, 403, 'Forbidden');
        return;
      }
      const credential = bearerCredential(request);
      if (!credential) {
        rejectUpgrade(socket, 401, 'Unauthorized');
        return;
      }
      const identity = await localAgentService.authenticate(credential);
      if (!identity) {
        rejectUpgrade(socket, 401, 'Unauthorized');
        return;
      }

      const currentAgentId = userConnections.get(identity.userId);
      if (currentAgentId && currentAgentId !== identity.id) {
        const current = agents.get(currentAgentId);
        if (current?.socket.readyState === WebSocket.OPEN) {
          rejectUpgrade(socket, 409, 'Agent Already Connected');
          return;
        }
        userConnections.delete(identity.userId);
      }

      const ws = server;
      // handleUpgrade is supplied by the owning WebSocketServer; the parameter
      // name keeps this async authentication path independent of server setup.
      const connection = await new Promise<WebSocket>((resolve, reject) => {
        ws.handleUpgrade(request, socket, head, resolve);
        socket.once('error', reject);
      });

      const previous = agents.get(identity.id);
      if (previous) {
        failPending(identity.id, new AppError('The local Docker agent reconnected.', 503, 'LOCAL_AGENT_RECONNECTED'));
        previous.socket.close(4001, 'Agent reconnected');
      }
      agents.set(identity.id, { agentId: identity.id, userId: identity.userId, socket: connection });
      userConnections.set(identity.userId, identity.id);
      await localAgentService.markSeen(identity.id);

      connection.on('message', (raw) => {
        const data = Buffer.isBuffer(raw)
          ? raw
          : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(new Uint8Array(raw as ArrayBuffer));
        if (data.byteLength > MAX_MESSAGE_BYTES) {
          connection.close(1009, 'Message too large');
          return;
        }
        let parsed: unknown;
        try { parsed = JSON.parse(data.toString('utf8'), reviveBuffers); } catch {
          connection.close(1007, 'Invalid JSON');
          return;
        }
        const progress = progressEnvelopeSchema.safeParse(parsed);
        if (progress.success) {
          const pending = pendingRequests.get(progress.data.id);
          if (pending?.agentId === identity.id) pending.onProgress?.(progress.data.data);
          return;
        }
        const envelope = responseEnvelopeSchema.safeParse(parsed);
        if (!envelope.success) {
          connection.close(1008, 'Invalid response');
          return;
        }
        const pending = pendingRequests.get(envelope.data.id);
        if (!pending || pending.agentId !== identity.id) return;
        clearTimeout(pending.timeout);
        pendingRequests.delete(envelope.data.id);
        if (envelope.data.ok) pending.resolve(envelope.data.result);
        else pending.reject(new AppError(
          envelope.data.error?.message ?? 'The local agent could not complete the request.',
          envelope.data.error?.statusCode ?? 502,
          envelope.data.error?.code ?? 'LOCAL_AGENT_OPERATION_FAILED',
        ));
        void localAgentService.markSeen(identity.id).catch(() => undefined);
      });

      connection.on('pong', () => {
        void localAgentService.markSeen(identity.id).catch(() => undefined);
      });
      connection.on('close', () => removeAgentConnection(identity.id, connection));
      connection.on('error', () => removeAgentConnection(identity.id, connection));
    } catch {
      rejectUpgrade(socket, 503, 'Service Unavailable');
    }
  })();
}

export function attachLocalAgentRelay(server: Server): void {
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
  server.on('upgrade', (request, socket, head) => {
    let pathname: string;
    try { pathname = new URL(request.url ?? '/', 'http://localhost').pathname; }
    catch { rejectUpgrade(socket, 400, 'Bad Request'); return; }
    if (pathname !== CONNECT_PATH) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    connectAuthenticatedAgent(webSocketServer, request, socket, head);
  });

  const heartbeat = setInterval(() => {
    for (const connection of agents.values()) {
      if (connection.socket.readyState !== WebSocket.OPEN) continue;
      connection.socket.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();
  server.once('close', () => {
    clearInterval(heartbeat);
    for (const connection of agents.values()) connection.socket.close(1001, 'API shutting down');
    agents.clear();
    userConnections.clear();
    for (const id of pendingRequests.keys()) {
      const pending = pendingRequests.get(id);
      if (!pending) continue;
      clearTimeout(pending.timeout);
      pending.reject(new AppError('The hosted API is shutting down.', 503, 'LOCAL_AGENT_UNAVAILABLE'));
    }
    pendingRequests.clear();
  });
}

export function isLocalAgentConnected(agentId: string): boolean {
  return agents.get(agentId)?.socket.readyState === WebSocket.OPEN;
}

export function disconnectLocalAgent(agentId: string): void {
  const connection = agents.get(agentId);
  if (!connection) return;
  failPending(agentId, new AppError('The local Docker agent was revoked.', 401, 'LOCAL_AGENT_REVOKED'));
  connection.socket.close(4003, 'Agent revoked');
  removeAgentConnection(agentId, connection.socket);
}

export async function requestLocalAgent<T>(
  operation: string,
  payload: unknown,
  options: { timeoutMs?: number; onProgress?: (data: unknown) => void } = {},
): Promise<T> {
  const userId = currentAuthenticatedUserId();
  if (!userId) throw new AppError('Authentication required.', 401, 'AUTH_REQUIRED');
  const agentId = userConnections.get(userId);
  const connection = agentId ? agents.get(agentId) : undefined;
  if (!agentId || !connection || connection.socket.readyState !== WebSocket.OPEN) {
    throw new AppError('No local Docker agent is connected. Start the DockerPilot agent on your computer and try again.', 503, 'LOCAL_AGENT_UNAVAILABLE');
  }
  const pendingCount = [...pendingRequests.values()].filter((pending) => pending.agentId === agentId).length;
  if (pendingCount >= MAX_PENDING_PER_AGENT) {
    throw new AppError('The local Docker agent is busy. Wait for a current operation to finish.', 429, 'LOCAL_AGENT_BUSY');
  }
  const id = randomUUID();
  const timeoutMs = options.timeoutMs ?? 20_000;
  const message = JSON.stringify({ type: 'request', id, operation, userId, payload, expiresAt: Date.now() + timeoutMs });
  if (Buffer.byteLength(message, 'utf8') > MAX_MESSAGE_BYTES) {
    throw new AppError('The Docker request is too large.', 413, 'LOCAL_AGENT_REQUEST_TOO_LARGE');
  }

  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new AppError('The local Docker agent did not respond in time.', 504, 'LOCAL_AGENT_TIMEOUT'));
    }, timeoutMs);
    pendingRequests.set(id, { agentId, resolve: (result) => resolve(result as T), reject, timeout, onProgress: options.onProgress });
    connection.socket.send(message, (error) => {
      if (!error) return;
      const pending = pendingRequests.get(id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      pendingRequests.delete(id);
      reject(new AppError('Could not send a request to the local Docker agent.', 503, 'LOCAL_AGENT_UNAVAILABLE'));
    });
  });
}
