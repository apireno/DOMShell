# AgentShell

**The browser is your filesystem.** A Chrome Extension that lets AI agents (and humans) browse the web using standard Linux commands — `ls`, `cd`, `cat`, `grep`, `click` — via a terminal in the Chrome Side Panel.

AgentShell maps the browser into a virtual filesystem. Windows and tabs become top-level directories (`~`). Each tab's Accessibility Tree becomes a nested filesystem where container elements are directories and buttons, links, and inputs are files. Navigate Chrome the same way you'd navigate `/usr/local/bin`.

## Why

AI agents that interact with websites typically rely on screenshots, pixel coordinates, or brittle CSS selectors. AgentShell takes a different approach: it exposes the browser's own Accessibility Tree as a familiar filesystem metaphor.

This means an agent can:
- **Browse** tabs with `ls ~/tabs/` and switch with `cd ~/tabs/123` instead of guessing which tab is active
- **Explore** a page with `ls` and `tree` instead of parsing screenshots
- **Navigate** into sections with `cd navigation/` instead of guessing coordinates
- **Act** on elements with `click submit_btn` instead of fragile DOM queries
- **Read** content with `cat` or bulk-extract with `text` instead of scraping innerHTML
- **Search** for elements with `find --type combobox` instead of writing selectors

The filesystem abstraction is deterministic, semantic, and works on any website — no site-specific adapters needed.

## Installation

### From Source

```bash
git clone https://github.com/apireno/AgenticShell.git
cd AgentShell
npm install
npm run build
```

### Load into Chrome

1. Open `chrome://extensions/`
2. Enable **Developer mode** (toggle in top right)
3. Click **Load unpacked**
4. Select the `dist/` folder
5. Click the AgentShell icon in your toolbar — the side panel opens

## Usage

### Getting Started

Open any webpage, then open the AgentShell side panel. You'll see a terminal:

```
╔══════════════════════════════════════╗
║   AgentShell v1.0.0                  ║
║   The browser is your filesystem.    ║
╚══════════════════════════════════════╝

Type 'help' to see available commands.
Type 'tabs' to see open browser tabs, then 'cd tabs/<id>' to enter one.

agent@shell:~$
```

You start at `~` (the browser root). From here you can see your windows and tabs:

```
agent@shell:~$ ls
  windows/       (2 windows)
  tabs/          (5 tabs)
```

### Browsing Tabs and Windows

```bash
# List all open tabs
agent@shell:~$ tabs
  ID     TITLE                       URL                        WIN
  123    Google                       google.com                 1
  124    GitHub - apireno             github.com/apireno         1
  125    Wikipedia                    en.wikipedia.org                 2

# Switch to a tab by ID
agent@shell:~$ cd tabs/125
✓ Entered tab 125
  Title: Wikipedia
  URL:   https://en.wikipedia.org
  AX Nodes: 312

# You're now inside the tab's DOM tree
agent@shell:~$ pwd
~/tabs/125

# Go back to browser level
agent@shell:~$ cd ~
agent@shell:~$

# Or use substring matching
agent@shell:~$ cd tabs/github
✓ Entered tab 124 (GitHub - apireno)

# List windows
agent@shell:~$ windows
  ID     TABS    STATUS
  1      3       focused
  2      2

# Browse a specific window's tabs
agent@shell:~$ cd windows/2
agent@shell:~/windows/2$ ls
  ID     TITLE                       URL
  125    Wikipedia                    en.wikipedia.org
  126    LinkedIn                     linkedin.com
```

You can also navigate or open new tabs:

```bash
# Navigate the current tab to a URL (requires being inside a tab)
agent@shell:~$ navigate https://example.com

# Open a URL in a new tab (works from anywhere)
agent@shell:~$ open https://github.com
✓ Opened new tab
  URL:   https://github.com
  Title: GitHub
  AX Nodes: 412
```

### Navigating the DOM

Once you're inside a tab, the Accessibility Tree appears as a filesystem:

