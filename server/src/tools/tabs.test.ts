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

// Helper to simulate tool handler logic for list_tabs
async function handleListTabs(bridge: Bridge) {
  const tabs = await bridge.send('tabs.list');
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(tabs, null, 2) }],
  };
}

// Helper to simulate tool handler logic for open_url (upgraded with reuseTab + timeout + tabId)
async function handleOpenUrl(bridge: Bridge, url: string, reuseTab: boolean = true, tabId?: number) {
  try {
    const result = await bridge.send('tabs.open', { url, reuseTab, tabId });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    if (err instanceof Error && err.message.includes('failed to load within')) {
      throw new McpError(
        ErrorCode.OPERATION_TIMEOUT,
        `Page failed to load within 30000ms: ${url}`,
        { url, timeoutMs: 30000 },
        'The page may be slow or unreachable. Verify the URL is accessible and try again.',
        true,
      );
    }
    if (tabId !== undefined && err instanceof Error && err.message.includes('not found')) {
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

// Helper to simulate tool handler logic for close_tab
async function handleCloseTab(bridge: Bridge, tabId: number) {
  try {
    const result = await bridge.send('tabs.close', { tabId });
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

// Helper to simulate tool handler logic for switch_tab
async function handleSwitchTab(bridge: Bridge, tabId: number) {
  try {
    const result = await bridge.send('tabs.switch', { tabId });
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

// Helper to simulate tool handler logic for reload_tab
async function handleReloadTab(bridge: Bridge, tabId: number) {
  try {
    const result = await bridge.send('tabs.reload', { tabId });
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

describe('Tab tools handlers', () => {
  describe('list_tabs', () => {
    it('should call bridge.send with tabs.list and return array as MCP content', async () => {
      const tabsData = [
        { tabId: 1, url: 'https://example.com', title: 'Example', active: true, windowId: 1 },
        { tabId: 2, url: 'https://test.com', title: 'Test', active: false, windowId: 1 },
      ];
      const bridge = createMockBridge(tabsData);

      const result = await handleListTabs(bridge);

      expect(bridge.send).toHaveBeenCalledWith('tabs.list');
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(JSON.parse(result.content[0].text)).toEqual(tabsData);
    });
  });

  describe('open_url', () => {
    it('should call bridge.send with tabs.open, url, and reuseTab params (default true)', async () => {
      const openResult = { tabId: 3, url: 'https://example.com', title: 'Example', reused: false };
      const bridge = createMockBridge(openResult);

      const result = await handleOpenUrl(bridge, 'https://example.com');

      expect(bridge.send).toHaveBeenCalledWith('tabs.open', { url: 'https://example.com', reuseTab: true });
      expect(result.content).toHaveLength(1);
      expect(JSON.parse(result.content[0].text)).toEqual(openResult);
    });

    it('should pass reuseTab=false to bridge when specified', async () => {
      const openResult = { tabId: 4, url: 'https://example.com', title: 'Example', reused: false };
      const bridge = createMockBridge(openResult);

      const result = await handleOpenUrl(bridge, 'https://example.com', false);

      expect(bridge.send).toHaveBeenCalledWith('tabs.open', { url: 'https://example.com', reuseTab: false });
      expect(result.content).toHaveLength(1);
      expect(JSON.parse(result.content[0].text)).toEqual(openResult);
    });

    it('should return reused=true when bridge indicates tab was reused', async () => {
      const openResult = { tabId: 5, url: 'https://example.com', title: 'Example', reused: true };
      const bridge = createMockBridge(openResult);

      const result = await handleOpenUrl(bridge, 'https://example.com');

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.reused).toBe(true);
      expect(parsed.tabId).toBe(5);
    });

    it('should throw McpError with OPERATION_TIMEOUT on load timeout', async () => {
      const bridge = createFailingBridge(new Error('Page failed to load within 30000ms'));

      await expect(handleOpenUrl(bridge, 'https://slow-site.com')).rejects.toThrow(McpError);

      try {
        await handleOpenUrl(bridge, 'https://slow-site.com');
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        const mcpErr = err as McpError;
        expect(mcpErr.code).toBe(ErrorCode.OPERATION_TIMEOUT);
        expect(mcpErr.message).toContain('https://slow-site.com');
        expect(mcpErr.resource).toEqual({ url: 'https://slow-site.com', timeoutMs: 30000 });
        expect(mcpErr.hint).toContain('Verify the URL is accessible');
        expect(mcpErr.recoverable).toBe(true);
      }
    });

    it('should rethrow non-timeout errors without wrapping', async () => {
      const bridge = createFailingBridge(new Error('Some other bridge error'));

      await expect(handleOpenUrl(bridge, 'https://example.com')).rejects.toThrow('Some other bridge error');
      await expect(handleOpenUrl(bridge, 'https://example.com')).rejects.not.toThrow(McpError);
    });

    it('should include title in response for backward compatibility', async () => {
      const openResult = { tabId: 6, url: 'https://example.com', title: 'Example Page', reused: false };
      const bridge = createMockBridge(openResult);

      const result = await handleOpenUrl(bridge, 'https://example.com');
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed).toHaveProperty('tabId');
      expect(parsed).toHaveProperty('url');
      expect(parsed).toHaveProperty('title');
      expect(parsed).toHaveProperty('reused');
    });

    it('should pass tabId to bridge when provided', async () => {
      const openResult = { tabId: 42, url: 'https://new-page.com', title: 'Navigated', navigated: true, reused: false };
      const bridge = createMockBridge(openResult);

      const result = await handleOpenUrl(bridge, 'https://new-page.com', true, 42);

      expect(bridge.send).toHaveBeenCalledWith('tabs.open', { url: 'https://new-page.com', reuseTab: true, tabId: 42 });
      expect(result.content).toHaveLength(1);
      expect(JSON.parse(result.content[0].text)).toEqual(openResult);
    });

    it('should throw McpError TAB_NOT_FOUND when tabId is invalid', async () => {
      const bridge = createFailingBridge(new Error('Tab 99999 not found'));

      await expect(handleOpenUrl(bridge, 'https://example.com', true, 99999)).rejects.toThrow(McpError);

      try {
        await handleOpenUrl(bridge, 'https://example.com', true, 99999);
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        const mcpErr = err as McpError;
        expect(mcpErr.code).toBe(ErrorCode.TAB_NOT_FOUND);
        expect(mcpErr.resource).toEqual({ tabId: 99999 });
        expect(mcpErr.hint).toBe('Call list_tabs to get current tab IDs');
        expect(mcpErr.recoverable).toBe(true);
      }
    });

    it('should include navigated field in response when tabId used', async () => {
      const openResult = { tabId: 42, url: 'https://new-page.com', title: 'Navigated', navigated: true, reused: false };
      const bridge = createMockBridge(openResult);

      const result = await handleOpenUrl(bridge, 'https://new-page.com', true, 42);
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.navigated).toBe(true);
      expect(parsed.reused).toBe(false);
      expect(parsed.tabId).toBe(42);
    });
  });

  describe('close_tab', () => {
    it('should call bridge.send with tabs.close and tabId param on success', async () => {
      const closeResult = { success: true };
      const bridge = createMockBridge(closeResult);

      const result = await handleCloseTab(bridge, 123);

      expect(bridge.send).toHaveBeenCalledWith('tabs.close', { tabId: 123 });
      expect(result.content).toHaveLength(1);
      expect(JSON.parse(result.content[0].text)).toEqual({ success: true });
    });

    it('should throw McpError with TAB_NOT_FOUND for invalid tabId', async () => {
      const bridge = createFailingBridge(new Error('Tab 99999 not found'));

      await expect(handleCloseTab(bridge, 99999)).rejects.toThrow(McpError);

      try {
        await handleCloseTab(bridge, 99999);
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

  describe('switch_tab', () => {
    it('should call bridge.send with tabs.switch and return tab info on success', async () => {
      const switchResult = { tabId: 123, url: 'https://example.com', title: 'Example' };
      const bridge = createMockBridge(switchResult);

      const result = await handleSwitchTab(bridge, 123);

      expect(bridge.send).toHaveBeenCalledWith('tabs.switch', { tabId: 123 });
      expect(result.content).toHaveLength(1);
      expect(JSON.parse(result.content[0].text)).toEqual(switchResult);
    });

    it('should throw McpError with TAB_NOT_FOUND for invalid tabId', async () => {
      const bridge = createFailingBridge(new Error('Tab 99999 not found'));

      await expect(handleSwitchTab(bridge, 99999)).rejects.toThrow(McpError);
    });
  });

  describe('reload_tab', () => {
    it('should call bridge.send with tabs.reload and return tab info on success', async () => {
      const reloadResult = { tabId: 123, url: 'https://example.com', title: 'Example' };
      const bridge = createMockBridge(reloadResult);

      const result = await handleReloadTab(bridge, 123);

      expect(bridge.send).toHaveBeenCalledWith('tabs.reload', { tabId: 123 });
      expect(result.content).toHaveLength(1);
      expect(JSON.parse(result.content[0].text)).toEqual(reloadResult);
    });

    it('should throw McpError with TAB_NOT_FOUND for invalid tabId', async () => {
      const bridge = createFailingBridge(new Error('Tab 99999 not found'));

      await expect(handleReloadTab(bridge, 99999)).rejects.toThrow(McpError);
    });
  });

  describe('MCP content format', () => {
    it('should produce content array with single text element for all tools', async () => {
      const bridge = createMockBridge({ some: 'data' });

      const listResult = await handleListTabs(bridge);
      const openResult = await handleOpenUrl(bridge, 'https://test.com', true);
      const closeResult = await handleCloseTab(bridge, 1);
      const switchResult = await handleSwitchTab(bridge, 1);
      const reloadResult = await handleReloadTab(bridge, 1);

      for (const result of [listResult, openResult, closeResult, switchResult, reloadResult]) {
        expect(result.content).toHaveLength(1);
        expect(result.content[0].type).toBe('text');
        expect(typeof result.content[0].text).toBe('string');
        expect(() => JSON.parse(result.content[0].text)).not.toThrow();
      }
    });
  });
});
