# DOMShell

```
| |
        ___|_|___
       |___|_|___|
       |   | |   |
       |___|_|___|
        /  | |  \
       /   | |   \
      |____|_|____|
      |           |
      |  DOMSHELL |
      |           |
      |___________|
      |###########|
      |###########|
       \#########/
        \_______/
 
  ██   ██ ██ ███████
  ██   ██ ██   ███
  ███████ ██   ██
  ██░░░██ ██   ██
  ██   ██ ██   ██
  ░░   ░░ ░░   ░░
   ███████ ██   ██ ███████
     ███   ███████ ██░░░░░
     ███   ██░░░██ █████
     ███   ██   ██ ██░░░
     ███   ██   ██ ███████
     ░░░   ░░   ░░ ░░░░░░░
   ██████   ██████  ███    ███  ██
   ██   ██ ██    ██ ████  ████  ██
   ██   ██ ██    ██ ██ ████ ██  ██
   ██   ██ ██    ██ ██  ██  ██  ░░
   ██████   ██████  ██      ██  ██
   ░░░░░░   ░░░░░░  ░░      ░░  ░░
```

**The browser is your filesystem.** A Chrome Extension that lets AI agents (and humans) browse the web using standard Linux commands — `ls`, `cd`, `cat`, `grep`, `click` — via a terminal in the Chrome Side Panel.

DOMShell maps the browser into a virtual filesystem. Windows and tabs become top-level directories (`~`). Each tab's Accessibility Tree becomes a nested filesystem where container elements are directories and buttons, links, and inputs are files. Navigate Chrome the same way you'd navigate `/usr/local/bin`.

## Why

AI agents that interact with websites typically rely on screenshots, pixel coordinates, or brittle CSS selectors. DOMShell takes a different approach: it exposes the browser's own Accessibility Tree as a familiar filesystem metaphor.

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
git clone https://github.com/apireno/DOMShell.git
cd DOMShell
npm install
npm run build
```

### Load into Chrome

1. Open `chrome://extensions/`
2. Enable **Developer mode** (toggle in top right)
3. Click **Load unpacked**
4. Select the `dist/` folder
5. Click the DOMShell icon in your toolbar — the side panel opens

## Usage

### Getting Started

Open any webpage, then open the DOMShell side panel. You'll see a terminal:

```
╔══════════════════════════════════════╗
║   DOMShell v1.0.0                    ║
║   The browser is your filesystem.    ║
╚══════════════════════════════════════╝

Type 'help' to see available commands.
Type 'tabs' to see open browser tabs, then 'cd tabs/<id>' to enter one.

dom@shell:~$
```

You start at `~` (the browser root). Jump straight to the active tab with `here`, or explore:

```
dom@shell:~$ ls
  windows/       (2 windows)
  tabs/          (5 tabs)

dom@shell:~$ here
✓ Entered tab 123
  Title: Google
  URL:   https://google.com
  AX Nodes: 247
```

### Browsing Tabs and Windows

```bash
# List all open tabs
dom@shell:~$ tabs
  ID     TITLE                       URL                        WIN
  123    Google                       google.com                 1
  124    GitHub - apireno             github.com/apireno         1
  125    Wikipedia                    en.wikipedia.org                 2

# Switch to a tab by ID
dom@shell:~$ cd tabs/125
✓ Entered tab 125
  Title: Wikipedia
  URL:   https://en.wikipedia.org
  AX Nodes: 312

# You're now inside the tab's DOM tree
dom@shell:~$ pwd
~/tabs/125

# Go back to browser level
dom@shell:~$ cd ~
dom@shell:~$

# Or use substring matching
dom@shell:~$ cd tabs/github
✓ Entered tab 124 (GitHub - apireno)

# List windows (shows tabs grouped under each window)
dom@shell:~$ windows
Window 1 (focused)
├── *123   Google                        google.com
├──  124   GitHub - apireno              github.com/apireno
└──  125   Wikipedia                     en.wikipedia.org

Window 2
├── *126   Stack Overflow                stackoverflow.com
└──  127   MDN Web Docs                  developer.mozilla.org

# Browse a specific window's tabs
dom@shell:~$ cd windows/2
dom@shell:~/windows/2$ ls
  ID     TITLE                       URL
  125    Wikipedia                    en.wikipedia.org
  126    LinkedIn                     linkedin.com
```

