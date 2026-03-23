import { describe, it, expect, beforeEach } from 'vitest';
import { UrlMapper } from './url-mapper.js';

describe('UrlMapper', () => {
  let mapper: UrlMapper;
  const outputDir = '/output';

  beforeEach(() => {
    mapper = new UrlMapper(outputDir);
  });

  it('maps URL without extension to index.html', () => {
    expect(mapper.mapUrl('https://example.com/docs/api/users')).toBe(
      '/output/docs/api/users/index.html',
    );
  });

  it('preserves explicit .html extension', () => {
    expect(mapper.mapUrl('https://example.com/docs/api/users.html')).toBe(
      '/output/docs/api/users.html',
    );
  });

  it('maps root URL to index.html', () => {
    expect(mapper.mapUrl('https://example.com/')).toBe('/output/index.html');
  });

  it('strips query params from filepath', () => {
    expect(mapper.mapUrl('https://example.com/page?a=1')).toBe('/output/page/index.html');
  });

  it('appends hash suffix on collision from different URLs', () => {
    const first = mapper.mapUrl('https://example.com/page');
    const second = mapper.mapUrl('https://other.com/page');

    expect(first).toBe('/output/page/index.html');
    expect(second).not.toBe(first);
    expect(second).toMatch(/\/output\/page\/index_[a-f0-9]{7}\.html$/);
  });

  it('returns same filepath for same URL (no self-collision)', () => {
    const first = mapper.mapUrl('https://example.com/page');
    const second = mapper.mapUrl('https://example.com/page');

    expect(first).toBe(second);
  });

  it('creates correct nested directory structure', () => {
    expect(mapper.mapUrl('https://example.com/a/b/c/d')).toBe('/output/a/b/c/d/index.html');
  });

  it('preserves .css extension', () => {
    expect(mapper.mapUrl('https://example.com/styles/main.css')).toBe('/output/styles/main.css');
  });

  it('preserves .js extension', () => {
    expect(mapper.mapUrl('https://example.com/scripts/app.js')).toBe('/output/scripts/app.js');
  });

  it('preserves .json extension', () => {
    expect(mapper.mapUrl('https://example.com/api/data.json')).toBe('/output/api/data.json');
  });

  it('preserves .xml extension', () => {
    expect(mapper.mapUrl('https://example.com/sitemap.xml')).toBe('/output/sitemap.xml');
  });

  it('clears collision tracking on reset', () => {
    mapper.mapUrl('https://example.com/page');
    mapper.reset();

    // After reset, a different URL mapping to the same filepath should get the clean path
    const result = mapper.mapUrl('https://other.com/page');
    expect(result).toBe('/output/page/index.html');
  });

  it('handles encoded characters in path', () => {
    const result = mapper.mapUrl('https://example.com/path%20with%20spaces');
    expect(result).toBe('/output/path%20with%20spaces/index.html');
  });
});
