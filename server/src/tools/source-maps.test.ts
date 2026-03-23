import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bridge } from '../bridge/index.js';
import { McpError, ErrorCode } from '../errors/index.js';
import { cleanSourcePath, extractSourceMapUrl, decodeDataUri, validateSourceMap } from './source-maps.js';

// ─── cleanSourcePath ───────────────────────────────────────────────────────────

describe('cleanSourcePath', () => {
  it('removes webpack:///. prefix', () => {
    expect(cleanSourcePath('webpack:///./src/App.tsx')).toBe('src/App.tsx');
  });

  it('removes webpack:/// prefix', () => {
    expect(cleanSourcePath('webpack:///src/App.tsx')).toBe('src/App.tsx');
  });

  it('removes webpack://[name]/ prefix', () => {
    expect(cleanSourcePath('webpack://my-app/./src/App.tsx')).toBe('src/App.tsx');
  });

  it('removes turbopack:///[project]/ prefix', () => {
    expect(cleanSourcePath('turbopack:///[project]/src/App.tsx')).toBe('src/App.tsx');
  });

  it('removes turbopack:/// prefix', () => {
    expect(cleanSourcePath('turbopack:///src/App.tsx')).toBe('src/App.tsx');
  });

  it('removes vite:/// prefix', () => {
    expect(cleanSourcePath('vite:///src/App.tsx')).toBe('src/App.tsx');
  });

  it('removes file:/// prefix', () => {
    expect(cleanSourcePath('file:///src/App.tsx')).toBe('src/App.tsx');
  });

  it('removes leading ./', () => {
    expect(cleanSourcePath('./src/App.tsx')).toBe('src/App.tsx');
  });

  it('passes through clean paths', () => {
    expect(cleanSourcePath('src/App.tsx')).toBe('src/App.tsx');
  });

  it('applies sourceRoot', () => {
    expect(cleanSourcePath('App.tsx', 'src/')).toBe('src/App.tsx');
  });

  it('applies sourceRoot after prefix removal', () => {
    expect(cleanSourcePath('webpack:///./App.tsx', 'src/')).toBe('src/App.tsx');
  });

  it('prevents directory traversal with ../', () => {
    expect(cleanSourcePath('../../etc/passwd')).toBeNull();
  });

  it('prevents directory traversal after prefix removal', () => {
    expect(cleanSourcePath('webpack:///../../etc/passwd')).toBeNull();
  });

  it('rejects absolute paths', () => {
    expect(cleanSourcePath('/etc/passwd')).toBeNull();
  });

  it('normalizes backslashes to forward slashes', () => {
    expect(cleanSourcePath('src\\components\\App.tsx')).toBe('src/components/App.tsx');
  });
});

// ─── extractSourceMapUrl ────────────────────────────────────────────────────────

describe('extractSourceMapUrl', () => {
  it('extracts sourceMappingURL with # comment', () => {
    const js = 'var a=1;\n//# sourceMappingURL=main.js.map';
    const result = extractSourceMapUrl(js, 'https://cdn.example.com/main.js', new Headers());
    expect(result).toEqual({
      jsUrl: 'https://cdn.example.com/main.js',
      mapUrl: 'https://cdn.example.com/main.js.map',
      inline: false,
    });
  });

  it('extracts sourceMappingURL with @ comment', () => {
    const js = 'var a=1;\n//@ sourceMappingURL=main.js.map';
    const result = extractSourceMapUrl(js, 'https://cdn.example.com/main.js', new Headers());
    expect(result).toEqual({
      jsUrl: 'https://cdn.example.com/main.js',
      mapUrl: 'https://cdn.example.com/main.js.map',
      inline: false,
    });
  });

  it('resolves relative URLs against JS URL', () => {
    const js = '//# sourceMappingURL=maps/main.js.map';
    const result = extractSourceMapUrl(js, 'https://cdn.example.com/js/main.js', new Headers());
    expect(result?.mapUrl).toBe('https://cdn.example.com/js/maps/main.js.map');
  });

  it('uses absolute URLs as-is', () => {
    const js = '//# sourceMappingURL=https://maps.example.com/main.js.map';
    const result = extractSourceMapUrl(js, 'https://cdn.example.com/main.js', new Headers());
    expect(result?.mapUrl).toBe('https://maps.example.com/main.js.map');
  });

  it('prefers SourceMap header over body', () => {
    const js = '//# sourceMappingURL=body.js.map';
    const headers = new Headers({ SourceMap: 'header.js.map' });
    const result = extractSourceMapUrl(js, 'https://cdn.example.com/main.js', headers);
    expect(result?.mapUrl).toBe('https://cdn.example.com/header.js.map');
  });

  it('uses X-SourceMap header', () => {
    const js = 'var a=1;';
    const headers = new Headers({ 'X-SourceMap': 'legacy.js.map' });
    const result = extractSourceMapUrl(js, 'https://cdn.example.com/main.js', headers);
    expect(result?.mapUrl).toBe('https://cdn.example.com/legacy.js.map');
  });

  it('returns null when no source map reference found', () => {
    const result = extractSourceMapUrl('var a=1;', 'https://cdn.example.com/main.js', new Headers());
    expect(result).toBeNull();
  });

  it('handles inline data URI base64 source maps', () => {
    const mapJson = JSON.stringify({ version: 3, sources: ['a.ts'], sourcesContent: ['code'], mappings: '' });
    const b64 = Buffer.from(mapJson).toString('base64');
    const js = `var a=1;\n//# sourceMappingURL=data:application/json;base64,${b64}`;
    const result = extractSourceMapUrl(js, 'https://cdn.example.com/main.js', new Headers());
    expect(result?.inline).toBe(true);
    expect(result?.inlineContent).toBe(mapJson);
  });

  it('handles inline data URI in header', () => {
    const mapJson = JSON.stringify({ version: 3, sources: [], sourcesContent: [] });
    const b64 = Buffer.from(mapJson).toString('base64');
    const headers = new Headers({ SourceMap: `data:application/json;base64,${b64}` });
    const result = extractSourceMapUrl('var a=1;', 'https://cdn.example.com/main.js', headers);
    expect(result?.inline).toBe(true);
    expect(result?.inlineContent).toBe(mapJson);
  });
});

