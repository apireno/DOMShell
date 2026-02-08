import { CDPClient } from "./cdp_client.ts";
import {
  buildNodeMap,
  findChildByName,
  findRootNode,
  generateNodeName,
  getChildVFSNodes,
} from "./vfs_mapper.ts";
import type { AXNode, ShellState, VFSNode } from "../shared/types.ts";
import { INTERACTIVE_ROLES } from "../shared/types.ts";

// ---- State ----

const cdp = new CDPClient();

const state: ShellState = {
  path: [],                // Start at browser root (~)
  axNodeIds: [],           // No DOM context yet
  activeTabId: null,       // No tab attached yet
  env: {
    SHELL: "/bin/agentshell",
    TERM: "xterm-256color",
    PS1: "agent@shell:$PWD$ ",
  },
};

let nodeMap: Map<string, AXNode> = new Map();
let treeStale = false;

// ---- Path Helpers ----

/** Extract tab ID from unified path, or null if not inside a tab. */
function getTabIdFromPath(path: string[]): number | null {
  // ["tabs", "<id>", ...] → id at index 1
  if (path[0] === "tabs" && path.length >= 2) {
    const n = parseInt(path[1], 10);
    return isNaN(n) ? null : n;
  }
  // ["windows", "<winId>", "<tabId>", ...] → id at index 2
  if (path[0] === "windows" && path.length >= 3) {
    const n = parseInt(path[2], 10);
    return isNaN(n) ? null : n;
  }
  return null;
}

/** Index in path where DOM segments start (after the tab entry segment). */
function getDomStartIndex(path: string[]): number {
  if (path[0] === "tabs" && path.length >= 2) return 2;
  if (path[0] === "windows" && path.length >= 3) return 3;
  return -1;
}

/** Are we currently inside a tab's DOM? */
function isInsideTab(): boolean {
  return getTabIdFromPath(state.path) !== null;
}

/** Guard: throws if not inside a tab. Replaces old ensureAttached(). */
function ensureInsideTab(): void {
  if (!isInsideTab()) {
    throw new Error("This command requires a tab context. Use 'cd tabs/<id>' to enter a tab, or 'open <url>' to open one.");
  }
  if (!state.activeTabId || nodeMap.size === 0) {
    throw new Error("Tab context lost. Navigate to a tab with 'cd tabs/<id>'.");
  }
}

/** Get the current AX node ID (last in axNodeIds). */
function getCurrentNodeId(): string {
  if (state.axNodeIds.length === 0) throw new Error("No DOM context. Navigate into a tab first.");
  return state.axNodeIds[state.axNodeIds.length - 1];
}

/** Get DOM segment names from current path (everything after tab entry). */
function getDomSegments(): string[] {
  const start = getDomStartIndex(state.path);
  if (start < 0) return [];
  return state.path.slice(start);
}

/** Internal: attach CDP to a tab and build its AX tree. */
async function cdpSwitchToTab(tabId: number): Promise<{ tab: chrome.tabs.Tab; nodeCount: number; iframeCount: number }> {
  if (state.activeTabId === tabId && nodeMap.size > 0) {
    // Already attached — just return info
    const tab = await chrome.tabs.get(tabId);
    let iframeCount = 0;
    for (const node of nodeMap.values()) {
      const r = node.role?.value ?? "";
      if (r === "Iframe" || r === "IframePresentational") iframeCount++;
    }
    return { tab, nodeCount: nodeMap.size, iframeCount };
  }

  // Attach (CDPClient auto-detaches the previous tab)
  await cdp.attach(tabId);
  state.activeTabId = tabId;

  const axNodes = await cdp.getAllFrameAXTrees();
  nodeMap = buildNodeMap(axNodes);

  const root = findRootNode(nodeMap);
  state.axNodeIds = root ? [root.nodeId] : [];

  const tab = await chrome.tabs.get(tabId);
  let iframeCount = 0;
  for (const node of nodeMap.values()) {
    const r = node.role?.value ?? "";
    if (r === "Iframe" || r === "IframePresentational") iframeCount++;
  }
  return { tab, nodeCount: nodeMap.size, iframeCount };
}

/** Resolve a tab target (numeric ID or substring match) to a chrome.tabs.Tab. */
async function resolveTabTarget(target: string): Promise<chrome.tabs.Tab> {
  // Numeric = exact tab ID
  if (/^\d+$/.test(target)) {
    const tabId = parseInt(target, 10);
    try {
      return await chrome.tabs.get(tabId);
    } catch {
      throw new Error(`Tab ${tabId} not found. Use 'tabs' to list all tabs.`);
    }
  }

  // Substring match on title/URL
  const pattern = target.toLowerCase();
  const allWindows = await chrome.windows.getAll({ populate: true });
  for (const win of allWindows) {
    for (const t of win.tabs ?? []) {
      if (
        t.title?.toLowerCase().includes(pattern) ||
        t.url?.toLowerCase().includes(pattern)
      ) {
        return t;
      }
    }
  }
  throw new Error(`No tab matching '${target}'. Use 'tabs' to list all tabs.`);
}

// ---- WebSocket Bridge (for MCP server) ----
// Default OFF — user must explicitly run `connect <token>` to enable

let ws: WebSocket | null = null;
let wsToken: string | null = null;
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wsHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
let wsPort = 9876;
let wsEnabled = false;
let wsConnected = false;
let wsAllowedDomains: string[] = [];

function setWsStatus(status: "disabled" | "connecting" | "connected" | "disconnected"): void {
  chrome.storage.local.set({ ws_status: status });
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function wsConnect(): void {
  if (!wsToken || !wsEnabled) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  setWsStatus("connecting");

  try {
    ws = new WebSocket(`ws://127.0.0.1:${wsPort}?token=${wsToken}`);

    ws.onopen = () => {
      wsConnected = true;
      setWsStatus("connected");
      startKeepaliveAlarm();
      console.log("[AgentShell] WebSocket connected to MCP server");

      // Start heartbeat to keep MV3 service worker alive
      if (wsHeartbeatTimer) clearInterval(wsHeartbeatTimer);
      wsHeartbeatTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "pong" }));
        }
      }, 20000);
    };

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(typeof event.data === "string" ? event.data : "");

        if (msg.type === "EXECUTE" && msg.command) {
          // Domain allowlist check
          if (msg.allowedDomains && msg.allowedDomains.length > 0 && state.activeTabId) {
            try {
              const url = await cdp.getPageUrl();
              const hostname = new URL(url).hostname.toLowerCase();
              const allowed = msg.allowedDomains.some((d: string) =>
                hostname === d || hostname.endsWith("." + d)
              );
              if (!allowed) {
                ws?.send(JSON.stringify({
                  type: "RESULT",
                  id: msg.id,
                  result: `Error: Domain '${hostname}' is not in the allowed list: ${msg.allowedDomains.join(", ")}`,
                }));
                return;
              }
            } catch {
              // If we can't check the domain, proceed anyway
            }
          }

          // Execute the command and send the result back
          const output = await executeCommand(msg.command);
          const cleanOutput = stripAnsi(output);

          ws?.send(JSON.stringify({
            type: "RESULT",
            id: msg.id,
            result: cleanOutput,
          }));
        }
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      wsConnected = false;
      if (wsHeartbeatTimer) {
        clearInterval(wsHeartbeatTimer);
        wsHeartbeatTimer = null;
      }

      // Auto-reconnect after 5s if still enabled with token
      if (wsEnabled && wsToken && !wsReconnectTimer) {
        setWsStatus("disconnected");
        wsReconnectTimer = setTimeout(() => {
          wsReconnectTimer = null;
          wsConnect();
        }, 5000);
      } else if (!wsEnabled) {
        stopKeepaliveAlarm();
        setWsStatus("disabled");
      }
    };

    ws.onerror = () => {
      // onclose will fire after onerror
    };
  } catch {
    // WebSocket constructor failed — retry later
    if (wsToken && !wsReconnectTimer) {
      wsReconnectTimer = setTimeout(() => {
        wsReconnectTimer = null;
        wsConnect();
      }, 5000);
    }
  }
}

function wsDisconnect(): void {
  wsEnabled = false;
  wsConnected = false;

  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  if (wsHeartbeatTimer) {
    clearInterval(wsHeartbeatTimer);
    wsHeartbeatTimer = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }

  stopKeepaliveAlarm();
  setWsStatus("disabled");
}

// ---- Alarm-based keepalive for MV3 service worker ----
// chrome.alarms survive worker suspension and wake the worker when they fire.

const KEEPALIVE_ALARM = "agentshell-keepalive";

function startKeepaliveAlarm(): void {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
}

function stopKeepaliveAlarm(): void {
  chrome.alarms.clear(KEEPALIVE_ALARM);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;

  // The mere act of this listener firing wakes the service worker.
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "pong" }));
  }

  // If we should be connected but aren't, trigger reconnect
  if (wsEnabled && wsToken && (!ws || ws.readyState !== WebSocket.OPEN) && !wsReconnectTimer) {
    wsConnect();
  }
});

// Restore WebSocket connection on service worker restart
chrome.storage.local.get(["ws_enabled", "ws_token", "ws_port"], (result) => {
  wsEnabled = result.ws_enabled === true;
  wsToken = (result.ws_token as string) || null;
  wsPort = (result.ws_port as number) || 9876;

  if (wsEnabled && wsToken) {
    startKeepaliveAlarm(); // Keep worker alive during reconnect attempt
    wsConnect();
  } else {
    stopKeepaliveAlarm();
    setWsStatus(wsEnabled ? "disconnected" : "disabled");
  }
});

