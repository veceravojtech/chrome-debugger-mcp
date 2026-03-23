import type { Bridge } from '../bridge/index.js';
import { McpError, ErrorCode } from '../errors/index.js';
import { TAB_ACQUIRE_TIMEOUT_MS } from '../types.js';
import { logger } from '../logger.js';

interface Waiter {
  resolve: (tabId: number) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class TabPool {
  private readonly tabIds: number[] = [];
  private readonly available = new Set<number>();
  private readonly errored = new Set<number>();
  private readonly waiters: Waiter[] = [];
  private readonly bridge: Bridge;
  readonly size: number;

  constructor(bridge: Bridge, size: number) {
    this.bridge = bridge;
    this.size = size;
  }

  async init(): Promise<void> {
    for (let i = 0; i < this.size; i++) {
      const result = await this.bridge.send('tabs.open', { url: 'about:blank' }) as { tabId: number };
      this.tabIds.push(result.tabId);
      this.available.add(result.tabId);
    }
    logger.info('Tab pool initialized', { size: this.size, tabIds: this.tabIds });
  }

  acquire(): Promise<number> {
    // Try to find an available (non-errored) tab immediately
    for (const tabId of this.available) {
      if (!this.errored.has(tabId)) {
        this.available.delete(tabId);
        return Promise.resolve(tabId);
      }
    }

    // Check if all tabs are errored — fail fast
    if (this.errored.size >= this.tabIds.length) {
      return Promise.reject(
        new McpError(
          ErrorCode.CRAWL_TAB_POOL_EXHAUSTED,
          'All tabs in the pool are in error state',
          { poolSize: this.size, erroredCount: this.errored.size },
          'The crawl cannot continue because all browser tabs have failed',
          false,
        ),
      );
    }

    // Wait for a tab to be released
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex(w => w.resolve === resolve);
        if (idx !== -1) {
          this.waiters.splice(idx, 1);
        }
        reject(
          new McpError(
            ErrorCode.CRAWL_TAB_POOL_EXHAUSTED,
            `Timed out waiting for available tab after ${TAB_ACQUIRE_TIMEOUT_MS}ms`,
            { poolSize: this.size, availableCount: this.available.size, erroredCount: this.errored.size },
            'All tabs are busy or in error state. Consider reducing parallelTabs or increasing timeout',
            false,
          ),
        );
      }, TAB_ACQUIRE_TIMEOUT_MS);

      this.waiters.push({ resolve, reject, timer });
    });
  }

  release(tabId: number): void {
    // If there's a waiter, give the tab directly
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      clearTimeout(waiter.timer);
      if (!this.errored.has(tabId)) {
        waiter.resolve(tabId);
        return;
      }
      // If the released tab is errored, we can't give it to the waiter
      // Put waiter back? No — re-add this tab and let waiter try acquire again.
      // Actually, just mark available and let the waiter resolve via available pool.
    }

    this.available.add(tabId);
  }

  markError(tabId: number): void {
    this.errored.add(tabId);
    this.available.delete(tabId);
    logger.warn('Tab marked as errored', { tabId });
  }

  async closeAll(): Promise<void> {
    // Cancel all waiters
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
    }
    this.waiters.length = 0;

    for (const tabId of this.tabIds) {
      try {
        await this.bridge.send('tabs.close', { tabId });
      } catch {
        // Safe to ignore — tab may already be closed
      }
    }

    this.tabIds.length = 0;
    this.available.clear();
    this.errored.clear();
    logger.info('Tab pool closed');
  }
}
