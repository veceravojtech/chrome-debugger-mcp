// Screenshot capture handler for MCP bridge.

async function capture(params) {
  try {
    const tab = await chrome.tabs.get(params.tabId);
    await chrome.tabs.update(params.tabId, { active: true });
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: params.format || 'png',
    });
    return { dataUrl };
  } catch (err) {
    throw new Error(`Failed to capture screenshot of tab ${params.tabId}: ${err.message}`);
  }
}

export const screenshotHandlers = {
  capture,
};
