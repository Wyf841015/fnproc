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
import { gzipSync } from 'node:zlib';
import { openAuditStore } from './audit-db.js';
import { openHistoryStore } from './history-db.js';
import { openAlertStore, METRICS, LEVEL_LABEL } from './alert-db.js';
import { createAlertEngine, readPsiMem, diskUsedPct } from './alerts.js';

const UI_DIR = dirname(fileURLToPath(import.meta.url));
const TARGET_DIR = dirname(UI_DIR);
const PORT = parseInt(process.env.PORT || '47951', 10);
// socket 默认与 ui 同级（生产环境即 <vol>/@appcenter/fnproc/fnproc.sock）。
// 本地调试可用 FNPROC_SOCK_DIR 把它挪到 /tmp，避免 .sock 落进源码树导致 fnpack 打包失败
// （fnpack 会尝试 cp 整个目录，遇到 socket 文件报 "no such device or address"）。
const SOCK_DIR = process.env.FNPROC_SOCK_DIR || TARGET_DIR;
const SOCK_PATH = join(SOCK_DIR, 'fnproc.sock');
const GATEWAY_PREFIX = '/app/fnproc';
const VERSION = '0.3.0';
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

function parseBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); resolve({}); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
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

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' || pathname === '' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (rel.includes('..')) { sendJSON(res, 403, { error: '路径越界' }); return; }
  const fp = join(UI_DIR, rel);
  let st;
  try { st = statSync(fp); } catch { sendJSON(res, 404, { error: 'not found: ' + rel }); return; }
  if (!st.isFile()) { sendJSON(res, 404, { error: 'not found: ' + rel }); return; }
  const type = MIME[extname(fp).toLowerCase()] || 'application/octet-stream';
  // ETag 用 size+mtime：部署新版本必然变，文件没变则命中 304 不用重下。
  // 保留 no-cache（每次都回源校验）—— fnOS WebView 缓存旧 main.js 的坑还在，
  // 不能用强缓存；304 只是把「未改动的整包传输」省掉。
  const etag = '"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
  const headers = {
    'Content-Type': type, 'Cache-Control': 'no-cache',
    ETag: etag, 'X-Content-Type-Options': 'nosniff',
  };
  if (String(req.headers['if-none-match'] || '') === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  let data;
  try { data = readFileSync(fp); } catch { sendJSON(res, 500, { error: 'read failed' }); return; }
  const ae = String(req.headers['accept-encoding'] || '');
  if (/gzip/.test(ae) && data.length > 2048 && /^(text|application\/javascript|application\/json|image\/svg)/.test(type)) {
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
let pidPorts = new Map();

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
let portsInflight = false;

async function refreshPorts() {
  if (portsInflight) return;
  portsInflight = true;
  try {
    const ok = await portsViaSs();
    if (!ok) { refreshInodePorts(); refreshPidPorts(); }
  } catch {
    try { refreshInodePorts(); refreshPidPorts(); } catch { /* 忽略 */ }
  } finally {
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
  let candidates = 0;               // 有多少行「看起来是端口」，用来判断 ss 是否有权限看到进程
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
  }
  // 非 root 时 ss 只给得出自己进程的 pid（实测 admin 只有 2 条，root 有 122 条）。
  // 拿到的比例太低就认为「看不到」，退回遍历 /proc/PID/fd（结果一样但至少不漏）。
  if (!byPid.size || byPid.size < Math.max(3, candidates * 0.3)) return false;
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
    dockerNames = names;
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
  if (!force && c && now - c.ts < 5000) return c.v;
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
const SECRET_KEY_RE = /(KEY|TOKEN|SECRET|PASS|PWD|AUTH|COOKIE|CREDENTIAL|SESSION)/i;
function readEnvPairs(pid, limit = 40) {
  const raw = readOr(`/proc/${pid}/environ`);
  if (!raw) return { count: 0, list: [], masked: 0 };
  const all = raw.split('\0').filter(Boolean);
  let masked = 0;
  const list = [];
  for (const kv of all.slice(0, limit)) {
    const eq = kv.indexOf('=');
    const k = eq > 0 ? kv.slice(0, eq) : kv;
    let v = eq > 0 ? kv.slice(eq + 1) : '';
    if (SECRET_KEY_RE.test(k) && v) { v = '***'; masked += 1; }
    else if (v.length > 140) v = v.slice(0, 140) + '…';
    list.push({ k, v });
  }
  return { count: all.length, list, masked };
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
function sseSnapshot() {
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
    hk: HIST_KEYS,
    h: histCompact(),
  };
}

function broadcast() {
  if (!clients.size) return;
  const payload = `data: ${JSON.stringify(sseSnapshot())}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
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
}, 3600 * 1000);

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
const UNIT_RE = /^[A-Za-z0-9@._:\\-]+\.service$/;

// 停掉这些会让机器失联或直接瘫痪，禁止 stop/restart（start 允许，用于救回来）
const PROTECTED_UNITS = new Set([
  'ssh.service', 'sshd.service', 'dbus.service', 'systemd-logind.service',
  'systemd-journald.service', 'systemd-udevd.service', 'systemd-networkd.service',
  'networking.service', 'NetworkManager.service', 'cron.service',
]);

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
        list.push({ name, load, active, sub, desc, protected: PROTECTED_UNITS.has(name), enabledState: '' });
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
  if (PROTECTED_UNITS.has(name) && action !== 'start') {
    return { ok: false, kind: 'rejected', error: `${name} 属于关键服务，禁止 ${action}（会导致失联或系统不可用）` };
  }
  try {
    await execFileP('systemctl', [action, name], { timeout: 20000, encoding: 'utf8' });
    unitsCache.at = 0;   // 让下一次查询重新拉取
    return { ok: true };
  } catch (e) {
    const msg = String(e.stderr || e.message || e).trim().split('\n').slice(0, 2).join(' ');
    return { ok: false, kind: 'error', error: msg.slice(0, 200) || 'systemctl 执行失败' };
  }
}


// ── 路由 ────────────────────────────────────────────────────────────────
const SORTS = {
  cpu: (a, b) => b.cpuPct - a.cpuPct,
  mem: (a, b) => b.rss - a.rss,
  pid: (a, b) => a.pid - b.pid,
  name: (a, b) => a.name.localeCompare(b.name),
  time: (a, b) => b.cpuTime - a.cpuTime,
  threads: (a, b) => b.threads - a.threads,
  start: (a, b) => b.startMs - a.startMs,
};

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
    clients.add(res);
    const keep = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* 忽略 */ } }, 25000);
    req.on('close', () => { clearInterval(keep); clients.delete(res); });
    return;
  }

  if (pathname === '/api/overview') {
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
    const sortKey = SORTS[query.get('sort')] ? query.get('sort') : 'cpu';
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
    const body = await parseBody(req);
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
      sendJSON(res, 200, {
        ts: Date.now(), minutes, count: q.rows.length, bucket: q.bucket,
        source: q.source, file: HISTORY_DB, rows: q.rows, health: historyStore.health(),
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
    sendJSON(res, 200, { ts: state.ts, total: list.length, counts, units: list.slice(0, 400) });
    return;
  }

  if (pathname === '/api/service' && req.method === 'POST') {
    const body = await parseBody(req);
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
    const body = await parseBody(req);
    const r = alertStore.saveRule(body);
    if (!r.ok) { sendJSON(res, 400, { error: r.error }); return; }
    auditRecord({ action: 'alert.save', target: String(r.id), result: 'ok', message: `${body.id ? '更新' : '新建'}规则 ${body.name || ''}`, client: clientOf(req) });
    sendJSON(res, 200, { success: true, id: r.id });
    return;
  }

  if (pathname === '/api/alerts/delete' && req.method === 'POST') {
    const body = await parseBody(req);
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
    const body = await parseBody(req);
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
    if (grep) args.push('--grep', grep);
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
    const body = await parseBody(req);
    const name = String(body.name || '').trim();
    const enable = body.enable !== false;
    const client = clientOf(req);
    const tag = enable ? 'service.enable' : 'service.disable';
    const reject = (msg) => {
      auditRecord({ action: tag, target: name, result: 'rejected', message: msg, client });
      sendJSON(res, 400, { error: msg });
    };
    if (!UNIT_RE.test(name)) return reject('服务名不合法');
    if (!enable && PROTECTED_UNITS.has(name)) return reject(`${name} 属于关键服务，禁止禁用（会导致失联或系统不可用）`);
    if (body.confirm !== true) return reject('需要 confirm: true 才会执行');
    try {
      await execFileP('systemctl', [enable ? 'enable' : 'disable', name],
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

  // 操作审计：从 SQLite 分页查，支持按动作 / 结果 / 关键字过滤
  if (pathname === '/api/audit') {
    const limit = num(query.get('limit')) || 50;
    const offset = num(query.get('offset')) || 0;
    const q = String(query.get('q') || '').trim();
    const action = String(query.get('action') || '').trim();
    const result = String(query.get('result') || '').trim();
    const { rows, total, degraded } = auditStore.list({ limit, offset, q, action, result });
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

  sendJSON(res, 404, { error: 'unknown api: ' + pathname });
}

// ── HTTP 入口（网关会带 /app/fnproc 前缀，必须自己剥掉）──────────────────
const httpServer = createServer(async (req, res) => {
  let pathname = '/';
  let query = new URLSearchParams();
  try {
    const u = new URL(req.url, 'http://localhost');
    pathname = u.pathname;
    query = u.searchParams;
  } catch { /* 忽略 */ }
  if (pathname === GATEWAY_PREFIX) pathname = '/';
  else if (pathname.startsWith(GATEWAY_PREFIX + '/')) pathname = pathname.slice(GATEWAY_PREFIX.length);
  if (pathname.startsWith('/api/')) {
    try { await handle(req, res, pathname, query); }
    catch (e) { console.error('[api]', e); sendJSON(res, 500, { error: String(e.message || e) }); }
    return;
  }
  serveStatic(req, res, pathname);
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
    try { auditStore.close(); } catch { /* 忽略 */ }   // 关闭时会把 WAL checkpoint 进主库
    try { unlinkSync(SOCK_PATH); } catch { /* 忽略 */ }
    process.exit(0);
  });
}

// 未捕获异常也要留痕：先落一条记录再退出，避免「莫名其妙重启但查不到原因」
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
