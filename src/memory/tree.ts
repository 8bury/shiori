import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

export const MAX_MEMORY_BYTES = 280;

export interface MemoryNode {
  lo: number;
  hi: number;
}

export interface PendingMerge {
  lo: number;
  hi: number;
  left: { lo: number; hi: number; text: string };
  right: { lo: number; hi: number; text: string };
}

export function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

export function isValidTreeRange(lo: number, hi: number): boolean {
  if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 0 || hi <= lo) return false;
  const size = hi - lo + 1;
  return isPowerOfTwo(size) && lo % size === 0;
}

export function parseRange(raw: string): MemoryNode | null {
  const m = raw.trim().match(/^#?(\d+)\s*[-–]\s*(\d+)$/);
  if (!m) return null;
  const lo = Number(m[1]);
  const hi = Number(m[2]);
  return isValidTreeRange(lo, hi) ? { lo, hi } : null;
}

export function cleanOneLine(input: string): string {
  return input.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

export function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/**
 * Pure logarithmic cover: covers [0, total - 1] with at most `budget` entries.
 * Older entries stay collapsed into larger summarized power-of-2 ranges; newer entries
 * expand right-to-left down to verbatim raw leaves.
 */
export function computeWakeCover(total: number, budget: number, hasSummary: (lo: number, hi: number) => boolean): MemoryNode[] {
  if (total <= 0) return [];
  const maxLines = Math.max(1, budget);

  // 1. Decompose [0, total - 1] into maximal power-of-2 aligned blocks from left to right.
  const initial: MemoryNode[] = [];
  let pos = 0;
  while (pos < total) {
    let size = 1;
    while (pos % (size * 2) === 0 && pos + size * 2 <= total) {
      size *= 2;
    }
    initial.push({ lo: pos, hi: pos + size - 1 });
    pos += size;
  }

  // 2. Any non-leaf block without a summary yet must be split until every non-leaf has a summary.
  const cover: MemoryNode[] = [];
  const ensureSummarized = (node: MemoryNode) => {
    if (node.lo === node.hi || hasSummary(node.lo, node.hi)) {
      cover.push(node);
      return;
    }
    const mid = Math.floor((node.lo + node.hi) / 2);
    ensureSummarized({ lo: node.lo, hi: mid });
    ensureSummarized({ lo: mid + 1, hi: node.hi });
  };
  for (const block of initial) ensureSummarized(block);

  // 3. Greedily expand the rightmost (most recent) non-leaf node while within budget.
  while (cover.length < maxLines) {
    let idx = -1;
    for (let i = cover.length - 1; i >= 0; i--) {
      if (cover[i].lo < cover[i].hi) {
        idx = i;
        break;
      }
    }
    if (idx === -1) break;
    const node = cover[idx];
    const mid = Math.floor((node.lo + node.hi) / 2);
    cover.splice(idx, 1, { lo: node.lo, hi: mid }, { lo: mid + 1, hi: node.hi });
  }

  return cover;
}

export class MemoryStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly wakeLines = 96,
    private readonly logFilePath?: string,
  ) {}

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) as c FROM memory_log").get() as { c: number };
    return Number(row.c);
  }

  private getLog(seq: number): { seq: number; content: string; source: string; created_at: string } | null {
    const row = this.db.prepare("SELECT seq, content, source, created_at FROM memory_log WHERE seq = ?").get(seq) as
      | { seq: number; content: string; source: string; created_at: string }
      | undefined;
    return row ?? null;
  }

  private getSummary(lo: number, hi: number): string | null {
    const row = this.db.prepare("SELECT summary FROM memory_tree WHERE lo = ? AND hi = ?").get(lo, hi) as { summary: string } | undefined;
    return row?.summary ?? null;
  }

  private nodeText(lo: number, hi: number): string | null {
    if (lo === hi) {
      const entry = this.getLog(lo);
      return entry ? `#${lo} [${entry.created_at.slice(0, 10)}] ${entry.content}` : null;
    }
    const summary = this.getSummary(lo, hi);
    return summary !== null ? `#${lo}-${hi} ${summary}` : null;
  }

  /** Finds the next complete power-of-2 pair missing a summary, bottom-up. */
  nextPendingMerge(): PendingMerge | null {
    const total = this.count();
    if (total < 2) return null;
    for (let size = 2; size <= total; size *= 2) {
      const half = size / 2;
      for (let lo = 0; lo + size - 1 < total; lo += size) {
        const hi = lo + size - 1;
        if (this.getSummary(lo, hi) !== null) continue;
        const leftText = this.nodeText(lo, lo + half - 1);
        const rightText = this.nodeText(lo + half, hi);
        if (leftText !== null && rightText !== null) {
          return {
            lo,
            hi,
            left: { lo, hi: lo + half - 1, text: leftText },
            right: { lo: lo + half, hi, text: rightText },
          };
        }
      }
    }
    return null;
  }

  formatMergePrompt(merge: PendingMerge): string {
    return [
      `COMPRESSION DUE for #${merge.lo}-${merge.hi}:`,
      `  left:  ${merge.left.text}`,
      `  right: ${merge.right.text}`,
      `Call memory_nap with range="${merge.lo}-${merge.hi}" and a single-line summary (<= ${MAX_MEMORY_BYTES} bytes) combining both before your next action.`,
    ].join("\n");
  }

  wake(customLines?: number): string {
    const total = this.count();
    if (total === 0) {
      return "Memory is empty (0 entries). Use memory_note to record important facts, decisions, and events.";
    }
    const budget = customLines && customLines > 0 ? customLines : this.wakeLines;
    const cover = computeWakeCover(total, budget, (lo, hi) => this.getSummary(lo, hi) !== null);
    const lines = cover.map((n) => this.nodeText(n.lo, n.hi)).filter((x): x is string => x !== null);
    const pending = this.nextPendingMerge();
    const out = [`Memory (${total} total entries, showing ${lines.length} lines):`, ...lines];
    if (pending) {
      out.push("", this.formatMergePrompt(pending));
    }
    return out.join("\n");
  }

  note(rawContent: string, source = ""): string {
    const content = cleanOneLine(rawContent);
    if (!content) return "Nothing recorded: memory text cannot be empty.";
    const bytes = byteLength(content);
    if (bytes > MAX_MEMORY_BYTES) {
      return `Too long (${bytes} bytes; max ${MAX_MEMORY_BYTES} bytes). Shorten to one concise line and call memory_note again.`;
    }
    const now = new Date().toISOString();
    let seq = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT COALESCE(MAX(seq), -1) + 1 as nextSeq FROM memory_log").get() as { nextSeq: number };
      seq = Number(row.nextSeq);
      this.db.prepare("INSERT INTO memory_log (seq, content, source, created_at) VALUES (?, ?, ?, ?)").run(seq, content, source, now);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }

    if (this.logFilePath) {
      try {
        fs.mkdirSync(path.dirname(this.logFilePath), { recursive: true });
        const line = `#${seq}\t${now}\t${source || "-"}\t${content}\n`;
        fs.appendFileSync(this.logFilePath, line, "utf8");
      } catch (e) {
        console.error(JSON.stringify({ memoryLogAppendFailed: String(e) }));
      }
    }

    const pending = this.nextPendingMerge();
    const saved = `Recorded #${seq}: ${content}`;
    return pending ? `${saved}\n\n${this.formatMergePrompt(pending)}` : saved;
  }

  nap(rangeStr?: string, rawSummary?: string): string {
    if (!rangeStr || !rawSummary) {
      const pending = this.nextPendingMerge();
      return pending ? this.formatMergePrompt(pending) : "No compressions due.";
    }
    const range = parseRange(rangeStr);
    if (!range) return `Invalid range "${rangeStr}". Expected a power-of-2 aligned range like "0-1" or "0-3".`;
    const total = this.count();
    if (range.hi >= total) return `Range #${range.lo}-${range.hi} is out of bounds (total memories: ${total}).`;

    const summary = cleanOneLine(rawSummary);
    if (!summary) return "Summary cannot be empty.";
    const bytes = byteLength(summary);
    if (bytes > MAX_MEMORY_BYTES) {
      return `Summary too long (${bytes} bytes; max ${MAX_MEMORY_BYTES} bytes). Shorten and call memory_nap again.`;
    }

    // Idempotent: if another agent already summarized this exact node, accept gracefully
    const existing = this.getSummary(range.lo, range.hi);
    if (existing !== null) {
      const next = this.nextPendingMerge();
      return next
        ? `#${range.lo}-${range.hi} was already summarized.\n\n${this.formatMergePrompt(next)}`
        : `#${range.lo}-${range.hi} was already summarized. No more compressions due.`;
    }

    this.db
      .prepare("INSERT OR IGNORE INTO memory_tree (lo, hi, summary, created_at) VALUES (?, ?, ?, ?)")
      .run(range.lo, range.hi, summary, new Date().toISOString());

    const next = this.nextPendingMerge();
    const saved = `Saved summary #${range.lo}-${range.hi}: ${summary}`;
    return next ? `${saved}\n\n${this.formatMergePrompt(next)}` : saved;
  }

  zoom(rangeStr: string): string {
    const range = parseRange(rangeStr);
    if (!range) return `Invalid range "${rangeStr}". Expected a power-of-2 aligned range like "0-3".`;
    const total = this.count();
    if (range.hi >= total) return `Range #${range.lo}-${range.hi} is out of bounds (total memories: ${total}).`;

    const mid = Math.floor((range.lo + range.hi) / 2);
    const left = this.nodeText(range.lo, mid) ?? `#${range.lo}-${mid} (unsummarized — zoom further)`;
    const right = this.nodeText(mid + 1, range.hi) ?? `#${mid + 1}-${range.hi} (unsummarized — zoom further)`;
    return [`Zoom #${range.lo}-${range.hi}:`, `  ${left}`, `  ${right}`].join("\n");
  }

  recall(pattern: string, limit = 50): string {
    const q = pattern.trim();
    if (!q) return "Provide a search pattern.";
    let matcher: (text: string) => boolean;
    try {
      const re = new RegExp(q, "i");
      matcher = (text) => re.test(text);
    } catch {
      const lower = q.toLowerCase();
      matcher = (text) => text.toLowerCase().includes(lower);
    }

    const rows = this.db.prepare("SELECT seq, content, created_at FROM memory_log ORDER BY seq DESC").all() as unknown as {
      seq: number;
      content: string;
      created_at: string;
    }[];
    const matches: string[] = [];
    for (const r of rows) {
      if (matcher(r.content)) {
        matches.push(`#${r.seq} [${r.created_at.slice(0, 10)}] ${r.content}`);
        if (matches.length >= limit) break;
      }
    }
    return matches.length ? matches.reverse().join("\n") : `No memories matching "${q}".`;
  }

  forget(rangeStr: string): string {
    const range = parseRange(rangeStr);
    if (!range) return `Invalid range "${rangeStr}". Expected a power-of-2 aligned range like "0-3".`;
    // Delete the node and any ancestor summaries covering it so they rebuild cleanly
    const res = this.db.prepare("DELETE FROM memory_tree WHERE lo <= ? AND hi >= ?").run(range.lo, range.hi);
    const removed = Number(res.changes);
    if (removed === 0) return `No summary found for #${range.lo}-${range.hi}.`;
    const next = this.nextPendingMerge();
    const msg = `Dropped ${removed} summary node(s) covering #${range.lo}-${range.hi}.`;
    return next ? `${msg}\n\n${this.formatMergePrompt(next)}` : msg;
  }
}
