const { createClient } = require('@libsql/client');
const path = require('path');
const { bestMatches } = require('./listMatch');

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
  `CREATE INDEX IF NOT EXISTS idx_family_messages_to ON family_messages(to_email, created_at DESC)`,
  // Shared checklists (groceries, packing, chores). The creator owns the list and
  // decides its audience: no list_shares rows means private, one row per person means
  // shared with just them, and a row for every other family member means "everyone".
  `CREATE TABLE IF NOT EXISTS lists (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_email TEXT    NOT NULL,
    name        TEXT    NOT NULL,
    created_at  DATETIME DEFAULT (datetime('now')),
    updated_at  DATETIME DEFAULT (datetime('now'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_lists_owner_name ON lists(owner_email, name COLLATE NOCASE)`,
  `CREATE TABLE IF NOT EXISTS list_shares (
    list_id INTEGER NOT NULL,
    email   TEXT    NOT NULL,
    PRIMARY KEY (list_id, email)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_list_shares_email ON list_shares(email)`,
  `CREATE TABLE IF NOT EXISTS list_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    list_id    INTEGER NOT NULL,
    text       TEXT    NOT NULL,
    done       INTEGER NOT NULL DEFAULT 0,
    added_by   TEXT    NOT NULL,
    position   INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_list_items_list ON list_items(list_id, position)`
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

// ─── Lists ───────────────────────────────────────────────────────────────────
// A user can see a list if they own it or it's been shared with them. Item-level
// edits are open to that whole audience (the point of a shared grocery list);
// renaming, resharing, and deleting stay with the owner — enforced by callers.

const LIST_VISIBLE_SQL = `
  l.owner_email = ?1
  OR EXISTS (SELECT 1 FROM list_shares s WHERE s.list_id = l.id AND s.email = ?1)`;

async function getListShares(listIds) {
  if (!listIds.length) return new Map();
  const placeholders = listIds.map(() => '?').join(',');
  const rs = await db.execute({
    sql: `SELECT list_id, email FROM list_shares WHERE list_id IN (${placeholders})`,
    args: listIds
  });
  const byList = new Map(listIds.map(id => [Number(id), []]));
  for (const row of rs.rows) byList.get(Number(row.list_id))?.push(row.email);
  return byList;
}

// Every list the user can see, each with its share audience and item counts.
async function getVisibleLists(email) {
  await ready;
  const rs = await db.execute({
    sql: `SELECT l.id, l.owner_email, l.name, l.created_at, l.updated_at,
                 (SELECT COUNT(*) FROM list_items i WHERE i.list_id = l.id)                AS total,
                 (SELECT COUNT(*) FROM list_items i WHERE i.list_id = l.id AND i.done = 1) AS done
          FROM lists l
          WHERE ${LIST_VISIBLE_SQL}
          ORDER BY l.updated_at DESC`,
    args: [email]
  });
  const shares = await getListShares(rs.rows.map(r => Number(r.id)));
  return rs.rows.map(r => ({
    id:          Number(r.id),
    owner_email: r.owner_email,
    name:        r.name,
    total:       Number(r.total),
    done:        Number(r.done),
    shared_with: shares.get(Number(r.id)) || [],
    created_at:  r.created_at,
    updated_at:  r.updated_at
  }));
}

// One list plus its ordered items. Returns null when the user can't see it, so callers
// can't tell "not shared with you" apart from "doesn't exist".
async function getListWithItems(listId, email) {
  await ready;
  const rs = await db.execute({
    sql: `SELECT l.id, l.owner_email, l.name, l.created_at, l.updated_at
          FROM lists l WHERE l.id = ?2 AND (${LIST_VISIBLE_SQL})`,
    args: [email, listId]
  });
  const row = rs.rows[0];
  if (!row) return null;
  const items = await db.execute({
    sql: `SELECT id, text, done, added_by, position, created_at FROM list_items
          WHERE list_id = ? ORDER BY position, id`,
    args: [listId]
  });
  const shares = await getListShares([Number(row.id)]);
  return {
    id:          Number(row.id),
    owner_email: row.owner_email,
    name:        row.name,
    shared_with: shares.get(Number(row.id)) || [],
    created_at:  row.created_at,
    updated_at:  row.updated_at,
    items: items.rows.map(i => ({
      id: Number(i.id), text: i.text, done: !!Number(i.done),
      added_by: i.added_by, position: Number(i.position), created_at: i.created_at
    }))
  };
}

// Name lookup for the voice path, fuzzy enough that "the grocery list" finds
// "Groceries". Returns every equally-good match so an ambiguous name can be sent back
// for the user to disambiguate rather than silently picking one.
async function findListsByName(email, name) {
  if (!(name || '').trim()) return [];
  const all = await getVisibleLists(email);
  return bestMatches(name, all, l => l.name);
}

