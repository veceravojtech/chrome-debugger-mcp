import { describe, it, expect, vi } from 'vitest';
import type { Bridge } from '../bridge/index.js';
import { McpError, ErrorCode } from '../errors/index.js';

function createMockBridge(sendResult?: unknown): Bridge {
  return {
    connectionState: 'connected',
    extensionVersion: '1.0.0',
    wsPort: 9222,
    lastError: null,
    send: vi.fn().mockResolvedValue(sendResult),
  } as unknown as Bridge;
}

function createFailingBridge(error: Error): Bridge {
  return {
    connectionState: 'connected',
    extensionVersion: '1.0.0',
    wsPort: 9222,
    lastError: null,
    send: vi.fn().mockRejectedValue(error),
  } as unknown as Bridge;
}

// Helper to simulate tool handler logic for execute_on_page
async function handleExecuteOnPage(bridge: Bridge, url: string, script: string, timeout?: number) {
  try {
    const params: Record<string, unknown> = { url, script };
    if (timeout !== undefined) {
      params.timeout = timeout;
    }
    const result = await bridge.send('page.executeOnPage', params);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    if (err instanceof Error && err.message.includes('failed to load within')) {
      throw new McpError(
        ErrorCode.OPERATION_TIMEOUT,
        `Page failed to load within timeout: ${url}`,
        { url, timeoutMs: timeout ?? 30000 },
        'The page may be slow or unreachable. Verify the URL is accessible and try again.',
        true,
      );
    }
    throw err;
  }
}

describe('Page tools handlers', () => {
  describe('execute_on_page', () => {
    it('should call bridge.send with page.executeOnPage and { url, script } on success', async () => {
      const execResult = { result: 'Example Domain', url: 'https://example.com', duration: 1234 };
      const bridge = createMockBridge(execResult);

      const result = await handleExecuteOnPage(bridge, 'https://example.com', 'document.title');

      expect(bridge.send).toHaveBeenCalledWith('page.executeOnPage', {
        url: 'https://example.com',
        script: 'document.title',
      });
      expect(result.content).toHaveLength(1);
      expect(JSON.parse(result.content[0].text)).toEqual(execResult);
    });

    it('should pass timeout to bridge when provided', async () => {
      const execResult = { result: 'test', url: 'https://example.com', duration: 500 };
      const bridge = createMockBridge(execResult);

      await handleExecuteOnPage(bridge, 'https://example.com', 'document.title', 5000);

      expect(bridge.send).toHaveBeenCalledWith('page.executeOnPage', {
        url: 'https://example.com',
        script: 'document.title',
        timeout: 5000,
      });
    });

    it('should NOT include timeout in bridge params when undefined', async () => {
      const bridge = createMockBridge({ result: 'test' });

      await handleExecuteOnPage(bridge, 'https://example.com', 'document.title');

      const callArgs = (bridge.send as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(callArgs[1]).not.toHaveProperty('timeout');
    });

    it('should format result as MCP content (single text element, JSON stringified)', async () => {
      const execResult = { result: 42, url: 'https://example.com', duration: 100 };
      const bridge = createMockBridge(execResult);

      const result = await handleExecuteOnPage(bridge, 'https://example.com', '21 + 21');

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(typeof result.content[0].text).toBe('string');
      expect(JSON.parse(result.content[0].text)).toEqual(execResult);
    });

    it('should throw McpError with OPERATION_TIMEOUT on timeout error', async () => {
      const bridge = createFailingBridge(new Error('Page https://slow.com failed to load within 30000ms'));

      await expect(
        handleExecuteOnPage(bridge, 'https://slow.com', 'document.title'),
      ).rejects.toThrow(McpError);

      try {
        await handleExecuteOnPage(bridge, 'https://slow.com', 'document.title');
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        const mcpErr = err as McpError;
        expect(mcpErr.code).toBe(ErrorCode.OPERATION_TIMEOUT);
        expect(mcpErr.message).toContain('https://slow.com');
      }
    });

    it('should include URL, timeoutMs in resource, hint, and recoverable: true on timeout', async () => {
      const bridge = createFailingBridge(new Error('Page failed to load within 5000ms'));

      try {
        await handleExecuteOnPage(bridge, 'https://slow.com', 'document.title', 5000);
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        const mcpErr = err as McpError;
        expect(mcpErr.resource).toEqual({ url: 'https://slow.com', timeoutMs: 5000 });
        expect(mcpErr.hint).toContain('Verify the URL is accessible');
        expect(mcpErr.recoverable).toBe(true);
      }
    });

    it('should use default 30000ms in resource when timeout not provided', async () => {
      const bridge = createFailingBridge(new Error('Page failed to load within 30000ms'));

      try {
        await handleExecuteOnPage(bridge, 'https://slow.com', 'document.title');
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        const mcpErr = err as McpError;
        expect(mcpErr.resource).toEqual({ url: 'https://slow.com', timeoutMs: 30000 });
      }
    });

    it('should re-throw non-timeout errors without wrapping', async () => {
      const bridge = createFailingBridge(new Error('Script execution failed: ReferenceError'));

      await expect(
        handleExecuteOnPage(bridge, 'https://example.com', 'nonExistentVar'),
      ).rejects.toThrow('Script execution failed: ReferenceError');

      await expect(
        handleExecuteOnPage(bridge, 'https://example.com', 'nonExistentVar'),
      ).rejects.not.toThrow(McpError);
    });
  });
});
