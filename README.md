# Second Brain MCP

<p align="center"><a href="https://github.com/8bury/second-brain-mcp/actions/workflows/ci.yml"><img alt="Tests" src="https://img.shields.io/github/actions/workflow/status/8bury/second-brain-mcp/ci.yml?branch=main&style=flat-square&label=tests&labelColor=1B2632"></a> <img alt="Node.js 24" src="https://img.shields.io/badge/runtime-Node.js_24-339933?style=flat-square&labelColor=1B2632&logo=node.js&logoColor=white"> <img alt="MCP" src="https://img.shields.io/badge/protocol-MCP-5A4BD1?style=flat-square&labelColor=1B2632"> <img alt="OAuth 2.1" src="https://img.shields.io/badge/auth-OAuth_2.1-2F8A5B?style=flat-square&labelColor=1B2632"> <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-8A6A3F?style=flat-square&labelColor=1B2632"></a> <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3767A8?style=flat-square&labelColor=1B2632&logo=typescript&logoColor=white"></p>

**A self-hosted remote MCP server that gives every AI client the same Markdown notes**: Claude, ChatGPT, Muse, Grok, and local coding agents. Hybrid search (SQLite FTS5 + API embeddings); every change is a Git commit; secured with OAuth 2.1 + GitHub owner login.

## Deploy on Coolify (or any Docker host)

1. Create a **GitHub OAuth App** (Settings → Developer settings → OAuth Apps):
   - Homepage URL: `https://brain.yourdomain.com`
   - Authorization callback URL: `https://brain.yourdomain.com/callback`
2. In **Coolify**, add a new resource from this GitHub repository using the `Dockerfile`.
3. Attach a persistent storage volume mounted at `/data` (holds `/data/notes` Git repo and `/data/brain.db` SQLite database).
4. Set the environment variables from [.env.example](.env.example):
   - `PUBLIC_URL` (e.g. `https://brain.yourdomain.com`)
   - `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `OWNER_GITHUB_ID`
   - `ADMIN_SECRET` (random hex string for `/admin/*`)
   - `EMBEDDING_PROVIDER` (`openai`, `gemini`, or `none`) and `EMBEDDING_API_KEY`
   - `ALLOWED_REDIRECT_PREFIXES` (comma-separated callback URLs for extra clients like Muse or Grok; Claude, ChatGPT, and localhost are allowed by default)
5. Deploy. Coolify handles HTTPS via Traefik and healthchecks `/health`.

## Local development

```sh
npm ci
cp .env.example .env
npm run dev
```

## Connecting AI clients

- **Claude Code:**
  ```sh
  claude mcp add -s user --transport http second-brain https://brain.yourdomain.com/mcp
  ```
- **Claude (web/desktop/mobile), ChatGPT, Muse, Grok:** add a custom remote MCP connector pointing to `https://brain.yourdomain.com/mcp`.
  - If a new client gets a `403` during sign-in, check the server logs for `{"auth":"redirect refused","redirectUri":"..."}` and add its callback prefix to `ALLOWED_REDIRECT_PREFIXES`.

## Tools

### Episodic Memory Tree (shared timeline)
- `memory_wake` — read the logarithmic memory view (recent verbatim, older summarized) at session start
- `memory_note` — append a 1-line memory (≤ 280 bytes); prompts for compression when a pair completes
- `memory_nap` — save a 1-line summary for a pending `#lo-hi` node (or check what's due)
- `memory_recall` — regex/text search across every raw memory ever recorded
- `memory_zoom` — open a `#lo-hi` summary node into its two halves down to raw entries
- `memory_forget` — drop a bad `#lo-hi` summary (and ancestors) so the next `memory_nap` rebuilds it

See [MEMORY_PROMPT.md](MEMORY_PROMPT.md) for the prompt to paste into `AGENTS.md`, `CLAUDE.md`, Muse, or Grok (also sent automatically via MCP server `instructions`).

### Long-form Notes (Markdown + Git + hybrid search)
- `list_notes` — list Markdown note paths (optional prefix filter)
- `read_note` — read a note and its version hash
- `search_notes` — hybrid keyword (FTS5) + semantic (vector) search fused with Reciprocal Rank Fusion
- `write_note` — create or overwrite a note (with optimistic version check)
- `edit_note` — exact-match passage replacement
- `delete_note` — delete a note (recoverable in Git history)
- `move_note` — move/rename a note in one commit

## Admin endpoints

Protected by `Authorization: Bearer <ADMIN_SECRET>`:

- `GET /admin/grants` — list active OAuth client grants
- `DELETE /admin/grants/<id>` — revoke one client grant
- `POST /admin/reconcile` — reconcile index with Git (`?mode=rebuild` for a full rebuild)
