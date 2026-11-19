# Shiori: Agent Guide

Shiori is a self-hosted Node 24 + SQLite + Git remote MCP server providing:
- **Episodic Memory Tree** (`src/memory/tree.ts`): append-only 1-line memories + binary-tree summaries (`memory_wake`, `memory_note`, `memory_nap`, `memory_recall`, `memory_zoom`, `memory_forget`).
- **Long-form Notes** (`src/writer/`, `src/indexer/`, `src/search/hybrid.ts`): Git-backed Markdown notes with hybrid FTS5 + vector search.
- **OAuth 2.1 + GitHub owner login** (`src/auth/oauth.ts`): protects `/mcp` with per-client grants, PKCE S256, and redirect allowlist.

## Development
- `npm run lint` - check formatting rules (no em-dashes allowed anywhere in the repo)
- `npm run typecheck` - TypeScript check
- `npm run build` - compile to `dist/`
- `npm test` - run Vitest suite
- Use **Conventional Commits** (`feat:`, `fix:`, `chore:`, `docs:`, etc.).
- Never use em-dashes in code, comments, or docs (enforced by `npm run lint`).
