import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequest, PendingRequests, type JsonRpcResponse } from './protocol.js';
import { McpError } from '../errors/index.js';

describe('createRequest', () => {
  it('should create a JSON-RPC 2.0 request with UUID id', () => {
    const req = createRequest('tabs.list', { active: true });

    expect(req.jsonrpc).toBe('2.0');
    expect(req.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(req.method).toBe('tabs.list');
    expect(req.params).toEqual({ active: true });
  });

  it('should generate unique IDs for each request', () => {
    const req1 = createRequest('tabs.list');
    const req2 = createRequest('tabs.list');

    expect(req1.id).not.toBe(req2.id);
  });

  it('should omit params when not provided', () => {
    const req = createRequest('tabs.list');

    expect(req.params).toBeUndefined();
  });
});

describe('PendingRequests', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should resolve matching pending request on success response', () => {
    const pending = new PendingRequests();
    let resolved: unknown = undefined;
    const reject = vi.fn();

    pending.add('req-1', (val) => { resolved = val; }, reject);

    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id: 'req-1',
      result: [{ tabId: 1, url: 'https://example.com' }],
    };

    const handled = pending.handleResponse(response);

    expect(handled).toBe(true);
    expect(resolved).toEqual([{ tabId: 1, url: 'https://example.com' }]);
    expect(reject).not.toHaveBeenCalled();
    expect(pending.size).toBe(0);
  });

  it('should reject matching pending request on error response', () => {
    const pending = new PendingRequests();
    const resolve = vi.fn();
    let rejected: McpError | undefined;

    pending.add('req-2', resolve, (err) => { rejected = err; });

    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id: 'req-2',
      error: { code: -32000, message: 'Tab not found', data: { tabId: 999 } },
    };

    const handled = pending.handleResponse(response);

    expect(handled).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
    expect(rejected).toBeInstanceOf(McpError);
    expect(rejected!.message).toBe('Tab not found');
    expect(pending.size).toBe(0);
  });

  it('should return false for unmatched response', () => {
    const pending = new PendingRequests();

    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id: 'unknown-id',
      result: {},
    };

    const handled = pending.handleResponse(response);

    expect(handled).toBe(false);
  });

  it('should reject with OPERATION_TIMEOUT on timeout', async () => {
    vi.useFakeTimers();
    const pending = new PendingRequests();
    const resolve = vi.fn();
    let rejected: McpError | undefined;

    pending.add('req-3', resolve, (err) => { rejected = err; }, 100);

    expect(pending.size).toBe(1);

    vi.advanceTimersByTime(101);

    expect(resolve).not.toHaveBeenCalled();
    expect(rejected).toBeInstanceOf(McpError);
    expect(rejected!.code).toBe('OPERATION_TIMEOUT');
    expect(pending.size).toBe(0);

    vi.useRealTimers();
  });

  it('should clear timeout when response arrives before timeout', () => {
    vi.useFakeTimers();
    const pending = new PendingRequests();
    let resolved: unknown;
    const reject = vi.fn();

    pending.add('req-4', (val) => { resolved = val; }, reject, 1000);

    pending.handleResponse({
      jsonrpc: '2.0',
      id: 'req-4',
      result: 'ok',
    });

    vi.advanceTimersByTime(2000);

    expect(resolved).toBe('ok');
    expect(reject).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('should reject all pending requests via rejectAll', () => {
    const pending = new PendingRequests();
    const rejects: McpError[] = [];

    pending.add('a', vi.fn(), (err) => rejects.push(err));
    pending.add('b', vi.fn(), (err) => rejects.push(err));
    pending.add('c', vi.fn(), (err) => rejects.push(err));

    expect(pending.size).toBe(3);

    const reason = new McpError(
      'EXTENSION_DISCONNECTED',
      'Extension disconnected',
      {},
      'Reconnect extension',
      true,
    );

    pending.rejectAll(reason);

    expect(pending.size).toBe(0);
    expect(rejects).toHaveLength(3);
    rejects.forEach((err) => {
      expect(err.code).toBe('EXTENSION_DISCONNECTED');
    });
  });
});
