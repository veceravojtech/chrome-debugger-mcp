import { describe, it, expect, vi } from 'vitest';
import type { Bridge } from '../bridge/index.js';
import { Crawler } from './crawler.js';
import { TabPool } from './tab-pool.js';
import type { LinkResult } from '../tools/links.js';

// Track tab navigations to return correct links per URL
function createTrackedBridge(linkMap: Record<string, LinkResult[]> = {}): { bridge: Bridge; navigations: Map<number, string> } {
  let nextTabId = 100;
  const navigations = new Map<number, string>();

  const bridge = {
    connectionState: 'connected',
    extensionVersion: '1.0.0',
    wsPort: 9222,
    lastError: null,
    send: vi.fn().mockImplementation((method: string, params?: Record<string, unknown>) => {
      if (method === 'tabs.open') {
        const tabId = (params?.tabId as number) ?? nextTabId++;
        if (params?.url) {
          navigations.set(tabId, params.url as string);
        }
        return Promise.resolve({ tabId });
      }
      if (method === 'tabs.close') {
        return Promise.resolve({});
      }
      if (method === 'dom.getRendered') {
        return Promise.resolve('<html></html>');
      }
      if (method === 'links.discover') {
        const tabId = params?.tabId as number;
        const url = navigations.get(tabId) ?? '';
        return Promise.resolve(linkMap[url] ?? []);
      }
      return Promise.resolve({});
    }),
  } as unknown as Bridge;

  return { bridge, navigations };
}

