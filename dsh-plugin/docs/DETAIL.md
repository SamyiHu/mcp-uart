# 串口面板

在 DSH 里直接用的串口调试台。它不是一个独立程序：面板和后端都挂在正在运行的 `mcp-uart` MCP 服务上，所以 **Agent 用 MCP 工具打开的串口，面板里能实时看到同样的 TX/RX 帧**，反过来面板发出的数据 Agent 也能读到。

## 一套界面，两种载体

界面只写一次：`src/hub/public/uart-ui.js`（无框架 ESM 模块）。两种模式挂载的是**同一个文件**：

- 浏览器模式：Hub 页面 `index.html → app.js → uart-ui.js`
- DSH 模式：本插件 `client.js` 通过 `/uart` 代理动态加载同一个 `uart-ui.js`，挂到侧边栏面板里

所以两种模式的布局、交互、文案完全一致；差别只有配色来源——DSH 内用主题变量（`--dsw-alias-*`），浏览器里用同一结构的内置浅色/深色回退值（跟随 `prefers-color-scheme`）。


## 功能

- 串口选择（列出本机串口）、波特率 / 数据位 / 校验 / 停止位 / 编码 / 协议
- 连接、停止监视（不关闭 MCP 打开的串口）、断开串口
- 实时帧带：TX/RX 双色轨、时间戳、字节数、HEX 与 ASCII 并排
- 过滤：方向、HEX 子串、文本子串；跟随滚动、清空
- 发送框：文本 + 行尾（CRLF / LF / 无），Ctrl+Enter 发送
- 信号：DTR / RTS 电平与 Break 脉冲
- 侧边栏图标进入，面板占主区；右上角「在浏览器打开」用同一套 Web UI

## 它怎么和 MCP 共用一个串口

`mcp-uart` 进程里本来就有一个 SerialManager 和一个 HTTP Hub（默认 8787 起，端口被占用时自动顺延）。MCP 工具打开串口时会把连接挂到 Hub 上；本插件不新开串口栈，而是：

1. 读发现文件 `~/.mcp-uart/hub.json`（MCP 服务启动时原子写入，含 URL / 端口 / pid），或
2. 探测 `127.0.0.1:8787..8817` 的 `/api/health`

找到 Hub 后，把 `/uart/*` 反向代理到它（含 SSE 帧流），面板与 Agent 因此共用同一个会话。

## 没有 DSH 时

同一套 API 与同一套 Web UI 在 DSH 之外照常可用，插件只是多一个前端：

```bash
# 作为 MCP 服务运行时，Hub 随进程启动，stderr 打印 URL
node dist/index.js

# 或单独起一个纯 Web 版（同样写发现文件）
npx mcp-uart-hub --port 8787
```

浏览器打开打印出的地址即可，功能和面板一致。契约测试对这一条同样成立：

```bash
node test/hub-contract-test.mjs http://127.0.0.1:8787/   # 独立 Hub
node test/hub-contract-test.mjs http://127.0.0.1:50031/uart/  # DSH 代理
```

## 限制

- 面板只驱动本机串口；远程会话里打开面板会连到那台机器上的 Hub。
- 同一时刻只监视一个连接（Hub 的单连接策略），切换连接会清空帧带。
- 依赖 `mcp-uart` MCP 服务在运行；它不在时面板显示「Hub 离线」并给出启动提示。
