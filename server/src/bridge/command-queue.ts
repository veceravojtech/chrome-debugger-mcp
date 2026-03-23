import { McpError, ErrorCode } from '../errors/index.js';
import type { JsonRpcRequest, JsonRpcResponse } from './protocol.js';

interface QueuedCommand {
  request: JsonRpcRequest;
  resolve: (response: JsonRpcResponse) => void;
  reject: (reason: McpError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CommandQueue {
  private readonly queue: QueuedCommand[] = [];
  private readonly timeoutMs: number;

  constructor(timeoutMs: number = 30_000) {
    this.timeoutMs = timeoutMs;
  }

  enqueue(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.queue.findIndex((cmd) => cmd.request.id === request.id);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
        }
        reject(
          new McpError(
            ErrorCode.EXTENSION_DISCONNECTED,
            `Queued command ${request.method} timed out after ${this.timeoutMs}ms`,
            { requestId: request.id, method: request.method },
            'The Chrome extension is not connected. It may be reconnecting after a server restart. Retry in a few seconds, or ensure the extension is installed and active.',
            true,
          ),
        );
      }, this.timeoutMs);

      this.queue.push({ request, resolve, reject, timer });
    });
  }

  async drain(sendFn: (request: JsonRpcRequest) => Promise<JsonRpcResponse>): Promise<void> {
    const commands = this.queue.splice(0);
    for (const cmd of commands) {
      clearTimeout(cmd.timer);
      try {
        const response = await sendFn(cmd.request);
        cmd.resolve(response);
      } catch (err) {
        cmd.reject(
          err instanceof McpError
            ? err
            : new McpError(
                ErrorCode.EXTENSION_DISCONNECTED,
                'Failed to replay queued command',
                { requestId: cmd.request.id, method: cmd.request.method },
                'The command could not be replayed after reconnection.',
                true,
              ),
        );
      }
    }
  }

  rejectAll(reason?: McpError): void {
    const commands = this.queue.splice(0);
    const error =
      reason ??
      new McpError(
        ErrorCode.EXTENSION_DISCONNECTED,
        'All queued commands rejected',
        {},
        'The server is shutting down or the extension disconnected.',
        false,
      );
    for (const cmd of commands) {
      clearTimeout(cmd.timer);
      cmd.reject(error);
    }
  }

  get size(): number {
    return this.queue.length;
  }
}