// React to settings changes from the options page
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;

  const enabledChanged = "ws_enabled" in changes;
  const tokenChanged = "ws_token" in changes;
  const portChanged = "ws_port" in changes;

  if (!enabledChanged && !tokenChanged && !portChanged) return;

  if (enabledChanged) wsEnabled = changes.ws_enabled.newValue === true;
  if (tokenChanged) wsToken = (changes.ws_token.newValue as string) || null;
  if (portChanged) wsPort = (changes.ws_port.newValue as number) || 9876;

  if (!wsEnabled) {
    // Disable: close connection but keep token/port in memory
    wsConnected = false;
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    if (wsHeartbeatTimer) { clearInterval(wsHeartbeatTimer); wsHeartbeatTimer = null; }
    if (ws) { ws.close(); ws = null; }
    setWsStatus("disabled");
    return;
  }

  // Enabled (or token/port changed while enabled): reconnect
  if (wsToken) {
    if (ws) { ws.close(); ws = null; }
    wsConnected = false;
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    wsConnect();
  }
});

// ---- CDP Event Listener for DOM / Navigation Changes ----

chrome.debugger.onEvent.addListener((source, method) => {
  if (source.tabId !== state.activeTabId) return;

  if (
    method === "Page.frameNavigated" ||
    method === "Page.loadEventFired" ||
    method === "DOM.documentUpdated"
  ) {
    treeStale = true;
  }
});

// ---- Open Side Panel on Action Click ----

chrome.sidePanel
  ?.setPanelBehavior?.({ openPanelOnActionClick: true })
  ?.catch(() => {});

// ---- Message Router ----

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "agentshell") return;

  port.onMessage.addListener(async (msg) => {
    if (msg.type === "STDIN") {
      const output = await executeCommand(msg.input);
      port.postMessage({ type: "STDOUT", output });
    } else if (msg.type === "COMPLETE") {
      const matches = getCompletions(msg.partial, msg.command);
      port.postMessage({ type: "COMPLETE_RESPONSE", matches, partial: msg.partial });
    } else if (msg.type === "READY") {
      port.postMessage({
        type: "STDOUT",
        output: formatWelcome(),
      });
    }
  });
});

// ---- Welcome Banner ----

function formatWelcome(): string {
  return [
    "\x1b[36m\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557\x1b[0m",
    "\x1b[36m\u2551\x1b[0m   \x1b[1;33mAgentShell v1.0.0\x1b[0m                                 \x1b[36m\u2551\x1b[0m",
    "\x1b[36m\u2551\x1b[0m   \x1b[37mThe browser is your filesystem.\x1b[0m                    \x1b[36m\u2551\x1b[0m",
    "\x1b[36m\u2551\x1b[0m   \x1b[90mhttps://github.com/apireno/AgenticShell\x1b[0m            \x1b[36m\u2551\x1b[0m",
    "\x1b[36m\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d\x1b[0m",
    "",
    "\x1b[90mType 'help' to see available commands.\x1b[0m",
    "\x1b[90mType 'tabs' to see open browser tabs, then 'cd tabs/<id>' to enter one.\x1b[0m",
    "",
  ].join("\r\n");
}

// ---- Type indicator prefixes for agent-friendly output ----
// These short prefixes communicate metadata without relying on color alone.

function typePrefix(node: VFSNode): string {
  if (node.isDirectory) {
    return "[d]";
  }
  if (INTERACTIVE_ROLES.has(node.role)) {
    return "[x]";
  }
  return "[-]";
}

// ---- Help text for --help on each command ----