```bash
# List children of the current node
agent@shell:~$ ls
navigation/
main/
complementary/
contentinfo/
skip_to_content_link
logo_link

# Long format shows type prefixes and roles
agent@shell:~$ ls -l
[d] navigation     navigation/
[d] main           main/
[x] link           skip_to_content_link
[x] link           logo_link

# Filter by type
agent@shell:~$ ls --type link
skip_to_content_link
logo_link

# Paginate large directories
agent@shell:~$ ls -n 10              # First 10 items
agent@shell:~$ ls -n 10 --offset 10  # Items 11-20

# Count children by type
agent@shell:~$ ls --count
45 total (12 [d], 28 [x], 5 [-])

# Enter a directory (container element)
agent@shell:~$ cd navigation

# See where you are
agent@shell:~$ pwd
~/tabs/125/navigation

# Go back up
agent@shell:~$ cd ..

# Jump to browser root
agent@shell:~$ cd ~

# Multi-level paths work too
agent@shell:~$ cd main/article/form
```

### Type Prefixes

Every node has a type prefix that communicates metadata without relying on color alone:

| Prefix | Meaning | Examples |
|--------|---------|---------|
| `[d]` | Directory (container, `cd`-able) | `navigation/`, `form/`, `main/` |
| `[x]` | Interactive (clickable/focusable) | buttons, links, inputs, checkboxes |
| `[-]` | Static (read-only) | headings, images, text |

### Reading Content

```bash
# Inspect an element's metadata and text
agent@shell:~$ cat submit_btn
--- submit_btn ---
  Role:  button
  Type:  [x] interactive
  AXID:  42
  DOM:   backend#187
  Text:  Submit Form

# Bulk extract ALL text from a section (one call instead of 50+ cat calls)
agent@shell:/main$ text
[textContent of /main — 4,821 chars]
Heading: Welcome to Our Site
Today we announce the launch of our new product...
(full article text continues)

# Extract text from a specific child
agent@shell:~$text main
[textContent of main — 4,821 chars]

# Limit output length
agent@shell:~$text main -n 500

# Get a tree view (default depth: 2)
agent@shell:~$tree
navigation/
├── [x] home_link
├── [x] about_link
├── [x] products_link
└── [x] contact_link

# Deeper tree
agent@shell:~$tree 4
```

### Searching

```bash
# Search current directory
agent@shell:~$grep login
[x] login_btn (button)
[d] login_form (form)
[x] login_link (link)

# Recursive search across all descendants
agent@shell:~$grep -r search
[x] search_search (combobox)
[x] search_btn (button)

# Limit results
agent@shell:~$grep -r -n 5 link

# Deep search with full paths (like Unix find)
agent@shell:~$find search
[x] /search_2/search_search (combobox)
[x] /search_2/search_btn (button)

# Find by role type
agent@shell:~$find --type combobox
[x] /search_2/search_search (combobox)

agent@shell:~$find --type textbox
[x] /main/form/email_input (textbox)
[x] /main/form/name_input (textbox)

# Limit results
agent@shell:~$find --type link -n 5
```

### Interacting with Elements

```bash
# Click a button or link
agent@shell:~$click submit_btn
✓ Clicked: submit_btn (button)
(tree will auto-refresh on next command)

# Focus an input field
agent@shell:~$focus email_input
✓ Focused: email_input

# Type into the focused field
agent@shell:~$type hello@example.com
✓ Typed 17 characters

# Navigate to a URL (current tab)
agent@shell:~$navigate https://example.com
✓ Navigated to https://example.com

# Open a URL in a new tab
agent@shell:~$open https://github.com
✓ Opened new tab → https://github.com
```

### Auto-Refresh on DOM Changes

AgentShell automatically detects when the page changes — navigation, DOM mutations, or content updates from clicks. You no longer need to manually run `refresh`:

```bash
agent@shell:~$click search_btn
✓ Clicked: search_btn (button)
(tree will auto-refresh on next command)

agent@shell:~$ls
(page changed — tree refreshed, 312 nodes, path reset to tab root)
main/
navigation/
search_results/
...
```

If the page navigated, CWD is reset to the tab root. If the DOM just updated in place, your CWD is preserved. You can still force a manual refresh:

```bash
agent@shell:~$refresh
✓ Refreshed. 312 AX nodes loaded.
```

### Tab Completion

Press `Tab` to auto-complete commands and element names — works like bash:

