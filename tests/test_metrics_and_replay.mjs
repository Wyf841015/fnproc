// /metrics 进程级指标（方案 A：抓取端用 ?proc= 指定）与审计重放的回归测试
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../app/ui/server.js', import.meta.url), 'utf8');
const MAIN = readFileSync(new URL('../app/ui/main.js', import.meta.url), 'utf8');

test('/metrics 默认不导出进程级指标（必须带 ?proc= 才导出）', () => {
  // 取 /metrics 处理段落
  const i = SRC.indexOf("if (pathname === '/metrics')");
  const j = SRC.indexOf('// ── CSV 导出', i);
  assert.ok(i > 0 && j > i, '找不到 /metrics 处理段');
  const seg = SRC.slice(i, j);
  // 进程级指标必须包在 wanted 循环里，不能有无条件的顶层循环
  assert.match(seg, /const wanted = /, '必须有 wanted（?proc= 解析）');
  assert.match(seg, /for \(const want of wanted\)/, '进程指标必须由 wanted 驱动');
  // 不允许出现「按内存排序取前 N」这种无条件导出
  assert.doesNotMatch(seg, /sort\(\(a, b\) => b\.rss - a\.rss\)\.slice\(0, 50\)/,
    '不应再按内存前 50 无条件导出进程指标');
});

test('/metrics 的 HELP/TYPE 只声明一次（Prometheus 文本格式要求）', () => {
  const i = SRC.indexOf("if (pathname === '/metrics')");
  const seg = SRC.slice(i, SRC.indexOf('// ── CSV 导出', i));
  assert.match(seg, /const declared = new Set\(\)/, '必须有 declared 去重集合');
  assert.match(seg, /if \(!declared\.has\(name\)\)/, 'HELP/TYPE 必须在首次出现时才写');
});

test('/metrics 的 proc 参数有数量上限', () => {
  assert.match(SRC, /const PROC_METRICS_LIMIT = 20/, '必须有 PROC_METRICS_LIMIT 常量');
  assert.match(SRC, /\.slice\(0, PROC_METRICS_LIMIT\)/, '参数必须按上限截断');
});

test('审计重放只放行服务启停，kill 不在白名单', () => {
  const i = SRC.indexOf("'/api/audit/replay'");
  assert.ok(i > 0, '找不到重放端点');
  const seg = SRC.slice(i, i + 2600);
  assert.match(seg, /REPLAYABLE = new Set\(\['service\.start', 'service\.stop', 'service\.restart'\]\)/,
    '白名单必须恰好是这三个动作');
  assert.doesNotMatch(seg, /REPLAYABLE[^\n]*kill/, 'kill 绝不能出现在可重放白名单里');
  assert.match(seg, /String\(row\.result\) !== 'ok'/, '只能重放当时成功的记录');
  // 重放必须复用 runServiceAction，不能绕过校验直接 systemctl
  assert.match(seg, /await runServiceAction\(/, '重放必须复用 runServiceAction 走完整校验');
});

test('前端重做按钮白名单与后端一致', () => {
  const backend = /REPLAYABLE = new Set\(\['service\.start', 'service\.stop', 'service\.restart'\]\)/.test(SRC);
  const frontend = /REPLAYABLE_ACTIONS = new Set\(\['service\.start', 'service\.stop', 'service\.restart'\]\)/.test(MAIN);
  assert.ok(backend && frontend, '前后端可重放白名单必须一致');
  // confirmModal 是回调式，不能被 await 当 Promise 用
  assert.doesNotMatch(MAIN, /await confirmModal\(/, 'confirmModal 是回调式，await 它永远拿到 undefined');
});

test('前端重做按钮只在可重放且成功的行渲染', () => {
  const i = MAIN.indexOf('REPLAYABLE_ACTIONS.has(a.action)');
  assert.ok(i > 0, '找不到重做按钮渲染条件');
  const seg = MAIN.slice(Math.max(0, i - 260), i + 60);
  assert.match(seg, /a\.result === 'ok'/, '必须同时要求 result === ok');
});