const COMMAND_HELP: Record<string, string> = {
  help: [
    "\x1b[1;36mhelp\x1b[0m \u2014 Show all available commands",
    "",
    "\x1b[33mUsage:\x1b[0m help",
  ].join("\r\n"),

  tabs: [
    "\x1b[1;36mtabs\x1b[0m \u2014 List all open browser tabs",
    "",
    "\x1b[33mUsage:\x1b[0m tabs",
    "",
    "Shows all tabs across all windows with their IDs, titles, and URLs.",
    "Use 'cd tabs/<id>' to switch to a specific tab.",
    "",
    "\x1b[33mEquivalent to:\x1b[0m ls ~/tabs/",
  ].join("\r\n"),

  windows: [
    "\x1b[1;36mwindows\x1b[0m \u2014 List all browser windows with their tabs",
    "",
    "\x1b[33mUsage:\x1b[0m windows",
    "",
    "Shows all Chrome windows with their tabs grouped underneath.",
    "Active tabs are marked with *, the current shell tab with *current.",
    "",
    "\x1b[33mEquivalent to:\x1b[0m ls ~/windows/",
  ].join("\r\n"),

  here: [
    "\x1b[1;36mhere\x1b[0m \u2014 Jump to the active tab in the focused window",
    "",
    "\x1b[33mUsage:\x1b[0m here",
    "",
    "Finds the active tab in the last focused Chrome window and enters it.",
    "Equivalent to finding the focused tab's ID and running 'cd tabs/<id>'.",
    "",
    "\x1b[33mExamples:\x1b[0m",
    "  here                 Enter whatever tab you're currently looking at",
    "  here                 (again) Prints 'Already in tab ...' if unchanged",
  ].join("\r\n"),

  refresh: [
    "\x1b[1;36mrefresh\x1b[0m \u2014 Re-fetch the Accessibility Tree",
    "",
    "\x1b[33mUsage:\x1b[0m refresh",
    "",
    "Re-fetches the full AX tree (including iframes) and resets to DOM root.",
    "Use after page navigation or DOM mutations.",
  ].join("\r\n"),

  ls: [
    "\x1b[1;36mls\x1b[0m \u2014 List children of the current node",
    "",
    "\x1b[33mUsage:\x1b[0m ls [options]",
    "",
    "\x1b[33mOptions:\x1b[0m",
    "  \x1b[32m-l, --long\x1b[0m      Long format: type prefix, role, and name",
    "  \x1b[32m-r, --recursive\x1b[0m Show nested children (one level deep)",
    "  \x1b[32m-n N\x1b[0m            Limit output to first N entries",
    "  \x1b[32m--offset N\x1b[0m      Skip first N entries (for pagination)",
    "  \x1b[32m--type ROLE\x1b[0m     Filter by AX role (e.g. --type button)",
    "  \x1b[32m--count\x1b[0m         Show count of children only",
    "",
    "\x1b[33mType Prefixes (in long format):\x1b[0m",
    "  [d]  Directory (container node, cd-able)",
    "  [x]  Interactive (clickable: button, link, input, etc.)",
    "  [-]  Static (read-only: heading, image, text, etc.)",
    "",
    "\x1b[33mColor Legend:\x1b[0m",
    "  \x1b[1;34m\u25a0 Blue\x1b[0m     Directories   \x1b[1;32m\u25a0 Green\x1b[0m   Buttons",
    "  \x1b[1;35m\u25a0 Magenta\x1b[0m  Links         \x1b[1;33m\u25a0 Yellow\x1b[0m  Inputs/search",
    "  \x1b[1;36m\u25a0 Cyan\x1b[0m     Checkboxes    \x1b[37m\u25a0 White\x1b[0m   Other",
    "",
    "At browser level (~), ls shows windows/ and tabs/ directories.",
    "Inside a tab, ls shows the DOM's Accessibility Tree children.",
  ].join("\r\n"),

  cd: [
    "\x1b[1;36mcd\x1b[0m \u2014 Change directory (unified browser + DOM hierarchy)",
    "",
    "\x1b[33mUsage:\x1b[0m cd [path]",
    "",
    "\x1b[33mBrowser paths:\x1b[0m",
    "  cd ~ or cd /     Go to browser root",
    "  cd tabs           Enter the tabs listing",
    "  cd tabs/123       Enter tab 123 (transparent CDP attach)",
    "  cd tabs/github    Switch to first tab matching 'github'",
    "  cd windows        Enter the windows listing",
    "  cd windows/1      Enter window 1's tab listing",
    "",
    "\x1b[33mDOM paths (inside a tab):\x1b[0m",
    "  cd navigation     Enter the 'navigation' container",
    "  cd ..              Go up one level (from DOM root exits to browser level)",
    "  cd main/form      Multi-level path",
    "  cd ../sidebar     Go up then into 'sidebar'",
    "  cd ../456         Switch from one tab to a sibling tab",
  ].join("\r\n"),

  pwd: [
    "\x1b[1;36mpwd\x1b[0m \u2014 Print working directory (unified path)",
    "",
    "\x1b[33mUsage:\x1b[0m pwd",
    "",
    "Shows the full path from browser root, e.g. ~/tabs/123/main/form",
  ].join("\r\n"),

  cat: [
    "\x1b[1;36mcat\x1b[0m \u2014 Read metadata and text content of a node",
    "",
    "\x1b[33mUsage:\x1b[0m cat <name>",
    "",
    "Shows: role, type ([d]/[x]/[-]), AX ID, DOM backend ID,",
    "value, child count (dirs), and DOM text content.",
    "",
    "Requires a tab context (cd into a tab first).",
  ].join("\r\n"),

  text: [
    "\x1b[1;36mtext\x1b[0m \u2014 Bulk extract text content from a node and its descendants",
    "",
    "\x1b[33mUsage:\x1b[0m text [name] [-n N]",
    "",
    "\x1b[33mArguments:\x1b[0m",
    "  name         Extract text from a specific child (default: current directory)",
    "  -n N         Limit output to first N characters",
    "",
    "Uses the DOM's textContent property, which returns all descendant text",
    "in a single call. Much faster than calling 'cat' on each element.",
    "",
    "\x1b[33mExamples:\x1b[0m",
    "  text                    All text from current directory",
    "  text main               All text from the 'main' child",
    "  text article -n 2000    First 2000 chars from 'article'",
  ].join("\r\n"),

  click: [
    "\x1b[1;36mclick\x1b[0m \u2014 Click an element",
    "",
    "\x1b[33mUsage:\x1b[0m click <name>",
    "",
    "Resolves the node to a DOM element and triggers a click.",
    "Falls back to coordinate-based click if JS click fails.",
  ].join("\r\n"),

  focus: [
    "\x1b[1;36mfocus\x1b[0m \u2014 Focus an input element",
    "",
    "\x1b[33mUsage:\x1b[0m focus <name>",
    "",
    "Focuses the DOM element. Use before 'type' to direct keyboard input.",
  ].join("\r\n"),

  type: [
    "\x1b[1;36mtype\x1b[0m \u2014 Type text into the focused element",
    "",
    "\x1b[33mUsage:\x1b[0m type <text>",
    "",
    "Dispatches key events character by character.",
    "Use 'focus' first to target an input.",
    "",
    "\x1b[33mExample:\x1b[0m",
    "  focus search_search",
    "  type hello world",
  ].join("\r\n"),

  grep: [
    "\x1b[1;36mgrep\x1b[0m \u2014 Search children for matching names",
    "",
    "\x1b[33mUsage:\x1b[0m grep [options] <pattern>",
    "",
    "\x1b[33mOptions:\x1b[0m",
    "  \x1b[32m-r, --recursive\x1b[0m  Search all descendants recursively",
    "  \x1b[32m-n N\x1b[0m             Limit results to first N matches",
    "",
    "Matches against name, role, and value. Case-insensitive.",
  ].join("\r\n"),

  find: [
    "\x1b[1;36mfind\x1b[0m \u2014 Deep recursive search with full paths",
    "",
    "\x1b[33mUsage:\x1b[0m find [options] <pattern>",
    "",
    "\x1b[33mOptions:\x1b[0m",
    "  \x1b[32m--type ROLE\x1b[0m   Filter by AX role (e.g. --type combobox)",
    "  \x1b[32m-n N\x1b[0m          Limit to first N results",
    "",
    "Searches the entire tree from CWD down. Shows the full path.",
  ].join("\r\n"),

  tree: [
    "\x1b[1;36mtree\x1b[0m \u2014 Show a tree view of the current node",
    "",
    "\x1b[33mUsage:\x1b[0m tree [depth]",
    "",
    "\x1b[33mArguments:\x1b[0m",
    "  depth    Max depth to display (default: 2)",
  ].join("\r\n"),

  whoami: [
    "\x1b[1;36mwhoami\x1b[0m \u2014 Check authentication status via cookies",
    "",
    "\x1b[33mUsage:\x1b[0m whoami",
    "",
    "Reads cookies for the current URL and looks for session/auth cookies.",
  ].join("\r\n"),

  env: [
    "\x1b[1;36menv\x1b[0m \u2014 Show environment variables",
    "",
    "\x1b[33mUsage:\x1b[0m env",
  ].join("\r\n"),

  export: [
    "\x1b[1;36mexport\x1b[0m \u2014 Set an environment variable",
    "",
    "\x1b[33mUsage:\x1b[0m export KEY=VALUE",
    "",
    "\x1b[33mExamples:\x1b[0m",
    "  export API_KEY=sk-abc123",
    "  export USER=agent",
  ].join("\r\n"),

  debug: [
    "\x1b[1;36mdebug\x1b[0m \u2014 Inspect raw AX tree data",
    "",
    "\x1b[33mSubcommands:\x1b[0m",
    "  \x1b[32mstats\x1b[0m          AX tree statistics",
    "  \x1b[32mraw\x1b[0m            Raw children of current node (incl. ignored)",
    "  \x1b[32mnode <id>\x1b[0m      Inspect a specific AX node by its ID",
  ].join("\r\n"),

  clear: [
    "\x1b[1;36mclear\x1b[0m \u2014 Clear the terminal screen",
    "",
    "\x1b[33mUsage:\x1b[0m clear",
  ].join("\r\n"),

  navigate: [
    "\x1b[1;36mnavigate\x1b[0m \u2014 Navigate the current tab to a URL",
    "",
    "\x1b[33mUsage:\x1b[0m navigate <url>",
    "",
    "Navigates the tab you're currently inside to the given URL.",
    "Requires a tab context (cd into a tab first).",
    "Automatically re-fetches the AX tree after loading.",
    "",
    "\x1b[33mAlias:\x1b[0m goto",
    "",
    "\x1b[33mExamples:\x1b[0m",
    "  navigate https://google.com",
    "  goto https://github.com",
  ].join("\r\n"),

  goto: [
    "\x1b[1;36mgoto\x1b[0m \u2014 Alias for navigate. See navigate --help.",
  ].join("\r\n"),

  open: [
    "\x1b[1;36mopen\x1b[0m \u2014 Open a new tab and enter it",
    "",
    "\x1b[33mUsage:\x1b[0m open <url>",
    "",
    "Creates a new tab with the given URL, waits for it to load,",
    "then enters it (path becomes ~/tabs/<id>).",
    "Works from any location in the hierarchy.",
    "",
    "\x1b[33mExamples:\x1b[0m",
    "  open https://google.com",
    "  open https://github.com/apireno/AgenticShell",
  ].join("\r\n"),

  connect: [
    "\x1b[1;36mconnect\x1b[0m \u2014 Connect to an AgentShell MCP server via WebSocket",
    "",
    "\x1b[33mUsage:\x1b[0m connect <token>",
    "",
    "Establishes a WebSocket bridge to the MCP server, allowing",
    "AI assistants like Claude Desktop to control the browser.",
    "",
    "\x1b[33mSetup:\x1b[0m",
    "  1. Start the MCP server:  cd mcp-server && npx tsx index.ts",
    "  2. Copy the auth token from the server output",
    "  3. In AgentShell:  connect <token>",
    "",
    "\x1b[33mOptions:\x1b[0m",
    "  \x1b[32m--port N\x1b[0m   Connect to a custom port (default: 9876)",
    "",
    "\x1b[1;31m\u26a0 Security Warning:\x1b[0m",
    "  This gives the MCP server (and any connected AI) access to",
    "  execute commands in your browser. Only connect to MCP servers",
    "  you trust and have started yourself.",
  ].join("\r\n"),

  disconnect: [
    "\x1b[1;36mdisconnect\x1b[0m \u2014 Disconnect from the MCP server",
    "",
    "\x1b[33mUsage:\x1b[0m disconnect",
    "",
    "Closes the WebSocket bridge and clears the stored auth token.",
  ].join("\r\n"),
};

// ---- Arg Parsing Utility ----

interface ParsedArgs {
  flags: Set<string>;
  named: Record<string, string>;
  positional: string[];
}

function parseArgs(args: string[]): ParsedArgs {
  const flags = new Set<string>();
  const named: Record<string, string> = {};
  const positional: string[] = [];

  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === "--help") {
      flags.add("--help");
    } else if (a === "-l" || a === "--long") {
      flags.add("-l");
    } else if (a === "-r" || a === "--recursive") {
      flags.add("-r");
    } else if (a === "--count") {
      flags.add("--count");
    } else if ((a === "-n" || a === "--offset" || a === "--type") && i + 1 < args.length) {
      named[a] = args[++i];
    } else if (a.startsWith("-")) {
      flags.add(a);
    } else {
      positional.push(a);
    }
    i++;
  }

  return { flags, named, positional };
}

// ---- Command Parser ----

async function executeCommand(raw: string): Promise<string> {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  const parts = parseCommandLine(trimmed);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  // Universal --help check
  if (args.includes("--help")) {
    return COMMAND_HELP[cmd] ?? `No help available for '${cmd}'.`;
  }

  try {
    switch (cmd) {
      case "help":
        return handleHelp();
      case "tabs":
        return await handleTabs();
      case "windows":
        return await handleWindows();
      case "ls":
        return await handleLs(args);
      case "cd":
        return await handleCd(args);
      case "pwd":
        return handlePwd();
      case "here":
        return await handleHere();
      case "cat":
        return await handleCat(args);
      case "text":
        return await handleText(args);
      case "click":
        return await handleClick(args);
      case "type":
        return await handleType(args);
      case "focus":
        return await handleFocus(args);
      case "grep":
        return await handleGrep(args);
      case "find":
        return await handleFind(args);
      case "whoami":
        return await handleWhoami();
      case "env":
        return handleEnv();
      case "export":
        return handleExport(args);
      case "tree":
        return await handleTree(args);
      case "refresh":
        return await handleRefresh();
      case "debug":
        return await handleDebug(args);
      case "navigate":
      case "goto":
        return await handleNavigate(args);
      case "open":
        return await handleOpen(args);
      case "connect":
        return handleConnect(args);
      case "disconnect":
        return handleDisconnect();
      case "clear":
        return "\x1b[2J\x1b[H";
      default:
        return `\x1b[31magentshell: ${cmd}: command not found\x1b[0m\r\nType 'help' for available commands. Use '<command> --help' for details.`;
    }
  } catch (err: any) {
    return `\x1b[31mError: ${err.message}\x1b[0m`;
  }
}