```bash
agent@shell:$ ta<Tab>
# completes to: tabs

agent@shell:$ cd nav<Tab>
# completes to: cd navigation/

agent@shell:$ click sub<Tab>
# if multiple matches, shows options:
#   submit_btn
#   subscribe_link
```

- Single match: auto-completes inline
- Multiple matches: shows options below, fills the longest common prefix
- `cd` only completes directories; other commands complete all elements

### Paste Support

Cmd+V (Mac) / Ctrl+V (Windows/Linux) pastes text directly into the terminal. Multi-line pastes are flattened to a single line.

### System Commands

```bash
# Check if you're authenticated (reads cookies)
agent@shell:~$whoami
URL: https://example.com
Status: Authenticated
Via: session_id
Expires: 2025-12-31T00:00:00.000Z
Total cookies: 12

# Environment variables
agent@shell:~$env
SHELL=/bin/agentshell
TERM=xterm-256color

# Set a variable
agent@shell:~$export API_KEY=sk-abc123

# Debug the raw AX tree
agent@shell:~$debug stats
--- Debug Stats ---
  Total AX nodes:   247
  Ignored nodes:    83
  Generic nodes:    41
  With children:    62
  Iframes:          2
```

### Getting Help

Every command supports `--help`:

```bash
agent@shell:$ ls --help
ls — List children of the current node

Usage: ls [options]

Options:
  -l, --long      Long format: type prefix, role, and name
  -r, --recursive Show nested children (one level deep)
  -n N            Limit output to first N entries
  --offset N      Skip first N entries (for pagination)
  --type ROLE     Filter by AX role (e.g. --type button)
  --count         Show count of children only
...
```

## Command Reference

### Browser Level

| Command | Description |
|---|---|
| `tabs` | List all open tabs (shortcut for `ls ~/tabs/`) |
| `windows` | List all windows (shortcut for `ls ~/windows/`) |
| `cd ~` | Go to browser root |
| `cd ~/tabs/<id>` | Switch to a tab by ID (enters automatically) |
| `cd ~/tabs/<pattern>` | Switch to a tab by title/URL substring match |
| `cd ~/windows/<id>` | Browse a window's tabs |
| `navigate <url>` | Navigate the current tab to a URL |
| `open <url>` | Open a URL in a new tab and enter it |

### DOM Tree

| Command | Description |
|---|---|
| `ls [options]` | List children (`-l`, `-r`, `-n N`, `--offset N`, `--type ROLE`, `--count`) |
| `cd <path>` | Navigate (`..`, `/` for root, `~` for browser, `main/form` for multi-level) |
| `pwd` | Print current path (DOM path or browser path) |
| `tree [depth]` | Tree view of current node (default depth: 2) |
| `cat <name>` | Read element's role, type, value, DOM ID, and text content |
| `text [name] [-n N]` | Bulk extract all text from a section (much faster than multiple `cat`) |
| `grep [opts] <pattern>` | Search children by name/role/value (`-r` recursive, `-n N` limit) |
| `find [opts] <pattern>` | Deep recursive search with full paths (`--type ROLE`, `-n N`) |
| `click <name>` | Click an element (falls back to coordinate-based click) |
| `focus <name>` | Focus an input element |
| `type <text>` | Type text into the focused element |
| `refresh` | Force re-fetch the Accessibility Tree |

### System

| Command | Description |
|---|---|
| `whoami` | Check session/auth cookies for the current page |
| `env` | Show environment variables |
| `export K=V` | Set an environment variable |
| `debug [sub]` | Inspect raw AX tree (`stats`, `raw`, `node <id>`) |
| `connect <token>` | Connect to an MCP server via WebSocket bridge |
| `disconnect` | Disconnect from the MCP server, clear token |
| `help` | Show all available commands |
| `clear` | Clear the terminal |

## How the Filesystem Mapping Works

AgentShell maps the browser into a two-level virtual filesystem:

### Browser Level (`~`)

The browser itself becomes the top of the filesystem hierarchy:

```
~                              (browser root)
├── windows/                   (all Chrome windows)
│   ├── <window-id>/           (tabs in that window)
│   │   ├── <tab-id>           (cd into = enter AX tree)
│   │   └── ...
│   └── ...
└── tabs/                      (flat listing of ALL tabs)
    ├── <tab-id>               (cd into = enter AX tree)
    └── ...
```

