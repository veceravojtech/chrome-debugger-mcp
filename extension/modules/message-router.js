// Chrome Debugger MCP — Message Router
// Routes incoming JSON-RPC requests to registered handler functions.
// Returns JSON-RPC response objects (caller is responsible for sending).

const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

export class MessageRouter {
  #handlers = new Map();

  /**
   * Register a handler for a JSON-RPC method name.
   * @param {string} method — dot-namespaced method name (e.g. "tabs.list")
   * @param {function(object): Promise<*>} handler — async function receiving params, returning result
   */
  register(method, handler) {
    this.#handlers.set(method, handler);
  }

  /**
   * Route a JSON-RPC request to its registered handler.
   * @param {object} request — parsed JSON-RPC request { jsonrpc, id, method, params }
   * @returns {Promise<object|null>} JSON-RPC response object, or null for notifications (no id)
   */
  async route(request) {
    // Notifications (no id) are fire-and-forget — no response
    if (request.id == null) {
      const handler = this.#handlers.get(request.method);
      if (handler) {
        try {
          await handler(request.params);
        } catch (err) {
          console.error(`[MCP] Notification handler error for ${request.method}:`, err);
        }
      }
      return null;
    }

    const handler = this.#handlers.get(request.method);

    if (!handler) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: METHOD_NOT_FOUND,
          message: `Method not found: ${request.method}`,
        },
      };
    }

    try {
      const result = await handler(request.params);
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: result ?? null,
      };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: INTERNAL_ERROR,
          message: `Internal error: ${err.message ?? String(err)}`,
        },
      };
    }
  }
}
