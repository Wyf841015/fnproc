// app/ui/alerts.js — 告警判定与通知投递
//
// 设计要点：
//   · 判定每 5 秒跑一轮，全部基于「已经采好的」数据（CPU/内存/Swap/进程列表），
//     不再额外扫 /proc —— 告警不应该成为新的性能负担
//   · 每条规则维护自己的「持续违规起点」：只有连续违规超过 durationSec 才触发，
//     避免一次瞬时抖动就打一条通知
//   · 触发后进入冷却（cooldownSec），不会每 5 秒刷屏
//   · 通知投递结果逐通道记录（成功 / 失败原因），写进事件表；「为什么没收到」
//     必须能查，不能只留一句「已触发」
//   · 所有对外动作（psql、webhook）都带超时，失败只记录不抛出，
//     告警子系统绝不能把监控主功能拖下水

import { readFileSync, statfsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lookup } from 'node:dns/promises';

const execFileP = promisify(execFile);

// psql 里拼字面量：单引号翻倍是唯一需要的转义，同时去掉 \0 与控制字符
function sqlLit(s) {
  return "'" + String(s == null ? '' : s)
    .replace(/\0/g, '')
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/'/g, "''") + "'";
}

// ── Webhook 地址校验（SSRF 防护）────────────────────────────────────────
// 告警 webhook 是本进程（root）主动发起的 POST，如果不校验目标，
// 它就是一台可打内网/回环/云元数据的内网 HTTP 客户端。
// 判据：解析出真实 IP 后逐个判断，字面 IP 与域名一视同仁。
export function isPrivateAddress(ip) {
  const a = String(ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!a) return true;
  const v4 = a.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [o1, o2] = [Number(v4[1]), Number(v4[2])];
    if (o1 === 10) return true;
    if (o1 === 127) return true;
    if (o1 === 0) return true;
    if (o1 === 169 && o2 === 254) return true;              // 链路本地 / 云元数据
    if (o1 === 172 && o2 >= 16 && o2 <= 31) return true;
    if (o1 === 192 && o2 === 168) return true;
    if (o1 === 100 && o2 >= 64 && o2 <= 127) return true;    // CGNAT
    if (o1 >= 224) return true;                              // 组播/保留
    return false;
  }
  if (a === '::1' || a === '::') return true;
  if (a.startsWith('fe80')) return true;                     // IPv6 链路本地
  if (/^f[cd][0-9a-f]{2}/.test(a)) return true;              // IPv6 ULA fc00::/7
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]);
  return false;
}

export async function webhookBlockReason(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl || '').trim()); } catch { return 'Webhook 地址不合法'; }
  if (!/^https?:$/.test(u.protocol)) return 'Webhook 必须是 http(s) 地址';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) return 'Webhook 缺少主机名';
  if (/^(localhost|.*\.local|.*\.internal|.*\.lan)$/i.test(host)) return 'Webhook 不允许指向本机或内网域名';
  const addrs = [];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) addrs.push(host);
  else {
    try {
      const list = await lookup(host, { all: true });
      for (const x of list) addrs.push(x.address);
    } catch { return 'Webhook 域名解析失败'; }
  }
  if (!addrs.length) return 'Webhook 域名未解析到地址';
  for (const a of addrs) {
    if (isPrivateAddress(a)) return `Webhook 指向内网地址 ${a}，已拒绝`;
  }
  return '';
}

export function readPsiMem() {
  try {
    const raw = readFileSync('/proc/pressure/memory', 'utf8');
    const line = raw.split('\n').find((l) => l.startsWith('some')) || '';
    const m = line.match(/avg10=([\d.]+)/);
    return m ? Number(m[1]) : 0;
  } catch { return 0; }
}

export function diskUsedPct(mount) {
  try {
    const st = statfsSync(mount);
    const total = st.blocks * st.bsize;
    if (!total) return null;
    const avail = (st.bfree || 0) * st.bsize;
    return ((total - avail) / total) * 100;
  } catch { return null; }
}