describe('Crawler', () => {
  describe('BFS crawl', () => {
    it('should visit start URL first', async () => {
      const { bridge } = createTrackedBridge();

      const pool = new TabPool(bridge, 1);
      await pool.init();

      const crawler = new Crawler({ bridge, tabPool: pool });
      const events: string[] = [];
      crawler.on('page:start', ({ url }: { url: string }) => events.push(url));

      await crawler.crawl('https://example.com/');

      expect(events[0]).toBe('https://example.com/');
      await pool.closeAll();
    });

    it('should discover and follow links in breadth-first order', async () => {
      const { bridge } = createTrackedBridge({
        'https://example.com/': [
          { url: 'https://example.com/a', text: 'A', attributes: {} },
          { url: 'https://example.com/b', text: 'B', attributes: {} },
        ],
        'https://example.com/a': [
          { url: 'https://example.com/a/1', text: 'A1', attributes: {} },
        ],
        'https://example.com/b': [],
      });

      const pool = new TabPool(bridge, 1);
      await pool.init();

      const crawler = new Crawler({ bridge, tabPool: pool, maxDepth: 3 });
      const visited: string[] = [];
      crawler.on('page:done', ({ url }: { url: string }) => visited.push(url));

      await crawler.crawl('https://example.com/');

      // BFS: root -> a, b -> a/1
      expect(visited).toEqual([
        'https://example.com/',
        'https://example.com/a',
        'https://example.com/b',
        'https://example.com/a/1',
      ]);
      await pool.closeAll();
    });

    it('should deduplicate URLs using normalizeUrl', async () => {
      const { bridge } = createTrackedBridge({
        'https://example.com/': [
          { url: 'https://example.com/page', text: 'Page', attributes: {} },
          { url: 'https://EXAMPLE.COM/page', text: 'Page Dup', attributes: {} },
          { url: 'https://example.com/page#section', text: 'Page Fragment', attributes: {} },
          { url: 'https://example.com/page/', text: 'Page Trailing', attributes: {} },
        ],
      });

      const pool = new TabPool(bridge, 1);
      await pool.init();

      const crawler = new Crawler({ bridge, tabPool: pool });
      const result = await crawler.crawl('https://example.com/');

      // Start URL + 1 unique page = 2 pages found
      expect(result.pagesFound).toBe(2);
      expect(result.pagesProcessed).toBe(2);
      await pool.closeAll();
    });
  });

  describe('maxDepth', () => {
    it('should stop adding links beyond depth limit', async () => {
      const { bridge } = createTrackedBridge({
        'https://example.com/': [
          { url: 'https://example.com/level1', text: 'L1', attributes: {} },
        ],
        'https://example.com/level1': [
          { url: 'https://example.com/level2', text: 'L2', attributes: {} },
        ],
        'https://example.com/level2': [
          { url: 'https://example.com/level3', text: 'L3', attributes: {} },
        ],
      });

      const pool = new TabPool(bridge, 1);
      await pool.init();

      const crawler = new Crawler({ bridge, tabPool: pool, maxDepth: 2 });
      const result = await crawler.crawl('https://example.com/');

      // depth 0: root, depth 1: level1, depth 2: level2, depth 3: level3 (excluded)
      expect(result.pagesProcessed).toBe(3);
      expect(result.pagesFound).toBe(3);
      await pool.closeAll();
    });
  });

  describe('maxPages', () => {
    it('should stop crawl at page limit', async () => {
      const { bridge } = createTrackedBridge({
        'https://example.com/': [
          { url: 'https://example.com/a', text: 'A', attributes: {} },
          { url: 'https://example.com/b', text: 'B', attributes: {} },
          { url: 'https://example.com/c', text: 'C', attributes: {} },
        ],
      });

      const pool = new TabPool(bridge, 1);
      await pool.init();

      const crawler = new Crawler({ bridge, tabPool: pool, maxPages: 2 });
      const result = await crawler.crawl('https://example.com/');

      expect(result.pagesProcessed).toBe(2);
      await pool.closeAll();
    });
  });

  describe('rate limiting', () => {
    it('should delay between page loads', async () => {
      const { bridge } = createTrackedBridge({
        'https://example.com/': [
          { url: 'https://example.com/a', text: 'A', attributes: {} },
        ],
      });

      const pool = new TabPool(bridge, 1);
      await pool.init();

      const rateLimit = 100;
      const crawler = new Crawler({ bridge, tabPool: pool, rateLimit });

      const start = Date.now();
      await crawler.crawl('https://example.com/');
      const elapsed = Date.now() - start;

      // Should have delayed at least rateLimit * 2 (one per page)
      expect(elapsed).toBeGreaterThanOrEqual(rateLimit * 2 - 10); // small tolerance
      await pool.closeAll();
    });
  });

  describe('error handling', () => {
    it('should skip failed page and continue crawl', async () => {
      const navigations = new Map<number, string>();
      let nextTabId = 100;

      const bridge = {
        connectionState: 'connected',
        extensionVersion: '1.0.0',
        wsPort: 9222,
        lastError: null,
        send: vi.fn().mockImplementation((method: string, params?: Record<string, unknown>) => {
          if (method === 'tabs.open') {
            const tabId = (params?.tabId as number) ?? nextTabId++;
            if (params?.url) {
              navigations.set(tabId, params.url as string);
            }
            // Fail on /fail page
            if (params?.url === 'https://example.com/fail') {
              return Promise.reject(new Error('Page load failed'));
            }
            return Promise.resolve({ tabId });
          }
          if (method === 'tabs.close') return Promise.resolve({});
          if (method === 'dom.getRendered') return Promise.resolve('<html></html>');
          if (method === 'links.discover') {
            const tabId = params?.tabId as number;
            const url = navigations.get(tabId) ?? '';
            if (url === 'https://example.com/') {
              return Promise.resolve([
                { url: 'https://example.com/fail', text: 'Fail', attributes: {} },
                { url: 'https://example.com/ok', text: 'OK', attributes: {} },
              ]);
            }
            return Promise.resolve([]);
          }
          return Promise.resolve({});
        }),
      } as unknown as Bridge;

      const pool = new TabPool(bridge, 1);
      await pool.init();

      const crawler = new Crawler({ bridge, tabPool: pool });
      const result = await crawler.crawl('https://example.com/');

      expect(result.pagesFailed).toBe(1);
      expect(result.pagesProcessed).toBe(3); // root + fail + ok
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].url).toBe('https://example.com/fail');
      await pool.closeAll();
    });

    it('should emit page:error event on page timeout', async () => {
      const navigations = new Map<number, string>();
      let nextTabId = 100;

      const bridge = {
        connectionState: 'connected',
        extensionVersion: '1.0.0',
        wsPort: 9222,
        lastError: null,
        send: vi.fn().mockImplementation((method: string, params?: Record<string, unknown>) => {
          if (method === 'tabs.open') {
            const tabId = (params?.tabId as number) ?? nextTabId++;
            if (params?.url) {
              navigations.set(tabId, params.url as string);
            }
            if (params?.url === 'https://example.com/slow') {
              // Never resolves — simulates timeout
              return new Promise(() => {});
            }
            return Promise.resolve({ tabId });
          }
          if (method === 'tabs.close') return Promise.resolve({});
          if (method === 'dom.getRendered') return Promise.resolve('<html></html>');
          if (method === 'links.discover') return Promise.resolve([]);
          return Promise.resolve({});
        }),
      } as unknown as Bridge;

      const pool = new TabPool(bridge, 1);
      await pool.init();

      // Use a very short page timeout for testing
      const crawler = new Crawler({ bridge, tabPool: pool, pageTimeoutMs: 50 });
      const errorEvents: Array<{ url: string }> = [];
      crawler.on('page:error', (e: { url: string }) => errorEvents.push(e));

      const result = await crawler.crawl('https://example.com/slow');

      expect(result.pagesFailed).toBe(1);
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].url).toBe('https://example.com/slow');
      await pool.closeAll();
    });
  });

  describe('events', () => {
    it('should emit page:start, page:done, crawl:progress, crawl:complete events', async () => {
      const { bridge } = createTrackedBridge();

      const pool = new TabPool(bridge, 1);
      await pool.init();

      const crawler = new Crawler({ bridge, tabPool: pool });
      const events: string[] = [];
      crawler.on('page:start', () => events.push('page:start'));
      crawler.on('page:done', () => events.push('page:done'));
      crawler.on('crawl:progress', () => events.push('crawl:progress'));
      crawler.on('crawl:complete', () => events.push('crawl:complete'));

      await crawler.crawl('https://example.com/');

      expect(events).toContain('page:start');
      expect(events).toContain('page:done');
      expect(events).toContain('crawl:progress');
      expect(events).toContain('crawl:complete');

      // crawl:complete should be last
      expect(events[events.length - 1]).toBe('crawl:complete');
      await pool.closeAll();
    });
  });

  describe('filter', () => {
    it('should apply filter to discovered links', async () => {
      const { bridge } = createTrackedBridge({
        'https://example.com/': [
          { url: 'https://example.com/docs/intro', text: 'Docs', attributes: {} },
          { url: 'https://other.com/external', text: 'External', attributes: {} },
        ],
      });

      const pool = new TabPool(bridge, 1);
      await pool.init();

      const crawler = new Crawler({
        bridge,
        tabPool: pool,
        filter: { domain: 'example.com' },
      });
      const result = await crawler.crawl('https://example.com/');

      // Only example.com links should be followed
      expect(result.pagesFound).toBe(2); // root + docs/intro
      expect(result.pagesProcessed).toBe(2);
      await pool.closeAll();
    });
  });

  describe('empty links', () => {
    it('should complete with only start page when no links discovered', async () => {
      const { bridge } = createTrackedBridge();

      const pool = new TabPool(bridge, 1);
      await pool.init();

      const crawler = new Crawler({ bridge, tabPool: pool });
      const result = await crawler.crawl('https://example.com/');

      expect(result.pagesFound).toBe(1);
      expect(result.pagesProcessed).toBe(1);
      expect(result.pagesFailed).toBe(0);
      await pool.closeAll();
    });
  });

  describe('CrawlResult', () => {
    it('should contain correct counts', async () => {
      const { bridge } = createTrackedBridge({
        'https://example.com/': [
          { url: 'https://example.com/a', text: 'A', attributes: {} },
          { url: 'https://example.com/b', text: 'B', attributes: {} },
        ],
      });

      const pool = new TabPool(bridge, 1);
      await pool.init();

      const crawler = new Crawler({ bridge, tabPool: pool });
      const result = await crawler.crawl('https://example.com/');

      expect(result.pagesFound).toBe(3);
      expect(result.pagesProcessed).toBe(3);
      expect(result.pagesFailed).toBe(0);
      expect(result.errors).toEqual([]);
      await pool.closeAll();
    });
  });
});
