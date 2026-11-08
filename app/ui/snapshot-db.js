// app/ui/snapshot-db.js — 进程快照与对比
//
// 场景：过两天回头看「内存为什么涨了 300MB」「服务是不是偷偷重启过」，
// 单看曲线看不出是谁干的。这里把某个时刻的进程清单（pid / 名字 / 命令行 / 内存）
// 存下来，两个快照一比就知道：谁新起了、谁没了、谁的内存涨了。
//
// 为什么用 SQLite 而不是内存：快照的价值就在于「跨天对比」，
// 存内存里进程一重启就没了。保留期默认 30 天，避免无限膨胀。

import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS snapshots (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     INTEGER NOT NULL,
  label  TEXT    NOT NULL DEFAULT '',
  count  INTEGER NOT NULL DEFAULT 0,
  version TEXT   NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS snapshot_items (
  snapshot_id INTEGER NOT NULL,
  pid         INTEGER NOT NULL,
  name        TEXT    NOT NULL DEFAULT '',
  cmd         TEXT    NOT NULL DEFAULT '',
  user        TEXT    NOT NULL DEFAULT '',
  rss         INTEGER NOT NULL DEFAULT 0,
  cpu         REAL    NOT NULL DEFAULT 0,
  threads     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (snapshot_id, pid)
);
CREATE INDEX IF NOT EXISTS idx_snapshot_items_sid ON snapshot_items(snapshot_id);
`;

export function openSnapshotStore(dbPath, { retentionDays = 30, version = '' } = {}) {
  let db = null;
  let error = '';
  try {
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(SCHEMA);
  } catch (e) {
    error = e.message;
    db = null;
  }

  return {
    enabled: !!db,
    path: dbPath,

    save(list, label = '') {
      if (!db) return { ok: false, error: '快照库不可用' };
      try {
        db.exec('BEGIN');
        const info = db.prepare('INSERT INTO snapshots (ts, label, count, version) VALUES (?, ?, ?, ?)')
          .run(Date.now(), String(label).slice(0, 120), list.length, version);
        const sid = Number(info.lastInsertRowid);
        const stmt = db.prepare(
          'INSERT OR REPLACE INTO snapshot_items (snapshot_id, pid, name, cmd, user, rss, cpu, threads) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        );
        for (const p of list) {
          stmt.run(sid, p.pid, String(p.name || '').slice(0, 200), String(p.cmd || '').slice(0, 400),
            String(p.user || '').slice(0, 60), Number(p.rss) || 0, Number(p.cpuPct) || 0, Number(p.threads) || 0);
        }
        db.exec('COMMIT');
        this.prune(retentionDays);
        return { ok: true, id: sid, count: list.length, ts: Date.now() };
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* 忽略 */ }
        error = e.message;
        return { ok: false, error: e.message };
      }
    },

    list(limit = 50) {
      if (!db) return [];
      try {
        return db.prepare('SELECT id, ts, label, count, version FROM snapshots ORDER BY ts DESC LIMIT ?')
          .all(Math.max(1, Math.min(200, Number(limit) || 50)));
      } catch { return []; }
    },

    remove(id) {
      if (!db) return { ok: false, error: '快照库不可用' };
      try {
        db.exec('BEGIN');
        db.prepare('DELETE FROM snapshot_items WHERE snapshot_id = ?').run(Number(id) || 0);
        const info = db.prepare('DELETE FROM snapshots WHERE id = ?').run(Number(id) || 0);
        db.exec('COMMIT');
        return { ok: true, removed: Number(info.changes) || 0 };
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* 忽略 */ }
        return { ok: false, error: e.message };
      }
    },

    items(id) {
      if (!db) return [];
      try {
        return db.prepare('SELECT pid, name, cmd, user, rss, cpu, threads FROM snapshot_items WHERE snapshot_id = ?')
          .all(Number(id) || 0);
      } catch { return []; }
    },

    // 两个快照对比：新增 / 消失 / 内存变化最大的
    diff(idA, idB) {
      const a = new Map(this.items(idA).map((x) => [x.pid, x]));
      const b = new Map(this.items(idB).map((x) => [x.pid, x]));
      const added = [];
      const removed = [];
      const changed = [];
      for (const [pid, x] of b) {
        if (!a.has(pid)) { added.push(x); continue; }
        const old = a.get(pid);
        const delta = (x.rss || 0) - (old.rss || 0);
        if (Math.abs(delta) > 1024 * 1024) {           // 内存变化超过 1MB 才列出来
          changed.push({ ...x, rssBefore: old.rss, delta });
        }
      }
      for (const [pid, x] of a) if (!b.has(pid)) removed.push(x);
      changed.sort((p, q) => Math.abs(q.delta) - Math.abs(p.delta));
      added.sort((p, q) => q.rss - p.rss);
      removed.sort((p, q) => q.rss - p.rss);
      return { added, removed, changed };
    },

    prune(days = retentionDays) {
      if (!db) return 0;
      try {
        const cutoff = Date.now() - days * 86400000;
        const ids = db.prepare('SELECT id FROM snapshots WHERE ts < ?').all(cutoff).map((r) => r.id);
        if (!ids.length) return 0;
        db.exec('BEGIN');
        for (const id of ids) {
          db.prepare('DELETE FROM snapshot_items WHERE snapshot_id = ?').run(id);
          db.prepare('DELETE FROM snapshots WHERE id = ?').run(id);
        }
        db.exec('COMMIT');
        return ids.length;
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* 忽略 */ }
        error = e.message;
        return 0;
      }
    },

    health() {
      let total = 0, oldest = 0;
      if (db) {
        try {
          const r = db.prepare('SELECT count(*) AS c, min(ts) AS o FROM snapshots').get();
          total = r.c || 0; oldest = r.o || 0;
        } catch { /* 忽略 */ }
      }
      return { enabled: !!db, path: dbPath, snapshots: total, oldest, retentionDays, error: error || '' };
    },

    close() { try { if (db) db.close(); } catch { /* 忽略 */ } db = null; },
  };
}
