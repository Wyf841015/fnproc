// app/ui/main.js — 进程管家前端
//
// 约定：
//   · 所有 DOM 绑定走 addEventListener（fnOS 的 WebView/CEF 对 inline onclick 不可靠）
//   · 进程命令行等外部文本一律 textContent 写入，绝不拼 innerHTML（cmdline 可含任意字符）
//   · API 基址自适应：本地调试（/api）与 fnOS 网关（/app/fnproc/api）都能用

const inGateway = location.pathname.startsWith('/app/fnproc');
const API = (inGateway ? '/app/fnproc' : '') + '/api';
const STREAM_URL = API + '/stream';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

// ── 格式化 ──────────────────────────────────────────────────────────────
function fmtBytes(b, digits = 1) {
  if (!b || b < 1) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return (b / 1024 ** i).toFixed(i === 0 ? 0 : digits) + ' ' + u[i];
}
function fmtBps(b) { return fmtBytes(b, 1) + '/s'; }
function fmtPct(v) { return (Math.round(v * 10) / 10).toFixed(1); }
function fmtUptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `已运行 ${d} 天 ${h} 小时`;
  if (h) return `已运行 ${h} 小时 ${m} 分`;
  return `已运行 ${m} 分`;
}
function fmtCpuTime(sec) {
  if (sec < 60) return sec + 's';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return `${h}h${m}m`;
  return `${m}m${s}s`;
}
function fmtStart(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const STATE_CN = { R: '运行', S: '睡眠', D: '不可中断', Z: '僵尸', T: '停止', t: '跟踪停止', I: '空闲', X: '死亡', '?': '未知' };

// ── Toast ───────────────────────────────────────────────────────────────
function toast(msg, kind = 'info') {
  const wrap = $('toasts');
  const t = el('div', 'toast ' + kind, msg);
  wrap.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, 3200);
}

// ── 主题 ────────────────────────────────────────────────────────────────
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $('theme-icon').textContent = t === 'light' ? '☀️' : '🌙';
  localStorage.setItem('fnproc-theme', t);
}
(function initTheme() {
  const saved = localStorage.getItem('fnproc-theme');
  const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  applyTheme(saved || (prefersLight ? 'light' : 'dark'));
})();

// ── 图表（SVG 实现）────────────────────────────────────────────────────
// 为什么不用 canvas：fnOS WebView（CEF）里 canvas 自身 clientWidth 经常量到 0
// （父级是 flex 项、布局晚于脚本时尤其明显）。一旦在 0 宽时把 canvas.width 定成 1，
// 绘图缓冲区就被锁死在 1 个设备像素上，之后怎么画都只剩一条细线 —— 用户看到的就是
// 「图表不显示」。SVG 靠 viewBox 自动缩放，完全不需要 JS 量尺寸，也天然适配 DPR，
// 所以改成 SVG：一根 polyline 一条曲线，一个 polygon 做面积填充。
const SVGNS = 'http://www.w3.org/2000/svg';
const CH_W = 300;      // viewBox 宽度（虚拟坐标，与像素无关）
const CH_H = 100;      // viewBox 高度

