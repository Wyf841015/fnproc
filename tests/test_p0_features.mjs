// tests/test_p0_features.mjs — 关注服务 / 进程追踪 / 批量处置的存储与约束
//
// 这几项都涉及"记住用户的选择"，所以重点验证落库与重启后的一致性，
// 而不是只测函数返回值好看。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { openAlertStore } from '../app/ui/alert-db.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '..', 'app', 'ui', 'server.js'), 'utf8');
const MAIN = readFileSync(join(here, '..', 'app', 'ui', 'main.js'), 'utf8');

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'fnproc-p0-'));
  const store = openAlertStore(join(dir, 'alerts.db'), { version: 'test' });
  assert.equal(store.enabled, true, '库应能打开');
  return { dir, store, path: join(dir, 'alerts.db') };
}

// ── 关注服务 ───────────────────────────────────────────────────────────
test('关注服务可增删，且重启后仍然记得', () => {
  const { dir, store, path } = fresh();
  assert.deepEqual(store.listPinned(), []);
  assert.equal(store.setPinned('nginx.service', true).ok, true);
  assert.equal(store.setPinned('docker.service', true).ok, true);
  assert.deepEqual(store.listPinned().sort(), ['docker.service', 'nginx.service']);
  store.close();

  const again = openAlertStore(path, { version: 'test' });
  assert.deepEqual(again.listPinned().sort(), ['docker.service', 'nginx.service'], '重开库应还在');
  again.setPinned('nginx.service', false);
  assert.deepEqual(again.listPinned(), ['docker.service']);
  again.close();
  rmSync(dir, { recursive: true, force: true });
});

