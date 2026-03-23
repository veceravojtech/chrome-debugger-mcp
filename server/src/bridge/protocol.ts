import { randomUUID } from 'node:crypto';
import { McpError, ErrorCode } from '../errors/index.js';

// --- JSON-RPC 2.0 Types ---

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string;
  result?: unknown;
  error?: JsonRpcError;
}

// --- Request Factory ---

export function createRequest(method: string, params?: unknown): JsonRpcRequest {
  return {
    jsonrpc: '2.0',
    id: randomUUID(),
    method,
    params,
  };
}

// --- Pending Request Tracking ---

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (reason: McpError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PendingRequests {
  private readonly pending = new Map<string, PendingEntry>();

  add(
    id: string,
    resolve: (value: unknown) => void,
    reject: (reason: McpError) => void,
    timeoutMs: number = 30_000,
  ): void {
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reject(
        new McpError(
          ErrorCode.OPERATION_TIMEOUT,
          `Request ${id} timed out after ${timeoutMs}ms`,
          { requestId: id },
          'The operation took too long. Retry or check extension connectivity.',
          true,
        ),
      );
    }, timeoutMs);

    this.pending.set(id, { resolve, reject, timer });
  }

  handleResponse(response: JsonRpcResponse): boolean {
    const entry = this.pending.get(response.id);
    if (!entry) return false;

    clearTimeout(entry.timer);
    this.pending.delete(response.id);

    if (response.error) {
      entry.reject(
        new McpError(
          response.error.code.toString(),
          response.error.message,
          response.error.data != null ? (response.error.data as Record<string, unknown>) : {},
          'The extension returned an error.',
          true,
        ),
      );
    } else {
      entry.resolve(response.result);
    }

    return true;
  }

  rejectAll(reason: McpError): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(reason);
    }
    this.pending.clear();
  }

  get size(): number {
    return this.pending.size;
  }
}
