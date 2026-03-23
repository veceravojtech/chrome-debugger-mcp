import { EventEmitter } from 'node:events';
import type { Bridge } from '../bridge/index.js';
import { McpError, ErrorCode } from '../errors/index.js';
import { logger } from '../logger.js';
import { CRAWL_PAGE_TIMEOUT_MS, DEFAULT_MAX_DEPTH } from '../types.js';
import { normalizeUrl } from './url-normalizer.js';
import { filterLinks } from '../tools/links.js';
import type { FilterParams, LinkResult } from '../tools/links.js';
import type { TabPool } from './tab-pool.js';


export interface CrawlOptions {
  bridge: Bridge;
  tabPool: TabPool;
  filter?: FilterParams;
  maxDepth?: number;
  maxPages?: number;
  rateLimit?: number;
  pageTimeoutMs?: number;
  onPageContent?: (url: string, html: string) => Promise<string | undefined>;
}

export interface CrawlResult {
  pagesFound: number;
  pagesProcessed: number;
  pagesFailed: number;
  errors: Array<{ url: string; code: string; message: string }>;
}

interface QueueEntry {
  url: string;
  depth: number;
  status: 'pending' | 'crawling' | 'done' | 'failed';
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, url: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new McpError(
          ErrorCode.CRAWL_PAGE_FAILED,
          `Page load timed out after ${ms}ms`,
          { url, timeoutMs: ms },
          'The page took too long to load. It may be unresponsive or very large.',
          true,
        ),
      );
    }, ms);

    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

export class Crawler extends EventEmitter {
  private readonly bridge: Bridge;
  private readonly tabPool: TabPool;
  private readonly filter?: FilterParams;
  private readonly maxDepth: number;
  private readonly maxPages?: number;
  private readonly rateLimit?: number;
  private readonly pageTimeoutMs: number;
  private readonly onPageContent?: (url: string, html: string) => Promise<string | undefined>;
  private readonly queue: QueueEntry[] = [];
  private readonly visited = new Set<string>();
  private pagesProcessed = 0;
  private pagesFailed = 0;
  private readonly errors: Array<{ url: string; code: string; message: string }> = [];
  private aborted = false;

  constructor(options: CrawlOptions) {
    super();
    this.bridge = options.bridge;
    this.tabPool = options.tabPool;
    this.filter = options.filter;
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.maxPages = options.maxPages;
    this.rateLimit = options.rateLimit;
    this.pageTimeoutMs = options.pageTimeoutMs ?? CRAWL_PAGE_TIMEOUT_MS;
    this.onPageContent = options.onPageContent;
  }

  async crawl(startUrl: string): Promise<CrawlResult> {
    const crawlStart = Date.now();

    const normalized = normalizeUrl(startUrl);
    this.visited.add(normalized);
    this.queue.push({ url: normalized, depth: 0, status: 'pending' });

    // Run concurrent workers
    const workers = Array.from({ length: this.tabPool.size }, () => this.workerLoop());
    await Promise.allSettled(workers);

    const result: CrawlResult = {
      pagesFound: this.visited.size,
      pagesProcessed: this.pagesProcessed,
      pagesFailed: this.pagesFailed,
      errors: this.errors,
    };

    this.emit('crawl:complete', {
      totalPages: this.visited.size,
      succeeded: this.pagesProcessed - this.pagesFailed,
      failed: this.pagesFailed,
      durationMs: Date.now() - crawlStart,
    });

    return result;
  }

  private async workerLoop(): Promise<void> {
    while (!this.aborted) {
      const entry = this.getNextPending();
      if (!entry) break;

      // Check maxPages before processing
      if (this.maxPages && this.pagesProcessed >= this.maxPages) {
        entry.status = 'pending'; // Put it back
        break;
      }

      entry.status = 'crawling';

      let tabId: number;
      try {
        tabId = await this.tabPool.acquire();
      } catch (err) {
        // Tab pool exhausted — abort crawl
        this.aborted = true;
        entry.status = 'failed';
        this.pagesFailed++;
        const mcpErr = err instanceof McpError ? err : new McpError(
          ErrorCode.CRAWL_ABORTED,
          'Failed to acquire tab',
          { url: entry.url },
          'Tab pool could not provide a tab',
          false,
        );
        this.errors.push({ url: entry.url, code: mcpErr.code, message: mcpErr.message });
        break;
      }

      try {
        await this.processPage(entry, tabId);
      } finally {
        this.tabPool.release(tabId);
      }
    }
  }

