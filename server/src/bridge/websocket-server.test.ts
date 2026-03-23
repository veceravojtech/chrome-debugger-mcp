import { describe, it, expect, afterEach, vi } from 'vitest';
import { WebSocket } from 'ws';
import { Bridge } from './websocket-server.js';

function getPort(): number {
  return 9300 + Math.floor(Math.random() * 600);
}

function connectClient(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function sendHandshake(
  ws: WebSocket,
  version = '1.0.0',
): void {
  ws.send(
    JSON.stringify({
      jsonrpc: '2.0',
      id: `hs-${Date.now()}`,
      method: 'handshake',
      params: { version, capabilities: [] },
    }),
  );
}

function waitForMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once('message', (data) => {
      resolve(JSON.parse(data.toString()));
    });
  });
}

describe('Bridge (WebSocket Server)', () => {
  let bridge: Bridge;
  let clients: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }
    clients = [];
    if (bridge) {
      await bridge.close();
    }
  });

  it('should start listening on configured port', async () => {
    const port = getPort();
    bridge = new Bridge({ port });

    // Give server time to bind
    await new Promise((r) => setTimeout(r, 100));

    const ws = await connectClient(port);
    clients.push(ws);

    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it('should transition to connected on valid handshake', async () => {
    const port = getPort();
    bridge = new Bridge({ port });
    await new Promise((r) => setTimeout(r, 100));

    const ws = await connectClient(port);
    clients.push(ws);

    expect(bridge.connectionState).toBe('connecting');

    sendHandshake(ws);
    await new Promise((r) => setTimeout(r, 50));

    expect(bridge.connectionState).toBe('connected');
  });

  it('should send request and receive response', async () => {
    const port = getPort();
    bridge = new Bridge({ port });
    await new Promise((r) => setTimeout(r, 100));

    const ws = await connectClient(port);
    clients.push(ws);

    // Handshake first — consume handshake response
    sendHandshake(ws);
    await waitForMessage(ws);

    // Listen for requests and respond
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'tabs.list') {
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: [{ tabId: 1, url: 'https://example.com' }],
          }),
        );
      }
    });

    const result = await bridge.send('tabs.list', {});

    expect(result).toEqual([{ tabId: 1, url: 'https://example.com' }]);
  });

  it('should queue commands when disconnected and drain on reconnect', async () => {
    const port = getPort();
    bridge = new Bridge({ port });
    await new Promise((r) => setTimeout(r, 100));

    // Send while no client connected — should queue
    const promise = bridge.send('tabs.list', {});

    // Now connect and handle
    const ws = await connectClient(port);
    clients.push(ws);

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method) {
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { queued: true },
          }),
        );
      }
    });

    // Handshake triggers drain
    sendHandshake(ws);

    const result = await promise;
    expect(result).toEqual({ queued: true });
  });

  it('should reject second client with code 1008', async () => {
    const port = getPort();
    bridge = new Bridge({ port });
    await new Promise((r) => setTimeout(r, 100));

    const ws1 = await connectClient(port);
    clients.push(ws1);

    // Handshake first client
    sendHandshake(ws1);
    await new Promise((r) => setTimeout(r, 50));

    // Second client should be rejected
    const ws2 = await connectClient(port);
    clients.push(ws2);

    const closePromise = new Promise<number>((resolve) => {
      ws2.on('close', (code) => resolve(code));
    });

    const code = await closePromise;
    expect(code).toBe(1008);
  });

  it('should transition to disconnected when client closes', async () => {
    const port = getPort();
    bridge = new Bridge({ port });
    await new Promise((r) => setTimeout(r, 100));

    const ws = await connectClient(port);
    clients.push(ws);

    sendHandshake(ws);
    await new Promise((r) => setTimeout(r, 50));

    expect(bridge.connectionState).toBe('connected');

    ws.close();
    await new Promise((r) => setTimeout(r, 100));

    expect(bridge.connectionState).toBe('disconnected');
  });

  it('should reject all pending on close()', async () => {
    const port = getPort();
    bridge = new Bridge({ port });
    await new Promise((r) => setTimeout(r, 100));

    const ws = await connectClient(port);
    clients.push(ws);

    sendHandshake(ws);
    await new Promise((r) => setTimeout(r, 50));

    // Send a request that won't get a response
    const promise = bridge.send('slow.operation', {});
    // Attach handler early to prevent unhandled rejection warning
    promise.catch(() => {});

    // Close bridge — should reject pending
    await bridge.close();

    await expect(promise).rejects.toThrow('Server shutting down');
  });

  it('should emit ws:connected and ws:disconnected events', async () => {
    const port = getPort();
    bridge = new Bridge({ port });
    await new Promise((r) => setTimeout(r, 100));

    const connected = vi.fn();
    const disconnected = vi.fn();
    bridge.on('ws:connected', connected);
    bridge.on('ws:disconnected', disconnected);

    const ws = await connectClient(port);
    clients.push(ws);

    sendHandshake(ws);
    await new Promise((r) => setTimeout(r, 50));

    expect(connected).toHaveBeenCalledOnce();

    ws.close();
    await new Promise((r) => setTimeout(r, 100));

    expect(disconnected).toHaveBeenCalledOnce();
  });

  // --- Handshake validation tests (Story 1.4) ---

  it('should reject non-handshake first message with error and close', async () => {
    const port = getPort();
    bridge = new Bridge({ port });
    await new Promise((r) => setTimeout(r, 100));

    const ws = await connectClient(port);
    clients.push(ws);

    const responsePromise = waitForMessage(ws);
    const closePromise = new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code));
    });

    // Send a non-handshake message as first message
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'bad-1',
        method: 'tabs.list',
        params: {},
      }),
    );

    const response = await responsePromise;
    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 'bad-1',
      error: { code: -32600, message: 'First message must be handshake' },
    });

    const code = await closePromise;
    expect(code).toBe(1008);
  });

  it('should reject incompatible version with error and close', async () => {
    const port = getPort();
    bridge = new Bridge({ port });
    await new Promise((r) => setTimeout(r, 100));

    const ws = await connectClient(port);
    clients.push(ws);

    const responsePromise = waitForMessage(ws);
    const closePromise = new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code));
    });

    // Send handshake with incompatible major version
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'hs-bad',
        method: 'handshake',
        params: { version: '2.0.0', capabilities: [] },
      }),
    );

    const response = await responsePromise;
    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 'hs-bad',
      error: {
        code: -32000,
        message: expect.stringContaining('Version mismatch'),
      },
    });

    const code = await closePromise;
    expect(code).toBe(1008);
  });

  it('should reject handshake without version', async () => {
    const port = getPort();
    bridge = new Bridge({ port });
    await new Promise((r) => setTimeout(r, 100));

    const ws = await connectClient(port);
    clients.push(ws);

    const responsePromise = waitForMessage(ws);
    const closePromise = new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code));
    });

    // Send handshake without version
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'hs-no-ver',
        method: 'handshake',
        params: {},
      }),
    );

    const response = await responsePromise;
    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 'hs-no-ver',
      error: {
        code: -32000,
        message: expect.stringContaining('Version mismatch'),
      },
    });

    const code = await closePromise;
    expect(code).toBe(1008);
  });

  it('should store extensionVersion on valid handshake', async () => {
    const port = getPort();
    bridge = new Bridge({ port });
    await new Promise((r) => setTimeout(r, 100));

    expect(bridge.extensionVersion).toBeNull();

    const ws = await connectClient(port);
    clients.push(ws);

    sendHandshake(ws, '1.2.3');
    await new Promise((r) => setTimeout(r, 50));

    expect(bridge.extensionVersion).toBe('1.2.3');
  });

  it('should send handshake success response with serverVersion', async () => {
    const port = getPort();
    bridge = new Bridge({ port });
    await new Promise((r) => setTimeout(r, 100));

    const ws = await connectClient(port);
    clients.push(ws);

    const responsePromise = waitForMessage(ws);
    sendHandshake(ws);

    const response = await responsePromise;
    expect(response).toMatchObject({
      jsonrpc: '2.0',
      result: { serverVersion: '1.0.0', accepted: true },
    });
  });

  it('should track lastError on disconnect', async () => {
    const port = getPort();
    bridge = new Bridge({ port });
    await new Promise((r) => setTimeout(r, 100));

    expect(bridge.lastError).toBeNull();

    const ws = await connectClient(port);
    clients.push(ws);

    sendHandshake(ws);
    await new Promise((r) => setTimeout(r, 50));

    ws.close();
    await new Promise((r) => setTimeout(r, 100));

    expect(bridge.lastError).toBe('WebSocket closed');
    expect(bridge.extensionVersion).toBeNull();
  });

  it('should expose wsPort getter', async () => {
    const port = getPort();
    bridge = new Bridge({ port });

    expect(bridge.wsPort).toBe(port);
  });
});
