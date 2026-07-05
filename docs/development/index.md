# Development Guide

Install dependencies and run the local build loop:

```bash
npm install
npm run dev
```

`npm run dev` starts the esbuild watcher for plugin development.

## Dogfood vault

Use `~/MyTestVault` unless you need another vault.

```bash
npm run install:local -- ~/MyTestVault
npm run dev:vault -- ~/MyTestVault
```

`dev:vault` installs the real plugin files under:

```text
~/MyTestVault/.obsidian/plugins/agentic-chat/
```

It also creates `.hotreload` and writes esbuild output directly to that plugin directory.

For the full dogfood loop:

```bash
npm run dogfood -- ~/MyTestVault
```

Use `--once --no-open --no-tail` for a non-interactive build and install check.

## Docs loop

```bash
npm run docs:dev
npm run docs:build
npm run docs:preview
```

## Live dogfood

Use [Live dogfood harness](./live-dogfood.md) for exploratory WebDriver/manual
bug sweeps against a real vault and external multi-repo workspace.
