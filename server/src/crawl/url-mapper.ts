import { join, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { URL } from 'node:url';

export class UrlMapper {
  private outputDir: string;
  private pathMap = new Map<string, string>(); // filepath → url (for collision detection)

  constructor(outputDir: string) {
    this.outputDir = outputDir;
  }

  mapUrl(url: string): string {
    const parsed = new URL(url);
    const pathname = parsed.pathname;

    const ext = extname(pathname);
    let filepath: string;

    if (ext) {
      // Explicit extension — preserve it: /docs/api.html → docs/api.html
      filepath = join(this.outputDir, pathname);
    } else {
      // No extension — append /index.html: /docs/api → docs/api/index.html
      filepath = join(this.outputDir, pathname, 'index.html');
    }

    // Collision detection
    const existingUrl = this.pathMap.get(filepath);
    if (existingUrl && existingUrl !== url) {
      // Different URL maps to same filepath — disambiguate with hash
      const hash = createHash('md5').update(url).digest('hex').slice(0, 7);
      const fileExt = extname(filepath);
      const base = filepath.slice(0, -fileExt.length);
      filepath = `${base}_${hash}${fileExt}`;
    }

    this.pathMap.set(filepath, url);
    return filepath;
  }

  reset(): void {
    this.pathMap.clear();
  }
}
