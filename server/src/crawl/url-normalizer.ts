import { URL } from 'node:url';

export function normalizeUrl(urlString: string): string {
  const url = new URL(urlString);

  // 1. Hostname is automatically lowercased by the URL class

  // 2. Remove fragment
  url.hash = '';

  // 3. Sort query parameters alphabetically by key
  url.searchParams.sort();

  // 4. Strip trailing slash from pathname (preserve root "/")
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.toString();
}
