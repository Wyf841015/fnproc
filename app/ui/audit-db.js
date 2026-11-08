// app/ui/audit-db.js — 操作审计的 SQLite 落盘存储
//
// 为什么要落盘：审计的意义在于「事后可追」，内存环形缓冲在进程重启、崩溃、
// 系统断电后就什么都不剩了。这里用 Node 24 内置的 node:sqlite（零依赖）。
//
// 「确保记录一直不丢失」落到具体做法上是四条：
//   ① journal_mode = WAL         —— 写 WAL 文件而不是重写整个库，崩溃后能恢复
//   ② synchronous  = FULL        —— 每次 COMMIT 都 fsync，掉电也不丢已提交的记录
//   ③ 写入是同步的，且在回 HTTP 响应之前完成 —— 客户端收到 200/400 时，
//      这条记录已经在磁盘上了，不存在「操作成功但没记下来」
//   ④ 从不自动删除 —— 不做保留期、不做条数上限轮转。审计只增不减
//
// 失败时的行为：SQLite 打不开（目录只读、磁盘满、被别的进程锁死）时，
// 不阻塞业务功能 —— 记到内存待写队列，下一次写入成功时补写进去，
// 同时在 /api/audit/health 里明确暴露 degraded 状态与原因，不允许静默丢记录。

