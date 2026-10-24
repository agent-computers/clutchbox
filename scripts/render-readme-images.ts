import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

// Renders the README banner and GitHub's social preview into .github/assets, in the Agent Computers brand: EB Garamond
// on the plum-black ground. GitHub's social preview is uploaded by hand (Settings, General, Social preview).
// Rerun after changing the headline or tagline: node --import tsx scripts/render-readme-images.ts
const font = async (file: string) =>
  `data:font/woff2;base64,${(await readFile(`apps/extension/src/ui/fonts/${file}`)).toString('base64')}`;
const style = `
  @font-face { font-family: Garamond; src: url(${await font('EBGaramond.woff2')}); font-weight: 400 500; }
  @font-face { font-family: Garamond; src: url(${await font('EBGaramond-Italic.woff2')}); font-weight: 400 500; font-style: italic; }
  * { margin: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; color: #ffffff; font-family: Garamond; }
  .ground { width: 100%; height: 100%; overflow: hidden; background: #0d060b; display: flex; flex-direction: column; }
  .mark { font-style: italic; font-weight: 500; }
  h1 { font-weight: 500; line-height: 1.02; letter-spacing: -0.02em; }
  .tagline { line-height: 1.3; color: #c9bec6; }
  .arrow { color: #ff488b; }`;
const headline = 'Agents that work <span class="mark">signed in</span>';
const tagline = 'Sync the sites you choose from your browser into the browsers your agents use.';
const banner = `<div class="ground" style="justify-content:center;padding:0 80px">
  <p class="mark" style="font-size:30px;margin-bottom:36px">agent computers</p>
  <h1 style="font-size:84px">${headline}</h1>
  <p class="tagline" style="margin-top:22px;font-size:30px">${tagline}</p></div>`;
const preview = `<div class="ground" style="justify-content:space-between;padding:72px 84px">
  <p class="mark" style="font-size:36px">agent computers</p>
  <div><h1 style="font-size:104px">${headline}</h1>
  <p class="tagline" style="margin-top:28px;max-width:46ch;font-size:36px">${tagline}</p></div>
  <p class="tagline" style="font-size:28px">Open source <span class="arrow">→</span> Playwright, browser-use, E2B, any Chrome over CDP</p></div>`;

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const render = async (html: string, width: number, height: number) => {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  await page.setContent(`<style>${style}</style>${html}`);
  await page.evaluate(() => document.fonts.ready);
  const png = await page.screenshot({ type: 'png' });
  await page.close();
  return png;
};
try {
  await mkdir('.github/assets', { recursive: true });
  await writeFile('.github/assets/banner.png', await render(banner, 1280, 420));
  // GitHub asks for 1280×640 and under 1 MB; at twice the scale it stays well under.
  await writeFile('.github/assets/social-preview.png', await render(preview, 1280, 640));
} finally {
  await browser.close();
}
