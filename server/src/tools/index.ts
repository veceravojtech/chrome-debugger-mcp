import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Bridge } from '../bridge/index.js';
import { registerStatusTool } from './status.js';
import { registerTabTools } from './tabs.js';
import { registerContentTools } from './content.js';
import { registerInspectTools } from './inspect.js';
import { registerLinkTools } from './links.js';
import { registerCrawlTools } from './crawl.js';
import { registerSourceMapTools } from './source-maps.js';
import { registerPageTools } from './page.js';

export function registerTools(server: McpServer, bridge: Bridge): void {
  registerStatusTool(server, bridge);
  registerTabTools(server, bridge);
  registerContentTools(server, bridge);
  registerInspectTools(server, bridge);
  registerLinkTools(server, bridge);
  registerCrawlTools(server, bridge);
  registerSourceMapTools(server, bridge);
  registerPageTools(server, bridge);
}
