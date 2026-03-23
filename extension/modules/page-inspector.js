// Page inspection handlers for MCP bridge.
// Provides cookie reading via chrome.cookies.getAll and
// storage reading via chrome.scripting.executeScript.

async function getCookies(params) {
  try {
    const tab = await chrome.tabs.get(params.tabId);
    if (!tab.url || !tab.url.startsWith('http')) {
      return [];
    }
    const cookies = await chrome.cookies.getAll({ url: tab.url });
    return cookies.map(cookie => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      expirationDate: cookie.expirationDate,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
    }));
  } catch (err) {
    throw new Error(`Failed to get cookies for tab ${params.tabId}: ${err.message}`);
  }
}

async function getStorage(params) {
  try {
    const storageType = params.type;
    const results = await chrome.scripting.executeScript({
      target: { tabId: params.tabId },
      func: (type) => {
        const storage = type === 'local' ? localStorage : sessionStorage;
        const entries = {};
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          if (key !== null) {
            try {
              entries[key] = JSON.parse(storage.getItem(key));
            } catch {
              entries[key] = storage.getItem(key);
            }
          }
        }
        return { entries };
      },
      args: [storageType],
    });
    return results[0].result;
  } catch (err) {
    throw new Error(`Failed to get ${params.type}Storage for tab ${params.tabId}: ${err.message}`);
  }
}

export const inspectorHandlers = {
  getCookies,
  getStorage,
};
