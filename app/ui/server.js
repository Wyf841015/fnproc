// app/ui/server.js — 进程管家 (fnproc) 后端
//
// 零依赖 Node ESM。数据全部来自 /proc 与 /sys，1 秒采样一次并缓存在内存里，
// 前端通过 SSE 拿快照、通过 REST 拿详情与发信号。
//
// 设计取舍（为什么这么做）：
//   · 每进程 CPU% 必须靠两次采样求差，不能单看 utime+stime —— 所以采样器常驻，
//     所有请求都读缓存，避免每个请求各扫一遍 /proc（几百个进程时差别很大）。
//   · cmdline / io 是较贵的读（每进程一个文件），用 TTL 缓存：
//     cmdline 10s、io 5s，详情页则强制刷新。
//   · 所有 /proc 读取都 try/catch：进程在扫描过程中消失是常态，不能因此 500。
import { readFileSync, readdirSync, existsSync, unlinkSync, statSync, statfsSync, readlinkSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import { gzipSync } from 'node:zlib';
import { openAuditStore } from './audit-db.js';
import { openHistoryStore } from './history-db.js';
import { openAlertStore, METRICS, LEVEL_LABEL } from './alert-db.js';
import { createAlertEngine, readPsiMem, diskUsedPct, webhookBlockReason } from './alerts.js';
import { openSnapshotStore } from './snapshot-db.js';

const UI_DIR = dirname(fileURLToPath(import.meta.url));
const TARGET_DIR = dirname(UI_DIR);
const PORT = parseInt(process.env.PORT || '47951', 10);
// socket 默认与 ui 同级（生产环境即 <vol>/@appcenter/fnproc/fnproc.sock）。
// 本地调试可用 FNPROC_SOCK_DIR 把它挪到 /tmp，避免 .sock 落进源码树导致 fnpack 打包失败
// （fnpack 会尝试 cp 整个目录，遇到 socket 文件报 "no such device or address"）。
const SOCK_DIR = process.env.FNPROC_SOCK_DIR || TARGET_DIR;
const SOCK_PATH = join(SOCK_DIR, 'fnproc.sock');
const GATEWAY_PREFIX = '/app/fnproc';
const VERSION = '0.2.0';
const SAMPLE_MS = 1000;
const HISTORY_MAX = 120;              // 内存里保留 120 个采样点，够前端画满图

// ── 小工具 ──────────────────────────────────────────────────────────────
// execFileSync 会把事件循环卡住：systemctl（超时 20s）或 docker（无响应）一旦变慢，
// 整个服务连 /api/health 都不响应。统一改成异步 execFile。
const execFileP = promisify(execFile);
const readOr = (p, dflt = '') => { try { return readFileSync(p, 'utf8'); } catch { return dflt; } };
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r1 = (v) => Math.round(v * 10) / 10;
// 注意：必须放在 readOr 之后 —— 放前面会踩 TDZ（Cannot access 'readOr' before initialization）
const HOST_NAME = readOr('/proc/sys/kernel/hostname').trim();

function sendJSON(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  const req = res.__req;
  const ae = String((req && req.headers['accept-encoding']) || '');
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    Vary: 'Accept-Encoding',
  };
  let out = buf;
  // 只压大响应：小 JSON 压完可能更大，还白花 CPU。/api/processes 实测 107KB→16KB。
  if (buf.length > 1024 && /gzip/.test(ae)) {
    out = gzipSync(buf);
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = out.length;
  res.writeHead(code, headers);
  res.end(out);
}

// 请求体解析。约定：解析失败不抛异常，而是返回 { __error } 让调用方回 400，
// 这样「JSON 写错」和「字段缺失」不会混在一起，排查时能看出区别。
function parseBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    let tooBig = false;
    const chunks = [];
    req.on('data', (c) => {
      if (tooBig) return;                 // 超限后继续丢弃，但不再累积
      size += c.length;
      if (size > limit) {
        tooBig = true;
        chunks.length = 0;
        resolve({ __error: '请求体过大', __status: 413 });
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) {
        resolve({ __error: '请求体不是合法 JSON: ' + String(e.message || e).slice(0, 80), __status: 400 });
      }
    });
    req.on('error', () => resolve({ __error: '读取请求体失败', __status: 400 }));
  });
}

// ── 用户表（uid → name），启动时读一次 ──────────────────────────────────
const UID_NAME = new Map();
for (const line of readOr('/etc/passwd').split('\n')) {
  const f = line.split(':');
  if (f.length > 2) UID_NAME.set(num(f[2]), f[0]);
}

// ── 静态资源 ────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
};

// 只有前端资源对外提供。UI_DIR 里同时放着 server.js / alert-db.js / config 等后端文件，
// 早期版本按「路径不越界」直接整目录放行，等于把整套后端源码和网关配置挂到公网可下载。
const STATIC_ALLOW = [
  /^index\.html$/,
  /^main\.js$/,
  /^styles\/[A-Za-z0-9._-]+\.css$/,
  /^images\/[A-Za-z0-9._-]+\.(png|jpe?g|svg|webp|gif|ico)$/,
  /^favicon\.ico$/,
];

