import { handle } from "./indexer/indexer.js";
import type { Deps, QueueMessage } from "./indexer/types.js";
import type { SqliteAlerts } from "./storage/sqlite-adapters.js";

const MAX_ATTEMPTS = 5;

export const retryDelay = (attempts: number) => 10 * 2 ** (attempts - 1);

interface QueuedJob {
  message: QueueMessage;
  attempt: number;
}

export class IndexQueue {
  private pending: QueuedJob[] = [];
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private running = false;
  private closed = false;
  private idleResolvers: (() => void)[] = [];

  constructor(
    private readonly getDeps: () => Deps,
    private readonly alerts: SqliteAlerts,
    private readonly delayMultiplier = 1000,
  ) {}

  enqueue(messages: QueueMessage[], delaySeconds?: number): Promise<void> {
    if (this.closed || !messages.length) return Promise.resolve();
    if (delaySeconds && delaySeconds > 0) {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        if (this.closed) return;
        for (const message of messages) this.pending.push({ message, attempt: 1 });
        void this.pump();
      }, delaySeconds * this.delayMultiplier);
      timer.unref?.();
      this.timers.add(timer);
      return Promise.resolve();
    }
    for (const message of messages) this.pending.push({ message, attempt: 1 });
    void this.pump();
    return Promise.resolve();
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length > 0 && !this.closed) {
        const job = this.pending.shift()!;
        try {
          const outcome = await handle(job.message, this.getDeps());
          console.log(JSON.stringify({ indexed: outcome }));
        } catch (e) {
          console.error(JSON.stringify({ indexFailed: String(e), attempt: job.attempt, body: job.message }));
          if (job.attempt >= MAX_ATTEMPTS) {
            console.error(JSON.stringify({ alert: "index job failed after retries", body: job.message }));
            this.alerts.add("dlq", JSON.stringify(job.message));
          } else {
            const nextAttempt = job.attempt + 1;
            const delay = retryDelay(job.attempt) * this.delayMultiplier;
            const timer = setTimeout(() => {
              this.timers.delete(timer);
              if (this.closed) return;
              this.pending.push({ message: job.message, attempt: nextAttempt });
              void this.pump();
            }, delay);
            timer.unref?.();
            this.timers.add(timer);
          }
        }
      }
    } finally {
      this.running = false;
      if (this.pending.length === 0) {
        for (const resolve of this.idleResolvers.splice(0)) resolve();
      }
    }
  }

  /** Wait until all currently queued (non-delayed) jobs finish. Useful in tests. */
  async drain(): Promise<void> {
    if (!this.running && this.pending.length === 0) return;
    await new Promise<void>((resolve) => this.idleResolvers.push(resolve));
  }

  close() {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}
