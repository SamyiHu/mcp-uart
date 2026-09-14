# mcp-uart

Serial Port MCP Server for AI agents. Lets Claude, Cline, Cursor, and other MCP-compatible AI tools talk to UART/serial devices.

## Features

- **Structured output**: critical tools return MCP `structuredContent` + human text, so agents can read exact fields (`verdict`, `frames[i].bytes[j]`, …) without parsing prose
- **Precise extract**: `serial_extract` / `dut_extract` pull one value via a path (`last.raw`, `rx.count`, `frames[1].bytes[2]`)
- **Filters**: `direction` / `matchHex` / `matchText` / `minLength` / `lastOnly` / `offset` on read & wait
- **HTML visualize**: `serial_visualize` (TX/RX timeline) and `serial_visualize_smoke` (PASS/FAIL report)
- **UART Hub host UI**: `mcp-uart-hub` local web app — config sidebar + live SSE monitor on one page
- **12 Encodings**: UTF-8, ASCII, Latin-1, GBK, GB2312, GB18030, Big5, Shift_JIS, EUC-KR, Hex, Base64, Binary
- **6 Protocols**: Raw, Line, Custom delimiter, Modbus RTU, Hex frame, SLIP (RFC 1055)
- **Smart Wait**: `serial_wait` collects a full device response (silence detection), `serial_wait_frame` returns on first frame
- **File Logging**: `serial_start_monitor` logs to a file (no popup by default)
- **DUT Profile-Driven Testing**: chip logic lives in `src/dut/profiles/*.json` (W6729 etc.)

> `serial_open` / `dut_connect` default `autoMonitor=false` (no terminal popup). Set `autoMonitor=true` for human debugging.

## Install

### From npm

```bash
npm install -g mcp-uart
```

### From source

```bash
git clone https://github.com/yourname/mcp-uart.git
cd mcp-uart
npm install
npm run build
```

## Setup

### Claude Code

```bash
claude mcp add uart -- mcp-uart
```

Or add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "uart": {
      "command": "mcp-uart"
    }
  }
}
```

### Cline (VS Code)

Open Cline -> MCP Servers -> Edit Configuration, add:

```json
{
  "mcpServers": {
    "uart": {
      "command": "mcp-uart"
    }
  }
}
```

### Cursor

Add to Cursor MCP settings:

```json
{
  "mcpServers": {
    "uart": {
      "command": "mcp-uart"
    }
  }
}
```

### From source (not installed globally)

If running from a local clone instead of `npm install -g`:

```json
{
  "mcpServers": {
    "uart": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-uart/dist/index.js"]
    }
  }
}
```

## Usage

Once configured, talk to your AI naturally:

```
"List available serial ports"
"Open COM3 at 115200 baud with GBK encoding and Modbus RTU protocol"
"Send 01030000000A in hex"
"Wait for the device to finish responding"
"Read any new data since my last read"
"Switch to 9600 baud"
"Close the connection"
```

## Tools Reference

| Tool | Description |
|------|-------------|
| `serial_list_ports` | Discover available serial ports |
| `serial_open` | Open a port (`autoMonitor` default false) |
| `serial_write` | Write data (text/hex/base64) |
| `serial_read` | Read with filters: direction/matchHex/matchText/lastOnly/offset/sinceLastRead |
| `serial_extract` | Pull one field: `last.raw`, `rx.count`, `rxHex`, `messages[0].length`, … |
| `serial_wait` | Wait for complete device response (silence detection) |
| `serial_wait_frame` | Wait for a single data frame (optional matchHex/matchText) |
| `serial_reconfigure` | Change settings on the fly |
| `serial_status` | View connection status |
| `serial_close` | Close a connection |
| `serial_start_monitor` | Start file logging (no popup) |
| `serial_stop_monitor` | Stop file logging |
| `serial_list_encodings` | List supported encodings |
| `serial_list_protocols` | List supported protocols |
| `serial_set_signals` | Set break/DTR/RTS stimulus lines |
| `serial_visualize` | Write HTML TX/RX timeline report |
| `serial_visualize_smoke` | Write HTML PASS/FAIL smoke report |

Resource: `serial://{connectionId}/frames` — JSON trajectory of buffered frames.

### Agent-precise extraction examples

```
serial_extract({ connectionId, path: "last.raw" })
  → structuredContent.value = "4F4B50494E47"

serial_extract({ connectionId, path: "rx.count" })
  → 12

serial_read({ connectionId, direction: "rx", matchHex: "AA55", lastOnly: true })
  → only the newest RX frame containing AA 55

dut_extract({ connectionId, name: "io_output", path: "frames[-1].bytes[2]" })
  → 85   # 0x55

dut_smoke → structuredContent.steps[i].frames[j].bytes[]
serial_visualize_smoke({ profile, steps, outputPath: "smoke.html" })
```

