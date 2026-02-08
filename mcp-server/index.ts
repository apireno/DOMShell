import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express, { type Request, type Response, type NextFunction } from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, openSync, readSync, writeSync } from "node:fs";

// ---- CLI Flags ----

const args = process.argv.slice(2);

function hasFlag(name: string): boolean {
  return args.includes(name);
}

function getFlagValue(name: string, fallback: string): string {
  const idx = args.indexOf(name);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : fallback;
}

const ALLOW_WRITE = hasFlag("--allow-write") || hasFlag("--allow-all");
const ALLOW_SENSITIVE = hasFlag("--allow-sensitive") || hasFlag("--allow-all");
const NO_CONFIRM = hasFlag("--no-confirm");
const EXPOSE_COOKIES = hasFlag("--expose-cookies");
const PORT = parseInt(getFlagValue("--port", "9876"), 10);
const MCP_PORT = parseInt(getFlagValue("--mcp-port", "3001"), 10);
const LOG_FILE = getFlagValue("--log-file", "audit.log");
const ALLOWED_DOMAINS = getFlagValue("--domains", "")
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

// ---- Auth Token ----

const AUTH_TOKEN = getFlagValue("--token", "") || randomBytes(24).toString("hex");

// ---- Logging ----

function log(msg: string): void {
  process.stderr.write(`[DOMShell MCP] ${msg}\n`);
}

function audit(entry: string): void {
  const line = `[${new Date().toISOString()}] ${entry}\n`;
  try {
    appendFileSync(LOG_FILE, line);
  } catch {
    // Ignore log write failures
  }
}

// ---- Command Tiers ----

const NAVIGATE_COMMANDS = new Set(["navigate", "goto", "open"]);
const WRITE_COMMANDS = new Set(["click", "focus", "type"]);
const SENSITIVE_COMMANDS = new Set(["whoami"]);

function getCommandTier(command: string): "read" | "navigate" | "write" | "sensitive" {
  const cmd = command.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (NAVIGATE_COMMANDS.has(cmd)) return "navigate";
  if (WRITE_COMMANDS.has(cmd)) return "write";
  if (SENSITIVE_COMMANDS.has(cmd)) return "sensitive";
  return "read";
}

function isCommandAllowed(command: string): { allowed: boolean; reason?: string } {
  const tier = getCommandTier(command);
  if (tier === "navigate" && !ALLOW_WRITE) {
    return { allowed: false, reason: "Navigation commands (navigate/open) are disabled. Start the MCP server with --allow-write or --allow-all." };
  }
  if (tier === "write" && !ALLOW_WRITE) {
    return { allowed: false, reason: "Write commands (click/focus/type) are disabled. Start the MCP server with --allow-write or --allow-all." };
  }
  if (tier === "sensitive" && !ALLOW_SENSITIVE) {
    return { allowed: false, reason: "Sensitive commands (whoami) are disabled. Start the MCP server with --allow-sensitive or --allow-all." };
  }
  return { allowed: true };
}

// ---- User Confirmation via /dev/tty ----

function confirmAction(description: string): Promise<boolean> {
  if (NO_CONFIRM) return Promise.resolve(true);

  return new Promise((resolve) => {
    try {
      const fd = openSync("/dev/tty", "r+");
      const prompt = `\n[DOMShell] Claude wants to: ${description}\nAllow? (y/n): `;
      writeSync(fd, prompt);

      const buf = Buffer.alloc(10);
      const bytesRead = readSync(fd, buf, 0, 10, null);
      const answer = buf.slice(0, bytesRead).toString().trim().toLowerCase();

      resolve(answer === "y" || answer === "yes");
    } catch {
      // /dev/tty not available (e.g., Windows, or running without a terminal)
      log("WARNING: Cannot open /dev/tty for confirmation. Denying write action.");
      log("Use --no-confirm to skip confirmation prompts.");
      resolve(false);
    }

    // Timeout after 60 seconds
    setTimeout(() => resolve(false), 60000);
  });
}

// ---- Sensitive Data Redaction ----

function redactSensitiveOutput(command: string, output: string): string {
  if (!SENSITIVE_COMMANDS.has(command.trim().split(/\s+/)[0]?.toLowerCase() ?? "")) {
    return output;
  }

  if (!EXPOSE_COOKIES) {
    // Redact cookie values — pattern: "Via: cookie_name" lines are OK, but
    // any line that looks like a cookie value assignment gets masked
    return output.replace(
      /^(.*?(?:cookie|session|token|jwt|auth|sid).*?=\s*)(.{4})(.+?)(.{4})$/gim,
      (_, prefix, start, _middle, end) => `${prefix}${start}***${end}`
    );
  }

  return output;
}

// ---- WebSocket Server (Extension Bridge) ----

