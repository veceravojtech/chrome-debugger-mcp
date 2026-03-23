export { McpError, ErrorCode } from './errors/index.js';
export { logger } from './logger.js';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { logger } from './logger.js';
import { Bridge } from './bridge/index.js';
import { registerTools } from './tools/index.js';
import { DEFAULT_WS_PORT } from './types.js';

export async function startServer(options?: { port?: number }): Promise<void> {
  const port = options?.port ?? DEFAULT_WS_PORT;

  logger.info('chrome-debugger-mcp server starting', {
    version: '0.1.0',
    port,
  });

  const server = new McpServer({
    name: 'chrome-debugger-mcp',
    version: '0.1.0',
  });

  const bridge = new Bridge({ port });

  registerTools(server, bridge);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    logger.info('Shutting down...');
    await bridge.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  logger.info('MCP server ready on stdio', { port });
}