## Standalone Serial Monitor

Run directly from the terminal (no AI needed):

```bash
# Global install
serial-monitor COM3 115200 utf8

# From source
node dist/monitor.js COM3 115200 utf8
```

Type and press Enter to send. `Ctrl+C` to exit.

## UART Hub (browser host UI)

One page: **left = config** (port/baud/encoding/DTR/RTS/Break), **right = live monitor** (SSE).

```bash
npm run hub
# or
npx mcp-uart-hub --port 8787
# open the URL printed on stderr (default http://127.0.0.1:8787)
```

Notes:

- Binds **127.0.0.1 only**
- **Auto port fallback**: if 8787 is busy (e.g. another host app), tries 8788… then ephemeral. Use `--strict-port` to fail instead, `--port-span N` to change scan width.
- Single connection policy: opening a new port closes the previous one
- Avoid opening the same COM in MCP at the same time as Hub (OS exclusive lock)
- API: `GET /api/health|ports|status|frames`, `POST /api/connect|disconnect|write|config|signals`, `GET /events/stream` (SSE)

Offline tests: `npm run test:hub`

## Supported Encodings

| Encoding | Description |
|----------|-------------|
| `utf8` | UTF-8 (default) |
| `ascii` | 7-bit ASCII |
| `latin1` | ISO-8859-1 Western European |
| `gbk` | GBK Simplified Chinese (Windows) |
| `gb2312` | GB2312 Simplified Chinese (basic) |
| `gb18030` | GB18030 Simplified Chinese (full) |
| `big5` | Big5 Traditional Chinese |
| `shift_jis` | Shift_JIS Japanese |
| `euc-kr` | EUC-KR Korean |
| `hex` | Hexadecimal string |
| `base64` | Base64 encoded |
| `binary` | Raw hex bytes |

## Supported Protocols

| Protocol | Description |
|----------|-------------|
| `raw` | No parsing, raw byte stream |
| `line` | Newline-delimited (`\r\n`) |
| `delimiter` | Custom hex delimiter (e.g. `0D0A`) |
| `modbus-rtu` | Modbus RTU frame detection by silence gap |
| `hex-frame` | Extract between configurable start/end markers |
| `slip` | SLIP RFC 1055 de-framing |

## DUT Profile-Driven Testing (FT/产测)

On top of the generic serial tools, this server ships a **profile-driven DUT test runner**. Chip-specific knowledge lives only in `src/dut/profiles/*.json` (serial params, frame format, checksum algorithm, command table, pass/fail rules, smoke sequence) — the engine is chip-agnostic. Supporting a new chip = drop a new JSON profile, zero core-code changes.

Tools:

| Tool | Description |
|------|-------------|
| `dut_list_profiles` | List profiles + their command tables (entry point) |
| `dut_connect` | Open port AND attach protocol session (e.g. w6729: 727000 8N1, 4-byte frames, 0xFF-sum checksum) |
| `dut_test` | Run one named test with auto judgment; `format=structured\|human` |
| `dut_extract` | Run a test then extract one field via path |
| `dut_cmd` | Raw framed command (checksum auto-appended), no judgment |
| `dut_smoke` | Run smoke sequence; structured `steps[]` for visualization |
| `dut_status` | Session stats: frames parsed/sent, noise bytes, last frames |
| `dut_send_raw` | Raw bytes without framing (echo bytes, out-of-protocol) |
| `dut_disconnect` | Detach session + close port |

Example flow (W6729 on FPGA):

```
"列出可用的 DUT profile"          -> dut_list_profiles
"用 COM5 连接 w6729"              -> dut_connect(path=COM5, profile=w6729)
"跑一遍冒烟"                      -> dut_smoke
"导出冒烟报告 HTML"               -> serial_visualize_smoke(profile, steps)
"测 P2 口输出高 0x55"             -> dut_test(io_output, cmd=0x15, p1=0xFF, p2=0x55)
"只要结果帧第3字节"               -> dut_extract(..., path="frames[1].bytes[2]")
"发原始命令 0F 04 00"             -> dut_cmd(cmd=15, p1=4, p2=0)
"画时序图"                        -> serial_visualize(connectionId)
```

Offline tests:

```bash
npm test              # dut + extract/visualize + hub
npm run test:dut
npm run test:extract
npm run test:hub
```

## License

MIT