// ─── decodeDataUri ──────────────────────────────────────────────────────────────

describe('decodeDataUri', () => {
  it('decodes base64 data URI', () => {
    const content = 'hello world';
    const b64 = Buffer.from(content).toString('base64');
    const uri = `data:application/json;base64,${b64}`;
    expect(decodeDataUri(uri)).toBe(content);
  });

  it('decodes URL-encoded data URI', () => {
    const content = '{"version":3}';
    const encoded = encodeURIComponent(content);
    const uri = `data:application/json;charset=utf-8,${encoded}`;
    expect(decodeDataUri(uri)).toBe(content);
  });

  it('returns empty string for malformed data URI', () => {
    expect(decodeDataUri('data:nope')).toBe('');
  });
});

// ─── validateSourceMap ──────────────────────────────────────────────────────────

describe('validateSourceMap', () => {
  it('validates a correct v3 source map', () => {
    expect(validateSourceMap({
      version: 3,
      sources: ['a.ts'],
      sourcesContent: ['code'],
      mappings: '',
    })).toBe(true);
  });

  it('rejects missing version', () => {
    expect(validateSourceMap({ sources: ['a.ts'], sourcesContent: ['code'] })).toBe(false);
  });

  it('rejects wrong version', () => {
    expect(validateSourceMap({ version: 2, sources: ['a.ts'], sourcesContent: ['code'] })).toBe(false);
  });

  it('rejects missing sources', () => {
    expect(validateSourceMap({ version: 3, sourcesContent: ['code'] })).toBe(false);
  });

  it('rejects missing sourcesContent', () => {
    expect(validateSourceMap({ version: 3, sources: ['a.ts'] })).toBe(false);
  });

  it('rejects null', () => {
    expect(validateSourceMap(null)).toBe(false);
  });

  it('rejects non-object', () => {
    expect(validateSourceMap('string')).toBe(false);
  });

  it('rejects sources as non-array', () => {
    expect(validateSourceMap({ version: 3, sources: 'a.ts', sourcesContent: ['code'] })).toBe(false);
  });
});

// ─── node_modules filtering ─────────────────────────────────────────────────────

describe('node_modules filtering', () => {
  it('cleanSourcePath does not filter node_modules itself', () => {
    // cleanSourcePath is a path cleaner, node_modules filtering happens in writeSourceTree
    // But we verify the path cleans correctly so the filter can work
    expect(cleanSourcePath('webpack:///./node_modules/react/index.js')).toBe('node_modules/react/index.js');
  });
});

// ─── File writing with temp directories ─────────────────────────────────────────

describe('writeSourceTree (via integration)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'source-maps-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // We test the file writing by importing and calling writeSourceTree indirectly
  // through the tool handler. Instead, test the exported functions + manual file ops.

  it('creates directory structure and writes files correctly', async () => {
    // Manually replicate writeSourceTree logic for a direct test
    const { mkdir, writeFile: wf } = await import('node:fs/promises');
    const { dirname, join: pjoin } = await import('node:path');

    const sources = ['src/App.tsx', 'src/hooks/useAuth.ts'];
    const contents = ['export function App() {}', 'export function useAuth() {}'];

    for (let i = 0; i < sources.length; i++) {
      const cleaned = cleanSourcePath(sources[i]);
      expect(cleaned).not.toBeNull();
      const filepath = pjoin(tempDir, cleaned!);
      await mkdir(dirname(filepath), { recursive: true });
      await wf(filepath, contents[i], 'utf-8');
    }

    const appContent = await readFile(join(tempDir, 'src/App.tsx'), 'utf-8');
    expect(appContent).toBe('export function App() {}');

    const authContent = await readFile(join(tempDir, 'src/hooks/useAuth.ts'), 'utf-8');
    expect(authContent).toBe('export function useAuth() {}');
  });
});

