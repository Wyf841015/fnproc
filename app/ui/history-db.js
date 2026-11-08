// app/ui/history-db.js — 采样历史的 SQLite 存储（替代 history.jsonl）
//
// 为什么换掉 JSONL：
//   · 老方案 30 秒追加一行，8MB 后整文件读+重写做轮转 —— 那一瞬间是同步阻塞，
//     正好卡在采样主循环上，前端会看到掉帧。
//   · 查 24 小时要读完整文件再逐行 JSON.parse，行数越多越慢，而且没有聚合。
//   · 老方案按体积轮转，保留多久完全取决于采样密度，说不清。
//
// 现在的做法：
//   · 一行一个采样点，ts 作主键（同一秒重复写就覆盖，天然幂等）
//   · 查询用 SQL 分桶聚合（avg），1 小时 / 24 小时 / 7 天都只回 ≤240 个点
//   · 按时间保留（默认 7 天），每小时裁一次，不再有整文件重写
//   · 掉电丢几行采样无所谓 —— 所以 synchronous=NORMAL，换更低的写放大
//
// 失败时（磁盘满、目录只读、库被锁）不阻塞监控主功能：内存待写队列兜底，
// 并在 /api/history 的 health 字段里明确暴露降级状态，不静默丢数据。

import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, statSync } from 'node:fs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS samples (
  ts    INTEGER PRIMARY KEY,
  cpu   REAL NOT NULL DEFAULT 0,
  mem   REAL NOT NULL DEFAULT 0,
  swap  REAL NOT NULL DEFAULT 0,
  load1 REAL NOT NULL DEFAULT 0,
  rd    REAL NOT NULL DEFAULT 0,
  wr    REAL NOT NULL DEFAULT 0,
  rx    REAL NOT NULL DEFAULT 0,
  tx    REAL NOT NULL DEFAULT 0
);
`;

const FIELDS = ['cpu', 'mem', 'swap', 'load1', 'rd', 'wr', 'rx', 'tx'];

// 分桶粒度：目标是不超过 maxPoints 个点，且不小于 30 秒（原始采样间隔）
export function bucketFor(spanMs, maxPoints = 240) {
  const want = Math.ceil(spanMs / Math.max(30, maxPoints) / 1000 / 30) * 30;
  return Math.max(30, want);
}

export function openHistoryStore(dbPath, { retentionDays = 7, migrateFrom = '', maxPending = 5000 } = {}) {
  let db = null;
  let error = '';
  let insertStmt = null;
  const pending = [];
  let pendingDropped = 0;
  let migrated = 0;

  try {
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(SCHEMA);
    insertStmt = db.prepare(
      `INSERT OR REPLACE INTO samples (ts, ${FIELDS.join(', ')})
       VALUES (?, ${FIELDS.map(() => '?').join(', ')})`,
    );
  } catch (e) {
    error = e.message;
    db = null;
    insertStmt = null;
  }

  const runInsert = (row) => {
    insertStmt.run(
      Math.round(row.ts),
      ...FIELDS.map((f) => Number(row[f]) || 0),
    );
  };

  function flushPending() {
    if (!insertStmt || !pending.length) return;
    try {
      db.exec('BEGIN');
      for (const row of pending.splice(0)) runInsert(row);
      db.exec('COMMIT');
    } catch (e) {
      error = e.message;
      try { db.exec('ROLLBACK'); } catch { /* 忽略 */ }
    }
  }

  // 一次性把历史 jsonl 迁进来（只在 samples 为空时做，避免重复导入）
  function migrate() {
    if (!insertStmt || !migrateFrom || !existsSync(migrateFrom)) return 0;
    try {
      const n = db.prepare('SELECT count(*) AS c FROM samples').get().c;
      if (n > 0) return 0;
      const raw = readFileSync(migrateFrom, 'utf8');
      const rows = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line);
          if (!r || !Number.isFinite(r.ts)) continue;
          rows.push(r);
        } catch { /* 跳过坏行 */ }
      }
      if (!rows.length) return 0;
      db.exec('BEGIN');
      for (const r of rows) runInsert(r);
      db.exec('COMMIT');
      migrated = rows.length;
    } catch (e) {
      error = e.message;
      try { db.exec('ROLLBACK'); } catch { /* 忽略 */ }
      migrated = 0;
    }
    return migrated;
  }

  migrate();

  return {
    enabled: !!db,
    path: dbPath,
    migrated,

    append(row) {
      if (!row || !Number.isFinite(row.ts)) return false;
      if (insertStmt) {
        try {
          if (pending.length) flushPending();
          runInsert(row);
          return true;
        } catch (e) {
          error = e.message;
        }
      }
      pending.push(row);
      if (pending.length > maxPending) { pending.shift(); pendingDropped += 1; }
      return false;
    },

    // 按分钟数查历史；自动分桶，返回 { rows, bucket, source }
    query(minutes, maxPoints = 240) {
      const span = Math.max(60, Math.min(60 * 24 * 31, Number(minutes) || 60)) * 60000;
      const since = Date.now() - span;
      const bucket = bucketFor(span, maxPoints);
      if (!db) return { rows: [], bucket, source: 'none' };
      try {
        // 注意两个单位坑：
        //   ① ts 存的是「毫秒」，bucket 是「秒」—— 必须 ×1000 再算桶，
        //      否则窗口越大越离谱（7 天窗口实测 3682 行一个桶都没合并）。
        //   ② 桶宽必须当「整数字面量」拼进 SQL：命名参数绑定会按 REAL 传，
        //      ts/2520.0 变成浮点除法，每行都落进不同桶，分组直接失效。
        // b 是本模块内部算出的整数，安全。
        const b = Math.round(bucket) * 1000;
        const sql = `
          SELECT (ts / ${b}) * ${b} AS b,
                 avg(cpu) AS cpu, avg(mem) AS mem, avg(swap) AS swap, avg(load1) AS load1,
                 avg(rd) AS rd, avg(wr) AS wr, avg(rx) AS rx, avg(tx) AS tx,
                 count(*) AS n
            FROM samples
           WHERE ts >= :since
           GROUP BY b
           ORDER BY b`;
        const stmt = db.prepare(sql);
        const rows = stmt.all({ since });
        return {
          rows: rows.map((r) => ({
            ts: r.b,
            cpu: Math.round(r.cpu * 10) / 10,
            mem: Math.round(r.mem * 10) / 10,
            swap: Math.round(r.swap * 10) / 10,
            load1: Math.round(r.load1 * 100) / 100,
            rd: Math.round(r.rd), wr: Math.round(r.wr),
            rx: Math.round(r.rx), tx: Math.round(r.tx),
            n: r.n,
          })),
          bucket,
          source: 'sqlite',
        };
      } catch (e) {
        error = e.message;
        return { rows: [], bucket, source: 'error' };
      }
    },

    // 按时间保留，返回删除行数
    prune(days = retentionDays) {
      if (!db) return 0;
      try {
        const cutoff = Date.now() - days * 86400000;
        const info = db.prepare('DELETE FROM samples WHERE ts < ?').run(cutoff);
        return Number(info.changes) || 0;
      } catch (e) {
        error = e.message;
        return 0;
      }
    },

    health() {
      let rows = 0, firstTs = 0, lastTs = 0, size = 0;
      if (db) {
        try {
          const r = db.prepare('SELECT count(*) AS c, min(ts) AS a, max(ts) AS b FROM samples').get();
          rows = r.c || 0; firstTs = r.a || 0; lastTs = r.b || 0;
        } catch { /* 忽略 */ }
        try { size = statSync(dbPath).size; } catch { size = 0; }
      }
      return {
        enabled: !!db, path: dbPath, rows, firstTs, lastTs, size,
        retentionDays, pending: pending.length, pendingDropped,
        migrated, error: error || '',
      };
    },

    close() {
      try { if (db) db.close(); } catch { /* 忽略 */ }
      db = null; insertStmt = null;
    },
  };
}
