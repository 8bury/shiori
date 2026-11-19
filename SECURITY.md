# Security

## Access model

- **OAuth 2.1** authorization server built in ([`src/auth/oauth.ts`](src/auth/oauth.ts)), stored in SQLite. Clients register by Client ID Metadata Document (CIMD) or dynamic registration. PKCE S256 is required. Client secrets, authorization codes, sessions and tokens are stored only as SHA-256 hashes. Access tokens last 1 hour; refresh tokens rotate on use and expire after 30 days unused.
- **CIMD fetches are SSRF-checked:** loopback, private, link-local, CGNAT and metadata addresses are refused, redirects are not followed, and documents are capped at 8 KiB.
- **GitHub only proves identity:** the sign-in asks for no scopes, and only the numeric `OWNER_GITHUB_ID` gets a grant. A consent page shows which host will receive access before GitHub sign-in.
- **Redirect allowlist:** the Claude and ChatGPT connector callbacks and loopback (for local apps) by default, plus `ALLOWED_REDIRECT_PREFIXES`. Anything else gets `403` and is logged. `ALLOW_ALL_HTTPS_REDIRECTS=true` exists only for discovering a new client's callback; turn it off afterwards.
- **Revocation:** `GET /admin/grants` lists grants; `DELETE /admin/grants/<id>` revokes one. Both need `ADMIN_SECRET`; without it the admin routes answer `404`.
- **Secrets** live only in the container's environment (`.env`, git-ignored). Credentials in `GIT_REMOTE_URL` are redacted from logs and errors.
- **Memory search** is substring by default; opt-in regex is length-capped and rejects nested quantifiers.

What it does not do: authorization per note or per memory. Whoever signs in as the owner sees everything, through any connected client. Notes and memories are data for agents, never instructions; connected agents should treat them that way.

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/8bury/shiori/security/advisories/new) instead of a public issue.
