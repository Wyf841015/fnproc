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

// ── 图表（原生 canvas，DPR 自适应）───────────────────────────────────────
function makeChart(canvas, opts) {
  const ctx = canvas.getContext('2d');
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 600;
    const h = Number(canvas.getAttribute('height')) || 120;
    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  function line(series, color, maxV, fill) {
    const w = canvas.clientWidth || 600, h = Number(canvas.getAttribute('height')) || 120;
    const n = Math.max(2, series.length);
    const stepX = w / (n - 1);
    ctx.beginPath();
    series.forEach((v, i) => {
      const x = i * stepX;
      const y = h - Math.max(0, Math.min(1, v / maxV)) * (h - 8) - 4;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.lineJoin = 'round';
    ctx.stroke();
    if (fill) {
      ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    }
  }

  return {
    resize,
    draw(data) {
      const w = canvas.clientWidth || 600, h = Number(canvas.getAttribute('height')) || 110;
      ctx.clearRect(0, 0, w, h);
      // 网格
      ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--grid') || 'rgba(255,255,255,.06)';
      ctx.lineWidth = 1;
      for (let i = 1; i <= 3; i++) {
        const y = (h / 4) * i;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }
      opts.series.forEach((s) => {
        const maxV = typeof s.max === 'function' ? s.max(data) : (s.max || 100);
        line(data.map(s.get), s.color, maxV, s.fill);
      });
      // Y 轴刻度（只给百分比类图表画，避免 IO 图误导）
      if (opts.yLabels) {
        ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-mute') || '#6b7b95';
        ctx.font = '10px ui-monospace, Menlo, monospace';
        ctx.textAlign = 'left';
        ctx.fillText('100%', 2, 10);
        ctx.fillText('50%', 2, h / 2 - 2);
        ctx.fillText('0', 2, h - 4);
      }
    },
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

  $('ver').textContent = s.version;
  $('ts-line').textContent = '更新于 ' + new Date(s.ts).toLocaleTimeString();
  const hist2 = s.history || [];
  chartCpu.draw(hist2);
  chartMem.draw(hist2);
  chartIo.draw(hist2);
}

// ── 渲染：进程表 ────────────────────────────────────────────────────────
function renderTable(rows) {
  rowsCache = rows;
  const tb = $('ptbody');
  tb.textContent = '';
  const frag = document.createDocumentFragment();
  for (const p of rows) {
    const tr = el('tr');
    tr.dataset.pid = p.pid;
    tr.appendChild(el('td', 'num mono', p.pid));
    const nameTd = el('td', 'pname');
    nameTd.appendChild(el('span', 'nm', p.name));
    if (p.cmd && p.cmd !== p.name) nameTd.appendChild(el('span', 'cmd', p.cmd));
    tr.appendChild(nameTd);
    const cpuTd = el('td', 'num mono');
    cpuTd.appendChild(el('span', 'cpuval', fmtPct(p.cpuPct)));
    if (p.cpuPct > 10) cpuTd.dataset.hot = '1';
    tr.appendChild(cpuTd);
    tr.appendChild(el('td', 'num mono', fmtBytes(p.rss)));
    tr.appendChild(el('td', 'num mono hide-sm', p.threads));
    tr.appendChild(el('td', 'hide-sm', p.user));
    const stTd = el('td', 'hide-sm');
    stTd.appendChild(el('span', 'state s-' + p.state, STATE_CN[p.state] || p.state));
    tr.appendChild(stTd);
    tr.appendChild(el('td', 'num mono hide-sm', fmtCpuTime(p.cpuTime)));
    const actTd = el('td', 'act');
    const btn = el('button', 'btn tiny', '信号');
    btn.type = 'button';
    btn.dataset.action = 'signal';
    btn.dataset.pid = p.pid;
    actTd.appendChild(btn);
    tr.appendChild(actTd);
    frag.appendChild(tr);
  }
  tb.appendChild(frag);
  $('empty').hidden = rows.length > 0;
  $('table-info').textContent = `${rows.length} 个进程${query ? `（已过滤，共 ${lastSnapshot?.procTotal ?? '?'} 个）` : ''}`;
}

// ── 数据获取 ────────────────────────────────────────────────────────────
async function fetchProcesses() {
  const u = new URL(API + '/processes', location.origin);
  u.searchParams.set('sort', sortKey);
  u.searchParams.set('limit', '500');
  if (query) u.searchParams.set('q', query);
  const r = await fetch(u.toString(), { cache: 'no-store' });
  if (!r.ok) throw new Error('进程列表请求失败: HTTP ' + r.status);
  const d = await r.json();
  renderTable(d.rows || []);
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
    const [o] = await Promise.all([
      fetch(API + '/overview', { cache: 'no-store' }).then((r) => r.json()),
      fetchProcesses(),
    ]);
    lastSnapshot = o;
    renderKpis(o);
    $('hostline').textContent = `${o.host?.name || ''} · ${o.host?.kernel || ''}`;
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
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    $('d-name').textContent = `${d.name} (${d.pid})`;
    $('d-meta').textContent = `${d.user} · ${STATE_CN[d.state] || d.state} · 启动于 ${fmtStart(d.startMs)}`;
    const grid = $('d-grid');
    grid.textContent = '';
    const items = [
      ['CPU', fmtPct(d.cpuPct) + ' %'],
      ['内存 RSS', fmtBytes(d.rss)],
      ['Swap', fmtBytes(d.vmSwap)],
      ['虚拟峰值', fmtBytes(d.vmPeak)],
      ['线程', d.threads],
      ['文件描述符', d.fds],
      ['环境变量', d.envCount + ' 个'],
      ['OOM 分数', d.oom],
      ['磁盘读', fmtBytes(d.io.read)],
      ['磁盘写', fmtBytes(d.io.write)],
      ['CPU 时间', fmtCpuTime(d.cpuTime)],
      ['父进程', d.ppid],
    ];
    for (const [k, v] of items) {
      const box = el('div', 'ditem');
      box.append(el('span', 'dk', k), el('span', 'dv mono', String(v)));
      grid.appendChild(box);
    }
    $('d-cmd').textContent = d.cmd || '—';
    $('d-paths').textContent = `EXE: ${d.exe || '(无权限读取)'}\nCWD: ${d.cwd || '(无权限读取)'}`;
    const ch = $('d-children');
    ch.textContent = '';
    if (d.children && d.children.length) {
      for (const c of d.children.slice(0, 20)) ch.appendChild(el('span', 'chip', `${c.name} (${c.pid})`));
    } else ch.appendChild(el('span', 'hint', '无子进程'));
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
  setTimeout(() => { mask.hidden = true; drawer.hidden = true; }, 200);
  currentDetailPid = null;
}

// ── 确认弹窗 ────────────────────────────────────────────────────────────
let pendingAction = null;
function confirmModal(title, body, okText, fn) {
  $('modal-title').textContent = title;
  $('modal-body').textContent = body;
  $('modal-ok').textContent = okText || '确定';
  pendingAction = fn;
  $('modal-mask').hidden = false;
  requestAnimationFrame(() => $('modal-mask').classList.add('show'));
}
function closeModal() {
  $('modal-mask').classList.remove('show');
  setTimeout(() => { $('modal-mask').hidden = true; }, 160);
  pendingAction = null;
}

async function sendSignal(pid, signal) {
  const row = rowsCache.find((p) => p.pid === pid);
  const name = row ? `${row.name} (${pid})` : `PID ${pid}`;
  const danger = signal === 'SIGKILL';
  confirmModal(
    danger ? '强制结束进程' : '向进程发送信号',
    `目标：${name}\n信号：${signal}${danger ? '\n\nKILL 无法被进程捕获，数据可能来不及保存。' : ''}`,
    danger ? '确定结束' : '确定发送',
    async () => {
      try {
        const r = await fetch(API + '/kill', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pid, signal, confirm: true }),
        });
        const d = await r.json();
        if (!r.ok || !d.success) throw new Error(d.error || ('HTTP ' + r.status));
        toast(`已向 ${name} 发送 ${signal}`, 'ok');
        loadAudit();
        refreshAll();
        if (currentDetailPid === pid && (signal === 'SIGKILL' || signal === 'SIGTERM')) closeDetail();
      } catch (e) {
        toast('发送失败：' + e.message, 'error');
      }
    },
  );
}

