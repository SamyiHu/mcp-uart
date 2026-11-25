# 串口面板与 Agent 工具

在 DSH 里直接用的串口调试台。**一个插件同时提供面板和 Agent 工具**，两者共用
同一个串口会话：Agent 打开的口，面板里能实时看到同样的 TX/RX；面板发出的数据
Agent 也读得到。

## 架构：插件自己管 Hub

```
dsh-uart 插件 (Host)
├─ 启动本地 Hub（dist/hub.js 子进程，端口 8787 起，占用则顺延）
├─ 把 /uart/* 代理到该 Hub（含 SSE 帧流）
├─ 注册 3 个 Agent 工具：uart_serial / uart_dut / uart_view
└─ client.js 渲染侧边栏面板 / 悬浮球 / 底栏状态条
```

插件不再依赖外部 `mcp-uart` MCP 服务：bundle 的 patch 里没有 MCP 行，DSH 会话
看不到任何 `mcp__uart__*` 工具。插件卸载时 Hub 子进程随之退出，不留孤儿进程。

## Agent 工具（3 个，不是 28 个）

| 工具 | 覆盖 |
|---|---|
| `uart_serial` | 列端口、连接/断开、收发、等待、DTR/RTS/Break、在线改编码与分帧 |
| `uart_dut` | DUT profile 列表、连接、单命令、冒烟序列、状态 |
| `uart_view` | 面板/Hub 状态、实时帧、历史帧（按文本或 HEX 搜索）、端口明细 |

分组的原因：MCP 版 28 个工具每轮请求要带约 16.5 KB schema（约 4100 token），
名字又高度相似容易选错。分组后 schema 约 900 token。

工具调用走 Hub 的 HTTP API——和面板完全同一条路径，不存在两套串口逻辑。

## 开关：设置页 → Agent 工具

- 默认**开**；关掉后三个工具立即从模型侧消失（运行时注销，无需重启）
- 偏好存在 `~/.mcp-uart/agent.json`，`config.agentTool: false` 可作为强制默认
- 设置 → 串口控制台 与 设置 → 插件 → 串口 两处是同一个开关

## 一套界面，两种载体

界面只写一次：`src/hub/public/uart-ui.js`（无框架 ESM 模块）。两种模式挂载的
是**同一个文件**：

- 浏览器模式：Hub 页面 `index.html → app.js → uart-ui.js`
- DSH 模式：本插件 `client.js` 内联同一份 UI，挂到侧边栏面板

布局、交互、文案完全一致；差别只有配色来源——DSH 内用主题变量
（`--dsw-alias-*`），浏览器里用同结构的内置浅色/深色回退值（跟随
`prefers-color-scheme`）。

## 功能

- 串口选择、波特率 / 数据位 / 校验 / 停止位 / 编码 / 分帧协议
- 连接、停止监视、断开；信号 DTR / RTS / Break
- 实时帧带：TX/RX 双色、时间戳、字节数、HEX 与 ASCII 并列，固定高度内滚动
- 过滤：方向、HEX 子串、文本子串；跟随滚动、清空
- 发送框：文本 + 行尾（CRLF / LF / 无），Ctrl+Enter 发送
- 顶部速率折线（60 秒窗口）与 RX/TX 比例条
- 三种放置：工作区面板 / 悬浮球 / 底栏状态条

## 外部（非 DSH）用法

同一套后端也是标准 MCP 服务器，给 Cursor、Claude Code 等客户端用，28 个工具
全量。这是独立进程，与本插件无关：

```bash
node dist/index.js        # MCP server，Hub 随进程启动，stderr 打印 URL
npx mcp-uart-hub --port 8787   # 只起 Web Hub
```

浏览器打开打印出的地址即可，功能和面板一致。契约测试对这一条同样成立：

```bash
node test/hub-contract-test.mjs http://127.0.0.1:8787/   # 独立 Hub
node test/hub-contract-test.mjs http://127.0.0.1:<port>/uart/  # DSH 代理
```

## 限制

- 面板只驱动本机串口；远程会话里打开面板会连到那台机器的 Hub
- 同一时刻只监视一个连接（Hub 的单连接策略），切换连接会清空帧带
- Hub 子进程起不来时（例如未 `npm run build`），面板显示离线诊断，
  `/uart/tools` 会返回具体错误；可用 `config.externalHub: true` 改为连接
  一个手工启动的 Hub
