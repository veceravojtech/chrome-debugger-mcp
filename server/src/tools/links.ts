import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import type { Bridge } from '../bridge/index.js';
import { McpError, ErrorCode } from '../errors/index.js';

interface LinkResult {
  url: string;
  text: string;
  attributes: Record<string, string>;
}

interface FilterParams {
  domain?: string;
  pathPrefix?: string;
  regex?: string;
  glob?: string;
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');
  return new RegExp('^' + escaped + '$');
}

function filterLinks(links: LinkResult[], filter?: FilterParams): LinkResult[] {
  if (!filter) return links;

  let filtered = links;

  if (filter.domain) {
    const targetDomain = filter.domain.toLowerCase();
    filtered = filtered.filter(link => {
      try {
        const hostname = new URL(link.url).hostname.toLowerCase();
        return hostname === targetDomain || hostname.endsWith('.' + targetDomain);
      } catch { return false; }
    });
  }

  if (filter.pathPrefix) {
    const prefix = filter.pathPrefix;
    filtered = filtered.filter(link => {
      try {
        return new URL(link.url).pathname.startsWith(prefix);
      } catch { return false; }
    });
  }

  if (filter.regex) {
    let re: RegExp;
    try {
      re = new RegExp(filter.regex);
    } catch (err) {
      throw new McpError(
        ErrorCode.INVALID_PARAMETERS,
        `Invalid regex pattern: ${(err as Error).message}`,
        { regex: filter.regex },
        'Provide a valid JavaScript regular expression',
        false,
      );
    }
    filtered = filtered.filter(link => re.test(link.url));
  }

  if (filter.glob) {
    const re = globToRegex(filter.glob);
    filtered = filtered.filter(link => {
      try {
        return re.test(new URL(link.url).pathname);
      } catch { return false; }
    });
  }

  return filtered;
}

export { filterLinks, globToRegex };
export type { LinkResult, FilterParams };

export function registerLinkTools(server: McpServer, bridge: Bridge): void {
  server.tool(
    'discover_links',
    'Discover all links on a page with optional filtering by domain, path prefix, regex, or glob pattern',
    {
      tabId: z.number().int().describe('Tab ID from list_tabs'),
      filter: z.object({
        domain: z.string().describe('Filter links by domain (includes subdomains)'),
        pathPrefix: z.string().describe('Filter links by URL path prefix'),
        regex: z.string().describe('Filter links by regex pattern matched against full URL'),
        glob: z.string().describe('Filter links by glob pattern matched against URL pathname'),
      }).partial().optional().describe('Optional filters (AND-combined when multiple specified)'),
    },
    async ({ tabId, filter }) => {
      try {
        const rawLinks = await bridge.send('links.discover', { tabId }) as LinkResult[];
        const filtered = filterLinks(rawLinks, filter);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(filtered, null, 2) }],
        };
      } catch (err) {
        if (err instanceof McpError) {
          throw err;
        }
        if (err instanceof Error && err.message.includes('not found')) {
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
