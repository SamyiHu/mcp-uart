# 设计规格：DSH 专用工具 + 外部 MCP 双模式

> 状态：**已实现**（2026-11-25）。落地文件：
> - `dsh-plugin/hub-host.js` — Hub 子进程生命周期（spawn `dist/hub.js`，解析 `HUB_URL=`，退出时回收）
> - `dsh-plugin/agent-tools.js` — 3 个分组工具，走 Hub HTTP API
> - `dsh-plugin/index.js` — 自启 Hub + `/uart/agent` 开关 + `/uart/tools` 诊断
> - `dsh-plugin/cordis.patch.yml` — 只留面板行，无 MCP 行
> - `dsh-plugin/client.template.js` — 设置页「Agent 工具」开关
>
> 验证：`test/dsh-agent-tools-test.mjs`（工具形状/patch 断言）+ `test/dsh-client-test.mjs`
> （设置页渲染）；实机跑通——3 个工具在注册表中 `present:true`，开关切到 false 后
> 全部消失、切回恢复，Hub 子进程随实例退出而回收。

## 1. 目标与动机

同一套串口能力要服务两类用户，诉求不同：

| 用户 | 诉求 | 现状问题 |
|---|---|---|
| **DSH 用户** | 少而精的 Agent 工具 + 可视化面板；工具不该干扰上下文 | MCP 行注册了 28 个 `mcp__uart__*`，schema 约 16.5 KB / 4100 token，且名字相近易选错 |
| **外部用户**（Cursor / Claude Code / 其他 MCP 客户端） | 标准 MCP 接口，完整工具集 | 现状已满足，应保留 |

目标：**DSH 里看不到 MCP 工具，只有专用工具 + 页面；外部用户继续用 MCP。**

## 2. 参照物：visio 插件

`dsh-visio` 已经是这个模式的实例（已核实其源码 `index.js` / `client.js`）：

- 工具用 `ctx.tools.register()` **直接注册为 Agent 工具**，不是 MCP：
  ```js
  tools.register({
    name: 'visio',
    parameters: { action: { enum: [...30+ 项] }, path: {...}, ... },
    output: { schema: {...} },
    execute: (args) => { switch (args.action) { ... } },
  })
  ```
  30 多种操作合成**一个工具**，靠 `action` 枚举分派。
- 开关叫 `agentTool`：
  - patch 里 `config.agentTool: true`（默认）
  - 面板头部有 `Agent 开/关` 按钮 → `POST /dsh-visio/agent {enabled}`
  - Host 的 `syncAgentTool()` 调 `register()` 返回的 disposer 实现**运行时**注册/卸载
  - 选择持久化在 `~/.dsh`

**本设计与 visio 的唯一分歧：开关位置。**
visio 把开关放在面板头部；本设计把开关放在**设置页**（`settings.section` 的
「串口控制台」与 `settings.plugins.tab` 的插件页，两处同一组件），因为工具权限
属于配置而非面板状态，且与现有的「底栏状态条」「自动滚到最新」「数据解码」
三个开关归在一起。功能行为一致：运行时注册/卸载，无需重启。

## 3. DSH 提供的机制（已核实）

来源：当前安装的 `docs/subsystems/tools.md`、`@deepseek-ai/dsh-mcp-client` 源码与 README。

| 机制 | 说明 | 适用性 |
|---|---|---|
| `ctx.tools.register(def, options)` | Host 插件直接注册工具，返回 disposer | **采用**：专用工具 |
| `ctx.tools.restrict({ allow?, deny? })` | 某作用域对其**继承的全局工具**做过滤；scope-local 注册不受影响 | 备选；本设计不用（去掉 MCP 行即可，无需隐藏） |
| 注册选项 `when` | 按模型/步骤动态决定是否暴露 | 暂不用 |
| `dsh-mcp-client` 的 Config | transport/serverName/command/url/超时/重连等 | **无工具过滤字段**，不能靠 YAML 实现 |
| `ToolRestriction` | 类型本身存在，供 subagent / preset scope 使用 | 主 Agent 全局工具不适用 |

结论：让 DSH 用户看不到 MCP 工具，最干净的办法是**在 bundle patch 里不装 MCP 行**，
而不是靠过滤把已注册的工具藏起来。

## 4. 目标架构

