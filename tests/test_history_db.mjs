// tests/test_history_db.mjs — 采样历史 SQLite 存储的回归测试
// 运行：node --test tests/test_history_db.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHistoryStore, bucketFor } from '../app/ui/history-db.js';

const dir = () => mkdtempSync(join(tmpdir(), 'fnproc-hist-'));

test('分桶粒度随窗口自动放大，且点数不超过 240', () => {
  assert.equal(bucketFor(3600e3), 30, '1 小时应该是 30 秒原始粒度');
  assert.equal(bucketFor(6 * 3600e3), 90, '6 小时 → 90 秒');
  const b24 = bucketFor(24 * 3600e3);
  assert.equal(b24, 360, '24 小时 → 360 秒');
  assert.ok((24 * 3600) / b24 <= 240, '24 小时点数不超过 240');
  const b7d = bucketFor(7 * 24 * 3600e3);
  assert.ok((7 * 24 * 3600) / b7d <= 240, '7 天点数不超过 240');
  assert.ok(b7d >= 30 && b7d % 30 === 0, '粒度必须是 30 秒的整数倍');
});

test('写入 / 查询 / 覆盖同 ts', () => {
  const d = dir();
  const store = openHistoryStore(join(d, 'h.db'));
  assert.equal(store.enabled, true);

  const now = Date.now();
  for (let i = 0; i < 10; i += 1) {
    store.append({ ts: now - i * 30000, cpu: 10 + i, mem: 40 + i, swap: 1, load1: 0.5, rd: 100, wr: 200, rx: 300, tx: 400 });
  }
  let h = store.health();
  assert.equal(h.rows, 10, '10 条采样点');

  // 同 ts 再写一次 = 覆盖，不新增（幂等）
  store.append({ ts: now, cpu: 99, mem: 99, swap: 0, load1: 9, rd: 0, wr: 0, rx: 0, tx: 0 });
  h = store.health();
  assert.equal(h.rows, 10, '同 ts 覆盖后行数不变');

  const { rows, bucket, source } = store.query(60);
  assert.equal(source, 'sqlite');
  assert.equal(bucket, 30);
  assert.ok(rows.length >= 1 && rows.length <= 10, `60 分钟窗口 ${rows.length} 个桶`);
  assert.ok(rows.every((r) => Number.isFinite(r.cpu) && Number.isFinite(r.mem)));
  // 最新桶的 cpu 应当是覆盖后的 99
  const last = rows[rows.length - 1];
  assert.equal(last.cpu, 99, '覆盖写入生效');
  store.close();
  rmSync(d, { recursive: true, force: true });
});

test('大窗口真的聚合：分桶后行数远小于原始行数', () => {
  const d = dir();
  const store = openHistoryStore(join(d, 'h.db'));
  const now = Date.now();
  // 24 小时、每 30 秒一条 = 2880 条原始采样
  const rows = [];
  for (let i = 0; i < 2880; i += 1) {
    rows.push({ ts: now - i * 30000, cpu: 10 + (i % 50), mem: 40, swap: 5, load1: 1, rd: 1, wr: 2, rx: 3, tx: 4 });
  }
  for (const r of rows) store.append(r);
  assert.equal(store.health().rows, 2880);

  const day = store.query(1440);                    // 24 小时 → 360s 桶
  assert.equal(day.bucket, 360);
  // 允许 +1：窗口起点落在某个桶中间时，首尾会各多出半个桶
  assert.ok(day.rows.length <= 241, `24h 点数应 ≤241，实际 ${day.rows.length}`);
  assert.ok(day.rows.length < 2880, '必须真的聚合，而不是每行一个桶');
  assert.ok(day.rows.every((r) => r.n >= 1), '每桶样本数 n 存在');
  assert.ok(day.rows.reduce((s, r) => s + r.n, 0) >= 2800, '聚合不能丢样本');
  // 时间戳必须对齐到桶边界（整数）
  assert.ok(day.rows.every((r) => Number.isInteger(r.ts)), '桶时间戳应是整数');

  const week = store.query(10080);                   // 7 天 → 2520s 桶
  assert.equal(week.bucket, 2520);
  assert.ok(week.rows.length <= 241, `7d 点数应 ≤241，实际 ${week.rows.length}`);
  store.close();
  rmSync(d, { recursive: true, force: true });
});

test('按时间保留：老数据被裁掉，新数据保留', () => {
  const d = dir();
  const store = openHistoryStore(join(d, 'h.db'), { retentionDays: 1 });
  const now = Date.now();
  store.append({ ts: now - 3 * 86400000, cpu: 1, mem: 1, swap: 0, load1: 0, rd: 0, wr: 0, rx: 0, tx: 0 });
  store.append({ ts: now - 1000, cpu: 2, mem: 2, swap: 0, load1: 0, rd: 0, wr: 0, rx: 0, tx: 0 });
  assert.equal(store.health().rows, 2);

  const removed = store.prune(1);
  assert.equal(removed, 1, '裁掉 1 条过期数据');
  assert.equal(store.health().rows, 1, '新数据保留');
  store.close();
  rmSync(d, { recursive: true, force: true });
});

test('从 history.jsonl 一次性迁移（只迁一次）', () => {
  const d = dir();
  const jsonl = join(d, 'history.jsonl');
  const base = Date.now() - 3600e3;
  const lines = [];
  for (let i = 0; i < 5; i += 1) {
    lines.push(JSON.stringify({ ts: base + i * 30000, cpu: i, mem: 10 + i, swap: 0, load1: 0.1, rd: 1, wr: 2, rx: 3, tx: 4 }));
  }
  lines.push('{ 坏行 ,,,');   // 坏 JSON 必须跳过而不是整批失败
  writeFileSync(jsonl, lines.join('\n') + '\n');

  const store = openHistoryStore(join(d, 'h.db'), { migrateFrom: jsonl });
  assert.equal(store.enabled, true);
  assert.equal(store.migrated, 5, '迁移了 5 条有效行（坏行跳过）');
  assert.equal(store.health().rows, 5);

  // 再开一次（同目录）不应该重复迁移
  store.close();
  const store2 = openHistoryStore(join(d, 'h.db'), { migrateFrom: jsonl });
  assert.equal(store2.migrated, 0, '已有数据时不再迁移');
  assert.equal(store2.health().rows, 5);
  store2.close();
  rmSync(d, { recursive: true, force: true });
});

test('库打不开时降级：enabled=false，写入进内存队列，不抛异常', () => {
  // /proc 下建库必然失败（只读）
  const store = openHistoryStore('/proc/fnproc-should-fail/h.db');
  assert.equal(store.enabled, false);
  assert.ok(store.health().error.length > 0, '暴露错误原因');
  assert.equal(store.append({ ts: Date.now(), cpu: 1 }), false, '写入返回 false');
  assert.equal(store.health().pending, 1, '进内存待写队列');
  const q = store.query(60);
  assert.equal(q.rows.length, 0);
  assert.equal(q.source, 'none');
  store.close();
});

test('待写队列有上限，不会无限增长', () => {
  const store = openHistoryStore('/proc/fnproc-should-fail/h2.db', { maxPending: 5 });
  for (let i = 0; i < 12; i += 1) store.append({ ts: Date.now() + i, cpu: i });
  const h = store.health();
  assert.equal(h.pending, 5, '队列被截断到 5');
  assert.equal(h.pendingDropped, 7, '丢弃计数正确');
  store.close();
});
