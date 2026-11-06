# Development guide

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

## Architecture

Use [Architecture](./architecture.md) for the single owner of each mutable state,
its invariants, and the current ownership gaps. The file is the design input for
the structural ownership PRs.

## Verification

Use [Verification](./verification.md) for the lane reference, evidence rules, the fake-green list, and probe workflows. The merge gate is:

```bash
npm run verify -- fast
```

For the witness tool, the CI witness gate, the independent verifier, and the
merge protocol, use [Trust the change](./trust.md). For the on-demand mutation
matrix, use [Mutation testing](./mutation.md).

## Live dogfood

Exploratory WebDriver and manual bug sweeps against a real vault use [`docs/development/live-dogfood.md`](https://github.com/tardigrde/obsidian-agentic-chat/blob/main/docs/development/live-dogfood.md). The file stays in the repo but out of the public site because it is a maintainer runbook, not user documentation.
