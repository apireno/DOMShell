# @apireno/domshell

MCP server that turns your browser into a filesystem. AI agents use `ls`, `cd`, `grep`, `find`, `click`, and `type` to browse the web — the same way you'd navigate a Linux filesystem.

DOMShell maps Chrome's Accessibility Tree to a virtual filesystem. Every DOM element becomes a file or directory. Agents work with familiar commands instead of raw selectors and coordinates.

## Install

```bash
npm install -g @apireno/domshell
```

Or run directly:

```bash
npx @apireno/domshell
```

You also need the [DOMShell Chrome Extension](https://pireno.com/domshell) — the MCP server talks to the browser through it.

## Quick Start

1. Install the Chrome extension from the [Chrome Web Store](https://pireno.com/domshell)
2. Open Chrome's side panel and start a DOMShell session
3. Start the MCP server: `npx @apireno/domshell --allow-write`
4. Connect from Claude Desktop, Cursor, or any MCP client

## Claude Desktop Config

Add this to your Claude Desktop MCP settings (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "domshell": {
      "command": "npx",
      "args": ["-y", "@apireno/domshell", "--allow-write"]
    }
  }
}
```

For the stdio proxy (required if your client needs command/args format):

```json
{
  "mcpServers": {
    "domshell": {
      "command": "npx",
      "args": ["-y", "-p", "@apireno/domshell", "domshell-proxy", "--port", "3001", "--token", "YOUR_TOKEN"]
    }
  }
}
```

## Benchmarks

We tested DOMShell against Computer-in-the-Cloud (CiC) — both using Claude as the underlying model — across 4 web tasks over 8 trials.

| Metric | DOMShell | CiC |
|--------|----------|-----|
| Avg API calls per task | **4.3** | 8.6 |
| Hardest task (T4) | **6.0 calls** | 13.0 calls |
| Cold start vs CiC warm cache | **4.5 calls** | 5.5 calls |

DOMShell uses **2× fewer API calls** to complete the same tasks. The filesystem metaphor gives the model a mental map of the page, so it spends less time exploring and more time extracting.

Full experiment data: [experiments/claude_domshell_vs_cic](https://github.com/apireno/DOMShell/tree/main/experiments/claude_domshell_vs_cic)

## 38 MCP Tools

**Read (always available):** `ls`, `cd`, `pwd`, `cat`, `find`, `grep`, `tree`, `text`, `read`, `tabs`, `here`, `refresh`, `diff`, `eval`, `functions`, `watch`, `for`, `script`, `each`, `extract_links`, `extract_table`

**Write (--allow-write):** `click`, `focus`, `type`, `scroll`, `navigate`, `open`, `submit`, `back`, `forward`, `close`, `select`, `js`, `screenshot`, `wait`, `call`

**Sensitive (--allow-sensitive):** `whoami`

**Fallback:** `execute` (run any command string)

## CLI Flags

| Flag | Description |
|------|-------------|
| `--allow-write` | Enable write-tier tools (click, type, navigate, etc.) |
| `--allow-sensitive` | Enable sensitive-tier tools (whoami) |
| `--allow-all` | Enable all tiers |
| `--port N` | WebSocket port (default: 9876) |
| `--mcp-port N` | HTTP MCP port (default: 3001) |
| `--domains a.com,b.com` | Restrict to specific domains |
| `--token TOKEN` | Set auth token (auto-generated if omitted) |
| `--log-file PATH` | Audit log location (default: audit.log) |
| `--no-confirm` | Skip confirmation prompts |

## Security

Every command goes through a 4-tier security model:

- **Read** — always allowed (ls, find, grep, text)
- **Navigate** — requires `--allow-write` (navigate, open, back, forward)
- **Write** — requires `--allow-write` (click, type, js, select)
- **Sensitive** — requires `--allow-sensitive` (whoami, cookie access)

All commands are logged to an audit file. Domain allowlists restrict which sites the agent can access. Auth tokens protect the HTTP endpoint.

## Architecture

```
MCP Client (Claude, Cursor, etc.)
    ↓ HTTP :3001/mcp
DOMShell MCP Server (Express + WebSocket)
    ↓ WebSocket :9876
DOMShell Chrome Extension (CDP 1.3)
    ↓ Chrome Debugger Protocol
Browser DOM + Accessibility Tree
```

## Links

- **Chrome Web Store**: [pireno.com/domshell](https://pireno.com/domshell)
- **GitHub**: [github.com/apireno/DOMShell](https://github.com/apireno/DOMShell)
- **Blog**: [Why I Built a Filesystem for the Browser](https://dev.to/apireno/why-i-built-a-filesystem-for-the-browser-3kpa)
- **Project home**: [pireno.com/domshell](https://pireno.com/domshell)

Built by [Pireno](https://pireno.com).

## License

MIT
