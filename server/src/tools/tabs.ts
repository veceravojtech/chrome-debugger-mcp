import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import type { Bridge } from '../bridge/index.js';
import { McpError, ErrorCode } from '../errors/index.js';

export function registerTabTools(server: McpServer, bridge: Bridge): void {
  server.tool(
    'list_tabs',
    'List all open browser tabs with URLs, titles, and active state',
    {},
    async () => {
      const tabs = await bridge.send('tabs.list');
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(tabs, null, 2) }],
      };
    },
  );

  server.tool(
    'open_url',
    'Open a URL in the browser. Reuses existing tab with same URL by default. When tabId is provided, navigates that existing tab to the URL instead. Waits for page load before returning.',
    {
      url: z.url(),
      reuseTab: z.boolean().optional().default(true).describe('Reuse an existing tab with the same URL instead of opening a new one (default: true)'),
      tabId: z.number().int().optional().describe('Navigate an existing tab to the URL instead of opening a new one. Get tab IDs from list_tabs.'),
    },
    async ({ url, reuseTab, tabId }) => {
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
    },
  );

  server.tool(
    'close_tab',
    'Close a specific browser tab',
    { tabId: z.number().int().describe('Tab ID from list_tabs') },
    async ({ tabId }) => {
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
    },
  );

  server.tool(
    'switch_tab',
    'Switch focus to a specific browser tab',
    { tabId: z.number().int().describe('Tab ID from list_tabs') },
    async ({ tabId }) => {
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
    },
  );

  server.tool(
    'reload_tab',
    'Reload a specific browser tab',
    { tabId: z.number().int().describe('Tab ID from list_tabs') },
    async ({ tabId }) => {
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
    },
  );
}
