# mcp-uart

Serial Port MCP Server for AI agents. Lets Claude, Cline, Cursor, and other MCP-compatible AI tools talk to UART/serial devices.

## Features

- **11 Tools**: list ports, open, write, read, wait (single frame / full response), reconfigure, status, close, monitor start/stop, list encodings, list protocols
- **12 Encodings**: UTF-8, ASCII, Latin-1, GBK, GB2312, GB18030, Big5, Shift_JIS, EUC-KR, Hex, Base64, Binary
- **6 Protocols**: Raw, Line (newline), Custom delimiter, Modbus RTU, Hex frame, SLIP (RFC 1055)
- **Smart Wait**: `serial_wait` collects a full device response (silence detection), `serial_wait_frame` returns on first frame
- **Real-time Monitor**: Auto-opens a terminal window showing TX/RX data live, like a serial assistant
- **Time-aware Read**: `sinceLastRead` mode returns only new messages with timing metadata
- **File Logging**: `serial_start_monitor` logs all data to a file, viewable with `tail -f`

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
| `serial_open` | Open a port (auto-opens monitor terminal) |
| `serial_write` | Write data (text/hex/base64) |
| `serial_read` | Read buffered messages (supports `sinceLastRead`) |
| `serial_wait` | Wait for complete device response (silence detection) |
| `serial_wait_frame` | Wait for a single data frame |
| `serial_reconfigure` | Change settings on the fly |
| `serial_status` | View connection status |
| `serial_close` | Close a connection |
| `serial_start_monitor` | Start logging to file |
| `serial_stop_monitor` | Stop file logging |
| `serial_list_encodings` | List supported encodings |
| `serial_list_protocols` | List supported protocols |

## Standalone Serial Monitor

Run directly from the terminal (no AI needed):

```bash
# Global install
serial-monitor COM3 115200 utf8

# From source
node dist/monitor.js COM3 115200 utf8
```

Type and press Enter to send. `Ctrl+C` to exit.

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

## License

MIT
