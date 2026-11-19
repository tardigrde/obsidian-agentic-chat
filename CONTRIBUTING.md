# Contributing

Thanks for helping. This page is the short version; the full process lives in
[`AGENTS.md`](AGENTS.md) and [`docs/development/`](docs/development/index.md).

## Setup

Node 24+ and npm 11+ (see `engines` in `package.json`).

```bash
npm install
npm run dev:vault -- ~/MyTestVault   # esbuild watch, output written into the vault's plugin folder
npm run dogfood -- ~/MyTestVault     # also enables the plugin, opens the vault, tails sessions
```

Install [`pjeby/hot-reload`](https://github.com/pjeby/hot-reload) in that vault
for automatic reloads. Full loop: [Development guide](docs/development/index.md).

## Everyday commands

```bash
npm test             # vitest unit suite (no Obsidian needed)
npm run typecheck
npm run lint
npm run build        # typecheck, production bundle, release and mobile checks
npm run docs:dev     # VitePress docs site
```

## Before you open a PR

1. `npm run verify -- plan` prints the exact lanes your diff needs.
2. Every change needs a **witness**: the smallest test that fails before your
   change and passes after it. Paste both results in the PR.
3. Run the lowest `verify` lane that can catch your risk, and report test
   counts, not just exit codes. Zero tests run is a failure.
4. UI changes need a committed e2e assertion and one screenshot.
5. Never commit secrets, vault `data.json`, or session files.

The PR template walks through each of these. The reasons and the details are in
[Testing](docs/development/testing.md), [Verification](docs/development/verification.md)
(real-Obsidian e2e, mobile, live provider and MCP runs), [Evals](docs/development/evals.md),
and [Trust the change](docs/development/trust.md).

## Where things are

| Path | What |
| --- | --- |
| `src/` | Plugin source. Start at [Architecture](docs/development/architecture.md). |
| `test/` | Unit tests (`*.test.ts`), e2e specs (`test/e2e/`), evals (`test/evals/`). Every file is listed in `test/manifest.json`. |
| `scripts/` | `verify`, dogfood, release, and witness tooling. |
| `docs/` | User docs (`guide/`, `features/`, `reference/`), maintainer docs (`development/`), decisions (`adr/`). |
