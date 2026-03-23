// Shared type definitions for chrome-debugger-mcp server

export const SERVER_VERSION = '1.0.0';

export interface BridgeOptions {
  port?: number;
}

export const DEFAULT_WS_PORT = 9222;
export const KEEPALIVE_INTERVAL_MS = 20_000;
export const KEEPALIVE_TIMEOUT_MS = 5_000;
export const COMMAND_TIMEOUT_MS = 30_000;
export const COMMAND_QUEUE_TIMEOUT_MS = 30_000;
export const CRAWL_PAGE_TIMEOUT_MS = 300_000;
export const TAB_ACQUIRE_TIMEOUT_MS = 60_000;
export const DEFAULT_PARALLEL_TABS = 3;
export const MAX_PARALLEL_TABS = 5;
export const DEFAULT_MAX_DEPTH = 10;
