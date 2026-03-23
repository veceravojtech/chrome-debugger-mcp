import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Bridge } from '../bridge/index.js';
import { McpError, ErrorCode } from '../errors/index.js';
import { TabPool } from './tab-pool.js';

function createMockBridge(overrides?: Partial<Bridge>): Bridge {
  let nextTabId = 100;
  return {
    connectionState: 'connected',
    extensionVersion: '1.0.0',
    wsPort: 9222,
    lastError: null,
    send: vi.fn().mockImplementation((method: string) => {
      if (method === 'tabs.open') {
        return Promise.resolve({ tabId: nextTabId++ });
      }
      if (method === 'tabs.close') {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    }),
    ...overrides,
  } as unknown as Bridge;
}

describe('TabPool', () => {
  let bridge: Bridge;

  beforeEach(() => {
    bridge = createMockBridge();
  });

  describe('init', () => {
    it('should open correct number of tabs', async () => {
      const pool = new TabPool(bridge, 3);
      await pool.init();

      expect(bridge.send).toHaveBeenCalledTimes(3);
      expect(bridge.send).toHaveBeenCalledWith('tabs.open', { url: 'about:blank' });
    });
  });

  describe('acquire', () => {
    it('should return an available tab', async () => {
      const pool = new TabPool(bridge, 2);
      await pool.init();

      const tabId = await pool.acquire();
      expect(typeof tabId).toBe('number');
    });

    it('should wait when no tabs available and resolve when one is released', async () => {
      const pool = new TabPool(bridge, 1);
      await pool.init();

      const firstTab = await pool.acquire();

      // Second acquire should wait
      let resolved = false;
      const acquirePromise = pool.acquire().then(id => {
        resolved = true;
        return id;
      });

      // Not resolved yet
      await new Promise(r => setTimeout(r, 10));
      expect(resolved).toBe(false);

      // Release the first tab
      pool.release(firstTab);

      const secondTab = await acquirePromise;
      expect(resolved).toBe(true);
      expect(secondTab).toBe(firstTab);
    });

    it('should throw CRAWL_TAB_POOL_EXHAUSTED on timeout', async () => {
      vi.useFakeTimers();
      try {
        const pool = new TabPool(bridge, 1);
        await pool.init();

        await pool.acquire(); // take the only tab

        const acquirePromise = pool.acquire(); // should timeout

        vi.advanceTimersByTime(60_001);

        await expect(acquirePromise).rejects.toThrow(McpError);
        await expect(acquirePromise).rejects.toMatchObject({
          code: ErrorCode.CRAWL_TAB_POOL_EXHAUSTED,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('should reject immediately when all tabs are errored', async () => {
      const pool = new TabPool(bridge, 2);
      await pool.init();

      const tab1 = await pool.acquire();
      const tab2 = await pool.acquire();

      pool.markError(tab1);
      pool.markError(tab2);
      pool.release(tab1);
      pool.release(tab2);

      await expect(pool.acquire()).rejects.toThrow(McpError);
      await expect(pool.acquire()).rejects.toMatchObject({
        code: ErrorCode.CRAWL_TAB_POOL_EXHAUSTED,
      });
    });
  });

  describe('release', () => {
    it('should make tab available again', async () => {
      const pool = new TabPool(bridge, 1);
      await pool.init();

      const tabId = await pool.acquire();
      pool.release(tabId);

      const sameTab = await pool.acquire();
      expect(sameTab).toBe(tabId);
    });
  });

  describe('markError', () => {
    it('should prevent tab from being acquired', async () => {
      vi.useFakeTimers();
      try {
        const pool = new TabPool(bridge, 1);
        await pool.init();

        const tabId = await pool.acquire();
        pool.markError(tabId);
        pool.release(tabId);

        // All tabs errored, should reject immediately
        await expect(pool.acquire()).rejects.toThrow(McpError);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('closeAll', () => {
    it('should close all tabs', async () => {
      const pool = new TabPool(bridge, 3);
      await pool.init();

      await pool.closeAll();

      // 3 opens + 3 closes
      expect(bridge.send).toHaveBeenCalledTimes(6);
      const closeCalls = (bridge.send as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === 'tabs.close',
      );
      expect(closeCalls).toHaveLength(3);
    });

    it('should not throw when tabs are already closed', async () => {
      const failingBridge = createMockBridge({
        send: vi.fn().mockImplementation((method: string) => {
          if (method === 'tabs.open') {
            return Promise.resolve({ tabId: 200 });
          }
          if (method === 'tabs.close') {
            return Promise.reject(new Error('Tab already closed'));
          }
          return Promise.resolve({});
        }),
      } as Partial<Bridge>);

      const pool = new TabPool(failingBridge, 1);
      await pool.init();

      // Should not throw
      await expect(pool.closeAll()).resolves.toBeUndefined();
    });
  });
});
