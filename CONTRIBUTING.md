# Contributing

## Development

Node 24 or later (`.nvmrc`), and `git` on the `PATH`.

```sh
npm ci
cp .env.example .env    # DATA_DIR defaults to ./data for local runs
npm run dev             # tsx watch on src/index.ts
```

Checks (the same ones CI runs on every push and PR):

```sh
npm run lint            # no em-dashes anywhere in the repo
npm run typecheck
npm run build
npm test                # Vitest, in-process with node:sqlite and fake git/indexer ports
```

To deploy your own: [docs/setup.md](docs/setup.md).

## How changes are made

1. **Tests first.** Describe the behavior in a failing test, then make it pass. A known bug can be pinned with `it.fails`, which turns red once the bug is fixed.
2. **Conventional Commits** (`feat:`, `fix:`, `docs:`, `chore:`...).
3. **CI must be green**: lint, typecheck, build and tests.
