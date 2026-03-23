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

// Helper to simulate tool handler logic for get_page_source
async function handleGetPageSource(bridge: Bridge, tabId: number) {
  try {
    const result = await bridge.send('dom.getSource', { tabId });
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

// Helper to simulate tool handler logic for get_rendered_dom
async function handleGetRenderedDom(bridge: Bridge, tabId: number) {
  try {
    const result = await bridge.send('dom.getRendered', { tabId });
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

// Helper to simulate tool handler logic for execute_js
async function handleExecuteJs(bridge: Bridge, tabId: number, script: string) {
  try {
    const result = await bridge.send('scripting.execute', { tabId, script });
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

// Helper to simulate tool handler logic for get_page_resources
async function handleGetPageResources(bridge: Bridge, tabId: number) {
  try {
    const result = await bridge.send('resources.list', { tabId });
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

// Helper to simulate tool handler logic for take_screenshot
async function handleTakeScreenshot(bridge: Bridge, tabId: number, format: string | undefined) {
  try {
    const result = await bridge.send('screenshot.capture', { tabId, format });
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

describe('Content tools handlers', () => {
  describe('get_page_source', () => {
    it('should call bridge.send with dom.getSource and return result as MCP content', async () => {
      const sourceData = { html: '<html><body>Hello</body></html>', url: 'https://example.com' };
      const bridge = createMockBridge(sourceData);

      const result = await handleGetPageSource(bridge, 123);

      expect(bridge.send).toHaveBeenCalledWith('dom.getSource', { tabId: 123 });
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(JSON.parse(result.content[0].text)).toEqual(sourceData);
    });

    it('should throw McpError with TAB_NOT_FOUND for invalid tabId', async () => {
      const bridge = createFailingBridge(new Error('Tab 99999 not found'));

      await expect(handleGetPageSource(bridge, 99999)).rejects.toThrow(McpError);

      try {
        await handleGetPageSource(bridge, 99999);
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

  describe('get_rendered_dom', () => {
    it('should call bridge.send with dom.getRendered and return result as MCP content', async () => {
      const renderedData = { html: '<html><body><div id="app">Rendered</div></body></html>', url: 'https://example.com' };
      const bridge = createMockBridge(renderedData);

      const result = await handleGetRenderedDom(bridge, 456);

      expect(bridge.send).toHaveBeenCalledWith('dom.getRendered', { tabId: 456 });
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(JSON.parse(result.content[0].text)).toEqual(renderedData);
    });

    it('should throw McpError with TAB_NOT_FOUND for invalid tabId', async () => {
      const bridge = createFailingBridge(new Error('Tab 99999 not found'));

      await expect(handleGetRenderedDom(bridge, 99999)).rejects.toThrow(McpError);

      try {
        await handleGetRenderedDom(bridge, 99999);
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
    it('should produce content array with single text element containing valid JSON for both tools', async () => {
      const bridge = createMockBridge({ html: '<html></html>', url: 'https://test.com' });

      const sourceResult = await handleGetPageSource(bridge, 1);
      const renderedResult = await handleGetRenderedDom(bridge, 1);

      for (const result of [sourceResult, renderedResult]) {
        expect(result.content).toHaveLength(1);
        expect(result.content[0].type).toBe('text');
        expect(typeof result.content[0].text).toBe('string');
        expect(() => JSON.parse(result.content[0].text)).not.toThrow();
      }
    });
  });

  describe('execute_js', () => {
    it('should call bridge.send with scripting.execute and return result as MCP content', async () => {
      const execResult = { result: 'Hello World' };
      const bridge = createMockBridge(execResult);

      const result = await handleExecuteJs(bridge, 123, 'document.title');

      expect(bridge.send).toHaveBeenCalledWith('scripting.execute', { tabId: 123, script: 'document.title' });
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(JSON.parse(result.content[0].text)).toEqual(execResult);
    });

    it('should throw McpError with TAB_NOT_FOUND for invalid tabId', async () => {
      const bridge = createFailingBridge(new Error('Tab 99999 not found'));

      await expect(handleExecuteJs(bridge, 99999, 'document.title')).rejects.toThrow(McpError);

      try {
        await handleExecuteJs(bridge, 99999, 'document.title');
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

  describe('get_page_resources', () => {
    it('should call bridge.send with resources.list and return result as MCP content', async () => {
      const resources = [
        { url: 'https://example.com/app.js', type: 'script', size: 1024 },
        { url: 'https://example.com/style.css', type: 'link', size: 512 },
      ];
      const bridge = createMockBridge(resources);

      const result = await handleGetPageResources(bridge, 456);

      expect(bridge.send).toHaveBeenCalledWith('resources.list', { tabId: 456 });
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(JSON.parse(result.content[0].text)).toEqual(resources);
    });

    it('should throw McpError with TAB_NOT_FOUND for invalid tabId', async () => {
      const bridge = createFailingBridge(new Error('Tab 99999 not found'));

      await expect(handleGetPageResources(bridge, 99999)).rejects.toThrow(McpError);

      try {
        await handleGetPageResources(bridge, 99999);
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

  describe('take_screenshot', () => {
    it('should call bridge.send with screenshot.capture and return result as MCP content', async () => {
      const screenshotResult = { dataUrl: 'data:image/png;base64,iVBOR...' };
      const bridge = createMockBridge(screenshotResult);

      const result = await handleTakeScreenshot(bridge, 789, 'png');

      expect(bridge.send).toHaveBeenCalledWith('screenshot.capture', { tabId: 789, format: 'png' });
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(JSON.parse(result.content[0].text)).toEqual(screenshotResult);
    });

    it('should send undefined format when not provided', async () => {
      const screenshotResult = { dataUrl: 'data:image/png;base64,iVBOR...' };
      const bridge = createMockBridge(screenshotResult);

      await handleTakeScreenshot(bridge, 789, undefined);

      expect(bridge.send).toHaveBeenCalledWith('screenshot.capture', { tabId: 789, format: undefined });
    });

    it('should throw McpError with TAB_NOT_FOUND for invalid tabId', async () => {
      const bridge = createFailingBridge(new Error('Tab 99999 not found'));

      await expect(handleTakeScreenshot(bridge, 99999, 'png')).rejects.toThrow(McpError);

      try {
        await handleTakeScreenshot(bridge, 99999, 'png');
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

  describe('MCP content format for new tools', () => {
    it('should produce content array with single text element containing valid JSON for all new tools', async () => {
      const bridge = createMockBridge({ result: 42 });

      const execResult = await handleExecuteJs(bridge, 1, '21 * 2');

      const resourceBridge = createMockBridge([{ url: 'https://test.com/a.js', type: 'script', size: 100 }]);
      const resourceResult = await handleGetPageResources(resourceBridge, 1);

      const screenshotBridge = createMockBridge({ dataUrl: 'data:image/png;base64,abc' });
      const screenshotResult = await handleTakeScreenshot(screenshotBridge, 1, 'png');

      for (const result of [execResult, resourceResult, screenshotResult]) {
        expect(result.content).toHaveLength(1);
        expect(result.content[0].type).toBe('text');
        expect(typeof result.content[0].text).toBe('string');
        expect(() => JSON.parse(result.content[0].text)).not.toThrow();
      }
    });
  });
});
