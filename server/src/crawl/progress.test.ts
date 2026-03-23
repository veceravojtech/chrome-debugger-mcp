import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { EventEmitter } from 'node:events';
import { CrawlProgressBridge } from './progress.js';
import type { Crawler } from './crawler.js';

type SendNotificationMock = Mock<(notification: object) => Promise<void>>;

function createMockCrawler(): Crawler {
  return new EventEmitter() as unknown as Crawler;
}

describe('CrawlProgressBridge', () => {
  let mockCrawler: Crawler;
  let mockSendNotification: SendNotificationMock;

  beforeEach(() => {
    mockCrawler = createMockCrawler();
    mockSendNotification = vi.fn<(notification: object) => Promise<void>>().mockResolvedValue(undefined);
  });

  it('attach subscribes to all crawler events', () => {
    const bridge = new CrawlProgressBridge(mockCrawler, mockSendNotification, 'token-1');
    bridge.attach();

    const emitter = mockCrawler as unknown as EventEmitter;
    expect(emitter.listenerCount('page:start')).toBe(1);
    expect(emitter.listenerCount('page:done')).toBe(1);
    expect(emitter.listenerCount('page:error')).toBe(1);
    expect(emitter.listenerCount('crawl:progress')).toBe(1);
    expect(emitter.listenerCount('crawl:complete')).toBe(1);

    bridge.detach();
  });

  it('crawl:progress sends notifications/progress with correct shape', async () => {
    const bridge = new CrawlProgressBridge(mockCrawler, mockSendNotification, 'token-1');
    bridge.attach();

    const emitter = mockCrawler as unknown as EventEmitter;
    emitter.emit('crawl:progress', {
      pagesFound: 10,
      pagesCrawled: 5,
      pagesFailed: 1,
      pagesRemaining: 4,
      currentUrls: ['https://example.com/a'],
    });

    // Wait for async notification
    await vi.waitFor(() => expect(mockSendNotification).toHaveBeenCalled());

    // Should send both notifications/progress and notifications/message
    const progressCall = mockSendNotification.mock.calls.find(
      (c: unknown[]) => (c[0] as { method: string }).method === 'notifications/progress',
    );
    expect(progressCall).toBeDefined();
    const progressNotification = progressCall![0] as {
      method: string;
      params: { progressToken: string; progress: number; total: number; message: string };
    };
    expect(progressNotification.params.progressToken).toBe('token-1');
    expect(progressNotification.params.progress).toBe(5);
    expect(progressNotification.params.total).toBe(10);

    const parsed = JSON.parse(progressNotification.params.message);
    expect(parsed.pagesFound).toBe(10);
    expect(parsed.pagesCrawled).toBe(5);
    expect(parsed.pagesFailed).toBe(1);
    expect(parsed.pagesRemaining).toBe(4);
    expect(parsed.currentUrls).toEqual(['https://example.com/a']);

    bridge.detach();
  });

  it('page:start sends notifications/message with info level', async () => {
    const bridge = new CrawlProgressBridge(mockCrawler, mockSendNotification);
    bridge.attach();

    const emitter = mockCrawler as unknown as EventEmitter;
    emitter.emit('page:start', { url: 'https://example.com/', depth: 0 });

    await vi.waitFor(() => expect(mockSendNotification).toHaveBeenCalled());

    const call = mockSendNotification.mock.calls[0][0] as {
      method: string;
      params: { level: string; logger: string; data: unknown };
    };
    expect(call.method).toBe('notifications/message');
    expect(call.params.level).toBe('info');
    expect(call.params.logger).toBe('crawl');

    bridge.detach();
  });

  it('page:error sends notifications/message with warning level', async () => {
    const bridge = new CrawlProgressBridge(mockCrawler, mockSendNotification);
    bridge.attach();

    const emitter = mockCrawler as unknown as EventEmitter;
    emitter.emit('page:error', { url: 'https://example.com/bad', error: { message: 'failed' } });

    await vi.waitFor(() => expect(mockSendNotification).toHaveBeenCalled());

    const call = mockSendNotification.mock.calls[0][0] as {
      method: string;
      params: { level: string; logger: string; data: unknown };
    };
    expect(call.method).toBe('notifications/message');
    expect(call.params.level).toBe('warning');
    expect(call.params.logger).toBe('crawl');

    bridge.detach();
  });

  it('crawl:complete sends final progress notification', async () => {
    const bridge = new CrawlProgressBridge(mockCrawler, mockSendNotification, 'token-2');
    bridge.attach();

    const emitter = mockCrawler as unknown as EventEmitter;
    emitter.emit('crawl:complete', {
      totalPages: 20,
      succeeded: 18,
      failed: 2,
      durationMs: 5000,
    });

    await vi.waitFor(() => expect(mockSendNotification).toHaveBeenCalled());

    const progressCall = mockSendNotification.mock.calls.find(
      (c: unknown[]) => (c[0] as { method: string }).method === 'notifications/progress',
    );
    expect(progressCall).toBeDefined();

    const notification = progressCall![0] as {
      params: { progressToken: string; progress: number; total: number };
    };
    // Final: progress === total
    expect(notification.params.progress).toBe(20);
    expect(notification.params.total).toBe(20);

    bridge.detach();
  });

  it('detach removes all listeners', () => {
    const bridge = new CrawlProgressBridge(mockCrawler, mockSendNotification, 'token-1');
    bridge.attach();

    const emitter = mockCrawler as unknown as EventEmitter;
    expect(emitter.listenerCount('page:start')).toBe(1);

    bridge.detach();

    expect(emitter.listenerCount('page:start')).toBe(0);
    expect(emitter.listenerCount('page:done')).toBe(0);
    expect(emitter.listenerCount('page:error')).toBe(0);
    expect(emitter.listenerCount('crawl:progress')).toBe(0);
    expect(emitter.listenerCount('crawl:complete')).toBe(0);
  });

  it('no progress notification when progressToken is undefined', async () => {
    // No progressToken
    const bridge = new CrawlProgressBridge(mockCrawler, mockSendNotification);
    bridge.attach();

    const emitter = mockCrawler as unknown as EventEmitter;
    emitter.emit('crawl:progress', {
      pagesFound: 10,
      pagesCrawled: 5,
      pagesFailed: 0,
      pagesRemaining: 5,
      currentUrls: [],
    });

    await vi.waitFor(() => expect(mockSendNotification).toHaveBeenCalled());

    // Should only send notifications/message, NOT notifications/progress
    const progressCalls = mockSendNotification.mock.calls.filter(
      (c: unknown[]) => (c[0] as { method: string }).method === 'notifications/progress',
    );
    expect(progressCalls).toHaveLength(0);

    // Should still send notifications/message
    const messageCalls = mockSendNotification.mock.calls.filter(
      (c: unknown[]) => (c[0] as { method: string }).method === 'notifications/message',
    );
    expect(messageCalls).toHaveLength(1);

    bridge.detach();
  });

  it('does not crash if sendNotification throws', async () => {
    const failingSend: SendNotificationMock = vi.fn<(notification: object) => Promise<void>>().mockRejectedValue(new Error('Client disconnected'));
    const bridge = new CrawlProgressBridge(mockCrawler, failingSend, 'token-1');
    bridge.attach();

    const emitter = mockCrawler as unknown as EventEmitter;
    // Should not throw
    emitter.emit('page:start', { url: 'https://example.com/', depth: 0 });

    await vi.waitFor(() => expect(failingSend).toHaveBeenCalled());

    bridge.detach();
  });
});