let extensionClient: WebSocket | null = null;
const pendingRequests = new Map<
  string,
  { resolve: (result: string) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
>();

const wss = new WebSocketServer({ port: PORT, host: "127.0.0.1" });

wss.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    log(`ERROR: Port ${PORT} is already in use.`);
    log("Another MCP server or process is using this port.");
    log(`Try: --port ${PORT + 1}  (or kill the other process)`);
    process.exit(1);
  }
  log(`WebSocket server error: ${err.message}`);
  process.exit(1);
});

wss.on("listening", () => {
  log(`WebSocket bridge listening on ws://127.0.0.1:${PORT}`);
});

wss.on("connection", (ws, req) => {
  // Validate auth token from URL query
  const url = new URL(req.url ?? "", `http://127.0.0.1:${PORT}`);
  const token = url.searchParams.get("token");

  if (token !== AUTH_TOKEN) {
    log("Connection rejected: invalid auth token");
    audit("REJECTED: invalid auth token");
    ws.close(4001, "Invalid auth token");
    return;
  }

  // Only allow one extension client
  if (extensionClient) {
    log("Replacing existing extension connection");
    extensionClient.close();
  }

  extensionClient = ws;
  log("Extension connected (authenticated)");
  audit("CONNECTED: extension authenticated");

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === "RESULT" && msg.id) {
        const pending = pendingRequests.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          pendingRequests.delete(msg.id);
          pending.resolve(msg.result ?? "");
        }
      } else if (msg.type === "pong") {
        // Heartbeat response — ignore
      }
    } catch {
      // Ignore malformed messages
    }
  });

  ws.on("close", () => {
    if (extensionClient === ws) {
      extensionClient = null;
      log("Extension disconnected");
      audit("DISCONNECTED: extension");
    }
  });

  ws.on("error", () => {
    if (extensionClient === ws) {
      extensionClient = null;
    }
  });
});

// ---- Send Command to Extension ----

function sendCommand(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!extensionClient || extensionClient.readyState !== 1) {
      reject(new Error("Extension not connected. Open the DOMShell side panel and run: connect <token>"));
      return;
    }

    const id = randomBytes(8).toString("hex");
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error("Command timed out after 30 seconds"));
    }, 30000);

    pendingRequests.set(id, { resolve, reject, timer });

    extensionClient.send(
      JSON.stringify({
        type: "EXECUTE",
        id,
        command,
        allowedDomains: ALLOWED_DOMAINS.length > 0 ? ALLOWED_DOMAINS : undefined,
      })
    );
  });
}

async function executeWithSecurity(command: string): Promise<string> {
  // Check tier
  const check = isCommandAllowed(command);
  if (!check.allowed) {
    audit(`DENIED: ${command} — ${check.reason}`);
    return `Error: ${check.reason}`;
  }

  const tier = getCommandTier(command);

  // Confirm write actions
  if (tier === "write") {
    const approved = await confirmAction(command);
    if (!approved) {
      audit(`[WRITE] DENIED by user: ${command}`);
      return "Action denied by user.";
    }
  }

  // Execute
  const tag = tier === "write" ? "[WRITE] " : tier === "navigate" ? "[NAV] " : tier === "sensitive" ? "[SENSITIVE] " : "";
  audit(`${tag}EXECUTE: ${command}`);

  try {
    let result = await sendCommand(command);
    result = redactSensitiveOutput(command, result);
    const summary = result.length > 80 ? result.slice(0, 80) + "..." : result;
    audit(`${tag}RESULT: ${summary}`);
    return result;
  } catch (err: any) {
    audit(`${tag}ERROR: ${err.message}`);
    return `Error: ${err.message}`;
  }
}

// ---- MCP Server Factory ----
// Each MCP client session gets its own McpServer instance.
// All instances share the same WebSocket bridge to the Chrome extension.