```
dsh-plugin/                      一个 bundle
├── cordis.patch.yml
│     - insert: id=local-uart, name=@local/dsh-uart   ← 只保留面板行
│     （不再 insert mcp-uart / dsh-mcp-client）
├── index.js (Host)
│     ├─ 自启 Hub：spawn 子进程 node dist/hub.js --port 8787
│     │     解析 stderr 的 HUB_URL= 得到真实地址（端口顺延也成立）
│     │     ctx.effect 里 kill 子进程，退出即回收
│     ├─ 注册 /uart/* 代理到该 Hub（SSE 原样透传）
│     ├─ 注册 /uart/agent GET|POST：读写「Agent 工具」开关
│     └─ 按开关注册/卸载 3 个专用工具（内部走 Hub HTTP API）
├── client.js（由 client.template.js + uart-ui.js 生成）
│     ├─ 面板 / 悬浮球 / 底栏状态条（现状不变）
│     └─ 设置页新增 ToggleRow「Agent 工具」
└── icon.svg / locale / docs

外部用户（非 DSH）
└─ node dist/index.js  ← 原样保留，MCP server + 自带 Hub，28 个工具全量
```

> **为什么用子进程而不是在插件里 `import` Hub 模块**
> 插件跑在 Electron 主进程里。`@serialport/bindings-cpp` 虽然用的是 NAPI 8
> （ABI 稳定），但在宿主的 Node 版本上加载失败会让整个插件崩掉，连带面板一起没了。
> 子进程把这一步隔离出去：崩了只是 Hub 不可用，插件和面板还能给出诊断。
> 而且 `dist/hub.js` 已经是现成的独立入口（`npx mcp-uart-hub`），不必新写。
> 代价是多一个 Node 进程（约 45MB）；等 Rust `uartd` 就绪后换成它，这 45MB 也就消失了。

三者关系：

- **DSH 的 Hub** 由 Host 插件以子进程方式启动，面板和专用工具都连它。
- **外部 MCP 的 Hub** 由 `dist/index.js` 自己启动（现状）。
- 两者是**独立串口会话**，不共享端口占用；各自发现/占用自己的串口。
  这是有意的：避免两个进程抢同一个 COM 口。若将来要共享，可复用
  `~/.mcp-uart/hub.json` 做单一 Hub 发现，但那属于后续演进。

## 5. 专用工具（少数分组，推荐 3 个）

不做 visio 式的单工具（40+ 属性 schema 可读性差），也不保留 28 个。分 3 个：

| 工具 | 覆盖 | 对应现有 MCP 工具 |
|---|---|---|
| `uart_serial` | 列端口、开/关、读写、等待、信号、编码/协议设置 | 15 个 `serial_*` |
| `uart_dut` | profile 列表、连接、单命令、smoke、序列、提取 | 10 个 `dut_*` |
| `uart_view` | 可视化（帧表/冒烟报告 HTML）、面板状态 | 3 个 `serial_visualize*` + `uart_panel_status` |

每个工具一个 `action` 枚举 + 共用参数（path / data / name / timeoutMs …），
`execute` 里 switch 分派到底层**同一套函数**（把 `src/tools/` 的逻辑抽成可被
Host 插件 import 的纯函数，工具注册层只做 schema ↔ 参数适配）。

收益：工具数 28 → 3，token 约 4100 → 约 900；选择干扰大幅下降。

## 6. 开关行为与互斥

插件页现在是三行、三个开关：

| 行 | 开关 | 作用 |
|---|---|---|
| `local-uart` | 面板 | 侧边栏 / 悬浮球 / 底栏 + 启动 Hub |
| `local-uart-tools` | 工具 | 3 个分组专用工具（默认开） |
| `mcp-uart`（可选 bundle） | MCP | 28 个 MCP 工具，作为兜底 |

**互斥规则（已实现）**：工具行每 2.5 秒检查注册表里有没有 `mcp__uart__*`。

- 有 → 工具行主动 `unregister()` 自己的 3 个工具，记 `mode: 'mcp'`
- 没有 → 工具行重新注册，记 `mode: 'native'`
- 于是两个都开时只有 MCP 生效；关掉 MCP 行后专用工具自动接管，无需重启插件

`/uart/tools` 会报告当前生效面：`mode: native | mcp | off`，附带两边工具清单，
用于回答"为什么模型看到的是这一组而不是那一组"。

### 设置页开关

