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
    'Open a new browser tab with the specified URL',
    { url: z.url() },
    async ({ url }) => {
      const result = await bridge.send('tabs.open', { url });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
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