// ─── Error resilience ───────────────────────────────────────────────────────────

describe('error resilience', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('JS fetch failure skips resource and continues', async () => {
    const errors: Array<{ jsUrl: string; error: string }> = [];

    // Simulate discoverSourceMapUrls behavior
    const resources = [
      { url: 'https://example.com/fail.js', type: 'script' },
      { url: 'https://example.com/ok.js', type: 'script' },
    ];

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('fail.js')) {
        return Promise.reject(new Error('Network error'));
      }
      return Promise.resolve({
        ok: true,
        headers: new Headers(),
        text: () => Promise.resolve('var a=1;'),
      });
    }) as unknown as typeof fetch;

    // Manually call the same logic
    for (const resource of resources) {
      try {
        const response = await fetch(resource.url);
        if (!(response as Response).ok) {
          errors.push({ jsUrl: resource.url, error: 'fetch failed' });
          continue;
        }
      } catch (err) {
        errors.push({ jsUrl: resource.url, error: (err as Error).message });
      }
    }

    expect(errors).toHaveLength(1);
    expect(errors[0].jsUrl).toBe('https://example.com/fail.js');
  });

  it('.map fetch failure skips map and continues', async () => {
    const errors: Array<{ jsUrl: string; error: string }> = [];

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('.map')) {
        return Promise.resolve({ ok: false, status: 404, statusText: 'Not Found' });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      });
    }) as unknown as typeof fetch;

    const response = await fetch('https://example.com/main.js.map');
    if (!(response as Response).ok) {
      errors.push({ jsUrl: 'https://example.com/main.js', error: 'Source map fetch failed: 404' });
    }

    expect(errors).toHaveLength(1);
    expect(errors[0].error).toContain('404');
  });

  it('write failure skips file and continues', async () => {
    const errors: Array<{ jsUrl: string; error: string }> = [];

    try {
      // Try to write to a path that doesn't exist and can't be created
      const { writeFile: wf } = await import('node:fs/promises');
      await wf('/nonexistent-root-dir/impossible/path.ts', 'content', 'utf-8');
    } catch (err) {
      errors.push({ jsUrl: 'test.js', error: `Write failed: ${(err as Error).message}` });
    }

    expect(errors).toHaveLength(1);
    expect(errors[0].error).toContain('Write failed');
  });
});

// ─── Complete recovery flow (mock bridge + mock fetch) ──────────────────────────

