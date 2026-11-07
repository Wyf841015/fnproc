# 进程管家 · fnproc

现代化的 Linux 进程与系统资源管理器，飞牛 fnOS (fnOS) 应用形态，Web 界面适配桌面与手机。

## 功能（v0.1.0 MVP）

- 进程列表：PID / 名称 / 命令行 / CPU% / 内存 RSS / 线程 / 用户 / 状态 / CPU 时间，支持搜索与七种排序
- 进程详情：命令行、可执行文件、工作目录、文件描述符、环境变量数、OOM 分数、Swap、磁盘读写、子进程
- 发信号：TERM / KILL / STOP / CONT / HUP（二次确认 + 操作审计）
- 实时曲线：CPU 总体与每核、内存、Swap、负载、磁盘 IO、网络（SSE 推送，1 秒采样）
- 主题切换（深色 / 浅色）、移动端适配

## 实现要点

- 后端零依赖 Node ESM，数据全部来自 `/proc` 与 `/sys`，不引入第三方库
- 1 秒采样一次并缓存，`/api/processes` 只读缓存；每进程 CPU% 由两次 `utime+stime` 差值归一化得到
- `cmdline` / `io` / `uid` 带 TTL 缓存，进程消失即清理对应 Map（长期运行不涨内存）
- SSE 响应带 `X-Accel-Buffering: no`（fnOS 网关是 nginx，不加会被缓冲住）
- 前端不使用 inline onclick（fnOS WebView/CEF 上不可靠），统一 addEventListener + 事件委托

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/overview` | 系统概览 + 历史采样 + 主机信息 |
| GET | `/api/processes?q=&sort=&limit=` | 进程列表（sort: cpu/mem/pid/name/time/threads/start） |
| GET | `/api/process/:pid` | 单进程详情 |
| POST | `/api/kill` | `{pid, signal, confirm:true}` 发信号 |
| GET | `/api/audit` | 最近操作记录 |
| GET | `/api/stream` | SSE 实时快照 |
| GET | `/api/health` | 健康检查 |

## 安全约束

- 以 root 运行（读取全量 /proc、发信号需要）
- 拒绝 `PID <= 1` 与自身 PID；信号白名单限 8 种；必须带 `confirm: true`
- 所有操作写入内存审计环（最近 100 条），界面展示最近 20 条

## 构建

```bash
cd /vol3/1000/hermes/fnproc && fnpack build .
```
