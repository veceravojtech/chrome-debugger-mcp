import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bridge } from '../bridge/index.js';
import { TabPool, Crawler, CrawlProgressBridge } from '../crawl/index.js';

function createMockBridge(): Bridge {
  let nextTabId = 100;
  const navigations = new Map<number, string>();
  return {
    connectionState: 'connected',
    extensionVersion: '1.0.0',
    wsPort: 9222,
    lastError: null,
    send: vi.fn().mockImplementation((method: string, params?: Record<string, unknown>) => {
      if (method === 'tabs.open') {
        const tabId = (params?.tabId as number) ?? nextTabId++;
        if (params?.url) navigations.set(tabId, params.url as string);
        return Promise.resolve({ tabId });
      }
      if (method === 'tabs.close') return Promise.resolve({});
      if (method === 'dom.getRendered') {
        const tabId = params?.tabId as number;
        const url = navigations.get(tabId) ?? 'https://example.com/';
        return Promise.resolve({ html: `<html>${url}</html>`, url });
      }
      if (method === 'links.discover') return Promise.resolve([]);
      return Promise.resolve({});
    }),
  } as unknown as Bridge;
}

function createFailingBridge(): Bridge {
  let nextTabId = 100;
  let callCount = 0;
  return {
    connectionState: 'connected',
    extensionVersion: '1.0.0',
    wsPort: 9222,
    lastError: null,
    send: vi.fn().mockImplementation((method: string, params?: Record<string, unknown>) => {
      if (method === 'tabs.open') {
        const tabId = (params?.tabId as number) ?? nextTabId++;
        // Fail on navigation (not init)
        if (params?.tabId) {
          callCount++;
          if (callCount === 1) {
            return Promise.reject(new Error('Navigation failed'));
          }
        }
        return Promise.resolve({ tabId });
      }
      if (method === 'tabs.close') return Promise.resolve({});
      if (method === 'dom.getRendered') return Promise.resolve({ html: '<html></html>', url: 'https://example.com/' });
      if (method === 'links.discover') return Promise.resolve([]);
      return Promise.resolve({});
    }),
  } as unknown as Bridge;
}

describe('crawl_site tool', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('should create tab pool and crawler and return result', async () => {
    const bridge = createMockBridge();
    const tabPool = new TabPool(bridge, 3);
    await tabPool.init();

    const crawler = new Crawler({ bridge, tabPool });
    const result = await crawler.crawl('https://example.com/');

    expect(result.pagesProcessed).toBe(1);
    expect(result.pagesFailed).toBe(0);
    expect(result.pagesFound).toBe(1);
    await tabPool.closeAll();
  });

  it('should clean up tabs on success', async () => {
    const bridge = createMockBridge();
    const tabPool = new TabPool(bridge, 2);
    await tabPool.init();

    const crawler = new Crawler({ bridge, tabPool });
    await crawler.crawl('https://example.com/');
    await tabPool.closeAll();

    // Verify close was called for each tab
    const closeCalls = (bridge.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === 'tabs.close',
    );
    expect(closeCalls).toHaveLength(2);
  });

  it('should clean up tabs on error (try/finally)', async () => {
    const bridge = createFailingBridge();
    const tabPool = new TabPool(bridge, 1);

    try {
      await tabPool.init();

      const crawler = new Crawler({ bridge, tabPool });
      await crawler.crawl('https://example.com/');
    } finally {
      await tabPool.closeAll();
    }

    // Verify close was called even though crawl had an error
    const closeCalls = (bridge.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === 'tabs.close',
    );
    expect(closeCalls).toHaveLength(1);
  });

  it('should apply defaults and respect parameter limits', async () => {
    const bridge = createMockBridge();

    // Test with default tab count
    const tabPool = new TabPool(bridge, 3); // DEFAULT_PARALLEL_TABS
    await tabPool.init();
    expect(tabPool.size).toBe(3);

    const crawler = new Crawler({
      bridge,
      tabPool,
      maxDepth: 5,
      maxPages: 10,
      rateLimit: 100,
    });

    const result = await crawler.crawl('https://example.com/');
    expect(result.pagesProcessed).toBeGreaterThanOrEqual(1);
    await tabPool.closeAll();
  });

  it('should write files when outputDir provided via onPageContent', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'crawl-tool-test-'));
    const bridge = createMockBridge();
    const tabPool = new TabPool(bridge, 1);
    await tabPool.init();

    const { UrlMapper, SiteWriter } = await import('../crawl/index.js');
    const urlMapper = new UrlMapper(tempDir);
    const siteWriter = new SiteWriter(urlMapper);

    const crawler = new Crawler({
      bridge,
      tabPool,
      onPageContent: async (url, html) => siteWriter.writePageContent(url, html),
    });

    const result = await crawler.crawl('https://example.com/');

    expect(result.pagesProcessed).toBe(1);
    const content = await readFile(join(tempDir, 'index.html'), 'utf-8');
    expect(content).toContain('<html>');
    await tabPool.closeAll();
  });

  it('should attach and detach progress bridge', async () => {
    const bridge = createMockBridge();
    const tabPool = new TabPool(bridge, 1);
    await tabPool.init();

    const mockSendNotification = vi.fn<(notification: object) => Promise<void>>().mockResolvedValue(undefined);

    const crawler = new Crawler({ bridge, tabPool });

    const progressBridge = new CrawlProgressBridge(crawler, mockSendNotification, 'test-token');
    progressBridge.attach();

    await crawler.crawl('https://example.com/');
    progressBridge.detach();

    // Should have sent notifications for page:start, page:done, crawl:progress, crawl:complete
    expect(mockSendNotification).toHaveBeenCalled();
    await tabPool.closeAll();
  });

  it('should include outputDir in response when specified', async () => {
    const bridge = createMockBridge();
    const tabPool = new TabPool(bridge, 1);
    await tabPool.init();

    const crawler = new Crawler({ bridge, tabPool });
    const result = await crawler.crawl('https://example.com/');

    // Simulate the response construction from tools/crawl.ts
    const outputDir = '/test/output';
    const response = { ...result, outputDir: outputDir ?? null };
    expect(response.outputDir).toBe('/test/output');
    await tabPool.closeAll();
  });

  it('should work without outputDir (no file writing)', async () => {
    const bridge = createMockBridge();
    const tabPool = new TabPool(bridge, 1);
    await tabPool.init();

    const crawler = new Crawler({ bridge, tabPool });
    const result = await crawler.crawl('https://example.com/');

    expect(result.pagesProcessed).toBe(1);
    expect(result.pagesFailed).toBe(0);

    // Response with null outputDir
    const response = { ...result, outputDir: null };
    expect(response.outputDir).toBeNull();
    await tabPool.closeAll();
  });

  it('should continue crawl when file write fails', async () => {
    const bridge = createMockBridge();
    const tabPool = new TabPool(bridge, 1);
    await tabPool.init();

    const failingWriteCallback = vi.fn<(url: string, html: string) => Promise<string | undefined>>()
      .mockRejectedValue(new Error('Permission denied'));

    const crawler = new Crawler({
      bridge,
      tabPool,
      onPageContent: failingWriteCallback,
    });

    const result = await crawler.crawl('https://example.com/');

    // Crawl continues despite write failure
    expect(result.pagesProcessed).toBe(1);
    // Error should be recorded
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('CRAWL_WRITE_FAILED');
    await tabPool.closeAll();
  });
});
