import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Bridge } from '../bridge/index.js';
import { SERVER_VERSION } from '../types.js';

export function registerStatusTool(server: McpServer, bridge: Bridge): void {
  server.tool(
    'status',
    'Check system health, connection status, and version compatibility',
    {},
    async () => {
      const connected = bridge.connectionState === 'connected';
      const status: Record<string, unknown> = {
        serverRunning: true,
        extensionConnected: connected,
        wsPort: bridge.wsPort,
        serverVersion: SERVER_VERSION,
      };

      if (connected) {
        status.extensionVersion = bridge.extensionVersion;
      } else {
        if (bridge.lastError) {
          status.lastError = bridge.lastError;
        }
        status.hint =
          'Extension WebSocket not connected. Check that the extension is enabled in chrome://extensions and the service worker is active.';
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(status, null, 2) }],
      };
    },
  );
}
