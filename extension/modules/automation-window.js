// Dedicated background window for MCP-controlled tabs.
// Keeps automation out of the user's windows so nothing switches visible tabs or steals focus.

const STORAGE_KEY = 'automationWindowId';
const PLACEHOLDER_URL = chrome.runtime.getURL('automation.html');

let pending = null;

/**
 * Get the automation window ID, creating the window (unfocused) if needed.
 * Concurrent callers share one in-flight lookup so only one window is ever created.
 * @returns {Promise<number>}
 */
export function getAutomationWindowId() {
  pending ??= resolveAutomationWindow().finally(() => {
    pending = null;
  });
  return pending;
}

/**
 * Whether the tab is the placeholder that keeps the automation window alive.
 * @param {chrome.tabs.Tab} tab
 */
export function isPlaceholderTab(tab) {
  return tab.url === PLACEHOLDER_URL || tab.pendingUrl === PLACEHOLDER_URL;
}

async function resolveAutomationWindow() {
  const { [STORAGE_KEY]: storedId } = await chrome.storage.session.get(STORAGE_KEY);
  if (storedId != null) {
    try {
      await chrome.windows.get(storedId);
      return storedId;
    } catch {
      // Window was closed — fall through
    }
  }

  // Session storage is wiped on extension reload — adopt a surviving window by its placeholder tab
  const placeholder = (await chrome.tabs.query({})).find(isPlaceholderTab);
  if (placeholder) {
    await chrome.storage.session.set({ [STORAGE_KEY]: placeholder.windowId });
    return placeholder.windowId;
  }

  const previous = await chrome.windows.getLastFocused().catch(() => null);
  const created = await chrome.windows.create({ url: PLACEHOLDER_URL, focused: false });
  await chrome.storage.session.set({ [STORAGE_KEY]: created.id });

  // Some window managers ignore focused:false — hand focus back if the user was in Chrome
  if (previous?.focused) {
    await chrome.windows.update(previous.id, { focused: true }).catch(() => {});
  }

  return created.id;
}

/**
 * Open a tab in the automation window and make it the active tab there (so it renders unthrottled).
 * Created inactive first: tabs.create({ active: true }) calls SetInitialFocus() on the new page,
 * which on X11 makes the window manager focus the window — and switch to its workspace.
 * tabs.update({ active: true }) only switches the tab strip, without requesting focus.
 * @param {string} url
 * @returns {Promise<chrome.tabs.Tab>}
 */
export async function openAutomationTab(url) {
  const windowId = await getAutomationWindowId();
  const tab = await chrome.tabs.create({ url, windowId, active: false });
  await chrome.tabs.update(tab.id, { active: true });
  return tab;
}

/**
 * Explicitly bring a tab to the user: activate it and focus its window.
 * @param {number} tabId
 * @returns {Promise<chrome.tabs.Tab>}
 */
export async function bringToFront(tabId) {
  const tab = await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  return tab;
}
