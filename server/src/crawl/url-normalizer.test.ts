import { describe, it, expect } from 'vitest';
import { normalizeUrl } from './url-normalizer.js';

describe('normalizeUrl', () => {
  it('lowercases hostname while preserving path case', () => {
    expect(normalizeUrl('https://EXAMPLE.Com/Path')).toBe('https://example.com/Path');
  });

  it('strips trailing slash from pathname', () => {
    expect(normalizeUrl('https://example.com/docs/')).toBe('https://example.com/docs');
  });

  it('preserves root path slash', () => {
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('sorts query parameters alphabetically by key', () => {
    expect(normalizeUrl('https://example.com/page?b=2&a=1')).toBe(
      'https://example.com/page?a=1&b=2',
    );
  });

  it('removes fragment', () => {
    expect(normalizeUrl('https://example.com/docs#section')).toBe('https://example.com/docs');
  });

  it('applies all normalization rules together', () => {
    expect(normalizeUrl('https://EXAMPLE.COM/Docs/Api/?z=3&a=1#top')).toBe(
      'https://example.com/Docs/Api?a=1&z=3',
    );
  });

  it('is idempotent — normalizing a normalized URL returns the same string', () => {
    const normalized = normalizeUrl('https://example.com/page?a=1&b=2');
    expect(normalizeUrl(normalized)).toBe(normalized);
  });

  it('handles empty query string', () => {
    const result = normalizeUrl('https://example.com/page?');
    // URL class with empty search params produces no trailing ?
    expect(result).toBe('https://example.com/page');
  });

  it('preserves port number', () => {
    expect(normalizeUrl('https://EXAMPLE.COM:8080/path')).toBe('https://example.com:8080/path');
  });

  it('handles URL with only fragment on root', () => {
    expect(normalizeUrl('https://example.com/#top')).toBe('https://example.com/');
  });

  it('handles URL with empty path', () => {
    expect(normalizeUrl('https://example.com')).toBe('https://example.com/');
  });
});
