// Ephemeral page execution handler for MCP bridge.
// Opens a tab in the background automation window, waits for load, executes a script, and closes the tab.
// Guaranteed tab cleanup via try/finally — no tab leakage on any code path.

import { waitForTabLoad } from './tab-lifecycle.js';
import { openAutomationTab } from './automation-window.js';

async function executeOnPage(params) {
  const startTime = Date.now();
  let tabId;
  try {
    const tab = await openAutomationTab(params.url);
    tabId = tab.id;
    await waitForTabLoad(tabId, params.timeout);

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (script) => {
        const result = (0, eval)(script);
        if (result && typeof result.then === 'function') {
          return await result;
        }
        return result;
      },
      args: [params.script],
    });

    return {
      result: results[0].result,
      url: params.url,
      duration: Date.now() - startTime,
    };
  } finally {
    if (tabId != null) {
      try {
        await chrome.tabs.remove(tabId);
      } catch (closeErr) {
        console.warn('[MCP] Failed to close ephemeral tab:', closeErr.message);
      }
    }
  }
}

export const pageHandlers = { executeOnPage };
