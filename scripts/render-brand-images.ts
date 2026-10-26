import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { brandFolder, extensionIcon, render, webAppIcons } from './brand-images';

// Renders this repository's brand images: brand/, the web app's icons (apps/web/app, by Next's file convention),
// and the extension's (apps/extension/public/icon).
// Rerun after changing the wordmark, headline, tagline, or colours in brand-images.ts: bun run render:brand-images
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  for (const [file, image] of Object.entries(brandFolder)) {
    await mkdir(path.dirname(`brand/${file}`), { recursive: true });
    await writeFile(`brand/${file}`, await render(browser, image));
  }
  for (const [file, image] of Object.entries(webAppIcons))
    await writeFile(`apps/web/app/${file}`, await render(browser, image));
  for (const size of [16, 32, 48, 128])
    await writeFile(`apps/extension/public/icon/${size}.png`, await render(browser, extensionIcon(size)));
} finally {
  await browser.close();
}