const MCP_INSTRUCTIONS = `DOMShell gives you full browser control through a filesystem metaphor. The DOM's Accessibility Tree (AXTree) is mapped to directories (containers like navigation/, main/, form/) and files (interactive elements like submit_btn, search_input, login_link). The browser itself (windows, tabs) is also part of the hierarchy.

WHEN TO USE DOMSHELL (prefer over native browser tools):
- Navigating to websites: use domshell_navigate or domshell_open
- Listing/switching tabs: use domshell_tabs, then domshell_cd with "~/tabs/<id>"
- Reading page content: domshell_text for bulk text, domshell_cat for element metadata, domshell_tree for structure
- Finding elements: domshell_find (deep recursive) or domshell_grep (current directory)
- Getting URLs/hrefs: domshell_cat on a link shows its URL, or domshell_find with --meta --type link
- Interacting: domshell_click, domshell_focus, domshell_type

TYPICAL WORKFLOW:
1. Enter a tab: domshell_here (focused tab), domshell_cd with "%here%" (composable), or domshell_open (new tab)
2. Understand structure: domshell_tree (overview), domshell_ls (children)
3. Extract content: domshell_text (bulk text — much faster than multiple cat calls)
4. Find specific elements: domshell_find with pattern or --type (e.g. --type link, --type button)
5. Inspect element details: domshell_cat shows full metadata — AX role, DOM tag, href/src/id/class, text, outerHTML
6. Interact: domshell_click, domshell_focus + domshell_type

BROWSER HIERARCHY:
- "~" or "/" = browser root. "ls" shows windows/ and tabs/.
- "~/tabs/<id>" = enter a tab by ID. "~/tabs/<pattern>" = match by title/URL substring.
- "~/windows/<id>/" = browse a window's tabs.
- "%here%" = path variable that expands to the focused tab (via its window). Composable:
  - "cd %here%" = enter the active tab
  - "cd %here%/.." = go to the window containing the active tab
  - "cd %here%/main" = enter the active tab and navigate to main
- "cd .." from DOM root exits to browser level.

READING ELEMENT METADATA:
- domshell_cat shows full info for any element: AX role, DOM tag, href (for links), src (for images), id, class, text content (textContent), visible text (innerText — only rendered text, respects CSS visibility), and an outerHTML snippet.
- If a child element (like a span) doesn't have the property you need (like href), navigate up with "cd .." to the parent element (like the <a> tag) and cat that instead.
- domshell_ls with --meta option shows href/src/id inline for each element in the listing.
- domshell_ls with --text option shows visible text preview (innerText) per element. Combine with --meta: "ls --meta --text".
- domshell_find with --meta option shows href/src/id inline for each search result. Use "find --type link --meta" to get all URLs on a page.
- domshell_find with --text option shows visible text preview per result. Use "find --type link --meta --text" to get all URLs with their link text.

IMPORTANT TIPS:
- Element names are human-readable (e.g. "Sign_in_btn", "Search_input") not CSS selectors.
- Use domshell_text for reading article content — it's one call vs. dozens of cat calls.
- Use domshell_find --type link --meta to extract all URLs from a page.
- Directories (navigation/, main/) are containers you cd into. Files (submit_btn, logo_link) are leaf elements you cat or click.
- The AXTree auto-refreshes after clicks/navigation — no manual refresh needed.

EFFICIENT PATTERNS:
1. Scoped Extraction: open URL → cd main/article → find --type heading (locate section) → cd section → text (content) + find --type link --meta (links)
2. Table Reading: find --type table → text table_element (reads ALL rows at once). For structured data, read the whole table, don't read row-by-row.
3. Section Discovery: grep "section_name" (recursive: true) OR find "section_name". NOT ls --offset pagination (too many calls).
4. Link Extraction: cd into the container with links → find --type link --meta. Use --text with a pattern to filter by visible text: find --type link --text "keyword" --meta.
5. Form Interaction: find --type textbox → focus input → type "query" → click submit_button. If page doesn't navigate, use domshell_navigate as fallback.
6. Path Resolution: All commands accept relative paths — text main/article/paragraph, cat nav/logo_link, click form/submit_btn. Saves cd round-trips.
7. Sibling Navigation: find --type heading "section" → cd container → ls --after section_heading -n 5 --text (elements after a heading). Combines with --type: ls --after intro --type link --meta.

COMMAND CHAINING (grep is the linchpin):
grep discovers sections and elements by name, giving you paths for subsequent commands. Chain pattern: grep (locate) → cd (scope) → extract (read/find/text). Examples:
- Article extraction: grep "article" (recursive) → cd article/ → text (bulk content)
- Link harvesting: grep "references" (recursive) → cd references/ → find --type link --meta (all URLs)
- Table data: grep "table" (recursive) → extract_table table_1234 (structured output)
- Targeted content: grep "results" (recursive) → cd results/ → find --type heading → cd target_heading/ → text
- Content search: grep "keyword" (recursive, content: true) → finds elements whose VISIBLE TEXT contains keyword → cd to parent → text
- Sibling content: find heading → cd to its container → ls --after heading -n 1 --text (content right after the heading)
The key insight: grep output feeds cd, and cd scopes everything else. Never skip the grep step when you don't know where content lives.

COMPOSING COMMANDS (think like bash):
DOMShell works like a filesystem. Use the same mental model as searching files on disk:
- grep -r "pattern" → finds WHERE (like grep -r in bash)
- cd into the result → scopes your context (like cd in bash)
- text / cat / find → reads content (like cat, head, less in bash)
- ls --after/--before → filters siblings (like ls | grep in bash)
- find --type X --meta → targeted search (like find -name "*.ext" in bash)
- command | grep "pattern" → filter output lines (pipe operator, just like bash)
Real-world examples:
- "Find all PDFs linked on this page": find --type link --text "pdf" --meta
- "Read paragraph after intro": ls --after intro_heading -n 1 → text paragraph_name
- "Filter links to GitHub": find --type link --meta | grep "github"
- "What's in the sidebar?": text sidebar (or text main/sidebar with path resolution)

ANTI-PATTERNS (avoid these):
- Do NOT cd into an element just to read its text — use text element_name or text path/to/element instead (saves a cd + cd .. round trip)
- Do NOT use ls --offset pagination to search for a section — use find or grep with recursive: true
- Do NOT call text on individual rows/items — text the parent container instead (one call replaces N)
- Do NOT make multiple cat calls for content — use text for bulk content, find --meta for properties
- Do NOT cd into a leaf element (links, buttons) — use cat element_name or text element_name instead

Note: Use --no-confirm when starting the server to skip interactive confirmation prompts for write actions.`;