// Accept-Encoding 里 gzip;q=0 表示「明确不要 gzip」，不能只看是否出现 gzip 字样
function wantsGzip(ae) {
  const m = String(ae || '').match(/(?:^|,)\s*gzip\s*(?:;\s*q=([0-9.]+))?/i);
  if (!m) return false;
  if (m[1] != null && Number(m[1]) <= 0) return false;
  return true;
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' || pathname === '' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (rel.includes('..') || rel.startsWith('.') || rel.includes('\\')) {
    sendJSON(res, 403, { error: '路径越界' });
    return;
  }
  if (!STATIC_ALLOW.some((re) => re.test(rel))) {
    // 白名单外：存在的文件回 403（不提供下载），不存在的回 404
    if (existsSync(join(UI_DIR, rel))) { sendJSON(res, 403, { error: '该资源不对外提供' }); return; }
    sendJSON(res, 404, { error: 'not found' });
    return;
  }
  const fp = join(UI_DIR, rel);
  let st;
  try { st = statSync(fp); } catch { sendJSON(res, 404, { error: 'not found' }); return; }
  if (!st.isFile()) { sendJSON(res, 404, { error: 'not found' }); return; }
  const type = MIME[extname(fp).toLowerCase()] || 'application/octet-stream';
  // ETag 用 size+mtime：部署新版本必然变，文件没变则命中 304 不用重下。
  // 保留 no-cache（每次都回源校验）—— fnOS WebView 缓存旧 main.js 的坑还在，
  // 不能用强缓存；304 只是把「未改动的整包传输」省掉。
  const compressible = st.size > 2048 && /^(text|application\/javascript|application\/json|image\/svg)/.test(type);
  const useGzip = compressible && wantsGzip(req.headers['accept-encoding']);
  // ETag 必须区分编码：同一 ETag 对应两种字节流时，中间的缓存可能把 gzip 内容喂给不支持的客户端
  const etag = '"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + (useGzip ? '-gz' : '') + '"';
  const headers = {
    'Content-Type': type, 'Cache-Control': 'no-cache',
    ETag: etag, 'X-Content-Type-Options': 'nosniff',
    Vary: 'Accept-Encoding',
    'Referrer-Policy': 'no-referrer',
    // 允许 fnOS 自己的外壳 iframe 与 fnOS 云域名，其它站点不允许嵌入（防点击劫持）
    "Content-Security-Policy": "frame-ancestors 'self' https://*.fnos.net;",
  };
  if (String(req.headers['if-none-match'] || '') === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  let data;
  try { data = readFileSync(fp); } catch { sendJSON(res, 500, { error: 'read failed' }); return; }
  if (useGzip) {
    data = gzipSync(data);
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = data.length;
  res.writeHead(200, headers);
  res.end(data);
}

// ── 采样器 ──────────────────────────────────────────────────────────────
const state = {
  ts: Date.now(),
  cpu: { totalPct: 0, cores: [], model: '', count: 0 },
  mem: { total: 0, available: 0, used: 0, usedPct: 0, cached: 0, buffers: 0, free: 0 },
  swap: { total: 0, used: 0, usedPct: 0 },
  load: [0, 0, 0],
  uptime: 0,
  procTotal: 0,
  io: { readBps: 0, writeBps: 0 },
  net: { rxBps: 0, txBps: 0 },
};
const history = [];                    // {ts, cpu, mem, swap, rx, tx, rd, wr}
let procs = [];                        // 最近一次进程快照
let prevCpu = null;                    // {total, perCore:[]}
let prevProc = new Map();              // pid → {ticks, io?}
let prevIo = null;                     // {read, write}
let prevNet = null;                    // {rx, tx}
const cmdCache = new Map();            // pid → {v, ts}
const ioCache = new Map();             // pid → {v, ts}
const uidOf = new Map();               // pid → uid（从 status 读，缓存 30s）

// ── 监听端口：inode → 端口 ──────────────────────────────────────────────
// /proc/net/tcp* 给出的每个 socket 只有 inode，没有 pid；要知道「哪个进程占了
// 8080」必须反向扫 /proc/PID/fd 里的 socket:[inode]。分两步：
//   1) refreshInodePorts()  解析 /proc/net/{tcp,tcp6,udp,udp6}   → inode → {port,proto,addr}
//   2) refreshPidPorts()    扫每个进程的 fd，链接名形如 socket:[12345] → 反查上表
// 第 2 步较贵（几百个进程 × 每个几十个 fd），所以拆到 10 秒一次的定时器里，
// 不放在 1 秒的主采样里。
let inodePort = new Map();
let pidPorts = new Map();          // 只含 LISTEN 的监听端口归属
let allConns = new Map();          // 全部连接（含 ESTABLISHED/TIME_WAIT），按 pid 分组

const TCP_STATE = { '01': 'ESTABLISHED', '0A': 'LISTEN', '06': 'TIME_WAIT', '08': 'CLOSE_WAIT', '09': 'LAST_ACK', '0B': 'CLOSING' };

function hexToIpv4(h) {
  if (!h || h.length !== 8) return h || '?';
  const b = h.match(/../g).map((x) => parseInt(x, 16));
  return b.reverse().join('.');
}

function refreshInodePorts() {
  const map = new Map();
  for (const [file, proto] of [
    ['/proc/net/tcp', 'tcp'], ['/proc/net/tcp6', 'tcp6'],
    ['/proc/net/udp', 'udp'], ['/proc/net/udp6', 'udp6'],
  ]) {
    const lines = readOr(file).split('\n');
    for (let i = 1; i < lines.length; i++) {
      const f = lines[i].trim().split(/\s+/);
      if (f.length < 10) continue;
      const [ipHex, portHex] = f[1].split(':');
      const st = f[3];
      const inode = f[9];
      // TCP 只关心 LISTEN（0A）；UDP 没有监听状态，全收
      if (proto.startsWith('tcp') && st !== '0A') continue;
      const port = parseInt(portHex, 16);
      if (!port) continue;
      const addr = proto.endsWith('6') ? '::' : hexToIpv4(ipHex);
      map.set(inode, { port, proto, addr, state: TCP_STATE[st] || st });
    }
  }
  inodePort = map;
}

// 端口 ↔ 进程：原来靠遍历 /proc/<pid>/fd 反查 socket inode 归属，
// 390 个进程 × 每 10 秒 ≈ 上万个 readdir/readlink 系统调用，是第二个 CPU 大户。
// 现在优先用一次 `ss -tunapH`（内核已经算好了），解析失败才退回旧路径。
// /metrics?proc= 一次最多声明多少个进程名（防误配置把 URL 写成几百个）
const PROC_METRICS_LIMIT = 20;
let portsInflight = false;
// 上次采集时见过的 PID 数量与集合摘要，用来判断「进程集合变了没」
let portsPidSig = '';
/**
 * 是否需要重新采集端口归属：
 * ① 从未采集过；② 距上次超过 30 秒；③ 进程集合发生了增删。
 * 判断③只看「数量 + 一个轻量摘要」，不做全量集合比较，377 个 PID 也就几百次
 * 字符串拼接，比 fork 一个 ss 便宜两个数量级。
 */
function portsNeedRefresh() {
  if (portsInflight) return false;
  const now = Date.now();
  if (!lastPortsAt) return true;
  if (now - lastPortsAt > 30000) return true;
  const sig = procs.length + ':' + procs.reduce((a, p) => a + (p.pid % 997), 0);
  if (sig !== portsPidSig) return true;
  return false;
}
let lastPortsAt = 0;
let portsSsOk = false;            // 本轮是否用 ss 采集成功（失败时连接视图为空，前端要能区分）
let allConnsDegraded = false;

// ── 进程追踪检查 ──────────────────────────────────────────────────────────
// 语义：给一个关键字（进程名 / 命令行片段），记住第一次看到的 PID 集合，
// 之后有新 PID 出现就记一条事件。只记录，绝不执行命令 —— 这和看门狗是两件事。
function checkWatches() {
  const watches = alertStore.listWatches();
  if (!watches.length) return 0;
  let added = 0;
  const now = Date.now();
  for (const w of watches) {
    if (!w.enabled) continue;
    const pat = String(w.pattern || '').toLowerCase();
    if (!pat) continue;
    const hits = procs.filter((p) => String(p.name || '').toLowerCase().includes(pat)
      || String(p.cmd || '').toLowerCase().includes(pat));
    const current = hits.map((p) => p.pid);
    const base = new Set(w.baseline || []);
    // 第一次（baseline 为空）只建基准，不把当下已在跑的进程全报成"新出现"
    if (!w.baseline || w.baseline.length === 0) {
      alertStore.updateWatchBaseline(w.id, current, now);
      continue;
    }
    if (now - (w.lastCheck || 0) < 4000) continue;
    for (const p of hits) {
      if (base.has(p.pid)) continue;
      alertStore.addWatchEvent({
        ts: now, watchId: w.id, watchName: w.name, kind: 'appear',
        pid: p.pid, pname: p.name, cmd: p.cmd || '',
      });
      added += 1;
      if (added > 200) break;                      // 防爆：一轮最多记 200 条
    }
    const gone = [];                               // 消失的只在基准里记下，不单独刷事件
    void gone;
    alertStore.updateWatchBaseline(w.id, current, now);
  }
  return added;
}

async function refreshPorts() {
  if (portsInflight) return;
  portsInflight = true;
  try {
    const ok = await portsViaSs();
    portsSsOk = ok;
    if (!ok) { refreshInodePorts(); refreshPidPorts(); }
  } catch {
    try { refreshInodePorts(); refreshPidPorts(); } catch { /* 忽略 */ }
  } finally {
    // 走回退路径（没装 ss / 无权限）时也要记时间戳，
    // 否则每个 /api/ports 请求都会触发一次全量 fd 扫描（数百进程同步 readdir/readlink）
    lastPortsAt = Date.now();
    portsPidSig = procs.length + ':' + procs.reduce((a, p) => a + (p.pid % 997), 0);
    allConnsDegraded = !portsSsOk;
    portsInflight = false;
  }
}

async function portsViaSs() {
  let out = '';
  try {
    const r = await execFileP('ss', ['-tunapH'],
      { timeout: 5000, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    out = String(r.stdout || '');
  } catch {
    return false;                     // 没装 ss / 无权限 → 调用方回退
  }
  if (!out.trim()) return false;
  const byPid = new Map();
  const conns = new Map();
  let candidates = 0;               // 「看起来是端口」的行数，仅供诊断
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const f = t.split(/\s+/);
    // 字段：Netid State Recv-Q Send-Q Local Peer [Process]
    if (f.length < 6) continue;
    const netid = f[0];
    const state = f[1];
    const local = f[4];
    if (!netid.startsWith('tcp') && !netid.startsWith('udp')) continue;
    if (netid.startsWith('tcp') && state !== 'LISTEN') continue;   // 与旧实现一致：TCP 只看监听
    candidates += 1;
    const m = t.match(/pid=(\d+)/);
    if (!m) continue;
    const pid = num(m[1]);
    const idx = local.lastIndexOf(':');
    if (idx < 0) continue;
    const port = num(local.slice(idx + 1));
    if (!port) continue;
    const addr = local.slice(0, idx).replace(/^\[|\]$/g, '');
    if (!byPid.has(pid)) byPid.set(pid, []);
    byPid.get(pid).push({ port, proto: netid, addr, state: state === 'LISTEN' ? 'LISTEN' : state });
    // 同一份 ss 结果顺带记一份「全部连接」，连接视图就不用再跑一次 ss 了
    const peer = f[5] || '';
    const pIdx = peer.lastIndexOf(':');
    if (!conns.has(pid)) conns.set(pid, []);
    conns.get(pid).push({
      proto: netid,
      local: local.replace(/^\[|\]$/g, ''),
      port,
      remote: pIdx > 0 ? peer.slice(0, pIdx) : peer,
      remotePort: pIdx > 0 ? num(peer.slice(pIdx + 1)) : 0,
      state: state === 'LISTEN' ? 'LISTEN' : state,
    });
  }
  // 非 root 时 ss 只给得出自己进程的 pid：实测 admin 167 行里只有 5 行带 pid，
  // root 有 129 行。所以判据用「带 pid 的行占比」，而不是按端口数估算
  // （早先那版把 33 个进程 / 128 个端口误判成「看不到」，直接退回慢路径）。
  const totalLines = out.split('\n').filter((l) => l.trim()).length || 1;
  const pidLines = out.split('\n').filter((l) => l.includes('pid=')).length;
  if (!byPid.size || pidLines / totalLines < 0.3) return false;
  for (const [pid, list] of byPid) {
    const seen = new Set();
    byPid.set(pid, list.filter((p) => {
      const k = p.proto + p.port + p.addr;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).sort((a, b) => a.port - b.port));
  }
  pidPorts = byPid;
  allConns = conns;
  lastPortsAt = Date.now();
  portsPidSig = procs.length + ':' + procs.reduce((a, p) => a + (p.pid % 997), 0);
  return true;
}

function refreshPidPorts() {
  const out = new Map();
  let pids = [];
  try { pids = readdirSync('/proc').filter((n) => /^\d+$/.test(n)); } catch { return; }
  for (const pidStr of pids) {
    let fds = [];
    try { fds = readdirSync(`/proc/${pidStr}/fd`); } catch { continue; }
    const list = [];
    for (const fd of fds) {
      let link = '';
      try { link = readlinkSync(`/proc/${pidStr}/fd/${fd}`); } catch { continue; }
      if (!link.startsWith('socket:[')) continue;
      const ino = link.slice(8, -1);
      const info = inodePort.get(ino);
      if (info) list.push(info);
    }
    if (list.length) out.set(num(pidStr), list);
  }
  // 按端口去重（同一进程可能多 fd 指向同一 socket）
  for (const [pid, list] of out) {
    const seenP = new Set();
    out.set(pid, list.filter((p) => {
      const k = p.proto + p.port + p.addr;
      if (seenP.has(k)) return false;
      seenP.add(k);
      return true;
    }).sort((a, b) => a.port - b.port));
  }
  pidPorts = out;
}

// ── 容器归属：cgroup → 容器短 ID → docker 容器名 ─────────────────────────
// fnOS 上的 docker 容器进程，/proc/PID/cgroup 里带 docker/<64位hex> 或
// docker-<64位hex>.scope。只认 64 位 hex，避免把 systemd 自己的 slice 误判成容器。
const cgroupCache = new Map();          // pid → {v, ts}
let dockerNames = new Map();            // 短ID(12) → 容器名
let containerStats = { at: 0, map: new Map(), error: '' };   // docker stats 缓存
let statsWait = null;                    // docker stats 在途 promise（并发请求共用，避免扇出多个子进程）
let dockerAt = 0;

let dockerInflight = false;
async function refreshDocker() {
  const now = Date.now();
  if (dockerInflight || now - dockerAt < 15000) return;   // docker 命令有开销，15s 才跑一次
  dockerAt = now;
  dockerInflight = true;
  const names = new Map();
  try {
    const { stdout } = await execFileP('docker', ['ps', '--no-trunc', '--format', '{{.ID}}\t{{.Names}}'],
      { timeout: 4000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    for (const line of String(stdout).split('\n')) {
      const [id, name] = line.trim().split('\t');
      if (id && name) names.set(id.slice(0, 12), name);
    }
    // 容器名变了要清缓存：cgroup → 容器 的映射 TTL 是 30 秒，
    // 刚启动时 docker ps 还没跑，会把容器名缓存成短 ID 并保持半分钟。
    let changed = names.size !== dockerNames.size;
    if (!changed) { for (const [k, v] of names) { if (dockerNames.get(k) !== v) { changed = true; break; } } }
    dockerNames = names;
    if (changed) cgroupCache.clear();
  } catch {
    /* 没装 docker / 无权限 / 超时：保留上一次结果，静默降级 */
  } finally {
    dockerInflight = false;
  }
}

function procContainer(pid) {
  const now = Date.now();
  const c = cgroupCache.get(pid);
  if (c && now - c.ts < 30000) return c.v;
  let v = null;
  const m = readOr(`/proc/${pid}/cgroup`).match(/(?:docker[-/]|cri-containerd[-/]|libpod-)([0-9a-f]{64})/);
  if (m) {
    const id = m[1].slice(0, 12);
    v = { id, name: dockerNames.get(id) || id };
  }
  cgroupCache.set(pid, { v, ts: now });
  return v;
}


const CLK_TCK = 100;                   // Linux 上恒为 100（USER_HZ），getconf CLK_TCK 一致
const PAGE = 4096;
const BOOT_MS = Date.now() - num(readOr('/proc/uptime').split(' ')[0]) * 1000;

function readCpuModel() {
  for (const line of readOr('/proc/cpuinfo').split('\n')) {
    if (line.startsWith('model name')) return line.split(':')[1].trim();
  }
  return '';
}

let lastCpuDelta = { dt: 0, di: 0 };
// 进程扫描的节奏可能慢于 1 秒（有人看 2 秒一次 / 没人看 10 秒一次），
// 所以 CPU% 的分母要跨过被跳过的 tick 累加起来，否则进程 CPU% 会虚高几倍。
let pendingCpuDelta = 0;
function sampleCpu() {
  const lines = readOr('/proc/stat').split('\n');
  const parse = (f) => {
    const v = f.slice(1).map(num);
    const idle = v[3] + (v[4] || 0);            // idle + iowait
    const total = v.reduce((a, b) => a + b, 0);
    return { idle, total };
  };
  const cores = [];
  let total = null;
  for (const line of lines) {
    if (!line.startsWith('cpu')) continue;
    const f = line.trim().split(/\s+/);
    if (f[0] === 'cpu') total = parse(f);
    else cores.push(parse(f));
  }
  if (!total) return;
  let totalPct = 0;
  if (prevCpu) {
    const dt = total.total - prevCpu.total.total;
    const di = total.idle - prevCpu.total.idle;
    lastCpuDelta = { dt, di };
    totalPct = dt > 0 ? Math.max(0, Math.min(100, (1 - di / dt) * 100)) : 0;
  }
  const corePct = cores.map((c, i) => {
    const p = prevCpu && prevCpu.perCore[i];
    if (!p) return 0;
    const dt = c.total - p.total, di = c.idle - p.idle;
    return dt > 0 ? Math.max(0, Math.min(100, (1 - di / dt) * 100)) : 0;
  });
  prevCpu = { total, perCore: cores };
  state.cpu = {
    totalPct: r1(totalPct),
    cores: corePct.map(r1),
    count: cores.length,
    model: state.cpu.model || readCpuModel(),
  };
}

function sampleMem() {
  const m = {};
  for (const line of readOr('/proc/meminfo').split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    m[line.slice(0, i)] = num(line.slice(i + 1).trim().split(/\s+/)[0]) * 1024;
  }
  const total = m.MemTotal || 0;
  const available = m.MemAvailable || 0;
  const used = Math.max(0, total - available);
  state.mem = {
    total, available, used,
    usedPct: total ? r1((used / total) * 100) : 0,
    free: m.MemFree || 0,
    buffers: m.Buffers || 0,
    cached: (m.Cached || 0) + (m.SReclaimable || 0),
    dirty: m.Dirty || 0,
  };
  const st = m.SwapTotal || 0, sf = m.SwapFree || 0;
  state.swap = { total: st, used: Math.max(0, st - sf), usedPct: st ? r1(((st - sf) / st) * 100) : 0 };
}

function sampleLoad() {
  const f = readOr('/proc/loadavg').split(/\s+/);
  state.load = [num(f[0]), num(f[1]), num(f[2])];
  state.uptime = Math.round(num(readOr('/proc/uptime').split(' ')[0]));
}

function diskDevices() {
  const out = [];
  for (const name of readdirSync('/sys/block').sort()) {
    if (/^(loop|ram|zram|sr\d)/.test(name)) continue;
    out.push(name);
  }
  return out;
}
const DISK_DEVS = (() => { try { return diskDevices(); } catch { return []; } })();

function sampleIo(dtSec) {
  let rd = 0, wr = 0;
  for (const line of readOr('/proc/diskstats').split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    if (!DISK_DEVS.includes(f[2])) continue;
    rd += num(f[5]) * 512;
    wr += num(f[9]) * 512;
  }
  if (prevIo && dtSec > 0) {
    state.io = {
      readBps: Math.max(0, Math.round((rd - prevIo.read) / dtSec)),
      writeBps: Math.max(0, Math.round((wr - prevIo.write) / dtSec)),
    };
  }
  prevIo = { read: rd, write: wr };
}

function sampleNet(dtSec) {
  let rx = 0, tx = 0;
  for (const line of readOr('/proc/net/dev').split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const name = line.slice(0, i).trim();
    if (name === 'lo') continue;
    const f = line.slice(i + 1).trim().split(/\s+/);
    rx += num(f[0]);
    tx += num(f[8]);
  }
  if (prevNet && dtSec > 0) {
    state.net = {
      rxBps: Math.max(0, Math.round((rx - prevNet.rx) / dtSec)),
      txBps: Math.max(0, Math.round((tx - prevNet.tx) / dtSec)),
    };
  }
  prevNet = { rx, tx };
}

function procCmdline(pid, force = false) {
  const now = Date.now();
  const c = cmdCache.get(pid);
  if (!force && c && now - c.ts < 10000) return c.v;
  let v = readOr(`/proc/${pid}/cmdline`).replace(/\0+$/, '').split('\0').join(' ').trim();
  if (!v) v = readOr(`/proc/${pid}/comm`).trim();
  cmdCache.set(pid, { v, ts: now });
  return v;
}

function procIo(pid, force = false) {
  const now = Date.now();
  const c = ioCache.get(pid);
  // IO 是累计计数器，1 分钟粒度足够看清「谁在写盘」，没必要每秒重读。
  // 377 个进程 × 每 5 秒一次 = 每分钟 4500 次文件读取，改成 60 秒后降到 377 次。
  // 需要精确值的路径（/api/io 卡片）自己带 force 或依赖本缓存即可。
  if (!force && c && now - c.ts < 60000) return c.v;
  const v = { read: 0, write: 0 };
  for (const line of readOr(`/proc/${pid}/io`).split('\n')) {
    const [k, val] = line.split(':');
    if (k === 'read_bytes') v.read = num(val);
    if (k === 'write_bytes') v.write = num(val);
  }
  ioCache.set(pid, { v, ts: now });
  return v;
}

function procUid(pid) {
  const now = Date.now();
  const c = uidOf.get(pid);
  if (c && now - c.ts < 30000) return c.uid;
  let uid = -1;
  for (const line of readOr(`/proc/${pid}/status`).split('\n')) {
    if (line.startsWith('Uid:')) { uid = num(line.split(/\s+/)[1]); break; }
  }
  uidOf.set(pid, { uid, ts: now });
  return uid;
}

// ── 详情页用的深度读取（只在打开详情/发信号时才跑，不进 1 秒采样热路径）──────
// PSS/USS 必须从 smaps_rollup 取：RSS 会把共享库和共享内存重复计进每个进程，
// 全机 RSS 相加能比真实占用高出一大截（实测 4.4GB vs PSS 3.2GB）。
function readSmaps(pid) {
  const raw = readOr(`/proc/${pid}/smaps_rollup`);
  if (!raw) return null;
  const out = { rss: 0, pss: 0, shared: 0, uss: 0, swap: 0, anonymous: 0, sharedClean: 0, sharedDirty: 0, privateClean: 0, privateDirty: 0 };
  for (const line of raw.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const val = num(line.slice(idx + 1).trim().split(/\s+/)[0]) * 1024;
    switch (key) {
      case 'Rss': out.rss = val; break;
      case 'Pss': out.pss = val; break;
      case 'Anonymous': out.anonymous = val; break;
      case 'Swap': out.swap = val; break;
      case 'Shared_Clean': out.sharedClean = val; break;
      case 'Shared_Dirty': out.sharedDirty = val; break;
      case 'Private_Clean': out.privateClean = val; break;
      case 'Private_Dirty': out.privateDirty = val; break;
      default: break;
    }
  }
  out.shared = out.sharedClean + out.sharedDirty;
  out.uss = out.privateClean + out.privateDirty;   // USS = 独享物理内存
  return out;
}

// cgroup v2：路径 + 内存额度。max 表示不限（返回字符串 'max'）
function readCgroupMem(pid) {
  const lines = readOr(`/proc/${pid}/cgroup`).trim().split('\n');
  let path = '';
  for (const line of lines) {
    const parts = line.split(':');
    if (parts.length >= 3 && parts[2]) { path = parts[2]; break; }
  }
  if (!path) return null;
  const base = '/sys/fs/cgroup' + (path === '/' ? '' : path);
  const readKey = (f) => {
    const v = readOr(join(base, f)).trim();
    if (!v) return null;
    if (v === 'max') return 'max';
    return num(v);
  };
  return {
    path,
    current: readKey('memory.current'),
    high: readKey('memory.high'),
    max: readKey('memory.max'),
    peak: readKey('memory.peak'),
    pids: readKey('pids.current'),
    pidsMax: readKey('pids.max'),
  };
}

function readThreads(pid, limit = 40) {
  let tids = [];
  try { tids = readdirSync(`/proc/${pid}/task`).map(num).filter(Boolean); } catch { return { count: 0, list: [] }; }
  const list = [];
  for (const tid of tids.slice(0, limit)) {
    const name = readOr(`/proc/${pid}/task/${tid}/comm`).trim();
    list.push({ tid, name: name || '?' });
  }
  return { count: tids.length, list, truncated: tids.length > limit };
}

// 沿 ppid 往上走，得到「父进程链」（限 8 层，防环形脏数据把循环卡死）
function readParentChain(pid, depth = 8) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const chain = [];
  let cur = byPid.get(pid)?.ppid || 0;
  const guard = new Set();
  while (cur > 0 && chain.length < depth && !guard.has(cur)) {
    guard.add(cur);
    const p = byPid.get(cur);
    chain.push({ pid: cur, name: p?.name || readOr(`/proc/${cur}/comm`).trim() || '?' });
    cur = p?.ppid || 0;
  }
  return chain;
}

// 环境变量：名字含 KEY/TOKEN/SECRET/PASS/AUTH/COOKIE 的值一律打码 ——
// 详情页是给人看的，不该把凭据原样铺在屏幕上（也避免被截图带走）。
// 密钥识别：键名关键词 + 值形状双判据。
// 只靠关键词会漏 DATABASE_URL / *_DSN / *_URI / BEARER / LICENSE 这类，
// 而这些恰恰是最常放连接串与授权码的地方。
const SECRET_KEY_RE = /(KEY|TOKEN|SECRET|PASS|PWD|AUTH|COOKIE|CREDENTIAL|SESSION|LICENSE|SIGN|SALT|DSN|DATABASE|REDIS|MONGO|MYSQL|PGHOST|PGUSER|API|BEARER|PRIVATE|CERT)/i;
// 值形状：xx://user:pass@host 或 query 里带 token/password
const SECRET_VALUE_RE = /\/\/[^/\s:@]+:[^/\s@]+@|(?:^|[?&])(?:token|password|passwd|secret|api_?key|access_?key|sig)=/i;

function readEnvPairs(pid, limit = 0) {
  const raw = readOr(`/proc/${pid}/environ`);
  if (!raw) return { count: 0, list: [], masked: 0 };
  const all = raw.split('\0').filter(Boolean);
  let masked = 0;
  const list = [];
  // limit<=0 表示不截断：早期只处理前 40 条，排在后面的敏感项既不显示也不计数
  const slice = limit > 0 ? all.slice(0, limit) : all;
  for (const kv of slice) {
    const eq = kv.indexOf('=');
    const k = eq > 0 ? kv.slice(0, eq) : kv;
    let v = eq > 0 ? kv.slice(eq + 1) : '';
    if (v && (SECRET_KEY_RE.test(k) || SECRET_VALUE_RE.test(v))) { v = '***'; masked += 1; }
    else if (v.length > 140) v = v.slice(0, 140) + '…';
    list.push({ k, v });
  }
  return { count: all.length, list, masked, truncated: limit > 0 && all.length > limit };
}

function readFdLimit(pid) {
  for (const line of readOr(`/proc/${pid}/limits`).split('\n')) {
    if (line.startsWith('Max open files')) {
      const f = line.slice(14).trim().split(/\s{2,}/);
      return { soft: num(f[0]), hard: num(f[1]) };
    }
  }
  return null;
}

// 子孙进程：广度优先展开。杀整棵子树时先按深度倒序（先子后父），
// 否则父进程先死会让子进程变孤儿（被 init 收养）而漏杀。
function descendantsOf(pid) {
  const kids = new Map();
  for (const p of procs) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p.pid);
  }
  const levels = [];
  let frontier = [pid];
  const seen = new Set([pid]);
  while (frontier.length && seen.size < 5000) {
    const next = [];
    for (const cur of frontier) {
      for (const c of kids.get(cur) || []) {
        if (seen.has(c)) continue;
        seen.add(c);
        next.push(c);
      }
    }
    if (next.length) levels.push(next);
    frontier = next;
  }
  return levels;          // 第 0 层是子，最后一层是最深的孙
}

function sampleProcs() {
  let pids = [];
  try { pids = readdirSync('/proc').filter((n) => /^\d+$/.test(n)); } catch { /* 忽略 */ }
  const now = Date.now();
  // 分母必须是「两次采样之间」的总 jiffies 增量，不能用累计值：
  // 用累计值算出来的进程 CPU% 会小到四舍五入后全是 0.0。
  // 分母 = 上次扫描以来累计的全机 jiffies
  const totalDelta = pendingCpuDelta > 0 ? pendingCpuDelta : (lastCpuDelta.dt > 0 ? lastCpuDelta.dt : 0);
  pendingCpuDelta = 0;
  const ncpu = Math.max(1, state.cpu.count || 1);
  const list = [];
  const seen = new Set();
  for (const pidStr of pids) {
    const pid = num(pidStr);
    if (!pid) continue;
    const statRaw = readOr(`/proc/${pid}/stat`);
    if (!statRaw) continue;
    // comm 里可能带空格与括号：以最后一个 ')' 为界切分，避免 comm 含 ") " 时错位
    const close = statRaw.lastIndexOf(')');
    const open = statRaw.indexOf('(');
    if (close < 0 || open < 0) continue;
    const comm = statRaw.slice(open + 1, close);
    const rest = statRaw.slice(close + 2).split(/\s+/);
    // 字段序号按 proc(5)：state=0, ppid=1, ... utime=11, stime=12, ... num_threads=17, starttime=19, rss=21
    const stateCh = rest[0] || '?';
    const ppid = num(rest[1]);
    const utime = num(rest[11]), stime = num(rest[12]);
    const threads = num(rest[17]);
    const startTicks = num(rest[19]);
    const rssPages = num(rest[21]);
    const nice = num(rest[16]);
    const ticks = utime + stime;
    const prev = prevProc.get(pid);
    let cpuPct = 0;
    if (prev && totalDelta > 0) {
      const dt = Math.max(0, ticks - prev.ticks);
      // 口径与 top 的 %CPU 一致：占「整机 CPU 容量」的百分比。
      // dt 是单进程的 jiffies 增量，totalDelta 是全机增量（含所有核），
      // 所以先算占比再乘核数，满载一个核 ≈ 100%/核数 * 核数 = (100/核数)*核数。
      cpuPct = (dt / totalDelta) * 100 * ncpu;
    }
    const uid = procUid(pid);
    const io = procIo(pid);
    list.push({
      pid, ppid, name: comm, state: stateCh, threads, nice,
      cpuPct: r1(cpuPct),
      rss: rssPages * PAGE,
      cpuTime: Math.round(ticks / CLK_TCK),
      startMs: BOOT_MS + (startTicks / CLK_TCK) * 1000,
      user: UID_NAME.get(uid) || (uid >= 0 ? String(uid) : '?'),
      cmd: procCmdline(pid),
      ioRead: io.read,
      ioWrite: io.write,
      ports: pidPorts.get(pid) || [],
      container: procContainer(pid),
    });
    seen.add(pid);
    prevProc.set(pid, { ticks });
  }
  // 清理已消失进程的缓存，防止长期运行时 Map 无限增长
  for (const pid of prevProc.keys()) if (!seen.has(pid)) prevProc.delete(pid);
  for (const pid of cmdCache.keys()) if (!seen.has(pid)) cmdCache.delete(pid);
  for (const pid of ioCache.keys()) if (!seen.has(pid)) ioCache.delete(pid);
  for (const pid of uidOf.keys()) if (!seen.has(pid)) uidOf.delete(pid);
  for (const pid of cgroupCache.keys()) if (!seen.has(pid)) cgroupCache.delete(pid);
  for (const pid of pidPorts.keys()) if (!seen.has(pid)) pidPorts.delete(pid);
  procs = list;
  state.procTotal = list.length;
  state.ts = now;
  const pids2 = list.filter((p) => p.name !== 'fnproc');
  return pids2;
}

let lastSampleAt = Date.now();
let lastApiHit = Date.now();
let lastProcScanAt = 0;

// 「有人在看吗」：有 SSE 长连接，或最近 N 秒内有过任何一个 /api 请求。
function activeRecently(ms = 30000) {
  return clients.size > 0 || (Date.now() - lastApiHit < ms);
}

// 请求进来时保证进程数据是新的（空闲期只每 5 秒扫一次，别把 5 秒前的数据当实时返回）
function ensureFreshProcs(maxAgeMs = 1200) {
  if (Date.now() - state.ts > maxAgeMs) {
    sampleProcs();
    lastProcScanAt = Date.now();
  }
}

// 只认 /proc/mounts 里真实挂载的卷根（/vol1、/vol2…）。
// 直接用 readdir('/') 会把 /vol00 这种「外接存储空壳目录」也算进来 ——
// 它没挂设备时 statfs 报的是根分区，会让「磁盘占用」告警盯错对象。
function volumeMounts() {
  const out = [];
  const seen = new Set();
  for (const line of readOr('/proc/mounts').split('\n')) {
    const f = line.split(/\s+/);
    if (f.length < 4) continue;
    const mount = f[1];
    if (!/^\/vol\d+$/.test(mount) || seen.has(mount)) continue;
    seen.add(mount);
    out.push(mount);
  }
  return out;
}

// PSI（进程压力）与各卷用量：几秒才变一次，5 秒采一次就够，不必挤进 1 秒主循环。
// PSI 比 CPU% 更能回答「机器为什么卡」——它统计的是进程真正在等资源的时间。
const volumes = { at: 0, list: [] };
const psi = { at: 0, cpu: 0, mem: 0, io: 0 };

function readPsi(file) {
  const raw = readOr(`/proc/pressure/${file}`);
  const line = raw.split('\n').find((l) => l.startsWith('some')) || '';
  const m = line.match(/avg60=([\d.]+)/) || line.match(/avg10=([\d.]+)/);
  return m ? Number(m[1]) : 0;
}

function refreshVolumes() {
  const now = Date.now();
  if (now - volumes.at < 5000) return;
  volumes.at = now;
  psi.cpu = readPsi('cpu');
  psi.mem = readPsi('memory');
  psi.io = readPsi('io');
  psi.at = now;
  const list = [];
  for (const mount of volumeMounts()) {
    try {
      const st = statfsSync(mount);
      const total = st.blocks * st.bsize;
      if (!total) continue;
      const free = st.bfree * st.bsize;
      const avail = st.bavail * st.bsize;
      list.push({
        mount,
        total,
        used: total - free,
        avail,
        usedPct: Math.round(((total - free) / total) * 1000) / 10,
        inodesTotal: st.files,
        inodesFree: st.ffree,
        inodesUsedPct: st.files ? Math.round(((st.files - st.ffree) / st.files) * 1000) / 10 : 0,
      });
    } catch { /* 未挂载 / 无权限 */ }
  }
  volumes.list = list;
}

function tick() {
  const now = Date.now();
  const dtSec = Math.max(0.2, (now - lastSampleAt) / 1000);
  lastSampleAt = now;
  sampleCpu();
  sampleMem();
  sampleLoad();
  refreshVolumes();                    // 内部 5 秒自节流
  sampleIo(dtSec);
  sampleNet(dtSec);
  // 全量扫 /proc（每个进程一个 stat 文件）是本项目最大的 CPU 开销：
  // 390 个进程 × 每秒一次 ≈ 持续 3% CPU。没人看的时候降到 5 秒一次，
  // 系统级指标照旧 1 秒采，所以历史曲线/告警不受影响。
  pendingCpuDelta += Math.max(0, lastCpuDelta.dt || 0);
  // 有人看：2 秒扫一次（表格本身 10 秒才拉一次，2 秒足够新）；
  // 没人看：10 秒扫一次。两种情况 CPU% 都靠 pendingCpuDelta 保持正确。
  const procInterval = activeRecently(30000) ? 2000 : 10000;
  if (now - lastProcScanAt >= procInterval) {
    sampleProcs();
    lastProcScanAt = now;
  }
  history.push({
    ts: now,
    cpu: state.cpu.totalPct,
    mem: state.mem.usedPct,
    swap: state.swap.usedPct,
    load: state.load[0],
    rd: state.io.readBps,
    wr: state.io.writeBps,
    rx: state.net.rxBps,
    tx: state.net.txBps,
  });
  if (history.length > HISTORY_MAX) history.shift();
  // 告警判定用的就是这份已采好的数据，不再额外扫 /proc
  alertEngine.setContext({
    cpu: state.cpu.totalPct,
    mem: state.mem.usedPct,
    swap: state.swap.usedPct,
    procs,
    procTotal: state.procTotal,
    units: unitsCache.list,
    host: HOST_NAME,
  });
  broadcast();
}

// ── SSE ─────────────────────────────────────────────────────────────────
const clients = new Set();

// SSE 是每秒一帧的长连接，每帧体积直接等于带宽：整包实测 16.5 KB/秒
// （一个页面挂一天 ≈ 1.4 GB）。而前端只用到标量 KPI + 最近 60 个历史点，
// 帧里那份 top30 进程列表从来没被读过 —— 所以 SSE 改推紧凑帧：
// 去掉 top，历史点压成数组（60 行 × 8 个数字，约 2.7 KB）。
const HIST_KEYS = ['ts', 'cpu', 'mem', 'swap', 'rd', 'wr', 'rx', 'tx'];
function histCompact() {
  const out = [];
  for (const h of history.slice(-60)) {
    out.push([
      h.ts,
      Math.round((h.cpu || 0) * 10) / 10,
      Math.round((h.mem || 0) * 10) / 10,
      Math.round((h.swap || 0) * 10) / 10,
      Math.round(h.rd || 0), Math.round(h.wr || 0),
      Math.round(h.rx || 0), Math.round(h.tx || 0),
    ]);
  }
  return out;
}
// 实时帧里的历史曲线：曲线每 5 秒才需要前进一格（appendHistory 是 30 秒一个
// 采样点），每秒重推一遍一模一样的数组纯属浪费带宽。这里只在曲线真的变了
// 之后才带上 h/hk，其余帧省掉这两个字段 —— 前端沿用上一份即可。
let lastHistPayload = '';
function sseSnapshot() {
  const base = {
    ts: state.ts,
    version: VERSION,
    cpu: state.cpu,
    mem: state.mem,
    swap: state.swap,
    load: state.load,
    uptime: state.uptime,
    procTotal: state.procTotal,
    io: state.io,
    net: state.net,
  };
  const h = histCompact();
  const sig = h.length + '|' + (h.length ? h[h.length - 1].join(',') : '');
  if (sig !== lastHistPayload) {
    lastHistPayload = sig;
    base.hk = HIST_KEYS;
    base.h = h;
  }
  return base;
}

function broadcast() {
  if (!clients.size) return;
  const payload = `data: ${JSON.stringify(sseSnapshot())}\n\n`;
  for (const res of clients) {
    // 对已断开的 ServerResponse 调 write() 不会抛异常（实测 Node 24），
    // 所以只能主动查状态，否则死连接会一直留在集合里被反复写入
    if (res.writableEnded || res.destroyed) { clients.delete(res); continue; }
    try {
      if (!res.write(payload)) { /* 背压：本帧写满缓冲，丢弃后续由下次推送补上 */ }
    } catch { clients.delete(res); }
  }
}

function snapshot(topN = 30) {
  const top = [...procs].sort((a, b) => b.cpuPct - a.cpuPct).slice(0, topN);
  return {
    ts: state.ts,
    version: VERSION,
    cpu: state.cpu,
    mem: state.mem,
    swap: state.swap,
    load: state.load,
    uptime: state.uptime,
    procTotal: state.procTotal,
    io: state.io,
    net: state.net,
    history: history.slice(-60),
    top,
  };
}

// ── 审计 ────────────────────────────────────────────────────────────────
// 审计原先只是内存里最近 100 条的环形数组，进程一重启（或崩溃、掉电）就全没了，
// 「事后可追」等于空话。现在全部落到 SQLite（见 audit-db.js）：WAL + synchronous=FULL，
// 同步写入且在回 HTTP 响应之前完成，只增不删。store 在 DATA_DIR 定义之后创建。


// ── 历史落盘 ────────────────────────────────────────────────────────────
// 内存里的 history 只有 120 个点（2 分钟），进程一重启就没了。这里每 30 秒
// 追加一行 JSON 到 <PKGVAR>/data/history.jsonl，供「最近 10 分钟 / 1 小时 /
// 6 小时 / 24 小时」的长时段曲线读取。
// 文件超过 8MB 就只保留最后 3000 行（约 25 小时），避免无限增长。
const PKGVAR = process.env.TRM_PKGVAR || process.env.TRIM_PKGVAR || join(TARGET_DIR, 'data');
const DATA_DIR = join(PKGVAR, 'data');
const HISTORY_FILE = join(DATA_DIR, 'history.jsonl');
const HISTORY_MAX_BYTES = 8 * 1024 * 1024;
const HISTORY_KEEP_LINES = 3000;

try { mkdirSync(DATA_DIR, { recursive: true }); } catch { /* 只读环境就静默降级 */ }

// ── 审计库 ──────────────────────────────────────────────────────────────
const AUDIT_DB = join(DATA_DIR, 'audit.db');
const auditStore = openAuditStore(AUDIT_DB, { version: VERSION });
if (auditStore.enabled) {
  const h = auditStore.health();
  console.log(`[audit] SQLite 已启用: ${AUDIT_DB} journal=${h.journalMode} sync=${h.synchronous} rows=${h.total}`);
} else {
  console.error('[audit] SQLite 打开失败，降级为内存待写队列:', auditStore.health().error);
}

// ── 采样历史库 ──────────────────────────────────────────────────────────
// 老的 history.jsonl 只在新库不可用时继续写；能开库就只写库，避免双份落盘。
// 首次启动会把已有 jsonl 一次性迁进来（迁完不再读它）。
const HISTORY_DB = join(DATA_DIR, 'history.db');
const HISTORY_RETENTION_DAYS = 7;
const ALERT_EVENT_RETENTION_DAYS = 180;      // 告警事件保留半年，避免无限增长
const historyStore = openHistoryStore(HISTORY_DB, {
  retentionDays: HISTORY_RETENTION_DAYS,
  migrateFrom: HISTORY_FILE,
});
if (historyStore.enabled) {
  const h = historyStore.health();
  console.log(`[history] SQLite 已启用: ${HISTORY_DB} rows=${h.rows} 迁移=${h.migrated} 保留=${HISTORY_RETENTION_DAYS}天`);
} else {
  console.error('[history] SQLite 打开失败，回退到 history.jsonl:', historyStore.health().error);
}
// 每小时裁一次过期采样（不再有 8MB 整文件重写）
setInterval(() => {
  const removed = historyStore.prune(HISTORY_RETENTION_DAYS);
  if (removed > 0) console.log(`[history] 清理过期采样 ${removed} 行`);
  const evRemoved = alertStore.pruneEvents(ALERT_EVENT_RETENTION_DAYS);
  if (evRemoved > 0) console.log(`[alert] 清理过期告警事件 ${evRemoved} 行`);
  const wRemoved = alertStore.pruneWatchEvents(30);
  if (wRemoved > 0) console.log(`[watch] 清理过期追踪事件 ${wRemoved} 行`);
}, 3600 * 1000);

// ── 进程快照 ────────────────────────────────────────────────────────────
// 存的是「某一刻的进程清单」，用来跨天对比：谁新起了、谁没了、谁内存涨了。
let lastSnapshotAt = 0;            // 快照写入节流
let lastAlertTestAt = 0;           // 测试通知节流
const snapshotStore = openSnapshotStore(join(DATA_DIR, 'snapshots.db'), { version: VERSION });
if (snapshotStore.enabled) {
  console.log(`[snapshot] 快照库已启用: ${snapshotStore.path} 现有 ${snapshotStore.health().snapshots} 个快照`);
} else {
  console.error('[snapshot] 快照库打开失败:', snapshotStore.health().error);
}

// ── 告警 ────────────────────────────────────────────────────────────────
// 规则与事件都落 SQLite（alerts.db）；判定每 5 秒一轮，只用已采好的数据。
const ALERT_DB = join(DATA_DIR, 'alerts.db');
const alertStore = openAlertStore(ALERT_DB, { version: VERSION });
const alertEngine = createAlertEngine({
  store: alertStore,
  version: VERSION,
  log: console.log,
  getUnits: async () => listUnits(),
});
if (alertStore.enabled) {
  const st = alertStore.stats();
  console.log(`[alert] 告警库已启用: ${ALERT_DB} 规则=${st.rules}（启用 ${st.enabled}）事件=${st.events}`);
  const prunedEvents = alertStore.pruneEvents(ALERT_EVENT_RETENTION_DAYS);
  if (prunedEvents > 0) console.log(`[alert] 启动清理过期事件 ${prunedEvents} 行`);
  // 首次运行给几条有意义的默认规则（阈值偏保守、持续时间长，避免抖动误报）。
  // 不想要可以在「告警」页删掉或关掉。
  if (st.rules === 0) {
    const seeds = [
      { name: 'CPU 持续过高', metric: 'cpu', op: '>', threshold: 90, durationSec: 180, cooldownSec: 900, level: 1 },
      { name: '内存持续过高', metric: 'mem', op: '>', threshold: 85, durationSec: 300, cooldownSec: 900, level: 1 },
      { name: 'Swap 使用过高', metric: 'swap', op: '>', threshold: 60, durationSec: 600, cooldownSec: 1800, level: 1 },
      { name: '发生 OOM', metric: 'oom', op: '>', threshold: 0, durationSec: 0, cooldownSec: 3600, level: 2 },
    ];
    // 磁盘：挑当前占用最高的卷，超过 90% 才报
    let worst = null;
    try {
      for (const mount of volumeMounts()) {
        const pct = diskUsedPct(mount);
        if (pct != null && (!worst || pct > worst.pct)) worst = { mount, pct };
      }
    } catch { /* 忽略 */ }
    if (worst) {
      seeds.push({
        name: `磁盘占用过高（${worst.mount}）`, metric: 'disk', op: '>', threshold: 90,
        durationSec: 600, cooldownSec: 3600, level: 1, target: worst.mount,
      });
    }
    let n = 0;
    for (const s of seeds) {
      const r = alertStore.saveRule({ enabled: true, notifyFn: true, webhook: '', target: '', ...s });
      if (r.ok) n += 1;
    }
    console.log(`[alert] 已播种 ${n} 条默认规则（阈值可在界面上改）`);
  }
} else {
  console.error('[alert] 告警库打开失败:', alertStore.health().error);
}

// 记录一条操作。在回 HTTP 响应之前调用 —— 客户端看到成功，就等于库里已有这条记录。
function auditRecord({ action, target = '', result = 'ok', message = '', client = '', detail = {} }) {
  const id = auditStore.record({ action, target, result, message, client, detail });
  const line = `[audit] ${action} target=${target || '-'} result=${result}${message ? ' msg=' + message : ''}`;
  if (result === 'ok') console.log(line); else console.error(line);
  return id;
}

// 客户端标识：网关会注入 X-Trim-Userid（fnOS 登录用户），socket 请求没有对端 IP
function clientOf(req) {
  const uid = req.headers['x-trim-userid'] || req.headers['x-trim-uid'];
  const addr = req.socket?.remoteAddress || 'unix-socket';
  return uid ? `uid:${uid}` : addr;
}

function appendHistory() {
  const row = {
    ts: Date.now(),
    cpu: state.cpu.totalPct,
    mem: state.mem.usedPct,
    swap: state.swap.usedPct,
    load1: state.load[0],
    rd: state.io.readBps,
    wr: state.io.writeBps,
    rx: state.net.rxBps,
    tx: state.net.txBps,
  };
  try {
    // 优先写 SQLite：按时间保留 + 分桶查询，不再有整文件重写。
    // 只有库打不开时才回退老的 jsonl（含 8MB 轮转）。
    if (historyStore.enabled) {
      historyStore.append(row);
      return;
    }
    appendFileSync(HISTORY_FILE, JSON.stringify(row) + '\n');
    const size = statSync(HISTORY_FILE).size;
    if (size > HISTORY_MAX_BYTES) {
      const lines = readFileSync(HISTORY_FILE, 'utf8').trim().split('\n');
      writeFileSync(HISTORY_FILE, lines.slice(-HISTORY_KEEP_LINES).join('\n') + '\n');
      console.log(`[history] rotated ${lines.length} → ${HISTORY_KEEP_LINES} 行`);
    }
  } catch (e) {
    // 写盘失败不影响监控主功能
    if (!globalThis.__histWarned) { console.error('[history] 写入失败:', e.message); globalThis.__histWarned = true; }
  }
}

function readHistory(minutes) {
  const since = Date.now() - Math.min(1440, Math.max(1, minutes)) * 60000;
  let lines = [];
  try { lines = readFileSync(HISTORY_FILE, 'utf8').trim().split('\n'); } catch { return []; }
  const out = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (r.ts >= since) out.push(r);
    } catch { /* 跳过坏行 */ }
  }
  // 下采样到 ≤240 点，避免 6/24 小时把前端画花
  if (out.length > 240) {
    const step = Math.ceil(out.length / 240);
    const d = [];
    for (let i = 0; i < out.length; i += step) d.push(out[i]);
    return d;
  }
  return out;
}