async function createList(ownerEmail, name) {
  await ready;
  const rs = await db.execute({
    sql: `INSERT INTO lists (owner_email, name) VALUES (?, ?)`,
    args: [ownerEmail, name]
  });
  return { id: Number(rs.lastInsertRowid) };
}

async function touchList(listId) {
  return db.execute({
    sql: `UPDATE lists SET updated_at = datetime('now') WHERE id = ?`,
    args: [listId]
  });
}

async function renameList(listId, name) {
  await ready;
  const rs = await db.execute({
    sql: `UPDATE lists SET name = ?, updated_at = datetime('now') WHERE id = ?`,
    args: [name, listId]
  });
  return { changes: Number(rs.rowsAffected) };
}

// Replaces the whole share set — an empty array makes the list private again.
async function setListShares(listId, emails = []) {
  await ready;
  const stmts = [{ sql: `DELETE FROM list_shares WHERE list_id = ?`, args: [listId] }];
  for (const email of [...new Set(emails)]) {
    stmts.push({ sql: `INSERT INTO list_shares (list_id, email) VALUES (?, ?)`, args: [listId, email] });
  }
  stmts.push({ sql: `UPDATE lists SET updated_at = datetime('now') WHERE id = ?`, args: [listId] });
  await db.batch(stmts, 'write');
}

async function deleteList(listId) {
  await ready;
  await db.batch([
    { sql: `DELETE FROM list_items  WHERE list_id = ?`, args: [listId] },
    { sql: `DELETE FROM list_shares WHERE list_id = ?`, args: [listId] },
    { sql: `DELETE FROM lists       WHERE id = ?`,      args: [listId] }
  ], 'write');
  return { changes: 1 };
}

// Appends to the end of the list, skipping anything already on it (case-insensitive) so
// saying "add milk" twice doesn't produce two milks. Reports what was added vs skipped.
async function addListItems(listId, texts, addedBy) {
  await ready;
  const clean = (texts || []).map(t => (t || '').trim()).filter(Boolean);
  if (!clean.length) return { added: [], skipped: [] };

  const existing = await db.execute({
    sql: `SELECT text FROM list_items WHERE list_id = ?`,
    args: [listId]
  });
  const seen = new Set(existing.rows.map(r => r.text.toLowerCase()));

  const maxRs = await db.execute({
    sql: `SELECT COALESCE(MAX(position), 0) AS max_pos FROM list_items WHERE list_id = ?`,
    args: [listId]
  });
  let pos = Number(maxRs.rows[0].max_pos);

  const added = [], skipped = [], stmts = [];
  for (const text of clean) {
    const key = text.toLowerCase();
    if (seen.has(key)) { skipped.push(text); continue; }
    seen.add(key);
    stmts.push({
      sql: `INSERT INTO list_items (list_id, text, added_by, position) VALUES (?, ?, ?, ?)`,
      args: [listId, text, addedBy, ++pos]
    });
    added.push(text);
  }
  if (stmts.length) {
    stmts.push({ sql: `UPDATE lists SET updated_at = datetime('now') WHERE id = ?`, args: [listId] });
    await db.batch(stmts, 'write');
  }
  return { added, skipped };
}

async function setListItemsDone(listId, itemIds, done) {
  await ready;
  if (!itemIds.length) return { changes: 0 };
  const placeholders = itemIds.map(() => '?').join(',');
  const rs = await db.execute({
    sql: `UPDATE list_items SET done = ? WHERE list_id = ? AND id IN (${placeholders})`,
    args: [done ? 1 : 0, listId, ...itemIds]
  });
  await touchList(listId);
  return { changes: Number(rs.rowsAffected) };
}

async function removeListItems(listId, itemIds) {
  await ready;
  if (!itemIds.length) return { changes: 0 };
  const placeholders = itemIds.map(() => '?').join(',');
  const rs = await db.execute({
    sql: `DELETE FROM list_items WHERE list_id = ? AND id IN (${placeholders})`,
    args: [listId, ...itemIds]
  });
  await touchList(listId);
  return { changes: Number(rs.rowsAffected) };
}

async function removeCompletedItems(listId) {
  await ready;
  const rs = await db.execute({
    sql: `DELETE FROM list_items WHERE list_id = ? AND done = 1`,
    args: [listId]
  });
  await touchList(listId);
  return { changes: Number(rs.rowsAffected) };
}

module.exports = {
  db, ready, getMemories, saveMemory, deleteMemory, getFamilyAccount, saveFamilyTokens,
  sendFamilyMessage, getMessagesForUser, markMessagesRead,
  getVisibleLists, getListWithItems, findListsByName, createList, renameList,
  setListShares, deleteList, addListItems, setListItemsDone, removeListItems,
  removeCompletedItems
};
