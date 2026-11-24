# uartd — Rust serial daemon

Node 版串口栈的 Rust 重写，目标：**内存从 ~45MB 降到 ~10MB 量级，去掉 GC 抖动，单二进制分发**。
前端（浏览器控制台 / DSH 面板）**零改动**——它只认 HTTP + SSE，接口逐条对齐。

## 状态

| 模块 | 状态 |
|---|---|
| `model.rs` 数据结构 | ✅ 与 Node 版 JSON 字段一致（camelCase） |
| `encoding.rs` 编码 | ✅ utf8/ascii/latin1/gbk/gb2312/gb18030/big5/shift_jis/euc-kr/hex/base64 |
| `framing.rs` 分帧 | ✅ line / raw / delimiter / hex-frame / slip / modbus-rtu |
| `serial.rs` 串口管理 | ✅ 打开/读写/信号/重连配置/订阅，每口一个读线程，批量裁剪缓冲 |
| `hub.rs` HTTP + SSE | ✅ `/api/health|ports|status|frames|history|connect|write|config|signals|detach|disconnect` + `/events/stream` + 静态页 |
| `mcp.rs` MCP stdio | 🟡 串口工具已实现（list_ports/open/write/read/status/close/set_signals）；DUT 工具待第 3 阶段 |
| `dut.rs` DUT 引擎 | 🟡 只做了 profile 加载；判定/smoke 待第 3 阶段 |

> 未编译验证：本机没有 Rust 工具链（用户自行安装）。刻意只用了 6 个常见 crate，
> 尽量降低首次 `cargo build` 的适配成本。

## 构建

```bash
winget install Rustlang.Rustup      # 若尚未安装
cd rust
cargo build --release
```

> **本机注意 1：路径含中文**
> 项目路径 `E:\...\小程序\MCP_Uart` 里的中文会让 MinGW 的 `ld` 解析失败
> （`cannot open output file ... \xd0\xa1\xb3\xcc\xd0\xf2\...`）。构建时把产物目录
> 指到纯英文路径：
>
> ```powershell
> $env:CARGO_TARGET_DIR = 'E:\cargo-target\uartd'
> cargo build --release
> ```
>
> 产物在 `E:\cargo-target\uartd\release\uartd.exe`。

> **本机注意 2：工具链**
> 当前装的是 `stable-x86_64-pc-windows-gnu`，但它缺少 binutils（`dlltool.exe`），
> 任何依赖 `windows-sys` 的 crate 都会在这里失败。二选一：
> - 装 MSVC 工具链（推荐，MSVC Build Tools 2022 已在本机）：
>   `rustup toolchain install stable-x86_64-pc-windows-msvc` 然后 `rustup default stable-msvc`
> - 或安装 MinGW-w64（提供 `dlltool/ld/gcc`）并加入 PATH

单元测试（编码往返、分帧规则）：

```bash
cargo test
```

## 运行

```bash
# HTTP + SSE hub（前端连这个）
uartd hub --host 127.0.0.1 --port 8787

# MCP stdio（给 Agent 用）
uartd stdio
```

`--port` 被占用时目前会直接报错退出；Node 版的自动顺延在里程碑 4 补上。

静态页面目录默认 `dist/hub/public`，可用 `UART_PUBLIC_DIR` 覆盖，或把 `src/hub/public` 复制过去。

## 验收（复用现有测试，不改断言）

Node 版已有的 8 组契约测试可以直接指向 Rust hub：

```bash
node test/hub-contract-test.mjs http://127.0.0.1:8787/
node test/encoding-test.mjs
node test/framing-test.mjs   # 这两组现在测的是 Node 实现
node test/perf-test.mjs
```

里程碑 3 完成后追加 `hub-dut-test.mjs` / `history-test.mjs` 对 Rust 端的运行。

## 路线图

- **M3** DUT：profile 判定（bytes/extraContains/echoMatches）、命令表、smoke 序列、`/api/dut*`
- **M4** 打包：npm 包内放 `bin/uartd.exe`，`mcp-uart` 启动器优先用 Rust，缺失时回退 Node
- **M5** 端口顺延、日志文件、`serial_wait` 等长轮询工具

## 为什么值得做（数据）

- 当前 Node MCP 进程：**45MB working set / 83MB private**
- 进程内吞吐：5000 帧约 9–11ms；而 921600 波特率下物理上限约 4.6k 帧/秒（20 字节/帧）
- 所以 Rust 的主要收益是**内存与确定性**，不是吞吐；UI 卡顿另有一条渲染侧优化路径