You can also navigate or open new tabs:

```bash
# Navigate the current tab to a URL (requires being inside a tab)
dom@shell:~$ navigate https://example.com

# Open a URL in a new tab (works from anywhere)
dom@shell:~$ open https://github.com
✓ Opened new tab
  URL:   https://github.com
  Title: GitHub
  AX Nodes: 412
```

### Navigating the DOM

Once you're inside a tab, the Accessibility Tree appears as a filesystem:

```bash
# List children of the current node
dom@shell:~$ ls
navigation/
main/
complementary/
contentinfo/
skip_to_content_link
logo_link

# Long format shows type prefixes and roles
dom@shell:~$ ls -l
[d] navigation     navigation/
[d] main           main/
[x] link           skip_to_content_link
[x] link           logo_link

# Filter by type
dom@shell:~$ ls --type link
skip_to_content_link
logo_link

# Show DOM metadata (href, src, id) inline — great for finding URLs
dom@shell:~$ ls --meta --type link
[x] link           skip_to_content_link  href=https://example.com/#content <a>
[x] link           logo_link             href=https://example.com/ <a>

# Paginate large directories
dom@shell:~$ ls -n 10              # First 10 items
dom@shell:~$ ls -n 10 --offset 10  # Items 11-20

# Count children by type
dom@shell:~$ ls --count
45 total (12 [d], 28 [x], 5 [-])

# Enter a directory (container element)
dom@shell:~$ cd navigation

# See where you are
dom@shell:~$ pwd
~/tabs/125/navigation

# Go back up
dom@shell:~$ cd ..

# Jump to browser root
dom@shell:~$ cd ~

# Multi-level paths work too
dom@shell:~$ cd main/article/form

# Path variable: %here% expands to the focused tab (via its window)
dom@shell:~$ cd %here%           # Enter the active tab
dom@shell:~$ cd %here%/..        # Go to the window containing the active tab
dom@shell:~$ cd %here%/main      # Enter the active tab and cd into main
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
# Inspect an element — cat shows full AX + DOM metadata
dom@shell:~$ cat submit_btn
--- submit_btn ---
  Role:  button
  Type:  [x] interactive
  AXID:  42
  DOM:   backend#187
  Tag:   <button>
  ID:    submit-form
  Class: btn btn-primary
  Text:  Submit Form
  HTML:  <button id="submit-form" class="btn btn-primary">Submit Form</button>

# cat on a link reveals the href URL
dom@shell:~$ cat Read_more
--- Read_more ---
  Role:  link
  Type:  [x] interactive
  AXID:  98
  DOM:   backend#312
  Tag:   <a>
  URL:   https://en.wikipedia.org/wiki/Article_Title
  Text:  Read more
  HTML:  <a href="https://en.wikipedia.org/wiki/Article_Title">Read more</a>

# Navigate to parent to find its properties (e.g. span inside a link)
dom@shell:~$ cd ..
dom@shell:~$ cat parent_link

# Bulk extract ALL text from a section (one call instead of 50+ cat calls)
dom@shell:/main$ text
[textContent of /main — 4,821 chars]
Heading: Welcome to Our Site
Today we announce the launch of our new product...
(full article text continues)

# Extract text from a specific child
dom@shell:~$text main
[textContent of main — 4,821 chars]

# Limit output length
dom@shell:~$text main -n 500

# Get a tree view (default depth: 2)
dom@shell:~$tree
navigation/
├── [x] home_link
├── [x] about_link
├── [x] products_link
└── [x] contact_link

# Deeper tree
dom@shell:~$tree 4
```

### Searching

```bash
# Search current directory
dom@shell:~$grep login
[x] login_btn (button)
[d] login_form (form)
[x] login_link (link)

# Recursive search across all descendants
dom@shell:~$grep -r search
[x] search_search (combobox)
[x] search_btn (button)

# Limit results
dom@shell:~$grep -r -n 5 link

# Deep search with full paths (like Unix find)
dom@shell:~$find search
[x] /search_2/search_search (combobox)
[x] /search_2/search_btn (button)

# Find by role type
dom@shell:~$find --type combobox
[x] /search_2/search_search (combobox)

dom@shell:~$find --type textbox
[x] /main/form/email_input (textbox)
[x] /main/form/name_input (textbox)

# Limit results
dom@shell:~$find --type link -n 5

# Find all links with their URLs (great for content extraction)
dom@shell:~$find --type link --meta
[x] /nav/home_link (link)  href=https://example.com/ <a>
[x] /main/Read_more (link)  href=https://example.com/article <a>
```

