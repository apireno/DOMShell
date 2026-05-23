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

```bash
npx @apireno/domshell init
```

The setup wizard detects installed MCP clients (Claude Desktop, Cursor, Windsurf), generates a secure token, and writes the config. Use `--yes` for non-interactive mode.

Then:

1. Install the [DOMShell Chrome Extension](https://pireno.com/domshell)
2. Open Chrome's side panel and start a DOMShell session
3. Restart your MCP client — DOMShell tools will appear
4. In the DOMShell terminal, run `connect <token>` (printed by the wizard)

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

## MCP Interface

**Default (recommended): the single `domshell_execute` tool.** Pass any DOMShell command as a string — `"ls"`, `"cd tabs/123"`, `"open https://example.com"` — or pass several newline-separated for a whole workflow in one call. One tool, one approval, the full command vocabulary in the tool description.

**Lanes & multi-agent.** Every reply ends with `[lane: <id>]`. Multiple MCP clients can connect simultaneously, each in its own isolated Chrome tab group. To carve sub-lanes within a single client (e.g. two Claude Desktop chats), pass `group_id: "new"` on the first call and carry the returned id thereafter. See [CHANGELOG.md](./CHANGELOG.md).

### Granular mode — `--granular`

Start the server with `--granular` and the 38 per-command tools are exposed alongside `domshell_execute`. Use it when you want per-operation approval in the client UI.

**Read tier (always available):** `ls`, `cd`, `pwd`, `cat`, `find`, `grep`, `tree`, `text`, `read`, `tabs`, `here`, `refresh`, `diff`, `eval`, `functions`, `watch`, `for`, `script`, `each`, `extract_links`, `extract_table`

**Write tier (`--allow-write`):** `click`, `focus`, `type`, `scroll`, `navigate`, `open`, `submit`, `back`, `forward`, `close`, `select`, `js`, `screenshot`, `wait`, `call`

**Sensitive tier (`--allow-sensitive`):** `whoami`

## CLI Flags

| Flag | Description |
|------|-------------|
| `--allow-write` | Enable write-tier tools (click, type, navigate, etc.) |
| `--allow-sensitive` | Enable sensitive-tier tools (whoami) |
| `--allow-all` | Enable all tiers |
| `--granular` | Expose the 38 per-command tools alongside `domshell_execute` |
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