function elNS(tag, attrs) {
  const n = document.createElementNS(SVGNS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
}

function makeChart(svg, opts) {
  if (!svg) return { draw() {}, redraw() {} };
  svg.setAttribute('viewBox', `0 0 ${CH_W} ${CH_H}`);
  svg.textContent = '';
  // 背景网格（3 条水平线）
  for (let i = 1; i <= 3; i++) {
    svg.appendChild(elNS('line', {
      class: 'grid-line', x1: 0, y1: (CH_H / 4) * i, x2: CH_W, y2: (CH_H / 4) * i,
    }));
  }
  // 每条曲线：面积多边形在下，折线在上
  const layers = opts.series.map((s) => {
    let fillEl = null;
    if (s.fill) {
      fillEl = elNS('polygon', { fill: s.fill });
      svg.appendChild(fillEl);
    }
    const poly = elNS('polyline', { stroke: s.color });
    svg.appendChild(poly);
    return { s, poly, fillEl };
  });

  function pts(data, getter, maxV) {
    const n = Math.max(2, data.length);
    const stepX = CH_W / (n - 1);
    return data.map((d, i) => {
      const v = Math.max(0, Math.min(1, (getter(d) || 0) / maxV));
      const x = i * stepX;
      const y = CH_H - v * (CH_H - 8) - 4;
      return [x, y];
    });
  }

  return {
    draw(data) {
      const rows = Array.isArray(data) ? data : [];
      for (const { s, poly, fillEl } of layers) {
        const maxV = typeof s.max === 'function' ? s.max(rows) : (s.max || 100);
        const p = pts(rows, s.get, maxV || 1);
        poly.setAttribute('points', p.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '));
        if (fillEl) {
          const area = p.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ') + ` ${CH_W},${CH_H} 0,${CH_H}`;
          fillEl.setAttribute('points', area);
        }
      }
    },
    // SVG 自适应，resize 不需要重算，保留接口对齐旧调用
    redraw() {},
  };
}

const chartCpu = makeChart($('chart-cpu'), {
  yLabels: true,
  series: [{ get: (d) => d.cpu, color: '#38bdf8', fill: 'rgba(56,189,248,.14)', max: 100 }],
});
const chartMem = makeChart($('chart-mem'), {
  yLabels: true,
  series: [
    { get: (d) => d.mem, color: '#a78bfa', fill: 'rgba(167,139,250,.12)', max: 100 },
    { get: (d) => d.swap, color: '#fb923c', max: 100 },
  ],
});
const chartIo = makeChart($('chart-io'), {
  series: [
    { get: (d) => d.rd, color: '#34d399', max: (rows) => Math.max(1024, ...rows.map((r) => r.rd || 0)) * 1.15 },
    { get: (d) => d.wr, color: '#fbbf24', max: (rows) => Math.max(1024, ...rows.map((r) => r.wr || 0)) * 1.15 },
    { get: (d) => d.rx, color: '#38bdf8', max: (rows) => Math.max(1024, ...rows.map((r) => r.rx || 0)) * 1.15 },
    { get: (d) => d.tx, color: '#f472b6', max: (rows) => Math.max(1024, ...rows.map((r) => r.tx || 0)) * 1.15 },
  ],
});

// ── 状态 ────────────────────────────────────────────────────────────────
let lastSnapshot = null;
let rowsCache = [];
let sortKey = 'cpu';
let query = '';
let currentTab = 'overview';     // overview | process | ports | containers | services | audit
let processView = 'list';        // list | tree（仅「进程」tab 内的子视图）
let historyRange = '60s';        // 60s = 实时内存数据；其它 = 从 /api/history 读落盘数据
let containerFilter = '';        // 容器名或短 ID，非空时列表只显示该容器进程
// ── 全局 fetch 超时 ────────────────────────────────────────────────────
// 后端卡住时（systemctl/docker 变慢、socket 半死），没有超时的 fetch 会永远挂着：
// 界面停在「加载中…」、模块级 flag 永久占用、后续点击被静默吞掉。
// 这里统一包一层，20 秒必断，不必在 38 个调用点各写一遍。
const __rawFetch = window.fetch.bind(window);
window.fetch = (input, init = {}) => {
  if (init && init.signal) return __rawFetch(input, init);       // 调用方自带取消信号就不重复包
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  return __rawFetch(input, { ...init, signal: ac.signal })
    .finally(() => clearTimeout(timer));
};

const collapsed = new Set();     // 树视图里被折叠的 pid
let currentDetailPid = null;
let es = null;
let pollTimer = null;

// ── 渲染：KPI ───────────────────────────────────────────────────────────
function renderKpis(s) {
  $('cpu-val').textContent = fmtPct(s.cpu.totalPct);
  $('cpu-bar').style.width = s.cpu.totalPct + '%';
  $('cpu-cores').textContent = `${s.cpu.count} 核`;
  $('cpu-model').textContent = s.cpu.model || '—';

  $('mem-val').textContent = fmtPct(s.mem.usedPct);
  $('mem-bar').style.width = s.mem.usedPct + '%';
  $('mem-sub').textContent = `${fmtBytes(s.mem.used)} / ${fmtBytes(s.mem.total)}`;

  $('swap-val').textContent = fmtPct(s.swap.usedPct);
  $('swap-bar').style.width = s.swap.usedPct + '%';
  $('swap-sub').textContent = s.swap.total ? `${fmtBytes(s.swap.used)} / ${fmtBytes(s.swap.total)}` : '未启用';

  $('load-1').textContent = s.load[0].toFixed(2);
  $('load-5').textContent = s.load[1].toFixed(2);
  $('load-15').textContent = s.load[2].toFixed(2);
  $('uptime-val').textContent = fmtUptime(s.uptime);
  $('proc-val').textContent = s.procTotal;
  const threads = rowsCache.reduce((a, p) => a + (p.threads || 0), 0);
  $('threads-val').textContent = threads ? `${threads} 线程` : '—';
  $('io-val').textContent = `↓${fmtBps(s.io.readBps)} ↑${fmtBps(s.io.writeBps)}`;
  $('net-val').textContent = `↓${fmtBps(s.net.rxBps)} ↑${fmtBps(s.net.txBps)}`;
  $('cpu-legend').innerHTML = '';
  $('cpu-legend').append('当前 ', Object.assign(document.createElement('b'), { textContent: fmtPct(s.cpu.totalPct) + '%' }));
  $('lg-mem').textContent = fmtPct(s.mem.usedPct) + '%';
  $('lg-swap').textContent = fmtPct(s.swap.usedPct) + '%';
  $('lg-rd').textContent = fmtBps(s.io.readBps);
  $('lg-wr').textContent = fmtBps(s.io.writeBps);
  $('lg-rx').textContent = fmtBps(s.net.rxBps);
  $('lg-tx').textContent = fmtBps(s.net.txBps);
  const hist = s.history || [];
  const peak = Math.max(1024, ...hist.map((h) => Math.max(h.rd || 0, h.wr || 0, h.rx || 0, h.tx || 0)));
  $('io-scale').textContent = `纵轴峰值 ${fmtBps(peak)}`;

  // 每核
  const cores = $('cores');
  if (cores.childElementCount !== s.cpu.cores.length) {
    cores.textContent = '';
    s.cpu.cores.forEach((_, i) => {
      const wrap = el('div', 'core');
      const label = el('span', 'core-label', 'CPU' + i);
      const bar = el('div', 'core-bar');
      const fill = el('i');
      bar.appendChild(fill);
      wrap.append(label, bar);
      cores.appendChild(wrap);
    });
  }
  [...cores.children].forEach((node, i) => {
    const v = s.cpu.cores[i] || 0;
    node.querySelector('i').style.width = v + '%';
    node.dataset.busy = v > 80 ? 'hot' : v > 50 ? 'warm' : 'cool';
  });

  if (s.psi) renderPsi(s.psi);
  if (s.volumes) renderVolumes(s.volumes);
  $('ver').textContent = s.version;
  $('ts-line').textContent = '更新于 ' + new Date(s.ts).toLocaleTimeString();
  if (historyRange === '60s') {
    const hist2 = s.history || [];
    chartCpu.draw(hist2);
    chartMem.draw(hist2);
    chartIo.draw(hist2);
  }
}

// ── 渲染：进程表 ────────────────────────────────────────────────────────
// 行级增量渲染：390 行 × 10 列的表格每次刷新都重建 DOM，会掉帧、丢滚动位置、
// 打断正在进行的点击。pid 顺序没变时只改变化的单元格文本。
let tablePids = [];
const rowRefs = new Map();          // pid → 该行需要更新的节点引用

function buildRow(p) {
  const tr = el('tr');
  tr.dataset.pid = p.pid;
  tr.appendChild(el('td', 'num mono', p.pid));
  const nameTd = el('td', 'pname');
  const nm = el('span', 'nm', p.name);
  let cmdEl = null;
  if (p.cmd && p.cmd !== p.name) { cmdEl = el('span', 'cmd', p.cmd); nameTd.append(nm, cmdEl); }
  else nameTd.appendChild(nm);
  tr.appendChild(nameTd);
  const cpuTd = el('td', 'num mono');
  const cpuSpan = el('span', 'cpuval', fmtPct(p.cpuPct));
  cpuTd.appendChild(cpuSpan);
  if (p.cpuPct > 10) cpuTd.dataset.hot = '1';
  tr.appendChild(cpuTd);
  const rssTd = el('td', 'num mono', fmtBytes(p.rss));
  tr.appendChild(rssTd);
  const thTd = el('td', 'num mono hide-sm', p.threads);
  tr.appendChild(thTd);
  const userTd = el('td', 'hide-sm', p.user);
  tr.appendChild(userTd);
  const stTd = el('td', 'hide-sm');
  const stSpan = el('span', 'state s-' + p.state, STATE_CN[p.state] || p.state);
  stTd.appendChild(stSpan);
  tr.appendChild(stTd);
  const cTd = el('td', 'hide-md');
  if (p.container) {
    const chip = el('span', 'chip cont', p.container.name);
    chip.title = '容器 ID ' + p.container.id + '（点击只看该容器）';
    chip.dataset.action = 'filter-container';
    chip.dataset.container = p.container.name;
    cTd.appendChild(chip);
  } else cTd.appendChild(el('span', 'hint', '—'));
  tr.appendChild(cTd);
  const ctTd = el('td', 'num mono hide-sm', fmtCpuTime(p.cpuTime));
  tr.appendChild(ctTd);
  const actTd = el('td', 'act');
  const btn = el('button', 'btn tiny', '信号');
  btn.type = 'button';
  btn.dataset.action = 'signal';
  btn.dataset.pid = p.pid;
  actTd.appendChild(btn);
  tr.appendChild(actTd);
  rowRefs.set(p.pid, { tr, cpuTd, cpuSpan, rssTd, thTd, userTd, stSpan, stTd, cTd, ctTd, nm, nameTd, cmdEl, container: p.container ? p.container.name : '' });
  return tr;
}

function setText(node, v) {
  if (!node) return;
  const s = String(v);
  if (node.textContent !== s) node.textContent = s;
}

function patchRow(p, r) {
  if (!r) return;
  setText(r.cpuSpan, fmtPct(p.cpuPct) );
  if (p.cpuPct > 10) r.cpuTd.dataset.hot = '1'; else delete r.cpuTd.dataset.hot;
  setText(r.rssTd, fmtBytes(p.rss));
  setText(r.thTd, p.threads);
  setText(r.userTd, p.user);
  const stLabel = STATE_CN[p.state] || p.state;
  if (r.stSpan.textContent !== stLabel) r.stSpan.textContent = stLabel;
  const stCls = 'state s-' + p.state;
  if (r.stSpan.className !== stCls) r.stSpan.className = stCls;
  setText(r.ctTd, fmtCpuTime(p.cpuTime));
  // 容器归属可能变（进程刚被 container 认领），变了才重建这一个 chip
  const cName = p.container ? p.container.name : '';
  if (cName !== r.container) {
    r.cTd.textContent = '';
    if (p.container) {
      const chip = el('span', 'chip cont', p.container.name);
      chip.title = '容器 ID ' + p.container.id + '（点击只看该容器）';
      chip.dataset.action = 'filter-container';
      chip.dataset.container = p.container.name;
      r.cTd.appendChild(chip);
    } else r.cTd.appendChild(el('span', 'hint', '—'));
    r.container = cName;
  }
  // 名称/命令行：一般不变，变了才动
  if (r.nm.textContent !== p.name) r.nm.textContent = p.name;
  if (p.cmd && p.cmd !== p.name) {
    if (!r.cmdEl) { r.cmdEl = el('span', 'cmd', p.cmd); r.nameTd.appendChild(r.cmdEl); }
    else setText(r.cmdEl, p.cmd);
  } else if (r.cmdEl) {
    r.cmdEl.remove();
    r.cmdEl = null;
  }
}

function renderTable(rows) {
  rowsCache = rows;
  const tb = $('ptbody');
  const sameShape = rows.length === tablePids.length && rows.every((p, i) => p.pid === tablePids[i]);
  if (sameShape && rowRefs.size) {
    for (const p of rows) patchRow(p, rowRefs.get(p.pid));
  } else {
    tb.textContent = '';
    rowRefs.clear();
    const frag = document.createDocumentFragment();
    for (const p of rows) frag.appendChild(buildRow(p));
    tb.appendChild(frag);
    tablePids = rows.map((p) => p.pid);
  }
  $('empty').hidden = rows.length > 0;
  $('table-info').textContent = `${rows.length} 个进程${query ? `（已过滤，共 ${lastSnapshot?.procTotal ?? '?'} 个）` : ''}`;
}

// ── 视图：进程树 ────────────────────────────────────────────────────────
// 用 ppid 建树。根节点 = 父进程不在当前结果集里（search/容器过滤后很常见，
// 不能假设 pid 1 一定是唯一根，否则过滤后整棵树会消失）。
const treeRefs = new Map();     // pid → 该行需要更新的节点（树视图按行复用，不整表重建）

function treeRow(node, depth, hasKids, isCollapsed, aggVal) {
  let r = treeRefs.get(node.pid);
  if (!r) {
    const tr = el('tr');
    tr.dataset.pid = node.pid;
    const pidTd = el('td', 'num mono', node.pid);
    tr.appendChild(pidTd);
    const nameTd = el('td', 'tree-cell');
    tr.appendChild(nameTd);
    const cpuTd = el('td', 'num mono');
    const cpuSpan = el('span', 'cpuval', '0');
    cpuTd.appendChild(cpuSpan);
    tr.appendChild(cpuTd);
    const rssTd = el('td', 'num mono');
    tr.appendChild(rssTd);
    const thTd = el('td', 'num mono hide-sm');
    tr.appendChild(thTd);
    const cTd = el('td', 'hide-md');
    tr.appendChild(cTd);
    const actTd = el('td', 'act');
    const btn = el('button', 'btn tiny', '信号');
    btn.type = 'button';
    btn.dataset.action = 'signal';
    btn.dataset.pid = node.pid;
    actTd.appendChild(btn);
    tr.appendChild(actTd);
    r = { tr, nameTd, cpuTd, cpuSpan, rssTd, thTd, cTd, container: '' };
    treeRefs.set(node.pid, r);
  }
  // 名称单元格：缩进 / 折叠三角 / 名字 / 子树合计，每次重画这 4 个小节点
  const cell = r.nameTd;
  cell.textContent = '';
  const indent = el('span', 'indent');
  indent.style.paddingLeft = (depth * 16) + 'px';
  if (hasKids) {
    const tg = el('button', 'toggle', isCollapsed ? '▶' : '▼');
    tg.type = 'button';
    tg.dataset.action = 'toggle';
    tg.dataset.pid = node.pid;
    indent.appendChild(tg);
  } else {
    indent.appendChild(el('span', 'toggle-ph', '·'));
  }
  indent.appendChild(el('span', 'nm', node.name));
  if (hasKids && (aggVal.cpu > node.cpuPct + 0.05 || aggVal.mem > node.rss * 1.05)) {
    indent.appendChild(el('span', 'agg', `子树 ${aggVal.cpu}% / ${fmtBytes(aggVal.mem)}`));
  }
  cell.appendChild(indent);

  const cpuText = fmtPct(node.cpuPct);
  if (r.cpuSpan.textContent !== cpuText) r.cpuSpan.textContent = cpuText;
  if (node.cpuPct > 10) r.cpuTd.dataset.hot = '1'; else delete r.cpuTd.dataset.hot;
  const rssText = fmtBytes(node.rss);
  if (r.rssTd.textContent !== rssText) r.rssTd.textContent = rssText;
  const thText = String(node.threads);
  if (r.thTd.textContent !== thText) r.thTd.textContent = thText;
  const cName = node.container ? node.container.name : '';
  if (cName !== r.container) {
    r.cTd.textContent = '';
    if (node.container) {
      const chip = el('span', 'chip cont', node.container.name);
      chip.dataset.action = 'filter-container';
      chip.dataset.container = node.container.name;
      chip.title = '只看该容器的进程';
      r.cTd.appendChild(chip);
    }
    else r.cTd.appendChild(el('span', 'hint', '—'));
    r.container = cName;
  }
  return r.tr;
}

function renderTree(rows) {
  const byPid = new Map(rows.map((p) => [p.pid, p]));
  const children = new Map();
  const roots = [];
  for (const p of rows) {
    if (p.ppid && byPid.has(p.ppid) && p.ppid !== p.pid) {
      if (!children.has(p.ppid)) children.set(p.ppid, []);
      children.get(p.ppid).push(p);
    } else roots.push(p);
  }
  // 子树聚合：父节点显示「自身 + 子孙」合计
  const agg = new Map();
  function sum(node) {
    if (agg.has(node.pid)) return agg.get(node.pid);
    let cpu = node.cpuPct, mem = node.rss, th = node.threads;
    for (const c of children.get(node.pid) || []) {
      const sub = sum(c);
      cpu += sub.cpu; mem += sub.mem; th += sub.th;
    }
    const v = { cpu: r1x(cpu), mem, th };
    agg.set(node.pid, v);
    return v;
  }
  const r1x = (v) => Math.round(v * 10) / 10;
  for (const r of roots) sum(r);

  const tb = $('treebody');
  const frag = document.createDocumentFragment();
  const seen = new Set();
  const walk = (node, depth) => {
    const kids = (children.get(node.pid) || []).sort((a, b) => b.cpuPct - a.cpuPct);
    const hasKids = kids.length > 0;
    const isCollapsed = collapsed.has(node.pid);
    seen.add(node.pid);
    frag.appendChild(treeRow(node, depth, hasKids, isCollapsed, agg.get(node.pid) || { cpu: node.cpuPct, mem: node.rss }));
    if (!isCollapsed) for (const k of kids) walk(k, depth + 1);
  };
  roots.sort((a, b) => (agg.get(b.pid)?.cpu || 0) - (agg.get(a.pid)?.cpu || 0));
  for (const r of roots) walk(r, 0);
  // 顺序会变，但节点是复用的：整块换进去只触发一次重排，不会重建上百行 DOM
  tb.textContent = '';
  tb.appendChild(frag);
  for (const pid of [...treeRefs.keys()]) if (!seen.has(pid)) treeRefs.delete(pid);
  // 折叠状态也按存活进程清理，否则长期开着页面会单调增长
  for (const pid of [...collapsed]) if (!seen.has(pid)) collapsed.delete(pid);
  $('table-info').textContent = `${rows.length} 个进程 · ${roots.length} 个根节点${collapsed.size ? ` · 已折叠 ${collapsed.size}` : ''}`;
}

// ── 视图：监听端口 ──────────────────────────────────────────────────────
async function renderPorts() {
  const r = await fetch(API + '/ports', { cache: 'no-store' });
  if (!r.ok) throw new Error('端口列表请求失败: HTTP ' + r.status);
  const d = await r.json();
  const tb = $('portbody');
  tb.textContent = '';
  const frag = document.createDocumentFragment();
  for (const p of d.ports || []) {
    const tr = el('tr');
    tr.dataset.pid = p.pid;
    tr.appendChild(el('td', 'num mono port', p.port));
    tr.appendChild(el('td', '', p.proto));
    tr.appendChild(el('td', 'mono', p.addr));
    tr.appendChild(el('td', 'num mono', p.pid));
    const nm = el('td', 'pname');
    nm.appendChild(el('span', 'nm', p.name));
    if (p.cmd) nm.appendChild(el('span', 'cmd', p.cmd));
    tr.appendChild(nm);
    tr.appendChild(el('td', 'hide-sm', p.user));
    const cTd = el('td', 'hide-md');
    if (p.container) cTd.appendChild(el('span', 'chip cont', p.container.name));
    else cTd.appendChild(el('span', 'hint', '—'));
    tr.appendChild(cTd);
    frag.appendChild(tr);
  }
  tb.appendChild(frag);
  $('ports-empty').hidden = (d.ports || []).length > 0;
  $('table-info').textContent = `${d.total} 个监听端口`;
  $('badge-ports').textContent = d.total ?? 0;
}

// ── 视图：容器聚合 ──────────────────────────────────────────────────────
async function renderContainers() {
  const r = await fetch(API + '/containers', { cache: 'no-store' });
  if (!r.ok) throw new Error('容器列表请求失败: HTTP ' + r.status);
  const d = await r.json();
  // docker stats 单独一次调用：拿真实的 CPU%/内存/网络（进程聚合的口径不算容器开销）
  let stats = new Map();
  try {
    const sd = await (await fetch(API + '/container/stats', { cache: 'no-store' })).json();
    stats = new Map((sd.stats || []).map((x) => [x.name, x]));
  } catch { /* docker 不可用就只显示进程聚合 */ }
  const tb = $('contbody');
  tb.textContent = '';
  const frag = document.createDocumentFragment();
  for (const c of d.containers || []) {
    const tr = el('tr');
    const nm = el('td', 'pname');
    nm.appendChild(el('span', 'nm', c.name));
    tr.appendChild(nm);
    tr.appendChild(el('td', 'num mono', c.procs));
    const io = stats.get(c.name) || stats.get(c.id);
    // 有 docker stats 就用它（CPU%/内存含容器自身开销，比进程相加更准）
    tr.appendChild(el('td', 'num mono', io && io.cpuPct ? io.cpuPct : fmtPct(c.cpuPct)));
    tr.appendChild(el('td', 'num mono', io && io.memUsage ? io.memUsage.split(' / ')[0] : fmtBytes(c.rss)));
    tr.appendChild(el('td', 'num mono hide-sm', io && io.pids ? io.pids : c.threads));
    tr.appendChild(el('td', 'num mono hide-md hint', io ? `${io.netIO || '—'}` : '—'));
    tr.appendChild(el('td', 'num mono small-id', c.id));
    const act = el('td', 'act svc-actions');
    const mkBtn = (label, action, cls) => {
      const b = el('button', 'btn tiny' + (cls ? ' ' + cls : ''), label);
      b.type = 'button';
      b.dataset.action = action;
      b.dataset.container = c.name;
      return b;
    };
    act.append(
      mkBtn('看进程', 'filter-container'),
      mkBtn('日志', 'cont-log'),
      mkBtn('重启', 'cont-restart'),
      mkBtn('停止', 'cont-stop', 'warn'),
    );
    tr.appendChild(act);
    frag.appendChild(tr);
  }
  tb.appendChild(frag);
  $('containers-empty').hidden = (d.containers || []).length > 0;
  $('table-info').textContent = `${d.total} 个容器${d.dockerAvailable ? '' : '（docker 名解析不可用，显示短 ID）'}`;
  $('badge-containers').textContent = d.total ?? 0;
}

// ── 视图：systemd 服务 ──────────────────────────────────────────────────
async function renderServices() {
  const q = new URL(API + '/services', location.origin);
  // 用服务页自己的筛选词：早期复用进程页的 query，
  // 在进程页搜过 "nginx" 再切过来，服务列表会被无声过滤
  if (svcQuery) q.searchParams.set('q', svcQuery);
  const st = $('svc-state').value;
  if (st) q.searchParams.set('state', st);
  const r = await fetch(q.toString(), { cache: 'no-store' });
  if (!r.ok) throw new Error('服务列表请求失败: HTTP ' + r.status);
  const d = await r.json();
  const tb = $('svcbody');
  tb.textContent = '';
  const frag = document.createDocumentFragment();
  for (const u of d.units || []) {
    const tr = el('tr');
    tr.dataset.unit = u.name;
    const nm = el('td', 'svc-name mono', u.name.replace(/\.service$/, ''));
    tr.appendChild(nm);
    const stTd = el('td');
    const cls = u.active === 'active' ? 's-R' : (u.active === 'failed' ? 's-Z' : 's-T');
    stTd.appendChild(el('span', 'state ' + cls, u.active === 'active' ? '运行中' : (u.active === 'failed' ? '失败' : '未运行')));
    if (u.sub && u.sub !== u.active) stTd.appendChild(el('span', 'hint svc-sub', u.sub));
    tr.appendChild(stTd);
    tr.appendChild(el('td', 'hide-sm svc-desc', u.desc || '—'));
    const act = el('td', 'act svc-actions');
    const mk = (label, action, cls2) => {
      const b = el('button', 'btn tiny' + (cls2 ? ' ' + cls2 : ''), label);
      b.type = 'button';
      b.dataset.action = 'service';
      b.dataset.unit = u.name;
      b.dataset.op = action;
      if (u.protected && action !== 'start') { b.disabled = true; b.title = '关键服务，禁止该操作'; }
      return b;
    };
    if (u.active === 'active') {
      act.append(mk('重启', 'restart'), mk('停止', 'stop', 'warn'));
    } else {
      act.append(mk('启动', 'start'));
    }
    // 日志：为什么 failed 得能看到它自己的日志，不能逼用户去 SSH
    const logBtn = el('button', 'btn tiny ghost', '日志');
    logBtn.type = 'button';
    logBtn.dataset.action = 'svc-log';
    logBtn.dataset.unit = u.name;
    act.appendChild(logBtn);
    // 开机自启（与启停是两件事：这个是改配置）
    if (u.enabledState === 'enabled' || u.enabledState === 'disabled') {
      const on = u.enabledState === 'enabled';
      const eb = el('button', 'btn tiny ghost', on ? '取消自启' : '开机自启');
      eb.type = 'button';
      eb.dataset.action = 'svc-enable';
      eb.dataset.unit = u.name;
      eb.dataset.enable = on ? '0' : '1';
      if (u.protected && on) { eb.disabled = true; eb.title = '关键服务，禁止取消开机自启'; }
      act.appendChild(eb);
    }
    tr.appendChild(act);
    frag.appendChild(tr);
  }
  tb.appendChild(frag);
  $('services-empty').hidden = (d.units || []).length > 0;
  const c = d.counts || {};
  $('svc-counts').textContent = `共 ${c.all ?? 0} 个服务 · 运行中 ${c.running ?? 0}${c.failed ? ` · 失败 ${c.failed}` : ''}`;
  $('table-info').textContent = `${d.total} 个服务`;
  const badge = $('badge-services');
  badge.textContent = c.failed ? `${c.failed} 失败` : `${c.running ?? 0} 运行`;
  badge.classList.toggle('alert', !!c.failed);
}

async function doServiceAction(name, action) {
  const label = { start: '启动', stop: '停止', restart: '重启' }[action] || action;
  confirmModal(
    `${label}服务`,
    `目标：${name}\n操作：${label}${action === 'stop' ? '\n\n停止后依赖它的功能会中断。' : ''}`,
    '确定' + label,
    async () => {
      try {
        const r = await fetch(API + '/service', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, action, confirm: true }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
        toast(`${name} ${label}成功`, 'ok');
        loadAudit();
        renderServices();
      } catch (e) {
        toast(`${label}失败：` + e.message, 'error');
      }
    },
  );
}

function doServiceEnable(name, enable) {
  const label = enable ? '开机自启' : '取消开机自启';
  confirmModal(
    enable ? '设置开机自启' : '取消开机自启',
    `目标：${name}\n操作：${label}${enable ? '' : '\n\n取消后系统重启时它不会自动运行。'}`,
    '确定',
    async () => {
      try {
        const r = await fetch(API + '/service/enable', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, enable, confirm: true }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
        toast(`${name} ${label}成功`, 'ok');
        renderServices();
      } catch (e) {
        toast(`${label}失败：` + e.message, 'error');
      }
    },
  );
}

// ── 告警 ────────────────────────────────────────────────────────────────
let alertMeta = {};                 // metric → { label, unit, needTarget, targetHint }
let alertLevels = { 0: '普通', 1: '警告', 2: '严重' };
let alertRules = [];                // 最近一次规则列表
let alertLive = [];                 // 每条规则当前的实测值 / 是否违规中
let editingAlertId = 0;

function fmtAgo(ts) {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
}

function fmtDur(sec) {
  const s = Number(sec) || 0;
  if (!s) return '立即';
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟`;
  return `${(s / 3600).toFixed(s % 3600 ? 1 : 0)} 小时`;
}

function metricText(rule) {
  const m = alertMeta[rule.metric] || {};
  const unit = m.unit || '';
  if (rule.metric === 'proc_missing') return `进程不存在：${rule.target}`;
  if (rule.metric === 'unit_failed') return `单元 failed：${rule.target}`;
  const tgt = rule.target ? ` ${rule.target}` : '';
  return `${m.label || rule.metric}${tgt} ${rule.op} ${rule.threshold}${unit}`;
}

async function loadAlerts() {
  try {
    const r = await fetch(API + '/alerts', { cache: 'no-store' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    alertMeta = d.metrics || {};
    alertLevels = d.levels || alertLevels;
    alertRules = d.rules || [];
    alertLive = d.live || [];
    renderAlertRules();
    await loadAlertEvents();
    await loadWatchdogs();
    const st = d.stats || {};
    $('alerts-hint').textContent = `${st.rules || 0} 条规则（启用 ${st.enabled || 0}）· 累计 ${st.events || 0} 次事件`;
    const firing = alertLive.filter((x) => x.breaching).length;
    $('badge-alerts').textContent = firing ? String(firing) : '—';
    $('badge-alerts').dataset.hot = firing ? '1' : '';
  } catch (e) {
    toast('告警数据读取失败：' + e.message, 'error');
  }
}

function renderAlertRules() {
  const tb = $('alert-body');
  tb.textContent = '';
  const liveOf = new Map(alertLive.map((x) => [x.id, x]));
  const frag = document.createDocumentFragment();
  for (const rule of alertRules) {
    const live = liveOf.get(rule.id) || {};
    const tr = el('tr');
    if (!rule.enabled) tr.classList.add('row-dim');
    tr.appendChild(el('td', 'num mono', rule.id));
    tr.appendChild(el('td', 'pname', rule.name));
    tr.appendChild(el('td', 'hint', metricText(rule)));
    tr.appendChild(el('td', 'num mono', rule.metric === 'proc_missing' || rule.metric === 'unit_failed' ? '—' : `${rule.threshold}`));
    tr.appendChild(el('td', 'num mono hide-sm', fmtDur(rule.durationSec)));
    tr.appendChild(el('td', 'num mono hide-sm', fmtDur(rule.cooldownSec)));
    const nt = el('td', 'hide-md');
    if (rule.notifyFn) nt.appendChild(el('span', 'chip', '系统通知'));
    if (rule.webhook) nt.appendChild(el('span', 'chip cont', 'Webhook'));
    if (!rule.notifyFn && !rule.webhook) nt.appendChild(el('span', 'hint', '未配置'));
    tr.appendChild(nt);
    const stTd = el('td');
    if (live.breaching) {
      const chip = el('span', 'chip alarm', `违规中 ${live.value != null ? (Math.round(live.value * 10) / 10) : ''}`);
      chip.title = `自 ${new Date(live.sinceMs || Date.now()).toLocaleTimeString()} 起持续超标`;
      stTd.appendChild(chip);
    } else if (live.value != null) {
      stTd.appendChild(el('span', 'chip dim', `正常 ${Math.round(live.value * 10) / 10}`));
    } else {
      stTd.appendChild(el('span', 'hint', rule.enabled ? '—' : '已停用'));
    }
    tr.appendChild(stTd);
    tr.appendChild(el('td', 'num hide-sm hint', fmtAgo(rule.lastFired)));
    const act = el('td', 'act');
    const mk = (label, action, cls) => {
      const b = el('button', 'btn tiny' + (cls ? ' ' + cls : ''), label);
      b.type = 'button';
      b.dataset.action = action;
      b.dataset.id = rule.id;
      return b;
    };
    act.append(mk('编辑', 'alert-edit'), mk('测试', 'alert-test'), mk('删除', 'alert-del', 'warn'));
    tr.appendChild(act);
    frag.appendChild(tr);
  }
  tb.appendChild(frag);
  $('alerts-empty').hidden = alertRules.length > 0;
}

async function loadAlertEvents() {
  try {
    const lv = $('alert-level-filter') ? $('alert-level-filter').value : '';
    const q = new URL(API + '/alerts/events', location.origin);
    q.searchParams.set('limit', '50');
    if (lv !== '') q.searchParams.set('level', lv);
    const d = await (await fetch(q.toString(), { cache: 'no-store' })).json();
    const tb = $('alert-events');
    tb.textContent = '';
    const frag = document.createDocumentFragment();
    for (const ev of d.rows || []) {
      const tr = el('tr');
      tr.appendChild(el('td', 'num mono hint', new Date(ev.ts).toLocaleString()));
      const lvTd = el('td');
      const cls = ev.level === 2 ? 'chip alarm' : (ev.level === 1 ? 'chip warn' : 'chip dim');
      lvTd.appendChild(el('span', cls, alertLevels[ev.level] || ev.level));
      tr.appendChild(lvTd);
      tr.appendChild(el('td', 'pname', ev.ruleName || '—'));
      tr.appendChild(el('td', '', ev.message || ''));
      const dl = el('td', 'hide-sm hint');
      const parts = [];
      for (const [ch, res] of Object.entries(ev.delivered || {})) {
        const name = ch === 'fnos' ? '系统通知' : (ch === 'webhook' ? 'Webhook' : ch);
        parts.push(`${name} ${res && res.ok ? '✓' : '✗' + (res && res.error ? ' ' + res.error : '')}`);
      }
      dl.textContent = parts.join(' · ') || '—';
      tr.appendChild(dl);
      frag.appendChild(tr);
    }
    tb.appendChild(frag);
    $('alert-events-empty').hidden = (d.rows || []).length > 0;
  } catch (e) { console.warn('[alerts/events] 读取失败:', e.message); }
}

// 规则编辑弹窗
function openAlertModal(rule) {
  editingAlertId = rule ? rule.id : 0;
  $('alert-modal-title').textContent = rule ? `编辑规则 #${rule.id}` : '新建告警规则';
  const sel = $('af-metric');
  sel.textContent = '';
  for (const [key, m] of Object.entries(alertMeta)) {
    const o = document.createElement('option');
    o.value = key;
    o.textContent = m.label;
    sel.appendChild(o);
  }
  const r = rule || { name: '', metric: 'cpu', op: '>', threshold: 90, durationSec: 180, cooldownSec: 900, level: 1, enabled: true, notifyFn: true, webhook: '', target: '' };
  sel.value = r.metric;
  $('af-name').value = r.name || '';
  $('af-threshold').value = r.threshold;
  $('af-duration').value = r.durationSec;
  $('af-cooldown').value = r.cooldownSec;
  $('af-level').value = String(r.level);
  $('af-enabled').checked = r.enabled !== false;
  $('af-notify-fn').checked = r.notifyFn !== false;
  $('af-webhook').value = r.webhook || '';
  $('af-target').value = r.target || '';
  syncAlertForm();
  showMask($('alert-mask'));
}

function closeAlertModal() {
  closeMask($('alert-mask'));
}

function syncAlertForm() {
  const m = alertMeta[$('af-metric').value] || {};
  $('af-target-wrap').hidden = !m.needTarget;
  $('af-target-label').textContent = m.targetHint || '目标';
  $('af-target').placeholder = m.targetHint || '';
  // 进程缺失 / 单元异常 是布尔判定，没有阈值
  const noThreshold = $('af-metric').value === 'proc_missing' || $('af-metric').value === 'unit_failed';
  $('af-threshold-wrap').hidden = noThreshold;
}

function alertFormBody() {
  return {
    id: editingAlertId || undefined,
    name: $('af-name').value.trim(),
    metric: $('af-metric').value,
    threshold: Number($('af-threshold').value) || 0,
    durationSec: Number($('af-duration').value) || 0,
    cooldownSec: Number($('af-cooldown').value) || 600,
    level: Number($('af-level').value) || 0,
    enabled: $('af-enabled').checked,
    notifyFn: $('af-notify-fn').checked,
    webhook: $('af-webhook').value.trim(),
    target: $('af-target').value.trim(),
    // op 必须在提交里带上：后端缺省会退回 '>'，
    // 于是一条「磁盘可用 < 10%」的规则被编辑保存后会反转成「> 10%」（从该报变成不报）
    op: (alertRules.find((x) => x.id === editingAlertId) || {}).op || '>',
  };
}

async function saveAlert() {
  const body = alertFormBody();
  try {
    const r = await fetch(API + '/alerts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    toast(editingAlertId ? '规则已更新' : '规则已创建', 'ok');
    closeAlertModal();
    await loadAlerts();
  } catch (e) {
    toast('保存失败：' + e.message, 'error');
  }
}

async function testAlert() {
  const body = alertFormBody();
  try {
    const r = await fetch(API + '/alerts/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editingAlertId ? { id: editingAlertId } : { rule: body }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    const dl = d.delivered || {};
    const ok = Object.values(dl).some((x) => x && x.ok);
    const detail = Object.entries(dl).map(([k, v]) => `${k === 'fnos' ? '系统通知' : k} ${v.ok ? '成功' : '失败（' + (v.error || '') + '）'}`).join('，');
    toast((ok ? '测试通知已发出：' : '测试通知发送失败：') + detail, ok ? 'ok' : 'error');
    await loadAlertEvents();
  } catch (e) {
    toast('测试失败：' + e.message, 'error');
  }
}

function deleteAlert(id) {
  const rule = alertRules.find((x) => x.id === id);
  confirmModal('删除告警规则', `确定删除「${rule ? rule.name : '#' + id}」？\n删除后不再产生该告警，历史事件保留。`, '确定删除', async () => {
    try {
      const r = await fetch(API + '/alerts/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, confirm: true }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
      toast('规则已删除', 'ok');
      await loadAlerts();
    } catch (e) {
      toast('删除失败：' + e.message, 'error');
    }
  });
}

// ── 日志查看（journalctl / docker logs）──────────────────────────────────
let logUnit = '';
let logKind = 'journal';          // journal | docker

async function openLog(unit) {
  logKind = 'journal';
  logUnit = unit || '';
  $('log-title').textContent = unit ? `日志 · ${unit}` : '系统日志';
  $('log-pre').textContent = '加载中…';
  showMask($('log-mask'));
  await loadLog();
}

async function openContainerLog(name) {
  logKind = 'docker';
  logUnit = name || '';
  $('log-title').textContent = `容器日志 · ${name}`;
  $('log-pre').textContent = '加载中…';
  showMask($('log-mask'));
  await loadLog();
}

// 延迟隐藏必须可取消：关闭后立刻重开时，旧定时器会把刚打开的层再藏起来
// （表现为 class="show" 与 hidden 同时存在，面板直接消失）
function hideLater(el, ms = 160) {
  if (!el) return;
  if (el.__hideTimer) clearTimeout(el.__hideTimer);
  el.__hideTimer = setTimeout(() => { el.hidden = true; el.__hideTimer = null; }, ms);
}
function showMask(el) {
  if (!el) return;
  if (el.__hideTimer) { clearTimeout(el.__hideTimer); el.__hideTimer = null; }
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
}
function closeMask(el, ms = 160) {
  if (!el) return;
  el.classList.remove('show');
  hideLater(el, ms);
}

function closeLog() {
  closeMask($('log-mask'));
}

function closeSnapModal() {
  closeMask($('snap-mask'));
}

async function loadLog() {
  const isDocker = logKind === 'docker';
  // 级别/关键字筛选只有 journalctl 支持，docker logs 用不上 —— 显式禁用并给出说明
  if ($('log-priority')) $('log-priority').disabled = isDocker;
  if ($('log-grep')) {
    $('log-grep').disabled = isDocker;
    $('log-grep').placeholder = isDocker ? '容器日志不支持关键字过滤' : '关键字过滤（回车生效）';
  }
  const q = new URL(API + (isDocker ? '/container/logs' : '/journal'), location.origin);
  if (isDocker) {
    if (logUnit) q.searchParams.set('name', logUnit);
  } else {
    if (logUnit) q.searchParams.set('unit', logUnit);
    const prio = $('log-priority').value;
    if (prio) q.searchParams.set('priority', prio);
    const grep = $('log-grep').value.trim();
    if (grep) q.searchParams.set('q', grep);
  }
  q.searchParams.set('lines', $('log-lines').value);
  try {
    const r = await fetch(q.toString(), { cache: 'no-store' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    const lines = d.lines || [];
    $('log-pre').textContent = lines.length ? lines.join('\n') : '（没有匹配的日志）';
    $('log-pre').scrollTop = $('log-pre').scrollHeight;
  } catch (e) {
    $('log-pre').textContent = '读取失败：' + e.message;
  }
}

// ── systemd 定时器 ──────────────────────────────────────────────────────
async function loadTimers() {
  try {
    const d = await (await fetch(API + '/timers', { cache: 'no-store' })).json();
    const tb = $('timers-body');
    if (!tb) return;
    tb.textContent = '';
    const frag = document.createDocumentFragment();
    for (const t of d.timers || []) {
      const tr = el('tr');
      tr.appendChild(el('td', 'svc-name mono', t.name.replace(/\.timer$/, '')));
      tr.appendChild(el('td', 'mono hint', t.activates || '—'));
      tr.appendChild(el('td', 'hide-sm hint', t.raw.replace(/\s+/g, ' ').slice(0, 90)));
      frag.appendChild(tr);
    }
    tb.appendChild(frag);
    $('timers-hint').textContent = `${(d.timers || []).length} 个`;
    $('timers-empty').hidden = (d.timers || []).length > 0;
  } catch { /* 忽略 */ }
}

// ── PSI 压力 / 卷用量（概览底部两张卡）────────────────────────────────────
function renderPsi(p) {
  const box = $('psi-grid');
  if (!box || !p) return;
  const items = [
    ['CPU', p.cpu, '进程因 CPU 排队等待'],
    ['内存', p.mem, '进程因内存回收等待'],
    ['磁盘 IO', p.io, '进程因 IO 阻塞'],
  ];
  box.textContent = '';
  for (const [name, v, tip] of items) {
    const cell = el('div', 'psi-item');
    const val = Number(v) || 0;
    cell.dataset.level = val > 20 ? 'hot' : (val > 5 ? 'warm' : 'cool');
    cell.title = tip;
    cell.appendChild(el('span', 'psi-name', name));
    cell.appendChild(el('span', 'psi-val', val.toFixed(2) + '%'));
    const bar = el('div', 'psi-bar');
    const fill = el('i');
    fill.style.width = Math.min(100, val * 4) + '%';     // 25% 压力就画满，视觉更敏感
    bar.appendChild(fill);
    cell.appendChild(bar);
    box.appendChild(cell);
  }
}

function renderVolumes(list) {
  const box = $('vol-list');
  if (!box || !Array.isArray(list)) return;
  box.textContent = '';
  if (!list.length) { box.appendChild(el('span', 'hint', '没有检测到已挂载的卷')); return; }
  for (const v of list) {
    const row = el('div', 'vol-row');
    row.dataset.level = v.usedPct > 90 ? 'hot' : (v.usedPct > 75 ? 'warm' : 'cool');
    const head = el('div', 'vol-head');
    head.appendChild(el('span', 'vol-name', v.mount));
    head.appendChild(el('span', 'vol-pct mono', v.usedPct.toFixed(1) + '%'));
    row.appendChild(head);
    const bar = el('div', 'vol-bar');
    const fill = el('i');
    fill.style.width = Math.min(100, v.usedPct) + '%';
    bar.appendChild(fill);
    row.appendChild(bar);
    row.appendChild(el('span', 'vol-sub hint', `${fmtBytes(v.used)} / ${fmtBytes(v.total)} · 可用 ${fmtBytes(v.avail)}${v.inodesUsedPct > 80 ? ` · inode ${v.inodesUsedPct}%` : ''}`));
    box.appendChild(row);
  }
  const worst = list.reduce((a, b) => (b.usedPct > a.usedPct ? b : a), list[0]);
  if ($('vol-hint')) $('vol-hint').textContent = `${list.length} 个卷 · 最高 ${worst.mount} ${worst.usedPct.toFixed(1)}%`;
}

// ── 连接视图（监听 / 全部）────────────────────────────────────────────────
let portMode = 'listen';
let svcQuery = '';               // 服务页独立筛选词（不共用进程页搜索框）

async function renderConnections() {
  const r = await fetch(API + '/connections', { cache: 'no-store' });
  if (!r.ok) throw new Error('连接列表请求失败: HTTP ' + r.status);
  const d = await r.json();
  const tb = $('connbody');
  tb.textContent = '';
  const frag = document.createDocumentFragment();
  for (const c of d.conns || []) {
    const tr = el('tr');
    tr.dataset.pid = c.pid;
    tr.appendChild(el('td', 'num mono', c.port));
    tr.appendChild(el('td', 'hint', c.proto));
    tr.appendChild(el('td', 'mono hide-sm', c.local));
    tr.appendChild(el('td', 'num mono', c.remotePort || '—'));
    tr.appendChild(el('td', 'mono hide-md', c.remote || '—'));
    const st = el('td');
    const chipCls = 'chip' + (c.state === 'LISTEN' ? ' cont' : (c.state === 'ESTAB' ? ' dim' : ''));
    st.appendChild(el('span', chipCls, c.state));
    tr.appendChild(st);
    tr.appendChild(el('td', 'num mono', c.pid));
    tr.appendChild(el('td', 'pname', c.name));
    const ct = el('td', 'hide-md');
    if (c.container) ct.appendChild(el('span', 'chip cont', c.container.name));
    else ct.appendChild(el('span', 'hint', '—'));
    tr.appendChild(ct);
    frag.appendChild(tr);
  }
  tb.appendChild(frag);
  $('conn-empty').hidden = (d.conns || []).length > 0;
  if ($('port-hint')) {
    const cnt = Object.entries(d.counts || {}).map(([k, v]) => `${k} ${v}`).join(' · ');
    $('port-hint').textContent = `共 ${d.total} 条连接：${cnt || '—'} · 每 10 秒刷新`;
  }
}

function setPortMode(mode) {
  portMode = mode === 'all' ? 'all' : 'listen';
  for (const b of $('port-views').querySelectorAll('.vbtn')) b.classList.toggle('active', b.dataset.pmode === portMode);
  $('view-ports-listen').hidden = portMode !== 'listen';
  $('view-ports-all').hidden = portMode !== 'all';
  refreshView();
}

// ── 进程快照 ────────────────────────────────────────────────────────────
async function saveSnapshot() {
  try {
    const r = await fetch(API + '/snapshot', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: new Date().toLocaleString() }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    toast(`已保存快照 #${d.id}（${d.count} 个进程）`, 'ok');
  } catch (e) {
    toast('保存快照失败：' + e.message, 'error');
  }
}

async function openSnapshotDiff() {
  showMask($('snap-mask'));
  $('snap-result').innerHTML = '<p class="hint">加载中…</p>';
  try {
    const d = await (await fetch(API + '/snapshots', { cache: 'no-store' })).json();
    const list = d.snapshots || [];
    for (const sel of [$('snap-a'), $('snap-b')]) {
      const keep = sel.value;
      sel.textContent = '';
      const first = document.createElement('option');
      first.value = '';
      first.textContent = sel.id === 'snap-a' ? '基准（较早）' : '对比（较晚）';
      sel.appendChild(first);
      for (const s of list) {
        const o = document.createElement('option');
        o.value = String(s.id);
        o.textContent = `#${s.id} ${new Date(s.ts).toLocaleString()} · ${s.count} 进程`;
        sel.appendChild(o);
      }
      sel.value = keep;
    }
    if (list.length >= 2 && !$('snap-a').value) {
      $('snap-a').value = String(list[list.length - 1].id);
      $('snap-b').value = String(list[0].id);
    }
    $('snap-result').innerHTML = list.length
      ? '<p class="hint">选两个快照，点「对比」。</p>'
      : '<p class="hint">还没有快照。在「进程」页点「存快照」记录当前进程清单。</p>';
  } catch (e) {
    $('snap-result').textContent = '读取快照失败：' + e.message;
  }
}

async function runSnapshotDiff() {
  const a = $('snap-a').value;
  const b = $('snap-b').value;
  if (!a || !b) { toast('请选择两个快照', 'error'); return; }
  if (a === b) { toast('请选择两个不同的快照', 'error'); return; }
  try {
    const d = await (await fetch(`${API}/snapshot/diff?a=${a}&b=${b}`, { cache: 'no-store' })).json();
    if (d.error) throw new Error(d.error);
    const box = $('snap-result');
    box.textContent = '';
    const section = (title, rows, muter) => {
      const wrap = el('div', 'snap-section');
      wrap.appendChild(el('h4', '', `${title}（${rows.length}）`));
      if (!rows.length) { wrap.appendChild(el('p', 'hint', '—')); box.appendChild(wrap); return; }
      const tb = el('div', 'chips');
      for (const x of rows.slice(0, 60)) {
        const txt = muter
          ? `${x.name}(${x.pid}) ${x.delta > 0 ? '+' : '-'}${fmtBytes(Math.abs(x.delta))}`
          : `${x.name}(${x.pid}) ${fmtBytes(x.rss)}`;
        tb.appendChild(el('span', 'chip dim', txt));
      }
      wrap.appendChild(tb);
      box.appendChild(wrap);
    };
    section('新增进程', d.added || []);
    section('消失进程', d.removed || []);
    section('内存变化最大', d.changed || [], true);
  } catch (e) {
    toast('对比失败：' + e.message, 'error');
  }
}

// ── 看门狗 ──────────────────────────────────────────────────────────────
let watchdogs = [];
let editingWdId = 0;

async function loadWatchdogs() {
  try {
    const d = await (await fetch(API + '/watchdogs', { cache: 'no-store' })).json();
    watchdogs = d.watchdogs || [];
    renderWatchdogs();
  } catch (e) { console.warn('[watchdogs] 读取失败:', e.message); }
}

function renderWatchdogs() {
  const tb = $('wd-body');
  if (!tb) return;
  tb.textContent = '';
  const frag = document.createDocumentFragment();
  for (const w of watchdogs) {
    const tr = el('tr');
    if (!w.enabled) tr.classList.add('row-dim');
    tr.appendChild(el('td', 'num mono', w.id));
    tr.appendChild(el('td', 'pname', w.name));
    tr.appendChild(el('td', 'mono', w.match));
    tr.appendChild(el('td', 'mono hide-sm hint', w.command.slice(0, 70)));
    tr.appendChild(el('td', 'num mono hide-sm', fmtDur(w.cooldownSec)));
    tr.appendChild(el('td', 'num mono hide-sm', w.runs));
    const st = el('td');
    st.appendChild(el('span', 'chip' + (w.enabled ? ' cont' : ' dim'), w.enabled ? '启用' : '停用'));
    tr.appendChild(st);
    const act = el('td', 'act');
    const edit = el('button', 'btn tiny', '编辑');
    edit.type = 'button'; edit.dataset.action = 'wd-edit'; edit.dataset.id = w.id;
    const del = el('button', 'btn tiny warn', '删除');
    del.type = 'button'; del.dataset.action = 'wd-del'; del.dataset.id = w.id;
    act.append(edit, del);
    tr.appendChild(act);
    frag.appendChild(tr);
  }
  tb.appendChild(frag);
  if ($('wd-empty')) $('wd-empty').hidden = watchdogs.length > 0;
  if ($('wd-hint')) $('wd-hint').textContent = `${watchdogs.length} 条 · 启用 ${watchdogs.filter((w) => w.enabled).length} 条`;
}

function openWatchdogModal(w) {
  editingWdId = w ? w.id : 0;
  $('wd-modal-title').textContent = w ? `编辑看门狗 #${w.id}` : '新建看门狗';
  $('wd-name').value = w ? w.name : '';
  $('wd-match').value = w ? w.match : '';
  $('wd-command').value = w ? w.command : '';
  $('wd-cooldown').value = w ? w.cooldownSec : 300;
  $('wd-enabled').checked = w ? w.enabled : false;
  showMask($('wd-mask'));
}

function closeWatchdogModal() {
  closeMask($('wd-mask'));
}

async function saveWatchdog() {
  const body = {
    id: editingWdId || undefined,
    name: $('wd-name').value.trim(),
    match: $('wd-match').value.trim(),
    command: $('wd-command').value.trim(),
    cooldownSec: Number($('wd-cooldown').value) || 300,
    enabled: $('wd-enabled').checked,
    acknowledge: true,
  };
  try {
    const r = await fetch(API + '/watchdogs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    toast('看门狗已保存', 'ok');
    closeWatchdogModal();
    await loadWatchdogs();
  } catch (e) {
    toast('保存失败：' + e.message, 'error');
  }
}

function deleteWatchdog(id) {
  const w = watchdogs.find((x) => x.id === id);
  confirmModal('删除看门狗', `确定删除「${w ? w.name : '#' + id}」？`, '确定删除', async () => {
    try {
      const r = await fetch(API + '/watchdogs/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, confirm: true }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
      toast('已删除', 'ok');
      await loadWatchdogs();
    } catch (e) { toast('删除失败：' + e.message, 'error'); }
  });
}

// ── 定时任务 / 开机耗时 ─────────────────────────────────────────────────
async function loadCron() {
  try {
    const d = await (await fetch(API + '/cron', { cache: 'no-store' })).json();
    const tb = $('cron-body');
    if (!tb) return;
    tb.textContent = '';
    const frag = document.createDocumentFragment();
    for (const j of d.jobs || []) {
      const tr = el('tr');
      tr.appendChild(el('td', 'hide-sm', j.owner));
      tr.appendChild(el('td', 'mono', j.schedule));
      tr.appendChild(el('td', 'mono hint', j.command));
      tr.appendChild(el('td', 'hide-md hint', j.file));
      frag.appendChild(tr);
    }
    tb.appendChild(frag);
    if ($('cron-hint')) $('cron-hint').textContent = `${d.count || 0} 条`;
    if ($('cron-empty')) $('cron-empty').hidden = (d.jobs || []).length > 0;
  } catch (e) {
    console.warn('[cron] 读取失败:', e.message);
    if ($('cron-hint')) $('cron-hint').textContent = '读取失败';
  }
}

async function loadBoot() {
  try {
    const d = await (await fetch(API + '/boot', { cache: 'no-store' })).json();
    if ($('boot-hint')) {
      $('boot-hint').textContent = d.kernelSec != null
        ? `内核 ${d.kernelSec}s · 用户空间 ${d.userspaceSec}s${d.totalSec ? ` · 合计 ${d.totalSec}s` : ''}`
        : (d.error || '—');
    }
    if ($('boot-pre')) {
      $('boot-pre').textContent = [d.raw || '', '', '耗时最长的服务（systemd-analyze blame）：']
        .concat(d.blame || []).join('\n').trim();
    }
  } catch (e) {
    console.warn('[boot] 读取失败:', e.message);
    if ($('boot-hint')) $('boot-hint').textContent = '读取失败';
  }
}

// ── 一级 tab（功能分类）──────────────────────────────────────────────────
const TAB_NAMES = ['overview', 'process', 'ports', 'containers', 'services', 'alerts', 'audit'];

function setTab(name) {
  if (!TAB_NAMES.includes(name)) name = 'overview';
  currentTab = name;
  for (const b of $('tabs').querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === name);
  for (const t of TAB_NAMES) $('panel-' + t).hidden = (t !== name);
  // 切到概览要立刻画一次图，否则 canvas 尺寸为 0 时画出来是空的
  if (name === 'overview') requestAnimationFrame(() => loadHistoryView());
  // 注意：audit / alerts 的加载由 refreshView() 统一分发，
  // 这里再调一次会让「告警」页一次点击发 6 个请求、整表重建两遍
  if (name === 'services') { loadTimers(); loadCron(); loadBoot(); }
  if (name === 'ports') {
    // 端口/连接数据是后台定时刷新的，切过来时可能已经陈旧，强制补一次
    fetch(API + '/connections', { cache: 'no-store' }).catch(() => {});
  }
  return refreshView();
}

// 「进程」tab 内的子视图
function setView(v) {
  processView = v === 'tree' ? 'tree' : 'list';
  for (const b of $('views').querySelectorAll('.vbtn')) b.classList.toggle('active', b.dataset.view === processView);
  $('view-list').hidden = processView !== 'list';
  $('view-tree').hidden = processView !== 'tree';
  $('cfilter').hidden = !containerFilter;
  $('cfilter-name').textContent = containerFilter || '—';
  if (currentTab !== 'process') return setTab('process');
  return refreshView();
}

let refreshSeq = 0;
async function refreshView() {
  const seq = ++refreshSeq;
  try {
    if (currentTab === 'ports') {
      if (portMode === 'all') { await renderConnections(); return; }
      await renderPorts(); return;
    }
    if (currentTab === 'containers') { await renderContainers(); return; }
    if (currentTab === 'services') { await renderServices(); return; }
    if (currentTab === 'audit') { await loadAudit(); return; }
    if (currentTab === 'alerts') { await loadAlerts(); return; }
    if (currentTab === 'overview') { updateBadges(); return; }
    const u = new URL(API + '/processes', location.origin);
    u.searchParams.set('sort', sortKey);
    u.searchParams.set('limit', '2000');
    if (query) u.searchParams.set('q', query);
    if (containerFilter) u.searchParams.set('container', containerFilter);
    const r = await fetch(u.toString(), { cache: 'no-store' });
    if (!r.ok) throw new Error('进程列表请求失败: HTTP ' + r.status);
    const d = await r.json();
    rowsCache = d.rows || [];
    if (processView === 'tree') renderTree(rowsCache);
    else renderTable(rowsCache);
    updateBadges(rowsCache.length);
  } catch (e) {
    toast(e.message, 'error');
  }
}

// tab 上的角标：进程数 / 端口数 / 容器数 / 失败服务数
// 启动时把端口 / 容器 / 服务三个角标先填上（各请求一次，失败就保持 —）
async function primeBadges() {
  const fill = async (url, id, pick) => {
    try {
      const r = await fetch(API + url, { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      const v = pick(d);
      if (v !== undefined && v !== null) $(id).textContent = v;
    } catch { /* 忽略，留 — */ }
  };
  fill('/ports', 'badge-ports', (d) => d.total);
  fill('/containers', 'badge-containers', (d) => d.total);
  const r = await fetch(API + '/services', { cache: 'no-store' }).catch(() => null);
  if (r && r.ok) {
    const d = await r.json();
    const b = $('badge-services');
    b.textContent = d.counts?.failed ? `${d.counts.failed} 失败` : `${d.counts?.running ?? 0} 运行`;
    b.classList.toggle('alert', !!d.counts?.failed);
  }
}

function updateBadges(procCount) {
  const set = (id, v) => { const e = $(id); if (e && v !== undefined && v !== null) e.textContent = v; };
  if (procCount !== undefined) set('badge-process', procCount);
  else if (lastSnapshot) set('badge-process', lastSnapshot.procTotal);
}

// ── 数据获取 ────────────────────────────────────────────────────────────
async function fetchProcesses() {
  const u = new URL(API + '/processes', location.origin);
  u.searchParams.set('sort', sortKey);
  u.searchParams.set('limit', '2000');
  if (query) u.searchParams.set('q', query);
  if (containerFilter) u.searchParams.set('container', containerFilter);
  const r = await fetch(u.toString(), { cache: 'no-store' });
  if (!r.ok) throw new Error('进程列表请求失败: HTTP ' + r.status);
  const d = await r.json();
  renderTable(d.rows || []);
}

// ── 历史曲线（从落盘的 history.jsonl 读）───────────────────────────────
async function loadHistoryView() {
  if (historyRange === '60s') {
    // 实时模式：直接用 SSE 快照里的 60 个采样点（1 秒粒度）
    const h = lastSnapshot?.history || [];
    chartCpu.draw(h);
    chartMem.draw(h);
    chartIo.draw(h);
    $('range-hint').textContent = '实时 · 最近 60 秒';
    return;
  }
  try {
    const r = await fetch(`${API}/history?minutes=${historyRange}`, { cache: 'no-store' });
    // 不判 r.ok 时，5xx 会让 rows 为空 —— 图表画空、提示变「暂无历史数据」，
    // 把「后端挂了」伪装成「没有数据」
    if (!r.ok) throw new Error('历史数据请求失败: HTTP ' + r.status);
    const d = await r.json();
    const rows = (d.rows || []).map((x) => ({
      ts: x.ts, cpu: x.cpu, mem: x.mem, swap: x.swap,
      rd: x.rd, wr: x.wr, rx: x.rx, tx: x.tx,
    }));
    chartCpu.draw(rows); chartMem.draw(rows); chartIo.draw(rows);
    // 后端按窗口自动分桶（30s / 90s / 6min / 1h…），提示里写清楚聚合粒度，
    // 否则 7 天曲线被压成 240 个点时会让人误以为是采样丢了。
    const bucket = Number(d.bucket || 30);
    // 跨度超过 6 小时就必须带日期：否则「昨天 21:06」和「今天 21:06」都显示成
    // 9:06:00 PM，看着像起点比终点还晚（实测 24 小时视图就这样被误读）。
    const withDate = Number(historyRange) >= 360;
    const fmtT = (ts) => {
      const dt = new Date(ts);
      const hm = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
      return withDate ? `${dt.getMonth() + 1}/${dt.getDate()} ${hm}` : dt.toLocaleTimeString();
    };
    const span = rows.length ? `${fmtT(rows[0].ts)} → ${fmtT(rows[rows.length - 1].ts)}` : '暂无历史数据';
    const gran = bucket >= 3600 ? `${Math.round(bucket / 3600)} 小时`
      : (bucket >= 60 ? `${Math.round(bucket / 60)} 分钟` : `${bucket} 秒`);
    $('range-hint').textContent = `${span} · ${rows.length} 个点 · 每 ${gran}聚合`;
  } catch (e) {
    $('range-hint').textContent = '历史数据读取失败：' + e.message;
  }
}

function setConn(mode, text) {
  const pill = $('conn-pill');
  pill.dataset.state = mode;
  $('conn-text').textContent = text;
}

function startStream() {
  if (es) { es.close(); es = null; }
  try {
    es = new EventSource(STREAM_URL);
  } catch {
    startPolling();
    return;
  }
  es.onopen = () => { setConn('live', '实时'); stopPolling(); };
  es.onmessage = (ev) => {
    try {
      const s = JSON.parse(ev.data);
      // 服务端为了省带宽把历史点压成数组（hk = 字段名表），这里还原成对象，
      // 后面的绘图代码就不用关心传输格式。实测一帧 16.5KB → 3.6KB。
      if (Array.isArray(s.hk) && Array.isArray(s.h)) {
        const keys = s.hk;
        s.history = s.h.map((row) => {
          const o = {};
          for (let i = 0; i < keys.length; i += 1) o[keys[i]] = row[i];
          return o;
        });
        delete s.hk;
        delete s.h;
      }
      lastSnapshot = s;
      renderKpis(s);
      // SSE 里只带 top 30；表格数据单独取，保证排序/过滤一致
      setConn('live', '实时');
    } catch { /* 忽略坏帧 */ }
  };
  es.onerror = () => {
    setConn('down', '重连中');
    if (es) { es.close(); es = null; }
    startPolling();
    setTimeout(startStream, 8000);
  };
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    try {
      const r = await fetch(API + '/overview', { cache: 'no-store' });
      const s = await r.json();
      lastSnapshot = s;
      renderKpis(s);
      setConn('poll', '轮询');
    } catch { setConn('down', '断开'); }
  }, 2000);
}
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

async function refreshAll() {
  try {
    const o = await fetch(API + '/overview', { cache: 'no-store' }).then((r) => r.json());
    lastSnapshot = o;
    renderKpis(o);
    $('hostline').textContent = `${o.host?.name || ''} · ${o.host?.kernel || ''}`;
    await refreshView();
  } catch (e) {
    toast('刷新失败：' + e.message, 'error');
  }
}

// ── 详情抽屉 ────────────────────────────────────────────────────────────
async function openDetail(pid) {
  currentDetailPid = pid;
  const mask = $('drawer-mask'), drawer = $('drawer');
  mask.hidden = false; drawer.hidden = false;
  requestAnimationFrame(() => { mask.classList.add('show'); drawer.classList.add('show'); });
  $('d-name').textContent = '加载中…';
  try {
    const r = await fetch(`${API}/process/${pid}`, { cache: 'no-store' });
    const d = await r.json();
    if (currentDetailPid !== pid) return;      // 期间用户点了别的行：丢弃这份过期响应
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    $('d-name').textContent = `${d.name} (${d.pid})`;
    $('d-meta').textContent = `${d.user} · ${STATE_CN[d.state] || d.state} · 启动于 ${fmtStart(d.startMs)}`;
    const grid = $('d-grid');
    grid.textContent = '';
    const sm = d.smaps || null;
    const cg = d.cgroup || null;
    // 内存必须同时给 RSS 与 PSS：RSS 会把共享库/共享内存按进程重复计一遍，
    // 只看 RSS 会误判大户（实测全机 RSS 相加比真实占用高 27%）。
    const items = [
      ['CPU', fmtPct(d.cpuPct) + ' %'],
      ['内存 RSS', fmtBytes(d.rss)],
      ['内存 PSS', sm ? fmtBytes(sm.pss) : '—'],
      ['独享 USS', sm ? fmtBytes(sm.uss) : '—'],
      ['共享内存', sm ? fmtBytes(sm.shared) : '—'],
      ['Swap', fmtBytes(sm ? sm.swap : (d.vmSwap || 0))],
      ['虚拟峰值', fmtBytes(d.vmPeak)],
      ['线程', d.threads && d.threads.count != null ? d.threads.count : d.threads],
      ['文件描述符', d.fdLimit ? `${d.fds} / ${d.fdLimit.soft}` : d.fds],
      ['环境变量', `${(d.env && d.env.count) || d.envCount || 0} 个`],
      ['OOM 分数', d.oomAdj ? `${d.oom}（adj ${d.oomAdj > 0 ? '+' : ''}${d.oomAdj}）` : d.oom],
      ['磁盘读', fmtBytes((d.io && d.io.read) || 0)],
      ['磁盘写', fmtBytes((d.io && d.io.write) || 0)],
      ['CPU 时间', fmtCpuTime(d.cpuTime)],
      ['父进程', d.ppid],
      ['子树进程', `${d.descendantCount || 0} 个`],
    ];
    for (const [k, v] of items) {
      const box = el('div', 'ditem');
      box.append(el('span', 'dk', k), el('span', 'dv mono', String(v)));
      grid.appendChild(box);
    }
    $('d-cmd').textContent = d.cmd || '—';
    $('d-paths').textContent = `EXE: ${d.exe || '(无权限读取)'}\nCWD: ${d.cwd || '(无权限读取)'}`;

    // 父进程链（由近到远）
    const par = $('d-parents');
    par.textContent = '';
    if (d.parents && d.parents.length) {
      d.parents.forEach((p, i) => par.appendChild(el('span', i === 0 ? 'chip chain near' : 'chip chain', `${p.name} (${p.pid})`)));
    } else par.appendChild(el('span', 'hint', '无上级进程'));

    // cgroup + 内存额度
    const cgBox = $('d-cgroup');
    cgBox.textContent = '';
    if (cg) {
      const lim = (v) => (v === 'max' || v == null ? '不限' : fmtBytes(v));
      cgBox.appendChild(el('span', 'chip dim', `当前 ${fmtBytes(cg.current || 0)}`));
      if (cg.peak != null) cgBox.appendChild(el('span', 'chip dim', `峰值 ${fmtBytes(cg.peak)}`));
      cgBox.appendChild(el('span', 'chip dim', `软限 ${lim(cg.high)}`));
      cgBox.appendChild(el('span', 'chip dim', `硬限 ${lim(cg.max)}`));
      if (cg.pids != null) {
        cgBox.appendChild(el('span', 'chip dim', `进程 ${cg.pids}${cg.pidsMax && cg.pidsMax !== 'max' ? ' / ' + cg.pidsMax : ''}`));
      }
      const pathChip = el('span', 'chip dim mono path', cg.path);
      pathChip.title = cg.path;
      cgBox.appendChild(pathChip);
    } else cgBox.appendChild(el('span', 'hint', '该进程不在 cgroup v2 下'));

    // 线程列表
    const th = $('d-threads');
    th.textContent = '';
    if (d.threads && d.threads.list && d.threads.list.length) {
      for (const t of d.threads.list) th.appendChild(el('span', 'chip dim', `${t.name} · ${t.tid}`));
      $('d-thread-count').textContent = d.threads.truncated
        ? `共 ${d.threads.count} 个，仅列前 ${d.threads.list.length}`
        : `共 ${d.threads.count} 个`;
    } else {
      th.appendChild(el('span', 'hint', '无'));
      $('d-thread-count').textContent = '';
    }

    // 环境变量（敏感项已由后端打码）
    const envBox = $('d-env');
    if (d.env && d.env.list && d.env.list.length) {
      envBox.textContent = d.env.list.map((e) => `${e.k}=${e.v}`).join('\n');
      $('d-env-count').textContent = d.env.masked
        ? `共 ${d.env.count} 个，其中 ${d.env.masked} 项已打码`
        : `共 ${d.env.count} 个`;
    } else {
      envBox.textContent = '(无权限读取或无环境变量)';
      $('d-env-count').textContent = '';
    }

    const ch = $('d-children');
    ch.textContent = '';
    if (d.children && d.children.length) {
      for (const c of d.children.slice(0, 20)) ch.appendChild(el('span', 'chip', `${c.name} (${c.pid})`));
    } else ch.appendChild(el('span', 'hint', '无子进程'));

    // 结束整棵子树（有子孙才显示）
    const kt = $('d-kill-tree');
    kt.hidden = !(d.descendantCount > 0);
    kt.textContent = `结束整棵子树（${d.descendantCount || 0} 个）`;

    // 手机上把长区块（环境变量/线程/父链）默认收起，避免抽屉一屏塞不下
    const narrow = window.matchMedia('(max-width: 640px)').matches;
    for (const d of drawer.querySelectorAll('details.dblock')) d.open = !narrow;

    // 更新各信号按钮的 pid
    for (const b of drawer.querySelectorAll('[data-signal]')) b.dataset.pid = pid;
  } catch (e) {
    toast('读取详情失败：' + e.message, 'error');
    closeDetail();
  }
}
function closeDetail() {
  const mask = $('drawer-mask'), drawer = $('drawer');
  mask.classList.remove('show'); drawer.classList.remove('show');
  hideLater(drawer, 200);
  currentDetailPid = null;
}

// ── 确认弹窗 ────────────────────────────────────────────────────────────
let pendingAction = null;
let pendingTree = 0;        // 这次操作「可选的」子树进程数，0 = 不显示勾选项
function confirmModal(title, body, okText, fn, opts = {}) {
  $('modal-title').textContent = title;
  $('modal-body').textContent = body;
  $('modal-ok').textContent = okText || '确定';
  pendingAction = fn;
  pendingTree = Number(opts.treeCount || 0);
  const wrap = $('modal-tree-wrap'), cb = $('modal-tree');
  if (pendingTree > 0) {
    $('modal-tree-count').textContent = String(pendingTree);
    cb.checked = opts.treeDefault === true;
    wrap.hidden = false;
  } else {
    cb.checked = false;
    wrap.hidden = true;
  }
  $('modal-mask').hidden = false;
  requestAnimationFrame(() => $('modal-mask').classList.add('show'));
}
function closeModal() {
  $('modal-mask').classList.remove('show');
  hideLater($('modal-mask'));
  pendingAction = null;
  pendingTree = 0;
}
// 勾选框是否被选中（只有存在可选子树时才为真）
function treeChecked() {
  return pendingTree > 0 && $('modal-tree').checked === true;
}

// 本地缓存里的子孙 pid（只用于「先显示个大概」，真正执行时以后端为准）
function descendantsInCache(pid) {
  const kids = new Map();
  for (const p of rowsCache) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p.pid);
  }
  const out = [];
  const stack = [...(kids.get(pid) || [])];
  const seen = new Set(stack);
  while (stack.length) {
    const cur = stack.pop();
    out.push(cur);
    for (const c of kids.get(cur) || []) if (!seen.has(c)) { seen.add(c); stack.push(c); }
  }
  return out;
}

async function sendSignal(pid, signal, opts = {}) {
  const row = rowsCache.find((p) => p.pid === pid);
  const name = row ? `${row.name} (${pid})` : `PID ${pid}`;
  const danger = signal === 'SIGKILL';
  // 问一次后端要准确的子孙数量（列表缓存可能被搜索/容器过滤裁过，不能当真）
  let descCount = descendantsInCache(pid).length;
  try {
    const d = await fetch(`${API}/process/${pid}`, { cache: 'no-store' }).then((r) => r.json());
    if (d && !d.error && Number.isFinite(d.descendantCount)) descCount = d.descendantCount;
  } catch { /* 拿不到就用本地估算 */ }
  confirmModal(
    danger ? '强制结束进程' : '向进程发送信号',
    `目标：${name}\n信号：${signal}`
      + (descCount > 0 ? `\n\n该进程还有 ${descCount} 个子孙进程。勾选下方选项可一并结束（先子后父，避免残留孤儿进程）。` : '')
      + (danger ? '\n\nKILL 无法被进程捕获，数据可能来不及保存。' : ''),
    danger ? '确定结束' : '确定发送',
    async ({ tree: treeKill } = {}) => {
      const tree = treeKill === true;
      try {
        const r = await fetch(API + '/kill', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pid, signal, confirm: true, tree }),
        });
        const d = await r.json();
        if (!r.ok || !d.success) throw new Error(d.error || ('HTTP ' + r.status));
        if (d.tree) toast(`已结束子树：${d.killed + d.gone}/${d.count} 个进程`, 'ok');
        else toast(`已向 ${name} 发送 ${signal}`, 'ok');
        loadAudit();
        refreshAll();
        if (currentDetailPid === pid && (signal === 'SIGKILL' || signal === 'SIGTERM')) closeDetail();
      } catch (e) {
        toast('发送失败：' + e.message, 'error');
      }
    },
    { treeCount: descCount, treeDefault: opts.forceTree === true },
  );
}

// ── 操作记录（SQLite 落盘，分页 + 筛选）──────────────────────────────────
const ACTION_LABEL = {
  kill: '发信号',
  'service.start': '服务启动',
  'service.stop': '服务停止',
  'service.restart': '服务重启',
  'app.start': '应用启动',
  'app.stop': '应用停止',
  'app.crash': '应用崩溃',
};
const RESULT_LABEL = { ok: '成功', rejected: '拒绝', error: '失败' };

const auditState = { page: 0, pageSize: 50, action: '', result: '', q: '', total: 0 };

function fmtAuditTime(ts) {
  const t = new Date(ts);
  const now = new Date();
  const sameDay = t.toDateString() === now.toDateString();
  const p = (n) => String(n).padStart(2, '0');
  const hm = `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
  return sameDay ? hm : `${t.getMonth() + 1}/${t.getDate()} ${hm}`;
}

function actionLabel(a) {
  return ACTION_LABEL[a] || a;
}

async function loadAudit() {
  const params = new URLSearchParams({
    limit: String(auditState.pageSize),
    offset: String(auditState.page * auditState.pageSize),
  });
  if (auditState.action) params.set('action', auditState.action);
  if (auditState.result) params.set('result', auditState.result);
  if (auditState.q) params.set('q', auditState.q);
  const rangeH = Number($('audit-range') ? $('audit-range').value : 0) || 0;
  if (rangeH) params.set('since', String(Date.now() - rangeH * 3600 * 1000));
  const ul = $('audit');
  try {
    const r = await fetch(API + '/audit?' + params.toString(), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    auditState.total = d.total || 0;
    renderAudit(d);
  } catch (e) {
    ul.textContent = '';
    ul.appendChild(el('li', 'hint', '读取记录失败：' + (e.message || e)));
  }
}

function renderAudit(d) {
  const ul = $('audit');
  const rows = d.actions || [];
  ul.textContent = '';

  // 顶部一行汇总：总数 + 结果分布 + 库状态
  const st = d.stats || {};
  const byResult = Object.fromEntries((st.byResult || []).map((x) => [x.result, x.count]));
  const filtered = !!(auditState.action || auditState.result || auditState.q);
  const all = st.total ?? d.total ?? 0;
  const bits = filtered ? [`筛选出 ${d.total} 条 · 共 ${all} 条`] : [`共 ${all} 条`];
  if (byResult.ok) bits.push(`成功 ${byResult.ok}`);
  if (byResult.rejected) bits.push(`拒绝 ${byResult.rejected}`);
  if (byResult.error) bits.push(`失败 ${byResult.error}`);
  if (st.lastTs) bits.push(`最后一次 ${fmtAuditTime(st.lastTs)}`);
  const meta = $('audit-meta');
  if (meta) {
    meta.textContent = '';
    for (const b of bits) meta.appendChild(el('span', 'audit-chip', b));
    const dbChip = el('span', 'audit-chip db', d.degraded ? '⚠ 库降级（暂存内存）' : '🗄 SQLite · 重启不丢');
    if (d.db?.path) dbChip.title = d.db.path;
    meta.appendChild(dbChip);
    $('audit-summary').textContent = `全部操作 · 落盘 SQLite，重启不丢`;
  }

  if (!rows.length) {
    ul.appendChild(el('li', 'hint', auditState.action || auditState.result || auditState.q
      ? '没有符合筛选条件的记录' : '暂无操作'));
    $('audit-pager').hidden = true;
    return;
  }

  for (const a of rows) {
    const li = el('li', a.result === 'ok' ? 'ok' : 'err');
    const sigText = (a.detail && a.detail.signal) ? a.detail.signal : '';
    const main = a.action.startsWith('service.')
      ? `${a.detail?.signal || a.action.split('.')[1]} ${a.target}`
      : (a.action.startsWith('app.') ? a.target : `${a.target}${a.detail?.name && a.detail.name !== '?' ? ' · ' + a.detail.name : ''}`);
    li.append(
      el('span', 'mono audit-time', fmtAuditTime(a.ts)),
      el('span', 'audit-act', actionLabel(a.action)),
      el('span', 'audit-name', main),
      el('span', 'audit-msg hint', a.message || ''),
      el('span', 'audit-res ' + a.result, RESULT_LABEL[a.result] || a.result),
    );
    li.title = `${new Date(a.ts).toLocaleString()}  ${actionLabel(a.action)}  ${main}\n${a.message || ''}\nclient: ${a.client || '-'}`;
    ul.appendChild(li);
  }

  // 分页
  const pages = Math.max(1, Math.ceil((d.total || 0) / auditState.pageSize));
  const pager = $('audit-pager');
  pager.hidden = pages <= 1;
  $('audit-page').textContent = `${auditState.page + 1} / ${pages}`;
  $('audit-prev').disabled = auditState.page <= 0;
  $('audit-next').disabled = auditState.page >= pages - 1;
}

// ── 赞助 / 反馈弹层 ─────────────────────────────────────────────────────
function openSheet(id) {
  const m = $(id);
  if (!m) return;
  m.hidden = false;
  requestAnimationFrame(() => m.classList.add('show'));
}
function closeSheet(id) {
  const m = $(id);
  if (!m) return;
  m.classList.remove('show');
  setTimeout(() => { m.hidden = true; }, 180);
}
function openLightbox(src) {
  const lb = $('lightbox');
  if (!lb || !src) return;
  $('lightbox-img').src = src;
  lb.hidden = false;
}
function closeLightbox() {
  const lb = $('lightbox');
  if (!lb) return;
  lb.hidden = true;
  $('lightbox-img').removeAttribute('src');
}
function closeSheets() {
  closeSheet('sponsor-mask');
  closeSheet('feedback-mask');
  closeLightbox();
}

// 复制到剪贴板：fnOS WebView 里 navigator.clipboard 常常不可用（非 https 安全上下文），
// 必须有 execCommand 兜底，否则点了「复制」毫无反应。
async function copyText(txt) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(txt);
      return true;
    }
  } catch { /* 落到下面的兜底 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = txt;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, txt.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

// ── 事件绑定（统一 addEventListener，不用 inline onclick）────────────────
function bindEvents() {
  // 赞助 / 反馈：走 DOM 0 级赋值（fnOS WebView 上比 addEventListener 更稳）
  const btnSponsor = $('btn-sponsor');
  if (btnSponsor) btnSponsor.onclick = () => openSheet('sponsor-mask');
  const btnFeedback = $('btn-feedback');
  if (btnFeedback) btnFeedback.onclick = () => openSheet('feedback-mask');

  // 关闭按钮 / 点遮罩关闭
  for (const b of document.querySelectorAll('[data-close]')) {
    b.onclick = () => closeSheet(b.dataset.close);
  }
  for (const m of document.querySelectorAll('.sheet-mask')) {
    m.addEventListener('click', (e) => { if (e.target === m) closeSheet(m.id); });
  }

  // 二维码点击放大
  for (const img of document.querySelectorAll('img[data-zoom]')) {
    img.onclick = () => openLightbox(img.getAttribute('src'));
  }
  const lb = $('lightbox');
  if (lb) lb.onclick = closeLightbox;

  // 复制 QQ 群号
  const qqBtn = $('qq-copy');
  if (qqBtn) qqBtn.onclick = async () => {
    const qq = ($('qq-num')?.textContent || '').trim();
    const ok = await copyText(qq);
    toast(ok ? `已复制 QQ 群号 ${qq}` : `复制失败，请手动记录：${qq}`, ok ? 'ok' : 'error');
  };

  // 操作记录：筛选 / 搜索 / 刷新 / 翻页
  const auditApply = () => { auditState.page = 0; loadAudit(); };
  if ($('audit-action')) $('audit-action').onchange = (e) => { auditState.action = e.target.value; auditApply(); };
  if ($('audit-result')) $('audit-result').onchange = (e) => { auditState.result = e.target.value; auditApply(); };
  if ($('audit-refresh')) $('audit-refresh').onclick = () => loadAudit();
  if ($('audit-prev')) $('audit-prev').onclick = () => { if (auditState.page > 0) { auditState.page -= 1; loadAudit(); } };
  if ($('audit-next')) $('audit-next').onclick = () => { auditState.page += 1; loadAudit(); };
  if ($('audit-q')) {
    let t = null;
    $('audit-q').oninput = (e) => {
      const v = e.target.value.trim();
      clearTimeout(t);
      t = setTimeout(() => { auditState.q = v; auditApply(); }, 250);
    };
    $('audit-q').onkeydown = (e) => {
      if (e.key === 'Enter') { clearTimeout(t); auditState.q = e.target.value.trim(); auditApply(); }
    };
  }

  $('btn-theme').addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
    loadHistoryView();
  });

  $('btn-refresh').addEventListener('click', () => { refreshAll(); loadHistoryView(); });

  // 图表时间范围
  $('range').addEventListener('change', (e) => {
    historyRange = e.target.value;
    loadHistoryView();
  });

  const q = $('q');
  let qTimer = null;
  q.addEventListener('input', () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { query = q.value.trim(); refreshView(); }, 220);
  });

  $('sort').addEventListener('change', (e) => {
    sortKey = e.target.value;
    refreshView();
  });

  // ── 告警页 ──
  $('alert-add').addEventListener('click', () => openAlertModal(null));
  $('alert-cancel').addEventListener('click', closeAlertModal);
  $('alert-save').addEventListener('click', saveAlert);
  $('alert-test').addEventListener('click', testAlert);
  $('af-metric').addEventListener('change', syncAlertForm);
  $('alert-mask').addEventListener('click', (e) => { if (e.target === $('alert-mask')) closeAlertModal(); });
  $('alert-level-filter').addEventListener('change', () => loadAlertEvents());
  $('alert-events-refresh').addEventListener('click', () => loadAlertEvents());
  $('alert-body').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-action]');
    if (!b) return;
    const id = Number(b.dataset.id);
    if (b.dataset.action === 'alert-edit') openAlertModal(alertRules.find((x) => x.id === id));
    else if (b.dataset.action === 'alert-test') {
      fetch(API + '/alerts/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
      }).then((r) => r.json()).then((d) => {
        const dl = d.delivered || {};
        const ok = Object.values(dl).some((x) => x && x.ok);
        const detail = Object.entries(dl).map(([k, v]) => `${k === 'fnos' ? '系统通知' : k} ${v.ok ? '成功' : '失败（' + (v.error || '') + '）'}`).join('，');
        toast((ok ? '测试通知已发出：' : '发送失败：') + detail, ok ? 'ok' : 'error');
        loadAlertEvents();
      }).catch((err) => toast('测试失败：' + err.message, 'error'));
    } else if (b.dataset.action === 'alert-del') deleteAlert(id);
  });

  // ── 日志弹窗 ──
  $('log-close').addEventListener('click', closeLog);
  $('log-refresh').addEventListener('click', loadLog);
  $('log-lines').addEventListener('change', loadLog);
  $('log-priority').addEventListener('change', loadLog);
  $('log-grep').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadLog(); });
  $('log-mask').addEventListener('click', (e) => { if (e.target === $('log-mask')) closeLog(); });

  // ── 端口视图切换 ──
  $('port-views').addEventListener('click', (e) => {
    const b = e.target.closest('.vbtn');
    if (b) setPortMode(b.dataset.pmode);
  });

  // ── 快照 ──
  $('btn-snapshot').addEventListener('click', saveSnapshot);
  $('btn-snap-diff').addEventListener('click', openSnapshotDiff);
  $('snap-close').addEventListener('click', () => {
    $('snap-mask').classList.remove('show');
    hideLater($('snap-mask'));
  });
  $('snap-mask').addEventListener('click', (e) => {
    if (e.target === $('snap-mask')) {
      $('snap-mask').classList.remove('show');
      hideLater($('snap-mask'));
    }
  });
  $('snap-run').addEventListener('click', runSnapshotDiff);
  $('snap-del').addEventListener('click', () => {
    // 早期实现静默优先删「对比（较晚）」那个，且不看响应就报成功。
    // 现在：两个下拉各自有明确的删除按钮语义 —— 删「对比快照」，并要求两个下拉都选好。
    const id = $('snap-b').value;
    if (!id) { toast('请先在右侧选择要删除的快照', 'error'); return; }
    const label = $('snap-b').selectedOptions && $('snap-b').selectedOptions[0]
      ? $('snap-b').selectedOptions[0].textContent : `#${id}`;
    confirmModal('删除快照', `确定删除「${label}」？\n删除后无法恢复。`, '确定删除', async () => {
      try {
        const r = await fetch(API + '/snapshot/delete', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: Number(id), confirm: true }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
        toast('快照已删除', 'ok');
        await openSnapshotDiff();
      } catch (err) {
        toast('删除失败：' + err.message, 'error');
      }
    });
  });

  // ── 看门狗 ──
  $('wd-add').addEventListener('click', () => openWatchdogModal(null));
  $('wd-cancel').addEventListener('click', closeWatchdogModal);
  $('wd-save').addEventListener('click', saveWatchdog);
  $('wd-mask').addEventListener('click', (e) => { if (e.target === $('wd-mask')) closeWatchdogModal(); });
  $('wd-body').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-action]');
    if (!b) return;
    const id = Number(b.dataset.id);
    if (b.dataset.action === 'wd-edit') openWatchdogModal(watchdogs.find((x) => x.id === id));
    else if (b.dataset.action === 'wd-del') deleteWatchdog(id);
  });

  // ── 记录：时间范围 + 导出 ──
  if ($('audit-range')) $('audit-range').addEventListener('change', () => { auditState.page = 0; loadAudit(); });
  if ($('audit-export')) $('audit-export').addEventListener('click', () => {
    // 导出必须与页面上的筛选一致，否则用户拿到的是全库数据却以为是筛选结果
    const p = new URLSearchParams({ what: 'audit' });
    if (auditState.action) p.set('action', auditState.action);
    if (auditState.result) p.set('result', auditState.result);
    if (auditState.q) p.set('q', auditState.q);
    const rangeH = Number($('audit-range') ? $('audit-range').value : 0) || 0;
    if (rangeH) p.set('since', String(Date.now() - rangeH * 3600 * 1000));
    location.href = `${API}/export?${p.toString()}`;
  });

  // 一级 tab 切换
  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (b) setTab(b.dataset.tab);
  });

  // 「进程」tab 内的 列表/树 切换
  $('views').addEventListener('click', (e) => {
    const b = e.target.closest('.vbtn');
    if (b) setView(b.dataset.view);
  });

  // 容器筛选清除
  $('cfilter-clear').addEventListener('click', () => {
    containerFilter = '';
    $('cfilter').hidden = true;
    refreshView();
  });

  // 树视图：折叠/展开 + 行点击详情
  $('treebody').addEventListener('click', (e) => {
    const tg = e.target.closest('button[data-action="toggle"]');
    if (tg) {
      e.stopPropagation();
      const pid = Number(tg.dataset.pid);
      if (collapsed.has(pid)) collapsed.delete(pid); else collapsed.add(pid);
      renderTree(rowsCache);
      return;
    }
    const sig = e.target.closest('button[data-action="signal"]');
    if (sig) { e.stopPropagation(); sendSignal(Number(sig.dataset.pid), 'SIGTERM'); return; }
    const tr = e.target.closest('tr[data-pid]');
    if (tr) openDetail(Number(tr.dataset.pid));
  });

  // 服务视图：启动 / 停止 / 重启 / 看日志 / 改开机自启
  $('svcbody').addEventListener('click', (e) => {
    const logB = e.target.closest('button[data-action="svc-log"]');
    if (logB) { e.stopPropagation(); openLog(logB.dataset.unit); return; }
    const enB = e.target.closest('button[data-action="svc-enable"]');
    if (enB) { e.stopPropagation(); if (!enB.disabled) doServiceEnable(enB.dataset.unit, enB.dataset.enable === '1'); return; }
    const b = e.target.closest('button[data-action="service"]');
    if (!b || b.disabled) return;
    e.stopPropagation();
    doServiceAction(b.dataset.unit, b.dataset.op);
  });
  $('svc-state').addEventListener('change', () => renderServices().catch((e) => toast(e.message, 'error')));

  // 端口视图：点行看进程详情
  $('portbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-pid]');
    if (tr) openDetail(Number(tr.dataset.pid));
  });

  // 容器视图 / 列表里的容器标签：只看该容器进程
  const applyContainerFilter = (name) => {
    containerFilter = name || '';
    setTab('process');
    setView('list');
  };
  $('contbody').addEventListener('click', (e) => {
    const logB = e.target.closest('button[data-action="cont-log"]');
    if (logB) { openContainerLog(logB.dataset.container); return; }
    const actB = e.target.closest('button[data-action="cont-restart"], button[data-action="cont-stop"]');
    if (actB) {
      const action = actB.dataset.action === 'cont-stop' ? 'stop' : 'restart';
      const label = action === 'stop' ? '停止' : '重启';
      const name = actB.dataset.container;
      confirmModal(`${label}容器`, `容器：${name}\n操作：docker ${action}${action === 'stop' ? '\n\n停止后容器内服务立即中断。' : ''}`, `确定${label}`, async () => {
        try {
          const r = await fetch(API + '/container/action', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, action, confirm: true }),
          });
          const d = await r.json();
          if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
          toast(`${name} ${label}成功`, 'ok');
          renderContainers();
        } catch (err) { toast(`${label}失败：` + err.message, 'error'); }
      });
      return;
    }
    const b = e.target.closest('button[data-action="filter-container"]');
    if (b) applyContainerFilter(b.dataset.container);
  });
  // 表头点击排序
  for (const th of document.querySelectorAll('th[data-sort]')) {
    th.addEventListener('click', () => {
      const k = th.dataset.sort;
      sortKey = k;
      $('sort').value = k;
      refreshView();
    });
  }

  // 表格行点击：详情 / 信号按钮
  // 一个委托监听处理三种点击，按优先级 return：
  // 早期这件事被写成两个 addEventListener 挂在同一个 tbody 上，
  // 而 stopPropagation 只阻止向祖先传播、拦不住同节点上的第二个监听器 ——
  // 点容器 chip 会「先过滤整张表、又弹出详情抽屉」
  $('ptbody').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-action="filter-container"]');
    if (chip) { applyContainerFilter(chip.dataset.container); return; }
    const btn = e.target.closest('button[data-action="signal"]');
    if (btn) { sendSignal(Number(btn.dataset.pid), 'SIGTERM'); return; }
    const tr = e.target.closest('tr[data-pid]');
    if (tr) openDetail(Number(tr.dataset.pid));
  });

  // 详情抽屉里的信号按钮
  for (const b of $('drawer').querySelectorAll('[data-signal]')) {
    b.addEventListener('click', () => {
      // 用按钮自带的 pid：连续点两行时 currentDetailPid 可能已经变成另一个进程，
      // 而界面上显示的还是前一个 —— 会出现「看着 A、杀的是 B」
      const pid = Number(b.dataset.pid) || currentDetailPid;
      if (!pid) return;
      if (Number(b.dataset.pid) && Number(b.dataset.pid) !== currentDetailPid) {
        toast('该行已被切换，请重新打开要操作的进程', 'error');
        return;
      }
      sendSignal(currentDetailPid, b.dataset.signal);
    });
  }

  // 调优：nice / OOM 保护 / cgroup 内存软限
  const tuneApply = async (action, value, label) => {
    if (!currentDetailPid) return;
    const pid = currentDetailPid;
    confirmModal('调整进程参数', `目标：PID ${pid}\n操作：${label}`, '确定', async () => {
      try {
        const r = await fetch(API + '/tune', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pid, action, value, confirm: true }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
        toast(`${label} 已生效`, 'ok');
        loadAudit();
        openDetail(pid);
      } catch (e) {
        toast(`${label} 失败：` + e.message, 'error');
      }
    });
  };
  if ($('d-apply-nice')) {
    $('d-apply-nice').addEventListener('click', () => {
      tuneApply('renice', Number($('d-nice').value) || 0, `nice = ${Number($('d-nice').value) || 0}`);
    });
  }
  if ($('d-apply-oom')) {
    $('d-apply-oom').addEventListener('click', () => {
      const v = Number($('d-oom').value) || 0;
      tuneApply('oom', v, `OOM 保护 = ${v}`);
    });
  }
  if ($('d-apply-cg')) {
    $('d-apply-cg').addEventListener('click', () => {
      const raw = $('d-cg').value.trim();
      if (!raw) { toast('请输入字节数或 max', 'error'); return; }
      // 支持 512M / 1G 这类写法
      let value = raw;
      const m = raw.match(/^(\d+)\s*([kKmMgG]?)$/);
      if (m) {
        const mult = { '': 1, k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 }[m[2].toLowerCase()];
        value = String(Number(m[1]) * mult);
      }
      tuneApply('cgroup-memory-high', value, `cgroup 内存软限 = ${raw}`);
    });
  }

  // 结束整棵子树：默认 TERM，弹窗里勾选状态预置为「已勾选」
  const ktBtn = $('d-kill-tree');
  if (ktBtn) {
    ktBtn.addEventListener('click', () => {
      if (!currentDetailPid) return;
      sendSignal(currentDetailPid, 'SIGTERM', { forceTree: true });
    });
  }

  $('d-close').addEventListener('click', closeDetail);
  $('drawer-mask').addEventListener('click', closeDetail);

  $('modal-cancel').addEventListener('click', closeModal);
  $('modal-mask').addEventListener('click', (e) => { if (e.target === $('modal-mask')) closeModal(); });
  $('modal-ok').addEventListener('click', async () => {
    const fn = pendingAction;
    // 注意顺序：closeModal() 会重置 pendingTree，所以勾选状态必须在关闭前取走
    const tree = treeChecked();
    closeModal();
    if (fn) await fn({ tree });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // 新增的四个弹层也要能被 ESC 关掉（之前只绑了"点遮罩"）
      closeModal(); closeDetail(); closeSheets();
      closeAlertModal(); closeLog(); closeWatchdogModal(); closeSnapModal();
    }
    // 只在「没在输入」时接管 `/`：早期只排除了搜索框自身，
    // 于是 webhook 地址、看门狗命令、记录搜索里打斜杠会被吞掉并把焦点抢走
    const ae = document.activeElement;
    const typing = !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA'
      || ae.tagName === 'SELECT' || ae.isContentEditable);
    if (e.key === '/' && !typing && currentTab === 'process') { e.preventDefault(); $('q').focus(); }
  });

  window.addEventListener('beforeunload', () => { if (es) es.close(); });
}

// ── 启动 ────────────────────────────────────────────────────────────────
(async function boot() {
  bindEvents();
  await refreshAll();
  setTab('overview');
  primeBadges();
  loadAudit();
  startStream();
  // 表格数据 10 秒刷一次兜底：概览数字由 SSE 实时推送，表格没必要跟着每秒重排。
  // 页面切到后台时完全跳过（后台标签页不该继续占带宽和 CPU）。
  // 10 秒兜底刷新 + 页面不可见时完全跳过（后台标签页不该占带宽和 CPU）。
  setInterval(() => {
    if (document.visibilityState === 'hidden') return;
    refreshView();
  }, 10000);
  setInterval(() => { if (historyRange !== '60s') loadHistoryView(); }, 30000);
})();
