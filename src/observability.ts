import type { Embedder } from "./indexer/types.js";
import type { MemorySummarizer } from "./memory/summarizer.js";
import type { SqliteAlerts } from "./storage/sqlite-adapters.js";

export type ServiceKind = "embedding" | "memory-summary";

export interface ServiceStats {
  okCount: number;
  errorCount: number;
  rateLimitCount: number;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  lastRateLimited: boolean;
}

const WEBHOOK_COOLDOWN_MS = 30 * 60 * 1000;

export function isRateLimitError(error: unknown): boolean {
  const s = String(error).toLowerCase();
  return s.includes("(429)") || s.includes(" 429") || s.includes("resource_exhausted") || s.includes("rate limit") || s.includes("quota");
}

function emptyStats(): ServiceStats {
  return {
    okCount: 0,
    errorCount: 0,
    rateLimitCount: 0,
    consecutiveFailures: 0,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastError: null,
    lastRateLimited: false,
  };
}

export class Observability {
  private readonly stats: Record<ServiceKind, ServiceStats> = {
    embedding: emptyStats(),
    "memory-summary": emptyStats(),
  };
  private readonly lastWebhookAt: Partial<Record<ServiceKind, number>> = {};

  constructor(
    private readonly alerts: SqliteAlerts,
    private readonly webhookUrl = "",
    private readonly serverName = "shiori",
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  recordSuccess(kind: ServiceKind) {
    const s = this.stats[kind];
    s.okCount += 1;
    const recovered = s.consecutiveFailures > 0;
    s.consecutiveFailures = 0;
    s.lastSuccessAt = new Date().toISOString();
    s.lastRateLimited = false;
    const resolved = this.alerts.resolveBySource(kind);
    if (recovered || resolved > 0) {
      console.log(JSON.stringify({ serviceRecovered: kind, resolvedAlerts: resolved }));
    }
  }

  recordFailure(kind: ServiceKind, error: unknown) {
    const s = this.stats[kind];
    const now = new Date().toISOString();
    const message = String(error).slice(0, 300);
    const rateLimited = isRateLimitError(error);

    s.errorCount += 1;
    if (rateLimited) s.rateLimitCount += 1;
    s.consecutiveFailures += 1;
    s.lastErrorAt = now;
    s.lastError = message;
    s.lastRateLimited = rateLimited;

    console.error(
      JSON.stringify({
        serviceError: kind,
        rateLimited,
        consecutiveFailures: s.consecutiveFailures,
        error: message,
      }),
    );

    // Record in SQLite on first failure or when escalating to rate-limit (avoids flooding alerts table on retries)
    if (s.consecutiveFailures === 1 || (rateLimited && s.rateLimitCount === 1)) {
      this.alerts.add(kind, JSON.stringify({ rateLimited, error: message }));
    }

    this.notifyWebhook(kind, rateLimited, message);
  }

  private notifyWebhook(kind: ServiceKind, rateLimited: boolean, message: string) {
    if (!this.webhookUrl) return;
    const now = Date.now();
    const last = this.lastWebhookAt[kind] ?? 0;
    if (now - last < WEBHOOK_COOLDOWN_MS) return;
    this.lastWebhookAt[kind] = now;

    const label = rateLimited ? "rate limit / quota exceeded" : "error";
    const text = `[${this.serverName}] ${kind} ${label}: ${message}`;
    void this.fetcher(this.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Compatible with Discord ("content"), Slack ("text"), and generic JSON receivers
      body: JSON.stringify({ content: text, text, service: kind, rateLimited, error: message, server: this.serverName }),
      signal: AbortSignal.timeout(8_000),
    }).catch((e) => {
      console.error(JSON.stringify({ alertWebhookFailed: String(e) }));
    });
  }

  getStats(kind: ServiceKind): ServiceStats {
    return { ...this.stats[kind] };
  }

  /** Concise warning block for memory_wake when background API issues exist. */
  wakeWarning(): string | null {
    const open = this.alerts.listOpen(10).filter((a) => a.source === "embedding" || a.source === "memory-summary");
    if (open.length === 0) return null;

    const seen = new Set<string>();
    const parts: string[] = [];
    for (const a of open) {
      if (seen.has(a.source)) continue;
      seen.add(a.source);
      let detail = a.body;
      let rateLimited = false;
      try {
        const parsed = JSON.parse(a.body) as { rateLimited?: boolean; error?: string };
        rateLimited = Boolean(parsed.rateLimited);
        detail = parsed.error ?? a.body;
      } catch {
        // plain text alert body
      }
      const tag = rateLimited ? "429 rate limit / quota" : "error";
      parts.push(`${a.source}: ${tag} (${detail.slice(0, 120)}) at ${a.created_at}`);
    }
    return `[Shiori Warning] Background API issue detected (${parts.join("; ")}). Mention this to the user so they can check /admin/status or API quota.`;
  }
}

export function observeEmbedder(inner: Embedder & { disabled?: boolean }, obs: Observability): Embedder & { disabled?: boolean } {
  if (inner.disabled) return inner;
  return {
    async embed(texts: string[]): Promise<number[][]> {
      if (!texts.length) return [];
      try {
        const res = await inner.embed(texts);
        obs.recordSuccess("embedding");
        return res;
      } catch (e) {
        obs.recordFailure("embedding", e);
        throw e;
      }
    },
  };
}

export function observeSummarizer(inner: MemorySummarizer, obs: Observability): MemorySummarizer {
  if (inner.disabled) return inner;
  return {
    async summarize(left: string, right: string): Promise<string> {
      try {
        const res = await inner.summarize(left, right);
        obs.recordSuccess("memory-summary");
        return res;
      } catch (e) {
        obs.recordFailure("memory-summary", e);
        throw e;
      }
    },
  };
}