### Command Chaining (Bash-Style Composition)

DOMShell works like a filesystem — use the same mental model as searching files on disk. `grep` discovers where content lives (like `grep -r` in bash), `cd` scopes your context, and `text`/`cat`/`find` reads content (like `cat`/`head`/`less`). The pipe operator (`|`) filters output, just like bash.

**The pattern is: grep (locate) → cd (scope) → extract (read).**

```bash
# Workflow 1: Find and read an article section
dom@shell:~$ grep -r article
[d] article (article)  →  ./main/article/
dom@shell:~$ cd main/article
dom@shell:~/main/article$ text
[full article content in one call]

# Workflow 2: Find a section and extract its links
dom@shell:~$ grep -r references
[d] references (region)  →  ./main/article/references/
dom@shell:~$ cd main/article/references
dom@shell:~/main/article/references$ find --type link --meta
[x] /wiki_link (link)  href=https://en.wikipedia.org/... <a>
[x] /paper_link (link)  href=https://arxiv.org/... <a>

# Workflow 3: Find a table and extract structured data
dom@shell:~$ grep -r table
[d] table_4091 (table)  →  ./main/section/table_4091/
dom@shell:~$ extract_table table_4091
| Name   | Value  | Date       |
|--------|--------|------------|
| Alpha  | 42     | 2025-01-15 |
| Beta   | 87     | 2025-02-20 |

# Workflow 4: Discover sections, then drill into one
dom@shell:~$ grep -r heading
[−] Introduction_heading (heading)  →  ./main/article/Introduction_heading
[−] Methods_heading (heading)  →  ./main/article/Methods_heading
[−] Results_heading (heading)  →  ./main/article/Results_heading
dom@shell:~$ cd main/article/Results_heading
dom@shell:~/main/article/Results_heading$ text
[text content of the Results section]

# Workflow 5: Find elements by visible text (not just name)
dom@shell:~$ grep -r --content "sign up"
[x] get_started_btn (button)  →  ./main/hero/get_started_btn
# The button's NAME is "get_started_btn" but its displayed text says "Sign Up Free"
dom@shell:~$ click get_started_btn
```

### Pipe Operator

The pipe operator (`|`) lets you filter command output, just like bash:

```bash
# Filter find results to only GitHub links
dom@shell:~$ find --type link --meta | grep github
[x] /main/repo_link (link)  href=https://github.com/example <a>

# Filter ls output to elements mentioning "login"
dom@shell:~$ ls --text | grep login
[x] login_btn  "Log in to your account"

# Limit results with head
dom@shell:~$ find --type heading | head -n 3
[−] /main/intro_heading (heading)
[−] /main/features_heading (heading)
[−] /main/pricing_heading (heading)

# Chain multiple pipes
dom@shell:~$ find --type link --meta | grep docs | head -n 5
```

### Path Resolution

All commands accept relative paths, eliminating the need to `cd` first:

```bash
# Read text from a nested element directly
dom@shell:~$ text main/article/paragraph_2971

# Click a button inside a form without cd'ing
dom@shell:~$ click main/form/submit_btn

# Inspect a link in the nav
dom@shell:~$ cat navigation/home_link
```

### Sibling Navigation

Use `--after` and `--before` flags on `ls` to find content relative to a landmark:

```bash
# Show the 3 elements after a heading
dom@shell:~$ ls --after See_also_heading -n 3 --text
[d] related_topics_list  "Machine Learning, Deep Learning, Neural..."
[−] paragraph_4512       "For more information on these topics..."
[x] Read_more_link       "Read more on Wikipedia"

# Find links after a specific section heading
dom@shell:~$ ls --after References_heading --type link --meta
[x] source_1_link (link)  href=https://arxiv.org/... <a>
[x] source_2_link (link)  href=https://doi.org/... <a>
```

The key insight: `grep` output feeds `cd`, and `cd` scopes everything else. When you don't know where content lives on a page, always grep first, then scope, then extract.

### Interacting with Elements

