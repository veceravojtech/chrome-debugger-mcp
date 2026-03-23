import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import type { Bridge } from '../bridge/index.js';
import { McpError, ErrorCode } from '../errors/index.js';

export function registerContentTools(server: McpServer, bridge: Bridge): void {
  server.tool(
    'get_page_source',
    'Get the raw HTML source of a page (before JavaScript modifications)',
    { tabId: z.number().int().describe('Tab ID from list_tabs') },
    async ({ tabId }) => {
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
    },
  );

  server.tool(
    'get_rendered_dom',
    'Get the fully-rendered DOM of a page after JavaScript execution',
    { tabId: z.number().int().describe('Tab ID from list_tabs') },
    async ({ tabId }) => {
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
    },
  );

  server.tool(
    'execute_js',
    'Execute JavaScript in the target page context and return the result',
    {
      tabId: z.number().int().describe('Tab ID from list_tabs'),
      script: z.string().describe('JavaScript code to execute'),
    },
    async ({ tabId, script }) => {
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
    },
  );

  server.tool(
    'get_page_resources',
    'Get all resources (JS, CSS, images, fonts) loaded by a page',
    { tabId: z.number().int().describe('Tab ID from list_tabs') },
    async ({ tabId }) => {
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
    },
  );

  server.tool(
    'take_screenshot',
    'Capture a screenshot of a tab as a base64-encoded image',
    {
      tabId: z.number().int().describe('Tab ID from list_tabs'),
      format: z.enum(['png', 'jpeg']).optional().describe('Image format (default: png)'),
    },
    async ({ tabId, format }) => {
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
    },
  );
}
