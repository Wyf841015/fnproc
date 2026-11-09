// app/ui/alert-db.js — 告警规则与告警事件的 SQLite 存储
//
// 为什么规则也要落库：规则是用户配置，重启进程管家（升级、崩溃、断电）不能丢。
// 事件同理 —— 「谁在什么时候报过什么警、有没有真的送到」是事后复盘的关键，
// 放在内存里等于没有。
//
// 表设计取舍：
//   · 规则表存「判据」（metric/op/threshold/duration/target）+ 通知方式 + 冷却时间，
//     判据用字符串而不是布尔列，加新指标不用改表结构
//   · 事件表每次触发写一行，带 delivered 字段记录每个通道的投递结果（成功/失败原因），
//     「通知没收到」这类问题必须能查，不能只有一句「已触发」
//   · 事件不做自动清理（和审计库保持一致的风格）

import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS alert_rules (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  metric        TEXT    NOT NULL,
  op            TEXT    NOT NULL DEFAULT '>',
  threshold     REAL    NOT NULL DEFAULT 0,
  duration_sec  INTEGER NOT NULL DEFAULT 60,
  target        TEXT    NOT NULL DEFAULT '',
  level         INTEGER NOT NULL DEFAULT 1,
  notify_fn     INTEGER NOT NULL DEFAULT 1,
  webhook       TEXT    NOT NULL DEFAULT '',
  cooldown_sec  INTEGER NOT NULL DEFAULT 600,
  last_fired    INTEGER NOT NULL DEFAULT 0,
  created       INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS alert_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  rule_id    INTEGER NOT NULL DEFAULT 0,
  rule_name  TEXT    NOT NULL DEFAULT '',
  metric     TEXT    NOT NULL DEFAULT '',
  value      REAL    NOT NULL DEFAULT 0,
  level      INTEGER NOT NULL DEFAULT 1,
  message    TEXT    NOT NULL DEFAULT '',
  delivered  TEXT    NOT NULL DEFAULT '{}',
  version    TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_alert_events_ts ON alert_events(ts DESC);
CREATE TABLE IF NOT EXISTS pinned_services (
  name   TEXT PRIMARY KEY,
  ts     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS proc_watches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  pattern     TEXT    NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  baseline    TEXT    NOT NULL DEFAULT '[]',
  last_check  INTEGER NOT NULL DEFAULT 0,
  seen_count  INTEGER NOT NULL DEFAULT 0,
  created     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_proc_watches_enabled ON proc_watches(enabled);
CREATE TABLE IF NOT EXISTS watch_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  watch_id   INTEGER NOT NULL DEFAULT 0,
  watch_name TEXT    NOT NULL DEFAULT '',
  kind       TEXT    NOT NULL DEFAULT 'appear',
  pid        INTEGER NOT NULL DEFAULT 0,
  pname      TEXT    NOT NULL DEFAULT '',
  cmd        TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_watch_events_ts ON watch_events(ts DESC);
CREATE TABLE IF NOT EXISTS watchdogs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  match        TEXT    NOT NULL,
  command      TEXT    NOT NULL DEFAULT '',
  enabled      INTEGER NOT NULL DEFAULT 0,
  cooldown_sec INTEGER NOT NULL DEFAULT 300,
  last_run     INTEGER NOT NULL DEFAULT 0,
  runs         INTEGER NOT NULL DEFAULT 0,
  created      INTEGER NOT NULL DEFAULT 0
);
`;

// 支持的判据：metric → 人类可读说明（前端也用它做提示）
export const METRICS = {
  cpu: { label: 'CPU 使用率', unit: '%', needTarget: false },
  mem: { label: '内存使用率', unit: '%', needTarget: false },
  swap: { label: 'Swap 使用率', unit: '%', needTarget: false },
  disk: { label: '磁盘使用率', unit: '%', needTarget: true, targetHint: '挂载点，如 /vol1' },
  psi_mem: { label: '内存压力（PSI）', unit: '%', needTarget: false },
  proc_missing: { label: '进程不存在', unit: '', needTarget: true, targetHint: '进程名或 PID' },
  unit_failed: { label: 'systemd 单元异常', unit: '', needTarget: true, targetHint: '单元名，如 nginx.service' },
  oom: { label: 'OOM 杀进程次数', unit: '次', needTarget: false },
};

const RULE_FIELDS = [
  'name', 'enabled', 'metric', 'op', 'threshold', 'duration_sec',
  'target', 'level', 'notify_fn', 'webhook', 'cooldown_sec', 'last_fired',
];

export const LEVEL_LABEL = { 0: '普通', 1: '警告', 2: '严重' };

export function openAlertStore(dbPath, { version = '' } = {}) {
  let db = null;
  let error = '';
  try {
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(SCHEMA);
  } catch (e) {
    error = e.message;
    db = null;
  }

  function rowToRule(r) {
    return {
      id: r.id,
      name: r.name,
      enabled: !!r.enabled,
      metric: r.metric,
      op: r.op,
      threshold: r.threshold,
      durationSec: r.duration_sec,
      target: r.target,
      level: r.level,
      notifyFn: !!r.notify_fn,
      webhook: r.webhook,
      cooldownSec: r.cooldown_sec,
      lastFired: r.last_fired,
      created: r.created,
    };
  }

  return {
    enabled: !!db,
    path: dbPath,

    listRules() {
      if (!db) return [];
      try {
        return db.prepare('SELECT * FROM alert_rules ORDER BY id').all().map(rowToRule);
      } catch { return []; }
    },

    // 新建或更新（带 id 就是更新）
    saveRule(input) {
      if (!db) return { ok: false, error: '告警库不可用' };
      const name = String(input.name || '').trim().slice(0, 80);
      const metric = String(input.metric || '').trim();
      if (!name) return { ok: false, error: '规则名不能为空' };
      if (!METRICS[metric]) return { ok: false, error: '不支持的判据：' + metric };
      // op 缺省时：更新保留原值，新建才用 '>'
      // （早期无论新建更新都退回 '>'，导致前端不带 op 时把「磁盘可用 < 10%」改成「> 10%」）
      const prev = Number(input.id)
        ? (db ? (db.prepare('SELECT op FROM alert_rules WHERE id = ?').get(Number(input.id)) || {}).op : null)
        : null;
      const op = ['>', '<', '==', 'missing', 'failed'].includes(input.op)
        ? input.op
        : (prev || '>');
      const values = {
        name,
        enabled: input.enabled === false ? 0 : 1,
        metric,
        op,
        threshold: Number(input.threshold) || 0,
        duration_sec: Math.max(0, Math.min(86400, Math.round(Number(input.durationSec) || 0))),
        target: String(input.target || '').trim().slice(0, 200),
        level: [0, 1, 2].includes(Number(input.level)) ? Number(input.level) : 1,
        notify_fn: input.notifyFn === false ? 0 : 1,
        webhook: String(input.webhook || '').trim().slice(0, 500),
        cooldown_sec: Math.max(30, Math.min(86400, Math.round(Number(input.cooldownSec) || 600))),
      };
      if (METRICS[metric].needTarget && !values.target) {
        return { ok: false, error: `${METRICS[metric].label} 必须填写目标（${METRICS[metric].targetHint}）` };
      }
      try {
        const id = Number(input.id) || 0;
        if (id) {
          const sets = RULE_FIELDS.filter((f) => f !== 'last_fired').map((f) => `${f} = ?`).join(', ');
          db.prepare(`UPDATE alert_rules SET ${sets} WHERE id = ?`)
            .run(...RULE_FIELDS.filter((f) => f !== 'last_fired').map((f) => values[f]), id);
          return { ok: true, id };
        }
        const cols = RULE_FIELDS.filter((f) => f !== 'last_fired');
        const stmt = db.prepare(
          `INSERT INTO alert_rules (${cols.join(', ')}, created) VALUES (${cols.map(() => '?').join(', ')}, ?)`,
        );
        const info = stmt.run(...cols.map((f) => values[f]), Date.now());
        return { ok: true, id: Number(info.lastInsertRowid) };
      } catch (e) {
        error = e.message;
        return { ok: false, error: e.message };
      }
    },

    deleteRule(id) {
      if (!db) return { ok: false, error: '告警库不可用' };
      try {
        const info = db.prepare('DELETE FROM alert_rules WHERE id = ?').run(Number(id) || 0);
        return { ok: true, removed: Number(info.changes) || 0 };
      } catch (e) {
        error = e.message;
        return { ok: false, error: e.message };
      }
    },

    touchFired(id, ts = Date.now()) {
      if (!db) return;
      try { db.prepare('UPDATE alert_rules SET last_fired = ? WHERE id = ?').run(ts, id); } catch { /* 忽略 */ }
    },

    addEvent({ ts = Date.now(), ruleId = 0, ruleName = '', metric = '', value = 0, level = 1, message = '', delivered = {} }) {
      if (!db) return 0;
      try {
        const info = db.prepare(
          `INSERT INTO alert_events (ts, rule_id, rule_name, metric, value, level, message, delivered, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(ts, ruleId, ruleName, metric, Number(value) || 0, level, String(message).slice(0, 1000),
          JSON.stringify(delivered), version);
        return Number(info.lastInsertRowid) || 0;
      } catch (e) {
        error = e.message;
        return 0;
      }
    },

    // ── 看门狗（进程消失后执行命令）────────────────────────────────────
    // ── 关注的服务（钉在服务列表顶部） ──────────────────────────────────
    listPinned() {
      if (!db) return [];
      try { return db.prepare('SELECT name FROM pinned_services ORDER BY ts ASC').all().map((r) => r.name); }
      catch { return []; }
    },

    setPinned(name, pinned) {
      if (!db) return { ok: false, error: '库不可用' };
      const n = String(name || '').trim();
      if (!n) return { ok: false, error: '服务名不能为空' };
      try {
        if (pinned) db.prepare('INSERT OR REPLACE INTO pinned_services (name, ts) VALUES (?, ?)').run(n, Date.now());
        else db.prepare('DELETE FROM pinned_services WHERE name = ?').run(n);
        return { ok: true, pinned: !!pinned };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    // ── 进程追踪：记录某个模式下的进程集合变化 ──────────────────────────
    // 只观察、不执行任何命令（与看门狗的区别就在这里）。
    listWatches() {
      if (!db) return [];
      try {
        return db.prepare('SELECT id, name, pattern, enabled, baseline, last_check, seen_count, created FROM proc_watches ORDER BY id ASC')
          .all().map((r) => {
            let base = [];
            try { base = JSON.parse(r.baseline || '[]'); } catch { base = []; }
            return {
              id: r.id, name: r.name, pattern: r.pattern, enabled: !!r.enabled,
              baselineCount: base.length, baseline: base,
              lastCheck: r.last_check, seenCount: r.seen_count, created: r.created,
            };
          });
      } catch { return []; }
    },

    saveWatch(input = {}) {
      if (!db) return { ok: false, error: '库不可用' };
      const name = String(input.name || '').trim();
      const pattern = String(input.pattern || '').trim();
      if (!name) return { ok: false, error: '名称不能为空' };
      if (!pattern) return { ok: false, error: '匹配关键字不能为空' };
      if (pattern.length > 120) return { ok: false, error: '匹配关键字过长（上限 120）' };
      const enabled = typeof input.enabled === 'boolean' ? (input.enabled ? 1 : 0) : 1;
      const id = Number(input.id) || 0;
      try {
        if (id) {
          const prev = db.prepare('SELECT id FROM proc_watches WHERE id = ?').get(id);
          if (!prev) return { ok: false, error: '追踪不存在' };
          // 改关键字就重设基准，否则新旧模式的进程集合会被混为一谈
          const old = db.prepare('SELECT pattern FROM proc_watches WHERE id = ?').get(id);
          const reset = old && old.pattern !== pattern;
          db.prepare(`UPDATE proc_watches SET name = ?, pattern = ?, enabled = ?${reset ? ', baseline = \'[]\'' : ''} WHERE id = ?`)
            .run(name, pattern, enabled, id);
          return { ok: true, id };
        }
        const info = db.prepare('INSERT INTO proc_watches (name, pattern, enabled, baseline, created) VALUES (?, ?, ?, \'[]\', ?)')
          .run(name, pattern, enabled, Date.now());
        return { ok: true, id: Number(info.lastInsertRowid) };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    deleteWatch(id) {
      if (!db) return false;
      try {
        db.prepare('DELETE FROM proc_watches WHERE id = ?').run(Number(id) || 0);
        db.prepare('DELETE FROM watch_events WHERE watch_id = ?').run(Number(id) || 0);
        return true;
      } catch { return false; }
    },

    updateWatchBaseline(id, pids, ts = Date.now()) {
      if (!db) return false;
      try {
        db.prepare('UPDATE proc_watches SET baseline = ?, last_check = ?, seen_count = ? WHERE id = ?')
          .run(JSON.stringify(pids.map(Number).filter((n) => n > 0).slice(0, 2000)), ts, pids.length, Number(id) || 0);
        return true;
      } catch { return false; }
    },

    addWatchEvent({ ts = Date.now(), watchId = 0, watchName = '', kind = 'appear', pid = 0, pname = '', cmd = '' }) {
      if (!db) return false;
      try {
        db.prepare('INSERT INTO watch_events (ts, watch_id, watch_name, kind, pid, pname, cmd) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(ts, Number(watchId) || 0, String(watchName || '').slice(0, 120), String(kind || 'appear').slice(0, 20),
            Number(pid) || 0, String(pname || '').slice(0, 120), String(cmd || '').slice(0, 400));
        return true;
      } catch { return false; }
    },

    listWatchEvents({ limit = 100, watchId = 0 } = {}) {
      if (!db) return { rows: [], total: 0 };
      const lim = Math.max(1, Math.min(1000, Number(limit) || 100));
      try {
        const where = Number(watchId) ? 'WHERE watch_id = ?' : '';
        const args = Number(watchId) ? [Number(watchId)] : [];
        const rows = db.prepare(`SELECT * FROM watch_events ${where} ORDER BY ts DESC LIMIT ${lim}`).all(...args);
        const total = (db.prepare(`SELECT count(*) AS c FROM watch_events ${where}`).get(...args) || {}).c || 0;
        return { rows, total };
      } catch { return { rows: [], total: 0 }; }
    },

    pruneWatchEvents(days = 30) {
      if (!db) return 0;
      try {
        const cutoff = Date.now() - Math.max(1, days) * 86400000;
        return Number(db.prepare('DELETE FROM watch_events WHERE ts < ?').run(cutoff).changes) || 0;
      } catch { return 0; }
    },

    listWatchdogs() {
      if (!db) return [];
      try {
        return db.prepare('SELECT * FROM watchdogs ORDER BY id').all().map((r) => ({
          id: r.id, name: r.name, match: r.match, command: r.command,
          enabled: !!r.enabled, cooldownSec: r.cooldown_sec,
          lastRun: r.last_run, runs: r.runs, created: r.created,
        }));
      } catch { return []; }
    },

    saveWatchdog(input) {
      if (!db) return { ok: false, error: '告警库不可用' };
      const name = String(input.name || '').trim().slice(0, 80);
      const match = String(input.match || '').trim().slice(0, 200);
      const command = String(input.command || '').trim().slice(0, 1000);
      if (!name) return { ok: false, error: '名称不能为空' };
      if (!match) return { ok: false, error: '必须填写要监视的进程（名称或 PID）' };
      if (!command) return { ok: false, error: '必须填写要执行的命令' };
      try {
        const id = Number(input.id) || 0;
        const vals = [name, match, command, input.enabled ? 1 : 0,
          Math.max(30, Math.min(86400, Math.round(Number(input.cooldownSec) || 300)))];
        if (id) {
          db.prepare('UPDATE watchdogs SET name=?, match=?, command=?, enabled=?, cooldown_sec=? WHERE id=?')
            .run(...vals, id);
          return { ok: true, id };
        }
        const info = db.prepare(
          'INSERT INTO watchdogs (name, match, command, enabled, cooldown_sec, created) VALUES (?,?,?,?,?,?)',
        ).run(...vals, Date.now());
        return { ok: true, id: Number(info.lastInsertRowid) };
      } catch (e) {
        error = e.message;
        return { ok: false, error: e.message };
      }
    },

    deleteWatchdog(id) {
      if (!db) return { ok: false, error: '告警库不可用' };
      try {
        const info = db.prepare('DELETE FROM watchdogs WHERE id = ?').run(Number(id) || 0);
        return { ok: true, removed: Number(info.changes) || 0 };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    touchWatchdog(id, ts = Date.now()) {
      if (!db) return;
      try { db.prepare('UPDATE watchdogs SET last_run = ?, runs = runs + 1 WHERE id = ?').run(ts, id); } catch { /* 忽略 */ }
    },

    listEvents({ limit = 100, offset = 0, level = '', ruleId = 0 } = {}) {
      if (!db) return { rows: [], total: 0 };
      try {
        const where = [];
        const args = [];
        if (level !== '' && level != null && Number.isFinite(Number(level))) { where.push('level = ?'); args.push(Number(level)); }
        if (ruleId) { where.push('rule_id = ?'); args.push(Number(ruleId)); }
        const tail = where.length ? ' WHERE ' + where.join(' AND ') : '';
        const total = db.prepare(`SELECT count(*) AS c FROM alert_events${tail}`).get(...args).c;
        const rows = db.prepare(
          `SELECT * FROM alert_events${tail} ORDER BY ts DESC LIMIT ? OFFSET ?`,
        ).all(...args, Math.max(1, Math.min(1000, Number(limit) || 100)), Math.max(0, Number(offset) || 0));
        return {
          total,
          rows: rows.map((r) => {
            let delivered = {};
            try { delivered = JSON.parse(r.delivered || '{}'); } catch { /* 坏 JSON 忽略 */ }
            return {
              id: r.id, ts: r.ts, ruleId: r.rule_id, ruleName: r.rule_name,
              metric: r.metric, value: r.value, level: r.level,
              message: r.message, delivered, version: r.version,
            };
          }),
        };
      } catch (e) {
        error = e.message;
        return { rows: [], total: 0 };
      }
    },

    // 告警事件保留期裁剪：这个表只增不删，长期跑必须定期裁，否则磁盘被慢慢吃满
    pruneEvents(days = 180) {
      if (!db) return 0;
      try {
        const cutoff = Date.now() - Math.max(1, days) * 86400000;
        const info = db.prepare('DELETE FROM alert_events WHERE ts < ?').run(cutoff);
        return Number(info.changes) || 0;
      } catch { return 0; }
    },

    stats() {
      if (!db) return { rules: 0, enabled: 0, events: 0, lastEventTs: 0 };
      try {
        const r = db.prepare('SELECT count(*) AS c, sum(enabled) AS e FROM alert_rules').get();
        const ev = db.prepare('SELECT count(*) AS c, max(ts) AS m FROM alert_events').get();
        const wd = db.prepare('SELECT count(*) AS c FROM watchdogs').get();
        return { rules: r.c || 0, enabled: r.e || 0, events: ev.c || 0, lastEventTs: ev.m || 0, watchdogs: wd.c || 0 };
      } catch { return { rules: 0, enabled: 0, events: 0, lastEventTs: 0 }; }
    },

    health() {
      return { enabled: !!db, path: dbPath, error: error || '', ...this.stats() };
    },

    close() { try { if (db) db.close(); } catch { /* 忽略 */ } db = null; },
  };
}