```bash
# Click a button or link
dom@shell:~$click submit_btn
✓ Clicked: submit_btn (button)
(tree will auto-refresh on next command)

# Focus an input field
dom@shell:~$focus email_input
✓ Focused: email_input

# Type into the focused field
dom@shell:~$type hello@example.com
✓ Typed 17 characters

# Navigate to a URL (current tab)
dom@shell:~$navigate https://example.com
✓ Navigated to https://example.com

# Open a URL in a new tab
dom@shell:~$open https://github.com
✓ Opened new tab → https://github.com
```

### Auto-Refresh on DOM Changes

DOMShell automatically detects when the page changes — navigation, DOM mutations, or content updates from clicks. You no longer need to manually run `refresh`:

```bash
dom@shell:~$click search_btn
✓ Clicked: search_btn (button)
(tree will auto-refresh on next command)

dom@shell:~$ls
(page changed — tree refreshed, 312 nodes, path reset to tab root)
main/
navigation/
search_results/
...
```

If the page navigated, CWD is reset to the tab root. If the DOM just updated in place, your CWD is preserved. You can still force a manual refresh:

```bash
dom@shell:~$refresh
✓ Refreshed. 312 AX nodes loaded.
```

### Tab Completion

Press `Tab` to auto-complete commands and element names — works like bash:

```bash
dom@shell:$ ta<Tab>
# completes to: tabs

dom@shell:$ cd nav<Tab>
# completes to: cd navigation/

dom@shell:$ click sub<Tab>
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
dom@shell:~$whoami
URL: https://example.com
Status: Authenticated
Via: session_id
Expires: 2025-12-31T00:00:00.000Z
Total cookies: 12

# Environment variables
dom@shell:~$env
SHELL=/bin/domshell
TERM=xterm-256color

# Set a variable
dom@shell:~$export API_KEY=sk-abc123

# Debug the raw AX tree
dom@shell:~$debug stats
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
dom@shell:$ ls --help
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
| `windows` | List all windows with their tabs grouped underneath |
| `here` | Jump to the active tab in the focused window |
| `cd ~` | Go to browser root |
| `cd ~/tabs/<id>` | Switch to a tab by ID (enters automatically) |
| `cd ~/tabs/<pattern>` | Switch to a tab by title/URL substring match |
| `cd ~/windows/<id>` | Browse a window's tabs |
| `navigate <url>` | Navigate the current tab to a URL |
| `open <url>` | Open a URL in a new tab and enter it |

### DOM Tree

| Command | Description |
|---|---|
| `ls [options]` | List children (`-l`, `--meta`, `--text`, `-r`, `-n N`, `--offset N`, `--type ROLE`, `--count`, `--after NAME`, `--before NAME`) |
| `cd <path>` | Navigate (`..`, `~` or `/` for browser root, `%here%` for focused tab, `main/form` for multi-level) |
| `pwd` | Print current path (DOM path or browser path) |
| `tree [depth]` | Tree view of current node (default depth: 2) |
| `cat <name>` | Full element metadata: AX info + DOM properties (tag, href, src, id, class, outerHTML) |
| `text [name] [-n N]` | Bulk extract all text from a section (much faster than multiple `cat`) |
| `read [name] [opts]` | Structured subtree extraction (`--meta`, `--text`, `-d N` depth) — tree + content in one call |
| `grep [opts] <pattern>` | Search by name/role/value (`-r` recursive, `--content` match visible text, `-n N` limit) |
| `find [opts] <pattern>` | Deep recursive search (`--type ROLE`, `--meta`, `--text`, `--content`, `-n N`) |
| `extract_links [name]` | Extract all links as `[text](url)` format (`-n N` limit) |
| `extract_table <name>` | Extract table as markdown or CSV (`--format csv`, `-n N` row limit) |
| `click <name>` | Click an element (falls back to coordinate-based click) |
| `focus <name>` | Focus an input element |
| `type <text>` | Type text into the focused element |
| `submit <input> <val>` | Atomic form fill: focus + clear + type + submit (`--submit btn` or Enter) |
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

DOMShell maps the browser into a two-level virtual filesystem:

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

The AX tree contains many "wrapper" nodes — ignored nodes, unnamed generics, and role=none elements that add structural noise without semantic meaning. DOMShell recursively flattens through these, promoting their children up so you see the meaningful elements without navigating through layers of invisible divs.

### Iframe Support

DOMShell discovers iframes via `Page.getFrameTree` and fetches each iframe's AX tree separately. Iframe nodes are merged into the main tree with prefixed IDs to avoid collisions, so elements inside iframes appear naturally in the filesystem.

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
┌────────────────────┐
│  Claude Desktop    │──┐
└────────────────────┘  │
┌────────────────────┐  │  HTTP POST/GET/DELETE              ┌─────────────────────┐
│  Claude CLI        │──┼─ localhost:3001/mcp ──┐            │  Side Panel (UI)    │
└────────────────────┘  │  (Bearer token auth)  │            │                     │
┌────────────────────┐  │                       │            │  React + Xterm.js   │
│  Cursor / Other    │──┘                       │            │  - Paste support    │
└────────────────────┘                          ▼            │  - Tab completion   │
                               ┌─────────────────────┐      │  - Command history  │
                               │  MCP Server          │      └─────────┬───────────┘
                               │  (mcp-server/)       │                │
                               │                      │       chrome.runtime
                               │  Express HTTP server  │       .connect()
                               │  Per-session MCP      │                │
                               │  Security layer:     │      ┌─────────▼───────────┐
                               │  - Auth token        │      │  Background Worker  │
                               │  - Command tiers     │      │   (Shell Kernel)    │
                               │  - Domain allowlist  │      │                     │
                               │  - Audit log         │      │  Browser hierarchy  │
                               └──────────┬───────────┘      │  (~, tabs, windows) │
                                          │                  │  Command parser     │
                               WebSocket (localhost:9876)     │  Shell state (CWD)  │
                               + auth token                  │  VFS mapper         │
                               + alarm keepalive             │  CDP client         │
                                          │                  │  DOM change detect  │
                                          └─────────────────►│  WebSocket bridge   │
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

The MCP server runs as a **standalone HTTP service** that any number of MCP clients can connect to simultaneously. It exposes two ports: an HTTP endpoint for MCP clients (default 3001) and a WebSocket bridge for the Chrome extension (default 9876).

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
  index.ts          # MCP server — standalone Express HTTP + StreamableHTTP, WebSocket bridge, security
  proxy.ts          # Stdio↔HTTP bridge for clients that require command/args (e.g. Claude Desktop)
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

## Connecting MCP Clients (Claude Desktop, CLI, Cursor, etc.)

DOMShell includes a hardened MCP server that lets any MCP-compatible client control the browser through DOMShell commands. The server runs as a standalone HTTP service — multiple clients can connect simultaneously.

### Architecture

```
User starts independently:
  npx tsx mcp-server/index.ts --allow-write --token xyz
    → HTTP on :3001/mcp  (MCP clients)
    → WebSocket on :9876  (Chrome extension)

