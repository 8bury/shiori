import type { DatabaseSync } from "node:sqlite";

/** What a metric row counts: MCP tool calls, calls per MCP client, background API services, or HTTP events. */
export type MetricKind = "tool" | "client" | "service" | "http";

const ERROR_RETENTION_DAYS = 30;
const HOURLY_RETENTION_DAYS = 90;
const MAX_ERROR_ROWS = 1000;

export interface MetricEvent {
  kind: MetricKind;
  name: string;
  ok: boolean;
  ms?: number;
  rateLimited?: boolean;
  error?: string;
}

function hourBucket(d = new Date()): string {
  return `${d.toISOString().slice(0, 13)}:00:00Z`;
}

export function ensureMetricsSchema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS metrics_hourly (
      hour         TEXT NOT NULL,
      kind         TEXT NOT NULL,
      name         TEXT NOT NULL,
      ok           INTEGER NOT NULL DEFAULT 0,
      err          INTEGER NOT NULL DEFAULT 0,
      rate_limited INTEGER NOT NULL DEFAULT 0,
      total_ms     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (hour, kind, name)
    );
    CREATE TABLE IF NOT EXISTS metrics_errors (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      at           TEXT NOT NULL,
      kind         TEXT NOT NULL,
      name         TEXT NOT NULL,
      rate_limited INTEGER NOT NULL DEFAULT 0,
      message      TEXT NOT NULL
    );
  `);
}

/** Persistent hourly counters (survive restarts) plus a capped log of recent errors. */
export class Metrics {
  private writes = 0;

  constructor(private readonly db: DatabaseSync) {
    ensureMetricsSchema(db);
  }

  record(e: MetricEvent) {
    try {
      const now = new Date();
      this.db
        .prepare(
          `INSERT INTO metrics_hourly (hour, kind, name, ok, err, rate_limited, total_ms) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (hour, kind, name) DO UPDATE SET ok = ok + excluded.ok, err = err + excluded.err,
             rate_limited = rate_limited + excluded.rate_limited, total_ms = total_ms + excluded.total_ms`,
        )
        .run(hourBucket(now), e.kind, e.name.slice(0, 120), e.ok ? 1 : 0, e.ok ? 0 : 1, e.rateLimited ? 1 : 0, Math.round(e.ms ?? 0));
      if (!e.ok) {
        this.db
          .prepare("INSERT INTO metrics_errors (at, kind, name, rate_limited, message) VALUES (?, ?, ?, ?, ?)")
          .run(now.toISOString(), e.kind, e.name.slice(0, 120), e.rateLimited ? 1 : 0, (e.error ?? "").slice(0, 500));
      }
      if (++this.writes % 500 === 0) this.prune();
    } catch (err) {
      console.error(JSON.stringify({ metricsWriteFailed: String(err) }));
    }
  }

  prune() {
    const now = Date.now();
    const errCutoff = new Date(now - ERROR_RETENTION_DAYS * 86_400_000).toISOString();
    const hourCutoff = hourBucket(new Date(now - HOURLY_RETENTION_DAYS * 86_400_000));
    this.db.prepare("DELETE FROM metrics_errors WHERE at < ?").run(errCutoff);
    this.db
      .prepare("DELETE FROM metrics_errors WHERE id NOT IN (SELECT id FROM metrics_errors ORDER BY id DESC LIMIT ?)")
      .run(MAX_ERROR_ROWS);
    this.db.prepare("DELETE FROM metrics_hourly WHERE hour < ?").run(hourCutoff);
  }

  /** Totals and hourly series for the last `hours` hours. */
  summary(hours: number) {
    const since = hourBucket(new Date(Date.now() - (hours - 1) * 3_600_000));
    const totals = this.db
      .prepare(
        `SELECT kind, name, SUM(ok) AS ok, SUM(err) AS err, SUM(rate_limited) AS rate_limited, SUM(total_ms) AS total_ms
         FROM metrics_hourly WHERE hour >= ? GROUP BY kind, name ORDER BY SUM(ok) + SUM(err) DESC`,
      )
      .all(since) as { kind: MetricKind; name: string; ok: number; err: number; rate_limited: number; total_ms: number }[];
    const series = this.db
      .prepare(
        `SELECT hour, kind, SUM(ok) AS ok, SUM(err) AS err, SUM(rate_limited) AS rate_limited
         FROM metrics_hourly WHERE hour >= ? AND kind IN ('tool', 'service') GROUP BY hour, kind ORDER BY hour`,
      )
      .all(since) as { hour: string; kind: MetricKind; ok: number; err: number; rate_limited: number }[];
    const errors = this.db
      .prepare("SELECT at, kind, name, rate_limited, message FROM metrics_errors WHERE at >= ? ORDER BY id DESC LIMIT 100")
      .all(since);
    return { since, hours, totals, series, errors };
  }
}
