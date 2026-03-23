// Chrome tabs API handlers for MCP bridge.
// Each handler receives JSON-RPC params and returns a result object.

async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map(tab => ({
    tabId: tab.id,
    url: tab.url ?? '',
    title: tab.title ?? '',
    active: tab.active,
    windowId: tab.windowId,
  }));
}

async function openTab(params) {
  const tab = await chrome.tabs.create({ url: params.url });
  return {
    tabId: tab.id,
    url: tab.url ?? params.url,
    title: tab.title ?? '',
  };
}

async function closeTab(params) {
  try {
    await chrome.tabs.remove(params.tabId);
  } catch (err) {
    throw new Error(`Tab ${params.tabId} not found`);
  }
  return { success: true };
}

async function switchTab(params) {
  try {
    const tab = await chrome.tabs.update(params.tabId, { active: true });
    return {
      tabId: tab.id,
      url: tab.url ?? '',
      title: tab.title ?? '',
    };
  } catch (err) {
    throw new Error(`Tab ${params.tabId} not found`);
  }
}

async function reloadTab(params) {
  try {
    await chrome.tabs.reload(params.tabId);
    const tab = await chrome.tabs.get(params.tabId);
    return {
      tabId: tab.id,
      url: tab.url ?? '',
      title: tab.title ?? '',
    };
  } catch (err) {
    throw new Error(`Tab ${params.tabId} not found`);
  }
}

export const tabHandlers = {
  listTabs,
  openTab,
  closeTab,
  switchTab,
  reloadTab,
};