Claude Desktop spawns (stdio proxy):                    ┐
  npx tsx mcp-server/proxy.ts --port 3001 --token xyz   ├─► HTTP :3001/mcp
Claude CLI connects directly:                           │
  url: http://localhost:3001/mcp?token=xyz              │
Gemini CLI connects directly:                           │
  url: http://localhost:3001/mcp?token=xyz              ┘
```

The MCP server is a **standalone HTTP service** — you start it independently, and any number of MCP clients connect to it. No single client "owns" the server process. For clients that require stdio (like Claude Desktop), a tiny proxy (`proxy.ts`) bridges stdio to the running HTTP server.

### Setup

**1. Install MCP server dependencies:**

```bash
cd mcp-server
npm install
```

**2. Start the MCP server:**

```bash
cd mcp-server
npx tsx index.ts --allow-write --no-confirm --token my-secret-token
```

The server starts two listeners:
- **HTTP** on `http://127.0.0.1:3001/mcp` — MCP client endpoint
- **WebSocket** on `ws://127.0.0.1:9876` — Chrome extension bridge

> **Tip:** Use `--token` to set a known token so you can pre-configure clients. If omitted, a random token is generated and printed on startup.

**3. Connect MCP clients:**

**Claude CLI / Gemini CLI / Cursor** (direct HTTP — recommended):

```
http://localhost:3001/mcp?token=my-secret-token
```