`cd`-ing into a tab transparently attaches CDP and drops you into its DOM tree.

### DOM Level (inside a tab)

Each tab's **Accessibility Tree** (AXTree) is read via the Chrome DevTools Protocol. Each AX node gets mapped to a virtual file or directory:

**Directories** (container roles): `navigation/`, `main/`, `form/`, `search/`, `list/`, `region/`, `dialog/`, `menu/`, `table/`, `Iframe/`, etc.

**Files** (interactive/leaf roles): `submit_btn`, `home_link`, `email_input`, `agree_chk`, `theme_switch`, etc.

`cd ..` from the DOM root exits back to the tab listing. `cd ~` returns to browser root from anywhere.

### Naming Heuristic

Names are generated from the node's accessible name and role:

| AX Node | Generated Name |
|---|---|
| `role=button, name="Submit"` | `submit_btn` |
| `role=link, name="Contact Us"` | `contact_us_link` |
| `role=textbox, name="Email"` | `email_input` |
| `role=checkbox, name="I agree"` | `i_agree_chk` |
| `role=navigation` | `navigation/` |
| `role=generic, no name, 1 child` | *(flattened — child promoted up)* |

Duplicate names are automatically disambiguated with `_2`, `_3`, etc.

### Node Flattening

The AX tree contains many "wrapper" nodes — ignored nodes, unnamed generics, and role=none elements that add structural noise without semantic meaning. AgentShell recursively flattens through these, promoting their children up so you see the meaningful elements without navigating through layers of invisible divs.

### Iframe Support

AgentShell discovers iframes via `Page.getFrameTree` and fetches each iframe's AX tree separately. Iframe nodes are merged into the main tree with prefixed IDs to avoid collisions, so elements inside iframes appear naturally in the filesystem.

### Color Coding

| Color | Meaning |
|---|---|
| **Blue (bold)** | Directories (containers) |
| **Green (bold)** | Buttons |
| **Magenta (bold)** | Links |
| **Yellow (bold)** | Text inputs / search boxes |
| **Cyan (bold)** | Checkboxes / radio / switches |
| **White** | Other elements |
| **Gray** | Images, metadata |

## Architecture

```
┌────────────────────┐                                     ┌─────────────────────┐
│  Claude Desktop /  │  MCP protocol (stdio)               │  Side Panel (UI)    │
│  MCP Client        │────────────────────┐                │                     │
└────────────────────┘                    │                │  React + Xterm.js   │
                                          ▼                │  - Paste support    │
                               ┌─────────────────────┐    │  - Tab completion   │
                               │  MCP Server          │    │  - Command history  │
                               │  (mcp-server/)       │    └─────────┬───────────┘
                               │                      │              │
                               │  Security layer:     │     chrome.runtime
                               │  - Auth token        │     .connect()
                               │  - Command tiers     │              │
                               │  - Domain allowlist  │    ┌─────────▼───────────┐
                               │  - Audit log         │    │  Background Worker  │
                               │  - Confirmation      │    │   (Shell Kernel)    │
                               └──────────┬───────────┘    │                     │
                                          │                │  Browser hierarchy  │
                               WebSocket (localhost:9876)   │  (~, tabs, windows) │
                               + auth token                │  Command parser     │
                               + alarm keepalive           │  Shell state (CWD)  │
                                          │                │  VFS mapper         │
                                          └───────────────►│  CDP client         │
                                                           │  DOM change detect  │
                                                           │  WebSocket bridge   │
                                                           └─────────┬───────────┘
                                                                     │
                                                            chrome.debugger
                                                            (CDP 1.3)
                                                                     │
                                                           ┌─────────▼───────────┐
                                                           │   Active Tab        │
                                                           │   Accessibility     │
                                                           │   Tree + iframes    │
                                                           │                     │
                                                           │   DOM events ──────►│
                                                           │   (auto-refresh)    │
                                                           └─────────────────────┘
```

