const session = require('express-session');
const { db, ready } = require('./db');

// express-session store backed by the same libsql database as memories, so sessions
// (which hold Google OAuth tokens) survive across serverless invocations instead of
// living in the default in-memory store, which resets per Vercel function instance.
class LibsqlStore extends session.Store {
  async get(sid, cb) {
    try {
      await ready;
      const rs = await db.execute({
        sql: 'SELECT sess FROM sessions WHERE sid = ? AND expires > ?',
        args: [sid, Date.now()]
      });
      const row = rs.rows[0];
      cb(null, row ? JSON.parse(row.sess) : null);
    } catch (err) {
      cb(err);
    }
  }

  async set(sid, sess, cb) {
    try {
      await ready;
      const expires = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 24 * 60 * 60 * 1000;
      await db.execute({
        sql: `INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
              ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires`,
        args: [sid, JSON.stringify(sess), expires]
      });
      cb?.(null);
    } catch (err) {
      cb?.(err);
    }
  }

  async destroy(sid, cb) {
    try {
      await ready;
      await db.execute({ sql: 'DELETE FROM sessions WHERE sid = ?', args: [sid] });
      cb?.(null);
    } catch (err) {
      cb?.(err);
    }
  }

  async touch(sid, sess, cb) {
    this.set(sid, sess, cb);
  }
}

module.exports = LibsqlStore;
