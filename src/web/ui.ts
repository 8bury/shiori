import type { DatabaseSync } from "node:sqlite";
import type { OAuthServer } from "../auth/oauth.js";
import { checkPath } from "../lib/notes.js";
import type { MemoryStore } from "../memory/tree.js";
import type { Fused } from "../search/hybrid.js";
import type { LocalGitNotesSource } from "../storage/git.js";
import { UI_HTML, LOGIN_HTML } from "./page.js";

export interface WebDeps {
  oauth: OAuthServer;
  db: DatabaseSync;
  memory: MemoryStore;
  notesSource: Pick<LocalGitNotesSource, "listNotes" | "readNote">;
  health: (hours: number) => unknown;
  searchNotes: (query: string, limit: number) => Promise<{ results: Fused[]; keywordFailed: boolean; semanticFailed: boolean } | null>;
}

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function html(body: string): Response {
  return new Response(body, {
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: SECURITY_HEADERS });
}

/** Read-only web viewer for memories and notes, behind the owner's GitHub sign-in. */
export async function handleWeb(request: Request, deps: WebDeps): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;

  if (pathname === "/ui/login" && request.method === "GET") return deps.oauth.webLogin();
  if (pathname === "/ui/logout" && request.method === "POST") return deps.oauth.webLogout(request);

  const user = deps.oauth.verifyWebSession(request);

  if (pathname === "/ui" || pathname === "/ui/") {
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    return html(user ? UI_HTML : LOGIN_HTML);
  }

  if (!pathname.startsWith("/ui/api/")) return new Response("Not found", { status: 404 });
  if (!user) return json({ error: "unauthorized" }, 401);
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);

  const endpoint = pathname.slice("/ui/api/".length);
  const q = url.searchParams;

  if (endpoint === "stats") {
    const memories = deps.memory.count();
    const summaries = Number((deps.db.prepare("SELECT COUNT(*) AS c FROM memory_tree").get() as { c: number }).c);
    const notes = (await deps.notesSource.listNotes("")).length;
    return json({ memories, summaries, notes });
  }

  if (endpoint === "health") {
    const hours = Math.min(Math.max(Number(q.get("hours")) || 24, 1), 24 * 90);
    return json(deps.health(hours));
  }

  if (endpoint === "memories") {
    const limit = Math.min(Math.max(Number(q.get("limit")) || 100, 1), 500);
    if (q.has("lo") || q.has("hi")) {
      const loRaw = q.get("lo") ?? "";
      const hiRaw = q.get("hi") ?? "";
      const lo = loRaw.trim() === "" ? NaN : Number(loRaw);
      const hi = hiRaw.trim() === "" ? NaN : Number(hiRaw);
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 0 || hi < lo) {
        return json({ error: "invalid range" }, 400);
      }
      const rows = deps.db
        .prepare("SELECT seq, content, source, created_at FROM memory_log WHERE seq >= ? AND seq <= ? ORDER BY seq ASC LIMIT ?")
        .all(lo, hi, limit);
      return json({ memories: rows });
    }
    const beforeRaw = q.has("before") ? Number(q.get("before")) : Number.MAX_SAFE_INTEGER;
    const before = Number.isFinite(beforeRaw) ? beforeRaw : Number.MAX_SAFE_INTEGER;
    const rows = deps.db
      .prepare("SELECT seq, content, source, created_at FROM memory_log WHERE seq < ? ORDER BY seq DESC LIMIT ?")
      .all(before, limit);
    return json({ memories: rows });
  }

  if (endpoint === "summaries") {
    const rows = deps.db.prepare("SELECT lo, hi, summary, created_at FROM memory_tree ORDER BY hi - lo DESC, lo ASC").all();
    return json({ summaries: rows });
  }

  if (endpoint === "notes") {
    return json({ notes: await deps.notesSource.listNotes("") });
  }

  if (endpoint === "note") {
    let p: string;
    try {
      p = checkPath(q.get("path") ?? "");
    } catch (e) {
      return json({ error: String(e instanceof Error ? e.message : e) }, 400);
    }
    const body = await deps.notesSource.readNote(p);
    if (body === null) return json({ error: "not found" }, 404);
    return json({ path: p, content: body });
  }

  if (endpoint === "search") {
    const query = (q.get("q") ?? "").trim();
    if (!query) return json({ memories: [], notes: [] });
    const [mem, notes] = await Promise.all([Promise.resolve(deps.memory.search(query, 30)), deps.searchNotes(query, 20)]);
    return json({
      memories: mem.lines,
      memoryError: mem.error ?? null,
      notes: notes?.results ?? [],
      notesError: notes ? null : "Note search is unavailable right now.",
    });
  }

  return json({ error: "not found" }, 404);
}
