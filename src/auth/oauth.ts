import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import type { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "../config.js";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SESSION_TTL_SEC = 600; // 10 minutes
const AUTH_CODE_TTL_SEC = 300; // 5 minutes
const ACCESS_TOKEN_TTL_SEC = 3600; // 1 hour
const REFRESH_TOKEN_IDLE_TTL_SEC = 30 * 24 * 3600; // 30 days
const CIMD_CACHE_TTL_SEC = 3600; // 1 hour
const MAX_CIMD_BYTES = 8 * 1024;
const MAX_REGISTER_BYTES = 8 * 1024;
const MAX_REDIRECT_URIS = 10;

export interface VerifiedToken {
  token: string;
  clientId: string;
  userId: string;
  scopes: string[];
  expiresAt: number;
  resource?: string;
}

interface ClientRecord {
  clientId: string;
  clientName: string;
  clientDomain?: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: string;
  clientSecretHash: string | null;
}

interface AuthRequestPayload {
  clientId: string;
  clientName: string;
  clientDomain?: string;
  redirectUri: string;
  state: string | null;
  scope: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  resource: string | null;
  githubVerifier?: string;
  /** Set when this GitHub sign-in is for the web viewer (/ui) instead of an MCP client. */
  web?: boolean;
}

const WEB_SESSION_TTL_SEC = 7 * 24 * 3600; // 7 days

function webCookieName(publicUrl: string): string {
  return publicUrl.startsWith("https://") ? "__Host-shiori_web" : "shiori_web";
}

function setWebCookieHeader(publicUrl: string, value: string, maxAge: number): string {
  const secure = publicUrl.startsWith("https://") ? "; Secure" : "";
  return `${webCookieName(publicUrl)}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

/**
 * Exact-origin + path-prefix allowlist (prevents https://muse.app matching https://muse.app.evil.com).
 * Loopback hosts (localhost, 127.0.0.1, [::1]) are always allowed per RFC 8252.
 */
export function redirectAllowed(uri: string, allowedPrefixes: string[], allowAllHttps = false): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (LOOPBACK.has(u.hostname)) return true;
  if (allowAllHttps && u.protocol === "https:") return true;
  return allowedPrefixes.some((p) => {
    try {
      const prefix = new URL(p);
      if (u.origin !== prefix.origin) return false;
      return prefix.pathname === "/" || u.pathname.startsWith(prefix.pathname);
    } catch {
      return false;
    }
  });
}

/** Rejects loopback, private, link-local, CGNAT, and metadata IP addresses (SSRF protection for CIMD). */
export function isPrivateIp(ip: string): boolean {
  const clean = ip.replace(/^::ffff:/i, "");
  if (net.isIPv4(clean)) {
    const [a, b] = clean.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT / Tailscale
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === "::" || low === "::1") return true;
    if (low.startsWith("fc") || low.startsWith("fd")) return true; // ULA
    if (low.startsWith("fe8") || low.startsWith("fe9") || low.startsWith("fea") || low.startsWith("feb")) return true; // link-local
    if (low.startsWith("ff")) return true; // multicast
    return false;
  }
  return true;
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function s256(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

function escapeHtml(v: string): string {
  return v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function htmlResponse(body: string, headers: Headers, status = 200): Response {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Frame-Options", "DENY");
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5}button{font-size:1rem;padding:.5rem 1rem;margin-right:.5rem;cursor:pointer}</style>${body}`,
    { status, headers },
  );
}

function plain(message: string, status = 400): Response {
  return new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

function jsonError(error: string, description: string, status = 400): Response {
  return Response.json({ error, error_description: description }, { status, headers: { "Cache-Control": "no-store" } });
}

function parseCookies(req: Request): Map<string, string> {
  const map = new Map<string, string>();
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) {
      map.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
    }
  }
  return map;
}

function cookieName(publicUrl: string): string {
  return publicUrl.startsWith("https://") ? "__Host-shiori_oauth" : "shiori_oauth";
}

