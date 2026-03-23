import { describe, it, expect, vi } from 'vitest';
import type { Bridge } from '../bridge/index.js';
import { McpError, ErrorCode } from '../errors/index.js';

function createMockBridge(sendResult?: unknown): Bridge {
  return {
    connectionState: 'connected',
    extensionVersion: '1.0.0',
    wsPort: 9222,
    lastError: null,
    send: vi.fn().mockResolvedValue(sendResult),
  } as unknown as Bridge;
}

function createFailingBridge(error: Error): Bridge {
  return {
    connectionState: 'connected',
    extensionVersion: '1.0.0',
    wsPort: 9222,
    lastError: null,
    send: vi.fn().mockRejectedValue(error),
  } as unknown as Bridge;
}

// Helper to simulate tool handler logic for get_cookies
async function handleGetCookies(bridge: Bridge, tabId: number) {
  try {
    const result = await bridge.send('cookies.get', { tabId });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    if (err instanceof McpError || (err instanceof Error && err.message.includes('not found'))) {
      throw new McpError(
        ErrorCode.TAB_NOT_FOUND,
        `Tab ${tabId} does not exist or has been closed`,
        { tabId },
        'Call list_tabs to get current tab IDs',
        true,
      );
    }
    throw err;
  }
}

// Helper to simulate tool handler logic for get_storage
async function handleGetStorage(bridge: Bridge, tabId: number, type: 'local' | 'session') {
  try {
    const result = await bridge.send('storage.get', { tabId, type });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    if (err instanceof McpError || (err instanceof Error && err.message.includes('not found'))) {
      throw new McpError(
        ErrorCode.TAB_NOT_FOUND,
        `Tab ${tabId} does not exist or has been closed`,
        { tabId },
        'Call list_tabs to get current tab IDs',
        true,
      );
    }
    throw err;
  }
}

describe('Inspect tools handlers', () => {
  describe('get_cookies', () => {
    it('should call bridge.send with cookies.get and return result as MCP content', async () => {
      const cookieData = [
        {
          name: 'session',
          value: 'abc123',
          domain: '.example.com',
          path: '/',
          expirationDate: 1700000000,
          httpOnly: true,
          secure: true,
        },
      ];
      const bridge = createMockBridge(cookieData);

      const result = await handleGetCookies(bridge, 123);

      expect(bridge.send).toHaveBeenCalledWith('cookies.get', { tabId: 123 });
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(JSON.parse(result.content[0].text)).toEqual(cookieData);
    });

    it('should throw McpError with TAB_NOT_FOUND for invalid tabId', async () => {
      const bridge = createFailingBridge(new Error('Tab 99999 not found'));

      await expect(handleGetCookies(bridge, 99999)).rejects.toThrow(McpError);

      try {
        await handleGetCookies(bridge, 99999);
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        const mcpErr = err as McpError;
        expect(mcpErr.code).toBe(ErrorCode.TAB_NOT_FOUND);
        expect(mcpErr.resource).toEqual({ tabId: 99999 });
        expect(mcpErr.hint).toBe('Call list_tabs to get current tab IDs');
        expect(mcpErr.recoverable).toBe(true);
      }
    });
  });

  describe('get_storage', () => {
    it('should call bridge.send with storage.get type local and return result as MCP content', async () => {
      const storageData = { entries: { theme: 'dark', lang: 'en' } };
      const bridge = createMockBridge(storageData);

      const result = await handleGetStorage(bridge, 456, 'local');

      expect(bridge.send).toHaveBeenCalledWith('storage.get', { tabId: 456, type: 'local' });
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(JSON.parse(result.content[0].text)).toEqual(storageData);
    });

    it('should call bridge.send with storage.get type session and return result as MCP content', async () => {
      const storageData = { entries: { cartId: '12345' } };
      const bridge = createMockBridge(storageData);

      const result = await handleGetStorage(bridge, 789, 'session');

      expect(bridge.send).toHaveBeenCalledWith('storage.get', { tabId: 789, type: 'session' });
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(JSON.parse(result.content[0].text)).toEqual(storageData);
    });

    it('should throw McpError with TAB_NOT_FOUND for invalid tabId', async () => {
      const bridge = createFailingBridge(new Error('Tab 99999 not found'));

      await expect(handleGetStorage(bridge, 99999, 'local')).rejects.toThrow(McpError);

      try {
        await handleGetStorage(bridge, 99999, 'local');
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        const mcpErr = err as McpError;
        expect(mcpErr.code).toBe(ErrorCode.TAB_NOT_FOUND);
        expect(mcpErr.resource).toEqual({ tabId: 99999 });
        expect(mcpErr.hint).toBe('Call list_tabs to get current tab IDs');
        expect(mcpErr.recoverable).toBe(true);
      }
    });
  });

  describe('MCP content format', () => {
    it('should produce content array with single text element containing valid JSON for get_cookies', async () => {
      const bridge = createMockBridge([{ name: 'a', value: 'b', domain: '.test.com', path: '/', httpOnly: false, secure: false }]);

      const result = await handleGetCookies(bridge, 1);

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(typeof result.content[0].text).toBe('string');
      expect(() => JSON.parse(result.content[0].text)).not.toThrow();
    });

    it('should produce content array with single text element containing valid JSON for get_storage', async () => {
      const bridge = createMockBridge({ entries: { key: 'value' } });

      const result = await handleGetStorage(bridge, 1, 'local');

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(typeof result.content[0].text).toBe('string');
      expect(() => JSON.parse(result.content[0].text)).not.toThrow();
    });
  });
});
