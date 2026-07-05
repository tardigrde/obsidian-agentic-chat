# Publishing Docs

This repository publishes the docs site with VitePress and GitHub Pages.

## Local commands

```bash
npm run docs:dev
npm run docs:build
npm run docs:preview
```

`docs:build` writes the static site to:

```text
docs/.vitepress/dist
```

## GitHub Pages source

In the GitHub repository settings, set **Pages > Build and deployment > Source** to **GitHub Actions**.

The workflow in `.github/workflows/deploy-docs.yml` builds VitePress and deploys the generated artifact to Pages.

## Base path

The VitePress config uses:

```ts
base: "/obsidian-agentic-chat/"
```

That matches the default project Pages URL:

```text
https://tardigrde.github.io/obsidian-agentic-chat/
```

If the site later moves to a custom domain, change `base` to `/`.
