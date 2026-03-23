export { McpError, ErrorCode } from './errors/index.js';
export { logger } from './logger.js';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { logger } from './logger.js';
import { Bridge } from './bridge/index.js';
import { registerTools } from './tools/index.js';
import { DEFAULT_WS_PORT, WS_CLOSE_TAKEOVER } from './types.js';
import { acquireInstanceLock, killProcessOnPort } from './singleton/instance-lock.js';

async function createAndBindBridge(port: number): Promise<Bridge> {
  try {
    const bridge = new Bridge({ port });
    await bridge.ready();
    return bridge;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      // Port held by a process not tracked by lock file (legacy or external)
      logger.warn('EADDRINUSE after lock acquired — killing process on port', { port });
      await killProcessOnPort(port);
      // Retry once
      const bridge = new Bridge({ port });
      await bridge.ready();
      return bridge;
    }
    throw err;
  }
}

export async function startServer(options?: { port?: number }): Promise<void> {
  const port = options?.port ?? DEFAULT_WS_PORT;

  logger.info('chrome-debugger-mcp server starting', {
    version: '0.1.0',
    port,
  });

  // Step 1: Acquire singleton lock (PID file + O_EXCL claim)
  await acquireInstanceLock(port);

  // Step 2: Create MCP server
  const server = new McpServer({
    name: 'chrome-debugger-mcp',
    version: '0.1.0',
  });

  // Step 3: Create Bridge and await port binding (with EADDRINUSE fallback)
  const bridge = await createAndBindBridge(port);

  // Step 4: Register tools and connect transport
  registerTools(server, bridge);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Step 5: Shutdown handlers
  const shutdown = async () => {
    logger.info('Shutting down...');
    await bridge.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', async () => {
    logger.info('SIGTERM received — closing for takeover');
    // Safety net: force exit if graceful close hangs (e.g. stuck TCP socket)
    const forceExit = setTimeout(() => {
      logger.warn('Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, 3_000);
    forceExit.unref();
    await bridge.close(WS_CLOSE_TAKEOVER, 'Server takeover');
    process.exit(0);
  });

  logger.info('MCP server ready on stdio', { port });
}
