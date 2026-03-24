// Tab lifecycle utilities for waiting on tab load state.
// Shared helper — imported by tab-manager.js and page-executor.js.

/**
 * Wait for a Chrome tab to reach 'complete' load status.
 * Resolves immediately if the tab is already loaded.
 * Rejects on timeout or if the tab is closed externally.
 *
 * @param {number} tabId - The Chrome tab ID to wait on.
 * @param {number} [timeoutMs=30000] - Maximum time to wait in milliseconds.
 * @returns {Promise<void>}
 */
export async function waitForTabLoad(tabId, timeoutMs = 30000) {
  // Immediate-complete check — resolve without registering listeners
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === 'complete') {
    return;
  }

  // Wait for load via listeners + timeout
  return new Promise((resolve, reject) => {
    function cleanup() {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timer);
    }

    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        cleanup();
        resolve();
      }
    };

    const onRemoved = (removedTabId) => {
      if (removedTabId === tabId) {
        cleanup();
        reject(new Error(`Tab ${tabId} was closed while waiting for it to load`));
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Page failed to load within ${timeoutMs}ms`));
    }, timeoutMs);

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}
