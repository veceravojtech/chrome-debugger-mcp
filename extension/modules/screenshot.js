// Screenshot capture handler for MCP bridge.

async function capture(params) {
  try {
    const tab = await chrome.tabs.get(params.tabId);

    // captureVisibleTab only sees the active tab of a window. Activate the target
    // temporarily and restore the previous tab so the window looks unchanged.
    let previousTabId = null;
    if (!tab.active) {
      const [previous] = await chrome.tabs.query({ windowId: tab.windowId, active: true });
      previousTabId = previous?.id ?? null;
      await chrome.tabs.update(params.tabId, { active: true });
    }

    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: params.format || 'png',
      });
      return { dataUrl };
    } finally {
      if (previousTabId != null) {
        await chrome.tabs.update(previousTabId, { active: true }).catch(() => {});
      }
    }
  } catch (err) {
    throw new Error(`Failed to capture screenshot of tab ${params.tabId}: ${err.message}`);
  }
}

export const screenshotHandlers = {
  capture,
};
