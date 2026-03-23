import { describe, it, expect } from 'vitest';
import type { Bridge } from '../bridge/index.js';
import { SERVER_VERSION } from '../types.js';

function createMockBridge(overrides: Partial<Bridge> = {}): Bridge {
  return {
    connectionState: 'disconnected',
    extensionVersion: null,
    wsPort: 9222,
    lastError: null,
    ...overrides,
  } as unknown as Bridge;
}

function getStatusResponse(bridge: Bridge): Record<string, unknown> {
  const connected = bridge.connectionState === 'connected';
  const status: Record<string, unknown> = {
    serverRunning: true,
    extensionConnected: connected,
    wsPort: bridge.wsPort,
    serverVersion: SERVER_VERSION,
  };

  if (connected) {
    status.extensionVersion = bridge.extensionVersion;
  } else {
    if (bridge.lastError) {
      status.lastError = bridge.lastError;
    }
    status.hint =
      'Extension WebSocket not connected. Check that the extension is enabled in chrome://extensions and the service worker is active.';
  }

  return status;
}

describe('Status tool handler', () => {
  it('should return connected status with extensionVersion', () => {
    const bridge = createMockBridge({
      connectionState: 'connected',
      extensionVersion: '1.0.0',
      wsPort: 9222,
    });

    const status = getStatusResponse(bridge);

    expect(status).toEqual({
      serverRunning: true,
      extensionConnected: true,
      wsPort: 9222,
      serverVersion: '1.0.0',
      extensionVersion: '1.0.0',
    });
  });

  it('should return disconnected status with hint and lastError', () => {
    const bridge = createMockBridge({
      connectionState: 'disconnected',
      lastError: 'WebSocket closed',
      wsPort: 9222,
    });

    const status = getStatusResponse(bridge);

    expect(status).toEqual({
      serverRunning: true,
      extensionConnected: false,
      wsPort: 9222,
      serverVersion: '1.0.0',
      lastError: 'WebSocket closed',
      hint: 'Extension WebSocket not connected. Check that the extension is enabled in chrome://extensions and the service worker is active.',
    });
  });

  it('should return disconnected status without lastError when none exists', () => {
    const bridge = createMockBridge({
      connectionState: 'disconnected',
      lastError: null,
      wsPort: 9222,
    });

    const status = getStatusResponse(bridge);

    expect(status).not.toHaveProperty('lastError');
    expect(status.extensionConnected).toBe(false);
    expect(status.hint).toBeDefined();
  });

  it('should always return serverRunning as true', () => {
    const connectedBridge = createMockBridge({ connectionState: 'connected', extensionVersion: '1.0.0' });
    const disconnectedBridge = createMockBridge({ connectionState: 'disconnected' });

    expect(getStatusResponse(connectedBridge).serverRunning).toBe(true);
    expect(getStatusResponse(disconnectedBridge).serverRunning).toBe(true);
  });
});