**Claude Desktop** (requires stdio — use the proxy):

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "domshell": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/DOMShell/mcp-server/proxy.ts", "--port", "3001", "--token", "my-secret-token"],
      "env": {}
    }
  }
}
```

> **Note:** The proxy connects to the already-running server over HTTP. If the server isn't running, the proxy will fail. Use an absolute path (not `~`).

Restart Claude Desktop. DOMShell tools will appear.

**3. Connect the extension (Options Page):**

1. Go to `chrome://extensions/`
2. Find **DOMShell** and click **Options** (or right-click the extension icon → Options)
3. Enable the **MCP Bridge** toggle
4. Paste the same token you used in the Claude Desktop config (`my-secret-token`)
5. Click **Save** — the status indicator turns green when connected

The options page shows live connection status: **Disabled**, **Connecting**, **Connected**, or **Disconnected**.

**Alternative: Connect via terminal**

You can also connect from the DOMShell terminal instead of the options page:

```bash
dom@shell:$ connect my-secret-token
```

**4. Test it:**

Ask Claude: *"List my open tabs and tell me what's on the first one."*

### Security

The MCP server is hardened with multiple layers of security. **By default, it's read-only** — Claude can browse but not click or type.

#### Command Tiers

| Tier | Commands | Default | Enable With |
|------|----------|---------|-------------|
| **Read** | `ls`, `cd`, `pwd`, `cat`, `text`, `grep`, `find`, `tree`, `refresh`, `tabs`, `windows`, `here` | Enabled | *(always on)* |
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
| `--mcp-port N` | MCP HTTP endpoint port (default: 3001) |
| `--port N` | WebSocket bridge port (default: 9876) |
| `--log-file PATH` | Audit log file (default: audit.log) |

#### User Confirmation

When write commands are enabled, the MCP server prompts in its terminal before executing:

