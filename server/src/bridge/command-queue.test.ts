import { describe, it, expect, vi, afterEach } from 'vitest';
import { CommandQueue } from './command-queue.js';
import { createRequest } from './protocol.js';
import { McpError } from '../errors/index.js';

describe('CommandQueue', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should enqueue a command and return a promise', () => {
    const queue = new CommandQueue();
    const request = createRequest('tabs.list');

    const promise = queue.enqueue(request);

    expect(promise).toBeInstanceOf(Promise);
    expect(queue.size).toBe(1);
  });

  it('should reject queued command after timeout', async () => {
    vi.useFakeTimers();
    const queue = new CommandQueue(100);
    const request = createRequest('tabs.list');

    const promise = queue.enqueue(request);

    vi.advanceTimersByTime(101);

    await expect(promise).rejects.toThrow('timed out');
    await expect(promise).rejects.toBeInstanceOf(McpError);
    expect(queue.size).toBe(0);

    vi.useRealTimers();
  });

  it('should drain all queued commands through sendFn', async () => {
    const queue = new CommandQueue();
    const req1 = createRequest('tabs.list');
    const req2 = createRequest('dom.getSource');

    const p1 = queue.enqueue(req1);
    const p2 = queue.enqueue(req2);

    expect(queue.size).toBe(2);

    const sendFn = vi.fn(async (request) => ({
      jsonrpc: '2.0' as const,
      id: request.id,
      result: { data: request.method },
    }));

    await queue.drain(sendFn);

    expect(queue.size).toBe(0);
    expect(sendFn).toHaveBeenCalledTimes(2);

    const r1 = await p1;
    const r2 = await p2;

    expect(r1.result).toEqual({ data: 'tabs.list' });
    expect(r2.result).toEqual({ data: 'dom.getSource' });
  });

  it('should reject individual command if sendFn throws during drain', async () => {
    const queue = new CommandQueue();
    const req1 = createRequest('tabs.list');
    const req2 = createRequest('dom.getSource');

    const p1 = queue.enqueue(req1);
    const p2 = queue.enqueue(req2);

    let callCount = 0;
    const sendFn = vi.fn(async (request) => {
      callCount++;
      if (callCount === 1) {
        throw new McpError(
          'EXTENSION_DISCONNECTED',
          'Send failed',
          {},
          'Retry',
          true,
        );
      }
      return {
        jsonrpc: '2.0' as const,
        id: request.id,
        result: 'ok',
      };
    });

    await queue.drain(sendFn);

    await expect(p1).rejects.toBeInstanceOf(McpError);
    const r2 = await p2;
    expect(r2.result).toBe('ok');
    expect(sendFn).toHaveBeenCalledTimes(2);
  });

  it('should reject all queued commands via rejectAll', async () => {
    const queue = new CommandQueue();
    const p1 = queue.enqueue(createRequest('a'));
    const p2 = queue.enqueue(createRequest('b'));
    const p3 = queue.enqueue(createRequest('c'));

    expect(queue.size).toBe(3);

    const reason = new McpError(
      'EXTENSION_DISCONNECTED',
      'Shutting down',
      {},
      'Server shutdown',
      false,
    );

    queue.rejectAll(reason);

    expect(queue.size).toBe(0);

    await expect(p1).rejects.toThrow('Shutting down');
    await expect(p2).rejects.toThrow('Shutting down');
    await expect(p3).rejects.toThrow('Shutting down');
  });

  it('should use default error when rejectAll called without reason', async () => {
    const queue = new CommandQueue();
    const p = queue.enqueue(createRequest('test'));

    queue.rejectAll();

    await expect(p).rejects.toBeInstanceOf(McpError);
    await expect(p).rejects.toThrow('All queued commands rejected');
  });

  it('should have size 0 when empty', () => {
    const queue = new CommandQueue();
    expect(queue.size).toBe(0);
  });
});
