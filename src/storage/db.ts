import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openDatabase(dbPath: string): DatabaseSync {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS manifest (
      path       TEXT PRIMARY KEY,
      sha        TEXT NOT NULL,
      chunks     INTEGER NOT NULL,
      indexed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      source      TEXT NOT NULL,
      body        TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      path UNINDEXED,
      seq UNINDEXED,
      text,
      tokenize = 'unicode61 remove_diacritics 2',
      prefix = '3'
    );

    CREATE TABLE IF NOT EXISTS vectors (
      id        TEXT PRIMARY KEY,
      path      TEXT NOT NULL,
      seq       INTEGER NOT NULL,
      text      TEXT NOT NULL,
      embedding BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_vectors_path ON vectors(path);

    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id                  TEXT PRIMARY KEY,
      client_secret_hash         TEXT,
      client_name                TEXT NOT NULL,
      redirect_uris              TEXT NOT NULL,
      token_endpoint_auth_method TEXT NOT NULL,
      created_at                 INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_sessions (
      handle        TEXT PRIMARY KEY,
      kind          TEXT NOT NULL,
      cookie_hash   TEXT NOT NULL,
      payload       TEXT NOT NULL,
      expires_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_auth_codes (
      code_hash             TEXT PRIMARY KEY,
      client_id             TEXT NOT NULL,
      user_id               TEXT NOT NULL,
      redirect_uri          TEXT NOT NULL,
      scope                 TEXT NOT NULL,
      code_challenge        TEXT NOT NULL,
      code_challenge_method TEXT NOT NULL,
      resource              TEXT,
      metadata              TEXT NOT NULL,
      expires_at            INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_grants (
      id              TEXT PRIMARY KEY,
      client_id       TEXT NOT NULL,
      user_id         TEXT NOT NULL,
      scope           TEXT NOT NULL,
      metadata        TEXT NOT NULL,
      created_at      INTEGER NOT NULL,
      last_used_at    INTEGER NOT NULL,
      expires_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_tokens (
      token_hash      TEXT PRIMARY KEY,
      grant_id        TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
      token_type      TEXT NOT NULL,
      client_id       TEXT NOT NULL,
      user_id         TEXT NOT NULL,
      scope           TEXT NOT NULL,
      resource        TEXT,
      expires_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_tokens_grant ON oauth_tokens(grant_id);

    CREATE TABLE IF NOT EXISTS memory_log (
      seq        INTEGER PRIMARY KEY,
      content    TEXT NOT NULL,
      source     TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_tree (
      lo         INTEGER NOT NULL,
      hi         INTEGER NOT NULL,
      summary    TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (lo, hi)
    );
  `);
}