  private getNextPending(): QueueEntry | undefined {
    return this.queue.find(e => e.status === 'pending');
  }

  private async processPage(entry: QueueEntry, tabId: number): Promise<void> {
    const pageStart = Date.now();
    this.emit('page:start', { url: entry.url, depth: entry.depth });

    try {
      // Rate limiting
      if (this.rateLimit) {
        await delay(this.rateLimit);
      }

      // Navigate tab to URL with timeout
      await withTimeout(
        this.bridge.send('tabs.open', { url: entry.url, tabId }),
        this.pageTimeoutMs,
        entry.url,
      );

      // Get rendered DOM
      const domResult = await withTimeout(
        this.bridge.send('dom.getRendered', { tabId }) as Promise<{ html: string; url: string }>,
        this.pageTimeoutMs,
        entry.url,
      );

      // Write page content if handler provided
      let filepath: string | undefined;
      if (this.onPageContent) {
        try {
          filepath = await this.onPageContent(entry.url, domResult.html);
        } catch (writeErr) {
          const mcpErr = writeErr instanceof McpError ? writeErr : new McpError(
            ErrorCode.CRAWL_WRITE_FAILED,
            writeErr instanceof Error ? writeErr.message : 'File write failed',
            { url: entry.url },
            'File write failed but crawl continues',
            true,
          );
          this.errors.push({ url: entry.url, code: mcpErr.code, message: mcpErr.message });
          logger.warn('File write failed, continuing crawl', { url: entry.url, error: mcpErr.message });
        }
      }

      // Discover links
      const rawLinks = await withTimeout(
        this.bridge.send('links.discover', { tabId }) as Promise<LinkResult[]>,
        this.pageTimeoutMs,
        entry.url,
      );

      // Filter and enqueue discovered links
      const filtered = filterLinks(rawLinks, this.filter);
      for (const link of filtered) {
        try {
          const normalizedLink = normalizeUrl(link.url);
          const newDepth = entry.depth + 1;
          if (!this.visited.has(normalizedLink) && newDepth <= this.maxDepth) {
            this.visited.add(normalizedLink);
            this.queue.push({ url: normalizedLink, depth: newDepth, status: 'pending' });
          }
        } catch {
          // Invalid URL — skip
        }
      }

      entry.status = 'done';
      this.pagesProcessed++;

      this.emit('page:done', { url: entry.url, filepath, durationMs: Date.now() - pageStart });
    } catch (err) {
      entry.status = 'failed';
      this.pagesProcessed++;
      this.pagesFailed++;

      const mcpErr = err instanceof McpError ? err : new McpError(
        ErrorCode.CRAWL_PAGE_FAILED,
        err instanceof Error ? err.message : 'Unknown error processing page',
        { url: entry.url },
        'Page failed to load or process',
        true,
      );

      this.errors.push({ url: entry.url, code: mcpErr.code, message: mcpErr.message });
      this.emit('page:error', { url: entry.url, error: mcpErr });

      // Only mark the tab as errored if it's a tab-level issue (tab not found / crashed),
      // not a page-level failure. Per AC6: tab remains in pool for reuse after page failure.
      if (mcpErr.code === 'TAB_NOT_FOUND') {
        this.tabPool.markError(tabId);
      }
    }

    this.emit('crawl:progress', {
      pagesFound: this.visited.size,
      pagesCrawled: this.pagesProcessed,
      pagesFailed: this.pagesFailed,
      pagesRemaining: this.queue.filter(e => e.status === 'pending').length,
      currentUrls: this.queue.filter(e => e.status === 'crawling').map(e => e.url),
    });
  }
}
