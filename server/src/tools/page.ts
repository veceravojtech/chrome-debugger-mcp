import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import type { Bridge } from '../bridge/index.js';
import { McpError, ErrorCode } from '../errors/index.js';

export function registerPageTools(server: McpServer, bridge: Bridge): void {
  server.tool(
    'execute_on_page',
    'Execute JavaScript on a page in a single atomic operation. Opens a tab, waits for page load, executes the script, returns the result, and closes the tab — even on error. No tab cleanup needed.',
    {
      url: z.string().describe('Page URL to open and execute script on'),
      script: z.string().describe('JavaScript code to execute on the loaded page'),
      timeout: z.number().optional().describe('Custom timeout in ms for page load (default: 30000)'),
    },
    async ({ url, script, timeout }) => {
      try {
        const params: Record<string, unknown> = { url, script };
        if (timeout !== undefined) {
          params.timeout = timeout;
        }
        const result = await bridge.send('page.executeOnPage', params);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        if (err instanceof Error && err.message.includes('failed to load within')) {
          throw new McpError(
            ErrorCode.OPERATION_TIMEOUT,
            `Page failed to load within timeout: ${url}`,
            { url, timeoutMs: timeout ?? 30000 },
            'The page may be slow or unreachable. Verify the URL is accessible and try again.',
            true,
          );
        }
        throw err;
      }
    },
  );
}