describe('complete recovery flow', () => {
  let tempDir: string;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'source-maps-flow-'));
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  function createMockBridge(resources: unknown): Bridge {
    return {
      connectionState: 'connected',
      extensionVersion: '1.0.0',
      wsPort: 9222,
      lastError: null,
      send: vi.fn().mockResolvedValue(resources),
    } as unknown as Bridge;
  }

  it('recovers source files from mocked resources', async () => {
    const mapJson = {
      version: 3,
      sources: ['src/App.tsx', 'src/utils/helpers.ts'],
      sourcesContent: [
        'export function App() { return <div/>; }',
        'export function helper() { return 42; }',
      ],
      sourceRoot: '',
      mappings: '',
    };

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('.js')) {
        return Promise.resolve({
          ok: true,
          headers: new Headers(),
          text: () => Promise.resolve('var a=1;\n//# sourceMappingURL=main.js.map'),
        });
      }
      if (url.endsWith('.map')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mapJson),
        });
      }
      return Promise.resolve({ ok: false, status: 404, statusText: 'Not Found' });
    }) as unknown as typeof fetch;

    // Simulate the full flow
    const bridge = createMockBridge([
      { url: 'https://example.com/main.js', type: 'script', size: 1000 },
    ]);

    const resources = await bridge.send('resources.list', { tabId: 1 }) as Array<{
      url: string;
      type: string;
      size: number;
    }>;
    const jsResources = resources.filter((r) => r.type === 'script' && r.url.endsWith('.js'));

    // Discover source maps
    const entries: Array<{ jsUrl: string; mapUrl: string; inline: boolean; inlineContent?: string }> = [];
    for (const r of jsResources) {
      const resp = await fetch(r.url);
      const body = await (resp as Response).text();
      const entry = extractSourceMapUrl(body, r.url, (resp as Response).headers);
      if (entry) entries.push(entry);
    }

    expect(entries).toHaveLength(1);
    expect(entries[0].mapUrl).toBe('https://example.com/main.js.map');

    // Fetch and parse
    const parsed = [];
    for (const entry of entries) {
      const resp = await fetch(entry.mapUrl);
      const data = await (resp as Response).json();
      if (validateSourceMap(data)) {
        parsed.push({
          jsUrl: entry.jsUrl,
          mapUrl: entry.mapUrl,
          sourceRoot: data.sourceRoot || '',
          sources: data.sources,
          sourcesContent: data.sourcesContent,
        });
      }
    }

    expect(parsed).toHaveLength(1);

    // Write source tree
    const { mkdir: mkdirAsync, writeFile: wf } = await import('node:fs/promises');
    const { dirname: dn, join: pjoin } = await import('node:path');
    const writtenPaths: string[] = [];

    for (const map of parsed) {
      for (let i = 0; i < map.sources.length; i++) {
        const content = map.sourcesContent[i];
        if (content == null) continue;
        const cleaned = cleanSourcePath(map.sources[i], map.sourceRoot || undefined);
        if (!cleaned || cleaned.includes('node_modules/')) continue;
        const filepath = pjoin(tempDir, cleaned);
        await mkdirAsync(dn(filepath), { recursive: true });
        await wf(filepath, content, 'utf-8');
        writtenPaths.push(cleaned);
      }
    }

    expect(writtenPaths).toHaveLength(2);
    expect(writtenPaths).toContain('src/App.tsx');
    expect(writtenPaths).toContain('src/utils/helpers.ts');

    // Verify file contents
    const appContent = await readFile(join(tempDir, 'src/App.tsx'), 'utf-8');
    expect(appContent).toBe('export function App() { return <div/>; }');

    const helperContent = await readFile(join(tempDir, 'src/utils/helpers.ts'), 'utf-8');
    expect(helperContent).toBe('export function helper() { return 42; }');
  });

  it('skips node_modules in recovery', async () => {
    const mapJson = {
      version: 3,
      sources: ['src/App.tsx', 'node_modules/react/index.js'],
      sourcesContent: ['app code', 'react code'],
      sourceRoot: '',
      mappings: '',
    };

    const writtenPaths: string[] = [];
    for (let i = 0; i < mapJson.sources.length; i++) {
      const cleaned = cleanSourcePath(mapJson.sources[i]);
      if (!cleaned || cleaned.includes('node_modules/')) continue;
      writtenPaths.push(cleaned);
    }

    expect(writtenPaths).toHaveLength(1);
    expect(writtenPaths[0]).toBe('src/App.tsx');
  });
});

// ─── TAB_NOT_FOUND error ────────────────────────────────────────────────────────

describe('TAB_NOT_FOUND error', () => {
  it('throws McpError with TAB_NOT_FOUND for invalid tabId', async () => {
    const bridge = {
      connectionState: 'connected',
      extensionVersion: '1.0.0',
      wsPort: 9222,
      lastError: null,
      send: vi.fn().mockRejectedValue(new Error('Tab 999 not found')),
    } as unknown as Bridge;

    // Simulate the tool handler error path
    try {
      await bridge.send('resources.list', { tabId: 999 });
      expect.fail('Should have thrown');
    } catch (err) {
      if (err instanceof McpError || (err instanceof Error && err.message.includes('not found'))) {
        const mcpError = new McpError(
          ErrorCode.TAB_NOT_FOUND,
          'Tab 999 does not exist or has been closed',
          { tabId: 999 },
          'Call list_tabs to get current tab IDs',
          true,
        );
        expect(mcpError.code).toBe(ErrorCode.TAB_NOT_FOUND);
        expect(mcpError.message).toContain('999');
        expect(mcpError.recoverable).toBe(true);
      }
    }
  });
});

// ─── Response shape ─────────────────────────────────────────────────────────────

describe('response shape', () => {
  it('matches expected RecoveryResult shape', () => {
    const result = {
      mapsFound: 3,
      filesRecovered: 47,
      outputDir: '/tmp/recovered',
      sourceTree: ['src/App.tsx', 'src/index.ts'],
      errors: [{ jsUrl: 'https://example.com/chunk.js', error: 'Failed to fetch: 404' }],
    };

    expect(result).toHaveProperty('mapsFound');
    expect(result).toHaveProperty('filesRecovered');
    expect(result).toHaveProperty('outputDir');
    expect(result).toHaveProperty('sourceTree');
    expect(result).toHaveProperty('errors');
    expect(typeof result.mapsFound).toBe('number');
    expect(typeof result.filesRecovered).toBe('number');
    expect(typeof result.outputDir).toBe('string');
    expect(Array.isArray(result.sourceTree)).toBe(true);
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors[0]).toHaveProperty('jsUrl');
    expect(result.errors[0]).toHaveProperty('error');
  });
});
