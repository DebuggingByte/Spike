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
  )`,
  // Persists each family member's Google OAuth tokens (independent of their session,
  // which expires) so any family member can ask about another's calendar at any time.
  `CREATE TABLE IF NOT EXISTS family_accounts (
    email      TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    tokens     TEXT NOT NULL,
    updated_at DATETIME DEFAULT (datetime('now'))
  )`,
  // One-way, short relayed messages between family members (e.g. "ask my mom if
  // she can come to my room"). No threading/replies — each row is a single
  // message from one family member to another, with a read/unread flag.
  `CREATE TABLE IF NOT EXISTS family_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    from_email  TEXT    NOT NULL,
    to_email    TEXT    NOT NULL,
    body        TEXT    NOT NULL,
    read        INTEGER NOT NULL DEFAULT 0,
    created_at  DATETIME DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_family_messages_to ON family_messages(to_email, created_at DESC)`
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

async function getFamilyAccount(email) {
  await ready;
  const rs = await db.execute({
    sql: 'SELECT email, name, tokens FROM family_accounts WHERE email = ?',
    args: [email]
  });
  return rs.rows[0] || null;
}

// Google only returns a refresh_token the first time a user consents (or after
// `prompt: consent`), so later logins that omit it must keep the one already on file.
async function saveFamilyTokens(email, name, tokens) {
  await ready;
  const existing = await getFamilyAccount(email);
  let merged = tokens;
  if (existing) {
    const oldTokens = JSON.parse(existing.tokens);
    merged = { ...oldTokens, ...tokens };
    if (!tokens.refresh_token && oldTokens.refresh_token) merged.refresh_token = oldTokens.refresh_token;
  }
  return db.execute({
    sql: `INSERT INTO family_accounts (email, name, tokens, updated_at)
          VALUES (?, ?, ?, datetime('now'))
          ON CONFLICT(email) DO UPDATE SET
            name       = excluded.name,
            tokens     = excluded.tokens,
            updated_at = excluded.updated_at`,
    args: [email, name, JSON.stringify(merged)]
  });
}

async function sendFamilyMessage(fromEmail, toEmail, body) {
  await ready;
  return db.execute({
    sql: `INSERT INTO family_messages (from_email, to_email, body) VALUES (?, ?, ?)`,
    args: [fromEmail, toEmail, body]
  });
}

async function getMessagesForUser(email, limit = 50) {
  await ready;
  const rs = await db.execute({
    sql: `SELECT id, from_email, body, read, created_at FROM family_messages
          WHERE to_email = ? ORDER BY created_at DESC LIMIT ?`,
    args: [email, limit]
  });
  return rs.rows;
}

async function markMessagesRead(email) {
  await ready;
  const rs = await db.execute({
    sql: `UPDATE family_messages SET read = 1 WHERE to_email = ? AND read = 0`,
    args: [email]
  });
  return { changes: Number(rs.rowsAffected) };
}

module.exports = {
  db, ready, getMemories, saveMemory, deleteMemory, getFamilyAccount, saveFamilyTokens,
  sendFamilyMessage, getMessagesForUser, markMessagesRead
};
