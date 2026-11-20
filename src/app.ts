import crypto from "node:crypto";
import path from "node:path";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { OAuthServer } from "./auth/oauth.js";
import type { AppConfig } from "./config.js";
import type { Embedder } from "./indexer/types.js";
import { checkPath, pathHash } from "./lib/notes.js";
import { MemoryCompactor } from "./memory/compactor.js";
import { buildMemoryInstructions } from "./memory/prompt.js";
import { createSummarizer, type MemorySummarizer } from "./memory/summarizer.js";
import { MemoryStore } from "./memory/tree.js";
import { isRateLimitError, Observability, observeEmbedder, observeSummarizer } from "./observability.js";
import { Metrics } from "./metrics.js";
import { IndexQueue } from "./queue.js";
import { runReconcile } from "./reconcile/reconcile.js";
import type { Mode, Report } from "./reconcile/types.js";
import { buildFtsQuery, fuse, semanticHits, type Hit } from "./search/hybrid.js";
import { openDatabase } from "./storage/db.js";
import { createEmbedder } from "./storage/embedder.js";
import { createReconcileSource, ensureGitRepo, LocalGitNotesSource, LocalGitWorkingCopy, redactCredentials } from "./storage/git.js";
import { SqliteAlerts, SqliteKeywords, SqliteManifest, SqliteReconcileIndex, SqliteVectorIndex } from "./storage/sqlite-adapters.js";
import type { Operation, WriteResult } from "./writer/types.js";
import { noteVersion } from "./writer/version.js";
import { Writer } from "./writer/writer.js";
import { handleWeb } from "./web/ui.js";

const SEMANTIC_FLOOR = 0.3;

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const opPaths = (op: Operation) => (op.kind === "move" ? [op.from, op.to] : [op.path]);

function hasBearer(request: Request, secret: string): boolean {
  if (!secret) return false;
  const given = crypto.createHash("sha256").update(request.headers.get("authorization") ?? "").digest();
  const expected = crypto.createHash("sha256").update(`Bearer ${secret}`).digest();
  return crypto.timingSafeEqual(given, expected);
}

export interface CreateAppOptions {
  embedder?: Embedder & { disabled?: boolean };
  summarizer?: MemorySummarizer;
  fetcher?: typeof fetch;
  queueDelayMultiplier?: number;
}

