# 进程管家 · fnproc

现代化的 Linux 进程与系统资源管理器，飞牛 fnOS (fnOS) 应用形态，Web 界面适配桌面与手机。

## v0.6.0 更新

### 新增赞助与反馈入口

顶栏加了两个按钮（和作者其它应用保持一致）：

- **❤ 赞助作者**：弹窗展示支付宝 / 微信收款码，点击二维码可全屏放大，手机上长按即可识别
- **✉️ 反馈与交流**：弹窗给出 QQ 群号（一键复制）、项目主页，以及提问题时建议附带的信息（版本号、
  复现步骤、相关进程的 PID / 命令行）

### 实现细节

- 二维码图片按 **JPEG** 保存并登记 MIME（`.jpg → image/jpeg`）。原来是 `.png` 扩展名的 JPEG，
  在带 `X-Content-Type-Options: nosniff` 的静态服务下容易被浏览器拒绝渲染
- 复制走 `navigator.clipboard` → `document.execCommand('copy')` 双路径兜底：
  fnOS WebView 经常不是安全上下文，只靠 Clipboard API 会「点了没反应」
- 弹层按钮用 DOM 0 级 `element.onclick` 绑定（fnOS WebView 上比 addEventListener 稳）
- Esc 键、点遮罩空白处都能关闭；`[hidden]` 由 v0.5.0 那条 `!important` 规则接管，不会再挡住页面

实测（真实鼠标事件 Input.dispatchMouseEvent）
- 点 ❤ → 弹层 display:grid / opacity:1，两张二维码 naturalSize 640×959 均已加载
- 点二维码 → 放大层打开且图片已加载；点空白 → 关闭；Esc → 弹层关闭
- 点 ✉ → QQ 群号 745565752、项目主页（target=_blank）、3 条提问建议齐全
- 点「复制」→ toast「已复制 QQ 群号 745565752」
- 控制台 0 报错

## v0.5.1 更新

### 修复：概览里的图表不显示（canvas → SVG）

根因是 **canvas 在 fnOS WebView 里量不到宽度**。原实现用 `canvas.clientWidth` 定
绘图缓冲区大小，而 fnOS 的 WebView（CEF）里这个值经常是 0（父级是 flex 项、或布局
晚于脚本执行时尤其明显）。一旦在 0 宽时执行 `canvas.width = 0 * dpr` 兜底成 1，
缓冲区就被永久锁死在 1 个设备像素上——之后每秒都在往这个 1px 宽的画布里画，CSS 把
它拉伸到 330px，用户看到的就是一片空白。

试过的补救（都在浏览器里"看起来正常"、到 WebView 里仍然栽）：
强制按父元素 `getBoundingClientRect()` 量宽、每次绘制前重新量、缓存数据后 resize
重绘、ResizeObserver + 多次延迟重试。这些能缓解，但只要有一次在 0 宽状态下先画了
一帧，缓冲区就已经坏了。

**最终改成 SVG**：一条曲线一个 `<polyline>`，面积用 `<polygon>`，坐标写进
`viewBox="0 0 300 100"` 的虚拟坐标系，靠 `preserveAspectRatio="none"` 自适应容器
宽度。SVG 根本不需要 JS 量尺寸，也就没有「缓冲区锁死」这个坑，顺带天然适配
高分屏。线条用 `vector-effect: non-scaling-stroke` 保证拉伸后粗细不变。

```
<svg class="chart" viewBox="0 0 300 100" preserveAspectRatio="none">
  <line class="grid-line">×3
  <polygon fill="...">      ← 面积
  <polyline stroke="...">   ← 曲线
</svg>
```

实测（截图逐像素核验，不靠肉眼）：
- CPU 图区域内蓝色曲线像素 727、颜色种类 225（纯背景时 <20）
- 内存图紫线 444 像素、Swap 橙线 331 像素
- 三张图 `viewBox` 正确、polyline 的 `points` 长度 211~1229 字符随数据量变化
- 切走 tab 再切回、切「最近 1 小时」都正常重绘，控制台 0 报错

## v0.5.0 更新

### 修复：所有按钮点不动

根因是 CSS 优先级，不是 JS。`.modal-mask` 写了 `display: grid`，而浏览器对
`hidden` 属性的内置样式是 `[hidden] { display: none }`，**作者样式优先级高于
内置样式** —— 于是那个 `position: fixed; inset: 0; z-index: 60` 的全屏遮罩虽然
`opacity: 0` 看不见，却一直盖在页面上吃掉所有点击。表现为「页面能看，按钮全点不动」。

修法是加一条：

```css
[hidden] { display: none !important; }
```

顺带记录一个教训：`element.click()` 是程序化派发，**不走命中测试**，所以自动化测试里
按钮全都「正常」。这次改用 CDP 的 `Input.dispatchMouseEvent` 发真实鼠标事件
（会走 `document.elementFromPoint` 那一层命中测试）才把问题暴露出来。

### 改进：功能按 tab 卡片分类

原来所有内容堆在一页（KPI + 图表 + 进程表 + 操作记录），现在按功能拆成 6 个 tab：

| Tab | 内容 |
|---|---|
| 📈 概览 | 三张实时图表 + 时间范围切换 |
| ⚙️ 进程 | 列表 / 树 子视图 + 搜索排序（角标显示进程总数） |
| 🔌 端口 | 监听端口及其占用进程（角标显示端口数） |
| 📦 容器 | docker 容器聚合（角标显示容器数） |
| 🛠 服务 | systemd 服务启停（角标显示失败数，有失败时变红） |
| 📝 记录 | 发信号 / 服务操作审计 |

KPI 概览条保持全局常驻，切到任何 tab 都能看到 CPU / 内存 / 负载。移动端 tab 横向
滚动、图标隐藏只留文字。

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
