// tests/test_audit_db.mjs — 审计 SQLite 存储的回归测试
// 跑法: node --test tests/test_audit_db.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAuditStore, toLegacy } from '../app/ui/audit-db.js';

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'fnproc-audit-'));
}

test('写入 / 查询：三条记录能按时间倒序读回来', () => {
  const dir = freshDir();
  const store = openAuditStore(join(dir, 'audit.db'), { version: 'test' });
  try {
    assert.equal(store.enabled, true);
    const id1 = store.record({ action: 'kill', target: '1234', result: 'ok', message: 'SIGTERM nginx', client: 'uid:1000', detail: { pid: 1234, signal: 'SIGTERM', name: 'nginx', user: 'root' } });
    const id2 = store.record({ action: 'service.stop', target: 'nmbd.service', result: 'ok', message: 'stop nmbd.service' });
    const id3 = store.record({ action: 'kill', target: '1', result: 'rejected', message: '拒绝：PID 必须 > 1（不能动 init）' });
    assert.ok(id1 > 0 && id2 > id1 && id3 > id2, '自增 id 必须递增');

    const { rows, total, degraded } = store.list({});
    assert.equal(total, 3);
    assert.equal(degraded, false);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].action, 'kill');            // 最新的在最前面
    assert.equal(rows[0].target, '1');
    assert.equal(rows[0].result, 'rejected');
    assert.equal(rows[2].message, 'SIGTERM nginx');
    assert.equal(rows[2].client, 'uid:1000');
    assert.equal(rows[2].detail.pid, 1234);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('过滤：按 action 前缀 / result / 关键字', () => {
  const dir = freshDir();
  const store = openAuditStore(join(dir, 'audit.db'));
  try {
    store.record({ action: 'kill', target: '100', result: 'ok', message: 'SIGKILL chrome' });
    store.record({ action: 'service.start', target: 'nginx.service', result: 'ok', message: 'start nginx.service' });
    store.record({ action: 'service.stop', target: 'nmbd.service', result: 'error', message: 'Unit nmbd.service not loaded' });
    store.record({ action: 'kill', target: '1', result: 'rejected', message: '拒绝：PID 必须 > 1' });

    assert.equal(store.list({ action: 'kill' }).total, 2, 'action 前缀匹配');
    assert.equal(store.list({ action: 'service' }).total, 2, '按 service 前缀抓全部服务操作');
    assert.equal(store.list({ action: 'service.start' }).total, 1);
    assert.equal(store.list({ result: 'rejected' }).total, 1);
    assert.equal(store.list({ q: 'nginx' }).total, 1, '关键字应命中原服务的 service.start 那条');
    assert.equal(store.list({ q: 'nmbd' }).total, 1, '消息里的关键字也能命中');
    assert.equal(store.list({ q: '这个不存在的关键字' }).total, 0);
    // 组合条件
    assert.equal(store.list({ action: 'service', result: 'error' }).total, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('分页：limit / offset，且 total 不受分页影响', () => {
  const dir = freshDir();
  const store = openAuditStore(join(dir, 'audit.db'));
  try {
    for (let i = 0; i < 25; i++) {
      store.record({ action: 'kill', target: String(1000 + i), result: 'ok', message: `sig ${i}` });
    }
    const p1 = store.list({ limit: 10, offset: 0 });
    const p2 = store.list({ limit: 10, offset: 10 });
    const p3 = store.list({ limit: 10, offset: 20 });
    assert.equal(p1.total, 25);
    assert.equal(p2.total, 25);
    assert.equal(p3.total, 25);
    assert.equal(p1.rows.length, 10);
    assert.equal(p3.rows.length, 5);
    assert.equal(p1.rows[0].target, '1024', '第一页最新一条是最后写入的');
    assert.equal(p3.rows[4].target, '1000', '最后一页最后一条是最早写入的');
    // 分页不重叠
    const ids = [...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.id);
    assert.equal(new Set(ids).size, 25);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('持久化：关闭后重新打开，记录仍在（这是「不丢失」的核心）', () => {
  const dir = freshDir();
  const path = join(dir, 'audit.db');
  const a = openAuditStore(path);
  a.record({ action: 'kill', target: '4242', result: 'ok', message: 'SIGTERM 关机前的操作' });
  a.record({ action: 'app.start', target: 'pid:1', result: 'ok', message: '启动' });
  a.close();

  assert.ok(existsSync(path), '库文件应存在于磁盘');
  assert.ok(statSync(path).size > 0);

  const b = openAuditStore(path);
  try {
    const { rows, total } = b.list({});
    assert.equal(total, 2, '重启后记录必须还在');
    assert.equal(rows[1].target, '4242');
    assert.equal(rows[1].message, 'SIGTERM 关机前的操作');
  } finally { b.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('落盘策略：WAL + synchronous=FULL + 完整性检查 OK', () => {
  const dir = freshDir();
  const store = openAuditStore(join(dir, 'audit.db'));
  try {
    store.record({ action: 'kill', target: '9', result: 'ok' });
    const h = store.health();
    assert.equal(h.enabled, true);
    assert.equal(String(h.journalMode).toLowerCase(), 'wal', '必须是 WAL，崩溃后可恢复');
    assert.ok(String(h.synchronous) === '2' || String(h.synchronous).toLowerCase() === 'full',
      `synchronous 必须是 FULL(2)，实际 ${h.synchronous}`);
    assert.equal(h.integrity, 'ok');
    assert.ok(h.sizeBytes > 0);
    assert.ok(existsSync(join(dir, 'audit.db-wal')), 'WAL 文件存在');
    assert.equal(h.pending, 0);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('统计：按结果与动作聚合，时间跨度正确', () => {
  const dir = freshDir();
  const store = openAuditStore(join(dir, 'audit.db'));
  try {
    store.record({ action: 'kill', target: '11', result: 'ok' });
    store.record({ action: 'kill', target: '12', result: 'ok' });
    store.record({ action: 'kill', target: '1', result: 'rejected' });
    store.record({ action: 'service.start', target: 'x.service', result: 'error' });
    const st = store.stats();
    assert.equal(st.total, 4);
    const map = Object.fromEntries(st.byResult.map((r) => [r.result, r.count]));
    assert.equal(map.ok, 2);
    assert.equal(map.rejected, 1);
    assert.equal(map.error, 1);
    const act = Object.fromEntries(st.byAction.map((r) => [r.action, r.count]));
    assert.equal(act.kill, 3);
    assert.equal(act['service.start'], 1);
    assert.ok(st.lastTs >= st.firstTs);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('旧字段兼容：toLegacy 同时给出新旧两种形状', () => {
  const row = toLegacy({
    id: 7, ts: 1700000000000, action: 'kill', target: '888',
    result: 'ok', message: 'SIGTERM node', client: 'uid:1000',
    detail: JSON.stringify({ pid: 888, signal: 'SIGTERM', name: 'node', user: 'admin' }),
  });
  // 新字段
  assert.equal(row.id, 7);
  assert.equal(row.action, 'kill');
  assert.equal(row.result, 'ok');
  assert.equal(row.detail.pid, 888);
  // 旧字段（老前端依赖这些）
  assert.equal(row.kind, 'kill');
  assert.equal(row.signal, 'SIGTERM');
  assert.equal(row.name, '888');
  assert.equal(row.pid, 888);
  assert.equal(row.user, 'admin');
  assert.equal(row.ok, true);
  assert.equal(row.error, undefined);
  assert.equal(row.at, new Date(1700000000000).toISOString());
  // 非 ok 的记录，error 要有内容
  const bad = toLegacy({ id: 8, ts: Date.now(), action: 'kill', target: '1', result: 'rejected', message: '拒绝' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, '拒绝');
});

test('降级：库打不开时不抛错、保留在待写队列、health 暴露 degraded', () => {
  const store = openAuditStore('/nonexistent-dir-should-fail/audit.db');
  try {
    assert.equal(store.enabled, false, '路径不可用时应降级');
    const id = store.record({ action: 'kill', target: '1', result: 'rejected', message: '拒绝' });
    assert.equal(id, null, '降级时拿不到 id，但也不能抛错');
    const l = store.list({});
    assert.equal(l.degraded, true);
    assert.equal(l.total, 1, '待写队列里的记录仍要能查到');
    const h = store.health();
    assert.equal(h.enabled, false);
    assert.equal(h.pending, 1);
    assert.ok(h.error, '必须给出失败原因，不能静默');
  } finally { store.close(); }
});

test('批量写入 500 条：全部落库且内容不串位', () => {
  const dir = freshDir();
  const store = openAuditStore(join(dir, 'audit.db'));
  try {
    for (let i = 0; i < 500; i++) {
      store.record({
        action: i % 2 ? 'kill' : 'service.start',
        target: `t-${i}`, result: i % 7 === 0 ? 'rejected' : 'ok',
        message: `msg-${i}`, detail: { i },
      });
    }
    const { total, rows } = store.list({ limit: 500 });
    assert.equal(total, 500);
    assert.equal(rows.length, 500);
    // 抽查首尾与中点，确认没有串位
    assert.equal(rows[0].target, 't-499');
    assert.equal(rows[0].message, 'msg-499');
    assert.equal(rows[250].target, 't-249');
    assert.equal(rows[499].target, 't-0');
    assert.equal(rows[499].detail.i, 0);
    assert.equal(store.list({ result: 'rejected' }).total, 72);  // 0,7,...,497
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
