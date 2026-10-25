import { describe, expect, it } from 'vitest';
import { isSupportedBrowser } from './setup';

const mac =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const linux = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const windows =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const chrome = [
  { brand: 'Google Chrome', version: '141' },
  { brand: 'Chromium', version: '141' },
  { brand: 'Not?A_Brand', version: '24' },
];

describe('isSupportedBrowser', () => {
  it('accepts desktop Chromium browsers on macOS, Windows, and Linux from client hints', () => {
    expect(isSupportedBrowser(mac, { brands: chrome, mobile: false, platform: 'macOS' })).toBe(true);
    expect(isSupportedBrowser(windows, { brands: chrome, mobile: false, platform: 'Windows' })).toBe(true);
    expect(isSupportedBrowser(linux, { brands: chrome, mobile: false, platform: 'Linux' })).toBe(true);
    const edge = [{ brand: 'Microsoft Edge', version: '141' }, chrome[1]!];
    expect(isSupportedBrowser(`${windows} Edg/141.0.0.0`, { brands: edge, mobile: false, platform: 'Windows' })).toBe(
      true,
    );
    const brave = [{ brand: 'Brave', version: '141' }, chrome[1]!];
    expect(isSupportedBrowser(mac, { brands: brave, mobile: false, platform: 'macOS' })).toBe(true);
  });
  it('rejects ChromeOS, mobile, and non-Chromium browsers from client hints', () => {
    expect(isSupportedBrowser(linux, { brands: chrome, mobile: false, platform: 'Chrome OS' })).toBe(false);
    expect(isSupportedBrowser(linux, { brands: chrome, mobile: true, platform: 'Android' })).toBe(false);
    // Client hints win over a Chrome-like user agent string.
    expect(isSupportedBrowser(mac, { brands: [chrome[2]!], mobile: false, platform: 'macOS' })).toBe(false);
  });
  it('falls back to the user agent string without client hints', () => {
    expect(isSupportedBrowser(mac)).toBe(true);
    expect(isSupportedBrowser(linux, { brands: [] })).toBe(true);
    expect(isSupportedBrowser(windows)).toBe(true);
    expect(isSupportedBrowser(`${windows} Edg/141.0.0.0`)).toBe(true);
    expect(isSupportedBrowser(`${linux} OPR/120.0.0.0`)).toBe(true);
    expect(
      isSupportedBrowser(
        'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      ),
    ).toBe(false);
    expect(
      isSupportedBrowser(
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
      ),
    ).toBe(false);
    expect(
      isSupportedBrowser(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
      ),
    ).toBe(false);
    expect(isSupportedBrowser('Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0')).toBe(false);
  });
});