```
[DOMShell] Claude wants to: click submit_btn
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

Disable the MCP Bridge toggle in the extension options page, or run `disconnect` in the DOMShell terminal:

```bash
dom@shell:$ disconnect
✓ Disconnected from MCP server.
```

### MCP Tools Reference

| MCP Tool | Maps To | Tier |
|----------|---------|------|
| `domshell_tabs` | `tabs` (list all tabs) | Read |
| `domshell_here` | `here` (jump to active tab) | Read |
| `domshell_ls` | `ls [options]` (DOM or browser level) | Read |
| `domshell_cd` | `cd <path>` (`~`, `~/tabs/`, `/`, `..`) | Read |
| `domshell_pwd` | `pwd` | Read |
| `domshell_cat` | `cat <name>` | Read |
| `domshell_text` | `text [name] [-n N]` (bulk text extraction) | Read |
| `domshell_read` | `read [name] [--meta] [--text] [-d N]` (structured subtree) | Read |
| `domshell_find` | `find [pattern] [--type ROLE] [--meta] [--text] [-n N]` | Read |
| `domshell_grep` | `grep [-r] [-n N] [--content] <pattern>` (section discovery) | Read |
| `domshell_tree` | `tree [depth]` | Read |
| `domshell_extract_links` | `extract_links [name] [-n N]` (all links as `[text](url)`) | Read |
| `domshell_extract_table` | `extract_table <name> [--format csv]` (table → markdown/CSV) | Read |
| `domshell_refresh` | `refresh` | Read |
| `domshell_navigate` | `navigate <url>` (current tab) | Navigate |
| `domshell_open` | `open <url>` (new tab) | Navigate |
| `domshell_click` | `click <name>` | Write |
| `domshell_focus` | `focus <name>` | Write |
| `domshell_type` | `type <text>` | Write |
| `domshell_submit` | `submit <input> <value> [--submit btn]` (atomic form fill) | Write |
| `domshell_whoami` | `whoami` | Sensitive |
| `domshell_execute` | *(any command)* | Varies |

## Roadmap

### Distribution & Setup

- [ ] **Chrome Web Store listing** — publish to the store for one-click install
- [ ] **GitHub release with .crx** — downloadable extension package for sideloading
- [ ] **MCP setup wizard** — an `npx domshell init` command (or in-extension prompt) that generates the Claude Desktop JSON config, sets a shared token, and writes it to `claude_desktop_config.json` automatically
- [ ] **Support for other MCP clients** — Gemini Desktop, OpenAI ChatGPT desktop, Cursor, Windsurf, and other MCP-compatible hosts

### New Commands

- [ ] **`watch` / `cron`** — periodic re-execution of a command (e.g. `watch ls` to poll for DOM changes, `cron "5s" "text main"` to sample content)
- [ ] **`history`** — command history with recall (`history`, `!n` to re-run)
- [ ] **`back` / `forward`** — browser-style history navigation within the current tab
- [ ] **`close`** — close the current tab (`close` or `close <tab-id>`)
- [ ] **`screenshot`** — capture a screenshot of the current tab (useful for visual verification alongside AX tree inspection)
- [x] **`pipe` / `|`** — pipe output between commands (e.g. `find --type link | grep login`)
- [ ] **`select <name>`** — select an option from a `<select>` dropdown by value or visible text
- [ ] **`scroll`** — scroll the page or a specific element (`scroll down`, `scroll up`, `scroll <name>`)
- [ ] **`wait`** — wait for a specific element to appear (e.g. `wait submit_btn` blocks until it exists in the tree)
- [ ] **`for` loop** — iterate over elements (e.g. `for item in $(find --type link); do cat $item; done`) — basic shell-style looping for batch operations
- [ ] **`.sh` scripts** — save and execute multi-command shell scripts (e.g. `run scrape.sh`) for repeatable workflows

### JavaScript Layer

- [ ] **`js` command** — execute arbitrary JavaScript in the tab context and return the result
- [ ] **JS functions as executables** — expose page-level JavaScript functions as "files" in a virtual `/js/` or `/functions/` directory; `ls /js/` lists callable functions, `cat /js/fetchData` shows the signature, and running `/js/fetchData --arg1 value` executes it with arguments
- [ ] **`eval <expr>`** — quick expression evaluation (e.g. `eval document.title`, `eval window.location.href`)

### Agent Ergonomics

- [x] **`--text` flag** — show visible text previews inline with `ls` and `find` using `.innerText` (rendered text only, respects CSS visibility); configurable length via `--textlen N`; `cat` also shows VisibleText separately from textContent
- [x] **`--meta` flag** — show DOM properties (href, src, id, tag) inline with `ls`, `find`, and `read` output — essential for extracting URLs without separate `cat` calls
- [x] **`--content` matching** — search by visible text content with `grep --content` and `find --content` (or `find --text "pattern"`) — finds elements by what they display, not just their AX name
- [x] **Path resolution** — all commands accept relative paths (e.g. `text main/article/paragraph`, `click form/submit_btn`) — eliminates unnecessary `cd` round-trips
- [x] **Sibling navigation** — `--after`/`--before` flags on `ls` to slice children relative to a landmark element (e.g. `ls --after heading --type link --meta`)
- [ ] **`bookmark` / `alias`** — save named paths for quick navigation (e.g. `bookmark inbox ~/tabs/gmail/main/inbox_list`)
- [ ] **Multi-tab operations** — run a command across multiple tabs (e.g. `each tab text main` to extract text from every open tab)
- [ ] **Structured output mode** — `--json` flag on commands for machine-parseable output (e.g. `ls --json`, `cat --json`)
- [ ] **Session persistence** — save and restore shell state (path, env vars, bookmarks) across extension reloads
- [ ] **`diff`** — compare two AX tree snapshots to see what changed after an action

### Platform

- [ ] **Standalone headless browser** — ship DOMShell as a self-contained headless Chromium process (via [Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/) or embedded Chromium) that agents launch directly — no extension install, no user Chrome profile; just `npx domshell --headless` and connect via MCP. Ideal for CI pipelines, server-side automation, and agent-in-a-loop workflows where a visible browser isn't needed
- [ ] **Firefox extension** — port to Firefox using WebExtensions API + remote debugging protocol
- [ ] **Playwright/Puppeteer backend** — alternative to Chrome extension for headless agent workflows
- [ ] **REST API mode** — expose DOMShell commands over HTTP for non-MCP integrations
- [ ] **WASM build** — compile DOMShell to WebAssembly so it can be embedded directly on a website for interactive demos without requiring a Chrome extension install

## How This Project Was Built

The technical specification for DOMShell was authored by **Google Gemini**, designed as a comprehensive prompt that could be handed directly to a coding agent to scaffold and build the entire project from scratch. The full original specification is preserved in [`intitial_project_prompt.md`](intitial_project_prompt.md).

The implementation was then built by **Claude** (Anthropic) via [Claude Code](https://claude.ai/code), working from that specification.

An AI-designed project, built by another AI, intended for AI agents to use. It's agents all the way down.

## License

MIT
