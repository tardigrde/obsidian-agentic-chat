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

Exploratory WebDriver/manual bug sweeps against a real vault run from
[`docs/development/live-dogfood.md`](https://github.com/tardigrde/obsidian-agentic-chat/blob/main/docs/development/live-dogfood.md)
in the repo (kept out of the public site because it is a maintainer runbook, not user docs).
