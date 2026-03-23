// Chrome Debugger MCP — WebSocket Client
// Manages WebSocket connection to the MCP server bridge with exponential backoff reconnection.
// Browser handles WebSocket ping/pong at the protocol level — no application code needed.

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 5_000;
const BACKOFF_MULTIPLIER = 2;
const TAKEOVER_RETRY_MS = 500;
const TAKEOVER_CLOSE_CODE = 4100;
const VERSION = '1.0.0';
const DEFAULT_PORT = 9222;

export class WebSocketClient {
  #ws = null;
  #backoffMs = INITIAL_BACKOFF_MS;
  #reconnectTimer = null;
  #onMessage = null;
  #port = DEFAULT_PORT;
  #intentionalDisconnect = false;

  /**
   * @param {function(object): void} onMessage — called with parsed JSON-RPC messages
   */
  constructor(onMessage) {
    this.#onMessage = onMessage;
  }

  /**
   * Read port from chrome.storage.local and open WebSocket connection.
   * Sends handshake on open. Schedules reconnect on close/error.
   */
  async connect() {
    // Cancel any pending reconnect
    this.#clearReconnectTimer();

    // Read port from storage, default 9222
    try {
      const { wsPort } = await chrome.storage.local.get('wsPort');
      if (wsPort != null) {
        this.#port = Number(wsPort);
      }
    } catch {
      // Storage may not be available during early startup — use default
    }

    // Close existing connection if any
    if (this.#ws) {
      try {
        this.#ws.close();
      } catch {
        // Ignore close errors
      }
      this.#ws = null;
    }

    try {
      this.#ws = new WebSocket(`ws://127.0.0.1:${this.#port}`);
    } catch {
      this.#scheduleReconnect();
      return;
    }

    this.#ws.onopen = () => {
      console.log(`[MCP] WebSocket connected to ws://127.0.0.1:${this.#port}`);

      // Reset backoff on successful connection
      this.#backoffMs = INITIAL_BACKOFF_MS;

      // Send handshake as first message (triggers bridge connecting → connected)
      const handshake = {
        jsonrpc: '2.0',
        id: crypto.randomUUID(),
        method: 'handshake',
        params: {
          version: VERSION,
          capabilities: [],
        },
      };
      this.#ws.send(JSON.stringify(handshake));
      console.log('[MCP] Handshake sent');
    };

    this.#ws.onmessage = (event) => {
      let parsed;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        console.warn('[MCP] Received non-JSON message:', event.data);
        return;
      }

      if (this.#onMessage) {
        this.#onMessage(parsed);
      }
    };

    this.#ws.onclose = (event) => {
      console.log(`[MCP] WebSocket closed: code=${event.code} reason=${event.reason}`);
      this.#ws = null;
      if (this.#intentionalDisconnect) {
        this.#intentionalDisconnect = false;
        return;
      }
      this.#scheduleReconnect(event.code);
    };

    this.#ws.onerror = (event) => {
      console.error('[MCP] WebSocket error:', event);
      // onclose will fire after onerror — reconnection handled there
    };
  }

  /**
   * Gracefully disconnect without triggering reconnection.
   */
  disconnect() {
    this.#clearReconnectTimer();
    this.#intentionalDisconnect = true;
    if (this.#ws) {
      try {
        this.#ws.close(1000, 'Client disconnect');
      } catch {
        // Ignore
      }
      this.#ws = null;
    }
  }

  /**
   * @returns {boolean} true if WebSocket is in OPEN state
   */
  isConnected() {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Send a JSON-RPC message to the server.
   * @param {object} message — JSON-RPC response or request object
   */
  send(message) {
    if (!this.isConnected()) {
      console.warn('[MCP] Cannot send — WebSocket not connected');
      return;
    }
    this.#ws.send(JSON.stringify(message));
  }

  /**
   * Schedule a reconnection attempt with strategy based on close code.
   * Code 4100 (server takeover) = fixed 500ms retry.
   * Otherwise = exponential backoff capped at 5s.
   * @param {number} [closeCode] — WebSocket close code from the server
   */
  #scheduleReconnect(closeCode) {
    this.#clearReconnectTimer();

    let delayMs;

    if (closeCode === TAKEOVER_CLOSE_CODE) {
      // Server takeover — reconnect fast with fixed delay
      delayMs = TAKEOVER_RETRY_MS;
      this.#backoffMs = INITIAL_BACKOFF_MS; // Reset backoff for next disconnect
    } else {
      // Normal exponential backoff (crash / unknown close)
      delayMs = this.#backoffMs;
      this.#backoffMs = Math.min(this.#backoffMs * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS);
    }

    console.log(`[MCP] Reconnecting in ${delayMs}ms (code=${closeCode ?? 'none'})...`);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  /**
   * Cancel pending reconnection timer.
   */
  #clearReconnectTimer() {
    if (this.#reconnectTimer != null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
  }
}
