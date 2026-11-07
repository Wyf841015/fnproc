# 进程管家 · fnproc

fnOS 上的进程与系统资源管理器。**零依赖**：只用 Node.js 内置模块直接读 `/proc`，
不装第三方库、不连外部服务、不采集数据、不上传任何东西。

![version](https://img.shields.io/badge/version-0.1.0-blue)
![deps](https://img.shields.io/badge/dependencies-0-brightgreen)

打开就能看清整机在跑什么：谁在吃 CPU、8080 被哪个进程占了、哪个 systemd 服务挂了，
并且可以直接对进程发信号、对服务做启停 —— 全部在一个页面里完成。

---

## 功能

### 概览

- 六张 KPI 卡：CPU、内存、Swap、负载、进程数、磁盘读写 / 网络收发
- 三张曲线：CPU、内存 + Swap、磁盘 + 网络
- 时间范围六档：最近 60 秒 / 10 分钟 / 1 小时 / 6 小时 / 24 小时
- 历史数据每 30 秒落盘，自动保留约 25 小时

### 进程

- **列表**：按 CPU / 内存 / PID 排序，支持搜索；显示用户、CPU%、内存、命令行
- **树**：按父子关系展开折叠，父节点显示整棵子树的 CPU / 内存合计
- **详情**：命令行、可执行文件、工作目录、状态、线程数、文件描述符、OOM 分数、
  Swap、磁盘读写、子进程、启动时间
- **发信号**：TERM / HUP / INT / QUIT / USR1 / USR2 / KILL / STOP / CONT

### 端口

监听端口一览，并把每个端口精确归属到进程。做法是扫 `/proc/<pid>/fd` 里的
`socket:[inode]`，反过来对 `/proc/net/{tcp,tcp6,udp,udp6}` 的 inode 表 ——
因为 `/proc/net/*` 只给 inode、不给 pid。

### 容器

Docker 容器聚合（进程数 / CPU / 内存 / 线程），可一键只看某个容器里的进程。
容器归属从 `/proc/<pid>/cgroup` 里匹配 `docker/<64位hex>`，只认 64 位 hex，
不会把 systemd 的 slice 误当成容器。

### 服务

systemd 服务列表（运行中 / 未运行 / 失败），支持启动、停止、重启，失败的单元标红。
关键服务（ssh、dbus、systemd-*、networking、NetworkManager、cron）只允许启动，
界面上按钮直接置灰 —— 避免手滑把自己锁在门外。

### 记录

发信号与服务操作的审计，最近 100 条留在内存环里，界面展示最近 20 条。

### 其它

- 内置**赞助**（支付宝 / 微信收款码，点击放大）与**反馈**（QQ 群一键复制）入口
- 亮色 / 暗色主题一键切换
- 顶栏为「标题行 + 状态操作行」两行结构，窄屏也不挤；桌面与手机自适应

---

## 安装

在 fnOS 应用中心安装 `fnproc.fpk`，或命令行：

```bash
appcenter-cli install-fpk fnproc.fpk
appcenter-cli start fnproc
```

依赖 `nodejs_v24`，已在 `manifest` 的 `install_dep_apps` 中声明，装应用时自动装好。

访问：`https://<你的 NAS>/app/fnproc`

---

## 数据与日志

| 内容 | 路径 | 说明 |
|---|---|---|
| 历史数据 | `<TRM_PKGVAR>/data/history.jsonl` | 30 秒一行 JSON，超 8 MB 自动轮转，约保留 25 小时 |
| 运行日志 | `<TRM_PKGVAR>/info.log` | 启动、异常、采样失败等 |
| PID 文件 | `<TRM_PKGVAR>/app.pid` | — |

进程管家**不读取、不修改任何用户文件**，也不向外发送数据 —— 它只看 `/proc` 与 `/sys`。

---

## 接口

全部走网关 Unix socket（`/var/apps/fnproc/target/fnproc.sock`），不对外监听端口。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查（版本、进程数、SSE 客户端数） |
| GET | `/api/overview` | 系统概览 + 历史采样 + 主机信息 |
| GET | `/api/processes` | 进程列表（`?q=` `?sort=` `?limit=` `?container=`） |
| GET | `/api/process/<pid>` | 单进程详情 |
| POST | `/api/kill` | `{pid, signal, confirm:true}` 发信号 |
| GET | `/api/ports` | 监听端口 + 占用进程 / 用户 / 容器 |
| GET | `/api/containers` | 容器维度聚合 |
| GET | `/api/services` | systemd 服务列表（`?q=` `?state=`） |
| POST | `/api/service` | `{name, action: start\|stop\|restart, confirm:true}` |
| GET | `/api/history` | 历史曲线（`?minutes=N`，最多 24 小时，下采样到 240 点） |
| GET | `/api/audit` | 最近操作记录 |
| GET | `/api/stream` | SSE 实时快照 |

---

## 安全约束

进程管家以 **root** 运行（读全量 `/proc`、扫 `/proc/<pid>/fd`、操作 systemd 都需要），
所以每条写操作都带闸门：

- 拒绝 `pid <= 1`（init 与内核线程）以及**自身 PID**
- 信号只接受白名单里的 8 种，其余一律拒绝
- 所有写接口必须带 `confirm: true`
- systemd 单元名必须匹配 `^[A-Za-z0-9@._:\-]+\.service$`，堵住路径穿越与命令注入
- 关键服务（ssh / sshd / dbus / systemd-* / networking / NetworkManager / cron）
  只允许 start
- 每次发信号、每次服务操作都写一条审计

---

## 实现要点

- 后端零依赖 Node ESM，数据全部来自 `/proc` 与 `/sys`
- 1 秒采样一次并缓存，`/api/processes` 只读缓存；进程 CPU% 由两次
  `utime+stime` 差值除以同一区间 `/proc/stat` 的 jiffies 增量得到
- `cmdline` / `io` / `uid` 带 TTL 缓存，进程消失即清理对应 Map（长期运行不涨内存）
- 端口归属较贵（几百个进程 × 每个几十个 fd），放在 10 秒的独立定时器里跑，
  不塞进 1 秒主采样循环
- SSE 响应带 `X-Accel-Buffering: no`（fnOS 网关是 nginx，不加会被缓冲住）
- **曲线用 SVG 而不是 canvas**：canvas 在 fnOS WebView 里量不到宽度时缓冲区会被锁成
  1 像素，表现为「图表不显示」；SVG 靠 `viewBox` 自适应，天生没这个问题
- 前端不用 inline onclick（fnOS WebView/CEF 上不可靠），统一事件绑定 + 事件委托；
  静态资源带版本查询串（`?v=0.1.0`），避免 WebView 用旧缓存

---

## 构建

```bash
fnpack build .
```

产物 `fnproc.fpk` 在当前目录。前端是原生 JS + SVG，没有构建步骤，改完直接打包。

---

## 版本历史

### v0.1.0 首发

六个视图，KPI 概览条全局常驻：

| Tab | 内容 |
|---|---|
| 📈 概览 | 三张曲线 + 时间范围切换 |
| ⚙️ 进程 | 列表 / 树 + 搜索排序（角标显示进程总数） |
| 🔌 端口 | 监听端口与占用进程（角标显示端口数） |
| 📦 容器 | Docker 容器聚合（角标显示容器数） |
| 🛠 服务 | systemd 服务启停（角标显示失败数，有失败时变红） |
| 📝 记录 | 发信号 / 服务操作审计 |

- 进程：列表 + 树 + 详情 + 9 种信号，CPU% 按两次采样的增量计算
- 端口：`/proc/<pid>/fd` 的 socket inode 反查 `/proc/net/*`，归属到具体进程
- 容器：cgroup 识别 + docker 名称解析，支持按容器过滤进程
- 服务：systemd 单元启停，关键服务保护
- 历史落盘：30 秒粒度、8 MB 轮转、60 秒 ~ 24 小时六档范围
- 顶栏两行结构：标题行只放名称与主机信息，状态胶囊与赞助 / 反馈 / 主题按钮独立成行
- 赞助与反馈：收款码点击放大、QQ 群一键复制
- 亮色 / 暗色主题，桌面与手机自适应
