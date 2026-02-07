import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { mkdirSync } from 'fs';
import { homedir } from 'os';

const DB_PATH = join(homedir(), '.claude', 'session-memory.db');

let _db = null;

export function getDb() {
  if (_db) return _db;

  mkdirSync(dirname(DB_PATH), { recursive: true });

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      project_path TEXT,
      git_branch TEXT,
      summary TEXT,
      first_prompt TEXT,
      document TEXT,
      embedding BLOB,
      created TEXT,
      modified TEXT,
      message_count INTEGER,
      file_mtime INTEGER,
      indexed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  return _db;
}

export function upsertSession(session) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO sessions
      (session_id, project_path, git_branch, summary, first_prompt, document, embedding, created, modified, message_count, file_mtime, indexed_at)
    VALUES
      (@session_id, @project_path, @git_branch, @summary, @first_prompt, @document, @embedding, @created, @modified, @message_count, @file_mtime, @indexed_at)
  `);
  stmt.run(session);
}

export function getSession(sessionId) {
  const db = getDb();
  return db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId);
}

export function getSessionByPrefix(prefix) {
  const db = getDb();
  return db.prepare('SELECT * FROM sessions WHERE session_id LIKE ?').get(prefix + '%');
}

export function getAllSessions() {
  const db = getDb();
  return db.prepare('SELECT * FROM sessions ORDER BY modified DESC').all();
}

export function getSessionMtime(sessionId) {
  const db = getDb();
  const row = db.prepare('SELECT file_mtime FROM sessions WHERE session_id = ?').get(sessionId);
  return row ? row.file_mtime : null;
}

export function getStats() {
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) as count FROM sessions').get();
  const oldest = db.prepare('SELECT MIN(created) as oldest FROM sessions').get();
  const newest = db.prepare('SELECT MAX(modified) as newest FROM sessions').get();
  const projects = db.prepare('SELECT COUNT(DISTINCT project_path) as count FROM sessions').get();
  return {
    totalSessions: count.count,
    oldestSession: oldest.oldest,
    newestSession: newest.newest,
    projectCount: projects.count,
  };
}

export function setMeta(key, value) {
  const db = getDb();
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
}

export function getMeta(key) {
  const db = getDb();
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}
