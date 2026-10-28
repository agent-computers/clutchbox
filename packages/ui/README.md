# @clutchbox/ui

The web app's design system: shadcn components on Base UI, the theme, and the type families.

- **Tokens and theme:** [`src/styles/globals.css`](src/styles/globals.css) holds the colour tokens (one dark theme in shadcn's token names), the Tailwind theme, and the reduced-motion rule. Import it as `@clutchbox/ui/globals.css`.
- **Fonts:** [`src/fonts`](src/fonts) holds EB Garamond (titles and the wordmark) and IBM Plex Sans (controls, forms, and body text), both under the SIL Open Font License, with their licences beside them. A Next app loads them with `next/font/local`; [`src/styles/fonts.css`](src/styles/fonts.css) declares the same faces for surfaces without it, as `@clutchbox/ui/fonts.css`.
- **Components:** [`src/components`](src/components) holds shadcn components in the `base-nova` style, owned and edited here. Add one from this directory with `bunx shadcn@4.21.5 add <name>` rather than writing it by hand. [`src/styles/shadcn.css`](src/styles/shadcn.css) is the CLI's variant and utility sheet, vendored so the CLI is not a runtime dependency. Both come from [shadcn/ui](https://github.com/shadcn-ui/ui) under the MIT License, whose notice is in [`LICENSE-shadcn.md`](LICENSE-shadcn.md).
- **Icons:** [lucide-react](https://lucide.dev), the icon library set in [`components.json`](components.json).

Import components and helpers by subpath, for example `@clutchbox/ui/components/button` and `@clutchbox/ui/lib/utils`. `globals.css` adds this package's files to Tailwind's sources, so the classes its components use are generated in any app that imports it; the app scans its own files.

The Chrome extension doesn't import this package yet: it keeps copies of the few components it uses and a trimmed theme in [`apps/extension/src/ui`](../../apps/extension/src/ui), so change shared colours and fonts in both.