- `Agent 工具`（默认开）：写 `~/.mcp-uart/agent.json`，工具行轮询该文件生效
- `底栏状态条` / `自动滚到最新` / `数据解码`：纯 UI 偏好

## 7. 迁移步骤

1. **Hub 子进程管理**：新增 `dsh-plugin/hub-host.js`——`spawn` `node dist/hub.js`，
   解析 `HUB_URL=`，暴露 `{ url, dispose }`；退出时 kill 并等待。
   Node 可执行文件：默认 `process.execPath` + `ELECTRON_RUN_AS_NODE=1`
   （Desktop 里这样才当 node 用），可用 `config.nodePath` 覆盖。
2. **工具注册**：`dsh-plugin/agent-tools.js` 实现 3 个分组工具，`execute` 里
   对 Hub 的 HTTP API 发请求（与面板同一套接口，不重复实现串口逻辑）。
3. **开关路由**：`/uart/agent` GET/POST，偏好存 `~/.mcp-uart/agent.json`；
   切换时 `register()` / `dispose()`，立即生效。
4. **patch 调整**：`dsh-plugin/cordis.patch.yml` 删除 `mcp-uart` 行。
5. **设置页开关**：`client.template.js` 加 `ToggleRow` + 读写 `/uart/agent`。
6. **验证**：
   - DSH profile：工具列表**无** `mcp__uart__*`，只有 `uart_serial/dut/view`；
     面板有数据；开关关掉后工具消失、页面仍可用。
   - 外部：`node dist/index.js` 作为 MCP 启动，28 个工具齐全，`npm test` 全绿。
7. **重启 DSH**（插件 Host 代码变更必须完全退出再启动）。

## 7.1 兼容与回退

- `config.externalHub: true` 时退回旧的"发现已有 Hub"逻辑
  （`~/.mcp-uart/hub.json` + 端口探测），便于与外部 MCP 共用同一个 Hub 做联调。
- Hub 子进程起不来时：插件不崩，`/uart/*` 返回 503 + 诊断文本，
  面板显示"Hub 未运行"，专用工具返回同样的错误文本。

## 8. 风险与取舍

| 风险 | 说明 | 缓解 |
|---|---|---|
| 两套串口会话 | DSH Hub 与外部 MCP Hub 各自占口 | 本来就不该同时连同一物理口；文档写明 |
| Hub 生命周期 | 插件进程内 Hub 随 DSH 退出而关闭 | `ctx.effect` 保证 dispose；无孤儿进程 |
| 公共逻辑抽取 | 工具实现要能被两端 import | 抽纯函数，MCP 层只留 schema 适配 |
| 开关默认值 | 默认开会保留工具（但只有 3 个） | 比现在 28 个已大幅收敛；可 patch 改 false |
| 端口冲突 | 插件 Hub 也用 8787~8817 顺延 | 复用 `createHubWithFallback` 已有逻辑 |

## 9. 明确不做

- 不改 `uart-ui.js`（面板 UI 与工具解耦）。
- 不在这一版做 Hub 共享 / 跨进程串口代理。
- 不动 Rust daemon（那是另一条性能线）。

## 9.1 未完成：MCP 侧也做分组 + 渐进披露

用户要求 MCP 也按"工具 + 参数分组、渐进披露"暴露。当前 MCP 服务器仍是 28 个
独立工具（`src/server.ts`，53 KB，zod schema 逐个声明）。

计划：给 `src/server.ts` 加一个 `UART_MCP_GROUPED=1` 开关，注册
`uart_serial` / `uart_dut` / `uart_view` 三个分组工具（action 枚举 + 合并参数，
与专用工具同形），handler 内部仍调用现有的 28 个实现，默认保持 28 个以兼容
外部客户端。DSH 的 MCP 桥接行可以设置该环境变量，使兜底路径也得到紧凑表面。

未做的原因：这是一次对外接口的结构性改动，需要同步改 `test/*.mjs` 里按名调用
工具的用例；先确认是否要动外部契约，再动手。

## 10. 当前状态

已实施（2026-11-25）。与设计稿的差异：

- Hub 改用**子进程**而不是进程内 import（理由见 §4 的引用块）；`dist/hub.js` 复用现成入口。
- 新增 `/uart/tools` 诊断路由，便于确认三个工具是否真的在注册表里。
- 设置页开关的偏好走 `~/.mcp-uart/agent.json`，`config.agentTool: false` 可强制关闭。
