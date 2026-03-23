import { EventEmitter } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import { logger } from '../logger.js';
import { McpError, ErrorCode } from '../errors/index.js';
import {
  createRequest,
  PendingRequests,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './protocol.js';
import { ConnectionStateMachine } from './connection-state.js';
import { CommandQueue } from './command-queue.js';
import {
  DEFAULT_WS_PORT,
  KEEPALIVE_INTERVAL_MS,
  KEEPALIVE_TIMEOUT_MS,
  COMMAND_TIMEOUT_MS,
  SERVER_VERSION,
  type BridgeOptions,
} from '../types.js';

export class Bridge extends EventEmitter {
  private readonly wss: WebSocketServer;
  private readonly readyPromise!: Promise<void>;
  private readonly stateMachine = new ConnectionStateMachine();
  private readonly pendingRequests = new PendingRequests();
  private readonly commandQueue = new CommandQueue(COMMAND_TIMEOUT_MS);
  private readonly port: number;
  private client: WebSocket | null = null;
  private extensionVersionValue: string | null = null;
  private lastErrorValue: string | null = null;
  private keepaliveInterval: ReturnType<typeof setInterval> | null = null;
  private pongTimeout: ReturnType<typeof setTimeout> | null = null;
  private alive = false;

  constructor(options?: BridgeOptions) {
    super();
    this.port = options?.port ?? DEFAULT_WS_PORT;

    // Forward state machine events
    this.stateMachine.on('ws:connected', (payload) =>
      this.emit('ws:connected', payload),
    );
    this.stateMachine.on('ws:disconnected', (payload) =>
      this.emit('ws:disconnected', payload),
    );

    this.wss = new WebSocketServer({
      port: this.port,
      host: '127.0.0.1',
      clientTracking: true,
    });

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.wss.once('listening', () => resolve());
      this.wss.once('error', (err) => reject(err));
    });

    this.wss.on('connection', (ws) => this.handleConnection(ws));
    this.wss.on('listening', () => {
      logger.info('WebSocket server listening', {
        host: '127.0.0.1',
        port: this.port,
      });
    });
    this.wss.on('error', (err) => {
      logger.error('WebSocket server error', { error: err.message });
    });
  }

  private handleConnection(ws: WebSocket): void {
    // Single client only — reject second connection
    if (this.client && this.client.readyState === WebSocket.OPEN) {
      logger.warn('Second client attempted connection — rejecting', {
        existingState: this.stateMachine.current,
      });
      ws.close(1008, 'Only one client allowed');
      return;
    }

    this.client = ws;
    this.alive = true;

    this.stateMachine.transition('connecting');

    ws.on('message', (data) => {
      this.alive = true;
      const raw = data.toString();

      let message: JsonRpcResponse | JsonRpcRequest;
      try {
        message = JSON.parse(raw);
      } catch {
        logger.warn('Received non-JSON message', { raw });
        return;
      }

      // Handshake validation — first message must be a handshake
      if (this.stateMachine.current === 'connecting') {
        if ((message as JsonRpcRequest).method !== 'handshake') {
          const errorResponse = {
            jsonrpc: '2.0',
            id: (message as JsonRpcRequest).id,
            error: { code: -32600, message: 'First message must be handshake' },
          };
          ws.send(JSON.stringify(errorResponse));
          ws.close(1008, 'Expected handshake');
          this.handleClientDisconnect('No handshake received');
          return;
        }

        const params = (message as JsonRpcRequest).params as
          | Record<string, unknown>
          | undefined;
        const extensionVersion = params?.version as string | undefined;
        if (
          !extensionVersion ||
          !isCompatibleVersion(extensionVersion, SERVER_VERSION)
        ) {
          const errorResponse = {
            jsonrpc: '2.0',
            id: (message as JsonRpcRequest).id,
            error: {
              code: -32000,
              message: `Version mismatch: server=${SERVER_VERSION}, extension=${extensionVersion ?? 'unknown'}`,
              data: { serverVersion: SERVER_VERSION, extensionVersion },
            },
          };
          ws.send(JSON.stringify(errorResponse));
          ws.close(1008, 'Version mismatch');
          this.handleClientDisconnect('Handshake failed: version mismatch');
          return;
        }

        // Valid handshake — accept
        this.extensionVersionValue = extensionVersion;
        this.stateMachine.transition('connected', { version: extensionVersion });

        const successResponse = {
          jsonrpc: '2.0',
          id: (message as JsonRpcRequest).id,
          result: { serverVersion: SERVER_VERSION, accepted: true },
        };
        ws.send(JSON.stringify(successResponse));

        this.startKeepalive();
        this.drainQueue();
        return;
      }

      // Route as response (has result or error field — it's a reply to our request)
      if ('id' in message && ('result' in message || 'error' in message)) {
        this.pendingRequests.handleResponse(message as JsonRpcResponse);
      }
    });

    ws.on('close', (code, reason) => {
      logger.info('Client disconnected', {
        code,
        reason: reason.toString(),
      });
      this.handleClientDisconnect('WebSocket closed');
    });

    ws.on('error', (err) => {
      logger.error('Client WebSocket error', { error: err.message });
      this.handleClientDisconnect('WebSocket error');
    });

    ws.on('pong', () => {
      this.alive = true;
      if (this.pongTimeout) {
        clearTimeout(this.pongTimeout);
        this.pongTimeout = null;
      }
    });
  }

  private handleClientDisconnect(reason: string): void {
    this.stopKeepalive();
    this.client = null;
    this.lastErrorValue = reason;
    this.extensionVersionValue = null;

    if (this.stateMachine.current !== 'disconnected') {
      this.stateMachine.transition('disconnected', { reason });
    }
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveInterval = setInterval(() => {
      if (!this.client || this.client.readyState !== WebSocket.OPEN) return;

      this.alive = false;
      this.client.ping();

      this.pongTimeout = setTimeout(() => {
        if (!this.alive) {
          logger.warn('Pong timeout — marking client disconnected');
          this.client?.terminate();
          this.handleClientDisconnect('pong timeout');
        }
      }, KEEPALIVE_TIMEOUT_MS);
    }, KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive(): void {
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
  }

  private async drainQueue(): Promise<void> {
    await this.commandQueue.drain(async (request) => {
      return this.sendDirect(request);
    });
  }

  private sendDirect(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      if (!this.client || this.client.readyState !== WebSocket.OPEN) {
        reject(
          new McpError(
            ErrorCode.EXTENSION_DISCONNECTED,
            'Extension not connected',
            { requestId: request.id },
            'Wait for extension to reconnect.',
            true,
          ),
        );
        return;
      }

      this.pendingRequests.add(
        request.id,
        (result) =>
          resolve({
            jsonrpc: '2.0',
            id: request.id,
            result,
          }),
        reject,
        COMMAND_TIMEOUT_MS,
      );

      this.client.send(JSON.stringify(request), (err) => {
        if (err) {
          logger.error('Failed to send message', {
            requestId: request.id,
            error: err.message,
          });
        }
      });
    });
  }

  async send(method: string, params?: unknown): Promise<unknown> {
    const request = createRequest(method, params);

    if (
      this.stateMachine.current === 'connected' &&
      this.client?.readyState === WebSocket.OPEN
    ) {
      const response = await this.sendDirect(request);
      if (response.error) {
        throw new McpError(
          response.error.code.toString(),
          response.error.message,
          response.error.data != null
            ? (response.error.data as Record<string, unknown>)
            : {},
          'The extension returned an error.',
          true,
        );
      }
      return response.result;
    }

    // Queue if not connected
    const response = await this.commandQueue.enqueue(request);
    if (response.error) {
      throw new McpError(
        response.error.code.toString(),
        response.error.message,
        response.error.data != null
          ? (response.error.data as Record<string, unknown>)
          : {},
        'The extension returned an error.',
        true,
      );
    }
    return response.result;
  }

  get connectionState(): string {
    return this.stateMachine.current;
  }

  get extensionVersion(): string | null {
    return this.extensionVersionValue;
  }

  get lastError(): string | null {
    return this.lastErrorValue;
  }

  get wsPort(): number {
    return this.port;
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  async close(closeCode: number = 1001, closeReason: string = 'Going Away'): Promise<void> {
    this.stopKeepalive();

    const shutdownError = new McpError(
      ErrorCode.EXTENSION_DISCONNECTED,
      'Server shutting down',
      {},
      'The server is shutting down.',
      false,
    );

    this.pendingRequests.rejectAll(shutdownError);
    this.commandQueue.rejectAll(shutdownError);

    if (this.client && this.client.readyState === WebSocket.OPEN) {
      this.client.close(closeCode, closeReason);
    }

    return new Promise<void>((resolve) => {
      this.wss.close(() => {
        logger.info('WebSocket server closed');
        resolve();
      });
    });
  }
}

function isCompatibleVersion(
  extensionVersion: string,
  serverVersion: string,
): boolean {
  const extMajor = extensionVersion.split('.')[0];
  const serverMajor = serverVersion.split('.')[0];
  return extMajor === serverMajor;
}
