import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { UrlMapper } from './url-mapper.js';
import { McpError, ErrorCode } from '../errors/index.js';

export class SiteWriter {
  private readonly urlMapper: UrlMapper;

  constructor(urlMapper: UrlMapper) {
    this.urlMapper = urlMapper;
  }

  async writePageContent(url: string, html: string): Promise<string> {
    const filepath = this.urlMapper.mapUrl(url);
    try {
      await mkdir(dirname(filepath), { recursive: true });
      await writeFile(filepath, html, 'utf-8');
      return filepath;
    } catch (err) {
      throw new McpError(
        ErrorCode.CRAWL_WRITE_FAILED,
        `Failed to write page content: ${err instanceof Error ? err.message : 'Unknown error'}`,
        { url, filepath },
        'Check that the output directory is writable and has sufficient disk space',
        true,
      );
    }
  }
}
