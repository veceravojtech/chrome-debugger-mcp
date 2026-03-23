import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SiteWriter } from './site-writer.js';
import { UrlMapper } from './url-mapper.js';

describe('SiteWriter', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'site-writer-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates correct filepath using UrlMapper', async () => {
    const mapper = new UrlMapper(tempDir);
    const writer = new SiteWriter(mapper);

    const filepath = await writer.writePageContent(
      'https://example.com/docs/api/users',
      '<html>content</html>',
    );

    expect(filepath).toBe(join(tempDir, 'docs/api/users/index.html'));
  });

  it('creates nested directory structure', async () => {
    const mapper = new UrlMapper(tempDir);
    const writer = new SiteWriter(mapper);

    const filepath = await writer.writePageContent(
      'https://example.com/a/b/c/d',
      '<html>deep</html>',
    );

    const content = await readFile(filepath, 'utf-8');
    expect(content).toBe('<html>deep</html>');
    expect(filepath).toBe(join(tempDir, 'a/b/c/d/index.html'));
  });

  it('writes HTML content correctly to disk', async () => {
    const mapper = new UrlMapper(tempDir);
    const writer = new SiteWriter(mapper);
    const html = '<!DOCTYPE html><html><body><h1>Hello World</h1></body></html>';

    const filepath = await writer.writePageContent('https://example.com/', html);

    const content = await readFile(filepath, 'utf-8');
    expect(content).toBe(html);
  });

  it('wraps file write error in McpError(CRAWL_WRITE_FAILED)', async () => {
    // Use a path that cannot be written (read-only parent)
    const readOnlyDir = join(tempDir, 'readonly');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(readOnlyDir);
    await chmod(readOnlyDir, 0o444);

    const mapper = new UrlMapper(join(readOnlyDir, 'output'));
    const writer = new SiteWriter(mapper);

    try {
      await writer.writePageContent('https://example.com/page', '<html></html>');
      expect.fail('Should have thrown');
    } catch (err: unknown) {
      const mcpErr = err as { code: string; message: string; recoverable: boolean };
      expect(mcpErr.code).toBe('CRAWL_WRITE_FAILED');
      expect(mcpErr.message).toContain('Failed to write page content');
      expect(mcpErr.recoverable).toBe(true);
    } finally {
      // Restore permissions for cleanup
      await chmod(readOnlyDir, 0o755);
    }
  });

  it('handles collision (two URLs → disambiguated filepaths)', async () => {
    const mapper = new UrlMapper(tempDir);
    const writer = new SiteWriter(mapper);

    const fp1 = await writer.writePageContent(
      'https://example.com/page',
      '<html>first</html>',
    );
    const fp2 = await writer.writePageContent(
      'https://other.com/page',
      '<html>second</html>',
    );

    expect(fp1).not.toBe(fp2);

    const content1 = await readFile(fp1, 'utf-8');
    const content2 = await readFile(fp2, 'utf-8');
    expect(content1).toBe('<html>first</html>');
    expect(content2).toBe('<html>second</html>');
  });

  it('uses temporary directory for test isolation', () => {
    // This test validates our test setup itself
    expect(tempDir).toContain('site-writer-test-');
  });
});
