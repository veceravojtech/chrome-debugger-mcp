// Chrome Debugger MCP — Offscreen Keepalive
// Sends a keepalive message every 20 seconds to prevent service worker suspension.
// This is the fallback keepalive layer — independent of WebSocket activity.

setInterval(() => {
  chrome.runtime.sendMessage({ type: 'keepalive' }).catch(() => {
    // Service worker might not be ready — ignore errors
  });
}, 20_000);