The extension follows a **Thin Client / Fat Host** model. The side panel is a dumb terminal — it captures keystrokes, handles paste, and renders ANSI-colored text. All logic lives in the background service worker: command parsing, AX tree traversal, filesystem mapping, CDP interaction, browser hierarchy navigation, and DOM change detection.

### Source Layout

```
src/
  background/
    index.ts        # Shell kernel — commands, state, message router, auto-refresh, WS bridge
    cdp_client.ts   # Promise-wrapped chrome.debugger API + iframe discovery
    vfs_mapper.ts   # Accessibility Tree → virtual filesystem mapping
  sidepanel/
    index.html      # Side panel entry HTML
    index.tsx        # React entry point
    Terminal.tsx     # Xterm.js terminal (paste, tab completion, history)
  shared/
    types.ts        # Message types, AXNode interfaces, role constants
public/
  manifest.json     # Chrome Manifest V3
  options.html      # Extension settings page (MCP bridge config)
mcp-server/
  index.ts          # MCP server — WebSocket bridge, security hardening, audit log
  package.json      # MCP server dependencies
  tsconfig.json     # MCP server TypeScript config
```

## Tech Stack

- **React** + **TypeScript** — Side panel UI
- **Xterm.js** (`@xterm/xterm`) — Terminal emulator with Tokyo Night color scheme
- **Vite** — Build tooling with multi-entry Chrome Extension support
- **Chrome DevTools Protocol** (CDP 1.3) via `chrome.debugger` — AX tree access, element interaction, iframe discovery, DOM mutation events
- **Chrome Manifest V3** — `sidePanel`, `debugger`, `activeTab`, `cookies`, `storage`, `alarms` permissions

## Development

```bash
# Watch mode (rebuilds on file changes)
npm run dev

# One-time production build
npm run build

# Type checking
npm run typecheck
```

After building, reload the extension on `chrome://extensions/` and reopen the side panel to pick up changes.

## Connecting Claude Desktop (MCP Server)

AgentShell includes a hardened MCP server that lets Claude Desktop (or any MCP-compatible client) control the browser through AgentShell commands.

### Architecture

```
Claude Desktop
  ↓ MCP protocol (stdio)
mcp-server/index.ts (Node.js)
  ↕ WebSocket (localhost:9876) + auth token
Chrome Extension background.js
  ↓ CDP
Browser DOM
```

### Setup

**1. Install MCP server dependencies:**

```bash
cd mcp-server
npm install
```

**2. Configure Claude Desktop:**

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "agentshell": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/AgenticShell/mcp-server/index.ts", "--allow-write", "--no-confirm", "--token", "my-secret-token"],
      "env": {}
    }
  }
}
```

> **Note:** Use an absolute path (not `~`). The `--token` flag lets you set a known token so you can configure both sides without copy-pasting. The `--no-confirm` flag is recommended for Claude Desktop since the MCP server has no terminal for interactive confirmation prompts.

Restart Claude Desktop. AgentShell tools will appear.

**3. Connect the extension (Options Page):**

1. Go to `chrome://extensions/`
2. Find **AgentShell** and click **Options** (or right-click the extension icon → Options)
3. Enable the **MCP Bridge** toggle
4. Paste the same token you used in the Claude Desktop config (`my-secret-token`)
5. Click **Save** — the status indicator turns green when connected

The options page shows live connection status: **Disabled**, **Connecting**, **Connected**, or **Disconnected**.

**Alternative: Connect via terminal**

You can also connect from the AgentShell terminal instead of the options page:

```bash
agent@shell:$ connect my-secret-token
```

**4. Test it:**

Ask Claude: *"List my open tabs and tell me what's on the first one."*

### Security

The MCP server is hardened with multiple layers of security. **By default, it's read-only** — Claude can browse but not click or type.

#### Command Tiers

| Tier | Commands | Default | Enable With |
|------|----------|---------|-------------|
| **Read** | `ls`, `cd`, `pwd`, `cat`, `text`, `grep`, `find`, `tree`, `refresh`, `tabs`, `windows` | Enabled | *(always on)* |
| **Navigate** | `navigate`, `goto`, `open` | **Disabled** | `--allow-write` |
| **Write** | `click`, `focus`, `type` | **Disabled** | `--allow-write` |
| **Sensitive** | `whoami` (exposes cookies) | **Disabled** | `--allow-sensitive` |

