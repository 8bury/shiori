# Changelog

## Unreleased

Shiori is a re-architecture of [second-brain-mcp](https://github.com/YudiG12/second-brain-mcp) as a self-hosted Node 24 + SQLite + Git server.

### Added
- **Episodic memory tree**: `memory_wake`, `memory_note`, `memory_nap`, `memory_recall`, `memory_zoom` and `memory_forget`. One-line memories in an append-only log, summarized into a power-of-2 binary tree; `memory_wake` returns recent memories verbatim and older ones compressed within `MEMORY_WAKE_LINES`. Every memory is also appended to `/data/memory.log`.
- MCP server `instructions` that tell agents how to use the memory, plus [MEMORY_PROMPT.md](MEMORY_PROMPT.md) for custom instructions.
- `ALLOWED_REDIRECT_PREFIXES` and `ALLOW_ALL_HTTPS_REDIRECTS` for clients beyond Claude and ChatGPT (Muse, Grok...).
- Embeddings from OpenAI or Gemini (`EMBEDDING_PROVIDER`), or keyword-only search with `none`.
- Optional backup push of the notes repository to `GIT_REMOTE_URL`.

### Changed
- **Runs as one Node 24 container** with SQLite (`node:sqlite`) and a local Git repository, in place of Cloudflare Workers, Artifacts, Durable Objects, Queues, D1, Vectorize and Workflows.
- **OAuth 2.1** is a built-in server stored in SQLite (PKCE S256, CIMD with SSRF checks, dynamic registration, consent page, GitHub owner check, refresh token rotation).
- Tests run in plain Node with Vitest instead of inside workerd.

### Kept from second-brain-mcp
- Notes tools: `list_notes`, `read_note`, `search_notes` (hybrid FTS5 + semantic, fused by reciprocal rank), `write_note` (with `expected_version`), `edit_note`, `delete_note`, `move_note`. Every edit is one Git commit.
- Daily reconciliation and on-demand rebuild of the search index; admin routes to list and revoke grants.

### Removed
- Cloudflare deployment (`wrangler`, setup scripts, D1 migrations, CI deploy), the Artifacts token hook and `HOOK_SECRET`, and the production measurement scripts.
- The v1/v2 PRDs, specs, ADRs and measurements of the Cloudflare version. They remain in Git history and in the upstream repository.
