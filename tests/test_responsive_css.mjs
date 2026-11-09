// tests/test_responsive_css.mjs — 移动端弹窗/表格布局回归
//
// 起因：容器日志弹窗在手机宽度下整块跑到视口右侧之外，只剩一层遮罩，
// 弹窗主体和关闭按钮都点不到。根因是 .modal-mask 用 grid 但没约束列宽 ——
// grid 的 auto 列会按内容的 max-content 定宽，日志里一条长行（实测 2076px）
// 就把列撑到两千多，弹窗在那条超大列里居中，于是整块溢出屏幕。
//
// 另外记一条顺序陷阱：写在 @media (max-width:760px) 里的移动端规则，
// 如果同名基础样式出现在它之后，同特异性下会被基础样式覆盖而无声失效
// （踩过：日志筛选条的下拉框被挤成只剩箭头）。所以移动端块必须放在文件末尾。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(here, '..', 'app', 'ui', 'styles', 'app.css'), 'utf8');

// 取出某一个选择器块（从 selector { 到配对的 }）
function block(selector, from = 0) {
  const i = CSS.indexOf(selector, from);
  assert.ok(i >= 0, `找不到选择器 ${selector}`);
  const open = CSS.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < CSS.length; j += 1) {
    if (CSS[j] === '{') depth += 1;
    else if (CSS[j] === '}') { depth -= 1; if (depth === 0) return CSS.slice(open + 1, j); }
  }
  throw new Error(`选择器 ${selector} 的花括号不配对`);
}

test('遮罩层用 minmax(0,1fr) 约束列宽（否则长内容会把弹窗顶出屏幕）', () => {
  const mask = block('.modal-mask {');
  assert.match(mask, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(block('.sheet-mask {'), /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});

test('弹窗自身限制宽度与高度，内容超高时窗内滚动', () => {
  const modal = block('.modal {');
  assert.match(modal, /min-width:\s*0/);
  assert.match(modal, /max-width:\s*100%/);
  assert.match(modal, /max-height:\s*calc\(100vh - 40px\)/);
  assert.match(modal, /overflow-y:\s*auto/);
  assert.match(block('.sheet {'), /max-height:\s*calc\(100vh - 36px\)/);
});

test('不使用 dvh（fnOS 的 WebView 不支持）', () => {
  assert.doesNotMatch(CSS, /\d+dvh/);
});

test('日志弹窗是 flex 列：工具条固定、只有日志区滚动', () => {
  assert.match(block('.log-modal {'), /flex-direction:\s*column/);
  assert.match(block('.log-modal .log-pre {'), /flex:\s*1 1 auto/);
  assert.match(block('.log-modal .log-pre {'), /min-height:\s*0/);
});

test('移动端块必须在文件末尾（否则被后面的基础规则覆盖）', () => {
  const lastMedia = CSS.lastIndexOf('@media (max-width: 760px)');
  assert.ok(lastMedia > 0, '缺少移动端媒体查询');
  const tail = CSS.slice(lastMedia);
  // 移动端块之后不应再出现 .log-tools / .ptable 的基础规则
  assert.doesNotMatch(tail.slice(tail.indexOf('}\n')), /^\.log-tools\s*\{/m);
  const afterTail = CSS.slice(lastMedia + tail.indexOf('\n}\n') + 3);
  assert.doesNotMatch(afterTail, /^\.ptable\s*\{/m);
});

test('移动端日志筛选条：下拉框各占半行、关键字与按钮各占一行', () => {
  const tail = CSS.slice(CSS.lastIndexOf('@media (max-width: 760px)'));
  assert.match(tail, /\.log-tools select\s*\{[^}]*flex:\s*1 1 40%/);
  assert.match(tail, /\.log-tools input\s*\{[^}]*flex:\s*1 1 100%/);
  assert.match(tail, /\.log-tools \.btn\s*\{[^}]*flex:\s*1 1 100%/);
  // 不能退化成 flex:1 1 0（360 屏下会把下拉框压成只剩箭头）
  assert.doesNotMatch(tail, /\.log-tools select\s*\{[^}]*flex:\s*1 1 0/);
});

test('移动端日志长行折行（手机不用左右拖）', () => {
  const tail = CSS.slice(CSS.lastIndexOf('@media (max-width: 760px)'));
  const pre = tail.slice(tail.indexOf('.log-modal .log-pre'));
  assert.match(pre.slice(0, 400), /white-space:\s*pre-wrap/);
  assert.match(pre.slice(0, 400), /overflow-wrap:\s*anywhere/);
});

test('移动端把表格最后一列（操作）钉在右侧', () => {
  const tail = CSS.slice(CSS.lastIndexOf('@media (max-width: 760px)'));
  const m = tail.match(/\.ptable th:last-child, \.ptable td:last-child\s*\{[^}]*\}/);
  assert.ok(m, '缺少操作列 sticky 规则');
  assert.match(m[0], /position:\s*sticky/);
  assert.match(m[0], /right:\s*0/);
  assert.match(tail, /\.ptable th:last-child\s*\{[^}]*top:\s*0/);
});

test('移动端弹窗满宽且按钮等分', () => {
  const tail = CSS.slice(CSS.lastIndexOf('@media (max-width: 760px)'));
  assert.match(tail, /\.modal, \.modal\.wide\s*\{[^}]*width:\s*100%/);
  assert.match(tail, /\.modal-actions \.btn\s*\{[^}]*flex:\s*1 1 120px/);
});

test('桌面端不继承移动端宽度（.modal.wide 仍是 620px 上限）', () => {
  const wide = block('.modal.wide {');
  assert.match(wide, /width:\s*min\(620px,\s*100%\)/);
});