export async function createApp(config: AppConfig, options: CreateAppOptions = {}) {
  await ensureGitRepo(config.notesDir, config.gitAuthorName, config.gitAuthorEmail, config.gitRemoteUrl);

  const db = openDatabase(config.dbPath);
  const workingCopy = new LocalGitWorkingCopy(config.notesDir, config.gitAuthorName, config.gitAuthorEmail, config.gitRemoteUrl);
  const writer = new Writer(workingCopy);
  const notesSource = new LocalGitNotesSource(config.notesDir);
  const manifest = new SqliteManifest(db);
  const keywords = new SqliteKeywords(db);
  const vectors = new SqliteVectorIndex(db);
  const alerts = new SqliteAlerts(db);
  const metrics = new Metrics(db);
  const observability = new Observability(alerts, config.alertWebhookUrl, config.serverName, options.fetcher, metrics);
  const embedder = observeEmbedder(options.embedder ?? createEmbedder(config), observability);
  const summarizer = observeSummarizer(options.summarizer ?? createSummarizer(config, options.fetcher), observability);
  const autoCompact = !summarizer.disabled;
  const memory = new MemoryStore(db, config.memoryWakeLines, path.join(config.dataDir, "memory.log"), autoCompact);
  const compactor = new MemoryCompactor(memory, summarizer, alerts, options.queueDelayMultiplier ?? 1000);
  if (autoCompact) compactor.trigger();

  const queue: IndexQueue = new IndexQueue(
    () => ({
      notes: notesSource,
      index: vectors,
      embedder,
      manifest,
      keywords,
      enqueue: (msgs, delay): Promise<void> => queue.enqueue(msgs, delay),
      repoName: config.serverName,
    }),
    alerts,
    options.queueDelayMultiplier ?? 1000,
  );

  const oauth = new OAuthServer(db, config, options.fetcher);

  async function runOp(op: Operation): Promise<WriteResult> {
    try {
      return await writer.run(op);
    } catch (e) {
      return { status: "unknown", reason: redactCredentials(String(e)) };
    }
  }

  async function describe(r: WriteResult, op: Operation, done: string): Promise<string> {
    switch (r.status) {
      case "failed":
        return redactCredentials(r.reason);
      case "busy":
        return "The notes are changing too fast right now; nothing was saved. Try again.";
      case "unknown":
        await queue.enqueue(opPaths(op).map((p) => ({ type: "index", path: p, reason: "write" }))).catch(() => {});
        return `Not sure the change to ${opPaths(op).join(" and ")} was saved (${redactCredentials(r.reason)}). Check it with read_note before retrying.`;
    }
    const saved = `${done} (${r.commit.slice(0, 7)}). Search reflects it shortly.`;
    try {
      await queue.enqueue(r.paths.map((p) => ({ type: "index", path: p, reason: "write" })));
      return saved;
    } catch (e) {
      return `${saved} Search will catch up later (enqueue failed: ${String(e)}).`;
    }
  }

  async function write(op: Operation, done: string): Promise<string> {
    return describe(await runOp(op), op, done);
  }

  const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
  const APPEND_ONLY = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
  const MUTATING = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
  const IDEMPOTENT_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
  const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;

  async function searchNotesRaw(query: string, limit: number) {
    const fts = buildFtsQuery(query);
    const [keyword, semantic] = await Promise.all([
      Promise.resolve()
        .then<Hit[]>(() => (fts ? keywords.search(fts, 50) : []))
        .catch((e) => (console.error(JSON.stringify({ keywordSearchFailed: String(e) })), null)),
      (async () => {
        if (embedder.disabled) return [] as Hit[];
        const [q] = await embedder.embed([query]);
        const matches = vectors.query(q, 50);
        return semanticHits(matches, SEMANTIC_FLOOR);
      })().catch((e) => (console.error(JSON.stringify({ semanticSearchFailed: String(e) })), null)),
    ]);
    if (keyword === null && semantic === null) return null;
    return { results: fuse(keyword ?? [], semantic ?? [], limit), keywordFailed: keyword === null, semanticFailed: semantic === null };
  }

  async function searchNotes(query: string, limit: number): Promise<string> {
    const raw = await searchNotesRaw(query, limit);
    if (!raw) return "Note search is unavailable right now. Try again in a moment.";
    const { results } = raw;
    const semantic = raw.semanticFailed ? null : [];
    const keyword = raw.keywordFailed ? null : [];
    const lines = results.map((r) => `${r.path} (${r.matched})\n${r.text.slice(0, 400)}`);
    const note =
      semantic === null
        ? "\n\n(semantic search unavailable right now: keyword results only)"
        : keyword === null
          ? "\n\n(keyword search unavailable right now: semantic results only)"
          : "";
    return (lines.join("\n\n---\n\n") || "No notes found.") + note;
  }

  function clientLabel(clientId: string): string {
    if (!clientId) return "unknown";
    const row = db.prepare("SELECT client_name FROM oauth_clients WHERE client_id = ?").get(clientId) as { client_name: string } | undefined;
    if (row) return row.client_name;
    try {
      return new URL(clientId).hostname;
    } catch {
      return clientId.slice(0, 40);
    }
  }

  // Wraps every tool handler so each call is timed and counted (per tool and per client) in Metrics.
  function instrumentTools(server: McpServer) {
    type Handler = (...args: unknown[]) => Promise<{ isError?: boolean; content?: { text?: string }[] }>;
    const register = server.registerTool.bind(server) as unknown as (name: string, cfg: unknown, cb: Handler) => unknown;
    (server as unknown as { registerTool: typeof register }).registerTool = (name, cfg, cb) =>
      register(name, cfg, async (...args) => {
        const extra = args[args.length - 1] as { http?: { authInfo?: { clientId?: string } } } | undefined;
        const client = clientLabel(extra?.http?.authInfo?.clientId ?? "");
        const t0 = performance.now();
        try {
          const res = await cb(...args);
          const ok = !res?.isError;
          const error = ok ? undefined : (res.content?.[0]?.text ?? "tool returned an error");
          const ev = { ok, ms: performance.now() - t0, error, rateLimited: !ok && isRateLimitError(error) };
          metrics.record({ kind: "tool", name, ...ev });
          metrics.record({ kind: "client", name: client, ...ev, error: ok ? undefined : `${name}: ${error}` });
          return res;
        } catch (e) {
          const ev = { ok: false, ms: performance.now() - t0, rateLimited: isRateLimitError(e) };
          metrics.record({ kind: "tool", name, ...ev, error: String(e) });
          metrics.record({ kind: "client", name: client, ...ev, error: `${name}: ${String(e)}` });
          throw e;
        }
      });
  }

  function createServer() {
    const server = new McpServer(
      { name: config.serverName, version: "0.5.0" },
      { instructions: buildMemoryInstructions(autoCompact) },
    );
    instrumentTools(server);

    // ---------- Episodic Memory Tree ----------

    server.registerTool(
      "memory_wake",
      {
        description:
          "Reads your shared episodic memory timeline (recent memories verbatim, older ones exponentially summarized). Call this first at the start of every session.",
        inputSchema: { lines: z.number().int().min(8).max(500).optional() },
        annotations: READ_ONLY,
      },
      async ({ lines }) => {
        const woke = memory.wake(lines);
        const warn = observability.wakeWarning();
        return text(warn ? `${woke}\n\n${warn}` : woke);
      },
    );

    server.registerTool(
      "memory_note",
      {
        description: autoCompact
          ? "Records one short episodic memory (1 line, max 280 bytes): a fact, preference, decision, or event worth remembering across sessions and agents."
          : "Records one short episodic memory (1 line, max 280 bytes): a fact, preference, decision, or event worth remembering across sessions and agents. If a compression is due, follow up with memory_nap.",
        inputSchema: { content: z.string() },
        annotations: APPEND_ONLY,
      },
      async ({ content }, extra) => {
        const res = memory.note(content, extra.http?.authInfo?.clientId ?? "");
        if (autoCompact) compactor.trigger();
        return text(res);
      },
    );

    if (!autoCompact) {
      server.registerTool(
        "memory_nap",
        {
          description:
            "Saves a 1-line summary (max 280 bytes) for a pending binary-tree range (e.g. range='0-1'). Call with no arguments to check if any compression is due.",
          inputSchema: { range: z.string().optional(), summary: z.string().optional() },
          annotations: IDEMPOTENT_WRITE,
        },
        async ({ range, summary }) => text(memory.nap(range, summary)),
      );
    }

    server.registerTool(
      "memory_zoom",
      {
        description: "Opens a summarized memory tree node (e.g. '0-3') into its two halves, down to the raw memories.",
        inputSchema: { range: z.string() },
        annotations: READ_ONLY,
      },
      async ({ range }) => text(memory.zoom(range)),
    );

    // ---------- Unified Search ----------

    server.registerTool(
      "search",
      {
        description:
          "Searches across both episodic memories (FTS5 keyword + substring fallback) and long-form notes (hybrid keyword + semantic), returning separate sections without mixing rankings. Pass scope='memory' or scope='notes' to search only one layer; regex=true applies to raw memories.",
        inputSchema: {
          query: z.string(),
          scope: z.enum(["all", "notes", "memory"]).optional(),
          limit: z.number().int().min(1).max(50).optional(),
          regex: z.boolean().optional(),
        },
        annotations: READ_ONLY,
      },
      async ({ query, scope, limit, regex }) => {
        const target = scope ?? "all";
        const useRegex = regex ?? false;
        if (target === "memory") {
          const res = memory.search(query, limit ?? 20, useRegex);
          if (res.error) return text(res.error);
          return text(res.lines.length ? res.lines.join("\n") : `No memories matching "${query.trim()}".`);
        }
        if (target === "notes") {
          return text(await searchNotes(query, Math.min(limit ?? 10, 20)));
        }
        const [memRes, notesText] = await Promise.all([
          Promise.resolve(memory.search(query, limit ?? 15, useRegex)),
          searchNotes(query, Math.min(limit ?? 10, 20)),
        ]);
        const memText = memRes.error
          ? memRes.error
          : memRes.lines.length
            ? memRes.lines.join("\n")
            : "No memories found.";
        return text(`## Memories\n\n${memText}\n\n## Notes\n\n${notesText}`);
      },
    );

    // ---------- Long-form Notes ----------

    server.registerTool(
      "list_notes",
      {
        description: `Lists the notes in Shiori (Markdown file paths, e.g. ${config.ideasDir}/..., projects/..., decisions/...).`,
        inputSchema: { prefix: z.string().optional() },
        annotations: READ_ONLY,
      },
      async ({ prefix }) => text((await notesSource.listNotes(prefix ?? "")).join("\n") || "No notes."),
    );

    server.registerTool(
      "read_note",
      {
        description: "Reads a whole note by path (e.g. overview.md, projects/roadmap.md). Also returns its version, which write_note needs to overwrite it.",
        inputSchema: { path: z.string() },
        annotations: READ_ONLY,
      },
      async ({ path: rawPath }) => {
        const p = checkPath(rawPath);
        const body = await notesSource.readNote(p);
        if (body === null) return text(`Note not found: ${p}`);
        return {
          content: [
            { type: "text" as const, text: body },
            { type: "text" as const, text: `version: ${await noteVersion(body)}` },
          ],
        };
      },
    );

    server.registerTool(
      "write_note",
      {
        description:
          "Creates a note, or overwrites a whole one (e.g. projects/roadmap.md). To overwrite, pass expected_version: the version read_note returned. If the note changed since, nothing is saved and you get a conflict: read it again and redo the change. To change only part of a note, prefer edit_note.",
        inputSchema: { path: z.string(), content: z.string(), expected_version: z.string().optional() },
        annotations: DESTRUCTIVE,
      },
      async ({ path: rawPath, content, expected_version }) => {
        const p = checkPath(rawPath);
        return text(await write({ kind: "write", path: p, content, ...(expected_version ? { expectedVersion: expected_version } : {}) }, `Saved: ${p}`));
      },
    );

    server.registerTool(
      "edit_note",
      {
        description:
          "Replaces an exact passage of a note with another (old_text must appear exactly once). An empty new_text deletes the passage. Use read_note first to copy the exact passage.",
        inputSchema: { path: z.string(), old_text: z.string(), new_text: z.string() },
        annotations: MUTATING,
      },
      async ({ path: rawPath, old_text, new_text }) => {
        const p = checkPath(rawPath);
        return text(await write({ kind: "edit", path: p, oldText: old_text, newText: new_text }, `Edited: ${p}`));
      },
    );

    server.registerTool(
      "delete_note",
      {
        description: "Deletes a note (it stays recoverable in the Git history).",
        inputSchema: { path: z.string() },
        annotations: DESTRUCTIVE,
      },
      async ({ path: rawPath }) => {
        const p = checkPath(rawPath);
        return text(await write({ kind: "delete", path: p }, `Deleted: ${p}`));
      },
    );

    server.registerTool(
      "move_note",
      {
        description: `Moves or renames a note in one commit (e.g. ${config.ideasDir}/x.md to projects/x.md).`,
        inputSchema: { from: z.string(), to: z.string() },
        annotations: MUTATING,
      },
      async ({ from, to }) => {
        const a = checkPath(from);
        const b = checkPath(to);
        return text(await write({ kind: "move", from: a, to: b }, `Moved: ${a} -> ${b}`));
      },
    );

    return server;
  }

  const mcp = createMcpHandler(createServer, {
    legacy: "stateless",
    onerror: (err) => console.error(JSON.stringify({ mcpError: String(err) })),
  });

  async function reconcile(mode: Mode): Promise<Report> {
    const step = { do: async <T>(_name: string, fn: () => Promise<T>) => fn() };
    return runReconcile(mode, step, {
      source: createReconcileSource(notesSource),
      index: new SqliteReconcileIndex(db),
      enqueue: (msgs) => queue.enqueue(msgs),
      pathHash,
      alert: async (body) => alerts.add("reconcile", body),
      resolveDlqAlerts: async () => alerts.resolveDlq(),
    });
  }

  async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/health" && request.method === "GET") {
      const openAlerts = alerts.countOpen();
      const pendingCompactions = memory.countPendingMerges();
      return Response.json({
        ok: true,
        degraded: openAlerts > 0,
        openAlerts,
        pendingCompactions,
        embeddingProvider: config.embeddingProvider,
        memorySummaryProvider: config.memorySummaryProvider,
        autoCompact,
      });
    }

    if (pathname === "/.well-known/oauth-protected-resource" || pathname === "/.well-known/oauth-protected-resource/mcp") {
      return oauth.protectedResourceMetadata();
    }
    if (pathname === "/.well-known/oauth-authorization-server") {
      return oauth.authorizationServerMetadata();
    }
    if (pathname === "/register") {
      return oauth.register(request);
    }
    if (pathname === "/authorize") {
      return oauth.authorize(request);
    }
    if (pathname === "/callback") {
      return oauth.callback(request);
    }
    if (pathname === "/token") {
      return oauth.token(request);
    }

    if (pathname === "/ui" || pathname.startsWith("/ui/")) {
      return handleWeb(request, {
        oauth,
        db,
        memory,
        notesSource,
        searchNotes: searchNotesRaw,
        health: (hours) => ({
          ...metrics.summary(hours),
          services: {
            embedding: { provider: config.embeddingProvider, model: config.embeddingModel, disabled: Boolean(embedder.disabled), ...observability.getStats("embedding") },
            memorySummary: {
              provider: config.memorySummaryProvider,
              model: config.memorySummaryModel,
              autoCompact,
              pendingCompactions: memory.countPendingMerges(),
              ...observability.getStats("memory-summary"),
            },
          },
          queue: { deadLetters: alerts.listOpen(50).filter((a) => a.source === "dlq").length },
          openAlerts: alerts.listOpen(50),
        }),
      });
    }

    if (pathname === "/mcp") {
      const verified = oauth.verifyBearer(request);
      if (!verified) {
        metrics.record({ kind: "http", name: "mcp_unauthorized", ok: true });
        return oauth.unauthorizedResponse();
      }
      console.log(JSON.stringify({ mcp: request.method, clientId: verified.clientId, userId: verified.userId }));
      return mcp.fetch(request, {
        authInfo: {
          token: verified.token,
          clientId: verified.clientId,
          scopes: verified.scopes,
          expiresAt: verified.expiresAt,
        },
      });
    }

    if (pathname === "/admin/grants" || pathname.startsWith("/admin/grants/")) {
      if (!hasBearer(request, config.adminSecret)) return new Response("Not found", { status: 404 });
      let id = "";
      try {
        id = pathname === "/admin/grants" ? "" : decodeURIComponent(pathname.slice("/admin/grants/".length));
      } catch {
        return new Response("Bad grant id", { status: 400 });
      }
      if (request.method === "GET" && !id) {
        return Response.json(oauth.listGrants(config.ownerGithubId), { headers: { "Cache-Control": "no-store" } });
      }
      if (request.method === "DELETE" && id) {
        const revoked = oauth.revokeGrant(id, config.ownerGithubId);
        if (!revoked) return new Response("Grant not found", { status: 404 });
        return Response.json({ revoked: id });
      }
      return new Response("Method not allowed", { status: 405 });
    }

    if (pathname === "/admin/reconcile" && request.method === "POST") {
      if (!hasBearer(request, config.adminSecret)) return new Response("Not found", { status: 404 });
      const mode: Mode = url.searchParams.get("mode") === "rebuild" ? "rebuild" : "daily";
      const report = await reconcile(mode);
      return Response.json(report, { status: 202 });
    }

    if (pathname === "/admin/memory/forget" && request.method === "POST") {
      if (!hasBearer(request, config.adminSecret)) return new Response("Not found", { status: 404 });
      let range = url.searchParams.get("range") ?? "";
      if (!range) {
        try {
          const body = (await request.json()) as { range?: unknown };
          if (typeof body?.range === "string") range = body.range;
        } catch {
          // ignore invalid/empty JSON body
        }
      }
      if (!range.trim()) return Response.json({ error: "Missing range" }, { status: 400 });
      const message = memory.forget(range);
      if (autoCompact) compactor.trigger();
      return Response.json({ message });
    }

    if (pathname === "/admin/status" && request.method === "GET") {
      if (!hasBearer(request, config.adminSecret)) return new Response("Not found", { status: 404 });
      const openAlerts = alerts.listOpen(50);
      return Response.json(
        {
          ok: openAlerts.length === 0,
          degraded: openAlerts.length > 0,
          embedding: {
            provider: config.embeddingProvider,
            model: config.embeddingModel,
            disabled: Boolean(embedder.disabled),
            stats: observability.getStats("embedding"),
          },
          memorySummary: {
            provider: config.memorySummaryProvider,
            model: config.memorySummaryModel,
            autoCompact,
            pendingCompactions: memory.countPendingMerges(),
            totalMemories: memory.count(),
            stats: observability.getStats("memory-summary"),
          },
          openAlerts,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    if (pathname === "/admin/alerts/resolve" && request.method === "POST") {
      if (!hasBearer(request, config.adminSecret)) return new Response("Not found", { status: 404 });
      const idParam = url.searchParams.get("id");
      const sourceParam = url.searchParams.get("source");
      let resolved = 0;
      if (idParam && /^\d+$/.test(idParam)) {
        resolved = alerts.resolveById(Number(idParam));
      } else if (
        sourceParam === "dlq" ||
        sourceParam === "reconcile" ||
        sourceParam === "embedding" ||
        sourceParam === "memory-summary"
      ) {
        resolved = alerts.resolveBySource(sourceParam);
      } else {
        resolved = alerts.resolveAll();
      }
      return Response.json({ resolved });
    }

    return new Response("Not found", { status: 404 });
  }

  async function close() {
    compactor.close();
    queue.close();
    await Promise.all([compactor.drain(), queue.drain()]);
    await mcp.close();
    db.close();
  }

  return {
    fetch,
    reconcile,
    purgeExpired: () => oauth.purgeExpired(),
    queue,
    compactor,
    oauth,
    db,
    close,
  };
}
