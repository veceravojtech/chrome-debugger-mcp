import { logger } from '../logger.js';
import type { Crawler } from './crawler.js';

export class CrawlProgressBridge {
  private readonly crawler: Crawler;
  private readonly sendNotification: (notification: object) => Promise<void>;
  private readonly progressToken?: string | number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly handlers = new Map<string, (...args: any[]) => void>();

  constructor(
    crawler: Crawler,
    sendNotification: (notification: object) => Promise<void>,
    progressToken?: string | number,
  ) {
    this.crawler = crawler;
    this.sendNotification = sendNotification;
    this.progressToken = progressToken;
  }

  attach(): void {
    const onPageStart = (data: unknown) => {
      this.safeSend({
        method: 'notifications/message',
        params: { level: 'info', logger: 'crawl', data },
      });
    };

    const onPageDone = (data: unknown) => {
      this.safeSend({
        method: 'notifications/message',
        params: { level: 'info', logger: 'crawl', data },
      });
    };

    const onPageError = (data: unknown) => {
      this.safeSend({
        method: 'notifications/message',
        params: { level: 'warning', logger: 'crawl', data },
      });
    };

    const onCrawlProgress = (data: {
      pagesFound: number;
      pagesCrawled: number;
      pagesFailed: number;
      pagesRemaining: number;
      currentUrls: string[];
    }) => {
      if (this.progressToken !== undefined) {
        this.safeSend({
          method: 'notifications/progress',
          params: {
            progressToken: this.progressToken,
            progress: data.pagesCrawled,
            total: data.pagesFound,
            message: JSON.stringify({
              pagesFound: data.pagesFound,
              pagesCrawled: data.pagesCrawled,
              pagesFailed: data.pagesFailed,
              pagesRemaining: data.pagesRemaining,
              currentUrls: data.currentUrls,
            }),
          },
        });
      }

      this.safeSend({
        method: 'notifications/message',
        params: { level: 'info', logger: 'crawl', data },
      });
    };

    const onCrawlComplete = (data: {
      totalPages: number;
      succeeded: number;
      failed: number;
      durationMs: number;
    }) => {
      if (this.progressToken !== undefined) {
        this.safeSend({
          method: 'notifications/progress',
          params: {
            progressToken: this.progressToken,
            progress: data.totalPages,
            total: data.totalPages,
            message: JSON.stringify({
              totalPages: data.totalPages,
              succeeded: data.succeeded,
              failed: data.failed,
              durationMs: data.durationMs,
            }),
          },
        });
      }

      this.safeSend({
        method: 'notifications/message',
        params: { level: 'info', logger: 'crawl', data },
      });
    };

    this.handlers.set('page:start', onPageStart);
    this.handlers.set('page:done', onPageDone);
    this.handlers.set('page:error', onPageError);
    this.handlers.set('crawl:progress', onCrawlProgress);
    this.handlers.set('crawl:complete', onCrawlComplete);

    for (const [event, handler] of this.handlers) {
      this.crawler.on(event, handler);
    }
  }

  detach(): void {
    for (const [event, handler] of this.handlers) {
      this.crawler.removeListener(event, handler);
    }
    this.handlers.clear();
  }

  private safeSend(notification: object): void {
    this.sendNotification(notification).catch((err: unknown) => {
      logger.warn('Failed to send MCP notification', {
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    });
  }
}
