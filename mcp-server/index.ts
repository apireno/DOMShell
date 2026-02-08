import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { randomBytes } from "node:crypto";
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

// ---- WebSocket Server ----

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
  log(`WebSocket server listening on ws://127.0.0.1:${PORT}`);
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

// ---- MCP Server ----

const server = new McpServer(
  {
    name: "domshell",
    version: "1.0.0",
  },
  {
    instructions: `DOMShell gives you full browser control through a filesystem metaphor. The DOM's Accessibility Tree (AXTree) is mapped to directories (containers like navigation/, main/, form/) and files (interactive elements like submit_btn, search_input, login_link). The browser itself (windows, tabs) is also part of the hierarchy.

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
- domshell_cat shows full info for any element: AX role, DOM tag, href (for links), src (for images), id, class, text content, and an outerHTML snippet.
- If a child element (like a span) doesn't have the property you need (like href), navigate up with "cd .." to the parent element (like the <a> tag) and cat that instead.
- domshell_ls with --meta option shows href/src/id inline for each element in the listing.
- domshell_find with --meta option shows href/src/id inline for each search result. Use "find --type link --meta" to get all URLs on a page.

IMPORTANT TIPS:
- Element names are human-readable (e.g. "Sign_in_btn", "Search_input") not CSS selectors.
- Use domshell_text for reading article content — it's one call vs. dozens of cat calls.
- Use domshell_find --type link --meta to extract all URLs from a page.
- Directories (navigation/, main/) are containers you cd into. Files (submit_btn, logo_link) are leaf elements you cat or click.
- The AXTree auto-refreshes after clicks/navigation — no manual refresh needed.

Note: When running under Claude Desktop, use --no-confirm to avoid /dev/tty prompts for click/type actions.`,
  }
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
  "List children of the current directory. In the DOM tree: shows elements as files and directories. At the browser level (~): shows tabs/windows. Supports flags: -l (long format), --meta (show DOM properties like href/src/id inline), -r (recursive), -n N (limit), --offset N, --type ROLE, --count.",
  { options: z.string().optional().describe("Flags and options, e.g. '-l', '-n 10', '--type button', or '~/tabs/' for tab listing") },
  async ({ options }) => ({
    content: [{ type: "text", text: await executeWithSecurity(`ls ${options ?? ""}`.trim()) }],
  })
);

server.tool(
  "domshell_cd",
  "Change directory. '~' and '/' go to browser root. '%here%' expands to the focused tab via its window path — use 'cd %here%' to enter the active tab, 'cd %here%/..' for its window, 'cd %here%/main' to enter and navigate. DOM paths: 'main/form', '..'. Browser paths: '~/tabs/<id>' (switch by ID), '~/tabs/<pattern>' (switch by title/URL match), '~/windows/<id>' (window's tabs).",
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
  "Read detailed metadata about a DOM element: role, type, AX ID, DOM backend ID, value, child count, and text content.",
  { name: z.string().describe("Name of the element to inspect") },
  async ({ name }) => ({
    content: [{ type: "text", text: await executeWithSecurity(`cat ${name}`) }],
  })
);

server.tool(
  "domshell_find",
  "Deep recursive search across the entire DOM tree from the current directory. Returns full paths to matching elements. Use --type to filter by role, --meta to include DOM properties (href, src, id) inline. Example: find --type link --meta to get all URLs on a page.",
  {
    pattern: z.string().optional().describe("Search pattern (matches name, role, value)"),
    type: z.string().optional().describe("Filter by AX role (e.g. 'button', 'link', 'textbox', 'combobox')"),
    limit: z.number().optional().describe("Maximum number of results"),
    meta: z.boolean().optional().describe("Include DOM properties (href, src, id, tag) per result"),
  },
  async ({ pattern, type, limit, meta }) => {
    let cmd = "find";
    if (pattern) cmd += ` ${pattern}`;
    if (type) cmd += ` --type ${type}`;
    if (limit) cmd += ` -n ${limit}`;
    if (meta) cmd += ` --meta`;
    return { content: [{ type: "text", text: await executeWithSecurity(cmd) }] };
  }
);

server.tool(
  "domshell_grep",
  "Search children of the current directory for elements matching a pattern. Matches against name, role, and value. Case-insensitive.",
  {
    pattern: z.string().describe("Search pattern"),
    recursive: z.boolean().optional().describe("Search all descendants recursively"),
    limit: z.number().optional().describe("Maximum number of results"),
  },
  async ({ pattern, recursive, limit }) => {
    let cmd = "grep";
    if (recursive) cmd += " -r";
    if (limit) cmd += ` -n ${limit}`;
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
  "Extract all text content from the current directory or a named child, including all descendants. Returns the full textContent in a single call — much more efficient than multiple domshell_cat calls for reading articles or page content.",
  {
    name: z.string().optional().describe("Name of a child element to extract text from (default: current directory)"),
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
  "domshell_refresh",
  "Force re-fetch the Accessibility Tree. Use after page navigation or significant DOM changes. Note: the tree also auto-refreshes when changes are detected.",
  {},
  async () => ({
    content: [{ type: "text", text: await executeWithSecurity("refresh") }],
  })
);

// -- Write tier tools (require --allow-write) --

if (ALLOW_WRITE) {
  server.tool(
    "domshell_click",
    "Click a DOM element. This may trigger navigation, form submission, or other page changes. The DOM tree will auto-refresh on the next command.",
    { name: z.string().describe("Name of the element to click") },
    async ({ name }) => ({
      content: [{ type: "text", text: await executeWithSecurity(`click ${name}`) }],
    })
  );

  server.tool(
    "domshell_focus",
    "Focus an input element. Use before 'domshell_type' to direct keyboard input to the right field.",
    { name: z.string().describe("Name of the input element to focus") },
    async ({ name }) => ({
      content: [{ type: "text", text: await executeWithSecurity(`focus ${name}`) }],
    })
  );

  server.tool(
    "domshell_type",
    "Type text into the currently focused element. Use domshell_focus first to target an input field.",
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
    "Open a URL in a new browser tab and enter it (path becomes ~/tabs/<id>). Automatically builds the accessibility tree after the page loads. Works from any location. Use this when you want to open a new tab rather than navigating the current one.",
    { url: z.string().describe("URL to open in a new tab (e.g. 'https://example.com' or 'example.com')") },
    async ({ url }) => ({
      content: [{ type: "text", text: await executeWithSecurity(`open ${url}`) }],
    })
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
  "Execute any DOMShell command. Use this for commands not covered by specific tools (e.g. 'env', 'export', 'debug stats'). Write and sensitive commands are subject to the same security restrictions.",
  { command: z.string().describe("The full command to execute (e.g. 'ls -l', 'debug stats')") },
  async ({ command }) => ({
    content: [{ type: "text", text: await executeWithSecurity(command) }],
  })
);

// ---- Start ----

async function main() {
  log("Starting DOMShell MCP server...");
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
