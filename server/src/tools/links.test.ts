import { describe, it, expect, vi } from 'vitest';
import type { Bridge } from '../bridge/index.js';
import { McpError, ErrorCode } from '../errors/index.js';
import { filterLinks, globToRegex } from './links.js';
import type { LinkResult, FilterParams } from './links.js';

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

// Helper to simulate discover_links tool handler logic
async function handleDiscoverLinks(
  bridge: Bridge,
  tabId: number,
  filter?: FilterParams,
) {
  try {
    const rawLinks = await bridge.send('links.discover', { tabId }) as LinkResult[];
    const filtered = filterLinks(rawLinks, filter);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(filtered, null, 2) }],
    };
  } catch (err) {
    if (err instanceof McpError) {
      throw err;
    }
    if (err instanceof Error && err.message.includes('not found')) {
      throw new McpError(
        ErrorCode.TAB_NOT_FOUND,
        `Tab ${tabId} does not exist or has been closed`,
        { tabId },
        'Call list_tabs to get current tab IDs',
        true,
      );
    }
    throw err;
  }
}

const sampleLinks: LinkResult[] = [
  { url: 'https://example.com/', text: 'Home', attributes: {} },
  { url: 'https://example.com/docs/getting-started', text: 'Getting Started', attributes: { class: 'nav-link' } },
  { url: 'https://example.com/docs/api/v2/users', text: 'Users API', attributes: { target: '_blank' } },
  { url: 'https://example.com/blog/post-1', text: 'Blog Post', attributes: {} },
  { url: 'https://sub.example.com/page', text: 'Subdomain Page', attributes: {} },
  { url: 'https://other.com/external', text: 'External Link', attributes: { rel: 'noopener' } },
  { url: 'https://example.com/api/v3/items', text: 'Items API', attributes: {} },
];