async function loadAudit() {
  try {
    const r = await fetch(API + '/audit', { cache: 'no-store' });
    const d = await r.json();
    const ul = $('audit');
    ul.textContent = '';
    if (!d.actions || !d.actions.length) { ul.appendChild(el('li', 'hint', '暂无操作')); return; }
    for (const a of d.actions.slice(0, 20)) {
      const li = el('li', a.ok ? 'ok' : 'err');
      const t = new Date(a.at);
      const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
      li.append(
        el('span', 'mono', hhmm),
        el('span', 'mono', a.signal),
        el('span', 'audit-name', `${a.name} (${a.pid})`),
        el('span', 'hint', a.ok ? '成功' : (a.error || '失败')),
      );
      ul.appendChild(li);
    }
  } catch { /* 忽略 */ }
}

// ── 事件绑定（统一 addEventListener，不用 inline onclick）────────────────
function bindEvents() {
  $('btn-theme').addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
    const h = lastSnapshot?.history || [];
    chartCpu.draw(h); chartMem.draw(h); chartIo.draw(h);
  });

  $('btn-refresh').addEventListener('click', () => refreshAll());

  const q = $('q');
  let qTimer = null;
  q.addEventListener('input', () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { query = q.value.trim(); fetchProcesses().catch((e) => toast(e.message, 'error')); }, 220);
  });

  $('sort').addEventListener('change', (e) => {
    sortKey = e.target.value;
    fetchProcesses().catch((err) => toast(err.message, 'error'));
  });

  // 表头点击排序
  for (const th of document.querySelectorAll('th[data-sort]')) {
    th.addEventListener('click', () => {
      const k = th.dataset.sort;
      sortKey = k;
      $('sort').value = k;
      fetchProcesses().catch((e) => toast(e.message, 'error'));
    });
  }

  // 表格行点击：详情 / 信号按钮
  $('ptbody').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action="signal"]');
    if (btn) {
      e.stopPropagation();
      sendSignal(Number(btn.dataset.pid), 'SIGTERM');
      return;
    }
    const tr = e.target.closest('tr[data-pid]');
    if (tr) openDetail(Number(tr.dataset.pid));
  });

  // 详情抽屉里的信号按钮
  for (const b of $('drawer').querySelectorAll('[data-signal]')) {
    b.addEventListener('click', () => {
      if (!currentDetailPid) return;
      sendSignal(currentDetailPid, b.dataset.signal);
    });
  }

  $('d-close').addEventListener('click', closeDetail);
  $('drawer-mask').addEventListener('click', closeDetail);

  $('modal-cancel').addEventListener('click', closeModal);
  $('modal-mask').addEventListener('click', (e) => { if (e.target === $('modal-mask')) closeModal(); });
  $('modal-ok').addEventListener('click', async () => {
    const fn = pendingAction;
    closeModal();
    if (fn) await fn();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeModal(); closeDetail(); }
    if (e.key === '/' && document.activeElement !== $('q')) { e.preventDefault(); $('q').focus(); }
  });

  window.addEventListener('beforeunload', () => { if (es) es.close(); });
}

// ── 启动 ────────────────────────────────────────────────────────────────
(async function boot() {
  bindEvents();
  await refreshAll();
  await fetchProcesses().catch((e) => toast(e.message, 'error'));
  loadAudit();
  startStream();
  // 表格数据 3 秒刷一次（SSE 只推概览与 top30，避免整表每秒重排导致选择/滚动丢失）
  setInterval(() => { fetchProcesses().catch(() => {}); }, 3000);
})();
