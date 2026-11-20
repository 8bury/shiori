import { retryDelay } from "../queue.js";
import type { SqliteAlerts } from "../storage/sqlite-adapters.js";
import type { MemorySummarizer } from "./summarizer.js";
import type { MemoryStore } from "./tree.js";

const MAX_ATTEMPTS = 5;

export class MemoryCompactor {
  private running = false;
  private closed = false;
  private rerunRequested = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private idleResolvers: (() => void)[] = [];

  constructor(
    private readonly memory: MemoryStore,
    private readonly summarizer: MemorySummarizer,
    private readonly alerts: SqliteAlerts,
    private readonly delayMultiplier = 1000,
  ) {}

  get enabled(): boolean {
    return !this.summarizer.disabled;
  }

  trigger(): void {
    if (!this.enabled || this.closed) return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.running) {
      this.rerunRequested = true;
      return;
    }
    void this.pump(1);
  }

  private wakeIdle() {
    for (const resolve of this.idleResolvers.splice(0)) resolve();
  }

  private async pump(attempt: number): Promise<void> {
    if (this.running || this.closed || !this.enabled) return;
    this.running = true;
    try {
      while (!this.closed) {
        this.rerunRequested = false;
        const pending = this.memory.nextPendingMerge();
        if (!pending) break;
        const range = `${pending.lo}-${pending.hi}`;
        try {
          const summary = await this.summarizer.summarize(pending.left.text, pending.right.text);
          const result = this.memory.saveSummary(pending.lo, pending.hi, summary);
          console.log(JSON.stringify({ memoryCompacted: { range, saved: result.saved } }));
          attempt = 1;
        } catch (e) {
          console.error(JSON.stringify({ memoryCompactFailed: String(e), range, attempt }));
          if (attempt >= MAX_ATTEMPTS) {
            this.alerts.add("dlq", JSON.stringify({ kind: "memory-compact", range, error: String(e) }));
            break;
          }
          if (!this.closed) {
            const nextAttempt = attempt + 1;
            const delay = retryDelay(attempt) * this.delayMultiplier;
            this.retryTimer = setTimeout(() => {
              this.retryTimer = null;
              if (!this.closed) void this.pump(nextAttempt);
            }, delay);
            this.retryTimer.unref?.();
          }
          break;
        }
      }
    } finally {
      this.running = false;
      if (!this.closed && this.rerunRequested && !this.retryTimer) {
        this.rerunRequested = false;
        void this.pump(1);
      } else if (this.closed || !this.retryTimer) {
        this.wakeIdle();
      }
    }
  }

  /** Wait until any active compaction loop (and scheduled retries unless closed) is idle. */
  async drain(): Promise<void> {
    if (!this.running && (this.closed || !this.retryTimer)) return;
    await new Promise<void>((resolve) => this.idleResolvers.push(resolve));
  }

  close() {
    this.closed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (!this.running) this.wakeIdle();
  }
}
