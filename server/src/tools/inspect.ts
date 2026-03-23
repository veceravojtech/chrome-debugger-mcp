import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import type { Bridge } from '../bridge/index.js';
import { McpError, ErrorCode } from '../errors/index.js';

export function registerInspectTools(server: McpServer, bridge: Bridge): void {
  server.tool(
    'get_cookies',
    'Read all cookies for a tab\'s domain including name, value, domain, path, expiration, httpOnly, and secure flags',
    { tabId: z.number().int().describe('Tab ID from list_tabs') },
    async ({ tabId }) => {
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
    },
  );

  server.tool(
    'get_storage',
    'Read localStorage or sessionStorage entries for a tab\'s origin',
    {
      tabId: z.number().int().describe('Tab ID from list_tabs'),
      type: z.enum(['local', 'session']).describe('Storage type: "local" for localStorage, "session" for sessionStorage'),
    },
    async ({ tabId, type }) => {
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
    },
  );
}
