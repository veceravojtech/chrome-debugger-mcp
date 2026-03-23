// Chrome Debugger MCP — Service Worker (Main Entry Point)
// Orchestrates WebSocket connection, message routing, offscreen keepalive, and alarm recovery.

import { WebSocketClient } from './modules/websocket-client.js';
import { MessageRouter } from './modules/message-router.js';
import { tabHandlers } from './modules/tab-manager.js';
import { contentHandlers } from './modules/content-extractor.js';
import { screenshotHandlers } from './modules/screenshot.js';
import { inspectorHandlers } from './modules/page-inspector.js';
import { linkHandlers } from './modules/link-discovery.js';

// --- Instantiate core modules ---

const router = new MessageRouter();
router.register('tabs.list', tabHandlers.listTabs);
router.register('tabs.open', tabHandlers.openTab);
router.register('tabs.close', tabHandlers.closeTab);
router.register('tabs.switch', tabHandlers.switchTab);
router.register('tabs.reload', tabHandlers.reloadTab);
router.register('dom.getSource', contentHandlers.getSource);
router.register('dom.getRendered', contentHandlers.getRendered);
router.register('scripting.execute', contentHandlers.executeJs);
router.register('resources.list', contentHandlers.getResources);
router.register('screenshot.capture', screenshotHandlers.capture);
router.register('cookies.get', inspectorHandlers.getCookies);
router.register('storage.get', inspectorHandlers.getStorage);
router.register('links.discover', linkHandlers.discoverLinks);

const wsClient = new WebSocketClient(async (message) => {
  // Skip responses (e.g. handshake reply) — only route requests from the server
  if (!message.method) {
    return;
  }

  // Route incoming JSON-RPC requests and send responses back
  const response = await router.route(message);
  if (response) {
    wsClient.send(response);
  }
});

// --- Offscreen document for keepalive ---

async function ensureOffscreenDocument() {
  try {
    const hasDoc = await chrome.offscreen.hasDocument();
    if (hasDoc) return;

    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: 'Keep service worker alive during MCP operations',
    });
    console.log('[MCP] Offscreen document created');
  } catch (err) {
    console.error('[MCP] Failed to create offscreen document:', err);
  }
}

// --- Alarm-based recovery (Layer 3) ---

chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    if (!wsClient.isConnected()) {
      console.log('[MCP] Alarm: WebSocket disconnected — reconnecting');
      wsClient.connect();
    }
    // Also ensure offscreen doc is alive
    ensureOffscreenDocument();
  }
});

// --- Handle keepalive messages from offscreen document ---

chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
  if (message.type === 'keepalive') {
    // No-op — receiving the message resets the service worker idle timer
  }
});

// --- Startup sequence ---

console.log('[MCP] Service worker starting');
ensureOffscreenDocument();
wsClient.connect();
