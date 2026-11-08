// tests/test_security_guards.mjs — 安全守护回归测试
//
// 这些是 0.3.1 审计修复的锁：全部用「真实源码 + 真实请求处理函数」验证，
// 不在测试里重写一份判据（重写等于给自己发假通行证）。
//
// 覆盖：
//   ① 写请求必须 application/json（跨站简单请求 CSRF 的根因）
//   ② OPTIONS 一律 403（让浏览器的预检直接失败）
//   ③ Sec-Fetch-Site: cross-site 被拒
//   ④ 静态资源白名单（后端源码不可下载）
//   ⑤ 私有地址判定（webhook SSRF）
//   ⑥ 看门狗「默认不启用」不再被请求体覆盖
//   ⑦ ?sort=__proto__ 不再 500

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isPrivateAddress, webhookBlockReason } from '../app/ui/alerts.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '..', 'app', 'ui', 'server.js'), 'utf8');

// 从源码里抠出 guardRequest / STATIC_ALLOW / SORT_KEYS 相关片段做真实求值。
// 注意 server.js 顶层会 listen()，不能直接 import（会挂住测试进程）。
function extractBlock(name) {
  const i = SRC.indexOf(name);
  assert.ok(i > 0, `${name} 未找到`);
  let depth = 0;
  let j = i;
  let started = false;
  while (j < SRC.length) {
    const ch = SRC[j];
    if (ch === '{') { depth += 1; started = true; }
    else if (ch === '}') { depth -= 1; if (started && depth === 0) { j += 1; break; } }
    j += 1;
  }
  return SRC.slice(i, j);
}

// 用假的 req/res 跑真实的 guardRequest
const guardSrc = extractBlock('function guardRequest');
const MUTATING_SRC = "const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);";
const sendJSONSrc = `
function sendJSON(res, code, obj) {
  res.__code = code; res.__body = obj;
}`;
const guard = new Function(MUTATING_SRC + sendJSONSrc + guardSrc +
  '; return guardRequest;')();

function fakeRes() { return { __code: 200, __body: null }; }
function req(method, headers = {}) { return { method, headers }; }

// ── ① 写请求必须 JSON ────────────────────────────────────────────────
test('POST 用 text/plain 被 415 拦下（跨站简单请求 CSRF 的根因）', () => {
  const res = fakeRes();
  const blocked = guard(req('POST', { 'content-type': 'text/plain' }), res);
  assert.equal(blocked, true);
  assert.equal(res.__code, 415);
});

test('POST 带 application/json 正常放行', () => {
  const res = fakeRes();
  const blocked = guard(req('POST', { 'content-type': 'application/json' }), res);
  assert.equal(blocked, false);
});

test('application/json; charset=utf-8 也放行', () => {
  const res = fakeRes();
  assert.equal(guard(req('POST', { 'content-type': 'application/json; charset=utf-8' }), res), false);
});

test('GET 不受 Content-Type 限制', () => {
  const res = fakeRes();
  assert.equal(guard(req('GET', {}), res), false);
});

// ── ② OPTIONS 一律 403 ──────────────────────────────────────────────
test('OPTIONS 预检返回 403（浏览器不再发出真正的跨站请求）', () => {
  const res = { writeHead(code) { this.__code = code; }, end() {} };
  const blocked = guard(req('OPTIONS', {}), res);
  assert.equal(blocked, true);
  assert.equal(res.__code, 403);
});

// ── ③ 跨站来源 ──────────────────────────────────────────────────────
test('Sec-Fetch-Site: cross-site 被 403', () => {
  const res = fakeRes();
  assert.equal(guard(req('GET', { 'sec-fetch-site': 'cross-site' }), res), true);
  assert.equal(res.__code, 403);
});

test('带网关注入的 X-Trim-Userid 时放行（恶意页面无法伪造该头）', () => {
  const res = fakeRes();
  assert.equal(guard(req('GET', { 'sec-fetch-site': 'cross-site', 'x-trim-userid': '1000' }), res), false);
});

test('同源请求（sec-fetch-site: same-origin）放行', () => {
  const res = fakeRes();
  assert.equal(guard(req('GET', { 'sec-fetch-site': 'same-origin' }), res), false);
});

// ── ④ 静态资源白名单 ────────────────────────────────────────────────
test('静态白名单包含前端资源、排除后端源码', () => {
  const listSrc = extractBlock('const STATIC_ALLOW = [');
  const allow = new Function('return ' + listSrc.replace(/^const STATIC_ALLOW = /, '').replace(/;$/, '') + ';')();
  const ok = (p) => allow.some((re) => re.test(p));
  for (const p of ['index.html', 'main.js', 'styles/app.css', 'images/icon_256.png']) {
    assert.equal(ok(p), true, `应放行 ${p}`);
  }
  for (const p of ['server.js', 'alert-db.js', 'config', 'alerts.js', 'snapshot-db.js']) {
    assert.equal(ok(p), false, `不应放行 ${p}`);
  }
});

// ── ⑤ webhook SSRF 判定 ─────────────────────────────────────────────
test('私有/回环/链路本地地址全部判为内网', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '172.31.255.1', '192.168.1.10',
    '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, `${ip} 应判为内网`);
  }
});

test('公网地址不判内网', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '203.0.113.10']) {
    assert.equal(isPrivateAddress(ip), false, `${ip} 不应判为内网`);
  }
});

