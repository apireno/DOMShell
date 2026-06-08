# @apireno/domshell

MCP server that turns your browser into a filesystem. AI agents use `ls`, `cd`, `grep`, `find`, `click`, and `type` to browse the web — the same way you'd navigate a Linux filesystem.

DOMShell maps Chrome's Accessibility Tree to a virtual filesystem. Every DOM element becomes a file or directory. Agents work with familiar commands instead of raw selectors and coordinates.

## Install

DOMShell supports **three install paths** — pick whichever fits your setup. **Path 1 is the documented default** and what 99% of users want; Paths 2 and 3 exist if you want lifecycle management across several MCP servers.

### Path 1 — Native CLI (default, simplest)

```bash
npm install -g @apireno/domshell
```

Or run directly without installing:

```bash
npx @apireno/domshell
```

Works on macOS, Linux, and Windows with Node 18+. Nothing else required.

### Path 2 — Dockerized (optional)

Run DOMShell in a container — useful if you don't want a global Node install or you want process isolation. Requires Docker Desktop. The token is persisted to a gitignored `.env` file so it survives container restarts and host reboots:

```bash
git clone https://github.com/apireno/DOMShell && cd DOMShell/mcp-server
cp .env.example .env
# Edit .env and set DOMSHELL_TOKEN to: $(openssl rand -hex 24)
docker compose build      # produces domshell-mcp-server:latest
docker compose up -d
docker compose logs -f
```

The container maps ports `3001` (MCP HTTP) and `9876` (WebSocket bridge to the Chrome extension) to your loopback interface, so the Chrome extension reaches it exactly as it would the native install. `restart: unless-stopped` brings the container back automatically when Docker Desktop starts (toggle "Start Docker Desktop when you log in" in Docker Settings to make Path 2 fully reboot-resilient).

### Path 3 — ToolHive-managed (optional)

Use [ToolHive](https://github.com/stacklok/toolhive) (`thv`) to manage the container's lifecycle alongside any other MCP servers you're running. Same `.env` file Path 2 uses, just sourced by thv:

```bash
brew tap stacklok/tap && brew install thv      # one-time
cd DOMShell/mcp-server
cp .env.example .env       # edit DOMSHELL_TOKEN if you haven't already
docker compose build       # produces domshell-mcp-server:latest

thv run \
  --name domshell-mcp-server \
  --transport streamable-http \
  --target-port 3001 \
  -p 9876:9876 \
  --env-file .env \
  domshell-mcp-server:latest

thv list                          # workload status (URL on the proxy port)
thv logs domshell-mcp-server      # tail logs
```

The container is reachable on `http://127.0.0.1:3001/mcp` because `--target-port 3001` auto-publishes that port to host loopback — your existing MCP client config (Claude Desktop, Cursor, …) keeps working without changes.

Path 3 needs a one-time launchd agent for reboot autostart (Path 2 survives reboot through Docker Desktop alone). Full reboot table, launchd plist template, autostart script, and a simulated-reboot verification: [`docs/deploy/container-and-toolhive.md`](../docs/deploy/container-and-toolhive.md).

### Chrome extension (required for all three paths)

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

**Multi-line semantics:** when `command` contains newlines, each line runs in order **in the same MCP session and lane**, so `cwd`, env, and history persist between lines. An error on one line does **not** halt the rest — its message is included in the combined output and subsequent lines still run. This is the right shape for cleanup-line idioms like `"cd path\ngrep pattern\ncd back"`: the trailing restore runs even if the middle step errors. Implementation: [`mcp-server/index.ts:1115-1136`](./index.ts#L1115-L1136).

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
| `--confirm` | Opt in to per-action y/n prompts in the server terminal before each write. Off by default. |
| `--no-confirm` | No-op (kept for backward compatibility — per-action prompts are off by default). |

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
