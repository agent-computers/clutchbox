# Brand images

The Clutchbox brand images that are uploaded by hand or shown in this repository's READMEs: EB Garamond in white on the black ground. The web app's icons (`apps/web/app`) and the extension's (`apps/extension/public/icon`) stay where their frameworks read them.

| File | Where it goes |
| --- | --- |
| `github-avatar.png` | The GitHub organization's profile picture (organization settings, Profile) |
| `github-social-preview.png` | This repository's social preview (Settings, General, Social preview) |
| `readme-banner.png` | The top of [README.md](../README.md) |
| `x-header.png` | The X profile header |
| `chrome-web-store/promo-small-440x280.png` | The store listing's small promo tile |
| `chrome-web-store/promo-marquee-1400x560.png` | The store listing's marquee promo tile |
| `chrome-web-store/screenshot-1-connect.png`, `screenshot-2-control.png` | The store listing's screenshots; the second also illustrates the READMEs |

The store icon is the extension's own `apps/extension/public/icon/128.png`. `bun run render:brand-images` renders everything here except the screenshots, from [scripts/brand-images.ts](../scripts/brand-images.ts); the screenshots are captures of the store build's popup.
