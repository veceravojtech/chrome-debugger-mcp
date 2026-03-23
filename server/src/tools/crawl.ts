import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import type { Bridge } from '../bridge/index.js';
import { Crawler, UrlMapper, TabPool, CrawlProgressBridge, SiteWriter } from '../crawl/index.js';
import { DEFAULT_PARALLEL_TABS, MAX_PARALLEL_TABS } from '../types.js';

export function registerCrawlTools(server: McpServer, bridge: Bridge): void {
  server.tool(
    'crawl_site',
    'Crawl a website using BFS with parallel tabs, rate limiting, and depth control. Returns crawl summary on completion.',
    {
      url: z.string().describe('Starting URL for the crawl'),
      filter: z.object({
        domain: z.string().describe('Filter links by domain (includes subdomains)'),
        pathPrefix: z.string().describe('Filter links by URL path prefix'),
        regex: z.string().describe('Filter links by regex pattern matched against full URL'),
        glob: z.string().describe('Filter links by glob pattern matched against URL pathname'),
      }).partial().optional().describe('Optional link filter (AND-combined when multiple specified)'),
      parallelTabs: z.number().int().min(1).max(MAX_PARALLEL_TABS).default(DEFAULT_PARALLEL_TABS).optional()
        .describe(`Number of parallel tabs (1-${MAX_PARALLEL_TABS}, default ${DEFAULT_PARALLEL_TABS})`),
      maxDepth: z.number().int().min(1).optional()
        .describe('Maximum link depth to follow'),
      maxPages: z.number().int().min(1).optional()
        .describe('Maximum number of pages to crawl'),
      rateLimit: z.number().int().min(0).optional()
        .describe('Milliseconds to wait between page loads per tab'),
      outputDir: z.string().optional()
        .describe('Directory to save crawled HTML files. If omitted, pages are crawled but not saved.'),
    },
    async ({ url, filter, parallelTabs, maxDepth, maxPages, rateLimit, outputDir }, extra) => {
      const tabCount = parallelTabs ?? DEFAULT_PARALLEL_TABS;
      const tabPool = new TabPool(bridge, tabCount);
      let progressBridge: CrawlProgressBridge | undefined;

      try {
        await tabPool.init();

        // File writing setup (optional)
        let onPageContent: ((pageUrl: string, html: string) => Promise<string | undefined>) | undefined;
        if (outputDir) {
          const urlMapper = new UrlMapper(outputDir);
          const siteWriter = new SiteWriter(urlMapper);
          onPageContent = async (pageUrl, html) => {
            return siteWriter.writePageContent(pageUrl, html);
          };
        }

        const crawler = new Crawler({
          bridge,
          tabPool,
          filter,
          maxDepth,
          maxPages,
          rateLimit,
          onPageContent,
        });

        // Wire up progress notifications
        progressBridge = new CrawlProgressBridge(
          crawler,
          extra.sendNotification.bind(extra) as (notification: object) => Promise<void>,
          extra._meta?.progressToken,
        );
        progressBridge.attach();

        const result = await crawler.crawl(url);

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ...result, outputDir: outputDir ?? null }, null, 2) }],
        };
      } finally {
        progressBridge?.detach();
        await tabPool.closeAll();
      }
    },
  );
}
