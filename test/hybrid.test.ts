import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFtsQuery, fuse, semanticHits, type Hit } from "../src/search/hybrid";
import { openDatabase } from "../src/storage/db";

describe("buildFtsQuery", () => {
  it("quotes each word as a prefix and joins with OR", () => {
    expect(buildFtsQuery("Acmecorp Maria")).toBe('"acmecorp"* OR "maria"*');
  });

  it("drops Portuguese and English stopwords and words under 3 characters", () => {
    expect(buildFtsQuery("o que eu decidi sobre a Acmecorp")).toBe('"decidi"* OR "acmecorp"*');
    expect(buildFtsQuery("what did I decide about the job")).toBe('"decide"* OR "job"*');
  });

  it("can't be broken by FTS5 syntax in the input", () => {
    expect(buildFtsQuery('a "quote" AND -minus NEAR(x) col:value*')).toBe('"quote"* OR "minus"* OR "near"* OR "col"* OR "value"*');
  });

  it("returns null when nothing is left", () => {
    expect(buildFtsQuery("o a de IA")).toBeNull();
    expect(buildFtsQuery("   ")).toBeNull();
  });

  it("keeps letters outside a-z (ø, ł) inside words, like the index does", () => {
    expect(buildFtsQuery("Søren Łódź")).toBe('"søren"* OR "łodz"*');
  });

  it("keeps accents out of the query (the index ignores them)", () => {
    expect(buildFtsQuery("decisão café")).toBe('"decisao"* OR "cafe"*');
  });
});

describe("semanticHits", () => {
  it("keeps matches above the similarity floor and maps their metadata", () => {
    const matches = [
      { id: "h-0", score: 0.8, metadata: { path: "a.md", seq: 0, text: "alpha" } },
      { id: "h-1", score: 0.3, metadata: { path: "b.md", seq: 1, text: "weak" } },
    ];
    expect(semanticHits(matches as any, 0.45)).toEqual([{ path: "a.md", seq: 0, text: "alpha" }]);
  });

  it("drops vectors without a path instead of returning a path 'undefined'", () => {
    expect(semanticHits([{ id: "x", score: 0.9, metadata: {} }] as any, 0.45)).toEqual([]);
  });
});

describe("fuse (reciprocal rank fusion)", () => {
  const h = (path: string, seq = 0): Hit => ({ path, seq, text: `${path}#${seq}` });

  it("ranks a note found by both above notes found by one", () => {
    const out = fuse([h("a"), h("b")], [h("c"), h("a")], 10);
    expect(out[0]).toMatchObject({ path: "a", matched: "both" });
    expect(out.map((r) => r.path).sort()).toEqual(["a", "b", "c"]);
  });

  it("labels how each note was found", () => {
    const out = fuse([h("k")], [h("s")], 10);
    expect(Object.fromEntries(out.map((r) => [r.path, r.matched]))).toEqual({ k: "keyword", s: "semantic" });
  });

  it("scores a note by its best chunk, not the sum (long notes don't win by size)", () => {
    const out = fuse([h("long", 0), h("short", 0), h("long", 1), h("long", 2)], [], 10);
    expect(out[0].path).toBe("long");
    expect(out[0].score).toBeCloseTo(1 / 61);
    expect(out[1].score).toBeCloseTo(1 / 62);
    expect(out[0].text).toBe("long#0"); // the best chunk is the snippet
  });

  it("returns at most limit notes", () => {
    expect(fuse([h("a"), h("b"), h("c")], [], 2)).toHaveLength(2);
  });
});

describe("chunks_fts on real local SQLite", () => {
  const db = openDatabase(":memory:");
  beforeAll(() => {
    db.prepare("INSERT INTO chunks_fts (path, seq, text) VALUES (?, 0, ?)").run("a.md", "A decisão sobre a Acmecorp e o café");
    db.prepare("INSERT INTO chunks_fts (path, seq, text) VALUES (?, 0, ?)").run("b.md", "Notes about cooking");
  });
  afterAll(() => db.close());
  const match = (q: string) =>
    (db.prepare("SELECT path FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts)").all(q) as { path: string }[]).map((r) => r.path);

  it("ignores accents and case", () => {
    expect(match(buildFtsQuery("DECISAO")!)).toEqual(["a.md"]);
  });

  it("matches word prefixes", () => {
    expect(match(buildFtsQuery("acme")!)).toEqual(["a.md"]);
  });

  it("finds either word with OR", () => {
    expect(match(buildFtsQuery("acmecorp cooking")!).sort()).toEqual(["a.md", "b.md"]);
  });
});