The **Navigate** tier is separate from Write because navigation is equivalent to typing a URL — it requires `--allow-write` but skips the interactive confirmation prompt. This is important for Claude Desktop where `/dev/tty` is unavailable.

#### Security Flags

| Flag | Description |
|------|-------------|
| `--allow-write` | Enable click/focus/type commands |
| `--allow-sensitive` | Enable whoami (cookie access) |
| `--allow-all` | Shorthand for both |
| `--no-confirm` | Skip user confirmation for write actions (use with caution) |
| `--domains example.com,app.example.com` | Restrict commands to specific domains |
| `--expose-cookies` | Show full cookie values (default: redacted) |
| `--port N` | WebSocket port (default: 9876) |
| `--log-file PATH` | Audit log file (default: audit.log) |

#### User Confirmation

When write commands are enabled, the MCP server prompts in its terminal before executing:

```
[AgentShell] Claude wants to: click submit_btn
Allow? (y/n):
```

This blocks until you type `y` or `n` (60-second timeout → deny). Disable with `--no-confirm` for trusted environments. **When using Claude Desktop**, always use `--no-confirm` since the MCP server runs without a terminal — without it, write commands will silently fail.

#### Auth Token

- Use `--token` to set a known token in the MCP server config, or let the server generate a random one on startup
- The extension must present this token (via the options page or `connect <token>`) before the bridge works
- WebSocket connections without a valid token are rejected
- Token is stored in `chrome.storage.local` — survives service worker restarts

#### Domain Allowlist

With `--domains`, commands are only executed when the active tab's URL matches:

```bash
npx tsx index.ts --allow-write --domains "github.com,docs.google.com"
```

#### Audit Log

Every command is logged with timestamps to `audit.log` (or `--log-file`):

```
[2026-02-07T12:00:00.000Z] EXECUTE: ls -l
[2026-02-07T12:00:01.000Z] RESULT: 12 items
[2026-02-07T12:00:05.000Z] [WRITE] EXECUTE: click submit_btn
[2026-02-07T12:00:05.500Z] [WRITE] RESULT: ✓ Clicked: submit_btn (button)
```

#### Disconnecting

Disable the MCP Bridge toggle in the extension options page, or run `disconnect` in the AgentShell terminal:

```bash
agent@shell:$ disconnect
✓ Disconnected from MCP server.
```

### MCP Tools Reference

| MCP Tool | Maps To | Tier |
|----------|---------|------|
| `agentshell_tabs` | `tabs` (list all tabs) | Read |
| `agentshell_ls` | `ls [options]` (DOM or browser level) | Read |
| `agentshell_cd` | `cd <path>` (`~`, `~/tabs/`, `/`, `..`) | Read |
| `agentshell_pwd` | `pwd` | Read |
| `agentshell_cat` | `cat <name>` | Read |
| `agentshell_text` | `text [name] [-n N]` (bulk text extraction) | Read |
| `agentshell_find` | `find [pattern] [--type ROLE] [-n N]` | Read |
| `agentshell_grep` | `grep [-r] [-n N] <pattern>` | Read |
| `agentshell_tree` | `tree [depth]` | Read |
| `agentshell_refresh` | `refresh` | Read |
| `agentshell_navigate` | `navigate <url>` (current tab) | Navigate |
| `agentshell_open` | `open <url>` (new tab) | Navigate |
| `agentshell_click` | `click <name>` | Write |
| `agentshell_focus` | `focus <name>` | Write |
| `agentshell_type` | `type <text>` | Write |
| `agentshell_whoami` | `whoami` | Sensitive |
| `agentshell_execute` | *(any command)* | Varies |

## How This Project Was Built

The technical specification for AgentShell was authored by **Google Gemini**, designed as a comprehensive prompt that could be handed directly to a coding agent to scaffold and build the entire project from scratch. The full original specification is preserved in [`intitial_project_prompt.md`](intitial_project_prompt.md).

The implementation was then built by **Claude** (Anthropic) via [Claude Code](https://claude.ai/code), working from that specification.

An AI-designed project, built by another AI, intended for AI agents to use. It's agents all the way down.

## License

MIT