function parseCommandLine(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuote: string | null = null;

  for (const char of input) {
    if (inQuote) {
      if (char === inQuote) {
        inQuote = null;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (char === " " || char === "\t") {
      if (current) {
        parts.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) parts.push(current);
  return parts;
}

// ---- Command Implementations ----

function handleHelp(): string {
  return [
    "\x1b[1;36mAgentShell \u2014 The browser is your filesystem\x1b[0m",
    "",
    "Use \x1b[33m<command> --help\x1b[0m for detailed usage of any command.",
    "",
    "\x1b[1;33mBrowser:\x1b[0m",
    "  \x1b[32mtabs\x1b[0m            List all open browser tabs",
    "  \x1b[32mwindows\x1b[0m         List all browser windows with their tabs",
    "  \x1b[32mhere\x1b[0m            Jump to the active tab in the focused window",
    "  \x1b[32mcd tabs/<id>\x1b[0m    Enter a tab (by ID or name pattern)",
    "  \x1b[32mcd ~\x1b[0m or \x1b[32mcd /\x1b[0m    Go to browser root",
    "",
    "\x1b[1;33mNavigation:\x1b[0m",
    "  \x1b[32mnavigate <url>\x1b[0m  Navigate the current tab to a URL",
    "  \x1b[32mopen <url>\x1b[0m      Open a new tab and enter it",
    "  \x1b[32mrefresh\x1b[0m         Re-fetch the Accessibility Tree",
    "  \x1b[32mls\x1b[0m              List children (tabs/windows at ~ or DOM elements)",
    "  \x1b[32mcd <name>\x1b[0m       Enter a child node",
    "  \x1b[32mpwd\x1b[0m             Show current path",
    "  \x1b[32mtree [depth]\x1b[0m    Show tree view of current node",
    "",
    "\x1b[1;33mInspection:\x1b[0m",
    "  \x1b[32mcat <name>\x1b[0m      Read metadata and text content of a node",
    "  \x1b[32mtext [name]\x1b[0m     Bulk extract text from a node and descendants",
    "  \x1b[32mgrep <pattern>\x1b[0m  Search children for matching names",
    "  \x1b[32mfind <pattern>\x1b[0m  Deep recursive search across the tree",
    "",
    "\x1b[1;33mInteraction:\x1b[0m",
    "  \x1b[32mclick <name>\x1b[0m    Click an element",
    "  \x1b[32mfocus <name>\x1b[0m    Focus an input element",
    "  \x1b[32mtype <text>\x1b[0m     Type text into the focused element",
    "",
    "\x1b[1;33mSystem:\x1b[0m",
    "  \x1b[32mwhoami\x1b[0m          Check authentication cookies",
    "  \x1b[32menv\x1b[0m             Show environment variables",
    "  \x1b[32mexport K=V\x1b[0m      Set an environment variable",
    "  \x1b[32mdebug\x1b[0m           Inspect raw AX tree data",
    "  \x1b[32mclear\x1b[0m           Clear the terminal",
    "",
    "\x1b[1;33mMCP Bridge:\x1b[0m",
    "  \x1b[32mconnect <token>\x1b[0m Connect to an MCP server (WebSocket)",
    "  \x1b[32mdisconnect\x1b[0m      Disconnect from the MCP server",
    "",
    "\x1b[90mType prefixes: [d]=directory [x]=interactive [-]=static\x1b[0m",
    "",
    "\x1b[90mhttps://github.com/apireno/AgenticShell\x1b[0m",
    "",
  ].join("\r\n");
}

// ---- refresh ----

async function handleRefresh(): Promise<string> {
  ensureInsideTab();

  const axNodes = await cdp.getAllFrameAXTrees();
  nodeMap = buildNodeMap(axNodes);

  const root = findRootNode(nodeMap);

  // Reset DOM portion of path to root
  const domStart = getDomStartIndex(state.path);
  if (domStart >= 0) {
    state.path = state.path.slice(0, domStart);
  }
  state.axNodeIds = root ? [root.nodeId] : [];

  return `\x1b[32m\u2713 Refreshed. ${nodeMap.size} AX nodes loaded.\x1b[0m`;
}

/**
 * If the DOM/page has changed since last fetch, re-fetch the AX tree.
 * Returns a status message if refresh happened, empty string otherwise.
 */
async function ensureFreshTree(): Promise<string> {
  if (!treeStale) return "";

  treeStale = false;

  const axNodes = await cdp.getAllFrameAXTrees();
  nodeMap = buildNodeMap(axNodes);

  // Check if current AX node still exists in the new tree
  const currentId = state.axNodeIds[state.axNodeIds.length - 1];
  if (currentId && !nodeMap.has(currentId)) {
    // CWD is gone — page navigated, reset DOM portion to root
    const root = findRootNode(nodeMap);
    const domStart = getDomStartIndex(state.path);
    if (domStart >= 0) {
      state.path = state.path.slice(0, domStart);
    }
    state.axNodeIds = root ? [root.nodeId] : [];
    return `\x1b[33m(page changed \u2014 tree refreshed, ${nodeMap.size} nodes, path reset to tab root)\x1b[0m\r\n`;
  }

  return `\x1b[90m(tree auto-refreshed, ${nodeMap.size} nodes)\x1b[0m\r\n`;
}

// ---- Tab Completion ----

const COMMANDS = [
  "help", "tabs", "windows", "here", "refresh", "ls", "cd", "pwd", "cat",
  "click", "focus", "type", "grep", "find", "whoami", "env", "export",
  "tree", "debug", "clear", "navigate", "goto", "open", "connect", "disconnect", "text",
];

function getCompletions(partial: string, command: string): string[] {
  // If no command yet (completing the command name itself)
  if (!command || command === partial) {
    const lower = partial.toLowerCase();
    return COMMANDS.filter((c) => c.startsWith(lower));
  }

  // For cd at browser level, complete browser-level names
  if (command === "cd" && !isInsideTab()) {
    const lower = partial.toLowerCase();
    if (state.path.length === 0) {
      // At ~: complete "tabs" or "windows"
      return ["tabs/", "windows/"].filter((c) => c.toLowerCase().startsWith(lower));
    }
    // At ~/tabs or ~/windows/<id>: could complete tab IDs but too dynamic
    return [];
  }

  // For commands that take node names, complete against current directory children
  const nodeCommands = new Set(["cd", "cat", "click", "focus", "ls", "grep", "find", "text"]);
  if (!nodeCommands.has(command)) return [];

  try {
    if (!state.activeTabId || nodeMap.size === 0 || !isInsideTab()) return [];
    const currentId = getCurrentNodeId();
    const children = getChildVFSNodes(currentId, nodeMap);

    const lower = partial.toLowerCase();
    let matches = children.filter((c) => c.name.toLowerCase().startsWith(lower));

    // For 'cd', only show directories
    if (command === "cd") {
      matches = matches.filter((c) => c.isDirectory);
    }

    return matches.map((m) => m.name + (m.isDirectory ? "/" : ""));
  } catch {
    return [];
  }
}

// ---- ls ----

async function handleLs(args: string[]): Promise<string> {
  const pa = parseArgs(args);

  // Check for explicit ~ path argument
  if (pa.positional.length > 0 && pa.positional[0].startsWith("~")) {
    const afterTilde = pa.positional[0].slice(1).replace(/^\//, "");
    const browserPath = afterTilde ? afterTilde.split("/").filter(Boolean) : [];
    return await listBrowserLevel(browserPath);
  }

  // If not inside a tab, route to browser-level listing
  if (!isInsideTab()) {
    // Resolve relative browser-level paths
    if (pa.positional.length > 0) {
      const relPath = pa.positional[0].split("/").filter(Boolean);
      const fullPath = [...state.path, ...relPath];
      return await listBrowserLevel(fullPath);
    }
    return await listBrowserLevel(state.path);
  }

  // DOM-level listing
  ensureInsideTab();
  const refreshMsg = await ensureFreshTree();

  const longFormat = pa.flags.has("-l");
  const recursive = pa.flags.has("-r");
  const countOnly = pa.flags.has("--count");
  const limit = pa.named["-n"] ? parseInt(pa.named["-n"], 10) : 0;
  const offset = pa.named["--offset"] ? parseInt(pa.named["--offset"], 10) : 0;
  const typeFilter = pa.named["--type"]?.toLowerCase();

  const currentId = getCurrentNodeId();
  let children = getChildVFSNodes(currentId, nodeMap);

  // Recursive: also include children of directory children
  if (recursive) {
    const extra: VFSNode[] = [];
    for (const child of children) {
      if (child.isDirectory) {
        const nested = getChildVFSNodes(child.axNodeId, nodeMap);
        for (const n of nested) {
          extra.push({ ...n, name: `${child.name}/${n.name}` });
        }
      }
    }
    children = [...children, ...extra];
  }

  // Type filter
  if (typeFilter) {
    children = children.filter((c) => c.role.toLowerCase() === typeFilter);
  }

  // Count only
  if (countOnly) {
    const dirs = children.filter((c) => c.isDirectory).length;
    const interactive = children.filter((c) => !c.isDirectory && INTERACTIVE_ROLES.has(c.role)).length;
    const staticCount = children.length - dirs - interactive;
    return `${children.length} total (\x1b[1;34m${dirs} [d]\x1b[0m, \x1b[1;32m${interactive} [x]\x1b[0m, ${staticCount} [-])`;
  }

  if (children.length === 0) {
    return "\x1b[90m(empty directory)\x1b[0m";
  }

  // Pagination
  const total = children.length;
  if (offset > 0) {
    children = children.slice(offset);
  }
  if (limit > 0) {
    children = children.slice(0, limit);
  }

  const lines: string[] = [];

  for (const child of children) {
    const tp = typePrefix(child);
    if (longFormat) {
      const role = child.role.padEnd(14);
      const name = child.isDirectory
        ? `\x1b[1;34m${child.name}/\x1b[0m`
        : formatColoredName(child);
      lines.push(`${tp} ${role} ${name}`);
    } else {
      if (child.isDirectory) {
        lines.push(`\x1b[1;34m${child.name}/\x1b[0m`);
      } else {
        lines.push(formatColoredName(child));
      }
    }
  }

  // Pagination hint
  if (limit > 0 && offset + limit < total) {
    lines.push(`\x1b[90m... ${offset + 1}-${offset + children.length} of ${total} (--offset ${offset + limit} for next page)\x1b[0m`);
  } else if (offset > 0) {
    lines.push(`\x1b[90m... ${offset + 1}-${offset + children.length} of ${total}\x1b[0m`);
  }

  return refreshMsg + lines.join("\r\n");
}

async function listBrowserLevel(browserPath: string[]): Promise<string> {
  const allWindows = await chrome.windows.getAll({ populate: true });

  if (browserPath.length === 0) {
    // Browser root: show windows/ and tabs/ directories
    const totalTabs = allWindows.reduce((sum, w) => sum + (w.tabs?.length ?? 0), 0);
    const lines = [
      `  \x1b[1;34mwindows/\x1b[0m       \x1b[90m(${allWindows.length} windows)\x1b[0m`,
      `  \x1b[1;34mtabs/\x1b[0m          \x1b[90m(${totalTabs} tabs)\x1b[0m`,
    ];
    if (state.activeTabId) {
      try {
        const tab = await chrome.tabs.get(state.activeTabId);
        lines.push("");
        lines.push(`  \x1b[90mActive tab: ${tab.id} \u2014 ${tab.title ?? "unknown"} (${tab.url ?? ""})\x1b[0m`);
      } catch { /* tab gone */ }
    }
    return lines.join("\r\n");
  }

  if (browserPath[0] === "tabs") {
    // Flat list of all tabs
    const lines: string[] = [
      `  \x1b[90mID     TITLE                                URL                                    WIN\x1b[0m`,
    ];
    for (const win of allWindows) {
      for (const tab of win.tabs ?? []) {
        const current = tab.id === state.activeTabId ? " \x1b[32m*current\x1b[0m" : "";
        const active = tab.active ? "\x1b[33m*\x1b[0m" : " ";
        const id = String(tab.id ?? "?").padEnd(6);
        const title = (tab.title ?? "untitled").slice(0, 36).padEnd(36);
        const url = (tab.url ?? "").slice(0, 38).padEnd(38);
        const winId = String(win.id ?? "?");
        lines.push(`  ${active}${id} ${title} ${url} ${winId}${current}`);
      }
    }
    lines.push("");
    lines.push(`\x1b[90mUse 'cd <id>' or 'cd <url-pattern>' to enter a tab.\x1b[0m`);
    return lines.join("\r\n");
  }

  if (browserPath[0] === "windows" && browserPath.length === 1) {
    // Tree view of windows with their tabs
    const lines: string[] = [];
    for (let wi = 0; wi < allWindows.length; wi++) {
      const win = allWindows[wi];
      const focused = win.focused ? " \x1b[33m(focused)\x1b[0m" : "";
      lines.push(`\x1b[1;34mWindow ${win.id ?? "?"}\x1b[0m${focused}`);

      const tabs = win.tabs ?? [];
      for (let ti = 0; ti < tabs.length; ti++) {
        const tab = tabs[ti];
        const isLast = ti === tabs.length - 1;
        const connector = isLast ? "\u2514\u2500\u2500 " : "\u251c\u2500\u2500 ";
        const active = tab.active ? "\x1b[33m*\x1b[0m" : " ";
        const current = tab.id === state.activeTabId ? " \x1b[32m*current\x1b[0m" : "";
        const id = String(tab.id ?? "?").padEnd(6);
        const title = (tab.title ?? "untitled").slice(0, 32).padEnd(32);
        const url = (tab.url ?? "").replace(/^https?:\/\//, "").slice(0, 30);
        lines.push(`${connector}${active}${id} ${title} \x1b[90m${url}\x1b[0m${current}`);
      }

      if (wi < allWindows.length - 1) lines.push("");
    }
    lines.push("");
    lines.push(`\x1b[90mUse 'cd windows/<id>/<tab-id>' to enter a tab, or 'here' to jump to the active tab.\x1b[0m`);
    return lines.join("\r\n");
  }

  if (browserPath[0] === "windows" && browserPath.length === 2) {
    // List tabs in a specific window
    const windowId = parseInt(browserPath[1], 10);
    const win = allWindows.find((w) => w.id === windowId);
    if (!win) return `\x1b[31mWindow ${windowId} not found.\x1b[0m`;

    const lines: string[] = [
      `  \x1b[90mID     TITLE                                URL\x1b[0m`,
    ];
    for (const tab of win.tabs ?? []) {
      const current = tab.id === state.activeTabId ? " \x1b[32m*current\x1b[0m" : "";
      const id = String(tab.id ?? "?").padEnd(6);
      const title = (tab.title ?? "untitled").slice(0, 36).padEnd(36);
      const url = (tab.url ?? "").slice(0, 38);
      lines.push(`  ${id} ${title} ${url}${current}`);
    }
    lines.push("");
    lines.push(`\x1b[90mUse 'cd <id>' or 'cd <url-pattern>' to enter a tab.\x1b[0m`);
    return lines.join("\r\n");
  }

  return `\x1b[31mInvalid browser path.\x1b[0m`;
}

// ---- tabs / windows shortcut commands ----

async function handleTabs(): Promise<string> {
  return await listBrowserLevel(["tabs"]);
}

async function handleWindows(): Promise<string> {
  return await listBrowserLevel(["windows"]);
}

function formatColoredName(node: VFSNode): string {
  switch (node.role) {
    case "button":
      return `\x1b[1;32m${node.name}\x1b[0m`;
    case "link":
      return `\x1b[1;35m${node.name}\x1b[0m`;
    case "textbox":
    case "searchbox":
    case "combobox":
      return `\x1b[1;33m${node.name}\x1b[0m`;
    case "checkbox":
    case "radio":
    case "switch":
      return `\x1b[1;36m${node.name}\x1b[0m`;
    case "heading":
      return `\x1b[1;37m${node.name}\x1b[0m`;
    case "img":
    case "image":
      return `\x1b[90m${node.name}\x1b[0m`;
    default:
      return `\x1b[37m${node.name}\x1b[0m`;
  }
}

// ---- cd (unified hierarchy) ----

async function handleCd(args: string[]): Promise<string> {
  const target = args.length > 0 ? args[0] : "";

  // cd / or cd ~ or cd (empty) — go to browser root
  if (target === "/" || target === "~" || target === "") {
    state.path = [];
    // Don't detach CDP — keep it lazy for quick re-entry
    return "";
  }

  // cd ~/... — absolute path from browser root
  if (target.startsWith("~/")) {
    state.path = [];
    const afterTilde = target.slice(2);
    if (!afterTilde) return "";
    const segments = afterTilde.split("/").filter(Boolean);
    return await navigateSegments(segments);
  }

  // Relative path: split into segments and navigate
  const segments = target.split("/").filter(Boolean);
  return await navigateSegments(segments);
}

/**
 * Navigate through path segments from the current position.
 * Handles both browser-level and DOM-level navigation seamlessly.
 */
async function navigateSegments(segments: string[]): Promise<string> {
  for (const segment of segments) {
    if (segment === ".") continue;

    if (segment === "..") {
      if (state.path.length === 0) {
        // Already at browser root, can't go higher
        continue;
      }

      // Check if we're leaving a tab (popping from tab entry point)
      const tabId = getTabIdFromPath(state.path);
      const domStart = getDomStartIndex(state.path);

      if (tabId !== null && domStart >= 0 && state.path.length > domStart) {
        // We're in DOM — pop one DOM level
        state.path.pop();
        state.axNodeIds.pop();
        // If we've popped back to the tab entry point, pop out of the tab entirely
        if (state.path.length === domStart) {
          state.path.pop(); // Pop the tab ID segment
          state.axNodeIds = [];
        }
      } else {
        // We're at browser level — pop one browser segment
        state.path.pop();
        state.axNodeIds = [];
      }
      continue;
    }

    // Determine what level we're at to interpret the segment
    const result = await navigateOneSegment(segment);
    if (result) return result; // Error message
  }
  return "";
}

/**
 * Navigate a single segment from the current path position.
 * Returns an error string, or empty string on success.
 */
async function navigateOneSegment(segment: string): Promise<string> {
  const tabId = getTabIdFromPath(state.path);

  // If inside a tab's DOM, navigate AX tree
  if (tabId !== null) {
    // Ensure CDP is attached for this tab
    if (state.activeTabId !== tabId || nodeMap.size === 0) {
      try {
        await cdpSwitchToTab(tabId);
      } catch (err: any) {
        return `\x1b[31mFailed to attach to tab ${tabId}: ${err.message}\x1b[0m`;
      }
    }

    await ensureFreshTree();

    const currentId = getCurrentNodeId();
    const match = findChildByName(currentId, segment, nodeMap);

    if (!match) {
      return `\x1b[31mcd: ${segment}: No such directory\x1b[0m`;
    }
    if (!match.isDirectory) {
      return `\x1b[31mcd: ${segment}: Not a directory (type: [x] ${match.role})\x1b[0m`;
    }

    state.path.push(match.name);
    state.axNodeIds.push(match.axNodeId);
    return "";
  }

  // Browser-level navigation
  const depth = state.path.length;

  if (depth === 0) {
    // At browser root (~): only "tabs" and "windows" are valid
    if (segment === "tabs" || segment === "windows") {
      state.path.push(segment);
      return "";
    }
    return `\x1b[31mcd: ${segment}: No such directory (try 'tabs' or 'windows')\x1b[0m`;
  }

  if (state.path[0] === "tabs" && depth === 1) {
    // At ~/tabs/ — segment is a tab target (ID or substring)
    return await enterTab(segment);
  }

  if (state.path[0] === "windows" && depth === 1) {
    // At ~/windows/ — segment is a window ID
    const windowId = parseInt(segment, 10);
    if (isNaN(windowId)) {
      return `\x1b[31mcd: ${segment}: Invalid window ID\x1b[0m`;
    }
    try {
      const win = await chrome.windows.get(windowId, { populate: true });
      if (!win) return `\x1b[31mcd: ${segment}: Window not found\x1b[0m`;
      state.path.push(segment);
      return "";
    } catch {
      return `\x1b[31mcd: ${segment}: Window not found\x1b[0m`;
    }
  }

  if (state.path[0] === "windows" && depth === 2) {
    // At ~/windows/<id>/ — segment is a tab target
    return await enterTab(segment);
  }

  return `\x1b[31mcd: ${segment}: Cannot navigate deeper\x1b[0m`;
}

/**
 * Enter a tab by ID or substring match.
 * Pushes the tab ID onto state.path, attaches CDP, and loads AX tree.
 */
async function enterTab(target: string): Promise<string> {
  try {
    const tab = await resolveTabTarget(target);
    if (!tab?.id) return `\x1b[31mcd: Tab has no ID.\x1b[0m`;

    // Push tab ID onto path
    state.path.push(String(tab.id));

    // Attach CDP and load AX tree
    const { nodeCount, iframeCount } = await cdpSwitchToTab(tab.id);

    const title = tab.title ?? "unknown";
    const url = tab.url ?? "unknown";

    const lines = [
      `\x1b[32m\u2713 Entered tab ${tab.id}\x1b[0m`,
      `  \x1b[37mTitle: ${title}\x1b[0m`,
      `  \x1b[37mURL:   ${url}\x1b[0m`,
      `  \x1b[90mAX Nodes: ${nodeCount}\x1b[0m`,
    ];
    if (iframeCount > 0) {
      lines.push(`  \x1b[90mIframes: ${iframeCount}\x1b[0m`);
    }
    lines.push("");
    return lines.join("\r\n");
  } catch (err: any) {
    return `\x1b[31mcd: ${err.message}\x1b[0m`;
  }
}

// ---- here ----

async function handleHere(): Promise<string> {
  const lastFocused = await chrome.windows.getLastFocused({ populate: true });
  const activeTab = lastFocused.tabs?.find(t => t.active);
  if (!activeTab?.id) {
    return "\x1b[31mNo active tab found.\x1b[0m";
  }

  // Already inside this tab?
  if (state.activeTabId === activeTab.id && isInsideTab()) {
    return `Already in tab ${activeTab.id} \u2014 ${activeTab.title ?? "unknown"}`;
  }

  // Navigate to ~/tabs/<id>
  state.path = ["tabs"];
  return await enterTab(String(activeTab.id));
}

// ---- pwd ----

function handlePwd(): string {
  if (state.path.length === 0) return "~";
  return "~/" + state.path.join("/");
}

// ---- cat ----

async function handleCat(args: string[]): Promise<string> {
  ensureInsideTab();
  await ensureFreshTree();

  if (args.length === 0) {
    return "\x1b[31mUsage: cat <name> (see cat --help)\x1b[0m";
  }

  const targetName = args[0];
  const currentId = getCurrentNodeId();
  const match = findChildByName(currentId, targetName, nodeMap);

  if (!match) {
    return `\x1b[31mcat: ${targetName}: No such file or directory\x1b[0m`;
  }

  const tp = typePrefix(match);
  const lines: string[] = [];
  lines.push(`\x1b[1;36m--- ${match.name} ---\x1b[0m`);
  lines.push(`  \x1b[33mRole:\x1b[0m  ${match.role}`);
  lines.push(`  \x1b[33mType:\x1b[0m  ${tp} ${match.isDirectory ? "directory" : INTERACTIVE_ROLES.has(match.role) ? "interactive" : "static"}`);
  lines.push(`  \x1b[33mAXID:\x1b[0m  ${match.axNodeId}`);

  if (match.backendDOMNodeId) {
    lines.push(`  \x1b[33mDOM:\x1b[0m   backend#${match.backendDOMNodeId}`);
  }

  if (match.value) {
    lines.push(`  \x1b[33mValue:\x1b[0m ${match.value}`);
  }

  if (match.isDirectory) {
    const childCount = getChildVFSNodes(match.axNodeId, nodeMap).length;
    lines.push(`  \x1b[33mChildren:\x1b[0m ${childCount}`);
  }

  if (match.backendDOMNodeId) {
    try {
      const text = await cdp.getTextContent(match.backendDOMNodeId);
      if (text.trim()) {
        lines.push(`  \x1b[33mText:\x1b[0m`);
        const wrapped = text.trim().slice(0, 500);
        lines.push(`  ${wrapped}`);
        if (text.length > 500) {
          lines.push(`  \x1b[90m... (${text.length} chars total)\x1b[0m`);
        }
      }
    } catch {
      // Ignore
    }
  }

  return lines.join("\r\n");
}

// ---- text (bulk text extraction) ----

async function handleText(args: string[]): Promise<string> {
  ensureInsideTab();
  await ensureFreshTree();

  const pa = parseArgs(args);
  const maxLength = pa.named["-n"] ? parseInt(pa.named["-n"], 10) : 0;

  let backendId: number | undefined;
  let targetName = "current directory";

  if (pa.positional.length > 0) {
    const name = pa.positional[0];
    const currentId = getCurrentNodeId();
    const match = findChildByName(currentId, name, nodeMap);
    if (!match) {
      return `\x1b[31mtext: ${name}: No such file or directory\x1b[0m`;
    }
    backendId = match.backendDOMNodeId;
    targetName = match.name;
  } else {
    const currentId = getCurrentNodeId();
    const node = nodeMap.get(currentId);
    backendId = node?.backendDOMNodeId;
    const domSegs = getDomSegments();
    targetName = domSegs.length > 0 ? domSegs[domSegs.length - 1] : "/";
  }

  if (!backendId) {
    return `\x1b[31mtext: ${targetName}: No DOM node backing (AX-only node)\x1b[0m`;
  }

  try {
    let text = await cdp.getTextContent(backendId);
    text = text.trim();

    if (!text) {
      return `\x1b[33m(no text content in ${targetName})\x1b[0m`;
    }

    const lines: string[] = [];
    lines.push(`\x1b[1;36m--- Text: ${targetName} ---\x1b[0m`);

    if (maxLength > 0 && text.length > maxLength) {
      lines.push(text.slice(0, maxLength));
      lines.push(`\x1b[90m... (${text.length} chars total, showing first ${maxLength})\x1b[0m`);
    } else {
      lines.push(text);
      lines.push(`\x1b[90m(${text.length} chars)\x1b[0m`);
    }

    return lines.join("\r\n");
  } catch (err: any) {
    return `\x1b[31mtext: Error extracting text: ${err.message}\x1b[0m`;
  }
}

// ---- click ----

async function handleClick(args: string[]): Promise<string> {
  ensureInsideTab();
  await ensureFreshTree();

  if (args.length === 0) {
    return "\x1b[31mUsage: click <name> (see click --help)\x1b[0m";
  }

  const targetName = args[0];
  const currentId = getCurrentNodeId();
  const match = findChildByName(currentId, targetName, nodeMap);

  if (!match) {
    return `\x1b[31mclick: ${targetName}: No such element\x1b[0m`;
  }

  if (!match.backendDOMNodeId) {
    return `\x1b[31mclick: ${targetName}: No DOM node backing (AX-only node)\x1b[0m`;
  }

  try {
    await cdp.clickByBackendNodeId(match.backendDOMNodeId);
    treeStale = true;
    return `\x1b[32m\u2713 Clicked: ${match.name} (${match.role})\x1b[0m\r\n\x1b[90m(tree will auto-refresh on next command)\x1b[0m`;
  } catch {
    try {
      await cdp.clickByCoordinates(match.backendDOMNodeId);
      treeStale = true;
      return `\x1b[32m\u2713 Clicked (coords): ${match.name} (${match.role})\x1b[0m\r\n\x1b[90m(tree will auto-refresh on next command)\x1b[0m`;
    } catch (err: any) {
      return `\x1b[31mclick failed: ${err.message}\x1b[0m`;
    }
  }
}

// ---- focus ----

async function handleFocus(args: string[]): Promise<string> {
  ensureInsideTab();
  await ensureFreshTree();

  if (args.length === 0) {
    return "\x1b[31mUsage: focus <name> (see focus --help)\x1b[0m";
  }

  const targetName = args[0];
  const currentId = getCurrentNodeId();
  const match = findChildByName(currentId, targetName, nodeMap);

  if (!match) {
    return `\x1b[31mfocus: ${targetName}: No such element\x1b[0m`;
  }

  if (!match.backendDOMNodeId) {
    return `\x1b[31mfocus: ${targetName}: No DOM node backing\x1b[0m`;
  }

  await cdp.focusByBackendNodeId(match.backendDOMNodeId);
  return `\x1b[32m\u2713 Focused: ${match.name}\x1b[0m`;
}

// ---- type ----

async function handleType(args: string[]): Promise<string> {
  ensureInsideTab();

  if (args.length === 0) {
    return "\x1b[31mUsage: type <text> (see type --help)\x1b[0m";
  }

  const text = args.join(" ");
  await cdp.typeText(text);
  return `\x1b[32m\u2713 Typed ${text.length} characters\x1b[0m`;
}

// ---- grep ----

async function handleGrep(args: string[]): Promise<string> {
  ensureInsideTab();
  await ensureFreshTree();

  const pa = parseArgs(args);
  const recursive = pa.flags.has("-r");
  const limit = pa.named["-n"] ? parseInt(pa.named["-n"], 10) : 0;

  if (pa.positional.length === 0) {
    return "\x1b[31mUsage: grep [options] <pattern> (see grep --help)\x1b[0m";
  }

  const pattern = pa.positional[0].toLowerCase();
  const currentId = getCurrentNodeId();

  let candidates: VFSNode[];
  if (recursive) {
    candidates = [];
    collectAllDescendants(currentId, nodeMap, candidates, new Set());
  } else {
    candidates = getChildVFSNodes(currentId, nodeMap);
  }

  let matches = candidates.filter(
    (c) =>
      c.name.toLowerCase().includes(pattern) ||
      c.role.toLowerCase().includes(pattern) ||
      (c.value && c.value.toLowerCase().includes(pattern))
  );

  if (matches.length === 0) {
    return `\x1b[33mNo matches for '${pattern}'\x1b[0m`;
  }

  if (limit > 0) matches = matches.slice(0, limit);

  return matches
    .map((m) => {
      const tp = typePrefix(m);
      return `${tp} ${formatColoredName(m)} \x1b[90m(${m.role})\x1b[0m`;
    })
    .join("\r\n");
}

// ---- find (deep recursive search with full paths) ----

async function handleFind(args: string[]): Promise<string> {
  ensureInsideTab();
  await ensureFreshTree();

  const pa = parseArgs(args);
  const typeFilter = pa.named["--type"]?.toLowerCase();
  const limit = pa.named["-n"] ? parseInt(pa.named["-n"], 10) : 0;
  const pattern = pa.positional[0]?.toLowerCase() ?? "";

  if (!pattern && !typeFilter) {
    return "\x1b[31mUsage: find [options] <pattern> (see find --help)\x1b[0m";
  }

  const currentId = getCurrentNodeId();
  const results: Array<{ path: string; node: VFSNode }> = [];
  findRecursive(currentId, "", pattern, typeFilter, results, new Set(), limit);

  if (results.length === 0) {
    const desc = typeFilter ? `type '${typeFilter}'` : `'${pattern}'`;
    return `\x1b[33mNo matches for ${desc}\x1b[0m`;
  }

  return results
    .map((r) => {
      const tp = typePrefix(r.node);
      const coloredName = r.node.isDirectory
        ? `\x1b[1;34m${r.node.name}/\x1b[0m`
        : formatColoredName(r.node);
      return `${tp} \x1b[90m${r.path}\x1b[0m${coloredName} \x1b[90m(${r.node.role})\x1b[0m`;
    })
    .join("\r\n");
}

function findRecursive(
  parentId: string,
  pathPrefix: string,
  pattern: string,
  typeFilter: string | undefined,
  results: Array<{ path: string; node: VFSNode }>,
  visited: Set<string>,
  limit: number
): void {
  if (visited.has(parentId)) return;
  if (limit > 0 && results.length >= limit) return;
  visited.add(parentId);

  const children = getChildVFSNodes(parentId, nodeMap);

  for (const child of children) {
    if (limit > 0 && results.length >= limit) return;

    const matchesPattern = !pattern ||
      child.name.toLowerCase().includes(pattern) ||
      child.role.toLowerCase().includes(pattern) ||
      (child.value && child.value.toLowerCase().includes(pattern));

    const matchesType = !typeFilter || child.role.toLowerCase() === typeFilter;

    if (matchesPattern && matchesType) {
      results.push({ path: pathPrefix, node: child });
    }

    if (child.isDirectory) {
      findRecursive(
        child.axNodeId,
        pathPrefix + child.name + "/",
        pattern,
        typeFilter,
        results,
        visited,
        limit
      );
    }
  }
}

function collectAllDescendants(
  parentId: string,
  map: Map<string, AXNode>,
  results: VFSNode[],
  visited: Set<string>
): void {
  if (visited.has(parentId)) return;
  visited.add(parentId);

  const children = getChildVFSNodes(parentId, map);
  for (const child of children) {
    results.push(child);
    if (child.isDirectory) {
      collectAllDescendants(child.axNodeId, map, results, visited);
    }
  }
}

// ---- tree ----

async function handleTree(args: string[]): Promise<string> {
  ensureInsideTab();
  await ensureFreshTree();

  const pa = parseArgs(args);
  const maxDepth = pa.positional[0] ? parseInt(pa.positional[0], 10) : 2;
  const currentId = getCurrentNodeId();

  const lines: string[] = [];
  const currentNode = nodeMap.get(currentId);
  const rootName = currentNode ? generateNodeName(currentNode) : "/";
  lines.push(`\x1b[1;34m${rootName}/\x1b[0m`);

  buildTreeLines(currentId, "", maxDepth, 0, lines);

  return lines.join("\r\n");
}

function buildTreeLines(
  parentId: string,
  prefix: string,
  maxDepth: number,
  depth: number,
  lines: string[]
): void {
  if (depth >= maxDepth) return;

  const children = getChildVFSNodes(parentId, nodeMap);

  children.forEach((child, i) => {
    const isLast = i === children.length - 1;
    const connector = isLast ? "\u2514\u2500\u2500 " : "\u251c\u2500\u2500 ";
    const childPrefix = isLast ? "    " : "\u2502   ";
    const tp = typePrefix(child);

    const display = child.isDirectory
      ? `\x1b[1;34m${child.name}/\x1b[0m`
      : formatColoredName(child);

    lines.push(`${prefix}${connector}${tp} ${display}`);

    if (child.isDirectory) {
      buildTreeLines(child.axNodeId, prefix + childPrefix, maxDepth, depth + 1, lines);
    }
  });
}

// ---- whoami ----

async function handleWhoami(): Promise<string> {
  ensureInsideTab();

  try {
    const url = await cdp.getPageUrl();
    const cookies = await chrome.cookies.getAll({ url });

    const sessionCookie = cookies.find((c) =>
      c.name.match(/session|sid|auth|token|jwt|user/i)
    );

    const lines: string[] = [];
    lines.push(`\x1b[1;36mURL:\x1b[0m ${url}`);

    if (sessionCookie) {
      lines.push(`\x1b[1;32mStatus:\x1b[0m Authenticated`);
      lines.push(`\x1b[1;33mVia:\x1b[0m ${sessionCookie.name}`);
      if (sessionCookie.expirationDate) {
        const expires = new Date(sessionCookie.expirationDate * 1000).toISOString();
        lines.push(`\x1b[1;33mExpires:\x1b[0m ${expires}`);
      }
    } else {
      lines.push(`\x1b[1;33mStatus:\x1b[0m Guest (no session cookie detected)`);
    }

    lines.push(`\x1b[90mTotal cookies: ${cookies.length}\x1b[0m`);
    return lines.join("\r\n");
  } catch (err: any) {
    return `\x1b[31mError: ${err.message}\x1b[0m`;
  }
}

// ---- env / export ----

function handleEnv(): string {
  return Object.entries(state.env)
    .map(([k, v]) => `\x1b[33m${k}\x1b[0m=${v}`)
    .join("\r\n");
}

function handleExport(args: string[]): string {
  if (args.length === 0) {
    return "\x1b[31mUsage: export KEY=VALUE (see export --help)\x1b[0m";
  }

  const joined = args.join(" ");
  const eqIndex = joined.indexOf("=");
  if (eqIndex === -1) {
    return "\x1b[31mUsage: export KEY=VALUE\x1b[0m";
  }

  const key = joined.slice(0, eqIndex).trim();
  const value = joined.slice(eqIndex + 1).trim();
  state.env[key] = value;

  return `\x1b[32m\u2713 ${key}=${value}\x1b[0m`;
}

// ---- navigate / open ----

async function handleNavigate(args: string[]): Promise<string> {
  if (args.length === 0) {
    return "\x1b[31mUsage: navigate <url> (see navigate --help)\x1b[0m";
  }

  ensureInsideTab();

  let url = args[0];
  if (!url.match(/^https?:\/\//i)) {
    url = "https://" + url;
  }

  const tabId = state.activeTabId!;

  // Detach first (navigation will invalidate CDP state)
  await cdp.detach();
  state.activeTabId = null;

  // Navigate
  await chrome.tabs.update(tabId, { url });

  // Wait for the page to load
  await new Promise<void>((resolve) => {
    const listener = (id: number, info: { status?: string }) => {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15000);
  });

  // Re-attach and fetch new AX tree
  try {
    const { nodeCount } = await cdpSwitchToTab(tabId);

    // Reset DOM portion of path (keep browser portion up to tab)
    const domStart = getDomStartIndex(state.path);
    if (domStart >= 0) {
      state.path = state.path.slice(0, domStart);
    }

    const tab = await chrome.tabs.get(tabId);
    return [
      `\x1b[32m\u2713 Navigated\x1b[0m`,
      `  \x1b[37mURL:   ${tab.url ?? url}\x1b[0m`,
      `  \x1b[37mTitle: ${tab.title ?? "unknown"}\x1b[0m`,
      `  \x1b[90mAX Nodes: ${nodeCount}\x1b[0m`,
      "",
    ].join("\r\n");
  } catch (err: any) {
    return `\x1b[32m\u2713 Navigated to ${url}\x1b[0m\r\n\x1b[31mRe-attach failed: ${err.message}\x1b[0m`;
  }
}

async function handleOpen(args: string[]): Promise<string> {
  if (args.length === 0) {
    return "\x1b[31mUsage: open <url> (see open --help)\x1b[0m";
  }

  let url = args[0];
  if (!url.match(/^https?:\/\//i)) {
    url = "https://" + url;
  }

  // Create new tab
  const tab = await chrome.tabs.create({ url, active: true });
  if (!tab.id) return "\x1b[31mError: Failed to create tab.\x1b[0m";

  // Wait for load
  await new Promise<void>((resolve) => {
    const listener = (id: number, info: { status?: string }) => {
      if (id === tab.id && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15000);
  });

  // Attach and enter the new tab
  try {
    const { nodeCount } = await cdpSwitchToTab(tab.id);

    // Set path to ~/tabs/<newTabId>
    state.path = ["tabs", String(tab.id)];

    const updatedTab = await chrome.tabs.get(tab.id);
    return [
      `\x1b[32m\u2713 Opened new tab\x1b[0m`,
      `  \x1b[37mURL:   ${updatedTab.url ?? url}\x1b[0m`,
      `  \x1b[37mTitle: ${updatedTab.title ?? "unknown"}\x1b[0m`,
      `  \x1b[90mAX Nodes: ${nodeCount}\x1b[0m`,
      "",
    ].join("\r\n");
  } catch (err: any) {
    // Still set path even if attach fails
    state.path = ["tabs", String(tab.id)];
    return `\x1b[32m\u2713 Opened ${url}\x1b[0m\r\n\x1b[31mAttach failed: ${err.message}\x1b[0m`;
  }
}

// ---- connect / disconnect (MCP WebSocket bridge) ----

function handleConnect(args: string[]): string {
  const pa = parseArgs(args);
  const port = pa.named["--port"] ? parseInt(pa.named["--port"], 10) : 9876;

  if (pa.positional.length === 0) {
    if (wsConnected) {
      return `\x1b[32mConnected\x1b[0m to MCP server on port ${wsPort}.\r\nRun \x1b[33mdisconnect\x1b[0m to close.`;
    }
    if (wsEnabled && wsToken) {
      return `\x1b[33mConnecting\x1b[0m to MCP server on port ${wsPort}... (waiting for server)\r\nRun \x1b[33mdisconnect\x1b[0m to cancel.`;
    }
    return "\x1b[31mUsage: connect <token> (see connect --help)\x1b[0m";
  }

  const token = pa.positional[0];

  // Store token, port, and enable
  wsToken = token;
  wsPort = port;
  wsEnabled = true;
  chrome.storage.local.set({ ws_enabled: true, ws_token: token, ws_port: port });

  // Initiate connection
  wsConnect();

  return [
    "\x1b[1;31m\u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510\x1b[0m",
    "\x1b[1;31m\u2502\x1b[0m  \x1b[1;33m\u26a0  SECURITY WARNING\x1b[0m                                    \x1b[1;31m\u2502\x1b[0m",
    "\x1b[1;31m\u2502\x1b[0m                                                         \x1b[1;31m\u2502\x1b[0m",
    "\x1b[1;31m\u2502\x1b[0m  You are granting an external process (MCP server)      \x1b[1;31m\u2502\x1b[0m",
    "\x1b[1;31m\u2502\x1b[0m  the ability to execute commands in your browser.       \x1b[1;31m\u2502\x1b[0m",
    "\x1b[1;31m\u2502\x1b[0m                                                         \x1b[1;31m\u2502\x1b[0m",
    "\x1b[1;31m\u2502\x1b[0m  \x1b[37m\u2022 Only connect to MCP servers you started yourself\x1b[0m    \x1b[1;31m\u2502\x1b[0m",
    "\x1b[1;31m\u2502\x1b[0m  \x1b[37m\u2022 The MCP server controls what commands are allowed\x1b[0m   \x1b[1;31m\u2502\x1b[0m",
    "\x1b[1;31m\u2502\x1b[0m  \x1b[37m\u2022 Use --allow-write on the server to enable clicks\x1b[0m   \x1b[1;31m\u2502\x1b[0m",
    "\x1b[1;31m\u2502\x1b[0m  \x1b[37m\u2022 Run 'disconnect' to stop at any time\x1b[0m               \x1b[1;31m\u2502\x1b[0m",
    "\x1b[1;31m\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518\x1b[0m",
    "",
    `\x1b[32m\u2713 Connecting to MCP server on ws://127.0.0.1:${port}\x1b[0m`,
    "",
  ].join("\r\n");
}

function handleDisconnect(): string {
  if (!wsEnabled && !wsConnected) {
    return "\x1b[33mNot connected to any MCP server.\x1b[0m";
  }

  wsDisconnect();
  chrome.storage.local.set({ ws_enabled: false });
  return "\x1b[32m\u2713 Disconnected from MCP server.\x1b[0m";
}

// ---- debug ----

async function handleDebug(args: string[]): Promise<string> {
  ensureInsideTab();
  await ensureFreshTree();

  const sub = args[0] ?? "stats";
  const currentId = getCurrentNodeId();

  if (sub === "stats") {
    const currentNode = nodeMap.get(currentId);
    const totalNodes = nodeMap.size;
    let ignoredCount = 0;
    let genericCount = 0;
    let withChildrenCount = 0;
    let iframeCount = 0;
    for (const node of nodeMap.values()) {
      if (node.ignored) ignoredCount++;
      if (node.role?.value === "generic") genericCount++;
      if (node.childIds && node.childIds.length > 0) withChildrenCount++;
      const r = node.role?.value ?? "";
      if (r === "Iframe" || r === "IframePresentational") iframeCount++;
    }

    return [
      "\x1b[1;36m--- Debug Stats ---\x1b[0m",
      `  Total AX nodes:   ${totalNodes}`,
      `  Ignored nodes:    ${ignoredCount}`,
      `  Generic nodes:    ${genericCount}`,
      `  With children:    ${withChildrenCount}`,
      `  Iframes:          ${iframeCount}`,
      `  CWD node ID:      ${currentId}`,
      `  CWD role:         ${currentNode?.role?.value ?? "?"}`,
      `  CWD name:         ${currentNode?.name?.value ?? "(none)"}`,
      `  CWD childIds:     ${currentNode?.childIds?.length ?? 0}`,
      `  CWD ignored:      ${currentNode?.ignored ?? false}`,
    ].join("\r\n");
  }

  if (sub === "raw") {
    const currentNode = nodeMap.get(currentId);
    if (!currentNode?.childIds) return "No children";

    const lines: string[] = ["\x1b[1;36m--- Raw Children ---\x1b[0m"];
    for (const childId of currentNode.childIds.slice(0, 30)) {
      const child = nodeMap.get(childId);
      if (!child) {
        lines.push(`  \x1b[31m${childId}: NOT IN MAP\x1b[0m`);
        continue;
      }
      const role = child.role?.value ?? "?";
      const name = child.name?.value ?? "";
      const ign = child.ignored ? " \x1b[31m[IGNORED]\x1b[0m" : "";
      const nChildren = child.childIds?.length ?? 0;
      lines.push(`  ${childId}: ${role} "${name}" (${nChildren} children)${ign}`);
    }
    if ((currentNode.childIds?.length ?? 0) > 30) {
      lines.push(`  \x1b[90m... and ${currentNode.childIds!.length - 30} more\x1b[0m`);
    }
    return lines.join("\r\n");
  }

  if (sub === "node") {
    const nodeId = args[1];
    if (!nodeId) return "\x1b[31mUsage: debug node <nodeId>\x1b[0m";
    const node = nodeMap.get(nodeId);
    if (!node) return `\x1b[31mNode ${nodeId} not found\x1b[0m`;

    return [
      `\x1b[1;36m--- Node ${nodeId} ---\x1b[0m`,
      `  role:     ${node.role?.value ?? "?"}`,
      `  name:     ${node.name?.value ?? "(none)"}`,
      `  ignored:  ${node.ignored ?? false}`,
      `  backend:  ${node.backendDOMNodeId ?? "none"}`,
      `  children: ${node.childIds?.length ?? 0} [${(node.childIds ?? []).slice(0, 5).join(", ")}${(node.childIds?.length ?? 0) > 5 ? "..." : ""}]`,
    ].join("\r\n");
  }

  return COMMAND_HELP["debug"] ?? "debug stats | debug raw | debug node <id>";
}
