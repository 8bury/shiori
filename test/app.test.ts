import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { isPrivateIp, redirectAllowed } from "../src/auth/oauth";
import { loadConfig } from "../src/config";
import type { Embedder } from "../src/indexer/types";

function s256(verifier: string) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function extractCookie(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? "";
  return raw.split(";")[0];
}

// Deterministic toy embedder: maps text into a 4D vector so semantic search works in tests
class ToyEmbedder implements Embedder {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const s = t.toLowerCase();
      return [
        s.includes("coffee") || s.includes("espresso") ? 1 : 0.05,
        s.includes("architecture") || s.includes("docker") ? 1 : 0.05,
        s.includes("muse") || s.includes("grok") ? 1 : 0.05,
        0.1,
      ];
    });
  }
}

describe("end-to-end Node app (OAuth 2.1 + MCP + SQLite + Git)", () => {
  let tmpDir: string;
  let app: Awaited<ReturnType<typeof createApp>>;
  let githubUserId = 42;

  const mockFetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url === "https://github.com/login/oauth/access_token") {
      return Response.json({ access_token: "gho_test_token" });
    }
    if (url === "https://api.github.com/user") {
      return Response.json({ id: githubUserId, login: "owner" });
    }
    return new Response("not found", { status: 404 });
  };

  beforeEach(async () => {
    githubUserId = 42;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-mcp-test-"));
    const config = loadConfig({
      DATA_DIR: tmpDir,
      PUBLIC_URL: "https://brain.example.com",
      GITHUB_CLIENT_ID: "gh-client",
      GITHUB_CLIENT_SECRET: "gh-secret",
      OWNER_GITHUB_ID: "42",
      ADMIN_SECRET: "super-secret-admin",
      ALLOWED_REDIRECT_PREFIXES: "https://muse.meta.com/oauth/callback",
    });
    app = await createApp(config, {
      embedder: new ToyEmbedder(),
      fetcher: mockFetcher,
      queueDelayMultiplier: 1,
    });
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function obtainToken(redirectUri = "http://127.0.0.1:4321/cb") {
    // 1. Dynamic client registration
    const reg = await app.fetch(
      new Request("https://brain.example.com/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "Test Client", redirect_uris: [redirectUri] }),
      }),
    );
    expect(reg.status).toBe(201);
    const { client_id } = (await reg.json()) as { client_id: string };

    // 2. GET /authorize -> consent page
    const verifier = "my-super-secret-pkce-verifier-string-1234567890";
    const authUrl = new URL("https://brain.example.com/authorize");
    authUrl.searchParams.set("client_id", client_id);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", "mcp");
    authUrl.searchParams.set("state", "xyz");
    authUrl.searchParams.set("code_challenge", s256(verifier));
    authUrl.searchParams.set("code_challenge_method", "S256");

    const consentRes = await app.fetch(new Request(authUrl));
    expect(consentRes.status).toBe(200);
    const consentHtml = await consentRes.text();
    const handleMatch = consentHtml.match(/name="handle" value="([^"]+)"/);
    expect(handleMatch).toBeTruthy();
    const consentCookie = extractCookie(consentRes);

    // 3. POST /authorize -> redirect to GitHub
    const form = new URLSearchParams({ handle: handleMatch![1], decision: "approve" });
    const approveRes = await app.fetch(
      new Request("https://brain.example.com/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: consentCookie },
        body: form,
      }),
    );
    expect(approveRes.status).toBe(302);
    const ghRedirect = new URL(approveRes.headers.get("location")!);
    expect(ghRedirect.origin).toBe("https://github.com");
    const ghState = ghRedirect.searchParams.get("state")!;
    const ghCookie = extractCookie(approveRes);

    // 4. GET /callback -> redirect back to client with code
    const cbRes = await app.fetch(
      new Request(`https://brain.example.com/callback?code=gh_code&state=${encodeURIComponent(ghState)}`, {
        headers: { Cookie: ghCookie },
      }),
    );
    expect(cbRes.status).toBe(302);
    const clientRedirect = new URL(cbRes.headers.get("location")!);
    expect(clientRedirect.searchParams.get("state")).toBe("xyz");
    const code = clientRedirect.searchParams.get("code")!;

    // 5. POST /token -> access + refresh tokens
    const tokRes = await app.fetch(
      new Request("https://brain.example.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        }),
      }),
    );
    expect(tokRes.status).toBe(200);
    const tokens = (await tokRes.json()) as { access_token: string; refresh_token: string };
    return { clientId: client_id, ...tokens };
  }

  async function mcpCall(token: string, name: string, args: Record<string, unknown> = {}) {
    const res = await app.fetch(
      new Request("https://brain.example.com/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      }),
    );
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") ?? "";
    const raw = await res.text();
    const jsonText = ct.includes("text/event-stream")
      ? raw
          .split("\n")
          .filter((l) => l.startsWith("data: "))
          .map((l) => l.slice(6))
          .pop() ?? ""
      : raw;
    const body = JSON.parse(jsonText) as { result: { content: { text: string }[] } };
    return body.result.content.map((c) => c.text);
  }

  it("exposes health and OAuth discovery metadata, and blocks unauthenticated /mcp", async () => {
    const health = await app.fetch(new Request("https://brain.example.com/health"));
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });

    const prm = await app.fetch(new Request("https://brain.example.com/.well-known/oauth-protected-resource"));
    expect(prm.status).toBe(200);
    expect(await prm.json()).toMatchObject({ resource: "https://brain.example.com/mcp", authorization_servers: ["https://brain.example.com"] });

    const unauth = await app.fetch(new Request("https://brain.example.com/mcp", { method: "POST" }));
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("enforces redirect allowlist (including custom ALLOWED_REDIRECT_PREFIXES) and owner GitHub ID", async () => {
    // Disallowed redirect gets 403
    const regBad = await app.fetch(
      new Request("https://brain.example.com/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "Evil", redirect_uris: ["https://evil.example.com/cb"] }),
      }),
    );
    const { client_id: evilId } = (await regBad.json()) as { client_id: string };
    const badAuth = await app.fetch(
      new Request(
        `https://brain.example.com/authorize?client_id=${evilId}&redirect_uri=https://evil.example.com/cb&response_type=code&code_challenge=abc&code_challenge_method=S256`,
      ),
    );
    expect(badAuth.status).toBe(403);

    // Custom ALLOWED_REDIRECT_PREFIXES (Muse) is allowed
    const { access_token } = await obtainToken("https://muse.meta.com/oauth/callback");
    expect(access_token).toBeTruthy();

    // Wrong GitHub owner is rejected at /callback
    githubUserId = 999;
    const reg = await app.fetch(
      new Request("https://brain.example.com/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "Other", redirect_uris: ["http://127.0.0.1:9999/cb"] }),
      }),
    );
    const { client_id } = (await reg.json()) as { client_id: string };
    const cRes = await app.fetch(
      new Request(
        `https://brain.example.com/authorize?client_id=${client_id}&redirect_uri=http://127.0.0.1:9999/cb&response_type=code&code_challenge=${s256("v")}&code_challenge_method=S256`,
      ),
    );
    const handle = (await cRes.text()).match(/name="handle" value="([^"]+)"/)![1];
    const aRes = await app.fetch(
      new Request("https://brain.example.com/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: extractCookie(cRes) },
        body: new URLSearchParams({ handle, decision: "approve" }),
      }),
    );
    const ghState = new URL(aRes.headers.get("location")!).searchParams.get("state")!;
    const cbRes = await app.fetch(
      new Request(`https://brain.example.com/callback?code=gh_code&state=${encodeURIComponent(ghState)}`, {
        headers: { Cookie: extractCookie(aRes) },
      }),
    );
    expect(cbRes.status).toBe(403);
  });

  it("supports full note lifecycle, hybrid search, refresh token, and grant revocation", async () => {
    const { access_token, refresh_token, clientId } = await obtainToken();

    // Write & read
    const w = await mcpCall(access_token, "write_note", {
      path: "projects/docker.md",
      content: "# Docker Setup\n\nRunning our second brain on Coolify with Docker.",
    });
    expect(w[0]).toContain("Saved: projects/docker.md");

    await app.queue.drain();

    const read = await mcpCall(access_token, "read_note", { path: "projects/docker.md" });
    expect(read[0]).toContain("Coolify");
    expect(read[1]).toMatch(/^version: /);

    // Hybrid search (matches both keyword "Coolify" and semantic "docker/architecture")
    const search = await mcpCall(access_token, "search_notes", { query: "Coolify architecture" });
    expect(search[0]).toContain("projects/docker.md (both)");

    // Episodic memory tree via MCP tools (wake -> note -> nap -> zoom -> recall)
    const wakeEmpty = await mcpCall(access_token, "memory_wake", {});
    expect(wakeEmpty[0]).toContain("empty");

    const m0 = await mcpCall(access_token, "memory_note", { content: "Decided to host second brain on fender VPS" });
    expect(m0[0]).toContain("Recorded #0");

    const m1 = await mcpCall(access_token, "memory_note", { content: "Muse and Grok will share this memory tree" });
    expect(m1[0]).toContain("COMPRESSION DUE for #0-1");

    const nap01 = await mcpCall(access_token, "memory_nap", {
      range: "0-1",
      summary: "Hosting shared second brain on fender for Muse and Grok",
    });
    expect(nap01[0]).toContain("Saved summary #0-1");

    const recalled = await mcpCall(access_token, "memory_recall", { pattern: "fender" });
    expect(recalled[0]).toContain("#0 [");

    const zoomed = await mcpCall(access_token, "memory_zoom", { range: "0-1" });
    expect(zoomed[0]).toContain("#0 [");
    expect(zoomed[0]).toContain("#1 [");

    // Edit & move
    const edit = await mcpCall(access_token, "edit_note", {
      path: "projects/docker.md",
      old_text: "Coolify with Docker",
      new_text: "Coolify on fender VPS",
    });
    expect(edit[0]).toContain("Edited: projects/docker.md");

    const list = await mcpCall(access_token, "list_notes", {});
    expect(list[0]).toContain("projects/docker.md");

    // Refresh token rotation
    const refRes = await app.fetch(
      new Request("https://brain.example.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token, client_id: clientId }),
      }),
    );
    expect(refRes.status).toBe(200);
    const rotated = (await refRes.json()) as { access_token: string };
    expect(rotated.access_token).not.toBe(access_token);

    // Admin grants list + revoke
    const grantsRes = await app.fetch(
      new Request("https://brain.example.com/admin/grants", { headers: { Authorization: "Bearer super-secret-admin" } }),
    );
    expect(grantsRes.status).toBe(200);
    const grants = (await grantsRes.json()) as { id: string }[];
    expect(grants).toHaveLength(1);

    const revRes = await app.fetch(
      new Request(`https://brain.example.com/admin/grants/${grants[0].id}`, {
        method: "DELETE",
        headers: { Authorization: "Bearer super-secret-admin" },
      }),
    );
    expect(revRes.status).toBe(200);

    // Revoking an already-deleted/missing grant returns 404 (L5)
    const revMissing = await app.fetch(
      new Request(`https://brain.example.com/admin/grants/${grants[0].id}`, {
        method: "DELETE",
        headers: { Authorization: "Bearer super-secret-admin" },
      }),
    );
    expect(revMissing.status).toBe(404);

    // Revoked token is immediately rejected
    const afterRevoke = await app.fetch(
      new Request("https://brain.example.com/mcp", {
        method: "POST",
        headers: { Authorization: `Bearer ${rotated.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(afterRevoke.status).toBe(401);
  });

  it("hardens redirect prefix matching (L1) and CIMD private IP blocking (M1)", () => {
    expect(redirectAllowed("https://muse.app/cb", ["https://muse.app"])).toBe(true);
    expect(redirectAllowed("https://muse.app.evil.com/cb", ["https://muse.app"])).toBe(false);
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("169.254.169.254")).toBe(true);
    expect(isPrivateIp("10.0.0.5")).toBe(true);
    expect(isPrivateIp("192.168.1.1")).toBe(true);
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("1.1.1.1")).toBe(false);
  });
});
