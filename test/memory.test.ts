import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeWakeCover, MAX_MEMORY_BYTES, MemoryStore, parseRange } from "../src/memory/tree";
import { openDatabase } from "../src/storage/db";

describe("parseRange", () => {
  it("accepts power-of-2 aligned ranges", () => {
    expect(parseRange("0-1")).toEqual({ lo: 0, hi: 1 });
    expect(parseRange("#0-3")).toEqual({ lo: 0, hi: 3 });
    expect(parseRange("4-7")).toEqual({ lo: 4, hi: 7 });
    expect(parseRange("8-15")).toEqual({ lo: 8, hi: 15 });
  });

  it("rejects unaligned or invalid ranges", () => {
    expect(parseRange("1-2")).toBeNull(); // not aligned to size 2
    expect(parseRange("0-2")).toBeNull(); // size 3 is not power of 2
    expect(parseRange("2-5")).toBeNull(); // not aligned to size 4
    expect(parseRange("0-0")).toBeNull(); // leaf
    expect(parseRange("abc")).toBeNull();
  });
});

describe("computeWakeCover", () => {
  it("expands everything to leaves when total <= budget", () => {
    const cover = computeWakeCover(7, 10, () => true);
    expect(cover).toEqual([
      { lo: 0, hi: 0 },
      { lo: 1, hi: 1 },
      { lo: 2, hi: 2 },
      { lo: 3, hi: 3 },
      { lo: 4, hi: 4 },
      { lo: 5, hi: 5 },
      { lo: 6, hi: 6 },
    ]);
  });

  it("keeps older nodes compressed and expands newer nodes right-to-left", () => {
    // 7 items: initial binary cover is [0-3], [4-5], [6-6] (3 lines)
    expect(computeWakeCover(7, 3, () => true)).toEqual([
      { lo: 0, hi: 3 },
      { lo: 4, hi: 5 },
      { lo: 6, hi: 6 },
    ]);
    // With budget 4: expands rightmost non-leaf [4-5] -> [4], [5]
    expect(computeWakeCover(7, 4, () => true)).toEqual([
      { lo: 0, hi: 3 },
      { lo: 4, hi: 4 },
      { lo: 5, hi: 5 },
      { lo: 6, hi: 6 },
    ]);
    // With budget 5: expands [0-3] -> [0-1], [2-3]
    expect(computeWakeCover(7, 5, () => true)).toEqual([
      { lo: 0, hi: 1 },
      { lo: 2, hi: 3 },
      { lo: 4, hi: 4 },
      { lo: 5, hi: 5 },
      { lo: 6, hi: 6 },
    ]);
  });

  it("splits unsummarized blocks automatically", () => {
    // Only [0-1] has a summary; [0-3] does not
    const cover = computeWakeCover(4, 2, (lo, hi) => lo === 0 && hi === 1);
    expect(cover).toEqual([
      { lo: 0, hi: 1 },
      { lo: 2, hi: 2 },
      { lo: 3, hi: 3 },
    ]);
  });
});

describe("MemoryStore", () => {
  let tmpDir: string;
  let db: ReturnType<typeof openDatabase>;
  let store: MemoryStore;
  let logPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-mem-test-"));
    logPath = path.join(tmpDir, "LOG.txt");
    db = openDatabase(":memory:");
    store = new MemoryStore(db, 4, logPath);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects empty or > 280 byte notes", () => {
    expect(store.note("   ")).toContain("cannot be empty");
    expect(store.note("a".repeat(MAX_MEMORY_BYTES + 1))).toContain("Too long");
    expect(store.count()).toBe(0);
  });

  it("appends memories, writes LOG.txt, schedules bottom-up merges, and supports wake/zoom/recall/forget", () => {
    expect(store.wake()).toContain("empty");

    const r0 = store.note("Started second brain project on fender", "claude");
    expect(r0).toContain("Recorded #0");
    expect(r0).not.toContain("COMPRESSION DUE");

    const r1 = store.note("Added Coolify deployment with Node 24 and SQLite", "muse");
    expect(r1).toContain("Recorded #1");
    expect(r1).toContain("COMPRESSION DUE for #0-1");

    // Verify LOG.txt backup
    const logLines = fs.readFileSync(logPath, "utf8").trim().split("\n");
    expect(logLines).toHaveLength(2);
    expect(logLines[0]).toContain("claude");
    expect(logLines[1]).toContain("muse");

    // Answer #0-1 merge
    const n01 = store.nap("0-1", "Set up second-brain-mcp on fender with Coolify, Node 24, and SQLite");
    expect(n01).toContain("Saved summary #0-1");
    expect(n01).not.toContain("COMPRESSION DUE");

    // Idempotent duplicate nap
    expect(store.nap("0-1", "Duplicate summary")).toContain("already summarized");

    // Add #2 and #3 -> triggers #2-3, then #0-3
    store.note("Connected Grok Bot via OAuth 2.1", "grok");
    const r3 = store.note("Added OpenAI embeddings for hybrid search", "claude");
    expect(r3).toContain("COMPRESSION DUE for #2-3");

    const n23 = store.nap("2-3", "Wired Grok OAuth and OpenAI embeddings");
    expect(n23).toContain("Saved summary #2-3");
    expect(n23).toContain("COMPRESSION DUE for #0-3");

    const n03 = store.nap("0-3", "Built and deployed second-brain-mcp on fender with OAuth + hybrid search");
    expect(n03).toContain("Saved summary #0-3");
    expect(n03).not.toContain("COMPRESSION DUE");

    // Add #4 -> total 5 entries with wakeLines=4: should show #0-1, #2-3, #4? Wait: initial cover [0-3], [4] (2 lines) -> expand [0-3] to [0-1],[2-3] (3 lines) -> expand [2-3] to #2, #3 (4 lines)!
    store.note("Designed OptMem-style binary tree memory", "claude");
    const woke = store.wake();
    expect(woke).toContain("#0-1");
    expect(woke).toContain("#2 [");
    expect(woke).toContain("#3 [");
    expect(woke).toContain("#4 [");

    // Zoom into #0-3 -> shows #0-1 and #2-3
    const zoomed = store.zoom("0-3");
    expect(zoomed).toContain("#0-1");
    expect(zoomed).toContain("#2-3");

    // Recall searches raw log (substring by default, safe regex opt-in)
    expect(store.recall("Grok Bot")).toContain("#2 [");
    const recalled = store.recall("grok.*oauth", 50, true);
    expect(recalled).toContain("#2 [");
    expect(recalled).toContain("Connected Grok Bot");
    expect(store.recall("(a+)+", 50, true)).toContain("Unsafe");

    // Forget #0-1 drops #0-1 AND its ancestor #0-3, and prompts rebuild
    const forgot = store.forget("0-1");
    expect(forgot).toContain("Dropped 2 summary node(s)");
    expect(forgot).toContain("COMPRESSION DUE for #0-1");

    // M3: nap refuses parent when child #0-1 is missing
    expect(store.nap("0-3", "Premature summary")).toContain("child #0-1 must be summarized first");
  });

  it("caps wake output even when many entries are unsummarized (M4)", () => {
    for (let i = 0; i < 10; i++) store.note(`Unsummarized entry ${i}`, "test");
    const woke = store.wake(4);
    const body = woke.split("\n\n")[0];
    expect(body).toContain("6 older unsummarized entries omitted");
    expect(body).toContain("#9 [");
    expect(body).not.toContain("#0 [");
  });
});