function readOomKillCount() {
  try {
    for (const line of readFileSync('/proc/vmstat', 'utf8').split('\n')) {
      if (line.startsWith('oom_kill ')) return Number(line.split(/\s+/)[1]) || 0;
    }
  } catch { /* 忽略 */ }
  return 0;
}

export function createAlertEngine({ store, version = '', log = console.log, getUnits = null }) {
  const breachSince = new Map();      // ruleId → 首次违规时间
  const state = new Map();            // ruleId → 当前值（给前端展示）
  let prevOom = readOomKillCount();
  let timer = null;
  let lastEvalAt = 0;
  let ctx = { cpu: 0, mem: 0, swap: 0, procs: [], procTotal: 0 };
  let delivering = false;
  let lastRuleSig = '';            // 规则判据签名：变化时重置计时状态

  // 供 /api/overview 等地方取「当前有没有告警在持续」
  function snapshot() {
    const out = [];
    for (const rule of store.listRules()) {
      if (!rule.enabled) continue;
      const s = state.get(rule.id);
      if (!s) continue;
      out.push({
        id: rule.id, name: rule.name, metric: rule.metric,
        value: s.value, breaching: s.breaching,
        sinceMs: s.sinceMs || 0, firedAt: rule.lastFired || 0,
      });
    }
    return out;
  }

  function valueOf(rule) {
    switch (rule.metric) {
      case 'cpu': return ctx.cpu;
      case 'mem': return ctx.mem;
      case 'swap': return ctx.swap;
      case 'disk': return diskUsedPct(rule.target);
      case 'psi_mem': return readPsiMem();
      case 'oom': return roundOomDelta;      // 每轮判定只采样一次（见 beginRound）
      case 'proc_missing': {
        const t = String(rule.target || '').trim();
        if (!t) return null;
        if (/^\d+$/.test(t)) {
          const pid = Number(t);
          const hit = ctx.procs.some((p) => p.pid === pid);
          return hit ? 0 : 1;               // 1 = 缺失
        }
        const key = t.toLowerCase();
        const hit = ctx.procs.some((p) => (p.name || '').toLowerCase() === key
          || (p.cmd || '').toLowerCase().includes(key));
        return hit ? 0 : 1;
      }
      case 'unit_failed': {
        if (!Array.isArray(ctx.units)) return null;
        const u = ctx.units.find((x) => x.name === rule.target);
        if (!u) return null;
        return (u.active === 'failed' || u.sub === 'failed') ? 1 : 0;
      }
      default: return null;
    }
  }

  // 每轮判定开始时采一次 OOM 计数，否则同时启用两条 OOM 规则时，
  // 第一条把 prevOom 推进了，第二条永远读到 delta=0、永不触发
  let roundOomDelta = 0;
  function beginRound() {
    const now = readOomKillCount();
    roundOomDelta = Math.max(0, now - prevOom);
    prevOom = now;
  }

  function breached(rule, v) {
    switch (rule.metric) {
      case 'proc_missing': return v === 1;
      case 'unit_failed': return v === 1;
      case 'oom': return v > 0;
      default:
        if (rule.op === '<') return v < rule.threshold;
        if (rule.op === '==') return Math.abs(v - rule.threshold) < 0.01;
        return v > rule.threshold;
    }
  }

  function messageFor(rule, v) {
    const who = rule.target ? `（${rule.target}）` : '';
    switch (rule.metric) {
      case 'proc_missing': return `进程缺失：找不到 ${rule.target}${who}`;
      case 'unit_failed': return `服务异常：${rule.target} 处于 failed 状态`;
      case 'oom': return `发生了 ${v} 次 OOM 杀进程（内存不足）`;
      case 'disk': return `磁盘 ${rule.target} 使用率 ${v.toFixed(1)}%`;
      case 'psi_mem': return `内存压力 PSI ${v.toFixed(1)}%（进程在等内存回收）`;
      case 'swap': return `Swap 使用率 ${v.toFixed(1)}%`;
      case 'mem': return `内存使用率 ${v.toFixed(1)}%`;
      case 'cpu': return `CPU 使用率 ${v.toFixed(1)}%`;
      default: return `${rule.metric} = ${v}`;
    }
  }

  // ── 通知投递 ────────────────────────────────────────────────────────────
  // fnOS 桌面通知：直接写 trim.notify + trim.notify_user（官方通知表）
  async function deliverFnos(rule, message) {
    const title = `进程管家：${rule.name}`;
    const content = message.slice(0, 2000);
    const sql = `
WITH n AS (
  INSERT INTO notify (cat, level, title, source, content, dateandtime)
  VALUES (0, ${Number(rule.level) || 0}, ${sqlLit(title.slice(0, 250))}, 'fnproc',
          ${sqlLit(content)}, extract(epoch from now())::bigint)
  RETURNING id
)
INSERT INTO notify_user (uid, notify_id, read)
SELECT uid, id, 0 FROM users, n;`.trim();
    try {
      await execFileP('psql', ['-X', '-q', '-U', 'postgres', '-d', 'trim', '-v', 'ON_ERROR_STOP=1', '-c', sql],
        { timeout: 8000, encoding: 'utf8', maxBuffer: 1024 * 1024 });
      return { ok: true };
    } catch (e) {
      const msg = String(e.stderr || e.message || e).trim().split('\n')[0].slice(0, 200);
      return { ok: false, error: msg || 'psql 执行失败' };
    }
  }

  async function deliverWebhook(rule, message) {
    const url = String(rule.webhook || '').trim();
    const blocked = await webhookBlockReason(url);
    if (blocked) return { ok: false, error: blocked };
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 6000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'fnproc',
          rule: { id: rule.id, name: rule.name, metric: rule.metric, level: rule.level },
          message,
          host: ctx.host || '',
          ts: Date.now(),
          version,
        }),
        redirect: 'manual',          // 不跟随重定向，避免 302 绕过 SSRF 校验
        signal: ac.signal,
      });
      return res.ok ? { ok: true, status: res.status } : { ok: false, error: `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, error: e.name === 'AbortError' ? '超时（6 秒）' : String(e.message || e).slice(0, 160) };
    } finally {
      clearTimeout(to);
    }
  }

  async function fire(rule, value, { test = false } = {}) {
    const message = test ? `［测试］${messageFor(rule, value)}` : messageFor(rule, value);
    const delivered = {};
    if (rule.notifyFn) delivered.fnos = await deliverFnos(rule, message);
    if (rule.webhook) delivered.webhook = await deliverWebhook(rule, message);
    if (!rule.notifyFn && !rule.webhook) delivered.none = { ok: false, error: '未启用任何通知通道' };

    const ts = Date.now();
    const id = store.addEvent({
      ts, ruleId: rule.id, ruleName: rule.name, metric: rule.metric,
      value: Number(value) || 0, level: rule.level, message, delivered,
    });
    if (!test) store.touchFired(rule.id, ts);
    const allFailed = Object.values(delivered).every((d) => !d.ok);
    log(`[alert] ${test ? 'TEST ' : ''}${rule.name} → ${message} | 投递 ${allFailed ? '失败' : '成功'} ${JSON.stringify(delivered)}`);
    return { id, ts, message, delivered };
  }

  // ── 看门狗：进程不在就执行指定命令 ────────────────────────────────────────
  // 这是本项目唯一会「主动跑命令」的功能，风险面明确写在界面上：
  // 命令以 root 身份通过 /bin/sh -c 执行，只在启用且冷却期外执行一次。
  async function runWatchdogs() {
    const list = store.listWatchdogs().filter((w) => w.enabled);
    if (!list.length) return;
    for (const w of list) {
      const key = String(w.match || '').trim();
      if (!key) continue;
      const alive = /^\d+$/.test(key)
        ? ctx.procs.some((p) => p.pid === Number(key))
        : ctx.procs.some((p) => (p.name || '').toLowerCase() === key.toLowerCase()
            || (p.cmd || '').toLowerCase().includes(key.toLowerCase()));
      if (alive) continue;
      if (Date.now() - (w.lastRun || 0) < Math.max(30, w.cooldownSec) * 1000) continue;
      let out = { ok: false, error: '' };
      try {
        const { stdout, stderr } = await execFileP('/bin/sh', ['-c', w.command],
          { timeout: 15000, encoding: 'utf8', maxBuffer: 1024 * 1024 });
        out = { ok: true, stdout: String(stdout || '').slice(-400), stderr: String(stderr || '').slice(-200) };
      } catch (e) {
        out = { ok: false, error: String(e.stderr || e.message || e).slice(0, 300) };
      }
      store.touchWatchdog(w.id);
      const message = `看门狗「${w.name}」：未找到 ${w.match}，执行命令 ${out.ok ? '成功' : '失败（' + out.error + '）'}`;
      const delivered = {};
      if (w.command) delivered.watchdog = out;
      store.addEvent({
        ts: Date.now(), ruleId: 0, ruleName: w.name, metric: 'watchdog',
        value: 0, level: out.ok ? 1 : 2, message, delivered,
      });
      log(`[watchdog] ${message}`);
    }
  }

  // ── 判定主循环 ──────────────────────────────────────────────────────────
  async function evaluate() {
    if (!store.enabled || delivering) return;
    delivering = true;
    lastEvalAt = Date.now();
    beginRound();
    try {
      // 看门狗先跑（它只看进程在不在，很便宜；有命令才会真的执行）
      try { await runWatchdogs(); } catch (e) { log('[watchdog] 异常: ' + (e.message || e)); }

      // systemd 单元状态按需补一次（有 unit_failed 规则时）
      const rules = store.listRules().filter((r) => r.enabled);
      const needUnits = rules.some((r) => r.metric === 'unit_failed');
      if (needUnits && typeof getUnits === 'function') {
        try { ctx.units = await getUnits(); } catch { /* 用上次的 */ }
      }

      // 规则被删掉后清理它的计时状态，避免 Map 只增不减
      const aliveIds = new Set(rules.map((r) => r.id));
      for (const id of [...breachSince.keys()]) if (!aliveIds.has(id)) breachSince.delete(id);
      const liveSig = rules.map((r) => `${r.id}:${r.metric}:${r.op}:${r.threshold}:${r.durationSec}`).join('|');
      if (liveSig !== lastRuleSig) {
        // 阈值/判据改了就重置计时：否则沿用旧起点会在下一次判定立刻触发
        lastRuleSig = liveSig;
        breachSince.clear();
      }

      for (const rule of rules) {
        const v = valueOf(rule);
        if (v == null || !Number.isFinite(v)) { continue; }
        const hit = breached(rule, v);
        const since = breachSince.get(rule.id);
        if (!hit) {
          breachSince.delete(rule.id);
          state.set(rule.id, { value: v, breaching: false, sinceMs: 0 });
          continue;
        }
        if (!since) breachSince.set(rule.id, Date.now());
        const startMs = breachSince.get(rule.id) || Date.now();
        const heldMs = Date.now() - startMs;
        state.set(rule.id, { value: v, breaching: true, sinceMs: startMs });
        const needMs = Math.max(0, rule.durationSec) * 1000;
        const cooled = Date.now() - (rule.lastFired || 0) >= Math.max(30, rule.cooldownSec) * 1000;
        if (heldMs >= needMs && cooled) {
          await fire(rule, v);
          state.set(rule.id, { value: v, breaching: true, sinceMs: startMs });
        }
      }
    } catch (e) {
      log('[alert] 判定异常: ' + (e.message || e));
    } finally {
      delivering = false;
    }
  }

  return {
    start(intervalMs = 5000) {
      if (timer) return;
      timer = setInterval(() => { evaluate().catch(() => {}); }, intervalMs);
      if (timer.unref) timer.unref();
      log(`[alert] 告警引擎已启动（每 ${intervalMs / 1000} 秒判定一次，规则 ${store.listRules().filter((r) => r.enabled).length} 条）`);
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    setContext(next) { ctx = next; },
    evaluate,
    snapshot,
    watchdogs: () => store.listWatchdogs(),
    lastEvalAt: () => lastEvalAt,
    // 测试投递：不写 last_fired，不影响冷却
    async test(rule, value = 0) {
      return fire(rule, value, { test: true });
    },
    fire,
  };
}