test('webhook 指向回环/内网域名/非法协议都被拒绝', async () => {
  assert.match(await webhookBlockReason('http://127.0.0.1:47951/hook'), /内网/);
  assert.match(await webhookBlockReason('http://localhost/hook'), /内网|本机/);
  assert.match(await webhookBlockReason('http://169.254.169.254/latest'), /内网/);
  assert.match(await webhookBlockReason('file:///etc/passwd'), /http/);
  assert.match(await webhookBlockReason('http://svc.internal/x'), /内网|本机/);
  assert.equal(await webhookBlockReason('https://example.com/hook'), '');
});

// ── ⑥ 看门狗不再被请求体覆盖 ────────────────────────────────────────
test('看门狗保存用 wantsEnable 判据，不再直接展开请求体', () => {
  assert.match(SRC, /const wantsEnable = typeof body\.enabled === 'boolean'/);
  assert.match(SRC, /saveWatchdog\(\{ \.\.\.body, enabled: wantsEnable \}\)/);
  assert.doesNotMatch(SRC, /saveWatchdog\(\{ enabled: false, \.\.\.body \}\)/);
  // acknowledge 校验必须覆盖「启用」与「改已启用看门狗的命令」两种情形
  assert.match(SRC, /const needAck = wantsEnable \|\| \(existing && existing\.enabled && commandChanged\)/);
});

// ── ⑦ 排序 key 走白名单，不再命中原型链 ─────────────────────────────
test('sort 参数用 SORT_KEYS 白名单判定', () => {
  assert.match(SRC, /const SORT_KEYS = new Set\(/);
  assert.match(SRC, /SORT_KEYS\.has\(String\(query\.get\('sort'\)/);
  assert.doesNotMatch(SRC, /SORTS\[query\.get\('sort'\)\]/);
});

// ── ⑧ CSV 的长度与 BOM ──────────────────────────────────────────────
test('CSV Content-Length 包含 BOM', () => {
  assert.match(SRC, /const out = '\\ufeff' \+ body;/);
  assert.match(SRC, /const len = Buffer\.byteLength\(out\)/);
  assert.match(SRC, /'Content-Length': len/);
});

// ── ⑨ 关键服务保护使用前缀规则 ──────────────────────────────────────
test('关键服务保护覆盖 fnOS 平台服务（isProtectedUnit + 前缀）', () => {
  assert.match(SRC, /function isProtectedUnit/);
  assert.match(SRC, /const PROTECTED_PREFIXES = \[/);
  for (const s of ['docker.service', 'accountsrv.service', 'filestor_service.service']) {
    assert.equal(SRC.includes(`'${s}'`), true, `名单应包含 ${s}`);
  }
});

// ── ⑩ 前端结构回归：防止 patch 命中错误位置（fuzzy 匹配真实踩过）──────
test('renderPorts 请求 /ports，且不再引用 openDetail 的 pid 变量', () => {
  const main = readFileSync(join(here, '..', 'app', 'ui', 'main.js'), 'utf8');
  const i = main.indexOf('async function renderPorts()');
  assert.ok(i > 0);
  const body = main.slice(i, i + 900);
  assert.match(body, /fetch\(API \+ '\/ports'/);
  assert.doesNotMatch(body, /currentDetailPid !== pid/);
});

test('openDetail 在 await 之后做过期响应丢弃', () => {
  const main = readFileSync(join(here, '..', 'app', 'ui', 'main.js'), 'utf8');
  const i = main.indexOf('async function openDetail(pid)');
  const body = main.slice(i, i + 1200);
  assert.match(body, /if \(currentDetailPid !== pid\) return;/);
});

test('告警表单提交带 op（避免 < 规则被反转成 >）', () => {
  const main = readFileSync(join(here, '..', 'app', 'ui', 'main.js'), 'utf8');
  const i = main.indexOf('function alertFormBody()');
  const body = main.slice(i, i + 900);
  assert.match(body, /op:/);
});

test('`/` 快捷键不再劫持输入框', () => {
  const main = readFileSync(join(here, '..', 'app', 'ui', 'main.js'), 'utf8');
  assert.match(main, /const typing = !!ae && \(ae\.tagName === 'INPUT'/);
  assert.match(main, /e\.key === '\/' && !typing/);
});

test('进程表只有一个 click 监听（避免 stopPropagation 拦不住同节点第二个）', () => {
  const main = readFileSync(join(here, '..', 'app', 'ui', 'main.js'), 'utf8');
  const n = (main.match(/\$\('ptbody'\)\.addEventListener\('click'/g) || []).length;
  assert.equal(n, 1, 'ptbody 应只有一个 click 监听');
});

test('setTab 不再重复调用 loadAudit / loadAlerts（refreshView 已覆盖）', () => {
  const main = readFileSync(join(here, '..', 'app', 'ui', 'main.js'), 'utf8');
  const i = main.indexOf('function setTab(name)');
  const body = main.slice(i, i + 900);
  assert.doesNotMatch(body, /loadAudit\(\)/);
  assert.doesNotMatch(body, /loadAlerts\(\)/);
});

// ── ⑪ psql 不读用户 rc 文件 ─────────────────────────────────────────
test('psql 调用带 -X（不加载 ~/.psqlrc）', () => {
  const alertsSrc = readFileSync(join(here, '..', 'app', 'ui', 'alerts.js'), 'utf8');
  assert.match(alertsSrc, /execFileP\('psql', \['-X', '-q'/);
});
