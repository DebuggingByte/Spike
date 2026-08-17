const { createClient } = require('@libsql/client');
const path = require('path');

// Uses a hosted Turso (libSQL) database when TURSO_DATABASE_URL is set (required on
// Vercel, since the serverless filesystem is ephemeral/read-only), and falls back to
// a local SQLite file for local development otherwise.
if (process.env.VERCEL && !process.env.TURSO_DATABASE_URL) {
  throw new Error('TURSO_DATABASE_URL is not set — a hosted database is required in production. See README for setup.');
}

const db = process.env.TURSO_DATABASE_URL
  ? createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })
  : createClient({ url: `file:${path.join(__dirname, 'scheduleai.db')}` });

const ready = db.batch([
  `CREATE TABLE IF NOT EXISTS memories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email  TEXT    NOT NULL,
    key         TEXT    NOT NULL,
    value       TEXT    NOT NULL,
    created_at  DATETIME DEFAULT (datetime('now')),
    updated_at  DATETIME DEFAULT (datetime('now')),
    UNIQUE(user_email, key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_memories_email ON memories(user_email)`,
  `CREATE TABLE IF NOT EXISTS sessions (
    sid     TEXT PRIMARY KEY,
    sess    TEXT NOT NULL,
    expires INTEGER NOT NULL
  )`
], 'write');

async function getMemories(email) {
  await ready;
  const rs = await db.execute({
    sql: 'SELECT key, value, updated_at FROM memories WHERE user_email = ? ORDER BY updated_at DESC',
    args: [email]
  });
  return rs.rows;
}

async function saveMemory(email, key, value) {
  await ready;
  return db.execute({
    sql: `INSERT INTO memories (user_email, key, value, updated_at)
          VALUES (?, ?, ?, datetime('now'))
          ON CONFLICT(user_email, key) DO UPDATE SET
            value      = excluded.value,
            updated_at = excluded.updated_at`,
    args: [email, key, value]
  });
}

async function deleteMemory(email, key) {
  await ready;
  const rs = await db.execute({
    sql: 'DELETE FROM memories WHERE user_email = ? AND key = ?',
    args: [email, key]
  });
  return { changes: Number(rs.rowsAffected) };
}

module.exports = { db, ready, getMemories, saveMemory, deleteMemory };
