# 串口面板与 Agent 工具

在 DSH 里直接用的串口调试台。面板和 Agent 工具共用同一个串口会话：Agent 打开
的口，面板里能实时看到同样的 TX/RX；面板发出的数据 Agent 也读得到。

## 组成

| 部分 | 作用 |
|---|---|
| 面板 | 侧边栏「串口」页：连接、实时帧、过滤、发送、调制解调器信号 |
| 悬浮球 | 右下角圆球，悬停展开为胶囊，点击打开完整控制台 |
| 底栏状态条 | 输入框下方一行状态，点「展开」以悬浮窗打开控制台 |
| Agent 工具 | `uart_serial` / `uart_orchestrator` / `uart_view`，见下节 |

插件在后台启动一个本地 Hub（`dist/hub.js` 子进程，端口从 8787 起，占用则顺延），
面板与工具都通过它访问同一个串口会话。

## Agent 工具

| 工具 | 覆盖 |
|---|---|
| `uart_serial` | 列端口、连接/断开、收发、等待、DTR/RTS/Break、在线改编码与分帧 |
| `uart_orchestrator` | 编排配置列表、连接、单命令、冒烟序列、状态 |
| `uart_view` | 面板/Hub 状态、实时帧、历史帧（按文本或 HEX 搜索）、端口明细 |

开关在 设置 → 串口控制台 → 「Agent 工具」，默认开启。关掉后工具立即从模型侧
移除，面板照常可用；偏好保存在 `~/.mcp-uart/agent.json`。

装入 MCP 串口行时，这三个工具会自动让位，避免同一串口出现两套工具。

## 功能

- 串口选择、波特率 / 数据位 / 校验 / 停止位 / 编码 / 分帧协议
- 连接、停止监视、断开；信号 DTR / RTS / Break
- 实时帧带：TX/RX 双色、时间戳、字节数、HEX 与 ASCII 并列，固定高度内滚动
- 过滤：方向、HEX 子串、文本子串；跟随滚动、清空
- 发送框：文本 + 行尾（CRLF / LF / 无），Ctrl+Enter 发送
- 顶部速率折线（60 秒窗口）与收发计数
- 编排页：配置选择、冒烟测试、单命令执行、结果复制与展开

## 外部（非 DSH）用法

同一套后端也是标准 MCP 服务器，给 Cursor、Claude Code 等客户端用，工具面与
DSH 内一致（`uart_serial` / `uart_orchestrator` / `uart_view`）：

```bash
mcp-uart                         # MCP 服务器（原生 uartd），stderr 打印地址
npx mcp-uart-hub --port 8787     # 只起 Web Hub（原生 uartd）
```

浏览器打开打印出的地址即可，功能和面板一致。

## 限制

- 面板只驱动本机串口；远程会话里打开面板会连到那台机器的 Hub
- 同一时刻只监视一个连接，切换连接会清空帧带
- Hub 起不来时（例如未 `npm run build`），面板显示离线诊断，
  `/uart/tools` 返回具体错误；可用 `config.externalHub: true` 连接一个手工
  启动的 Hub
