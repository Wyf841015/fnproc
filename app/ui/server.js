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
import { readFileSync, readdirSync, existsSync, unlinkSync, statSync, readlinkSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';

const UI_DIR = dirname(fileURLToPath(import.meta.url));
const TARGET_DIR = dirname(UI_DIR);
const PORT = parseInt(process.env.PORT || '47951', 10);
// socket 默认与 ui 同级（生产环境即 <vol>/@appcenter/fnproc/fnproc.sock）。
// 本地调试可用 FNPROC_SOCK_DIR 把它挪到 /tmp，避免 .sock 落进源码树导致 fnpack 打包失败
// （fnpack 会尝试 cp 整个目录，遇到 socket 文件报 "no such device or address"）。
const SOCK_DIR = process.env.FNPROC_SOCK_DIR || TARGET_DIR;
const SOCK_PATH = join(SOCK_DIR, 'fnproc.sock');
const GATEWAY_PREFIX = '/app/fnproc';
const VERSION = '0.1.0';
const SAMPLE_MS = 1000;
const HISTORY_MAX = 120;              // 内存里保留 120 个采样点，够前端画满图

// ── 小工具 ──────────────────────────────────────────────────────────────
const readOr = (p, dflt = '') => { try { return readFileSync(p, 'utf8'); } catch { return dflt; } };
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r1 = (v) => Math.round(v * 10) / 10;

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
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
  if (!existsSync(fp) || !statSync(fp).isFile()) { sendJSON(res, 404, { error: 'not found: ' + rel }); return; }
  let data;
  try { data = readFileSync(fp); } catch { sendJSON(res, 500, { error: 'read failed' }); return; }
  const type = MIME[extname(fp).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
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

function refreshDocker() {
  const now = Date.now();
  if (now - dockerAt < 15000) return;   // docker 命令有开销，15s 才跑一次
  dockerAt = now;
  const names = new Map();
  try {
    const out = execFileSync('docker', ['ps', '--no-trunc', '--format', '{{.ID}}\t{{.Names}}'],
      { timeout: 4000, encoding: 'utf8' });
    for (const line of out.split('\n')) {
      const [id, name] = line.trim().split('\t');
      if (id && name) names.set(id.slice(0, 12), name);
    }
  } catch { /* 没装 docker / 无权限：静默降级，不显示容器列即可 */ }
  dockerNames = names;
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

function sampleProcs() {
  let pids = [];
  try { pids = readdirSync('/proc').filter((n) => /^\d+$/.test(n)); } catch { /* 忽略 */ }
  const now = Date.now();
  // 分母必须是「两次采样之间」的总 jiffies 增量，不能用累计值：
  // 用累计值算出来的进程 CPU% 会小到四舍五入后全是 0.0。
  const totalDelta = lastCpuDelta.dt > 0 ? lastCpuDelta.dt : 0;
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
function tick() {
  const now = Date.now();
  const dtSec = Math.max(0.2, (now - lastSampleAt) / 1000);
  lastSampleAt = now;
  sampleCpu();
  sampleMem();
  sampleLoad();
  sampleIo(dtSec);
  sampleNet(dtSec);
  sampleProcs();
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
  broadcast();
}

// ── SSE ─────────────────────────────────────────────────────────────────
const clients = new Set();
function broadcast() {
  if (!clients.size) return;
  const payload = `data: ${JSON.stringify(snapshot(30))}\n\n`;
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

// ── 审计（谁杀了谁，内存保留最近 100 条）─────────────────────────────────
const audit = [];
function auditPush(entry) {
  audit.unshift(entry);
  if (audit.length > 100) audit.pop();
}


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

function listUnits(force = false) {
  const now = Date.now();
  if (!force && now - unitsCache.at < 5000) return unitsCache.list;
  let list = [];
  try {
    const out = execFileSync('systemctl',
      ['list-units', '--type=service', '--all', '--no-legend', '--no-pager', '--plain'],
      { timeout: 6000, encoding: 'utf8' });
    for (const line of out.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const f = t.split(/\s+/);
      if (f.length < 4) continue;
      const [name, load, active, sub] = f;
      if (!name.endsWith('.service')) continue;
      const desc = t.slice(t.indexOf(sub, name.length + load.length + active.length) + sub.length).trim();
      list.push({ name, load, active, sub, desc, protected: PROTECTED_UNITS.has(name) });
    }
  } catch { /* 非 systemd 环境：返回空表，前端提示即可 */ }
  unitsCache = { at: now, list };
  return list;
}

const SERVICE_ACTIONS = new Set(['start', 'stop', 'restart']);

function runServiceAction(name, action) {
  if (!UNIT_RE.test(name)) return { ok: false, error: '服务名不合法' };
  if (!SERVICE_ACTIONS.has(action)) return { ok: false, error: '不支持的操作：' + action };
  if (PROTECTED_UNITS.has(name) && action !== 'start') {
    return { ok: false, error: `${name} 属于关键服务，禁止 ${action}（会导致失联或系统不可用）` };
  }
  try {
    execFileSync('systemctl', [action, name], { timeout: 20000, encoding: 'utf8' });
    unitsCache.at = 0;   // 让下一次查询重新拉取
    return { ok: true };
  } catch (e) {
    const msg = String(e.stderr || e.message || e).trim().split('\n').slice(0, 2).join(' ');
    return { ok: false, error: msg.slice(0, 200) || 'systemctl 执行失败' };
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
    res.write(`data: ${JSON.stringify(snapshot(30))}\n\n`);
    clients.add(res);
    const keep = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* 忽略 */ } }, 25000);
    req.on('close', () => { clearInterval(keep); clients.delete(res); });
    return;
  }

  if (pathname === '/api/overview') {
    sendJSON(res, 200, {
      ...snapshot(10),
      core: state.cpu.cores,
      host: { name: readOr('/proc/sys/kernel/hostname').trim(), kernel: readOr('/proc/sys/kernel/osrelease').trim() },
    });
    return;
  }

  if (pathname === '/api/processes') {
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
    sendJSON(res, 200, {
      ...base, exe, cwd, fds, envCount, oom, vmSwap, vmPeak, statm,
      cmd: procCmdline(pid, true),
      io: { read: io.read, write: io.write },
      children: procs.filter((p) => p.ppid === pid).map((p) => ({ pid: p.pid, name: p.name })),
    });
    return;
  }

  if (pathname === '/api/kill' && req.method === 'POST') {
    const body = await parseBody(req);
    const pid = num(body.pid);
    const sig = String(body.signal || 'SIGTERM').toUpperCase();
    if (!pid || pid <= 1) { sendJSON(res, 400, { error: '拒绝：PID 必须 > 1（不能动 init）' }); return; }
    if (pid === process.pid) { sendJSON(res, 400, { error: '拒绝：不能结束进程管家自身' }); return; }
    if (!SIGNALS.has(sig)) { sendJSON(res, 400, { error: `拒绝：不支持的信号 ${sig}` }); return; }
    if (body.confirm !== true) { sendJSON(res, 400, { error: '需要 confirm: true 才会执行' }); return; }
    const target = procs.find((p) => p.pid === pid);
    try {
      process.kill(pid, sig);
      const entry = { at: new Date().toISOString(), pid, signal: sig, name: target?.name || '?', user: target?.user || '?', ok: true };
      auditPush(entry);
      console.log(`[kill] pid=${pid} sig=${sig} name=${entry.name}`);
      sendJSON(res, 200, { success: true, ...entry });
    } catch (e) {
      const entry = { at: new Date().toISOString(), pid, signal: sig, name: target?.name || '?', user: target?.user || '?', ok: false, error: e.code || e.message };
      auditPush(entry);
      sendJSON(res, 400, { success: false, error: e.code === 'EPERM' ? '权限不足（EPERM）' : (e.code === 'ESRCH' ? '进程不存在（ESRCH）' : e.message), ...entry });
    }
    return;
  }

  if (pathname === '/api/history') {
    const minutes = num(query.get('minutes')) || 60;
    const rows = readHistory(minutes);
    sendJSON(res, 200, {
      ts: Date.now(), minutes, count: rows.length,
      file: HISTORY_FILE, rows,
    });
    return;
  }

  if (pathname === '/api/services') {
    const q = String(query.get('q') || '').toLowerCase().trim();
    const state = String(query.get('state') || '').trim();
    let list = listUnits();
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
    if (body.confirm !== true) { sendJSON(res, 400, { error: '需要 confirm: true 才会执行' }); return; }
    const r = runServiceAction(name, action);
    if (!r.ok) {
      auditPush({ at: new Date().toISOString(), kind: 'service', pid: null, signal: action, name, user: 'root', ok: false, error: r.error });
      sendJSON(res, 400, { error: r.error });
      return;
    }
    auditPush({ at: new Date().toISOString(), kind: 'service', pid: null, signal: action, name, user: 'root', ok: true });
    console.log(`[service] ${action} ${name}`);
    sendJSON(res, 200, { success: true, name, action });
    return;
  }

  if (pathname === '/api/audit') {
    sendJSON(res, 200, { actions: audit });
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
setInterval(() => { refreshDocker(); refreshInodePorts(); refreshPidPorts(); }, 10000);

// 先跑一轮采样，避免首屏全是 0（进程 CPU% 需要两次采样才有意义）
tick();
setInterval(tick, SAMPLE_MS);

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    try { unlinkSync(SOCK_PATH); } catch { /* 忽略 */ }
    process.exit(0);
  });
}
