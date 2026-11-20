import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { isPrivateIp, redirectAllowed } from "../src/auth/oauth";
import { loadConfig } from "../src/config";
import type { Embedder } from "../src/indexer/types";
import type { MemorySummarizer } from "../src/memory/summarizer";

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

class ToySummarizer implements MemorySummarizer {
  calls: { left: string; right: string }[] = [];
  async summarize(left: string, right: string): Promise<string> {
    this.calls.push({ left, right });
    return `Summary(${left.slice(0, 40)} + ${right.slice(0, 40)})`;
  }
}

describe("end-to-end Node app (OAuth 2.1 + MCP + SQLite + Git)", () => {
  let tmpDir: string;
  let app: Awaited<ReturnType<typeof createApp>>;
  let summarizer: ToySummarizer;
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shiori-test-"));
    const config = loadConfig({
      DATA_DIR: tmpDir,
      PUBLIC_URL: "https://shiori.example.com",
      GITHUB_CLIENT_ID: "gh-client",
      GITHUB_CLIENT_SECRET: "gh-secret",
      OWNER_GITHUB_ID: "42",
      ADMIN_SECRET: "super-secret-admin",
      ALLOWED_REDIRECT_PREFIXES: "https://muse.meta.com/oauth/callback",
    });
    summarizer = new ToySummarizer();
    app = await createApp(config, {
      embedder: new ToyEmbedder(),
      summarizer,
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
      new Request("https://shiori.example.com/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "Test Client", redirect_uris: [redirectUri] }),
      }),
    );
    expect(reg.status).toBe(201);
    const { client_id } = (await reg.json()) as { client_id: string };

    // 2. GET /authorize -> consent page
    const verifier = "my-super-secret-pkce-verifier-string-1234567890";
    const authUrl = new URL("https://shiori.example.com/authorize");
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
      new Request("https://shiori.example.com/authorize", {
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
      new Request(`https://shiori.example.com/callback?code=gh_code&state=${encodeURIComponent(ghState)}`, {
        headers: { Cookie: ghCookie },
      }),
    );
    expect(cbRes.status).toBe(302);
    const clientRedirect = new URL(cbRes.headers.get("location")!);
    expect(clientRedirect.searchParams.get("state")).toBe("xyz");
    const code = clientRedirect.searchParams.get("code")!;

    // 5. POST /token -> access + refresh tokens
    const tokRes = await app.fetch(
      new Request("https://shiori.example.com/token", {
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

  async function mcpRequest(token: string, method: string, params: Record<string, unknown> = {}) {
    const res = await app.fetch(
      new Request("https://shiori.example.com/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
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
    return JSON.parse(jsonText) as { result: unknown };
  }

  async function mcpCall(token: string, name: string, args: Record<string, unknown> = {}) {
    const body = (await mcpRequest(token, "tools/call", { name, arguments: args })) as {
      result: { content: { text: string }[] };
    };
    return body.result.content.map((c) => c.text);
  }

  it("exposes health and OAuth discovery metadata, and blocks unauthenticated /mcp", async () => {
    const health = await app.fetch(new Request("https://shiori.example.com/health"));
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });

    const prm = await app.fetch(new Request("https://shiori.example.com/.well-known/oauth-protected-resource"));
    expect(prm.status).toBe(200);
    expect(await prm.json()).toMatchObject({ resource: "https://shiori.example.com/mcp", authorization_servers: ["https://shiori.example.com"] });

    const unauth = await app.fetch(new Request("https://shiori.example.com/mcp", { method: "POST" }));
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("enforces redirect allowlist (including custom ALLOWED_REDIRECT_PREFIXES) and owner GitHub ID", async () => {
    // Disallowed redirect gets 403
    const regBad = await app.fetch(
      new Request("https://shiori.example.com/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "Evil", redirect_uris: ["https://evil.example.com/cb"] }),
      }),
    );
    const { client_id: evilId } = (await regBad.json()) as { client_id: string };
    const badAuth = await app.fetch(
      new Request(
        `https://shiori.example.com/authorize?client_id=${evilId}&redirect_uri=https://evil.example.com/cb&response_type=code&code_challenge=abc&code_challenge_method=S256`,
      ),
    );
    expect(badAuth.status).toBe(403);

    // Custom ALLOWED_REDIRECT_PREFIXES (Muse) is allowed
    const { access_token } = await obtainToken("https://muse.meta.com/oauth/callback");
    expect(access_token).toBeTruthy();

    // Wrong GitHub owner is rejected at /callback
    githubUserId = 999;
    const reg = await app.fetch(
      new Request("https://shiori.example.com/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "Other", redirect_uris: ["http://127.0.0.1:9999/cb"] }),
      }),
    );
    const { client_id } = (await reg.json()) as { client_id: string };
    const cRes = await app.fetch(
      new Request(
        `https://shiori.example.com/authorize?client_id=${client_id}&redirect_uri=http://127.0.0.1:9999/cb&response_type=code&code_challenge=${s256("v")}&code_challenge_method=S256`,
      ),
    );
    const handle = (await cRes.text()).match(/name="handle" value="([^"]+)"/)![1];
    const aRes = await app.fetch(
      new Request("https://shiori.example.com/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: extractCookie(cRes) },
        body: new URLSearchParams({ handle, decision: "approve" }),
      }),
    );
    const ghState = new URL(aRes.headers.get("location")!).searchParams.get("state")!;
    const cbRes = await app.fetch(
      new Request(`https://shiori.example.com/callback?code=gh_code&state=${encodeURIComponent(ghState)}`, {
        headers: { Cookie: extractCookie(aRes) },
      }),
    );
    expect(cbRes.status).toBe(403);
  });

  it("supports full note lifecycle, hybrid search, refresh token, and grant revocation", async () => {
    const { access_token, refresh_token, clientId } = await obtainToken();

    // Verify consolidated 10-tool surface + MCP annotations
    const toolsRes = (await mcpRequest(access_token, "tools/list")) as {
      result: { tools: { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }[] };
    };
    const toolMap = new Map(toolsRes.result.tools.map((t) => [t.name, t]));
    expect([...toolMap.keys()].sort()).toEqual([
      "delete_note",
      "edit_note",
      "list_notes",
      "memory_note",
      "memory_wake",
      "memory_zoom",
      "move_note",
      "read_note",
      "search",
      "write_note",
    ]);
    expect(toolMap.get("search")?.annotations?.readOnlyHint).toBe(true);
    expect(toolMap.get("memory_wake")?.annotations?.readOnlyHint).toBe(true);
    expect(toolMap.get("delete_note")?.annotations?.destructiveHint).toBe(true);
    expect(toolMap.get("write_note")?.annotations?.destructiveHint).toBe(true);
    expect(toolMap.get("move_note")?.annotations?.destructiveHint).toBe(false);

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

    // Episodic memory tree via MCP tools (auto-compacted in background)
    const wakeEmpty = await mcpCall(access_token, "memory_wake", {});
    expect(wakeEmpty[0]).toContain("empty");

    const m0 = await mcpCall(access_token, "memory_note", { content: "Decided to host second brain on fender VPS" });
    expect(m0[0]).toContain("Recorded #0");
    expect(m0[0]).not.toContain("COMPRESSION DUE");

    const m1 = await mcpCall(access_token, "memory_note", { content: "Muse and Grok will share this memory tree" });
    expect(m1[0]).toContain("Recorded #1");
    expect(m1[0]).not.toContain("COMPRESSION DUE");

    await app.compactor.drain();
    expect(summarizer.calls).toHaveLength(1);

    const zoomed = await mcpCall(access_token, "memory_zoom", { range: "0-1" });
    expect(zoomed[0]).toContain("#0 [");
    expect(zoomed[0]).toContain("#1 [");

    // Unified search returns separate Memories and Notes sections
    const searchAll = await mcpCall(access_token, "search", { query: "second brain Coolify fender" });
    expect(searchAll[0]).toContain("## Memories");
    expect(searchAll[0]).toContain("#0 [");
    expect(searchAll[0]).toContain("## Notes");
    expect(searchAll[0]).toContain("projects/docker.md");

    // Scoped search: notes hybrid (matches keyword "Coolify" and semantic "docker/architecture")
    const searchNotes = await mcpCall(access_token, "search", { query: "Coolify architecture", scope: "notes" });
    expect(searchNotes[0]).toContain("projects/docker.md (both)");

    // Scoped search: memory regex
    const searchMemRegex = await mcpCall(access_token, "search", { query: "muse.*grok", scope: "memory", regex: true });
    expect(searchMemRegex[0]).toContain("#1 [");

    // Admin memory forget drops summary and triggers background rebuild
    const forgetRes = await app.fetch(
      new Request("https://shiori.example.com/admin/memory/forget", {
        method: "POST",
        headers: { Authorization: "Bearer super-secret-admin", "Content-Type": "application/json" },
        body: JSON.stringify({ range: "0-1" }),
      }),
    );
    expect(forgetRes.status).toBe(200);
    expect(((await forgetRes.json()) as { message: string }).message).toContain("Dropped 1 summary node");
    await app.compactor.drain();
    expect(summarizer.calls).toHaveLength(2);

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
      new Request("https://shiori.example.com/token", {
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
      new Request("https://shiori.example.com/admin/grants", { headers: { Authorization: "Bearer super-secret-admin" } }),
    );
    expect(grantsRes.status).toBe(200);
    const grants = (await grantsRes.json()) as { id: string }[];
    expect(grants).toHaveLength(1);

    const revRes = await app.fetch(
      new Request(`https://shiori.example.com/admin/grants/${grants[0].id}`, {
        method: "DELETE",
        headers: { Authorization: "Bearer super-secret-admin" },
      }),
    );
    expect(revRes.status).toBe(200);

    // Revoking an already-deleted/missing grant returns 404 (L5)
    const revMissing = await app.fetch(
      new Request(`https://shiori.example.com/admin/grants/${grants[0].id}`, {
        method: "DELETE",
        headers: { Authorization: "Bearer super-secret-admin" },
      }),
    );
    expect(revMissing.status).toBe(404);

    // Revoked token is immediately rejected
    const afterRevoke = await app.fetch(
      new Request("https://shiori.example.com/mcp", {
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

  it("registers memory_nap fallback when no summary LLM is configured", async () => {
    const fallbackDir = fs.mkdtempSync(path.join(os.tmpdir(), "shiori-fallback-"));
    const fallbackApp = await createApp(
      loadConfig({
        DATA_DIR: fallbackDir,
        PUBLIC_URL: "https://shiori.example.com",
        GITHUB_CLIENT_ID: "gh-client",
        GITHUB_CLIENT_SECRET: "gh-secret",
        OWNER_GITHUB_ID: "42",
        ADMIN_SECRET: "secret",
        EMBEDDING_PROVIDER: "none",
        MEMORY_SUMMARY_PROVIDER: "none",
      }),
      { fetcher: mockFetcher, queueDelayMultiplier: 1 },
    );
    try {
      const health = await (await fallbackApp.fetch(new Request("https://shiori.example.com/health"))).json();
      expect(health).toMatchObject({ ok: true, autoCompact: false, memorySummaryProvider: "none" });

      const reg = await fallbackApp.fetch(
        new Request("https://shiori.example.com/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_name: "Fallback", redirect_uris: ["http://127.0.0.1:4321/cb"] }),
        }),
      );
      const { client_id } = (await reg.json()) as { client_id: string };
      const verifier = "fallback-pkce-verifier-string-1234567890";
      const cRes = await fallbackApp.fetch(
        new Request(
          `https://shiori.example.com/authorize?client_id=${client_id}&redirect_uri=http://127.0.0.1:4321/cb&response_type=code&code_challenge=${s256(verifier)}&code_challenge_method=S256`,
        ),
      );
      const handle = (await cRes.text()).match(/name="handle" value="([^"]+)"/)![1];
      const aRes = await fallbackApp.fetch(
        new Request("https://shiori.example.com/authorize", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: extractCookie(cRes) },
          body: new URLSearchParams({ handle, decision: "approve" }),
        }),
      );
      const ghState = new URL(aRes.headers.get("location")!).searchParams.get("state")!;
      const cbRes = await fallbackApp.fetch(
        new Request(`https://shiori.example.com/callback?code=gh_code&state=${encodeURIComponent(ghState)}`, {
          headers: { Cookie: extractCookie(aRes) },
        }),
      );
      const code = new URL(cbRes.headers.get("location")!).searchParams.get("code")!;
      const tokRes = await fallbackApp.fetch(
        new Request("https://shiori.example.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_id,
            redirect_uri: "http://127.0.0.1:4321/cb",
            code_verifier: verifier,
          }),
        }),
      );
      const { access_token } = (await tokRes.json()) as { access_token: string };

      const listRes = await fallbackApp.fetch(
        new Request("https://shiori.example.com/mcp", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${access_token}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        }),
      );
      const text = await listRes.text();
      expect(text).toContain('"memory_nap"');
    } finally {
      await fallbackApp.close();
      fs.rmSync(fallbackDir, { recursive: true, force: true });
    }
  });
});