const SIGNALS = new Set(['SIGTERM', 'SIGKILL', 'SIGSTOP', 'SIGCONT', 'SIGHUP', 'SIGINT', 'SIGUSR1', 'SIGUSR2']);

// ── systemd 服务 ────────────────────────────────────────────────────────
// systemctl 调用有开销（几十到几百毫秒），所以结果缓存 5 秒；名字进 URL/JSON
// 都要先过白名单，防止把 "ssh.service; rm -rf /" 这种塞进 execFile 的参数。
let unitsCache = { at: 0, list: [] };
// 首字符不允许 - ：否则 "-x.service" 会被 systemctl 当成命令行选项解析
const UNIT_RE = /^[A-Za-z0-9@._:][A-Za-z0-9@._:\\-]*\.service$/;

// 停掉这些会让机器失联或直接瘫痪，禁止 stop/restart（start 允许，用于救回来）
// 关键服务：禁止 stop / restart / 禁用自启。
// 早期只有 10 条通用黑名单，fnOS 自己的登录、存储、docker、备份等服务全不在里面 ——
// 一次误操作就能让整台 NAS 停服，而 disable 之后重启也不会恢复。
const PROTECTED_UNITS = new Set([
  // 通用
  'ssh.service', 'sshd.service', 'dbus.service', 'systemd-logind.service',
  'systemd-journald.service', 'systemd-udevd.service', 'systemd-networkd.service',
  'networking.service', 'NetworkManager.service', 'cron.service',
  'systemd-resolved.service', 'systemd-timesyncd.service', 'polkit.service',
  // fnOS 平台（登录 / 存储 / 应用管理 / docker / 备份）
  'accountsrv.service', 'dockermgr.service', 'docker.service', 'containerd.service',
  'filestor_service.service', 'backup_service.service', 'trim_nginx.service',
  'trim_update.service', 'trim_ws.service', 'trim_connect.service',
  'eventlogger.service', 'downloader.service', 'postgresql.service',
  // 显示相关（NAS 面板依赖）
  'trim_display.service', 'power_manager.service',
]);

