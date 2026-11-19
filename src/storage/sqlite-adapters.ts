import type { DatabaseSync } from "node:sqlite";
import type { KeywordIndex, Manifest, ManifestRow, Vector, VectorIndex } from "../indexer/types.js";
import type { ReconcileIndex } from "../reconcile/types.js";
import type { Hit } from "../search/hybrid.js";

function encodeVector(values: number[]): Uint8Array {
  const f32 = new Float32Array(values);
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
}

function decodeVector(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, Math.floor(blob.byteLength / 4));
}

export function cosineSimilarity(a: number[] | Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return -1;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export class SqliteManifest implements Manifest {
  constructor(private readonly db: DatabaseSync) {}

  async get(path: string): Promise<ManifestRow | null> {
    const row = this.db.prepare("SELECT path, sha, chunks FROM manifest WHERE path = ?").get(path) as ManifestRow | undefined;
    return row ?? null;
  }

  async put(row: ManifestRow): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO manifest (path, sha, chunks, indexed_at) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET sha = excluded.sha, chunks = excluded.chunks, indexed_at = excluded.indexed_at",
      )
      .run(row.path, row.sha, row.chunks, new Date().toISOString());
  }

  async remove(path: string): Promise<void> {
    this.db.prepare("DELETE FROM manifest WHERE path = ?").run(path);
  }
}

export class SqliteKeywords implements KeywordIndex {
  constructor(private readonly db: DatabaseSync) {}

  async replace(path: string, chunks: string[]): Promise<void> {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM chunks_fts WHERE path = ?").run(path);
      const insert = this.db.prepare("INSERT INTO chunks_fts (path, seq, text) VALUES (?, ?, ?)");
      chunks.forEach((text, seq) => insert.run(path, seq, text));
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  async remove(path: string): Promise<void> {
    this.db.prepare("DELETE FROM chunks_fts WHERE path = ?").run(path);
  }

  search(ftsQuery: string, limit = 50): Hit[] {
    return this.db
      .prepare("SELECT path, seq, text FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT ?")
      .all(ftsQuery, limit) as unknown as Hit[];
  }
}

export class SqliteVectorIndex implements VectorIndex {
  constructor(private readonly db: DatabaseSync) {}

  async upsert(vectors: Vector[]): Promise<void> {
    const nonEmpty = vectors.filter((v) => v.values.length > 0);
    if (!nonEmpty.length) return;
    this.db.exec("BEGIN");
    try {
      const stmt = this.db.prepare(
        "INSERT INTO vectors (id, path, seq, text, embedding) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET path = excluded.path, seq = excluded.seq, text = excluded.text, embedding = excluded.embedding",
      );
      for (const v of nonEmpty) {
        stmt.run(v.id, v.metadata.path, v.metadata.seq, v.metadata.text, encodeVector(v.values));
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  async deleteByIds(ids: string[]): Promise<void> {
    if (!ids.length) return;
    this.db.exec("BEGIN");
    try {
      const stmt = this.db.prepare("DELETE FROM vectors WHERE id = ?");
      for (const id of ids) stmt.run(id);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  async pathOf(id: string): Promise<string | null> {
    const row = this.db.prepare("SELECT path FROM vectors WHERE id = ?").get(id) as { path: string } | undefined;
    return row?.path ?? null;
  }

  query(queryVector: number[], topK = 50): { score: number; metadata: { path: string; seq: number; text: string } }[] {
    if (!queryVector.length) return [];
    const rows = this.db.prepare("SELECT path, seq, text, embedding FROM vectors").all() as unknown as {
      path: string;
      seq: number;
      text: string;
      embedding: Uint8Array;
    }[];
    const scored: { score: number; metadata: { path: string; seq: number; text: string } }[] = [];
    let mismatchLogged = false;
    for (const row of rows) {
      const vec = decodeVector(row.embedding);
      if (vec.length !== queryVector.length) {
        if (!mismatchLogged) {
          mismatchLogged = true;
          console.warn(JSON.stringify({ vectorDimensionMismatch: { query: queryVector.length, stored: vec.length } }));
        }
        continue;
      }
      const score = cosineSimilarity(queryVector, vec);
      if (score > 0) {
        scored.push({ score, metadata: { path: row.path, seq: row.seq, text: row.text } });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }
}

export class SqliteReconcileIndex implements ReconcileIndex {
  constructor(private readonly db: DatabaseSync) {}

  async manifest() {
    return this.db.prepare("SELECT path, sha, chunks FROM manifest").all() as unknown as { path: string; sha: string; chunks: number }[];
  }

  async keywordPaths(): Promise<string[]> {
    const rows = this.db.prepare("SELECT DISTINCT path FROM chunks_fts").all() as unknown as { path: string }[];
    return rows.map((r) => r.path);
  }

  async vectorPathHashes(): Promise<string[]> {
    const rows = this.db.prepare("SELECT id FROM vectors").all() as unknown as { id: string }[];
    const hashes = new Set<string>();
    for (const r of rows) {
      const dash = r.id.lastIndexOf("-");
      if (dash > 0) hashes.add(r.id.slice(0, dash));
    }
    return [...hashes].sort();
  }
}

export class SqliteAlerts {
  constructor(private readonly db: DatabaseSync) {}

  add(source: "dlq" | "reconcile", body: string) {
    this.db.prepare("INSERT INTO alerts (source, body, created_at) VALUES (?, ?, ?)").run(source, body, new Date().toISOString());
  }

  resolveDlq() {
    this.db.prepare("UPDATE alerts SET resolved_at = ? WHERE source = 'dlq' AND resolved_at IS NULL").run(new Date().toISOString());
  }
}