import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync } from 'node:fs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  action    TEXT    NOT NULL,
  target    TEXT    NOT NULL DEFAULT '',
  result    TEXT    NOT NULL,
  message   TEXT    NOT NULL DEFAULT '',
  client    TEXT    NOT NULL DEFAULT '',
  detail    TEXT    NOT NULL DEFAULT '{}',
  version   TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_ts     ON audit(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit(action);
CREATE INDEX IF NOT EXISTS idx_audit_result ON audit(result);
`;

// 老前端用的是 {at, kind, pid, signal, name, user, ok, error} 这套字段，
// 新版用 {action, target, result, message, client, detail}。这里同时给出两套，
// 保证旧调用方与旧页面不需要同步改动就能继续工作。
export function toLegacy(row) {
  let detail = {};
  try { detail = JSON.parse(row.detail || '{}'); } catch { /* 坏 JSON 忽略 */ }
  const [kind, sub] = String(row.action || '').split('.');
  return {
    // 新字段
    id: row.id,
    action: row.action,
    target: row.target,
    result: row.result,
    message: row.message || '',
    client: row.client || '',
    detail,
    // 旧字段（兼容）
    at: new Date(row.ts).toISOString(),
    ts: row.ts,
    kind,
    // 老前端的 signal：kill 类要的是信号名（SIGTERM…），服务类要的是动作（start…）
    signal: detail.signal || sub || row.action,
    name: row.target,
    pid: detail.pid ?? null,
    user: detail.user ?? '',
    ok: row.result === 'ok',
    error: row.result === 'ok' ? undefined : (row.message || ''),
  };
}

export function openAuditStore(dbPath, { version = '' } = {}) {
  let db = null;
  let error = '';
  const pending = [];          // 未落盘的记录（DB 不可用时暂存）
  let pendingDropped = 0;

  try {
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(SCHEMA);
  } catch (e) {
    error = String(e.message || e);
    try { db?.close(); } catch { /* 忽略 */ }
    db = null;
  }

  const insertStmt = db ? db.prepare(
    `INSERT INTO audit (ts, action, target, result, message, client, detail, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ) : null;

  function writeOne(rec) {
    const info = insertStmt.run(
      rec.ts, rec.action, rec.target, rec.result,
      rec.message, rec.client, rec.detail, rec.version,
    );
    return Number(info.lastInsertRowid);
  }

  // 落盘时把 detail 统一成字符串（node:sqlite 只接受 null/number/string/bigint/Buffer）
  function normalize(input) {
    const detail = input.detail == null ? {}
      : (typeof input.detail === 'string' ? safeParse(input.detail) : input.detail);
    return {
      ts: Number(input.ts) || Date.now(),
      action: String(input.action || 'unknown').slice(0, 64),
      target: String(input.target ?? '').slice(0, 256),
      result: String(input.result || 'ok').slice(0, 16),
      message: String(input.message ?? '').slice(0, 512),
      client: String(input.client ?? '').slice(0, 128),
      detail: safeDetail(detail),
      version: String(input.version ?? version).slice(0, 32),
    };
  }

  function safeParse(s) {
    try { return JSON.parse(s); } catch { return { raw: String(s).slice(0, 500) }; }
  }

  /**
   * 记录一条操作。同步落盘；DB 不可用时进待写队列并返回 null。
   * 调用方应该在回 HTTP 响应之前调用它 —— 这样「响应成功」就等于「已记录」。
   */
  function record(input) {
    const rec = normalize(input);
    if (!insertStmt) {
      pending.push(rec);
      if (pending.length > 5000) { pending.shift(); pendingDropped += 1; }
      return null;
    }
    try {
      // 先把之前欠的补写掉（DB 刚恢复时）
      while (pending.length) {
        const p = pending[0];
        try { writeOne(p); pending.shift(); } catch { break; }
      }
      return writeOne(rec);
    } catch (e) {
      error = String(e.message || e);
      pending.push(rec);
      if (pending.length > 5000) { pending.shift(); pendingDropped += 1; }
      return null;
    }
  }

  // detail 截断必须保证仍是合法 JSON：直接 slice 字符串会切在 token 中间，
  // 读侧 JSON.parse 失败后静默变 {}，管理员看到空白 detail 却不知道被截断过
  function safeDetail(detail) {
    if (detail == null) return null;
    let s;
    try { s = JSON.stringify(detail); } catch { return JSON.stringify({ _error: '无法序列化' }); }
    if (s.length <= 4096) return s;
    return JSON.stringify({ _truncated: true, preview: s.slice(0, 3800) });
  }

  function list({ limit = 50, offset = 0, q = '', action = '', result = '', since = 0 } = {}) {
    if (!db) {
      const rows = pending.slice().reverse().map((r, i) => toLegacy({ ...r, id: pending.length - i }));
      return { rows, total: rows.length, degraded: true };
    }
    const where = [];
    const args = [];
    if (action) { where.push('action LIKE ?'); args.push(action + '%'); }
    if (result) { where.push('result = ?'); args.push(result); }
    if (since) { where.push('ts >= ?'); args.push(Number(since) || 0); }
    if (q) {
      where.push('(target LIKE ? OR message LIKE ? OR action LIKE ? OR detail LIKE ?)');
      const like = `%${q}%`;
      args.push(like, like, like, like);
    }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const lim = Math.min(5000, Math.max(1, Number(limit) || 50));
    const off = Math.max(0, Number(offset) || 0);
    try {
      const total = db.prepare(`SELECT COUNT(*) AS c FROM audit ${clause}`).get(...args).c;
      const rows = db.prepare(
        `SELECT * FROM audit ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`
      ).all(...args, lim, off);
      return { rows: rows.map(toLegacy), total: Number(total), degraded: false };
    } catch (e) {
      error = String(e.message || e);
      return { rows: [], total: 0, degraded: true, error };
    }
  }

  function stats() {
    if (!db) return { total: 0, degraded: true };
    try {
      const total = Number(db.prepare('SELECT COUNT(*) AS c FROM audit').get().c);
      const byResult = db.prepare('SELECT result, COUNT(*) AS c FROM audit GROUP BY result').all()
        .map((r) => ({ result: r.result, count: Number(r.c) }));
      const byAction = db.prepare('SELECT action, COUNT(*) AS c FROM audit GROUP BY action ORDER BY c DESC LIMIT 12').all()
        .map((r) => ({ action: r.action, count: Number(r.c) }));
      const span = db.prepare('SELECT MIN(ts) AS first, MAX(ts) AS last FROM audit').get();
      return {
        total, byResult, byAction,
        firstTs: span.first == null ? null : Number(span.first),
        lastTs: span.last == null ? null : Number(span.last),
        degraded: false,
      };
    } catch (e) {
      return { total: 0, degraded: true, error: String(e.message || e) };
    }
  }

  function health() {
    const out = {
      enabled: !!db,
      path: dbPath,
      pending: pending.length,
      dropped: pendingDropped,
      error: error || null,
    };
    if (!db) return out;
    try {
      out.journalMode = db.prepare('PRAGMA journal_mode').get().journal_mode;
      out.synchronous = db.prepare('PRAGMA synchronous').get().synchronous;
      out.integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
      out.sizeBytes = existsSync(dbPath) ? statSync(dbPath).size : 0;
      const wal = dbPath + '-wal';
      out.walBytes = existsSync(wal) ? statSync(wal).size : 0;
      out.total = Number(db.prepare('SELECT COUNT(*) AS c FROM audit').get().c);
    } catch (e) {
      out.error = String(e.message || e);
    }
    return out;
  }

  function close() {
    try { db?.close(); } catch { /* 忽略 */ }
    db = null;
  }

  return { record, list, stats, health, close, get enabled() { return !!db; } };
}
