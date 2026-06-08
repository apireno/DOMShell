# HARNESS.md — Integrating DOMShell as a Backend

DOMShell exposes Chrome's Accessibility Tree as a virtual filesystem via 38 MCP tools. This document describes how to integrate DOMShell as a backend for external frameworks, CLI wrappers, or agent orchestrators.

## Architecture

```
┌──────────────────────┐     stdio/SSE      ┌──────────────────┐    WebSocket     ┌──────────────┐
│  Your Framework      │ ◄────────────────► │  DOMShell MCP    │ ◄──────────────► │  Chrome Ext  │
│  (CLI-Anything,      │    MCP protocol    │  Server          │    localhost:    │  (Side Panel) │
│   custom agent, etc) │                    │  (Node.js)       │    9876          │              │
└──────────────────────┘                    └──────────────────┘                  └──────────────┘
```

DOMShell has two components:

1. **Chrome Extension** — Captures the Accessibility Tree from any tab, listens for commands via the side panel terminal
2. **MCP Server** — Bridges MCP clients to the extension over WebSocket; exposes all commands as MCP tools

Your integration talks to the MCP server. The server talks to the extension. You never touch Chrome directly.

## Connecting via MCP

### Option 1: stdio transport (recommended for CLI wrappers)

```python
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

server_params = StdioServerParameters(
    command="npx",
    args=["@apireno/domshell", "--allow-write", "--no-confirm"]
)

async with stdio_client(server_params) as (read, write):
    async with ClientSession(read, write) as session:
        await session.initialize()

        # List available tools
        tools = await session.list_tools()

        # Execute a command
        result = await session.call_tool("domshell_ls", {"path": "/"})
```

### Option 2: SSE/Streamable HTTP transport (recommended for long-running services)

DOMShell's MCP server also listens on HTTP (default port 3001):

```python
from mcp import ClientSession
from mcp.client.sse import sse_client

async with sse_client("http://localhost:3001/mcp") as (read, write):
    async with ClientSession(read, write) as session:
        await session.initialize()
        result = await session.call_tool("domshell_here", {})
```

Start the server manually for this mode:

```bash
npx @apireno/domshell --allow-write --no-confirm --mcp-port 3001
```