describe('Link tools handlers', () => {
  describe('discover_links (unfiltered)', () => {
    it('should call bridge.send with links.discover and return all links as MCP content', async () => {
      const bridge = createMockBridge(sampleLinks);

      const result = await handleDiscoverLinks(bridge, 123);

      expect(bridge.send).toHaveBeenCalledWith('links.discover', { tabId: 123 });
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(sampleLinks.length);
      expect(parsed).toEqual(sampleLinks);
    });
  });

  describe('domain filter', () => {
    it('should return only links matching the specified domain including subdomains', async () => {
      const bridge = createMockBridge(sampleLinks);

      const result = await handleDiscoverLinks(bridge, 123, { domain: 'example.com' });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(6);
      expect(parsed.every((l: LinkResult) => {
        const hostname = new URL(l.url).hostname;
        return hostname === 'example.com' || hostname.endsWith('.example.com');
      })).toBe(true);
      expect(parsed.find((l: LinkResult) => l.url.includes('other.com'))).toBeUndefined();
    });
  });

  describe('pathPrefix filter', () => {
    it('should return only links whose pathname starts with the specified prefix', async () => {
      const bridge = createMockBridge(sampleLinks);

      const result = await handleDiscoverLinks(bridge, 123, { pathPrefix: '/docs/' });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(2);
      expect(parsed.every((l: LinkResult) => new URL(l.url).pathname.startsWith('/docs/'))).toBe(true);
    });
  });

  describe('regex filter', () => {
    it('should return only links whose full URL matches the regex pattern', async () => {
      const bridge = createMockBridge(sampleLinks);

      const result = await handleDiscoverLinks(bridge, 123, { regex: '/api/v[0-9]+' });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(2);
      expect(parsed.every((l: LinkResult) => /\/api\/v[0-9]+/.test(l.url))).toBe(true);
    });
  });

  describe('glob filter', () => {
    it('should return only links whose URL pathname matches the glob pattern', async () => {
      const bridge = createMockBridge(sampleLinks);

      const result = await handleDiscoverLinks(bridge, 123, { glob: '/docs/**' });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(2);
      expect(parsed.every((l: LinkResult) => new URL(l.url).pathname.startsWith('/docs/'))).toBe(true);
    });
  });

  describe('combined filters (AND logic)', () => {
    it('should apply multiple filters with AND logic', async () => {
      const bridge = createMockBridge(sampleLinks);

      const result = await handleDiscoverLinks(bridge, 123, {
        domain: 'example.com',
        pathPrefix: '/docs/',
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(2);
      expect(parsed.every((l: LinkResult) => {
        const u = new URL(l.url);
        return (u.hostname === 'example.com' || u.hostname.endsWith('.example.com'))
          && u.pathname.startsWith('/docs/');
      })).toBe(true);
    });

    it('should return empty array when no links match all combined filters', async () => {
      const bridge = createMockBridge(sampleLinks);

      const result = await handleDiscoverLinks(bridge, 123, {
        domain: 'other.com',
        pathPrefix: '/docs/',
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(0);
    });
  });

  describe('invalid regex', () => {
    it('should throw McpError with INVALID_PARAMETERS for invalid regex pattern', async () => {
      const bridge = createMockBridge(sampleLinks);

      await expect(handleDiscoverLinks(bridge, 123, { regex: '[invalid(' })).rejects.toThrow(McpError);

      try {
        await handleDiscoverLinks(bridge, 123, { regex: '[invalid(' });
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        const mcpErr = err as McpError;
        expect(mcpErr.code).toBe(ErrorCode.INVALID_PARAMETERS);
        expect(mcpErr.resource).toEqual({ regex: '[invalid(' });
        expect(mcpErr.hint).toBe('Provide a valid JavaScript regular expression');
        expect(mcpErr.recoverable).toBe(false);
      }
    });
  });

  describe('invalid tabId', () => {
    it('should throw McpError with TAB_NOT_FOUND for invalid tabId', async () => {
      const bridge = createFailingBridge(new Error('Tab 99999 not found'));

      await expect(handleDiscoverLinks(bridge, 99999)).rejects.toThrow(McpError);

      try {
        await handleDiscoverLinks(bridge, 99999);
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        const mcpErr = err as McpError;
        expect(mcpErr.code).toBe(ErrorCode.TAB_NOT_FOUND);
        expect(mcpErr.resource).toEqual({ tabId: 99999 });
        expect(mcpErr.hint).toBe('Call list_tabs to get current tab IDs');
        expect(mcpErr.recoverable).toBe(true);
      }
    });
  });

  describe('MCP content format', () => {
    it('should produce content array with single text element containing valid JSON', async () => {
      const bridge = createMockBridge(sampleLinks);

      const result = await handleDiscoverLinks(bridge, 1);

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(typeof result.content[0].text).toBe('string');
      expect(() => JSON.parse(result.content[0].text)).not.toThrow();
    });

    it('should return empty array as valid JSON when no links found', async () => {
      const bridge = createMockBridge([]);

      const result = await handleDiscoverLinks(bridge, 1);

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual([]);
    });
  });
});

describe('globToRegex', () => {
  it('should convert simple glob with single wildcard', () => {
    const re = globToRegex('/docs/*');
    expect(re.test('/docs/intro')).toBe(true);
    expect(re.test('/docs/')).toBe(true);
    expect(re.test('/docs/a/b')).toBe(false);
  });

  it('should convert glob with double wildcard (globstar)', () => {
    const re = globToRegex('/docs/**');
    expect(re.test('/docs/intro')).toBe(true);
    expect(re.test('/docs/a/b/c')).toBe(true);
    expect(re.test('/docs/')).toBe(true);
  });

  it('should escape regex special characters in glob', () => {
    const re = globToRegex('/api/v1.0/*');
    expect(re.test('/api/v1.0/users')).toBe(true);
    expect(re.test('/api/v1X0/users')).toBe(false);
  });
});
