# 进程管家 · fnproc

现代化的 Linux 进程与系统资源管理器，飞牛 fnOS (fnOS) 应用形态，Web 界面适配桌面与手机。

## v0.4.0 更新

### 历史数据落盘（重启不再清空）

- 每 30 秒把当前指标追加一行 JSON 到 `<PKGVAR>/data/history.jsonl`
  （字段：ts / cpu / mem / swap / load1 / rd / wr / rx / tx）
- 图表新增时间范围选择：**实时 60 秒**（内存数据，1 秒粒度）/ 10 分钟 / 1 小时 / 6 小时 / 24 小时
- 长时段从文件读，超过 240 点自动下采样，避免把曲线画花
- 文件超过 8MB 自动轮转，只保留最后 3000 行（约 25 小时）
- 写盘失败只记一条警告、不影响监控主功能；`/api/history?minutes=N` 返回区间数据

为什么 30 秒而不是 1 秒：24 小时 × 1 秒 = 8.6 万行，磁盘和读取都不划算；
监控趋势看 30 秒粒度足够，实时那 60 秒仍由内存里的 1 秒采样提供。

## v0.3.0 更新

### 新增「服务」视图（systemd）

- 列出全部 service（本机 239 个：运行中 129 / 失败 3），支持按状态筛选（全部 / 运行中 / 未运行 / 失败）与关键字搜索
- 每行可直接 **启动 / 停止 / 重启**，全部走二次确认，并写入操作审计
- 状态徽章区分 运行中 / 未运行 / 失败，并显示 systemd 的 sub 状态（running / exited / failed / dead）

### 安全约束（服务操作比杀进程更危险，所以卡得更死）

- 服务名必须匹配 `^[A-Za-z0-9@._:\-]+\.service$`，路径穿越、分号注入、不带 `.service` 后缀的一律拒绝
- 关键服务黑名单禁止 stop/restart（只允许 start，用于救回来）：
  `ssh/sshd`、`dbus`、`systemd-logind`、`systemd-journald`、`systemd-udevd`、
  `systemd-networkd`、`networking`、`NetworkManager`、`cron`
- 动作白名单只有 start/stop/restart；必须带 `confirm: true`
- 界面上这些按钮直接置灰并带提示，不是只在后端拦

实测拒绝用例：`../../../etc/passwd`、`trim_app_center`（无 .service）、`ssh.service;id`、
`sshd.service` 的 stop/restart、`action=nuke`、缺 confirm —— 全部 400 且给出中文原因。

## v0.2.0 更新

### 新增四个视图

- **列表**：原进程表，新增「容器」列（chips 可点击，点了只看该容器的进程）
- **树**：按 `ppid` 还原进程树，可逐级折叠/展开，父节点显示「子树合计 CPU / 内存」
- **端口**：按端口号列出所有监听端口（TCP LISTEN + UDP），含协议、监听地址、占用进程、用户、容器
- **容器**：按 docker 容器聚合进程数 / CPU / 内存 / 线程，一键跳到该容器的进程列表

### 端口归属是怎么算出来的

`/proc/net/{tcp,tcp6,udp,udp6}` 只给出 socket 的 inode，没有 pid。要回答「谁占了 8080」
得反过来扫 `/proc/<pid>/fd` 里的 `socket:[inode]` 去对表。这步比较贵（几百个进程 ×
每个几十个 fd），所以放在 **10 秒**的独立定时器里跑，不塞进 1 秒的主采样循环。
实测本机（root 运行）解析出 **107 个监听端口**，进程名、命令行、用户都对得上。

已知限制：容器内的进程用的是自己的 network namespace，它的 socket inode 不出现在宿主的
`/proc/net/tcp` 里，所以容器进程的端口列不出来 —— 这是 namespace 隔离的正常结果，不是 bug。

### 容器归属

从 `/proc/<pid>/cgroup` 里匹配 `docker/<64位hex>` 或 `docker-<64位hex>.scope`，取前 12 位；
容器名通过 `docker ps --no-trunc` 解析（15 秒节流一次，docker 不可用时静默降级为短 ID）。
只认 64 位 hex，避免把 systemd 的 slice 误判成容器。实测识别出 mtphotos、It-tools。

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
| GET | `/api/ports` | 监听端口（含占用进程 / 用户 / 容器） |
| GET | `/api/containers` | 容器维度聚合（进程数 / CPU / 内存 / 线程） |
| GET | `/api/history?minutes=` | 历史曲线数据（落盘，最多 24 小时，下采样到 240 点） |
| GET | `/api/services?q=&state=` | systemd 服务列表（state: running/stopped/failed） |
| POST | `/api/service` | `{name, action: start\|stop\|restart, confirm:true}` |
| GET | `/api/processes?container=` | 按容器名或短 ID 过滤进程 |
| GET | `/api/health` | 健康检查 |

## 安全约束

- 以 root 运行（读取全量 /proc、发信号需要）
- 拒绝 `PID <= 1` 与自身 PID；信号白名单限 8 种；必须带 `confirm: true`
- 所有操作写入内存审计环（最近 100 条），界面展示最近 20 条

## 构建

```bash
cd /vol3/1000/hermes/fnproc && fnpack build .
```