> **Other install paths.** The integration shape is the same regardless of how the DOMShell server is running. Besides this default `npx` invocation, you can also reach a `docker compose`-managed or `thv`-managed DOMShell on the same `http://localhost:3001/mcp` endpoint. See [`mcp-server/README.md`](./mcp-server/README.md#install) for the three-paths overview and [`docs/deploy/container-and-toolhive.md`](./docs/deploy/container-and-toolhive.md) for the container deep dive.

## State Model

DOMShell maintains state that persists across tool calls within a session:

| State | Description | Serializable |
|-------|-------------|:------------:|
| **Current working directory** | Path in the AX tree (e.g., `~/tabs/123/main/article`) | Yes |
| **Active tab** | Which Chrome tab is focused | Yes |
| **AX tree snapshot** | Cached Accessibility Tree for the current tab | Yes (JSON) |
| **Bookmarks** | Named path shortcuts (via `bookmark` command) | Yes |
| **Scripts** | Saved multi-command scripts (via `script` command) | Yes |

The tree auto-refreshes when the page changes (navigation, DOM mutations). If the page navigates, CWD resets to tab root. If the DOM updates in-place, CWD is preserved.

## Command Tiers and Permissions

DOMShell enforces permission tiers via server flags:

| Tier | Commands | Flag Required |
|------|----------|---------------|
| **Read** | `ls`, `cd`, `cat`, `grep`, `find`, `tree`, `text`, `pwd`, `tabs`, `windows`, `here`, `screenshot`, `diff`, `eval`, `functions` | None (always allowed) |
| **Navigate** | `navigate`, `open`, `back`, `forward` | `--allow-write` |
| **Write** | `click`, `focus`, `type`, `scroll`, `select`, `close`, `js`, `call` | `--allow-write` |
| **Sensitive** | `whoami` | `--allow-sensitive` |

For full agent automation, start with `--allow-all --no-confirm`. For read-only scraping, no flags needed.

## Tool Reference (Minimal POC Subset)

These 6 tools cover the core scope/discover/act loop:

### `domshell_ls` — List children
```json
{
  "path": "/main",        // optional, defaults to cwd
  "type": "link",         // optional, filter by AX role
  "meta": true,           // optional, show href/src/id inline
  "text": true,           // optional, show visible text preview
  "n": 20,                // optional, limit results
  "offset": 0             // optional, pagination offset
}
```

### `domshell_cd` — Change directory
```json
{
  "path": "main/article"  // relative or absolute path, supports "..", "~", "%here%"
}
```

### `domshell_cat` — Inspect element metadata
```json
{
  "target": "submit_btn"  // element name or path
}
```
Returns: AX role, DOM tag, href/src, id, class, text content, outerHTML snippet.

### `domshell_click` — Click an element
```json
{
  "target": "submit_btn"  // element name or path
}
```
Requires `--allow-write`. Tree auto-refreshes after click.

### `domshell_grep` — Search current directory
```json
{
  "pattern": "login",     // text pattern to match
  "recursive": true,      // optional, search all descendants
  "n": 10                 // optional, limit results
}
```

### `domshell_open` — Navigate to URL in new tab
```json
{
  "url": "https://example.com"
}
```
Requires `--allow-write`. Returns tab ID, title, URL, node count.

## Full Tool List (38 tools)

Beyond the POC subset, DOMShell exposes:

| Tool | Category | Description |
|------|----------|-------------|
| `domshell_ls` | Discovery | List children of current/target node |
| `domshell_cd` | Navigation | Change working directory |
| `domshell_cat` | Discovery | Inspect element metadata |
| `domshell_tree` | Discovery | Tree view with configurable depth |
| `domshell_text` | Extraction | Bulk text extraction (with optional `--links` for inline URLs) |
| `domshell_grep` | Search | Pattern search in current directory |
| `domshell_find` | Search | Deep recursive search with type/meta/text filters |
| `domshell_pwd` | Navigation | Print working directory |
| `domshell_here` | Navigation | Jump to focused tab |
| `domshell_tabs` | Navigation | List all open tabs |
| `domshell_windows` | Navigation | List windows with grouped tabs |
| `domshell_navigate` | Navigation | Navigate current tab to URL |
| `domshell_open` | Navigation | Open URL in new tab |
| `domshell_back` | Navigation | Browser back (uses cache) |
| `domshell_forward` | Navigation | Browser forward |
| `domshell_close` | Navigation | Close a tab |
| `domshell_click` | Interaction | Click an element |
| `domshell_focus` | Interaction | Focus an input element |
| `domshell_type` | Interaction | Type text into focused element |
| `domshell_select` | Interaction | Select option in dropdown |
| `domshell_scroll` | Interaction | Scroll page or element into view |
| `domshell_screenshot` | Extraction | Capture page screenshot |
| `domshell_js` | Advanced | Execute JavaScript (CSS selectors, batch extraction) |
| `domshell_eval` | Advanced | Read-only JS expression evaluation (no `--allow-write` needed) |
| `domshell_diff` | Advanced | Show DOM changes since last snapshot |
| `domshell_wait` | Advanced | Poll for element existence (SPA/AJAX) |
| `domshell_extract_table` | Extraction | Extract HTML table as markdown |
| `domshell_whoami` | Sensitive | Check authentication status via cookies |
| `domshell_bookmark` | Utility | Save/recall named path shortcuts |
| `domshell_script` | Utility | Save/run multi-command scripts with variables |
| `domshell_watch` | Utility | Re-run command on interval, optionally stop on change |
| `domshell_for` | Utility | Iterate over command output, run template per line |
| `domshell_each` | Utility | Run command across multiple tabs |
| `domshell_functions` | Discovery | List callable `window` functions |
| `domshell_call` | Interaction | Invoke a global JS function |
| `domshell_execute` | Core | Execute raw DOMShell command string |
| `domshell_refresh` | Core | Force AX tree refresh |
| `domshell_help` | Core | Show help for commands |

## The Filesystem Metaphor

The reason DOMShell uses filesystem primitives instead of DOM-query primitives (`querySelector`, `waitForSelector`) is efficiency. In controlled benchmarks with Claude (4 tasks, 8 trials), the filesystem approach averaged **4.3 API calls per task vs 8.6** for screenshot-based browsing.

The insight: agents waste most of their cycles on **orientation**, not action. The filesystem metaphor gives them three primitives LLMs deeply understand from training data:

- **Scope** (`cd`) — Narrow context to reduce noise
- **Discover** (`ls`, `find`, `grep`) — See what's available within scope
- **Act** (`click`, `type`, `cat`, `text`) — Operate on what you found

When integrating DOMShell, preserve these semantics. Map `ls`/`cd`/`grep` to your framework's navigation model rather than flattening them into query-style commands. The efficiency gain comes from the abstraction, not just the underlying data.

## Example: Full Workflow

```python
async with ClientSession(read, write) as session:
    await session.initialize()

    # Open a page
    await session.call_tool("domshell_open", {"url": "https://en.wikipedia.org/wiki/Model_Context_Protocol"})

    # Orient: what's on this page?
    result = await session.call_tool("domshell_tree", {"depth": 2})

    # Scope: navigate to the article body
    await session.call_tool("domshell_cd", {"path": "main/article"})

    # Discover: find all links with URLs
    links = await session.call_tool("domshell_find", {
        "pattern": "",
        "type": "link",
        "meta": True
    })

    # Extract: get the full article text with inline link URLs
    content = await session.call_tool("domshell_text", {"links": True})

    # Act: click a specific link
    await session.call_tool("domshell_click", {"target": "References_link"})

    # Detect changes after navigation
    changes = await session.call_tool("domshell_diff", {})
```

## Server Configuration Reference

```bash
npx @apireno/domshell [flags]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--allow-write` | off | Enable navigate + write commands |
| `--allow-sensitive` | off | Enable `whoami` |
| `--allow-all` | off | Enable all tiers |
| `--no-confirm` | off | Skip interactive confirmation for write commands |
| `--port <n>` | 9876 | WebSocket port (extension bridge) |
| `--mcp-port <n>` | 3001 | HTTP/SSE MCP endpoint port |
| `--token <str>` | random | Auth token for MCP connections |
| `--domains <list>` | all | Comma-separated allowed domains |
| `--expose-cookies` | off | Don't redact cookie values in `whoami` |
| `--log-file <path>` | audit.log | Audit log file path |

## Testing Integration

For E2E tests, you need both components running:

1. **Chrome with DOMShell extension loaded** (the extension side panel must be open on at least one tab)
2. **DOMShell MCP server** (`npx @apireno/domshell --allow-all --no-confirm`)

Verify connectivity:

```python
async with ClientSession(read, write) as session:
    await session.initialize()
    # This should return tab info if the extension is connected
    result = await session.call_tool("domshell_here", {})
    assert "Title:" in str(result)  # Extension is connected and a tab is active
```

If `domshell_here` returns an error about no extension connected, ensure:
- The Chrome extension is installed and enabled
- The DOMShell side panel is open in at least one Chrome window
- The WebSocket port (default 9876) is not blocked

## Links

- GitHub: [github.com/apireno/DOMShell](https://github.com/apireno/DOMShell)
- Chrome Web Store: [Install DOMShell](https://chromewebstore.google.com/detail/domshell-%E2%80%94-browser-filesy/okcliheamhmijccjknkkplploacoidnp)
- npm: `npx @apireno/domshell`
- mcpservers.org: [DOMShell listing](https://mcpservers.org/servers/apireno/domshell)
- Benchmark data: [DOMShell vs CiC experiment](https://github.com/apireno/DOMShell/tree/main/experiments/claude_domshell_vs_cic)
- MCP Python SDK: [github.com/modelcontextprotocol/python-sdk](https://github.com/modelcontextprotocol/python-sdk)
