import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Bridge } from '../bridge/index.js';
import { McpError, ErrorCode } from '../errors/index.js';
import { logger } from '../logger.js';

interface SourceMapEntry {
  jsUrl: string;
  mapUrl: string;
  inline: boolean;
  inlineContent?: string;
}

interface ParsedSourceMap {
  jsUrl: string;
  mapUrl: string;
  sourceRoot: string;
  sources: string[];
  sourcesContent: (string | null)[];
}

interface RecoveryError {
  jsUrl: string;
  error: string;
}

interface RecoveryResult {
  mapsFound: number;
  filesRecovered: number;
  outputDir: string;
  sourceTree: string[];
  errors: RecoveryError[];
}

const SOURCE_MAP_URL_RE = /\/\/[#@]\s*sourceMappingURL=(.+?)(?:\s|$)/;

const PROTOCOL_PREFIXES = [
  /^webpack:\/\/\/\.\//,
  /^webpack:\/\/[^/]*\//,
  /^webpack:\/\/\//,
  /^turbopack:\/\/\/\[project\]\//,
  /^turbopack:\/\/\//,
  /^vite:\/\/\//,
  /^file:\/\/\//,
];

export function cleanSourcePath(sourcePath: string, sourceRoot?: string): string | null {
  let cleaned = sourcePath;

  // Remove protocol prefixes
  for (const prefix of PROTOCOL_PREFIXES) {
    cleaned = cleaned.replace(prefix, '');
  }

  // Remove leading ./
  cleaned = cleaned.replace(/^\.\//, '');

  // Prepend sourceRoot if present
  if (sourceRoot) {
    cleaned = sourceRoot + cleaned;
  }

  // Normalize path separators
  cleaned = cleaned.replace(/\\/g, '/');

  // Security: reject paths that try to traverse outside
  if (cleaned.includes('../') || cleaned.startsWith('/')) {
    return null;
  }

  return cleaned;
}

export function extractSourceMapUrl(jsContent: string, jsUrl: string, headers: Headers): SourceMapEntry | null {
  // Check headers first
  const headerMapUrl = headers.get('SourceMap') || headers.get('X-SourceMap');
  if (headerMapUrl) {
    if (headerMapUrl.startsWith('data:')) {
      return { jsUrl, mapUrl: headerMapUrl, inline: true, inlineContent: decodeDataUri(headerMapUrl) };
    }
    const resolved = new URL(headerMapUrl, jsUrl).href;
    return { jsUrl, mapUrl: resolved, inline: false };
  }

  // Search body for sourceMappingURL directive
  const match = SOURCE_MAP_URL_RE.exec(jsContent);
  if (!match) return null;

  const rawUrl = match[1].trim();
  if (rawUrl.startsWith('data:')) {
    return { jsUrl, mapUrl: rawUrl, inline: true, inlineContent: decodeDataUri(rawUrl) };
  }

  const resolved = new URL(rawUrl, jsUrl).href;
  return { jsUrl, mapUrl: resolved, inline: false };
}

export function decodeDataUri(dataUri: string): string {
  const commaIndex = dataUri.indexOf(',');
  if (commaIndex === -1) return '';

  const meta = dataUri.slice(0, commaIndex);
  const content = dataUri.slice(commaIndex + 1);

  if (meta.includes(';base64')) {
    return Buffer.from(content, 'base64').toString('utf-8');
  }

  return decodeURIComponent(content);
}

export function validateSourceMap(data: unknown): data is {
  version: number;
  sources: string[];
  sourcesContent: (string | null)[];
  sourceRoot?: string;
} {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    obj.version === 3 &&
    Array.isArray(obj.sources) &&
    Array.isArray(obj.sourcesContent)
  );
}

async function discoverSourceMapUrls(
  resources: Array<{ url: string; type: string }>,
  errors: RecoveryError[],
): Promise<SourceMapEntry[]> {
  const entries: SourceMapEntry[] = [];

  for (const resource of resources) {
    try {
      const response = await fetch(resource.url);
      if (!response.ok) {
        errors.push({ jsUrl: resource.url, error: `JS fetch failed: ${response.status} ${response.statusText}` });
        continue;
      }

      const body = await response.text();
      const entry = extractSourceMapUrl(body, resource.url, response.headers);
      if (entry) {
        entries.push(entry);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      errors.push({ jsUrl: resource.url, error: `JS fetch failed: ${message}` });
      logger.warn('Failed to fetch JS resource', { url: resource.url, error: message });
    }
  }

  return entries;
}

async function fetchAndParseSourceMaps(
  entries: SourceMapEntry[],
  errors: RecoveryError[],
): Promise<ParsedSourceMap[]> {
  const parsed: ParsedSourceMap[] = [];

  for (const entry of entries) {
    try {
      let data: unknown;

      if (entry.inline && entry.inlineContent) {
        data = JSON.parse(entry.inlineContent);
      } else {
        const response = await fetch(entry.mapUrl);
        if (!response.ok) {
          errors.push({
            jsUrl: entry.jsUrl,
            error: `Source map fetch failed: ${response.status} ${response.statusText}`,
          });
          logger.warn('Failed to fetch source map', { jsUrl: entry.jsUrl, mapUrl: entry.mapUrl });
          continue;
        }
        data = await response.json();
      }

      if (!validateSourceMap(data)) {
        errors.push({ jsUrl: entry.jsUrl, error: 'Invalid source map: missing version 3, sources, or sourcesContent' });
        logger.warn('Invalid source map format', { jsUrl: entry.jsUrl, mapUrl: entry.mapUrl });
        continue;
      }

      parsed.push({
        jsUrl: entry.jsUrl,
        mapUrl: entry.mapUrl,
        sourceRoot: (data as Record<string, unknown>).sourceRoot as string || '',
        sources: data.sources,
        sourcesContent: data.sourcesContent,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      errors.push({ jsUrl: entry.jsUrl, error: `Source map parse failed: ${message}` });
      logger.warn('Failed to parse source map', { jsUrl: entry.jsUrl, mapUrl: entry.mapUrl, error: message });
    }
  }

  return parsed;
}

async function writeSourceTree(
  parsedMaps: ParsedSourceMap[],
  outputDir: string,
  errors: RecoveryError[],
): Promise<string[]> {
  const writtenPaths = new Set<string>();
  const resolvedOutput = resolve(outputDir);

  for (const map of parsedMaps) {
    for (let i = 0; i < map.sources.length; i++) {
      const sourceContent = map.sourcesContent[i];
      if (sourceContent == null) continue;

      const cleaned = cleanSourcePath(map.sources[i], map.sourceRoot || undefined);
      if (cleaned === null) {
        logger.warn('Skipping source file with unsafe path', { sourcePath: map.sources[i], jsUrl: map.jsUrl });
        continue;
      }

      // Skip node_modules
      if (cleaned.includes('node_modules/')) continue;

      // Skip duplicates
      if (writtenPaths.has(cleaned)) continue;

      const filepath = join(outputDir, cleaned);
      const resolved = resolve(filepath);
      if (!resolved.startsWith(resolvedOutput)) {
        logger.warn('Skipping source file outside output directory', { relativePath: cleaned, resolved });
        continue;
      }

      try {
        await mkdir(dirname(filepath), { recursive: true });
        await writeFile(filepath, sourceContent, 'utf-8');
        writtenPaths.add(cleaned);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        errors.push({ jsUrl: map.jsUrl, error: `File write failed for ${cleaned}: ${message}` });
        logger.warn('Failed to write source file', { filepath: cleaned, error: message });
      }
    }
  }

  return Array.from(writtenPaths).sort();
}

export function registerSourceMapTools(server: McpServer, bridge: Bridge): void {
  server.tool(
    'recover_source_maps',
    'Recover original source files from production JavaScript source maps',
    {
      tabId: z.number().int().describe('Tab ID from list_tabs'),
      outputDir: z.string().describe('Directory to write recovered source files'),
    },
    async ({ tabId, outputDir }) => {
      const errors: RecoveryError[] = [];

      // 1. Get page resources via bridge
      let resources: Array<{ url: string; type: string; size: number }>;
      try {
        resources = await bridge.send('resources.list', { tabId }) as Array<{
          url: string;
          type: string;
          size: number;
        }>;
      } catch (err) {
        if (err instanceof McpError || (err instanceof Error && err.message.includes('not found'))) {
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

      // 2. Filter for JS resources
      const jsResources = resources.filter(
        (r) => r.type === 'script' && (r.url.endsWith('.js') || r.url.endsWith('.mjs')),
      );

      if (jsResources.length === 0) {
        const result: RecoveryResult = {
          mapsFound: 0,
          filesRecovered: 0,
          outputDir,
          sourceTree: [],
          errors: [{ jsUrl: '', error: 'No JavaScript resources found on the page' }],
        };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      }

      // 3. Discover source map URLs
      const mapEntries = await discoverSourceMapUrls(jsResources, errors);

      // 4. Fetch and parse source maps
      const parsedMaps = await fetchAndParseSourceMaps(mapEntries, errors);

      // 5. Write source tree
      const sourceTree = await writeSourceTree(parsedMaps, outputDir, errors);

      // 6. Return result
      const result: RecoveryResult = {
        mapsFound: mapEntries.length,
        filesRecovered: sourceTree.length,
        outputDir,
        sourceTree,
        errors,
      };

      logger.info('Source map recovery complete', {
        mapsFound: result.mapsFound,
        filesRecovered: result.filesRecovered,
        errorCount: result.errors.length,
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
