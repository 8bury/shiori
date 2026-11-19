# Setup

Shiori is one Docker container. It keeps all its state in a single volume mounted at `/data`:

| Path | What |
|---|---|
| `/data/notes` | Git repository of Markdown notes (every edit is a commit) |
| `/data/shiori.db` | SQLite: OAuth clients and grants, episodic memory, search index (FTS5 + vectors) |
| `/data/memory.log` | Plain-text append-only copy of every memory, for disaster recovery |

Back up the volume and you have backed up everything. The search index can always be rebuilt from the notes.

## Requirements

- A Docker host with HTTPS in front of it (Coolify, Traefik, Caddy, nginx...). OAuth clients like Claude and ChatGPT require a public `https://` URL.
- A GitHub account (sign-in only proves identity; no scopes are requested).
- Optional: an OpenAI or Gemini API key for semantic search. Without one, search is keyword-only (FTS5).

## Steps

1. **GitHub OAuth App.** In *Settings → Developer settings → OAuth Apps*, create an app with:
   - Homepage URL: `https://shiori.yourdomain.com`
   - Authorization callback URL: `https://shiori.yourdomain.com/callback`

   Note the client id, generate a client secret, and look up your numeric user id at `https://api.github.com/users/<username>`.
2. **Environment.** Copy [`.env.example`](../.env.example) and fill in at least `PUBLIC_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `OWNER_GITHUB_ID` and `ADMIN_SECRET` (`openssl rand -hex 32`). Set `EMBEDDING_PROVIDER` and `EMBEDDING_API_KEY` for semantic search.
3. **Run the container.** With Coolify, point a resource at the repository's `Dockerfile`, mount a persistent volume at `/data`, and set the domain. With plain Docker:

   ```sh
   docker build -t shiori .
   docker run -d --name shiori --env-file .env -p 3000:3000 -v shiori-data:/data shiori
   ```

   The container has a `HEALTHCHECK` on `GET /health`.
4. **Import existing notes (optional).** Put Markdown files in `/data/notes` and commit them, or clone an existing notes repository there before the first start. Then build the index once:

   ```sh
   curl -X POST -H "Authorization: Bearer $ADMIN_SECRET" "https://shiori.yourdomain.com/admin/reconcile?mode=rebuild"
   ```

   After that, a daily reconciliation keeps the index in line with Git.
5. **Backup remote (optional).** Set `GIT_REMOTE_URL` to a private repository. Shiori syncs with it and pushes every commit. Prefer an SSH deploy key or a fine-grained token scoped to that one repository.
6. **Connect clients.** Add `https://shiori.yourdomain.com/mcp` as a remote MCP server in each client (see the [README](../README.md#connecting-your-agents)). The first connection opens the consent page and then GitHub sign-in.

## Operations

- **Grants:** `GET /admin/grants` lists connected clients; `DELETE /admin/grants/<id>` revokes one. Both need `Authorization: Bearer <ADMIN_SECRET>`; without it they answer `404`.
- **Index repair:** `POST /admin/reconcile` repairs drift between Git and the index; `?mode=rebuild` re-indexes every note.
- **New client refused:** if a client gets `403` during sign-in, the logs show `{"auth":"redirect refused","redirectUri":"..."}`. Add that callback prefix to `ALLOWED_REDIRECT_PREFIXES` and restart.
- **Daily maintenance** runs in-process: reconciliation plus purging expired OAuth sessions, codes and tokens.
- **Shutdown:** on `SIGTERM` the server stops accepting requests, drains the indexing queue and closes the database.
