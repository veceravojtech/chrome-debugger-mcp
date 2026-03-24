// Chrome tabs API handlers for MCP bridge.
// Each handler receives JSON-RPC params and returns a result object.

import { waitForTabLoad } from './tab-lifecycle.js';

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
  // Direct navigation: navigate an existing tab by tabId
  if (params.tabId !== undefined) {
    try {
      await chrome.tabs.update(params.tabId, { url: params.url });
    } catch (err) {
      throw new Error(`Tab ${params.tabId} not found`);
    }
    await waitForTabLoad(params.tabId);
    const tab = await chrome.tabs.get(params.tabId);
    return {
      tabId: tab.id,
      url: tab.url ?? params.url,
      title: tab.title ?? '',
      navigated: true,
      reused: false,
    };
  }

  let tabId;
  let reused = false;

  // Tab reuse: query for existing tab when reuseTab !== false
  if (params.reuseTab !== false) {
    // Compare normalized URLs (strip trailing slash, fragment, and query)
    const normalize = (u) => u.replace(/\/?([\?#].*)?$/, '');
    const targetNorm = normalize(params.url);
    const allTabs = await chrome.tabs.query({});
    const existing = allTabs.filter(t => normalize(t.url ?? '') === targetNorm);
    if (existing.length > 0) {
      tabId = existing[0].id;
      await chrome.tabs.update(tabId, { active: true });
      reused = true;
    }
  }

  // Create new tab if no reuse
  if (!tabId) {
    const created = await chrome.tabs.create({ url: params.url, active: true });
    tabId = created.id;
  }

  // Wait for page load (resolves immediately if already complete)
  await waitForTabLoad(tabId);

  // Get final tab state for title
  const tab = await chrome.tabs.get(tabId);
  return {
    tabId: tab.id,
    url: tab.url ?? params.url,
    title: tab.title ?? '',
    reused,
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