test('关注服务拒绝空名', () => {
  const { dir, store } = fresh();
  assert.equal(store.setPinned('', true).ok, false);
  assert.equal(store.setPinned('   ', true).ok, false);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

// ── 进程追踪 ───────────────────────────────────────────────────────────
test('追踪项可增改删，基准建立后仍可读', () => {
  const { dir, store } = fresh();
  const r = store.saveWatch({ name: '日志哨兵', pattern: 'fnlogpush' });
  assert.equal(r.ok, true);
  assert.ok(r.id > 0);

  let list = store.listWatches();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, '日志哨兵');
  assert.equal(list[0].enabled, true);
  assert.equal(list[0].baselineCount, 0, '新建时基准为空');

  // 建立基准
  assert.equal(store.updateWatchBaseline(r.id, [101, 202], 1000), true);
  list = store.listWatches();
  assert.equal(list[0].baselineCount, 2);
  assert.deepEqual(list[0].baseline, [101, 202]);

  // 改名 + 停用
  const up = store.saveWatch({ id: r.id, name: '改过的名字', pattern: 'fnlogpush', enabled: false });
  assert.equal(up.ok, true);
  list = store.listWatches();
  assert.equal(list[0].name, '改过的名字');
  assert.equal(list[0].enabled, false);

  assert.equal(store.deleteWatch(r.id), true);
  assert.equal(store.listWatches().length, 0);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('改了匹配关键字就重置基准（新旧进程集合不能混在一起）', () => {
  const { dir, store } = fresh();
  const r = store.saveWatch({ name: 'w', pattern: 'aaa' });
  store.updateWatchBaseline(r.id, [1, 2, 3], Date.now());
  assert.equal(store.listWatches()[0].baselineCount, 3);

  store.saveWatch({ id: r.id, name: 'w', pattern: 'bbb' });
  assert.equal(store.listWatches()[0].baselineCount, 0, '换关键字后基准必须清空');

  // 只改名字不动关键字，基准要保留
  store.updateWatchBaseline(r.id, [7, 8], Date.now());
  store.saveWatch({ id: r.id, name: 'w2', pattern: 'bbb' });
  assert.equal(store.listWatches()[0].baselineCount, 2, '只改名不应丢基准');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('追踪项入参校验：空名/空关键字/超长关键字都拒绝', () => {
  const { dir, store } = fresh();
  assert.equal(store.saveWatch({ name: '', pattern: 'x' }).ok, false);
  assert.equal(store.saveWatch({ name: 'x', pattern: '' }).ok, false);
  assert.equal(store.saveWatch({ name: 'x', pattern: 'a'.repeat(121) }).ok, false);
  assert.equal(store.saveWatch({ id: 9999, name: 'x', pattern: 'y' }).ok, false, '更新不存在的 id 应失败');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('追踪事件可写可查，删除追踪会带走它的事件', () => {
  const { dir, store } = fresh();
  const r = store.saveWatch({ name: 'w', pattern: 'p' });
  store.addWatchEvent({ watchId: r.id, watchName: 'w', kind: 'appear', pid: 1234, pname: 'node', cmd: 'node x.js' });
  store.addWatchEvent({ watchId: r.id, watchName: 'w', kind: 'appear', pid: 5678, pname: 'node' });
  const ev = store.listWatchEvents({ limit: 50 });
  assert.equal(ev.total, 2);
  assert.equal(ev.rows[0].pid, 5678, '按时间倒序');

  const onlyThis = store.listWatchEvents({ watchId: r.id });
  assert.equal(onlyThis.total, 2);

  store.deleteWatch(r.id);
  assert.equal(store.listWatchEvents({ limit: 50 }).total, 0, '删追踪应连带删事件');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('追踪事件按保留期裁剪', () => {
  const { dir, store } = fresh();
  const r = store.saveWatch({ name: 'w', pattern: 'p' });
  const old = Date.now() - 40 * 86400000;
  store.addWatchEvent({ ts: old, watchId: r.id, watchName: 'w', pid: 1, pname: 'old' });
  store.addWatchEvent({ ts: Date.now(), watchId: r.id, watchName: 'w', pid: 2, pname: 'new' });
  assert.equal(store.listWatchEvents({ limit: 50 }).total, 2);
  const removed = store.pruneWatchEvents(30);
  assert.equal(removed, 1);
  assert.equal(store.listWatchEvents({ limit: 50 }).total, 1);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

// ── 后端约束（源码级，防止以后被改回去） ────────────────────────────────
test('批量处置的硬约束写在服务端', () => {
  assert.match(SRC, /Array\.isArray\(body\.pids\)/);
  assert.match(SRC, /批量处置不支持 tree/);
  assert.match(SRC, /一次最多 50 个进程/);
  assert.match(SRC, /需要 confirm: true 才会执行/);
  // 批量里也必须逐个跳过受保护 PID（不能只在前端拦）
  assert.match(SRC, /if \(p <= 1\) \{ results\.push\(\{ pid: p, ok: false, error: '受保护：PID ≤ 1'/);
  assert.match(SRC, /受保护：不能结束自身/);
});

test('历史接口把审计事件一起带出去', () => {
  assert.match(SRC, /events: acts/);
  assert.match(SRC, /filter\(\(e\) => \/\^\(kill\|service/);
});

test('追踪检查只记录、不执行命令', () => {
  const i = SRC.indexOf('function checkWatches()');
  assert.ok(i > 0);
  // 只截到函数结束，否则会把后面的 refreshPorts（里面有 execFileP）算进来
  const end = SRC.indexOf('\n}\n', i);
  const body = SRC.slice(i, end);
  assert.match(body, /addWatchEvent/);
  assert.doesNotMatch(body, /execFile|spawn|execSync|child_process/, '追踪不允许执行任何命令');
  // 对照：看门狗才允许执行命令，两者不能混
  assert.match(SRC, /watchdogs/);
});

test('前端批量上限与后端一致，且渲染后清理已退出的选中项', () => {
  assert.match(MAIN, /const PICK_LIMIT = 50/);
  assert.match(MAIN, /一次最多选 \$\{PICK_LIMIT\} 个进程/);
  assert.match(MAIN, /已选进程已退出，已自动取消勾选/);
});

test('服务关注在前端用原生 checkbox/按钮，且排序来自后端', () => {
  assert.match(MAIN, /data-action'?\]? *= ?'svc-pin'|dataset\.action = 'svc-pin'/);
  assert.match(SRC, /Number\(b\.pinned\) - Number\(a\.pinned\)/);
});
