import { readFile } from 'node:fs/promises';

// The Clutchbox brand images as HTML, drawn by Chromium so the real Garamond sets them (Next's ImageResponse cannot
// read woff2). render-brand-images.ts writes this repository's; a deployment can render the share card and icons
// for its own web app from here too. The browser is passed in, so callers bring their own Playwright.

export type Image = { html: string; size: [number, number]; scale?: number; ico?: boolean };
type Page = {
  setContent(html: string): Promise<void>;
  evaluate(fn: () => unknown): Promise<unknown>;
  screenshot(options: { type: 'png'; omitBackground: boolean }): Promise<Buffer>;
  close(): Promise<void>;
};
type Browser = {
  newPage(options: { viewport: { width: number; height: number }; deviceScaleFactor: number }): Promise<Page>;
};

const fonts = new URL('../packages/ui/src/fonts/', import.meta.url);
const font = async (file: string) =>
  `data:font/woff2;base64,${(await readFile(new URL(file, fonts))).toString('base64')}`;
const style = `
  @font-face { font-family: Garamond; src: url(${await font('EBGaramond.woff2')}); font-weight: 400 500; }
  @font-face { font-family: Garamond; src: url(${await font('EBGaramond-Italic.woff2')}); font-weight: 400 500; font-style: italic; }
  * { margin: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; color: #ffffff; font-family: Garamond; }
  .ground { width: 100%; height: 100%; overflow: hidden; background: #0d060b; }
  h1 { font-weight: 500; line-height: 1.02; letter-spacing: -0.02em; }
  .wordmark { font-style: italic; font-weight: 500; line-height: 1; }
  .tagline { line-height: 1.3; color: #c9bec6; }`;
const headline = (br: boolean) => `Your agents,${br ? '<br>' : ' '}<i style="white-space:nowrap">already signed in</i>`;
const tagline = 'Sync your sign-ins to where your agents run';

// The italic c on the plum-black ground. Rounded corners give the tab icons transparency, so they are RGBA as ICO
// requires; iOS rounds the opaque apple-icon itself and would draw transparent corners black, and GitHub crops avatars.
const mark = (rounded: boolean) =>
  `<div class="ground" style="display:grid;place-items:center;border-radius:${rounded ? '22%' : '0'}"><span style="font-style:italic;font-weight:500;font-size:116vw;line-height:1;transform:translate(3%,-21%)">c</span></div>`;
// The wordmark over the headline, set right on the plum field (--field). X crops the header's top and bottom on some
// screens and puts the avatar over its bottom left, so there the type sits in the middle band, clear of that corner.
const plum = (wordmark: number, size: number, gap: number, right: number) =>
  `<div class="ground" style="background:#470c35;display:flex;flex-direction:column;align-items:flex-end;justify-content:center;padding-right:${right}px">
  <p class="wordmark" style="font-size:${wordmark}px;margin-bottom:${gap}px">clutchbox</p>
  <h1 style="font-size:${size}px;text-align:right">${headline(true)}</h1></div>`;

// A web app's icons, by Next's file names.
export const webAppIcons: Record<string, Image> = {
  'icon.png': { html: mark(true), size: [512, 512] },
  'apple-icon.png': { html: mark(false), size: [180, 180] },
  'favicon.ico': { html: mark(true), size: [48, 48], ico: true },
};
export const extensionIcon = (size: number): Image => ({ html: mark(true), size: [size, size] });
// A website's share card.
export const shareCard: Image = {
  html: `<div class="ground" style="display:flex;flex-direction:column;justify-content:space-between;padding:72px 80px">
  <p class="wordmark" style="font-size:34px">clutchbox</p>
  <div><h1 style="font-size:104px">${headline(true)}</h1>
  <p class="tagline" style="margin-top:28px;max-width:40ch;font-size:34px">${tagline}</p></div></div>`,
  size: [1200, 630],
};
// brand/, by file name: what is uploaded by hand or shown in the READMEs (brand/README.md says where each goes).
export const brandFolder: Record<string, Image> = {
  'github-avatar.png': { html: mark(false), size: [500, 500] },
  'readme-banner.png': {
    html: `<div class="ground" style="display:flex;flex-direction:column;justify-content:center;padding:0 80px">
  <p class="wordmark" style="font-size:30px;margin-bottom:36px">clutchbox</p>
  <h1 style="font-size:84px">${headline(false)}</h1>
  <p class="tagline" style="margin-top:22px;font-size:30px">${tagline}</p></div>`,
    size: [1280, 420],
    scale: 2,
  },
  // GitHub asks for 1280×640 and under 1 MB; at twice the scale it stays well under.
  'github-social-preview.png': {
    html: `<div class="ground" style="display:flex;flex-direction:column;justify-content:space-between;padding:72px 84px">
  <p class="wordmark" style="font-size:36px">clutchbox</p>
  <div><h1 style="font-size:104px">${headline(false)}</h1>
  <p class="tagline" style="margin-top:28px;max-width:46ch;font-size:36px">${tagline}</p></div>
  <p class="tagline" style="font-size:28px">Open source <span style="color:#ff488b">→</span> Playwright, browser-use, E2B, any Chrome over CDP</p></div>`,
    size: [1280, 640],
    scale: 2,
  },
  'x-header.png': { html: plum(44, 104, 34, 130), size: [1500, 500] },
  'chrome-web-store/promo-small-440x280.png': { html: plum(20, 46, 16, 40), size: [440, 280] },
  'chrome-web-store/promo-marquee-1400x560.png': { html: plum(44, 116, 36, 130), size: [1400, 560] },
};

// A single-image ICO may hold a PNG directly: 6-byte header, 16-byte entry, then the PNG.
const ico = (png: Buffer, size: number) => {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(size, 6);
  header.writeUInt8(size, 7);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, png]);
};

export const render = async (browser: Browser, image: Image) => {
  const [width, height] = image.size;
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: image.scale ?? 1 });
  await page.setContent(`<style>${style}</style>${image.html}`);
  await page.evaluate(() => document.fonts.ready);
  const png = await page.screenshot({ type: 'png', omitBackground: true });
  await page.close();
  return image.ico ? ico(png, width) : png;
};
