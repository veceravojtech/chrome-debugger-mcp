// Content extraction handlers for MCP bridge.
// Each handler receives JSON-RPC params and returns a result object.

async function getSource(params) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: params.tabId },
      func: async () => {
        const response = await fetch(document.URL, { credentials: 'include' });
        const html = await response.text();
        return { html, url: document.URL };
      },
    });
    return results[0].result;
  } catch (err) {
    throw new Error(`Failed to get page source for tab ${params.tabId}: ${err.message}`);
  }
}

async function getRendered(params) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: params.tabId },
      func: () => {
        return {
          html: document.documentElement.outerHTML,
          url: document.URL,
        };
      },
    });
    return results[0].result;
  } catch (err) {
    throw new Error(`Failed to get rendered DOM for tab ${params.tabId}: ${err.message}`);
  }
}

async function executeJs(params) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: params.tabId },
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
    return { result: results[0].result };
  } catch (err) {
    throw new Error(`Failed to execute script on tab ${params.tabId}: ${err.message}`);
  }
}

async function getResources(params) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: params.tabId },
      func: () => {
        const entries = performance.getEntriesByType('resource');
        return entries.map(entry => ({
          url: entry.name,
          type: entry.initiatorType,
          size: entry.transferSize || 0,
        }));
      },
    });
    return results[0].result;
  } catch (err) {
    throw new Error(`Failed to get page resources for tab ${params.tabId}: ${err.message}`);
  }
}

export const contentHandlers = {
  getSource,
  getRendered,
  executeJs,
  getResources,
};