// 前缀规则：命中即视为关键服务（覆盖各版本命名差异，避免每加一个服务就要改名单）
const PROTECTED_PREFIXES = ['trim_', 'trim-', 'account', 'dockermgr', 'docker', 'containerd',
  'filestor', 'backup_', 'eventlog', 'systemd-', 'ssh', 'dbus'];

function isProtectedUnit(name) {
  if (PROTECTED_UNITS.has(name)) return true;
  return PROTECTED_PREFIXES.some((p) => name.startsWith(p));
}

// 并发调用共享同一个在途 promise。
// 早期写法是「在途时直接返回缓存」，但首次加载时缓存还是空的 ——
// 页面切到服务页会同时触发两次请求，第二次拿到空数组，表格就一片空白。
let unitsWait = null;

async function listUnits(force = false) {
  // 缓存有效且非空才直接返回：空结果不当作有效缓存
  if (!force && unitsCache.list.length && Date.now() - unitsCache.at < 5000) return unitsCache.list;
  if (unitsWait) return unitsWait;                 // 有人正在拉：一起等同一个结果

  unitsWait = (async () => {
    const list = [];
    try {
      const { stdout } = await execFileP('systemctl',
        ['list-units', '--type=service', '--all', '--no-legend', '--no-pager', '--plain'],
        { timeout: 6000, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      for (const line of String(stdout).split('\n')) {
        const t = line.trim();
        if (!t) continue;
        const f = t.split(/\s+/);
        if (f.length < 4) continue;
        const [name, load, active, sub] = f;
        if (!name.endsWith('.service')) continue;
        const desc = t.slice(t.indexOf(sub, name.length + load.length + active.length) + sub.length).trim();
        list.push({ name, load, active, sub, desc, protected: isProtectedUnit(name), enabledState: '' });
      }
      // 开机自启状态（enabled / disabled / static …）：列表里没有，得单独问一次
      try {
        const uf = await execFileP('systemctl',
          ['list-unit-files', '--type=service', '--no-legend', '--no-pager', '--plain'],
          { timeout: 6000, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
        const map = new Map();
        for (const line of String(uf.stdout || '').split('\n')) {
          const f = line.trim().split(/\s+/);
          if (f.length >= 2 && f[0].endsWith('.service')) map.set(f[0], f[1]);
        }
        for (const u of list) u.enabledState = map.get(u.name) || '';
      } catch { /* 拿不到就留空，不影响列表 */ }
      unitsCache = { at: Date.now(), list };
    } catch {
      /* 非 systemd / 无权限：保留上一次的缓存（宁可显示旧数据，也不清空成「没有服务」） */
      unitsCache = { at: Date.now(), list: unitsCache.list };
    }
    return unitsCache.list;
  })().finally(() => { unitsWait = null; });

  return unitsWait;
}

const SERVICE_ACTIONS = new Set(['start', 'stop', 'restart']);

async function runServiceAction(name, action) {
  // kind 用来区分审计里的分类：rejected = 被规则拦住（没真的执行），error = 执行了但失败
  if (!UNIT_RE.test(name)) return { ok: false, kind: 'rejected', error: '服务名不合法' };
  if (!SERVICE_ACTIONS.has(action)) return { ok: false, kind: 'rejected', error: '不支持的操作：' + action };
  if (isProtectedUnit(name) && action !== 'start') {
    return { ok: false, kind: 'rejected', error: `${name} 属于关键服务，禁止 ${action}（会导致失联或系统不可用）` };
  }
  try {
    await execFileP('systemctl', ['--', action, name], { timeout: 20000, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
    unitsCache.at = 0;   // 让下一次查询重新拉取
    return { ok: true };
  } catch (e) {
    const msg = String(e.stderr || e.message || e).trim().split('\n').slice(0, 2).join(' ');
    return { ok: false, kind: 'error', error: msg.slice(0, 200) || 'systemctl 执行失败' };
  }
}


// ── 路由 ────────────────────────────────────────────────────────────────
const SORTS = Object.assign(Object.create(null), {
  cpu: (a, b) => b.cpuPct - a.cpuPct,
  mem: (a, b) => b.rss - a.rss,
  pid: (a, b) => a.pid - b.pid,
  name: (a, b) => a.name.localeCompare(b.name),
  time: (a, b) => b.cpuTime - a.cpuTime,
  threads: (a, b) => b.threads - a.threads,
  start: (a, b) => b.startMs - a.startMs,
});

// 用 hasOwn 判存在：直接 SORTS[k] 会命中原型链（?sort=__proto__ 把 Object.prototype 当比较器 → 500）
const SORT_KEYS = new Set(['cpu', 'mem', 'pid', 'name', 'time', 'threads', 'start']);

async function handle(req, res, pathname, query) {
  res.__req = req;                        // sendJSON 需要看 Accept-Encoding 决定是否 gzip
  if (pathname.startsWith('/api/')) lastApiHit = Date.now();

  // ── SSE：实时快照 ──
  if (pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',        // fnOS 网关是 nginx：不加这个会缓冲住 SSE
    });
    res.write('retry: 3000\n');
    res.write(': connected\n\n');
    res.write(`data: ${JSON.stringify(sseSnapshot())}\n\n`);
    if (clients.size >= 64) {            // 单机管理界面，64 个并发流已经远超正常用量
      sendJSON(res, 429, { error: '实时连接过多，请稍后再试' });
      return;
    }
    clients.add(res);
    const keep = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* 忽略 */ } }, 25000);
    req.on('close', () => { clearInterval(keep); clients.delete(res); });
    return;
  }

  if (pathname === '/api/overview') {
    ensureFreshProcs();                   // 与 /api/processes 一致：最多陈旧 1.2 秒
    sendJSON(res, 200, {
      ...snapshot(10),
        core: state.cpu.cores,
        host: { name: HOST_NAME, kernel: readOr('/proc/sys/kernel/osrelease').trim() },
        psi: { cpu: psi.cpu, mem: psi.mem, io: psi.io, at: psi.at },
        volumes: volumes.list,
        alerts: alertEngine.snapshot(),
    });
    return;
  }

  if (pathname === '/api/processes') {
    ensureFreshProcs();                   // 空闲期按 5 秒扫，这里按需补一次到 1.2 秒内
    const q = String(query.get('q') || '').toLowerCase().trim();
    const sortKey = SORT_KEYS.has(String(query.get('sort') || '')) ? String(query.get('sort')) : 'cpu';
    const limit = Math.min(2000, Math.max(1, num(query.get('limit')) || 500));
    const cFilter = String(query.get('container') || '').trim();
    let rows = procs;
    if (q) {
      rows = rows.filter((p) => p.name.toLowerCase().includes(q)
        || p.cmd.toLowerCase().includes(q)
        || String(p.pid) === q
        || p.user.toLowerCase().includes(q));
    }
    if (cFilter) {
      rows = rows.filter((p) => p.container
        && (p.container.id === cFilter || p.container.name === cFilter));
    }
    rows = [...rows].sort(SORTS[sortKey]).slice(0, limit);
    sendJSON(res, 200, { ts: state.ts, total: procs.length, shown: rows.length, sort: sortKey, rows });
    return;
  }

  // 监听端口视图：把 inode→port 的结果反查成 pid，再补进程名/用户/容器
  if (pathname === '/api/ports') {
    // 端口数据是 10 秒后台刷新的，刚切过来可能偏旧：超过 5 秒就后台补一次
    // 端口归属只在「进程集合变化」或「距上次采集超过 30 秒」时重算。
    // 每次重算要 fork 一个 ss 进程（约 20~40ms CPU），而端口归属其实只在
    // 服务启停时变 —— 每秒/每 5 秒跑一遍纯属浪费。
    // 新 PID 出现时立即重算，保证「刚起的服务」马上能看到它监听的端口。
    if (portsNeedRefresh()) { refreshPorts().catch(() => {}); }
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    const out = [];
    for (const [pid, list] of pidPorts) {
      const p = byPid.get(pid);
      for (const s of list) {
        out.push({
          port: s.port, proto: s.proto, addr: s.addr,
          pid, name: p?.name || '?', user: p?.user || '?',
          cmd: p?.cmd ? p.cmd.slice(0, 120) : '',
          container: p?.container || null,
        });
      }
    }
    out.sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto));
    sendJSON(res, 200, { ts: state.ts, total: out.length, ports: out });
    return;
  }

  // 容器维度聚合：进程数 / CPU / 内存（按容器名归堆，非容器进程单独一档 null）
  if (pathname === '/api/containers') {
    // 首次打开时 docker ps 可能还没跑过（它按活跃度节流），这里补一次，
    // 否则容器名会显示成 12 位短 ID
    if (!dockerNames.size) await refreshDocker();
    const map = new Map();
    for (const p of procs) {
      if (!p.container) continue;
      const key = p.container.name || p.container.id;
      const cur = map.get(key) || { id: p.container.id, name: key, procs: 0, cpuPct: 0, rss: 0, threads: 0 };
      cur.procs += 1;
      cur.cpuPct = r1(cur.cpuPct + p.cpuPct);
      cur.rss += p.rss;
      cur.threads += p.threads;
      map.set(key, cur);
    }
    const list = [...map.values()].sort((a, b) => b.rss - a.rss);
    sendJSON(res, 200, {
      ts: state.ts,
      dockerAvailable: dockerNames.size > 0,
      total: list.length,
      containers: list,
    });
    return;
  }

  const detail = pathname.match(/^\/api\/process\/(\d+)$/);
  if (detail) {
    ensureFreshProcs();
    const pid = num(detail[1]);
    const base = procs.find((p) => p.pid === pid);
    if (!base) { sendJSON(res, 404, { error: '进程不存在或已退出' }); return; }
    const io = procIo(pid, true);
    let exe = '', cwd = '', fds = 0, envCount = 0, oom = 0, vmSwap = 0, vmPeak = 0;
    // 注意：/proc/<pid>/exe 是符号链接，必须用 readlinkSync 取目标路径。
    // 早期写成 readFileSync(exe) 会真的把整个可执行文件读进内存 —— 查自己的
    // node 进程时等于同步读 ~100MB 二进制，事件循环直接卡死（表现为接口超时、
    // 连 /api/health 都不响应）。
    try { exe = readlinkSync(`/proc/${pid}/exe`); } catch { /* 无权限或已退出 */ }
    try { cwd = readlinkSync(`/proc/${pid}/cwd`); } catch { /* 无权限或已退出 */ }
    try { fds = readdirSync(`/proc/${pid}/fd`).length; } catch { /* 无权限 */ }
    try {
      const envRaw = readOr(`/proc/${pid}/environ`);
      envCount = envRaw ? envRaw.split('\0').filter(Boolean).length : 0;
    } catch { /* 无权限 */ }
    for (const line of readOr(`/proc/${pid}/status`).split('\n')) {
      if (line.startsWith('VmSwap:')) vmSwap = num(line.split(/\s+/)[1]) * 1024;
      if (line.startsWith('VmPeak:')) vmPeak = num(line.split(/\s+/)[1]) * 1024;
    }
    try { oom = num(readOr(`/proc/${pid}/oom_score`).trim()); } catch { /* 忽略 */ }
    let statm = {};
    try {
      const f = readOr(`/proc/${pid}/statm`).split(/\s+/).map(num);
      statm = { size: f[0] * PAGE, resident: f[1] * PAGE, shared: f[2] * PAGE };
    } catch { /* 忽略 */ }

    // ── 深度信息（PSS/USS、cgroup、线程、父链、环境变量、句柄上限）────────
    // 这些读取得多花几毫秒，所以只在打开详情时算，不参与 1 秒采样。
    const smaps = readSmaps(pid);
    const cgroup = readCgroupMem(pid);
    const threads = readThreads(pid);
    const parents = readParentChain(pid);
    const env = readEnvPairs(pid);
    const fdLimit = readFdLimit(pid);
    let oomAdj = 0;
    try { oomAdj = num(readOr(`/proc/${pid}/oom_score_adj`).trim()); } catch { /* 忽略 */ }
    const levels = descendantsOf(pid);
    const descPids = levels.flat();

    sendJSON(res, 200, {
      ...base, exe, cwd, fds, envCount, oom, vmSwap, vmPeak, statm,
      cmd: procCmdline(pid, true),
      io: { read: io.read, write: io.write },
      children: procs.filter((p) => p.ppid === pid).map((p) => ({ pid: p.pid, name: p.name })),
      // 新增：内存细分（PSS 才是「真实占用」，RSS 会把共享内存重复计）
      smaps,
      // 新增：cgroup 及其内存额度（current/high/max/peak），max 表示不限
      cgroup,
      // 新增：线程列表（限 40 条，超过用 truncated 标记）
      threads,
      // 新增：父进程链（由近到远）
      parents,
      // 新增：环境变量（敏感 key 已打码）
      env,
      fdLimit,
      oomAdj,
      // 新增：整棵子树的进程数与 pid 列表（供「结束整棵子树」用）
      descendantCount: descPids.length,
      descendants: descPids.slice(0, 200),
    });
    return;
  }

  if (pathname === '/api/kill' && req.method === 'POST') {
    const body = await readBody(req, res);
    if (!body) return;

    // ── 批量处置 ─────────────────────────────────────────────────────────
    // 排查时经常要一次处理一组进程（比如十几个 python worker）。批量本身
    // 是危险动作，所以约束比单条更紧：上限 50 个、不支持 tree、逐个走完整
    // 校验、逐个记审计，任何一条被拦都不影响其它条。
    if (Array.isArray(body.pids)) {
      const client = clientOf(req);
      const sig = String(body.signal || 'SIGTERM').toUpperCase();
      const raw = body.pids.map((x) => num(x)).filter((x) => x > 0);
      const uniq = [...new Set(raw)];
      const guard = (msg) => {
        auditRecord({
          action: 'kill.batch', target: `n=${raw.length}`, result: 'rejected',
          message: msg, client, detail: { pids: uniq.slice(0, 50), signal: sig },
        });
        sendJSON(res, 400, { error: msg });
      };
      if (body.tree === true) return guard('批量处置不支持 tree，请逐个结束子树');
      if (!uniq.length) return guard('缺少 pids');
      if (uniq.length > 50) return guard(`拒绝：一次最多 50 个进程（当前 ${uniq.length} 个）`);
      if (!SIGNALS.has(sig)) return guard(`拒绝：不支持的信号 ${sig}`);
      if (body.confirm !== true) return guard('需要 confirm: true 才会执行');

      const results = [];
      let okCount = 0;
      for (const p of uniq) {
        const info = procs.find((x) => x.pid === p);
        const nm = info?.name || '?';
        if (p <= 1) { results.push({ pid: p, ok: false, error: '受保护：PID ≤ 1', name: nm }); continue; }
        if (p === process.pid) { results.push({ pid: p, ok: false, error: '受保护：不能结束自身', name: nm }); continue; }
        try {
          process.kill(p, sig);
          okCount += 1;
          results.push({ pid: p, ok: true, name: nm });
        } catch (e) {
          results.push({ pid: p, ok: false, error: e.code === 'ESRCH' ? '进程不存在' : (e.code === 'EPERM' ? '权限不足' : e.message), name: nm });
        }
      }
      const failed = results.filter((r) => !r.ok);
      const id = auditRecord({
        action: 'kill.batch', target: `${uniq.length} 个进程`, result: failed.length ? 'partial' : 'ok',
        message: `${sig}：成功 ${okCount} · 失败 ${failed.length}`,
        client, detail: { signal: sig, results: results.slice(0, 50) },
      });
      sendJSON(res, 200, { success: true, id, at: new Date().toISOString(), signal: sig, total: uniq.length, okCount, failed: failed.length, results });
      return;
    }

    const pid = num(body.pid);
    const sig = String(body.signal || 'SIGTERM').toUpperCase();
    const client = clientOf(req);
    const target = procs.find((p) => p.pid === pid);
    const tName = target?.name || '?';
    const tUser = target?.user || '?';
    const detail = { pid, signal: sig, name: tName, user: tUser };
    // 拒绝也要记 —— 审计的价值一半在于「谁试图做了什么但被拦了」
    const reject = (msg) => {
      auditRecord({ action: 'kill', target: String(pid), result: 'rejected', message: msg, client, detail });
      sendJSON(res, 400, { error: msg });
    };
    if (!pid || pid <= 1) return reject('拒绝：PID 必须 > 1（不能动 init）');
    if (pid === process.pid) return reject('拒绝：不能结束进程管家自身');
    if (!SIGNALS.has(sig)) return reject(`拒绝：不支持的信号 ${sig}`);
    if (body.confirm !== true) return reject('需要 confirm: true 才会执行');

    // ── 结束整棵子树 ──────────────────────────────────────────────────────
    // 顺序很关键：必须「先子后父」。反过来的话父进程先死，子进程被 init 收养、
    // ppid 变成 1，这一轮就再也找不到它们了 —— 表现为「杀了个 node，还剩几个
    // worker 在跑」。所以按层深倒序发送，最后才动目标进程本身。
    if (body.tree === true) {
      const levels = descendantsOf(pid);
      const descCount = levels.reduce((s, l) => s + l.length, 0);
      if (descCount > 500) return reject(`拒绝：子树过大（${descCount} 个进程），超过 500 上限`);
      const targets = [];
      for (let i = levels.length - 1; i >= 0; i -= 1) targets.push(...levels[i]);
      targets.push(pid);
      const killed = [];
      const gone = [];
      const failed = [];
      for (const t of targets) {
        if (t <= 1 || t === process.pid) { failed.push({ pid: t, error: '受保护，跳过' }); continue; }
        try { process.kill(t, sig); killed.push(t); } catch (e) {
          if (e.code === 'ESRCH') gone.push(t);
          else failed.push({ pid: t, error: e.code || e.message });
        }
      }
      const okCount = killed.length + gone.length;
      const ok = okCount > 0 && failed.length === 0;
      const msg = `${sig} 子树 ${okCount}/${targets.length}${failed.length ? ` 失败 ${failed.length}` : ''}`;
      const id = auditRecord({
        action: 'kill', target: String(pid), result: ok ? 'ok' : 'error', message: msg, client,
        detail: { ...detail, tree: true, count: targets.length, killed, gone, failed: failed.slice(0, 20) },
      });
      sendJSON(res, ok ? 200 : 400, {
        success: ok, id, at: new Date().toISOString(), pid, signal: sig,
        name: tName, user: tUser, ok, tree: true,
        count: targets.length, killed: killed.length, gone: gone.length, failed,
        error: ok ? undefined : (failed[0]?.error || '子树内没有进程被结束'),
      });
      return;
    }

    try {
      process.kill(pid, sig);
      const id = auditRecord({ action: 'kill', target: String(pid), result: 'ok', message: `${sig} ${tName}`, client, detail });
      sendJSON(res, 200, { success: true, id, at: new Date().toISOString(), pid, signal: sig, name: tName, user: tUser, ok: true });
    } catch (e) {
      const msg = e.code === 'EPERM' ? '权限不足（EPERM）' : (e.code === 'ESRCH' ? '进程不存在（ESRCH）' : e.message);
      const id = auditRecord({ action: 'kill', target: String(pid), result: 'error', message: msg, client, detail });
      sendJSON(res, 400, { success: false, id, at: new Date().toISOString(), pid, signal: sig, name: tName, user: tUser, ok: false, error: msg });
    }
    return;
  }

  if (pathname === '/api/history') {
    // 1 小时 / 6 小时 / 24 小时 / 7 天：SQLite 分桶聚合，返回点数恒定 ≤240
    const minutes = Math.max(1, Math.min(60 * 24 * 31, num(query.get('minutes')) || 60));
    if (historyStore.enabled) {
      const points = Math.min(600, Math.max(60, num(query.get('points')) || 240));
      const q = historyStore.query(minutes, points);
      // 把这段时间内的审计事件一并带上：曲线上标出「那一刻谁动过什么」，
      // 内存暴涨的时间点就能直接对上是重启了服务还是杀了进程
      const since = Date.now() - minutes * 60000;
      const acts = auditStore.enabled
        ? auditStore.list({ limit: 200, since, action: '', result: '' }).rows
          .filter((e) => /^(kill|service\.|app\.|tune)/.test(String(e.action || '')))
          .map((e) => ({ ts: e.ts, action: e.action, target: e.target, result: e.result, message: e.message }))
        : [];
      sendJSON(res, 200, {
        ts: Date.now(), minutes, count: q.rows.length, bucket: q.bucket,
        source: q.source, file: HISTORY_DB, rows: q.rows, health: historyStore.health(),
        events: acts,
      });
      return;
    }
    const rows = readHistory(minutes);
    sendJSON(res, 200, {
      ts: Date.now(), minutes, count: rows.length, bucket: 30,
      source: 'jsonl', file: HISTORY_FILE, rows,
    });
    return;
  }

  if (pathname === '/api/services') {
    const q = String(query.get('q') || '').toLowerCase().trim();
    const state = String(query.get('state') || '').trim();
    let list = await listUnits();
    if (q) list = list.filter((u) => u.name.toLowerCase().includes(q) || u.desc.toLowerCase().includes(q));
    if (state === 'running') list = list.filter((u) => u.active === 'active');
    else if (state === 'stopped') list = list.filter((u) => u.active !== 'active');
    else if (state === 'failed') list = list.filter((u) => u.active === 'failed' || u.sub === 'failed');
    const counts = { all: unitsCache.list.length, running: 0, failed: 0 };
    for (const u of unitsCache.list) {
      if (u.active === 'active') counts.running += 1;
      if (u.active === 'failed' || u.sub === 'failed') counts.failed += 1;
    }
    // 关注的服务置顶：日常只盯那 5～10 个，239 个平铺时是被噪音淹掉的
    const pinnedSet = new Set(alertStore.listPinned());
    for (const u of list) u.pinned = pinnedSet.has(u.name);
    list.sort((a, b) => (Number(b.pinned) - Number(a.pinned))
      || a.name.localeCompare(b.name));
    sendJSON(res, 200, {
      ts: state.ts, total: list.length, counts, pinnedCount: pinnedSet.size,
      units: list.slice(0, 400),
    });
    return;
    }

    // ── 进程追踪：只记录出现/消失，不执行任何命令 ────────────────────────
    if (pathname === '/api/alerts/presets') {
      // 规则模板：告警判据要填 metric/op/阈值/持续时长/冷却，手填容易填错方向
      // （把「低于」填成「高于」这种）。给几个开箱可用的预设，点一下就落到表单里。
      sendJSON(res, 200, {
        presets: [
          {
            key: 'cpu-sustained', name: 'CPU 持续过高', metric: 'cpu', op: '>', threshold: 90,
            durationSec: 180, cooldownSec: 900, level: 1,
            desc: 'CPU 连续 3 分钟超过 90% 才提醒，避免瞬时尖峰刷屏',
          },
          {
            key: 'mem-high', name: '内存使用率过高', metric: 'mem', op: '>', threshold: 90,
            durationSec: 300, cooldownSec: 900, level: 1,
            desc: '内存连续 5 分钟超过 90%',
          },
          {
            key: 'swap-storm', name: 'Swap 使用率过高', metric: 'swap', op: '>', threshold: 50,
            durationSec: 600, cooldownSec: 1800, level: 1,
            desc: 'Swap 过半通常意味着内存不够，机器会明显卡',
          },
          {
            key: 'disk-low', name: '磁盘空间不足', metric: 'disk', op: '>', threshold: 90,
            durationSec: 600, cooldownSec: 3600, level: 2, needTarget: true,
            desc: '指定挂载点使用率超过 90%（也就是可用不到一成）。磁盘满会让应用写日志失败、进程直接崩 —— 要盯多个卷就加多条',
          },
          {
            key: 'oom', name: '发生 OOM 杀进程', metric: 'oom', op: '>', threshold: 0,
            durationSec: 0, cooldownSec: 3600, level: 2,
            desc: '内核因内存不足杀掉了进程，立即告警',
          },
          {
            key: 'psi-mem', name: '内存压力过高', metric: 'psi_mem', op: '>', threshold: 10,
            durationSec: 180, cooldownSec: 900, level: 1,
            desc: '进程因内存不足开始排队等待（比「内存占用率」更早反映卡顿）',
          },
        ],
      });
      return;
    }

    if (pathname === '/api/watches') {
      if (req.method === 'GET') {
        sendJSON(res, 200, {
          watches: alertStore.listWatches(),
          events: alertStore.listWatchEvents({ limit: Math.min(200, num(query.get('limit')) || 50) }).rows,
          storeEnabled: alertStore.enabled,
        });
        return;
      }
      const body = await readBody(req, res);
      if (!body) return;
      const input = { id: num(body.id) || 0, name: body.name, pattern: body.pattern };
      if (typeof body.enabled === 'boolean') input.enabled = body.enabled;
      const r2 = alertStore.saveWatch(input);
      if (!r2.ok) { sendJSON(res, 400, { error: r2.error }); return; }
      auditRecord({
        action: input.id ? 'watch.update' : 'watch.add', target: String(input.name || '').slice(0, 120),
        result: 'ok', message: `追踪关键字：${String(input.pattern || '').slice(0, 120)}`, client: clientOf(req),
      });
      sendJSON(res, 200, { ok: true, id: r2.id, watches: alertStore.listWatches() });
      return;
    }

    if (pathname === '/api/watches/delete' && req.method === 'POST') {
      const body = await readBody(req, res);
      if (!body) return;
      const id = num(body.id) || 0;
      if (!id) { sendJSON(res, 400, { error: '缺少 id' }); return; }
      if (body.confirm !== true) { sendJSON(res, 400, { error: '需要 confirm: true' }); return; }
      alertStore.deleteWatch(id);
      auditRecord({ action: 'watch.delete', target: `watch:${id}`, result: 'ok', message: '删除进程追踪', client: clientOf(req) });
      sendJSON(res, 200, { ok: true, watches: alertStore.listWatches() });
      return;
    }

    if (pathname === '/api/watches/events') {
      const r3 = alertStore.listWatchEvents({
        limit: Math.min(500, num(query.get('limit')) || 100),
        watchId: num(query.get('watchId')) || 0,
      });
      sendJSON(res, 200, { ts: Date.now(), total: r3.total, rows: r3.rows });
      return;
    }

    if (pathname === '/api/service/pin' && req.method === 'POST') {
    const body = await readBody(req, res);
    if (!body) return;
    const name = String(body.name || '').trim();
    const want = body.pinned === true || body.pinned === 'true' || body.pinned === 1;
    if (!UNIT_RE.test(name)) { sendJSON(res, 400, { error: '服务名不合法' }); return; }
    const r = alertStore.setPinned(name, want);
    if (!r.ok) { sendJSON(res, 500, { error: r.error || '保存失败' }); return; }
    auditRecord({
      action: want ? 'service.pin' : 'service.unpin', target: name, result: 'ok',
      message: want ? '加入关注' : '取消关注', client: clientOf(req),
    });
    sendJSON(res, 200, { ok: true, name, pinned: r.pinned });
    return;
    }

  if (pathname === '/api/service' && req.method === 'POST') {
    const body = await readBody(req, res);
    if (!body) return;
    const name = String(body.name || '').trim();
    const action = String(body.action || '').trim();
    const client = clientOf(req);
    const tag = 'service.' + (action || 'unknown');
    if (body.confirm !== true) {
      auditRecord({ action: tag, target: name, result: 'rejected', message: '需要 confirm: true 才会执行', client });
      sendJSON(res, 400, { error: '需要 confirm: true 才会执行' });
      return;
    }
    const r = await runServiceAction(name, action);
    if (!r.ok) {
      const id = auditRecord({ action: tag, target: name, result: r.kind || 'error', message: r.error, client });
      sendJSON(res, 400, { error: r.error, id });
      return;
    }
    const id = auditRecord({ action: tag, target: name, result: 'ok', message: `${action} ${name}`, client });
    sendJSON(res, 200, { success: true, id, name, action });
    return;
  }

  // ── 审计重放 ────────────────────────────────────────────────────────────
  // 只放行「服务启停」这一类幂等动作。
  // 为什么不做通用重放：重放一条 kill 就是真的再杀一次进程，重放一条
  // service.enable 会改开机自启状态 —— 这些都需要人在现场判断「现在还是不是
  // 当时那个情况」。启停是显式、可逆、且不改变持久配置的，重放才有意义。
  if (pathname === '/api/audit/replay' && req.method === 'POST') {
    const body = await readBody(req, res);
    if (!body) return;
    const client = clientOf(req);
    const row = auditStore.getById(body.id);
    if (!row) {
      sendJSON(res, 404, { error: '找不到这条审计记录' });
      return;
    }
    const REPLAYABLE = new Set(['service.start', 'service.stop', 'service.restart']);
    if (!REPLAYABLE.has(String(row.action))) {
      auditRecord({
        action: 'service.replay', target: String(row.target || ''), result: 'rejected',
        message: `不允许重放 ${row.action}（只支持服务启停）`, client,
      });
      sendJSON(res, 400, {
        error: `只支持重放服务启动 / 停止 / 重启；「${row.action}」不提供重放`,
        replayable: [...REPLAYABLE],
      });
      return;
    }
    if (String(row.result) !== 'ok') {
      sendJSON(res, 400, { error: '只能重放当时执行成功的操作' });
      return;
    }
    const act = String(row.action).slice('service.'.length);
    const name = String(row.target || '');
    const rr = await runServiceAction(name, act);
    if (!rr.ok) {
      const id = auditRecord({
        action: 'service.replay', target: name, result: rr.kind || 'error',
        message: `重放 #${row.id} 的 ${act} 失败: ${rr.error}`, client,
      });
      sendJSON(res, 400, { error: rr.error, id });
      return;
    }
    const id = auditRecord({
      action: 'service.replay', target: name, result: 'ok',
      message: `重放 #${row.id} 的 ${row.action}`, client,
    });
    sendJSON(res, 200, { success: true, id, name, action: act, replayed: row.id });
    return;
  }

  // ── 告警：规则与事件 ────────────────────────────────────────────────────
  if (pathname === '/api/alerts' && req.method === 'GET') {
    sendJSON(res, 200, {
      rules: alertStore.listRules(),
      stats: alertStore.stats(),
      health: alertStore.health(),
      metrics: METRICS,
      levels: LEVEL_LABEL,
      live: alertEngine.snapshot(),          // 当前各规则的实测值与是否正在违规
      lastEvalAt: alertEngine.lastEvalAt(),
    });
    return;
  }

  if (pathname === '/api/alerts' && req.method === 'POST') {
    const body = await readBody(req, res);
    if (!body) return;
    if (body.webhook) {
      const blocked = await webhookBlockReason(body.webhook);
      if (blocked) {
        auditRecord({ action: 'alert.save', target: String(body.id || 0), result: 'rejected', message: blocked, client: clientOf(req) });
        sendJSON(res, 400, { error: blocked });
        return;
      }
    }
    const r = alertStore.saveRule(body);
    if (!r.ok) { sendJSON(res, 400, { error: r.error }); return; }
    auditRecord({ action: 'alert.save', target: String(r.id), result: 'ok', message: `${body.id ? '更新' : '新建'}规则 ${body.name || ''}`, client: clientOf(req) });
    sendJSON(res, 200, { success: true, id: r.id });
    return;
  }

  if (pathname === '/api/alerts/delete' && req.method === 'POST') {
    const body = await readBody(req, res);
    if (!body) return;
    if (body.confirm !== true) { sendJSON(res, 400, { error: '需要 confirm: true' }); return; }
    const id = num(body.id);
    const r = alertStore.deleteRule(id);
    if (!r.ok) { sendJSON(res, 400, { error: r.error }); return; }
    auditRecord({ action: 'alert.delete', target: String(id), result: 'ok', message: `删除规则 #${id}`, client: clientOf(req) });
    sendJSON(res, 200, { success: true, removed: r.removed });
    return;
  }

  if (pathname === '/api/alerts/events') {
    const limit = Math.min(1000, Math.max(1, num(query.get('limit')) || 100));
    const offset = Math.max(0, num(query.get('offset')) || 0);
    const level = query.get('level') == null ? '' : String(query.get('level'));
    const ruleId = num(query.get('ruleId')) || 0;
    sendJSON(res, 200, { ...alertStore.listEvents({ limit, offset, level, ruleId }), limit, offset });
    return;
  }

  // 发一条测试通知（不写 last_fired、不影响冷却）
  if (pathname === '/api/alerts/test' && req.method === 'POST') {
    const body = await readBody(req, res);
    if (!body) return;
    if (Date.now() - lastAlertTestAt < 3000) {
      sendJSON(res, 429, { error: '测试通知过于频繁，请 3 秒后再试' });
      return;
    }
    lastAlertTestAt = Date.now();
    const id = num(body.id);
    let rule = alertStore.listRules().find((x) => x.id === id);
    if (!rule && body.rule) rule = { ...body.rule, id: 0, lastFired: 0 };
    if (!rule) { sendJSON(res, 404, { error: '规则不存在' }); return; }
    const out = await alertEngine.test(rule, Number(body.value) || 0);
    auditRecord({
      action: 'alert.test', target: String(rule.id || 0), result: 'ok',
      message: `测试告警 ${rule.name}`, client: clientOf(req),
      detail: { delivered: out.delivered },
    });
    sendJSON(res, 200, { success: true, ...out });
    return;
  }

  // ── journal 日志 ────────────────────────────────────────────────────────
  // 看服务为什么 failed 必须能看到它的日志，不能逼用户去 SSH 敲 journalctl。
  if (pathname === '/api/journal') {
    const unit = String(query.get('unit') || '').trim();
    const lines = Math.min(1000, Math.max(10, num(query.get('lines')) || 200));
    const prio = String(query.get('priority') || '').trim();
    const grep = String(query.get('q') || '').trim().slice(0, 80);
    if (unit && !UNIT_RE.test(unit)) { sendJSON(res, 400, { error: '单元名不合法' }); return; }
    const args = ['--no-pager', '--utc', '-o', 'short-iso'];
    if (unit) args.push('-u', unit);
    if (/^[0-7]$/.test(prio)) args.push('-p', prio);
    // journalctl --grep 走 PCRE2：用户输入 (a+)+$ 这类模式能让它烧满 CPU 到超时。
    // 把元字符转义成字面量，功能上「搜关键字」仍然满足，风险归零。
    if (grep) args.push('--grep', grep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    args.push('-n', String(lines));
    try {
      const { stdout } = await execFileP('journalctl', args, { timeout: 8000, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      const text = String(stdout || '');
      const rows = text.split('\n').filter(Boolean).slice(-lines);
      sendJSON(res, 200, { unit: unit || null, count: rows.length, lines: rows });
    } catch (e) {
      sendJSON(res, 500, { error: String(e.stderr || e.message || e).trim().split('\n')[0].slice(0, 200) });
    }
    return;
  }

  // ── systemd 定时器 ──────────────────────────────────────────────────────
  if (pathname === '/api/timers') {
    try {
      const { stdout } = await execFileP('systemctl',
        ['list-timers', '--all', '--no-pager', '--plain', '--no-legend'],
        { timeout: 6000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
      const timers = [];
      for (const line of String(stdout || '').split('\n')) {
        const t = line.trim();
        if (!t) continue;
        // 形如：Mon 2026-11-10 04:00:00 CST  11h left  Sun ...  hermes.timer  hermes.service
        const m = t.match(/([A-Za-z0-9@._:\\-]+\.timer)\s+([A-Za-z0-9@._:\\-]+\.(?:service|target))?\s*$/);
        if (!m) continue;
        timers.push({ raw: t, name: m[1], activates: m[2] || '' });
      }
      sendJSON(res, 200, { count: timers.length, timers });
    } catch (e) {
      sendJSON(res, 500, { error: String(e.stderr || e.message || e).trim().split('\n')[0].slice(0, 200) });
    }
    return;
  }

  // 启用 / 禁用开机自启（与 start/stop 分开：这是改配置，不是改运行状态）
  if (pathname === '/api/service/enable' && req.method === 'POST') {
    const body = await readBody(req, res);
    if (!body) return;
    const name = String(body.name || '').trim();
    const enable = body.enable !== false;
    const client = clientOf(req);
    const tag = enable ? 'service.enable' : 'service.disable';
    const reject = (msg) => {
      auditRecord({ action: tag, target: name, result: 'rejected', message: msg, client });
      sendJSON(res, 400, { error: msg });
    };
    if (!UNIT_RE.test(name)) return reject('服务名不合法');
    if (!enable && isProtectedUnit(name)) return reject(`${name} 属于关键服务，禁止禁用（会导致失联或系统不可用）`);
    if (body.confirm !== true) return reject('需要 confirm: true 才会执行');
    try {
      await execFileP('systemctl', ['--', enable ? 'enable' : 'disable', name],
        { timeout: 20000, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
      unitsCache.at = 0;
      auditRecord({ action: tag, target: name, result: 'ok', message: `${enable ? '启用' : '禁用'} ${name}`, client });
      sendJSON(res, 200, { success: true, name, enable });
    } catch (e) {
      const msg = String(e.stderr || e.message || e).trim().split('\n').slice(0, 2).join(' ').slice(0, 200);
      auditRecord({ action: tag, target: name, result: 'error', message: msg || 'systemctl 执行失败', client });
      sendJSON(res, 400, { error: msg || 'systemctl 执行失败' });
    }
    return;
  }

  // ── 全部网络连接（不只是监听）────────────────────────────────────────────
  if (pathname === '/api/users') {
    // 按 UID 聚合：多用户 NAS 上「谁在吃资源」比「哪个进程在吃」更有意义
    ensureFreshProcs();
    const q = String(query.get('q') || '').toLowerCase().trim();
    const cFilter = String(query.get('container') || '').toLowerCase().trim();
    const pool = procs.filter((p) => {
      if (cFilter && String((p.container && p.container.name) || '').toLowerCase() !== cFilter) return false;
      if (!q) return true;
      return String(p.name || '').toLowerCase().includes(q)
        || String(p.cmd || '').toLowerCase().includes(q)
        || String(p.user || '').toLowerCase().includes(q)
        || String(p.pid) === q;
    });
    const byUser = new Map();
    for (const p of pool) {
      const key = p.user || '?';
      let u = byUser.get(key);
      if (!u) {
        u = { user: key, uid: p.uid ?? null, procs: 0, cpuPct: 0, rss: 0, threads: 0, top: [] };
        byUser.set(key, u);
      }
      u.procs += 1;
      u.cpuPct += Number(p.cpuPct) || 0;
      u.rss += Number(p.rss) || 0;
      u.threads += Number(p.threads) || 0;
      if (u.top.length < 5) u.top.push({ pid: p.pid, name: p.name, cpuPct: p.cpuPct, rss: p.rss });
    }
    const rows = [...byUser.values()].map((u) => ({
      ...u,
      cpuPct: r1(u.cpuPct),
      top: u.top.sort((a, b) => (b.cpuPct - a.cpuPct) || (b.rss - a.rss)).slice(0, 5),
    })).sort((a, b) => (b.cpuPct - a.cpuPct) || (b.rss - a.rss));
    sendJSON(res, 200, { ts: Date.now(), total: rows.length, rows });
    return;
  }

  if (pathname === '/api/io') {
    // 磁盘 IO 排行：读 /proc/<pid>/io（每进程一个文件，400 个进程约 20ms）
    ensureFreshProcs();
    const rows = [];
    for (const p of procs) {
      // procIo() 自带 5 秒缓存，字段是 {read, write}（来自 read_bytes / write_bytes，
      // 也就是真正落到磁盘的字节数，不是含页缓存的 rchar/wchar）
      const io = procIo(p.pid);
      if (!io) continue;
      const rd = Number(io.read) || 0;
      const wr = Number(io.write) || 0;
      if (!rd && !wr) continue;
      rows.push({ pid: p.pid, name: p.name, user: p.user, container: p.container ? p.container.name : '', rd, wr, total: rd + wr });
    }
    rows.sort((a, b) => b.total - a.total);
    sendJSON(res, 200, { ts: Date.now(), total: rows.length, rows: rows.slice(0, 30) });
    return;
  }

  if (pathname === '/api/connections') {
    const stateFilter = String(query.get('state') || '').trim().toUpperCase();
    const pidFilter = num(query.get('pid')) || 0;
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    const out = [];
    for (const [pid, list] of allConns) {
      if (pidFilter && pid !== pidFilter) continue;
      const p = byPid.get(pid);
      for (const c of list) {
        if (stateFilter && c.state !== stateFilter) continue;
        out.push({
          ...c, pid,
          name: p?.name || '?',
          user: p?.user || '?',
          cmd: p?.cmd ? p.cmd.slice(0, 120) : '',
          container: p?.container || null,
        });
      }
    }
    // 监听排前面，其余按端口
    out.sort((a, b) => (a.state === 'LISTEN' ? 0 : 1) - (b.state === 'LISTEN' ? 0 : 1) || a.port - b.port);
    const counts = {};
    for (const c of out) counts[c.state] = (counts[c.state] || 0) + 1;
    sendJSON(res, 200, { ts: state.ts, total: out.length, counts, degraded: allConnsDegraded, conns: out.slice(0, 2000) });
    return;
  }

  // ── 容器资源（一次 docker stats 覆盖全部容器）────────────────────────────
  if (pathname === '/api/container/stats') {
    const now = Date.now();
    if (now - containerStats.at > 10000) {
      // 并发请求共用同一次 docker stats：之前没有在途保护，N 个请求会拉起 N 个子进程
      if (!statsWait) {
        statsWait = (async () => {
          try {
            const { stdout } = await execFileP('docker',
              ['stats', '--no-stream', '--format', '{{json .}}'],
              { timeout: 8000, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
            const map = new Map();
            for (const line of String(stdout || '').split('\n')) {
              const t = line.trim();
              if (!t) continue;
              try {
                const o = JSON.parse(t);
                map.set(o.Name, {
                  name: o.Name,
                  cpuPct: o.CPUPerc || '',
                  memUsage: o.MemUsage || '',
                  memPct: o.MemPerc || '',
                  netIO: o.NetIO || '',
                  blockIO: o.BlockIO || '',
                  pids: o.PIDs || '',
                });
              } catch { /* 跳过坏行 */ }
            }
            containerStats = { at: Date.now(), map, error: '' };
          } catch (e) {
            containerStats = {
              at: Date.now(), map: containerStats.map,
              error: String(e.stderr || e.message || e).split('\n')[0].slice(0, 160),
            };
          }
        })().finally(() => { statsWait = null; });
      }
      await statsWait;
    }
    sendJSON(res, 200, {
      ts: containerStats.at, error: containerStats.error,
      stats: [...containerStats.map.values()],
    });
    return;
  }

  // ── 容器日志 ────────────────────────────────────────────────────────────
  if (pathname === '/api/container/logs') {
    const name = String(query.get('name') || '').trim();
    const lines = Math.min(1000, Math.max(10, num(query.get('lines')) || 200));
    if (!name || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/.test(name)) { sendJSON(res, 400, { error: '容器名不合法' }); return; }
    try {
      const { stdout } = await execFileP('docker', ['logs', '--tail', String(lines), name],
        { timeout: 8000, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      sendJSON(res, 200, { name, count: String(stdout || '').split('\n').length, lines: String(stdout || '').split('\n').slice(-lines) });
    } catch (e) {
      sendJSON(res, 500, { error: String(e.stderr || e.message || e).split('\n')[0].slice(0, 200) });
    }
    return;
  }

  // ── 容器启停 ────────────────────────────────────────────────────────────
  if (pathname === '/api/container/action' && req.method === 'POST') {
    const body = await readBody(req, res);
    if (!body) return;
    const name = String(body.name || '').trim();
    const action = String(body.action || '').trim();
    const client = clientOf(req);
    const tag = 'container.' + (action || 'unknown');
    const reject = (msg) => {
      auditRecord({ action: tag, target: name, result: 'rejected', message: msg, client });
      sendJSON(res, 400, { error: msg });
    };
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/.test(name)) return reject('容器名不合法');
    if (!['start', 'stop', 'restart'].includes(action)) return reject('不支持的操作：' + action);
    if (body.confirm !== true) return reject('需要 confirm: true 才会执行');
    try {
      await execFileP('docker', [action, name], { timeout: 30000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
      containerStats.at = 0;                     // 让下一次查询重新拉 stats
      auditRecord({ action: tag, target: name, result: 'ok', message: `docker ${action} ${name}`, client });
      sendJSON(res, 200, { success: true, name, action });
    } catch (e) {
      const msg = String(e.stderr || e.message || e).split('\n')[0].slice(0, 200);
      auditRecord({ action: tag, target: name, result: 'error', message: msg || 'docker 执行失败', client });
      sendJSON(res, 400, { error: msg || 'docker 执行失败' });
    }
    return;
  }

  // ── 进程快照 ────────────────────────────────────────────────────────────
  // ── 诊断包：把排查常用的几样东西打成一个 tar.gz 交出去 ─────────────────
  // 用户报「机器有问题」时，来回问日志 / 快照 / 服务状态效率很低。
  // 这里一次性打包：运行日志、当前进程快照、端口归属、服务状态、历史曲线、
  // 告警规则与事件、最近操作记录、版本与环境信息。
  if (pathname === '/api/diagnose') {
    ensureFreshProcs();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const files = [];
    const addText = (name, text) => files.push({ name, data: Buffer.from(String(text), 'utf8') });
    const addJSON = (name, obj) => addText(name, JSON.stringify(obj, null, 2));

    addJSON('meta.json', {
      version: VERSION, node: process.version, platform: process.platform, arch: process.arch,
      host: HOST_NAME, generatedAt: new Date().toISOString(),
      uptimeSec: Math.round(process.uptime()), procCount: procs.length,
      dataDir: PKGVAR, snapshotEnabled: snapshotStore.enabled,
      historyEnabled: historyStore.enabled, auditEnabled: auditStore.enabled, alertEnabled: alertStore.enabled,
    });
    addJSON('processes.json', procs.map((p) => ({
      pid: p.pid, ppid: p.ppid, name: p.name, user: p.user, state: p.state,
      threads: p.threads, cpuPct: p.cpuPct, rss: p.rss, cpuTime: p.cpuTime,
      cmd: String(p.cmd || '').slice(0, 400), container: p.container ? p.container.name : '',
    })));
    try { addJSON('ports.json', [...pidPorts.entries()].map(([pid, list]) => ({ pid, ports: list }))); } catch { /* 忽略 */ }
    try { addJSON('history.json', historyStore.enabled ? historyStore.query(60, 240).rows : []); } catch { /* 忽略 */ }
    try { addJSON('alerts.json', { rules: alertStore.listRules(), events: alertStore.listEvents({ limit: 100 }).rows }); } catch { /* 忽略 */ }
    try { addJSON('audit.json', auditStore.enabled ? auditStore.list({ limit: 200 }).rows : []); } catch { /* 忽略 */ }
    try { addJSON('snapshots.json', snapshotStore.enabled ? snapshotStore.list(20) : []); } catch { /* 忽略 */ }
    const logPath = join(PKGVAR, 'info.log');
    if (existsSync(logPath)) {
      try {
        const buf = readFileSync(logPath);
        files.push({ name: 'info.log', data: buf.length > 4 * 1024 * 1024 ? buf.subarray(buf.length - 4 * 1024 * 1024) : buf });
      } catch { /* 忽略 */ }
    }

    // 手写 tar（零依赖）：512 字节头 + 内容按 512 对齐
    const blocks = [];
    const push = (b) => blocks.push(b);
    for (const f of files) {
      const header = Buffer.alloc(512, 0);
      header.write(f.name.slice(0, 99), 0, 'utf8');
      header.write('0000644 ', 100);                       // mode
      header.write('0000000 ', 108);                      // uid
      header.write('0000000 ', 116);                      // gid
      header.write(f.data.length.toString(8).padStart(11, '0') + ' ', 124);
      header.write(Math.floor(Date.now() / 1000).toString(8) + ' ', 136);
      header.write('        ', 148);                       // checksum 占位（空格）
      header.write('0', 156);                              // typeflag: 普通文件
      header.write('ustar ', 257);
      header.write('00', 263);
      let sum = 0;
      for (const b of header) sum += b;
      header.write(sum.toString(8).padStart(6, '0') + '  ', 148);
      push(header);
      push(f.data);
      const pad = (512 - (f.data.length % 512)) % 512;
      if (pad) push(Buffer.alloc(pad, 0));
    }
    push(Buffer.alloc(1024, 0));                            // tar 结尾两个空块
    const tar = gzipSync(Buffer.concat(blocks));
    auditRecord({ action: 'diagnose', target: `${files.length} 个文件`, result: 'ok', message: '导出诊断包', client: clientOf(req) });
    res.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="fnproc-diag-${stamp}.tar.gz"`,
      'Content-Length': tar.length,
      'Cache-Control': 'no-store',
    });
    res.end(tar);
    return;
  }

  if (pathname === '/api/settings') {
    if (req.method === 'GET') {
      sendJSON(res, 200, {
        snapshotAuto: alertStore.getSetting('snapshotAuto', { enabled: false, keepDays: 30 }),
      });
      return;
    }
    const body = await readBody(req, res);
    if (!body) return;
    if (body.snapshotAuto && typeof body.snapshotAuto === 'object') {
      const keepDays = Math.max(1, Math.min(365, Number(body.snapshotAuto.keepDays) || 30));
      const enabled = body.snapshotAuto.enabled === true;
      alertStore.setSetting('snapshotAuto', { enabled, keepDays });
      auditRecord({
        action: 'settings.update', target: 'snapshotAuto', result: 'ok',
        message: `自动快照 ${enabled ? '开启' : '关闭'}，保留 ${keepDays} 天`, client: clientOf(req),
      });
    }
    sendJSON(res, 200, { ok: true, snapshotAuto: alertStore.getSetting('snapshotAuto', { enabled: false, keepDays: 30 }) });
    return;
  }

  if (pathname === '/api/snapshots' && req.method === 'GET') {
    sendJSON(res, 200, { snapshots: snapshotStore.list(50), health: snapshotStore.health() });
    return;
  }

  if (pathname === '/api/snapshot' && req.method === 'POST') {
    const body = await readBody(req, res);
    if (!body) return;
    // 每个快照写全量进程清单，循环调用会把磁盘打满（磁盘满了审计库会降级成内存队列，
    // 超出 5000 条就丢 —— 等于审计被冲掉）。10 秒内只允许存一个。
    if (Date.now() - lastSnapshotAt < 10000) {
      sendJSON(res, 429, { error: '存快照太频繁，请 10 秒后再试' });
      return;
    }
    lastSnapshotAt = Date.now();
    ensureFreshProcs();
    const r = snapshotStore.save(procs, String(body.label || '').trim());
    if (!r.ok) { sendJSON(res, 400, { error: r.error }); return; }
    auditRecord({ action: 'snapshot.save', target: String(r.id), result: 'ok', message: `保存快照 #${r.id}（${r.count} 个进程）`, client: clientOf(req) });
    sendJSON(res, 200, { success: true, ...r });
    return;
  }

  if (pathname === '/api/snapshot/delete' && req.method === 'POST') {
    const body = await readBody(req, res);
    if (!body) return;
    if (body.confirm !== true) { sendJSON(res, 400, { error: '需要 confirm: true' }); return; }
    const r = snapshotStore.remove(num(body.id));
    sendJSON(res, r.ok ? 200 : 400, r);
    return;
  }

  if (pathname === '/api/snapshot/diff') {
    const a = num(query.get('a'));
    const b = num(query.get('b'));
    if (!a || !b) { sendJSON(res, 400, { error: '需要 a 和 b 两个快照 id' }); return; }
    sendJSON(res, 200, { a, b, ...snapshotStore.diff(a, b) });
    return;
  }

  // ── 看门狗 ──────────────────────────────────────────────────────────────
  if (pathname === '/api/watchdogs' && req.method === 'GET') {
    sendJSON(res, 200, { watchdogs: alertStore.listWatchdogs() });
    return;
  }

  if (pathname === '/api/watchdogs' && req.method === 'POST') {
    const body = await readBody(req, res);
    if (!body) return;
    // 执行命令是高风险动作，判据必须用「结果状态」而不是「请求里有没有 id」：
    //   · 新建时为 false（哪怕请求里写了 true）
    //   · 更新时保持原有开关状态，除非显式要求改
    //   · 以下任一条成立就必须带 acknowledge：true
    //       ① 目标状态是「启用」 ② 改动了一条已启用看门狗的命令
    const existing = body.id ? alertStore.listWatchdogs().find((w) => w.id === Number(body.id)) : null;
    const wantsEnable = typeof body.enabled === 'boolean' ? body.enabled : (existing ? existing.enabled : false);
    const commandChanged = existing ? String(body.command || '').trim() !== existing.command : true;
    const needAck = wantsEnable || (existing && existing.enabled && commandChanged);
    if (needAck && body.acknowledge !== true) {
      auditRecord({
        action: 'watchdog.save', target: String(body.id || 0), result: 'rejected',
        message: '缺少 acknowledge: true（看门狗以 root 执行命令）', client: clientOf(req),
      });
      sendJSON(res, 400, { error: '看门狗会以 root 身份执行命令，保存启用状态需要 acknowledge: true' });
      return;
    }
    const r = alertStore.saveWatchdog({ ...body, enabled: wantsEnable });
    if (!r.ok) { sendJSON(res, 400, { error: r.error }); return; }
    auditRecord({
      action: 'watchdog.save', target: String(r.id), result: 'ok',
      message: `${body.id ? '更新' : '新建'}看门狗 ${body.name || ''} → ${body.command || ''}`,
      client: clientOf(req),
    });
    sendJSON(res, 200, { success: true, id: r.id });
    return;
  }

  if (pathname === '/api/watchdogs/delete' && req.method === 'POST') {
    const body = await readBody(req, res);
    if (!body) return;
    if (body.confirm !== true) { sendJSON(res, 400, { error: '需要 confirm: true' }); return; }
    const r = alertStore.deleteWatchdog(num(body.id));
    if (!r.ok) { sendJSON(res, 400, { error: r.error }); return; }
    auditRecord({ action: 'watchdog.delete', target: String(body.id), result: 'ok', message: `删除看门狗 #${body.id}`, client: clientOf(req) });
    sendJSON(res, 200, { success: true, ...r });
    return;
  }

  // ── 进程调优（renice / OOM 保护 / cgroup 内存上限）──────────────────────
  if (pathname === '/api/tune' && req.method === 'POST') {
    const body = await readBody(req, res);
    if (!body) return;
    const pid = num(body.pid);
    const action = String(body.action || '').trim();
    const client = clientOf(req);
    const tag = 'tune.' + (action || 'unknown');
    const reject = (msg) => {
      auditRecord({ action: tag, target: String(pid), result: 'rejected', message: msg, client });
      sendJSON(res, 400, { error: msg });
    };
    if (!pid || pid <= 1) return reject('拒绝：PID 必须 > 1');
    if (pid === process.pid) return reject('拒绝：不能调自己的优先级');
    if (body.confirm !== true) return reject('需要 confirm: true 才会执行');
    if (!existsSync(`/proc/${pid}`)) return reject('进程不存在');
    try {
      if (action === 'renice') {
        const nice = Math.max(-20, Math.min(19, Math.round(Number(body.value) || 0)));
        os.setPriority(pid, nice);
        auditRecord({ action: tag, target: String(pid), result: 'ok', message: `renice ${nice}`, client });
        sendJSON(res, 200, { success: true, pid, nice });
      } else if (action === 'oom') {
        const adj = Math.max(-1000, Math.min(1000, Math.round(Number(body.value) || 0)));
        writeFileSync(`/proc/${pid}/oom_score_adj`, String(adj));
        auditRecord({ action: tag, target: String(pid), result: 'ok', message: `oom_score_adj=${adj}`, client });
        sendJSON(res, 200, { success: true, pid, oomScoreAdj: adj });
      } else if (action === 'cgroup-memory-high') {
        const cg = readCgroupMem(pid);
        if (!cg || !cg.path) return reject('该进程没有 cgroup 信息');
        const base = '/sys/fs/cgroup' + (cg.path === '/' ? '' : cg.path);
        const raw = String(body.value == null ? '' : body.value).trim();
        const value = raw === 'max' ? 'max' : String(Math.max(0, Math.round(Number(raw) || 0)));
        if (value !== 'max' && value === '0') return reject('内存上限必须是正整数或 max');
        writeFileSync(join(base, 'memory.high'), value);
        auditRecord({ action: tag, target: String(pid), result: 'ok', message: `memory.high=${value}（${cg.path}）`, client });
        sendJSON(res, 200, { success: true, pid, value, cgroup: cg.path });
      } else {
        return reject('不支持的操作：' + action);
      }
    } catch (e) {
      const msg = (e.code === 'EPERM' ? '权限不足（EPERM）' : (e.code === 'EACCES' ? '内核不允许（EACCES）' : e.message));
      auditRecord({ action: tag, target: String(pid), result: 'error', message: String(msg).slice(0, 200), client });
      sendJSON(res, 400, { error: msg });
    }
    return;
  }

  // ── Prometheus 指标 ─────────────────────────────────────────────────────
  if (pathname === '/metrics') {
    const L = [];
    // label 值必须转义：进程 comm 可以用 prctl 设成含换行的任意字节，
    // 不处理就能在指标输出里伪造整行（指标注入）
    const lbl = (s) => String(s == null ? '' : s).replace(/[\\"\n\r\t]/g, '_').slice(0, 80);
    const declared = new Set();
    const add = (name, help, val, labels = '') => {
      if (!declared.has(name)) {
        declared.add(name);
        L.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
      }
      L.push(`${name}${labels} ${val}`);
    };
    add('fnproc_up', '进程管家是否在运行', 1);
    add('fnproc_cpu_percent', '整机 CPU 使用率', state.cpu.totalPct);
    add('fnproc_load1', '1 分钟负载', state.load[0]);
    add('fnproc_mem_percent', '内存使用率', state.mem.usedPct);
    add('fnproc_mem_used_bytes', '已用内存', state.mem.used);
    add('fnproc_swap_percent', 'Swap 使用率', state.swap.usedPct);
    add('fnproc_procs_total', '进程总数', state.procTotal);
    add('fnproc_io_read_bps', '磁盘读速率', state.io.readBps);
    add('fnproc_io_write_bps', '磁盘写速率', state.io.writeBps);
    add('fnproc_net_rx_bps', '网络收速率', state.net.rxBps);
    add('fnproc_net_tx_bps', '网络发速率', state.net.txBps);
    add('fnproc_psi_mem_some_avg60', '内存压力 PSI', psi.mem);
    for (const v of volumes.list) {
      add('fnproc_volume_used_percent', '卷使用率', v.usedPct, `{mount="${lbl(v.mount)}"}`);
    }
    for (const a of alertEngine.snapshot()) {
      add('fnproc_alert_breaching', '规则是否正在违规', a.breaching ? 1 : 0, `{rule="${lbl(a.name)}"}`);
    }
    add('fnproc_alert_events_total', '历史告警事件数', alertStore.stats().events);

    // ── 进程级指标：由抓取端指定要看谁 ──────────────────────────────────────
    // 进程级 label 是永久成本：每出现过一个 name 组合就会在 Prometheus 里留一条
    // 序列，即使该进程早已消失。所以默认不导出任何进程级指标，改由抓取端用
    //   /metrics?proc=nginx&proc=postgres
    // 显式声明要看哪些进程。这样「要监控谁」这件事写在 prometheus.yml 里，
    // 基数由那几行配置决定，永远不会随机器上的进程变动而膨胀。
    const wanted = [...new Set((query.getAll ? query.getAll('proc') : [query.get('proc')])
      .filter(Boolean).map((s) => String(s).trim()).filter(Boolean))].slice(0, PROC_METRICS_LIMIT);
    const ignored = (query.getAll ? query.getAll('proc') : []).filter(Boolean).length - wanted.length;
    add('fnproc_proc_metrics_requested', '本次抓取请求的进程级指标个数', wanted.length);
    if (ignored > 0) {
      add('fnproc_proc_metrics_ignored', '超出上限被忽略的 proc 参数个数', ignored);
    }
    for (const want of wanted) {
      // 精确匹配进程名（comm）。同名多进程全部导出，用 pid 区分 ——
      // 进程重启后 pid 变了，Prometheus 视为新序列，这是正常的。
      const hits = procs.filter((p) => p.name === want);
      add('fnproc_process_matches', '该进程名当前匹配到的进程数', hits.length, `{name="${lbl(want)}"}`);
      for (const p of hits) {
        const nm = lbl(p.name);
        add('fnproc_process_rss_bytes', '进程常驻内存', p.rss, `{pid="${p.pid}",name="${nm}"}`);
        add('fnproc_process_cpu_percent', '进程 CPU 使用率', p.cpuPct, `{pid="${p.pid}",name="${nm}"}`);
        add('fnproc_process_threads', '进程线程数', p.threads, `{pid="${p.pid}",name="${nm}"}`);
        add('fnproc_process_start_time_seconds', '进程启动时间（Unix 秒）', Math.round((p.startMs || 0) / 1000), `{pid="${p.pid}",name="${nm}"}`);
      }
    }
    const body = L.join('\n') + '\n';
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(body);
    return;
  }

  // ── CSV 导出 ────────────────────────────────────────────────────────────
  if (pathname === '/api/export') {
    const what = String(query.get('what') || 'processes').trim();
    const csvCell = (v) => {
      let s = String(v == null ? '' : v);
      // Excel 公式注入：以 = + - @ 制表符 开头的单元格会被当公式执行，前置单引号中和
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    let header = [];
    let rows = [];
    if (what === 'processes') {
      ensureFreshProcs();
      header = ['pid', 'ppid', 'name', 'user', 'state', 'cpuPct', 'rssBytes', 'threads', 'cpuTimeSec', 'cmd'];
      rows = procs.map((p) => [p.pid, p.ppid, p.name, p.user, p.state, p.cpuPct, p.rss, p.threads, p.cpuTime, p.cmd]);
    } else if (what === 'history') {
      const minutes = Math.min(10080, Math.max(1, num(query.get('minutes')) || 1440));
      const q = historyStore.query(minutes, 600);
      header = ['ts', 'isoTime', 'cpu', 'mem', 'swap', 'load1', 'readBps', 'writeBps', 'rxBps', 'txBps'];
      rows = (q.rows || []).map((r) => [r.ts, new Date(r.ts).toISOString(), r.cpu, r.mem, r.swap, r.load1, r.rd, r.wr, r.rx, r.tx]);
    } else if (what === 'audit') {
      // 与记录页保持同一套筛选条件（action / result / q / since 全部透传）
      const q = auditStore.list({
        limit: 500, offset: 0,
        q: String(query.get('q') || ''),
        action: String(query.get('action') || ''),
        result: String(query.get('result') || ''),
        since: num(query.get('since')) || 0,
      });
      header = ['id', 'isoTime', 'action', 'target', 'result', 'message', 'client', 'detail'];
      rows = (q.rows || []).map((r) => [r.id, new Date(r.ts).toISOString(), r.action, r.target, r.result, r.message, r.client, r.detail]);
    } else if (what === 'alerts') {
      const q = alertStore.listEvents({ limit: 1000, offset: 0, level: query.get('level') == null ? '' : String(query.get('level')) });
      header = ['id', 'isoTime', 'level', 'rule', 'metric', 'value', 'message', 'delivered'];
      rows = (q.rows || []).map((r) => [r.id, new Date(r.ts).toISOString(), r.level, r.ruleName, r.metric, r.value, r.message, JSON.stringify(r.delivered)]);
    } else {
      sendJSON(res, 400, { error: '不支持的导出类型：' + what });
      return;
    }
    const body = [header.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n') + '\n';
    // BOM 必须算进 Content-Length：早期版本按不含 BOM 的长度声明，
    // 客户端会按声明截断，导出的最后一行末尾 3 字节被吃掉
    const out = '\ufeff' + body;
    const len = Buffer.byteLength(out);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="fnproc-${what}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.csv"`,
      'Content-Length': len,
      'X-Row-Count': String(rows.length),
    });
    res.end(out);
    return;
  }

  // ── 定时任务（crontab）────────────────────────────────────────────────────
  if (pathname === '/api/cron') {
    const jobs = [];
    const pushFile = (file, owner) => {
      const raw = readOr(file);
      if (!raw) return;
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        // 环境变量行（KEY=value）不是任务
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue;
        const f = t.split(/\s+/);
        if (f.length < 6) continue;
        // /etc/crontab 和 /etc/cron.d/* 多一列「运行用户」，用户级 crontab 没有
        const hasUserCol = file === '/etc/crontab' || file.startsWith('/etc/cron.d/');
        const cmdFrom = hasUserCol ? 6 : 5;
        const who = hasUserCol ? f[5] : owner;
        if (f.length < cmdFrom + 1) continue;
        jobs.push({ file, owner: who, schedule: f.slice(0, 5).join(' '), command: f.slice(cmdFrom).join(' ').slice(0, 300) });
      }
    };
    pushFile('/etc/crontab', 'root');
    try {
      for (const f of readdirSync('/etc/cron.d')) pushFile(join('/etc/cron.d', f), 'root');
    } catch { /* 没有 cron.d */ }
    try {
      for (const f of readdirSync('/var/spool/cron/crontabs')) pushFile(join('/var/spool/cron/crontabs', f), f);
    } catch {
      try { for (const f of readdirSync('/var/spool/cron')) pushFile(join('/var/spool/cron', f), f); } catch { /* 忽略 */ }
    }
    sendJSON(res, 200, { count: jobs.length, jobs });
    return;
  }

  // ── 开机耗时 ────────────────────────────────────────────────────────────
  if (pathname === '/api/boot') {
    const out = { kernelSec: null, userspaceSec: null, blame: [], error: '' };
    try {
      const t = await execFileP('systemd-analyze', [], { timeout: 6000, encoding: 'utf8', maxBuffer: 1024 * 1024 });
      const txt = String(t.stdout || '');
      const k = txt.match(/([\d.]+)s \(kernel\)/);
      const u = txt.match(/([\d.]+)s \(userspace\)/);
      const total = txt.match(/=\s*([\d.]+)s/);
      if (k) out.kernelSec = Number(k[1]);
      if (u) out.userspaceSec = Number(u[1]);
      if (total) out.totalSec = Number(total[1]);
      out.raw = txt.trim().replace(/\s+/g, ' ').slice(0, 300);
    } catch (e) { out.error = String(e.stderr || e.message || '').slice(0, 160); }
    try {
      const b = await execFileP('systemd-analyze', ['blame'], { timeout: 8000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
      out.blame = String(b.stdout || '').split('\n').filter(Boolean).slice(0, 15).map((l) => l.trim());
    } catch { /* 忽略 */ }
    sendJSON(res, 200, out);
    return;
  }

  // 操作审计：从 SQLite 分页查，支持按动作 / 结果 / 关键字过滤
  if (pathname === '/api/audit') {
    const limit = num(query.get('limit')) || 50;
    const offset = num(query.get('offset')) || 0;
    const q = String(query.get('q') || '').trim();
    const action = String(query.get('action') || '').trim();
    const result = String(query.get('result') || '').trim();
    // since：毫秒时间戳，用于「最近 1 小时 / 24 小时 / 7 天」筛选
    const since = num(query.get('since')) || 0;
    const { rows, total, degraded } = auditStore.list({ limit, offset, q, action, result, since });
    sendJSON(res, 200, {
      actions: rows, total, limit, offset, degraded,
      stats: auditStore.stats(),
      db: { path: AUDIT_DB, enabled: auditStore.enabled },
    });
    return;
  }

  // 审计库自身健康状态：库路径、WAL 模式、fsync 策略、完整性检查、待写队列
  if (pathname === '/api/audit/health') {
    sendJSON(res, 200, auditStore.health());
    return;
  }

  if (pathname === '/api/health') {
    sendJSON(res, 200, { ok: true, version: VERSION, ts: Date.now(), procs: procs.length, clients: clients.size });
    return;
  }

  // 写端点被 GET 访问时回 405，比 404 更能说明问题（避免把「方法不对」当成「接口不存在」）
  const POST_ONLY = new Set(['/api/kill', '/api/service', '/api/service/enable', '/api/alerts',
    '/api/alerts/delete', '/api/alerts/test', '/api/watchdogs', '/api/watchdogs/delete',
    '/api/snapshot', '/api/snapshot/delete', '/api/container/action', '/api/tune',
    '/api/watches', '/api/watches/delete', '/api/service/pin', '/api/kill/batch',
    '/api/settings', '/api/audit/replay']);
  if (POST_ONLY.has(pathname)) {
    sendJSON(res, 405, { error: '该接口只接受 POST' });
    return;
  }
  sendJSON(res, 404, { error: 'unknown api: ' + pathname });
}

// ── HTTP 入口（网关会带 /app/fnproc 前缀，必须自己剥掉）──────────────────
// ── 请求来源守卫 ────────────────────────────────────────────────────────
// 为什么需要：服务同时监听 127.0.0.1:PORT，浏览器里的任意网页都能跨域打到它。
// 跨域的「简单请求」（text/plain / form-urlencoded）不会触发预检，浏览器直接发出，
// 服务端不判 Content-Type 就等于开了后门 —— 本项目以 root 运行，
// 一个 text/plain POST 就能落地 root 命令（实测过）。
//
// 分层判据（按强度从高到低）：
//   ① 带 X-Trim-Userid = 请求确实从 fnOS 网关过来（恶意网页无法伪造该头）→ 放行
//   ② 没有该头时，拒绝 Sec-Fetch-Site: cross-site（浏览器必带）
//   ③ 任何写请求必须是 application/json —— 这会让浏览器强制发预检，
//      而预检一律 403 直接掐掉（见 OPTIONS 处理）
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function guardRequest(req, res) {
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'OPTIONS') {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return true;
  }
  const gwUid = req.headers['x-trim-userid'] || req.headers['x-trim-uid'];
  if (!gwUid) {
    const sfs = String(req.headers['sec-fetch-site'] || '').toLowerCase();
    if (sfs === 'cross-site') {
      sendJSON(res, 403, { error: '拒绝跨站请求' });
      return true;
    }
  }
  if (MUTATING_METHODS.has(method)) {
    const ct = String(req.headers['content-type'] || '');
    if (!/^application\/json\b/i.test(ct)) {
      sendJSON(res, 415, { error: '写请求必须使用 Content-Type: application/json' });
      return true;
    }
  }
  return false;
}

// 统一读取请求体：解析失败/超限时直接回 400/413，调用方拿到 null 就 return
async function readBody(req, res) {
  const b = await parseBody(req);
  if (b && b.__error) {
    sendJSON(res, b.__status || 400, { error: b.__error });
    return null;
  }
  return b;
}

const httpServer = createServer(async (req, res) => {
  if (guardRequest(req, res)) return;
  let pathname = '/';
  let query = new URLSearchParams();
  try {
    const u = new URL(req.url, 'http://localhost');
    pathname = u.pathname;
    query = u.searchParams;
  } catch { /* 忽略 */ }
  if (pathname === GATEWAY_PREFIX) pathname = '/';
  else if (pathname.startsWith(GATEWAY_PREFIX + '/')) pathname = pathname.slice(GATEWAY_PREFIX.length);
  if (pathname.startsWith('/api/') || pathname === '/metrics') {
    try { await handle(req, res, pathname, query); }
    catch (e) { console.error('[api]', e); sendJSON(res, 500, { error: String(e.message || e) }); }
    return;
  }
  serveStatic(req, res, pathname);
});

httpServer.on('error', (e) => {
  console.error(`[fatal] HTTP 监听失败 ${PORT}: ${e.code || ''} ${e.message || e}`);
  process.exit(1);
});
httpServer.listen(PORT, '127.0.0.1', () => console.log(`fnproc HTTP on 127.0.0.1:${PORT}`));

const sockServer = createServer((req, res) => httpServer.emit('request', req, res));
if (existsSync(SOCK_PATH)) { try { unlinkSync(SOCK_PATH); } catch { /* 忽略 */ } }
sockServer.listen(SOCK_PATH, () => console.log(`fnproc UNIX socket listening: ${SOCK_PATH}`));

// 端口 / 容器：先建表，再按各自的节奏刷新（不进 1 秒主循环，避免拖慢采样）
refreshDocker();
refreshInodePorts();
refreshPidPorts();
setInterval(appendHistory, 30000);   // 历史每 30 秒一行
// 自动快照：每小时检查一次，按配置每天存 1 个、定期裁旧。
// 手动快照靠人记得点，长期没人点就永远只有一个基准 —— 定时快照才让
// 「上周和现在的进程清单差在哪」这类问题问得出来。
setInterval(() => {
  try {
    if (!snapshotStore.enabled) return;
    const auto = alertStore.getSetting('snapshotAuto', null) || {};
    if (auto.enabled !== true) return;
    const keepDays = Math.max(1, Math.min(365, Number(auto.keepDays) || 30));
    const list = snapshotStore.list(200);
    const autoMarks = list.filter((s) => String(s.label || '').startsWith('自动'));
    const lastAuto = autoMarks[0];
    const dayMs = 86400000;
    const due = !lastAuto || (Date.now() - Number(lastAuto.ts || 0)) > dayMs;
    if (due) {
      const label = '自动 ' + new Date().toISOString().slice(0, 10);
      const r2 = snapshotStore.save(procs, label);
      if (r2 && r2.id) console.log(`[snapshot] 已自动快照 #${r2.id}（${label}）`);
    }
    // 裁掉超期的自动快照（手动的一个都不动）
    const cutoff = Date.now() - keepDays * dayMs;
    for (const s of autoMarks) {
      if (Number(s.ts || 0) < cutoff) {
        snapshotStore.remove(s.id);
        console.log(`[snapshot] 已清理超期自动快照 #${s.id}`);
      }
    }
  } catch (e) { console.error('[snapshot] 自动快照失败:', e.message); }
}, 3600000);
let portsTick = 0;
setInterval(() => {
  portsTick += 1;
  const active = activeRecently(60000);
  // 容器列表只在有人看的时候刷新（docker ps 要几十毫秒）
  if (active) refreshDocker();
  // 端口归属：有人看 10 秒一次；没人看 60 秒一次。
  // 单次 `ss -tunapH` 内核要挨个进程做 socket 归属，实测约 80ms CPU，
  // 按 10 秒跑就是常驻 0.8% —— 没人看的时候完全没必要。
  if (active || portsTick % 6 === 0) refreshPorts();
}, 10000);

// 先跑一轮采样，避免首屏全是 0（进程 CPU% 需要两次采样才有意义）
tick();
setInterval(tick, SAMPLE_MS);
alertEngine.start(5000);        // 告警判定每 5 秒一轮，只用已采好的数据
setInterval(() => { try { checkWatches(); } catch (e) { console.error('[watch]', e.message); } }, 5000);

// 应用自身的启停也进审计 —— 这样「谁在什么时候重启过这个应用」也查得到
auditRecord({
  action: 'app.start', target: `pid:${process.pid}`, result: 'ok',
  message: `fnproc ${VERSION} 启动`, client: `pid:${process.ppid}`,
  detail: { version: VERSION, node: process.version, uptimeSec: Math.round(process.uptime()) },
});

for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => {
    try {
      auditRecord({
        action: 'app.stop', target: `pid:${process.pid}`, result: 'ok',
        message: `收到 ${sig}，正常退出`, client: 'systemd',
        detail: { signal: sig, uptimeSec: Math.round(process.uptime()) },
      });
    } catch { /* 退出路径不抛错 */ }
    // 四个 SQLite 库都要关：只关审计库会让 history/snapshot/alert 的 WAL 不 checkpoint，
  // 最后一段采样与事件丢失（historyStore 还有内存 pending 队列要落盘）
  for (const [name, store] of [['audit', auditStore], ['history', historyStore],
    ['alert', alertStore], ['snapshot', snapshotStore]]) {
    try { store.close(); } catch (e) { console.error(`[shutdown] 关闭 ${name} 库失败:`, e.message); }
  }   // 关闭时会把 WAL checkpoint 进主库
    try { unlinkSync(SOCK_PATH); } catch { /* 忽略 */ }
    process.exit(0);
  });
}

// 未捕获异常也要留痕：先落一条记录再退出，避免「莫名其妙重启但查不到原因」
process.on('unhandledRejection', (e) => {
  console.error('[unhandledRejection]', e && e.stack ? e.stack : e);
});

process.on('uncaughtException', (e) => {
  try {
    auditRecord({
      action: 'app.crash', target: `pid:${process.pid}`, result: 'error',
      message: String(e?.message || e).slice(0, 400), client: 'self',
      detail: { stack: String(e?.stack || '').slice(0, 3000) },
    });
    auditStore.close();
  } catch { /* 忽略 */ }
  console.error('[fatal]', e);
  process.exit(1);
});