function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "domshell", version: "1.0.0" },
    { instructions: MCP_INSTRUCTIONS }
  );

  // -- Read tier tools (always available) --

  server.tool(
    "domshell_tabs",
    "List all open browser tabs with their IDs, titles, URLs, and window info. Use this to find the right tab before switching. Equivalent to 'ls ~/tabs/'.",
    {},
    async () => ({
      content: [{ type: "text", text: await executeWithSecurity("tabs") }],
    })
  );

  server.tool(
    "domshell_here",
    "Jump to the active tab in the last focused Chrome window. Use this to quickly enter whichever tab the user is currently looking at, without needing to know the tab ID.",
    {},
    async () => ({
      content: [{ type: "text", text: await executeWithSecurity("here") }],
    })
  );

  server.tool(
    "domshell_ls",
    "List children of the current directory. In the DOM tree: shows elements as files and directories. At the browser level (~): shows tabs/windows.\n\nFlags:\n  -l              Long format (more detail per element)\n  --meta          Show DOM properties (href, src, id) inline — great for extracting links\n  --text          Show visible text preview per element\n  -r              Recursive listing\n  -n N            Limit to N results\n  --offset N      Skip first N children (pagination)\n  --type ROLE     Filter by AX role (link, heading, button, etc.)\n  --count         Just count children\n  --textlen N     Max chars for text preview (default 80)\n  --after NAME    Show only children after the named element (sibling navigation)\n  --before NAME   Show only children before the named element (sibling navigation)\n\nSibling navigation: Use --after/--before to find content relative to a landmark. Example: ls --after See_also_heading -n 3 --text shows the 3 elements after a heading. Combines with --type: ls --after intro --type link --meta.\n\nPipe support: ls output can be piped into grep for filtering: ls --text | grep keyword.\n\nBest for: viewing immediate children of the current element.\nNOT recommended for: searching deep in the tree — use domshell_find or domshell_grep instead.",
    { options: z.string().optional().describe("Flags and options, e.g. '-l', '-n 10', '--type button', '--text', '--meta --text', '--after heading_name', or '~/tabs/' for tab listing") },
    async ({ options }) => ({
      content: [{ type: "text", text: await executeWithSecurity(`ls ${options ?? ""}`.trim()) }],
    })
  );

  server.tool(
    "domshell_cd",
    "Change directory — sets your scope for all subsequent commands (ls, find, grep, text all operate relative to current directory).\n\nPaths: 'main/form', '..', '~' (browser root), '~/tabs/<id>', '~/tabs/<pattern>', '%here%' (focused tab).\n\nWhen to cd:\n  - cd into a SECTION (article, main, sidebar) to scope find/grep/ls to that area\n  - cd into ~/tabs/<id> to switch between tabs\n  - cd .. to go up when done with a section\n\nWhen NOT to cd:\n  - To read a child's text: use 'domshell_text' with the name parameter instead (saves a cd + cd .. round trip)\n  - To inspect a child: use 'domshell_cat' with the name parameter instead\n  - To extract links: domshell_find --type link --meta works from the current directory",
    { path: z.string().describe("Path: DOM path, '~', '~/tabs/<id>', '~/windows/<id>', '%here%', '..', '/'") },
    async ({ path }) => ({
      content: [{ type: "text", text: await executeWithSecurity(`cd ${path}`) }],
    })
  );

  server.tool(
    "domshell_pwd",
    "Print the current working directory path in the DOM tree.",
    {},
    async () => ({
      content: [{ type: "text", text: await executeWithSecurity("pwd") }],
    })
  );

  server.tool(
    "domshell_cat",
    "Read detailed metadata about a DOM element: role, type, AX ID, DOM backend ID, value, child count, text content (textContent), visible text (innerText — only rendered text, respects CSS visibility), and outerHTML snippet.",
    { name: z.string().describe("Name or path of the element (e.g. 'link_name' or 'main/link_name')") },
    async ({ name }) => ({
      content: [{ type: "text", text: await executeWithSecurity(`cat ${name}`) }],
    })
  );

  server.tool(
    "domshell_find",
    "Deep recursive search from the CURRENT DIRECTORY downward. Scope matters: cd into a section first, then find, to get only that section's elements (fewer, more relevant results). Returns full paths to matching elements.\n\nKey flags:\n  --type ROLE   Filter by AX role (link, button, heading, textbox, table, list, etc.)\n  --meta        Include DOM properties (href, src, id) inline — essential for extracting URLs\n  --text        Show visible text preview per result\n\nCommon patterns:\n  find --type link --meta              All links with URLs under current directory\n  find --type heading                  All section headings (to locate 'See Also', 'References', etc.)\n  find --type table                    Find tables for data extraction\n  find 'paragraph'                     Find paragraph elements by name pattern\n\nEfficiency tip: cd into the container you care about FIRST, then find within it. This avoids sidebar/nav/footer noise in results. Use 'text element_name' on find results to read their content without cd'ing.\n\nWhen --text is used with a search pattern, elements are also matched against their visible text content (not just name/role). Example: find --type link --text 'login' --meta finds links whose displayed text contains 'login' and shows their hrefs — even when the text is in nested spans.\n\nPipe support: find output can be piped into grep for filtering: find --type link --meta | grep 'github'. Think like bash: find is your 'find + grep' combined.",
    {
      pattern: z.string().optional().describe("Search pattern (matches name, role, value)"),
      type: z.string().optional().describe("Filter by AX role (e.g. 'button', 'link', 'textbox', 'combobox')"),
      limit: z.number().optional().describe("Maximum number of results"),
      meta: z.boolean().optional().describe("Include DOM properties (href, src, id, tag) per result"),
      text: z.boolean().optional().describe("Show visible text preview per result (uses innerText, respects CSS visibility)"),
      textlen: z.number().optional().describe("Maximum characters for text preview (default: 80)"),
      content: z.boolean().optional().describe("Also match against visible text content of elements (slower but finds elements by their displayed text, e.g. find a heading whose text says 'See also')"),
    },
    async ({ pattern, type, limit, meta, text, textlen, content }) => {
      let cmd = "find";
      if (pattern) cmd += ` ${pattern}`;
      if (type) cmd += ` --type ${type}`;
      if (limit) cmd += ` -n ${limit}`;
      if (meta) cmd += ` --meta`;
      if (text) cmd += ` --text`;
      if (textlen) cmd += ` --textlen ${textlen}`;
      if (content) cmd += ` --content`;
      return { content: [{ type: "text", text: await executeWithSecurity(cmd) }] };
    }
  );

  server.tool(
    "domshell_grep",
    "Search for elements matching a pattern. Matches against name, role, and value. Case-insensitive.\n\nBy default, searches only IMMEDIATE children. Use recursive: true to search all descendants — this is almost always what you want for finding sections or elements by name.\n\ngrep is the primary section-discovery tool. Its output gives you element names and paths that you then use with cd, text, find, and other commands. This is how you chain commands together efficiently.\n\nCommon patterns:\n  grep 'see_also' (recursive: true)      Find a section by name anywhere below\n  grep 'heading' (recursive: true)        Find all headings in the subtree\n  grep 'button'                           Find buttons among immediate children\n\nWorkflow chains (grep → cd → extract):\n  1. Find + Read: grep 'references' (recursive: true) → cd references/ → text\n  2. Find + Links: grep 'sidebar' (recursive: true) → cd sidebar/ → find --type link --meta\n  3. Find + Table: grep 'table' (recursive: true) → extract_table table_1234\n  4. Scoped Search: grep 'article' (recursive: true) → cd article/ → find --type heading → cd into target section → text\n  5. Content Discovery: grep 'results' (recursive: true, content: true) → cd search_results/ → read --text\n\ngrep tells you WHERE things are; cd + text/find/extract_links/extract_table gets the content. Always grep first to scope your work, then extract within that scope.\n\nThink like bash: grep output gives you paths. Use those paths with cd, text, cat — just as you'd use grep to find a file, then cat to read it.",
    {
      pattern: z.string().describe("Search pattern"),
      recursive: z.boolean().optional().describe("Search all descendants recursively"),
      limit: z.number().optional().describe("Maximum number of results"),
      content: z.boolean().optional().describe("Also match against visible text content of elements (slower but finds elements by their displayed text)"),
    },
    async ({ pattern, recursive, limit, content }) => {
      let cmd = "grep";
      if (recursive) cmd += " -r";
      if (limit) cmd += ` -n ${limit}`;
      if (content) cmd += ` --content`;
      cmd += ` ${pattern}`;
      return { content: [{ type: "text", text: await executeWithSecurity(cmd) }] };
    }
  );

  server.tool(
    "domshell_tree",
    "Show a tree view of the current directory in the DOM, displaying the hierarchy of elements with type prefixes [d]=directory, [x]=interactive, [-]=static.",
    { depth: z.number().optional().describe("Maximum depth to display (default: 2)") },
    async ({ depth }) => ({
      content: [{ type: "text", text: await executeWithSecurity(`tree ${depth ?? 2}`) }],
    })
  );

  server.tool(
    "domshell_text",
    "Extract ALL text content from the current directory or a named child, including every descendant. Returns full textContent in a single call.\n\nThe name parameter lets you read any child without cd'ing into it first:\n  text paragraph_2994      Read a paragraph's text without cd'ing into it\n  text table_1234          Read an ENTIRE table (all rows, all cells) in one call\n  text list_5678           Read all list items at once\n  text                     Read everything under current directory\n\nEfficiency tip: call text on the HIGHEST container that has the content you need.\n  - Need a table? text on the table element, not individual rows.\n  - Need a section? text on the section container, not each paragraph.\n  - Need article body? cd into article/main, then text with no args.\n\nOne text call on a parent replaces N calls on its children.",
    {
      name: z.string().optional().describe("Name or path of element to extract text from (e.g. 'paragraph' or 'article/paragraph'). Default: current directory"),
      limit: z.number().optional().describe("Maximum characters to return"),
    },
    async ({ name, limit }) => {
      let cmd = "text";
      if (name) cmd += ` ${name}`;
      if (limit) cmd += ` -n ${limit}`;
      return { content: [{ type: "text", text: await executeWithSecurity(cmd) }] };
    }
  );

  server.tool(
    "domshell_read",
    "Structured subtree extraction — returns the hierarchy of elements under the current directory or a named child, with roles, names, and values in one call. Think of it as 'tree' + 'cat' combined: you get the structure AND the content.\n\nExcellent for tables, lists, and nested sections. A single read on a table returns all rows and cells with their roles and values, replacing N separate text calls.\n\nFlags:\n  --meta     Include DOM properties (href, src, id) per element\n  --text     Include visible text preview per element\n  -d N       Max depth to traverse (default 5)\n  -n N       Max total elements to return\n\nExamples:\n  read table_1234          Get full table structure with values\n  read list_5678 --meta    Get list with href/src/id properties\n  read -d 3                Current directory, 3 levels deep",
    {
      name: z.string().optional().describe("Name or path of element to read (e.g. 'table_1' or 'main/table_1'). Default: current directory"),
      depth: z.number().optional().describe("Maximum depth to traverse (default: 5)"),
      limit: z.number().optional().describe("Maximum total elements to return"),
      meta: z.boolean().optional().describe("Include DOM properties (href, src, id) per element"),
      text: z.boolean().optional().describe("Include visible text preview per element"),
      textlen: z.number().optional().describe("Max chars for text preview (default: 120)"),
    },
    async ({ name, depth, limit, meta, text, textlen }) => {
      let cmd = "read";
      if (name) cmd += ` ${name}`;
      if (depth) cmd += ` -d ${depth}`;
      if (limit) cmd += ` -n ${limit}`;
      if (meta) cmd += ` --meta`;
      if (text) cmd += ` --text`;
      if (textlen) cmd += ` --textlen ${textlen}`;
      return { content: [{ type: "text", text: await executeWithSecurity(cmd) }] };
    }
  );

  server.tool(
    "domshell_refresh",
    "Force re-fetch the Accessibility Tree. Use after page navigation or significant DOM changes. Note: the tree also auto-refreshes when changes are detected.",
    {},
    async () => ({
      content: [{ type: "text", text: await executeWithSecurity("refresh") }],
    })
  );

  server.tool(
    "domshell_extract_links",
    "Extract all links under the current directory or a named child as a clean numbered list in [text](url) format. Purpose-built for link extraction — returns display text and URLs in one call.\n\nExamples:\n  extract_links              All links under current directory\n  extract_links main -n 20   First 20 links in 'main' section",
    {
      name: z.string().optional().describe("Name or path of element to extract links from (e.g. 'nav' or 'main/nav'). Default: current directory"),
      limit: z.number().optional().describe("Maximum number of links to return"),
    },
    async ({ name, limit }) => {
      let cmd = "extract_links";
      if (name) cmd += ` ${name}`;
      if (limit) cmd += ` -n ${limit}`;
      return { content: [{ type: "text", text: await executeWithSecurity(cmd) }] };
    }
  );

  server.tool(
    "domshell_extract_table",
    "Extract a table element as structured markdown or CSV. Reads all rows and cells, returns formatted output. First row is treated as the header.\n\nExamples:\n  extract_table table_1234              Markdown table\n  extract_table table_1234 --format csv CSV format\n  extract_table table_1234 -n 10        First 10 rows only",
    {
      name: z.string().describe("Name or path of the table element (e.g. 'table_1' or 'article/table_1')"),
      format: z.enum(["markdown", "csv"]).optional().describe("Output format (default: markdown)"),
      limit: z.number().optional().describe("Maximum number of rows to return"),
    },
    async ({ name, format, limit }) => {
      let cmd = `extract_table ${name}`;
      if (format) cmd += ` --format ${format}`;
      if (limit) cmd += ` -n ${limit}`;
      return { content: [{ type: "text", text: await executeWithSecurity(cmd) }] };
    }
  );

  // -- Write tier tools (require --allow-write) --

  if (ALLOW_WRITE) {
    server.tool(
      "domshell_click",
      "Click a DOM element. May trigger navigation, form submission, or page changes. The DOM tree auto-refreshes on the next command.\n\nAfter clicking: use domshell_ls or domshell_pwd to verify the page actually changed. Some clicks (like search buttons) may need a domshell_refresh to see updated content. If clicking a search/submit button doesn't navigate, try using domshell_navigate as a fallback.",
      { name: z.string().describe("Name or path of the element to click (e.g. 'submit_btn' or 'form/submit_btn')") },
      async ({ name }) => ({
        content: [{ type: "text", text: await executeWithSecurity(`click ${name}`) }],
      })
    );

    server.tool(
      "domshell_focus",
      "Focus an input element. Use before 'domshell_type' to direct keyboard input to the right field.",
      { name: z.string().describe("Name or path of the input to focus (e.g. 'search_input' or 'form/search_input')") },
      async ({ name }) => ({
        content: [{ type: "text", text: await executeWithSecurity(`focus ${name}`) }],
      })
    );

    server.tool(
      "domshell_type",
      "Type text into the currently focused element. Use domshell_focus first to target an input field.\n\nFor search forms: after typing, you may need to either:\n  1. click the submit/search button, OR\n  2. type '\\n' to simulate pressing Enter\n\nIf the page doesn't navigate after form submission, use domshell_navigate as a fallback to go to the expected URL directly.",
      { text: z.string().describe("Text to type into the focused element") },
      async ({ text }) => ({
        content: [{ type: "text", text: await executeWithSecurity(`type ${text}`) }],
      })
    );

    server.tool(
      "domshell_navigate",
      "Navigate the current tab to a URL. Automatically rebuilds the accessibility tree after navigation completes. Requires a tab context (cd into a tab first). Use this to go to a specific website without opening a new tab.",
      { url: z.string().describe("URL to navigate to (e.g. 'https://example.com' or 'example.com')") },
      async ({ url }) => ({
        content: [{ type: "text", text: await executeWithSecurity(`navigate ${url}`) }],
      })
    );

    server.tool(
      "domshell_open",
      "Open a URL in a new tab and enter it (path becomes ~/tabs/<id>). Automatically builds the accessibility tree after page loads. Works from any location.\n\nAfter opening a page, a typical extraction workflow is:\n  1. open URL\n  2. find the section you need (find --type heading, or grep section_name with recursive: true)\n  3. cd into the container\n  4. text (for content) or find --type link --meta (for links)",
      { url: z.string().describe("URL to open in a new tab (e.g. 'https://example.com' or 'example.com')") },
      async ({ url }) => ({
        content: [{ type: "text", text: await executeWithSecurity(`open ${url}`) }],
      })
    );

    server.tool(
      "domshell_submit",
      "Atomic form submission — focuses input, clears existing value, types new value, then submits (clicks button or presses Enter). Replaces the 3-step focus → type → click pattern in one reliable call.\n\nExamples:\n  submit search_input 'machine learning'                   Type and press Enter\n  submit search_input 'machine learning' --submit search_btn  Type and click button",
      {
        input: z.string().describe("Name or path of the input element (e.g. 'search_input' or 'form/search_input')"),
        value: z.string().describe("Text value to type into the input"),
        submit_button: z.string().optional().describe("Name or path of submit button to click (default: press Enter)"),
      },
      async ({ input, value, submit_button }) => {
        let cmd = `submit ${input} ${value}`;
        if (submit_button) cmd += ` --submit ${submit_button}`;
        return { content: [{ type: "text", text: await executeWithSecurity(cmd) }] };
      }
    );
  }

  // -- Sensitive tier tools (require --allow-sensitive) --

  if (ALLOW_SENSITIVE) {
    server.tool(
      "domshell_whoami",
      "Check authentication status by examining cookies for the current page. Shows session cookies and expiry.",
      {},
      async () => ({
        content: [{ type: "text", text: await executeWithSecurity("whoami") }],
      })
    );
  }

  // -- Fallback execute tool --

  server.tool(
    "domshell_execute",
    "Execute any DOMShell command. Use this for commands not covered by specific tools (e.g. 'env', 'export', 'debug stats'). Supports pipe operator: 'find --type link --meta | grep github'. Write and sensitive commands are subject to the same security restrictions.",
    { command: z.string().describe("The full command to execute (e.g. 'ls -l', 'debug stats', 'find --type link | grep login')") },
    async ({ command }) => ({
      content: [{ type: "text", text: await executeWithSecurity(command) }],
    })
  );

  return server;
}

