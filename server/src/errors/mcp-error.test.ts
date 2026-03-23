import { describe, it, expect } from 'vitest';
import { McpError } from './mcp-error.js';
import { ErrorCode } from './error-codes.js';

describe('McpError', () => {
  it('should extend Error with correct name', () => {
    const err = new McpError(
      ErrorCode.TAB_NOT_FOUND,
      'Tab 42 not found',
      { tabId: 42 },
      'Check if the tab is still open',
      true,
    );

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('McpError');
    expect(err.message).toBe('Tab 42 not found');
  });

  it('should expose all fields', () => {
    const err = new McpError(
      ErrorCode.EXTENSION_DISCONNECTED,
      'Extension is not connected',
      { wsPort: 9222 },
      'Ensure the Chrome extension is installed and active',
      true,
    );

    expect(err.code).toBe('EXTENSION_DISCONNECTED');
    expect(err.resource).toEqual({ wsPort: 9222 });
    expect(err.hint).toBe('Ensure the Chrome extension is installed and active');
    expect(err.recoverable).toBe(true);
  });

  it('should serialize via toJSON()', () => {
    const err = new McpError(
      ErrorCode.OPERATION_TIMEOUT,
      'Operation timed out after 30s',
      { method: 'tabs.list' },
      'Retry the operation',
      true,
    );

    const json = err.toJSON();

    expect(json).toEqual({
      error: true,
      code: 'OPERATION_TIMEOUT',
      message: 'Operation timed out after 30s',
      resource: { method: 'tabs.list' },
      hint: 'Retry the operation',
      recoverable: true,
    });
  });

  it('should serialize correctly with JSON.stringify()', () => {
    const err = new McpError(
      ErrorCode.INVALID_PARAMETERS,
      'Missing required field: tabId',
      { tool: 'close_tab' },
      'Provide a valid tabId parameter',
      false,
    );

    const parsed = JSON.parse(JSON.stringify(err));

    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe('INVALID_PARAMETERS');
    expect(parsed.message).toBe('Missing required field: tabId');
    expect(parsed.resource).toEqual({ tool: 'close_tab' });
    expect(parsed.hint).toBe('Provide a valid tabId parameter');
    expect(parsed.recoverable).toBe(false);
  });

  it('should handle empty resource object', () => {
    const err = new McpError(
      ErrorCode.TAB_NOT_FOUND,
      'Not found',
      {},
      'Try again',
      false,
    );

    expect(err.toJSON().resource).toEqual({});
  });
});