function setCookieHeader(publicUrl: string, value: string, maxAge: number): string {
  const name = cookieName(publicUrl);
  const secure = publicUrl.startsWith("https://") ? "; Secure" : "";
  return `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

function redirectWithError(redirectUri: string, error: string, state: string | null, description?: string): Response {
  const u = new URL(redirectUri);
  u.searchParams.set("error", error);
  if (description) u.searchParams.set("error_description", description);
  if (state) u.searchParams.set("state", state);
  return new Response(null, { status: 302, headers: { Location: u.toString(), "Cache-Control": "no-store" } });
}

function consentPage(req: AuthRequestPayload, handle: string): string {
  const redirectUrl = new URL(req.redirectUri);
  const isLoopback = LOOPBACK.has(redirectUrl.hostname);
  const who = req.clientDomain ? `Published by <strong>${escapeHtml(req.clientDomain)}</strong>.` : "This app registered itself; its name is not verified.";
  return `<title>Connect ${escapeHtml(req.clientName)}</title>
<h1>Connect ${escapeHtml(req.clientName)} to Shiori?</h1>
<p>${who} Access to your notes will be sent to <strong>${escapeHtml(redirectUrl.host)}</strong>.</p>
${isLoopback ? "<p><strong>This sends access to an app on this computer.</strong> Continue only if you just started connecting from it.</p>" : ""}
<p>Next, you'll sign in with GitHub to prove it's you.</p>
<form method="post"><input type="hidden" name="handle" value="${escapeHtml(handle)}">
<button name="decision" value="approve">Continue with GitHub</button><button name="decision" value="deny">Cancel</button></form>`;
}

async function readTextCapped(res: Response, maxBytes: number): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class OAuthServer {
  private readonly cimdCache = new Map<string, { record: ClientRecord; expiresAt: number }>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly config: Pick<
      AppConfig,
      "publicUrl" | "githubClientId" | "githubClientSecret" | "ownerGithubId" | "allowedRedirectPrefixes" | "allowAllHttpsRedirects"
    >,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private expectedResource(): string {
    return `${this.config.publicUrl}/mcp`;
  }

  private isValidResource(resource: string | null): boolean {
    if (!resource) return true;
    const norm = resource.replace(/\/+$/, "");
    return norm === this.expectedResource() || norm === this.config.publicUrl;
  }

  protectedResourceMetadata(): Response {
    return Response.json(
      {
        resource: this.expectedResource(),
        authorization_servers: [this.config.publicUrl],
        scopes_supported: ["mcp"],
        bearer_methods_supported: ["header"],
      },
      { headers: { "Cache-Control": "public, max-age=300" } },
    );
  }

  authorizationServerMetadata(): Response {
    const base = this.config.publicUrl;
    return Response.json(
      {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
        scopes_supported: ["mcp"],
        client_id_metadata_document_supported: true,
      },
      { headers: { "Cache-Control": "public, max-age=300" } },
    );
  }

  unauthorizedResponse(description?: string): Response {
    const resourceMeta = `${this.config.publicUrl}/.well-known/oauth-protected-resource`;
    const parts = [`Bearer resource_metadata="${resourceMeta}"`, `scope="mcp"`];
    if (description) parts.push(`error="invalid_token"`, `error_description="${description.replace(/"/g, "'")}"`);
    return new Response(JSON.stringify({ error: "unauthorized", error_description: description ?? "Authentication required" }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": parts.join(", "),
        "Cache-Control": "no-store",
      },
    });
  }

  async register(req: Request): Promise<Response> {
    if (req.method !== "POST") return plain("Method not allowed", 405);
    const raw = await req.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_REGISTER_BYTES) {
      return jsonError("invalid_client_metadata", "Registration payload too large", 413);
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return jsonError("invalid_client_metadata", "Request body must be valid JSON");
    }
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
    if (!redirectUris.length || redirectUris.length > MAX_REDIRECT_URIS) {
      return jsonError("invalid_redirect_uri", `redirect_uris must contain 1..${MAX_REDIRECT_URIS} URLs`);
    }
    for (const uri of redirectUris) {
      if (uri.length > 512) return jsonError("invalid_redirect_uri", "Redirect URI too long");
      try {
        const u = new URL(uri);
        if (u.protocol !== "https:" && !LOOPBACK.has(u.hostname)) {
          return jsonError("invalid_redirect_uri", `Redirect URI must use https or loopback: ${uri}`);
        }
      } catch {
        return jsonError("invalid_redirect_uri", `Invalid redirect URI: ${uri}`);
      }
    }
    const clientName = typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim().slice(0, 120) : "MCP Client";
    const authMethod =
      body.token_endpoint_auth_method === "client_secret_post" || body.token_endpoint_auth_method === "client_secret_basic"
        ? body.token_endpoint_auth_method
        : "none";
    const clientId = `mcp_${randomToken(18)}`;
    const clientSecret = authMethod === "none" ? undefined : randomToken(32);
    const now = Math.floor(Date.now() / 1000);

    this.db
      .prepare(
        "INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, token_endpoint_auth_method, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(clientId, clientSecret ? sha256Hex(clientSecret) : null, clientName, JSON.stringify(redirectUris), authMethod, now);

    return Response.json(
      {
        client_id: clientId,
        ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
        client_id_issued_at: now,
        client_name: clientName,
        redirect_uris: redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: authMethod,
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  }

  private lookupStoredClient(clientId: string): ClientRecord | null {
    const row = this.db
      .prepare("SELECT client_id, client_secret_hash, client_name, redirect_uris, token_endpoint_auth_method FROM oauth_clients WHERE client_id = ?")
      .get(clientId) as
      | {
          client_id: string;
          client_secret_hash: string | null;
          client_name: string;
          redirect_uris: string;
          token_endpoint_auth_method: string;
        }
      | undefined;

    if (!row) return null;
    return {
      clientId: row.client_id,
      clientName: row.client_name,
      clientDomain: row.client_id.startsWith("https://") ? new URL(row.client_id).host : undefined,
      redirectUris: JSON.parse(row.redirect_uris) as string[],
      tokenEndpointAuthMethod: row.token_endpoint_auth_method,
      clientSecretHash: row.client_secret_hash,
    };
  }

  private async resolveClient(clientId: string, allowNetwork = true): Promise<ClientRecord | null> {
    const stored = this.lookupStoredClient(clientId);
    if (stored) return stored;

    if (!clientId.startsWith("https://")) return null;
    const now = Math.floor(Date.now() / 1000);
    const cached = this.cimdCache.get(clientId);
    if (cached && cached.expiresAt > now) return cached.record;
    if (!allowNetwork) return null;

    // Client ID Metadata Document (CIMD) with SSRF, redirect, and size protections
    try {
      const u = new URL(clientId);
      if (u.protocol !== "https:" || u.pathname === "/" || u.pathname === "" || u.username || u.password) return null;
      if (LOOPBACK.has(u.hostname)) return null;
      const addrs = await dns.lookup(u.hostname, { all: true });
      if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) return null;

      const res = await this.fetcher(clientId, {
        headers: { Accept: "application/json", "User-Agent": "shiori" },
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      const text = await readTextCapped(res, MAX_CIMD_BYTES);
      if (!text) return null;
      const doc = JSON.parse(text) as { client_id?: string; client_name?: string; redirect_uris?: unknown };
      if (doc.client_id !== clientId) return null;
      const uris = Array.isArray(doc.redirect_uris)
        ? doc.redirect_uris.filter((x): x is string => typeof x === "string").slice(0, MAX_REDIRECT_URIS)
        : [];
      if (!uris.length) return null;

      const record: ClientRecord = {
        clientId,
        clientName: typeof doc.client_name === "string" && doc.client_name.trim() ? doc.client_name.trim().slice(0, 120) : u.host,
        clientDomain: u.host,
        redirectUris: uris,
        tokenEndpointAuthMethod: "none",
        clientSecretHash: null,
      };
      this.cimdCache.set(clientId, { record, expiresAt: now + CIMD_CACHE_TTL_SEC });
      // Persist in oauth_clients so /token never depends on live CIMD availability
      this.db
        .prepare(
          "INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, token_endpoint_auth_method, created_at) VALUES (?, NULL, ?, ?, 'none', ?) ON CONFLICT(client_id) DO UPDATE SET client_name = excluded.client_name, redirect_uris = excluded.redirect_uris",
        )
        .run(record.clientId, record.clientName, JSON.stringify(record.redirectUris), now);
      return record;
    } catch {
      return null;
    }
  }

  async authorize(req: Request): Promise<Response> {
    if (req.method === "GET") {
      const url = new URL(req.url);
      const clientId = url.searchParams.get("client_id") ?? "";
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const responseType = url.searchParams.get("response_type") ?? "";
      const state = url.searchParams.get("state");
      const rawScope = url.searchParams.get("scope") ?? "mcp";
      const codeChallenge = url.searchParams.get("code_challenge") ?? "";
      const codeChallengeMethod = url.searchParams.get("code_challenge_method") ?? "";
      const resource = url.searchParams.get("resource");

      if (!clientId || !redirectUri) return plain("Missing client_id or redirect_uri", 400);
      const client = await this.resolveClient(clientId, true);
      if (!client) return plain("Unknown client_id", 400);
      if (!client.redirectUris.includes(redirectUri)) return plain("redirect_uri is not registered for this client", 400);

      if (!redirectAllowed(redirectUri, this.config.allowedRedirectPrefixes, this.config.allowAllHttpsRedirects)) {
        console.warn(JSON.stringify({ auth: "redirect refused", redirectUri, clientId }));
        return plain(`This server does not allow redirects to ${new URL(redirectUri).host}. Add it to ALLOWED_REDIRECT_PREFIXES to connect it.`, 403);
      }

      if (responseType !== "code") return redirectWithError(redirectUri, "unsupported_response_type", state);
      if (!codeChallenge || codeChallengeMethod !== "S256") {
        return redirectWithError(redirectUri, "invalid_request", state, "PKCE S256 is required");
      }
      if (!this.isValidResource(resource)) {
        return redirectWithError(redirectUri, "invalid_target", state, "Invalid resource parameter");
      }

      // Limit granted scope strictly to "mcp"
      const requestedScopes = rawScope.split(/\s+/).filter(Boolean);
      const scope = requestedScopes.length === 0 || requestedScopes.includes("mcp") ? "mcp" : "";
      if (!scope) return redirectWithError(redirectUri, "invalid_scope", state, "Only scope 'mcp' is supported");

      const handle = randomToken(24);
      const cookieVal = randomToken(24);
      const now = Math.floor(Date.now() / 1000);
      const payload: AuthRequestPayload = {
        clientId: client.clientId,
        clientName: client.clientName,
        clientDomain: client.clientDomain,
        redirectUri,
        state,
        scope,
        codeChallenge,
        codeChallengeMethod,
        resource: resource ? this.expectedResource() : null,
      };
      this.db
        .prepare("INSERT INTO oauth_sessions (handle, kind, cookie_hash, payload, expires_at) VALUES (?, 'consent', ?, ?, ?)")
        .run(handle, sha256Hex(cookieVal), JSON.stringify(payload), now + SESSION_TTL_SEC);

      const headers = new Headers();
      headers.append("Set-Cookie", setCookieHeader(this.config.publicUrl, cookieVal, SESSION_TTL_SEC));
      return htmlResponse(consentPage(payload, handle), headers);
    }

    if (req.method === "POST") {
      const form = await req.formData();
      const handle = String(form.get("handle") ?? "");
      const decision = String(form.get("decision") ?? "");
      const session = this.consumeSession(req, handle, "consent");
      if (!session) return plain("This authorization session expired or was opened in another browser. Start again from your app.", 400);

      if (decision !== "approve") {
        const res = redirectWithError(session.redirectUri, "access_denied", session.state);
        res.headers.append("Set-Cookie", setCookieHeader(this.config.publicUrl, "", 0));
        return res;
      }

      if (!this.config.githubClientId || !this.config.githubClientSecret || !this.config.ownerGithubId) {
        return plain("Server OAuth is not configured (missing GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, or OWNER_GITHUB_ID).", 500);
      }

      const ghState = randomToken(24);
      const cookieVal = randomToken(24);
      const verifier = randomToken(32);
      const now = Math.floor(Date.now() / 1000);
      const nextPayload: AuthRequestPayload = { ...session, githubVerifier: verifier };
      this.db
        .prepare("INSERT INTO oauth_sessions (handle, kind, cookie_hash, payload, expires_at) VALUES (?, 'github', ?, ?, ?)")
        .run(ghState, sha256Hex(cookieVal), JSON.stringify(nextPayload), now + SESSION_TTL_SEC);

      const headers = new Headers({ Location: this.githubAuthorizeUrl(ghState, verifier), "Cache-Control": "no-store" });
      headers.append("Set-Cookie", setCookieHeader(this.config.publicUrl, cookieVal, SESSION_TTL_SEC));
      return new Response(null, { status: 302, headers });
    }

    return plain("Method not allowed", 405);
  }

  /** Starts a GitHub sign-in for the web viewer. */
  webLogin(): Response {
    if (!this.config.githubClientId || !this.config.githubClientSecret || !this.config.ownerGithubId) {
      return plain("Server OAuth is not configured (missing GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, or OWNER_GITHUB_ID).", 500);
    }
    const ghState = randomToken(24);
    const cookieVal = randomToken(24);
    const verifier = randomToken(32);
    const now = Math.floor(Date.now() / 1000);
    const payload = { web: true, githubVerifier: verifier } as AuthRequestPayload;
    this.db
      .prepare("INSERT INTO oauth_sessions (handle, kind, cookie_hash, payload, expires_at) VALUES (?, 'github', ?, ?, ?)")
      .run(ghState, sha256Hex(cookieVal), JSON.stringify(payload), now + SESSION_TTL_SEC);
    const headers = new Headers({ Location: this.githubAuthorizeUrl(ghState, verifier), "Cache-Control": "no-store" });
    headers.append("Set-Cookie", setCookieHeader(this.config.publicUrl, cookieVal, SESSION_TTL_SEC));
    return new Response(null, { status: 302, headers });
  }

  /** Returns the GitHub user id if the request carries a valid web viewer session. */
  verifyWebSession(req: Request): string | null {
    const cookieVal = parseCookies(req).get(webCookieName(this.config.publicUrl));
    if (!cookieVal) return null;
    const row = this.db
      .prepare("SELECT payload, expires_at FROM oauth_sessions WHERE handle = ? AND kind = 'web'")
      .get(sha256Hex(cookieVal)) as { payload: string; expires_at: number } | undefined;
    if (!row || row.expires_at < Math.floor(Date.now() / 1000)) return null;
    const { userId } = JSON.parse(row.payload) as { userId: string };
    return userId === this.config.ownerGithubId ? userId : null;
  }

  webLogout(req: Request): Response {
    const cookieVal = parseCookies(req).get(webCookieName(this.config.publicUrl));
    if (cookieVal) this.db.prepare("DELETE FROM oauth_sessions WHERE handle = ? AND kind = 'web'").run(sha256Hex(cookieVal));
    const headers = new Headers({ Location: "/ui", "Cache-Control": "no-store" });
    headers.append("Set-Cookie", setWebCookieHeader(this.config.publicUrl, "", 0));
    return new Response(null, { status: 303, headers });
  }

  private githubAuthorizeUrl(ghState: string, verifier: string): string {
    const gh = new URL("https://github.com/login/oauth/authorize");
    gh.search = new URLSearchParams({
      client_id: this.config.githubClientId,
      redirect_uri: `${this.config.publicUrl}/callback`,
      state: ghState,
      scope: "",
      code_challenge: s256(verifier),
      code_challenge_method: "S256",
      allow_signup: "false",
    }).toString();
    return gh.toString();
  }

  async callback(req: Request): Promise<Response> {
    if (req.method !== "GET") return plain("Method not allowed", 405);
    const params = new URL(req.url).searchParams;
    const ghState = params.get("state") ?? "";
    const session = this.consumeSession(req, ghState, "github");
    if (!session || !session.githubVerifier) {
      return plain("This sign-in link expired or was opened in another browser. Start again from your app.", 400);
    }

    const clearCookie = setCookieHeader(this.config.publicUrl, "", 0);
    const code = params.get("code");
    if (params.get("error") || !code) {
      if (session.web) return plain("GitHub sign-in was cancelled.", 400);
      const res = redirectWithError(session.redirectUri, "access_denied", session.state);
      res.headers.append("Set-Cookie", clearCookie);
      return res;
    }

    const tokenRes = await this.fetcher("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: this.config.githubClientId,
        client_secret: this.config.githubClientSecret,
        code,
        redirect_uri: `${this.config.publicUrl}/callback`,
        code_verifier: session.githubVerifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const tokenJson = tokenRes.ok ? ((await tokenRes.json().catch(() => null)) as { access_token?: string; error?: string } | null) : null;
    if (!tokenJson?.access_token) {
      return plain(`GitHub sign-in failed (${tokenJson?.error ?? "no token"}). Start again from your app.`, 400);
    }

    const userRes = await this.fetcher("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${tokenJson.access_token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "shiori",
      },
      signal: AbortSignal.timeout(10_000),
    });
    const user = userRes.ok ? ((await userRes.json().catch(() => null)) as { id: number; login: string } | null) : null;
    if (!user) return plain("Couldn't read your GitHub account. Start again from your app.", 502);
    if (String(user.id) !== this.config.ownerGithubId) {
      console.warn(JSON.stringify({ auth: "refused", githubId: user.id }));
      return plain("This Shiori instance belongs to someone else.", 403);
    }

    if (session.web) {
      const webToken = randomToken(32);
      this.db
        .prepare("INSERT INTO oauth_sessions (handle, kind, cookie_hash, payload, expires_at) VALUES (?, 'web', '', ?, ?)")
        .run(sha256Hex(webToken), JSON.stringify({ userId: String(user.id), login: user.login }), Math.floor(Date.now() / 1000) + WEB_SESSION_TTL_SEC);
      const headers = new Headers({ Location: "/ui", "Cache-Control": "no-store" });
      headers.append("Set-Cookie", clearCookie);
      headers.append("Set-Cookie", setWebCookieHeader(this.config.publicUrl, webToken, WEB_SESSION_TTL_SEC));
      return new Response(null, { status: 302, headers });
    }

    const authCode = randomToken(32);
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        "INSERT INTO oauth_auth_codes (code_hash, client_id, user_id, redirect_uri, scope, code_challenge, code_challenge_method, resource, metadata, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        sha256Hex(authCode),
        session.clientId,
        String(user.id),
        session.redirectUri,
        session.scope,
        session.codeChallenge,
        session.codeChallengeMethod,
        session.resource,
        JSON.stringify({ login: user.login }),
        now + AUTH_CODE_TTL_SEC,
      );

    const dest = new URL(session.redirectUri);
    dest.searchParams.set("code", authCode);
    if (session.state) dest.searchParams.set("state", session.state);

    const headers = new Headers({ Location: dest.toString(), "Cache-Control": "no-store" });
    headers.append("Set-Cookie", clearCookie);
    return new Response(null, { status: 302, headers });
  }

  async token(req: Request): Promise<Response> {
    if (req.method !== "POST") return plain("Method not allowed", 405);
    const params = await this.parseTokenBody(req);
    if (!params) return jsonError("invalid_request", "Could not parse token request body");

    let clientId = params.get("client_id") ?? "";
    let clientSecret = params.get("client_secret") ?? "";
    const authHeader = req.headers.get("authorization") ?? "";
    if (authHeader.startsWith("Basic ")) {
      try {
        const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
        const colon = decoded.indexOf(":");
        if (colon > 0) {
          clientId = decodeURIComponent(decoded.slice(0, colon));
          clientSecret = decodeURIComponent(decoded.slice(colon + 1));
        }
      } catch {
        return jsonError("invalid_client", "Invalid Basic authorization header", 401);
      }
    }

    const grantType = params.get("grant_type");
    if (grantType === "authorization_code") {
      return this.exchangeAuthCode(params, clientId, clientSecret);
    }
    if (grantType === "refresh_token") {
      return this.exchangeRefreshToken(params, clientId, clientSecret);
    }
    return jsonError("unsupported_grant_type", `Unsupported grant_type: ${grantType ?? ""}`);
  }

  private verifyClientAuthSync(clientId: string, clientSecret: string): boolean {
    const client = this.lookupStoredClient(clientId);
    if (!client) return false;
    if (client.tokenEndpointAuthMethod === "none") return true;
    if (!client.clientSecretHash || !clientSecret) return false;
    const given = Buffer.from(sha256Hex(clientSecret), "hex");
    const expected = Buffer.from(client.clientSecretHash, "hex");
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  }

  private exchangeAuthCode(params: URLSearchParams, clientId: string, clientSecret: string): Response {
    const code = params.get("code") ?? "";
    const redirectUri = params.get("redirect_uri") ?? "";
    const codeVerifier = params.get("code_verifier") ?? "";
    if (!code || !codeVerifier) return jsonError("invalid_request", "Missing code or code_verifier");

    const codeHash = sha256Hex(code);
    const row = this.db
      .prepare(
        "DELETE FROM oauth_auth_codes WHERE code_hash = ? RETURNING client_id, user_id, redirect_uri, scope, code_challenge, code_challenge_method, resource, metadata, expires_at",
      )
      .get(codeHash) as
      | {
          client_id: string;
          user_id: string;
          redirect_uri: string;
          scope: string;
          code_challenge: string;
          code_challenge_method: string;
          resource: string | null;
          metadata: string;
          expires_at: number;
        }
      | undefined;

    const now = Math.floor(Date.now() / 1000);
    if (!row || row.expires_at < now) return jsonError("invalid_grant", "Authorization code is invalid or expired");
    if (clientId && clientId !== row.client_id) return jsonError("invalid_grant", "client_id mismatch");
    const effectiveClientId = clientId || row.client_id;
    if (!this.verifyClientAuthSync(effectiveClientId, clientSecret)) {
      return jsonError("invalid_client", "Client authentication failed", 401);
    }
    if (redirectUri && redirectUri !== row.redirect_uri) return jsonError("invalid_grant", "redirect_uri mismatch");
    if (row.code_challenge_method !== "S256" || s256(codeVerifier) !== row.code_challenge) {
      return jsonError("invalid_grant", "Invalid PKCE code_verifier");
    }

    const grantId = randomToken(18);
    this.db
      .prepare(
        "INSERT INTO oauth_grants (id, client_id, user_id, scope, metadata, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(grantId, row.client_id, row.user_id, row.scope, row.metadata, now, now, now + REFRESH_TOKEN_IDLE_TTL_SEC);

    return this.issueTokens(grantId, row.client_id, row.user_id, row.scope, row.resource, now);
  }

  private exchangeRefreshToken(params: URLSearchParams, clientId: string, clientSecret: string): Response {
    const refreshToken = params.get("refresh_token") ?? "";
    if (!refreshToken) return jsonError("invalid_request", "Missing refresh_token");
    const tokenHash = sha256Hex(refreshToken);

    // Atomically consume the refresh token first so two concurrent refreshes cannot both succeed
    const row = this.db
      .prepare("DELETE FROM oauth_tokens WHERE token_hash = ? AND token_type = 'refresh' RETURNING grant_id, client_id, user_id, scope, resource, expires_at")
      .get(tokenHash) as
      | { grant_id: string; client_id: string; user_id: string; scope: string; resource: string | null; expires_at: number }
      | undefined;

    const now = Math.floor(Date.now() / 1000);
    if (!row || row.expires_at < now) return jsonError("invalid_grant", "Refresh token is invalid or expired");
    if (clientId && clientId !== row.client_id) return jsonError("invalid_grant", "client_id mismatch");
    if (!this.verifyClientAuthSync(row.client_id, clientSecret)) {
      return jsonError("invalid_client", "Client authentication failed", 401);
    }

    this.db
      .prepare("UPDATE oauth_grants SET last_used_at = ?, expires_at = ? WHERE id = ?")
      .run(now, now + REFRESH_TOKEN_IDLE_TTL_SEC, row.grant_id);

    return this.issueTokens(row.grant_id, row.client_id, row.user_id, row.scope, row.resource, now);
  }

  private issueTokens(grantId: string, clientId: string, userId: string, scope: string, resource: string | null, now: number): Response {
    const accessToken = randomToken(32);
    const refreshToken = randomToken(32);
    const insert = this.db.prepare(
      "INSERT INTO oauth_tokens (token_hash, grant_id, token_type, client_id, user_id, scope, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run(sha256Hex(accessToken), grantId, "access", clientId, userId, scope, resource, now + ACCESS_TOKEN_TTL_SEC);
    insert.run(sha256Hex(refreshToken), grantId, "refresh", clientId, userId, scope, resource, now + REFRESH_TOKEN_IDLE_TTL_SEC);

    return Response.json(
      {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_TTL_SEC,
        refresh_token: refreshToken,
        scope,
      },
      { headers: { "Cache-Control": "no-store", Pragma: "no-cache" } },
    );
  }

  verifyBearer(req: Request): VerifiedToken | null {
    const header = req.headers.get("authorization") ?? "";
    if (!header.startsWith("Bearer ")) return null;
    const token = header.slice(7).trim();
    if (!token) return null;
    const now = Math.floor(Date.now() / 1000);
    const row = this.db
      .prepare("SELECT client_id, user_id, scope, resource, expires_at FROM oauth_tokens WHERE token_hash = ? AND token_type = 'access'")
      .get(sha256Hex(token)) as
      | { client_id: string; user_id: string; scope: string; resource: string | null; expires_at: number }
      | undefined;
    if (!row || row.expires_at <= now) return null;
    if (!this.isValidResource(row.resource)) return null;
    return {
      token,
      clientId: row.client_id,
      userId: row.user_id,
      scopes: row.scope.split(/\s+/).filter(Boolean),
      expiresAt: row.expires_at,
      resource: row.resource ?? undefined,
    };
  }

  listGrants(userId: string) {
    return this.db
      .prepare("SELECT id, client_id as clientId, scope, created_at as createdAt, last_used_at as lastUsedAt FROM oauth_grants WHERE user_id = ? ORDER BY created_at DESC")
      .all(userId) as unknown as { id: string; clientId: string; scope: string; createdAt: number; lastUsedAt: number }[];
  }

  revokeGrant(grantId: string, userId: string): boolean {
    const res = this.db.prepare("DELETE FROM oauth_grants WHERE id = ? AND user_id = ?").run(grantId, userId);
    return Number(res.changes) > 0;
  }

  purgeExpired(): { sessions: number; codes: number; tokens: number; grants: number; clients: number } {
    const now = Math.floor(Date.now() / 1000);
    const sessions = Number(this.db.prepare("DELETE FROM oauth_sessions WHERE expires_at < ?").run(now).changes);
    const codes = Number(this.db.prepare("DELETE FROM oauth_auth_codes WHERE expires_at < ?").run(now).changes);
    const tokens = Number(this.db.prepare("DELETE FROM oauth_tokens WHERE expires_at < ?").run(now).changes);
    const grants = Number(this.db.prepare("DELETE FROM oauth_grants WHERE expires_at < ?").run(now).changes);
    // Remove orphaned clients older than 30 days with no active grants
    const cutoff = now - REFRESH_TOKEN_IDLE_TTL_SEC;
    const clients = Number(
      this.db
        .prepare("DELETE FROM oauth_clients WHERE created_at < ? AND client_id NOT IN (SELECT DISTINCT client_id FROM oauth_grants)")
        .run(cutoff).changes,
    );
    return { sessions, codes, tokens, grants, clients };
  }

  private consumeSession(req: Request, handle: string, kind: "consent" | "github"): AuthRequestPayload | null {
    if (!handle) return null;
    const cookies = parseCookies(req);
    const cookieVal = cookies.get(cookieName(this.config.publicUrl));
    if (!cookieVal) return null;
    const row = this.db
      .prepare("DELETE FROM oauth_sessions WHERE handle = ? AND kind = ? RETURNING cookie_hash, payload, expires_at")
      .get(handle, kind) as { cookie_hash: string; payload: string; expires_at: number } | undefined;
    const now = Math.floor(Date.now() / 1000);
    if (!row || row.expires_at < now) return null;
    const given = Buffer.from(sha256Hex(cookieVal), "hex");
    const expected = Buffer.from(row.cookie_hash, "hex");
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    return JSON.parse(row.payload) as AuthRequestPayload;
  }

  private async parseTokenBody(req: Request): Promise<URLSearchParams | null> {
    const ct = (req.headers.get("content-type") ?? "").toLowerCase();
    const raw = await req.text();
    if (ct.includes("application/json")) {
      try {
        const obj = JSON.parse(raw) as Record<string, string>;
        return new URLSearchParams(obj);
      } catch {
        return null;
      }
    }
    return new URLSearchParams(raw);
  }
}