// ---- MCP Session Management ----

const transports: Record<string, StreamableHTTPServerTransport> = {};

// ---- MCP Auth Middleware ----

function mcpAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Check Authorization header: "Bearer <token>"
  const authHeader = req.headers["authorization"];
  if (authHeader) {
    const [scheme, token] = authHeader.split(" ");
    if (scheme?.toLowerCase() === "bearer" && token === AUTH_TOKEN) {
      next();
      return;
    }
  }
  // Fallback: check query param ?token=<token>
  if (req.query["token"] === AUTH_TOKEN) {
    next();
    return;
  }
  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Unauthorized: invalid or missing auth token" },
    id: null,
  });
}

// ---- Start ----

async function main() {
  log("Starting DOMShell MCP server...");

  // ---- HTTP transport (standalone, multi-client) ----
  const app = express();
  app.use(express.json());

  // Auth on all /mcp routes
  app.use("/mcp", mcpAuthMiddleware);

  // POST /mcp — handle MCP requests (initialize, tool calls, etc.)
  app.post("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    try {
      // Existing session — route to its transport
      if (sessionId && transports[sessionId]) {
        await transports[sessionId].handleRequest(req, res, req.body);
        return;
      }

      // New session — must be an initialize request
      if (!sessionId && isInitializeRequest(req.body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            log(`MCP session initialized: ${sid}`);
            transports[sid] = transport;
          },
        });

        transport.onclose = () => {
          const sid = Object.entries(transports).find(([, t]) => t === transport)?.[0];
          if (sid) {
            log(`MCP session closed: ${sid}`);
            delete transports[sid];
          }
        };

        const server = createMcpServer();
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      // Bad request — no session and not initialize
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: no valid session. Send an initialize request first." },
        id: null,
      });
    } catch (error: any) {
      log(`MCP request error: ${error.message}`);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // GET /mcp — SSE stream for server-to-client messages
  app.get("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid or missing session ID" },
        id: null,
      });
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  // DELETE /mcp — session termination
  app.delete("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid or missing session ID" },
        id: null,
      });
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  // Start HTTP server
  const httpServer = app.listen(MCP_PORT, "127.0.0.1", () => {
    log("");
    log(`MCP HTTP endpoint: http://127.0.0.1:${MCP_PORT}/mcp`);
    log(`WebSocket bridge:  ws://127.0.0.1:${PORT}`);
    log(`Auth token: ${AUTH_TOKEN}`);
    log("");
    log("In the DOMShell terminal, run:");
    log(`  connect ${AUTH_TOKEN}`);
    log("");
    log(`Security: write=${ALLOW_WRITE ? "ON" : "OFF"}, sensitive=${ALLOW_SENSITIVE ? "ON" : "OFF"}, confirm=${!NO_CONFIRM ? "ON" : "OFF"}`);
    if (ALLOWED_DOMAINS.length > 0) {
      log(`Domains: ${ALLOWED_DOMAINS.join(", ")}`);
    } else {
      log("Domains: all (no restriction)");
    }
    log(`Audit log: ${LOG_FILE}`);
    log("");
    log("Configure MCP clients with:");
    log(`  { "url": "http://localhost:${MCP_PORT}/mcp?token=${AUTH_TOKEN}" }`);
  });

  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log(`ERROR: MCP port ${MCP_PORT} is already in use.`);
      log(`Try: --mcp-port ${MCP_PORT + 1}  (or kill the other process)`);
      process.exit(1);
    }
    log(`HTTP server error: ${err.message}`);
    process.exit(1);
  });

  // Graceful shutdown
  process.on("SIGINT", async () => {
    log("Shutting down...");
    for (const sid in transports) {
      try {
        await transports[sid].close();
      } catch {}
      delete transports[sid];
    }
    wss.close();
    httpServer.close();
    process.exit(0);
  });
}

main().catch((err) => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
