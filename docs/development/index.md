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

## Testing

Start with [Testing](./testing.md): tiers, the eight lanes, what to run for each
kind of change, and the rules. The first command for any change is:

```bash
npm run verify -- plan
```

[Verification](./verification.md) is the lane reference: e2e internals, the
fake-green list, probes, and evals. For the witness tool, the CI witness gate,
agent review, and the merge protocol, use [Trust the change](./trust.md). For
Obsidian Mobile, use [Mobile testing](./mobile-testing.md). For the on-demand mutation
matrix, use [Mutation testing](./mutation.md).

For the community plugin review warnings, the lint gate, and the two intentional
behavior recommendations, use [Community plugin review](./community-review.md).

## Live dogfood

Exploratory WebDriver and manual bug sweeps against a real vault use [`docs/development/live-dogfood.md`](https://github.com/tardigrde/obsidian-agentic-chat/blob/main/docs/development/live-dogfood.md). The file stays in the repo but out of the public site because it is a maintainer runbook, not user documentation.
