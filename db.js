const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'scheduleai.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email  TEXT    NOT NULL,
    key         TEXT    NOT NULL,
    value       TEXT    NOT NULL,
    created_at  DATETIME DEFAULT (datetime('now')),
    updated_at  DATETIME DEFAULT (datetime('now')),
    UNIQUE(user_email, key)
  );
  CREATE INDEX IF NOT EXISTS idx_memories_email ON memories(user_email);
`);

const stmtGetAll = db.prepare('SELECT key, value, updated_at FROM memories WHERE user_email = ? ORDER BY updated_at DESC');
const stmtUpsert = db.prepare(`
  INSERT INTO memories (user_email, key, value, updated_at)
  VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT(user_email, key) DO UPDATE SET
    value      = excluded.value,
    updated_at = excluded.updated_at
`);
const stmtDelete = db.prepare('DELETE FROM memories WHERE user_email = ? AND key = ?');

module.exports = {
  getMemories:  (email)             => stmtGetAll.all(email),
  saveMemory:   (email, key, value) => stmtUpsert.run(email, key, value),
  deleteMemory: (email, key)        => stmtDelete.run(email, key)
};
