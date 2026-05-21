import { CDPClient } from "./cdp_client.ts";
import {
  buildNodeMap,
  findChildByName,
  findRootNode,
  generateNodeName,
  getChildVFSNodes,
  resolveByPath,
} from "./vfs_mapper.ts";
import type { AXNode, ShellState, VFSNode } from "../shared/types.ts";
import { INTERACTIVE_ROLES, ROLE_ALIASES } from "../shared/types.ts";

// ---- State ----

const cdp = new CDPClient();

const state: ShellState = {
  path: [],                // Start at browser root (~)
  axNodeIds: [],           // No DOM context yet
  activeTabId: null,       // No tab attached yet
  env: {
    SHELL: "/bin/domshell",
    TERM: "xterm-256color",
    PS1: "dom@shell:$PWD$ ",
  },
};

let nodeMap: Map<string, AXNode> = new Map();
let treeStale = false;
let commandHistory: string[] = [];
let bookmarks: Record<string, string[]> = {};
let scripts: Record<string, string[]> = {};

// ---- Tab-group session state (PRD-001 / ADR-001) ----
type GroupMode = "shared" | "isolated";
let groupMode: GroupMode = "shared";
let sessionGroupId: number | null = null;
let createdGroupIds = new Set<number>();  // groups DOMShell created (ADR-001 D6)
let createdTabIds = new Set<number>();    // tabs DOMShell opened (non-destructive close, ADR-001 D7)
let sessionGroupDisrupted = false;        // session group removed externally (ADR-001 D7)
let groupSeq = 0;                         // disambiguates default group names
let sessionGroupName: string | null = null; // attached group's display name (prompt host)
let mcpSessionActive = false;             // an MCP session created the current group (ADR-001 D3)

/** Lazy cache for visible text (innerText), keyed by backendDOMNodeId. Cleared on tree rebuild. */
let textContentCache: Map<number, string> = new Map();

/** Get innerText with caching — avoids repeated CDP calls for the same node within one tree lifecycle. */
async function getCachedInnerText(backendDOMNodeId: number): Promise<string> {
  const cached = textContentCache.get(backendDOMNodeId);
  if (cached !== undefined) return cached;
  try {
    const text = await cdp.getInnerText(backendDOMNodeId);
    textContentCache.set(backendDOMNodeId, text);
    return text;
  } catch {
    textContentCache.set(backendDOMNodeId, "");
    return "";
  }
}

// Snapshot for diff: saved before write/navigate commands
interface SnapshotEntry { role: string; name: string; value?: string; childCount: number }
let previousSnapshot: Map<string, SnapshotEntry> | null = null;

function captureSnapshot(): Map<string, SnapshotEntry> {
  const snap = new Map<string, SnapshotEntry>();
  for (const [id, node] of nodeMap) {
    const vfsChildren = getChildVFSNodes(id, nodeMap);
    const name = generateNodeName(node, nodeMap);
    snap.set(id, {
      role: node.role || "unknown",
      name,
      value: node.name || node.value?.value || undefined,
      childCount: vfsChildren.length,
    });
  }
  return snap;
}

const WRITE_NAVIGATE_COMMANDS = new Set([
  "click", "type", "submit", "select", "navigate", "goto", "open", "back", "forward", "scroll",
]);

/** Persist shell state to chrome.storage.local for service worker restart resilience. */
function persistState(): void {
  chrome.storage.local.set({
    domshell_path: state.path,
    domshell_env: state.env,
    domshell_bookmarks: bookmarks,
    domshell_scripts: scripts,
    domshell_history: commandHistory.slice(-500),
    domshell_group: {
      mode: groupMode,
      groupId: sessionGroupId,
      groupName: sessionGroupName,
      createdGroupIds: [...createdGroupIds],
      createdTabIds: [...createdTabIds],
    },
  });
}

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

/** Expand path variables like %here% and @bookmark to concrete paths. */
async function expandPathVariable(target: string): Promise<string> {
  // Expand @name bookmark references
  if (target.startsWith("@")) {
    const slashIdx = target.indexOf("/");
    const name = slashIdx === -1 ? target.slice(1) : target.slice(1, slashIdx);
    const rest = slashIdx === -1 ? "" : target.slice(slashIdx);
    if (!name) throw new Error("bookmark: empty name after @");
    const saved = bookmarks[name];
    if (!saved) throw new Error(`bookmark: '@${name}' not found. Use 'bookmark' to list saved bookmarks.`);
    return "~/" + saved.join("/") + rest;
  }

  if (!target.includes("%here%")) return target;

  const lastFocused = await chrome.windows.getLastFocused({ populate: true });
  const activeTab = lastFocused.tabs?.find(t => t.active);
  if (!activeTab?.id || !lastFocused.id) {
    throw new Error("No active tab found");
  }

  // Expand to window-based path so %here%/.. goes to the window
  const expanded = `~/windows/${lastFocused.id}/${activeTab.id}`;
  return target.replace("%here%", expanded);
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
    // Already attached — just return info.
    const tab = await chrome.tabs.get(tabId);
    // Re-entering a tab via `cd` after `cd ..` clears axNodeIds; restore the DOM
    // root so the next command has a context (fixes spurious "No DOM context").
    if (state.axNodeIds.length === 0) {
      const root = findRootNode(nodeMap);
      state.axNodeIds = root ? [root.nodeId] : [];
    }
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
  textContentCache = new Map();

  const root = findRootNode(nodeMap);
  state.axNodeIds = root ? [root.nodeId] : [];

  // Clear stale flag — we just fetched a fresh tree.
  // CDP events (DOM.documentUpdated) fire during attach and set treeStale=true,
  // but our tree is already up-to-date. Without this, ensureFreshTree() would
  // immediately re-fetch on the next command, and the new AX node IDs may differ,
  // causing a spurious "No DOM context" error.
  treeStale = false;

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
      console.log("[DOMShell] WebSocket connected to MCP server");

      // Capability handshake (ADR-001 D11) — let a grouping-aware MCP server
      // know this extension supports tab groups.
      ws?.send(JSON.stringify({
        type: "HELLO",
        version: chrome.runtime.getManifest().version,
        capabilities: ["grouping"],
      }));

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

        if (msg.type === "SESSION_START") {
          // An MCP session started — give it its own isolated group (ADR-001 D3).
          // `groupMode`/`sessionGroupId` are persisted (chrome.storage), so on a
          // fresh connect we may be restored into a stale "isolated" state whose
          // group was closed between sessions. Create a fresh group when we are
          // shared OR when the restored session group no longer exists.
          let groupAlive = false;
          if (groupMode === "isolated" && sessionGroupId !== null) {
            try {
              await chrome.tabGroups.get(sessionGroupId);
              groupAlive = true;
            } catch {
              groupAlive = false;  // persisted group was closed between sessions
            }
          }
          if (!groupAlive) {
            // Clear stale isolated state so groupNew() doesn't report a phantom
            // "previous group" and starts cleanly.
            groupMode = "shared";
            sessionGroupId = null;
            sessionGroupName = null;
            sessionGroupDisrupted = false;
            await groupNew(["agent"]);
          }
          mcpSessionActive = true;
          return;
        }

        if (msg.type === "SESSION_END") {
          // Non-destructive teardown (PRD-001 Req 7) — detach, leave the group open.
          // Gate on groupMode, not the non-persisted mcpSessionActive flag: a
          // service-worker restart mid-session would otherwise strand the state.
          if (groupMode === "isolated") {
            await groupDetach();
          }
          mcpSessionActive = false;
          return;
        }

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

const KEEPALIVE_ALARM = "domshell-keepalive";

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

// Restore shell state on service worker restart
chrome.storage.local.get(
  ["domshell_path", "domshell_env", "domshell_bookmarks", "domshell_scripts", "domshell_history", "domshell_group"],
  (result) => {
    if (Array.isArray(result.domshell_path)) {
      state.path = result.domshell_path;
      // A path inside a tab needs a live CDP attachment, which does not survive
      // a service-worker restart. Drop such paths to the browser root so the
      // shell always starts somewhere usable — `ls` shows windows/ and tabs/.
      // Browser-level paths (root, tabs/, windows/) restore fine.
      if (getTabIdFromPath(state.path) !== null) {
        state.path = [];
      }
    }
    if (result.domshell_env && typeof result.domshell_env === "object") {
      state.env = { ...state.env, ...result.domshell_env };
    }
    if (result.domshell_bookmarks && typeof result.domshell_bookmarks === "object") {
      bookmarks = result.domshell_bookmarks;
    }
    if (result.domshell_scripts && typeof result.domshell_scripts === "object") {
      scripts = result.domshell_scripts;
    }
    if (Array.isArray(result.domshell_history)) {
      commandHistory = result.domshell_history.slice(-500);
    }
    if (result.domshell_group && typeof result.domshell_group === "object") {
      const g: any = result.domshell_group;
      groupMode = g.mode === "isolated" ? "isolated" : "shared";
      sessionGroupId = typeof g.groupId === "number" ? g.groupId : null;
      sessionGroupName = typeof g.groupName === "string" ? g.groupName : null;
      createdGroupIds = new Set(Array.isArray(g.createdGroupIds) ? g.createdGroupIds : []);
      createdTabIds = new Set(Array.isArray(g.createdTabIds) ? g.createdTabIds : []);
    }
  }
);

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

// ---- Tab-group disruption detection (ADR-001 D7) ----

chrome.tabGroups?.onRemoved?.addListener((group) => {
  createdGroupIds.delete(group.id);
  if (group.id === sessionGroupId) {
    sessionGroupDisrupted = true;
  }
});

// ---- Open Side Panel on Action Click ----

chrome.sidePanel
  ?.setPanelBehavior?.({ openPanelOnActionClick: true })
  ?.catch(() => {});

// ---- Message Router ----

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "domshell") return;

  port.onMessage.addListener(async (msg) => {
    if (msg.type === "STDIN") {
      const output = await executeCommand(msg.input);
      port.postMessage({ type: "STDOUT", output, prompt: currentPrompt() });
    } else if (msg.type === "COMPLETE") {
      const matches = await getCompletions(msg.partial, msg.command, msg.line);
      port.postMessage({ type: "COMPLETE_RESPONSE", matches, partial: msg.partial });
    } else if (msg.type === "READY") {
      await maybeAutoAttach();
      port.postMessage({
        type: "STDOUT",
        output: formatWelcome(),
        prompt: currentPrompt(),
      });
    }
  });
});

// ---- Welcome Banner ----

function formatWelcome(): string {
  return [
    "\x1b[36m\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557\x1b[0m",
    "\x1b[36m\u2551\x1b[0m   \x1b[1;33mDOMShell v1.2.0\x1b[0m                                   \x1b[36m\u2551\x1b[0m",
    "\x1b[36m\u2551\x1b[0m   \x1b[37mThe browser is your filesystem.\x1b[0m                    \x1b[36m\u2551\x1b[0m",
    "\x1b[36m\u2551\x1b[0m   \x1b[90mhttps://github.com/apireno/DOMShell\x1b[0m                \x1b[36m\u2551\x1b[0m",
    "\x1b[36m\u2551\x1b[0m   \x1b[90mBuilt by Pireno | pireno.com\x1b[0m                       \x1b[36m\u2551\x1b[0m",
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

function formatTextPreview(text: string, maxLen: number): string {
  const cleaned = text.trim().replace(/\s+/g, " ");
  if (!cleaned) return "";
  if (cleaned.length > maxLen) {
    return `  \x1b[90m"${cleaned.slice(0, maxLen)}..." (${cleaned.length})\x1b[0m`;
  }
  return `  \x1b[90m"${cleaned}"\x1b[0m`;
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
    "  \x1b[32m--meta\x1b[0m          Include DOM properties (href, src, id, tag) per element",
    "  \x1b[32m--text\x1b[0m          Show visible text preview per element (uses innerText)",
    "  \x1b[32m--textlen N\x1b[0m     Max chars for text preview (default: 80)",
    "  \x1b[32m-r, --recursive\x1b[0m Show nested children (one level deep)",
    "  \x1b[32m-n N\x1b[0m            Limit output to first N entries",
    "  \x1b[32m--offset N\x1b[0m      Skip first N entries (for pagination)",
    "  \x1b[32m--type ROLE\x1b[0m     Filter by AX role (e.g. --type button)",
    "  \x1b[32m--count\x1b[0m         Show count of children only",
    "  \x1b[32m--after NAME\x1b[0m    Show only children after the named element",
    "  \x1b[32m--before NAME\x1b[0m   Show only children before the named element",
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
    "\x1b[33mSpecial paths:\x1b[0m",
    "  cd ~ or cd /       Go to browser root (windows/tabs level)",
    "",
    "\x1b[33mBrowser paths:\x1b[0m",
    "  cd tabs            Enter the tabs listing",
    "  cd tabs/123        Enter tab 123 (transparent CDP attach)",
    "  cd tabs/github     Switch to first tab matching 'github'",
    "  cd windows         Enter the windows listing",
    "  cd windows/1       Enter window 1's tab listing",
    "",
    "\x1b[33mDOM paths (inside a tab):\x1b[0m",
    "  cd navigation      Enter the 'navigation' container",
    "  cd ..               Go up one level (from DOM root exits to browser level)",
    "  cd main/form       Multi-level path",
    "  cd ../sidebar      Go up then into 'sidebar'",
    "",
    "\x1b[33mPath variables:\x1b[0m",
    "  %here%             Expands to the focused tab (via its window path)",
    "  cd %here%          Enter the active tab",
    "  cd %here%/..       Go to the window containing the active tab",
    "  cd %here%/main     Enter the active tab and cd into main",
  ].join("\r\n"),

  pwd: [
    "\x1b[1;36mpwd\x1b[0m \u2014 Print working directory (unified path)",
    "",
    "\x1b[33mUsage:\x1b[0m pwd",
    "",
    "Shows the full path from browser root, e.g. ~/tabs/123/main/form",
  ].join("\r\n"),

  cat: [
    "\x1b[1;36mcat\x1b[0m \u2014 Read full metadata for a node (AX + DOM properties)",
    "",
    "\x1b[33mUsage:\x1b[0m cat <name>",
    "",
    "Shows AX info (role, type, value) plus real DOM properties:",
    "  tag, href/URL, src, action, id, class, alt, title, placeholder,",
    "  target, name, text content (textContent), visible text (innerText),",
    "  and an outer HTML snippet.",
    "",
    "Accepts a name or relative path (e.g. cat main/article/link_name).",
    "",
    "Use 'cd ..' to navigate to a parent element if you need",
    "its properties (e.g. navigate up from a span to its <a> for href).",
    "",
    "Requires a tab context (cd into a tab first).",
  ].join("\r\n"),

  text: [
    "\x1b[1;36mtext\x1b[0m \u2014 Bulk extract text content from a node and its descendants",
    "",
    "\x1b[33mUsage:\x1b[0m text [name] [-n N]",
    "",
    "\x1b[33mArguments:\x1b[0m",
    "  name         Extract text from a specific child or path (default: current directory)",
    "  -n N         Limit output to first N characters",
    "",
    "Accepts a name or relative path (e.g. text main/article/paragraph).",
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
    "Accepts a name or relative path (e.g. click form/submit_btn).",
    "Resolves the node to a DOM element and triggers a click.",
    "Falls back to coordinate-based click if JS click fails.",
  ].join("\r\n"),

  focus: [
    "\x1b[1;36mfocus\x1b[0m \u2014 Focus an input element",
    "",
    "\x1b[33mUsage:\x1b[0m focus <name>",
    "",
    "Accepts a name or relative path (e.g. focus form/search_input).",
    "Focuses the DOM element. Use before 'type' to direct keyboard input.",
  ].join("\r\n"),

  scroll: [
    "\x1b[1;36mscroll\x1b[0m \u2014 Scroll the page or scroll an element into view",
    "",
    "\x1b[33mUsage:\x1b[0m scroll [down|up] [N] | scroll <element_name>",
    "",
    "\x1b[33mModes:\x1b[0m",
    "  \x1b[32mscroll down\x1b[0m             Scroll page down by 1 viewport height",
    "  \x1b[32mscroll up\x1b[0m               Scroll page up by 1 viewport height",
    "  \x1b[32mscroll down 3\x1b[0m           Scroll page down by 3 viewport heights",
    "  \x1b[32mscroll element_name\x1b[0m     Scroll element into center of viewport",
    "",
    "Returns current scroll position as percentage.",
    "",
    "\x1b[33mExamples:\x1b[0m",
    "  scroll down                    See more content below the fold",
    "  scroll see_also_heading        Jump to a specific section",
    "  find --type heading → scroll target_heading → text",
  ].join("\r\n"),

  js: [
    "\x1b[1;36mjs\x1b[0m \u2014 Execute JavaScript in the tab context",
    "",
    "\x1b[33mUsage:\x1b[0m js <expression>",
    "",
    "Evaluates arbitrary JavaScript in the current tab and returns the result.",
    "Supports async/await (Promises are automatically awaited).",
    "Results are JSON-serialized. Large results are truncated at 10000 chars.",
    "",
    "\x1b[33mExamples:\x1b[0m",
    "  js document.title",
    "  js document.querySelectorAll('a').length",
    "  js [...document.querySelectorAll('h2')].map(h => h.textContent)",
    "  js document.querySelector('.score').innerText",
    "  js fetch('/api/data').then(r => r.json())",
  ].join("\r\n"),

  back: [
    "\x1b[1;36mback\x1b[0m \u2014 Navigate back in browser history",
    "",
    "\x1b[33mUsage:\x1b[0m back",
    "",
    "Goes to the previous page in the tab's browser history.",
    "Equivalent to clicking the browser back button.",
    "Automatically refreshes the AX tree after navigation.",
    "",
    "\x1b[33mExample:\x1b[0m",
    "  open wikipedia.org/wiki/AI → navigate to ML → back (returns to AI)",
  ].join("\r\n"),

  forward: [
    "\x1b[1;36mforward\x1b[0m \u2014 Navigate forward in browser history",
    "",
    "\x1b[33mUsage:\x1b[0m forward",
    "",
    "Goes to the next page in the tab's browser history.",
    "Only works after a 'back' command.",
  ].join("\r\n"),

  close: [
    "\x1b[1;36mclose\x1b[0m \u2014 Close a tab",
    "",
    "\x1b[33mUsage:\x1b[0m close [tab-id]",
    "",
    "Closes the current tab (no args) or a specific tab by ID.",
    "After closing, returns to the browser root.",
    "",
    "\x1b[33mExamples:\x1b[0m",
    "  close           Close the current tab",
    "  close 12345     Close tab with ID 12345",
  ].join("\r\n"),

  screenshot: [
    "\x1b[1;36mscreenshot\x1b[0m \u2014 Capture a screenshot of the current tab",
    "",
    "\x1b[33mUsage:\x1b[0m screenshot",
    "",
    "Captures a PNG screenshot of the visible tab content.",
    "Returns the image for visual inspection.",
    "Useful for understanding page layout on unfamiliar sites.",
  ].join("\r\n"),

  select: [
    "\x1b[1;36mselect\x1b[0m \u2014 Select an option from a <select> dropdown",
    "",
    "\x1b[33mUsage:\x1b[0m select <name> <value>",
    "",
    "Selects an option from a dropdown by value or visible text.",
    "Matches by value attribute first, then by option text (case-insensitive).",
    "Dispatches change and input events to trigger form updates.",
    "",
    "\x1b[33mExamples:\x1b[0m",
    "  select language_select en           Select by value",
    "  select country_dropdown United States   Select by text",
  ].join("\r\n"),

  wait: [
    "\x1b[1;36mwait\x1b[0m \u2014 Wait for an element to appear in the AX tree",
    "",
    "\x1b[33mUsage:\x1b[0m wait <pattern> [--type role] [--timeout N]",
    "",
    "Polls the AX tree until an element matching the pattern appears.",
    "Default timeout: 5 seconds. Maximum: 30 seconds.",
    "Useful after clicks or navigation that trigger async content loading.",
    "",
    "\x1b[33mExamples:\x1b[0m",
    "  wait results                        Wait for 'results' to appear",
    "  wait submit_btn --type button        Wait for a specific button",
    "  wait loading --timeout 10            Wait up to 10 seconds",
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

  submit: [
    "\x1b[1;36msubmit\x1b[0m \u2014 Atomic form submission (focus + clear + type + submit)",
    "",
    "\x1b[33mUsage:\x1b[0m submit <input_name> <value> [--submit button_name]",
    "",
    "Accepts names or relative paths for input and button.",
    "Focuses the input, clears existing value, types the new value,",
    "then either clicks the submit button or presses Enter.",
    "",
    "\x1b[33mExamples:\x1b[0m",
    "  submit search_input machine learning",
    "  submit search_input machine learning --submit search_btn",
  ].join("\r\n"),

  extract_links: [
    "\x1b[1;36mextract_links\x1b[0m \u2014 Extract all links as [text](url) format",
    "",
    "\x1b[33mUsage:\x1b[0m extract_links [element_name] [-n limit]",
    "",
    "Accepts a name or relative path (e.g. extract_links main/sidebar).",
    "Recursively finds all link elements and returns their",
    "display text and URLs in markdown link format.",
    "",
    "\x1b[33mExamples:\x1b[0m",
    "  extract_links              All links under current directory",
    "  extract_links main -n 20   First 20 links in main section",
  ].join("\r\n"),

  extract_table: [
    "\x1b[1;36mextract_table\x1b[0m \u2014 Extract table as markdown or CSV",
    "",
    "\x1b[33mUsage:\x1b[0m extract_table <table_name> [--format markdown|csv] [-n limit]",
    "",
    "Accepts a name or relative path (e.g. extract_table main/table_1234).",
    "Reads all rows and cells of a table element and returns",
    "structured output. First row is treated as the header.",
    "",
    "\x1b[33mExamples:\x1b[0m",
    "  extract_table table_1234",
    "  extract_table table_1234 --format csv",
    "  extract_table table_1234 -n 10",
  ].join("\r\n"),

  grep: [
    "\x1b[1;36mgrep\x1b[0m \u2014 Search children for matching names (section discovery tool)",
    "",
    "\x1b[33mUsage:\x1b[0m grep [options] <pattern>",
    "",
    "\x1b[33mOptions:\x1b[0m",
    "  \x1b[32m-r, --recursive\x1b[0m  Search all descendants recursively (recommended)",
    "  \x1b[32m--content\x1b[0m        Also match against visible text content (slower)",
    "  \x1b[32m-n N\x1b[0m             Limit results to first N matches",
    "",
    "Matches against name, role, and value. Case-insensitive.",
    "Use --content to also match against the element's displayed text.",
    "",
    "\x1b[33mWorkflow chains (grep \u2192 cd \u2192 extract):\x1b[0m",
    "  grep -r article   \u2192  cd article/      \u2192  text",
    "  grep -r references \u2192  cd references/  \u2192  find --type link --meta",
    "  grep -r table     \u2192  extract_table table_1234",
    "  grep -r heading   \u2192  cd target_section/ \u2192  text",
    "",
    "grep tells you WHERE things are. cd + text/find gets the content.",
    "",
    "\x1b[33mPipe support:\x1b[0m",
    "  find --type link --meta | grep login     Filter find results",
    "  ls --text | grep keyword                 Filter ls output",
    "  text | grep pattern                      Search within text output",
  ].join("\r\n"),

  find: [
    "\x1b[1;36mfind\x1b[0m \u2014 Deep recursive search with full paths",
    "",
    "\x1b[33mUsage:\x1b[0m find [options] <pattern>",
    "",
    "\x1b[33mOptions:\x1b[0m",
    "  \x1b[32m--type ROLE\x1b[0m   Filter by AX role (e.g. --type combobox)",
    "  \x1b[32m--meta\x1b[0m        Include DOM properties (href, src, id, tag) per result",
    "  \x1b[32m--text\x1b[0m        Show visible text preview per result (uses innerText)",
    "  \x1b[32m--textlen N\x1b[0m   Max chars for text preview (default: 80)",
    "  \x1b[32m--content\x1b[0m     Also match against visible text content (slower)",
    "  \x1b[32m-n N\x1b[0m          Limit to first N results",
    "",
    "Searches the entire tree from CWD down. Shows the full path.",
    "Use --meta with --type link to find all URLs on a page.",
    "Use --content to find elements by their displayed text (e.g. find 'see also' --content).",
    "",
    "When --text is used with a pattern, also matches against visible text content.",
    "  find --type link --text login --meta    Find links with 'login' text + show hrefs",
  ].join("\r\n"),

  tree: [
    "\x1b[1;36mtree\x1b[0m \u2014 Show a tree view of the current node",
    "",
    "\x1b[33mUsage:\x1b[0m tree [depth]",
    "",
    "\x1b[33mArguments:\x1b[0m",
    "  depth    Max depth to display (default: 2)",
  ].join("\r\n"),

  group: [
    "\x1b[1;36mgroup\x1b[0m \u2014 Tab-group session isolation (PRD-001)",
    "",
    "\x1b[33mUsage:\x1b[0m group [new|attach|detach|close|list]",
    "",
    "\x1b[33mSubcommands:\x1b[0m",
    "  \x1b[32mgroup\x1b[0m                Show the current grouping mode and group",
    "  \x1b[32mgroup new [name]\x1b[0m     Create an isolated tab group and work inside it",
    "  \x1b[32mgroup attach <id>\x1b[0m    Bind to an existing DOMShell-created group",
    "  \x1b[32mgroup detach\x1b[0m         Leave the group; return to shared mode",
    "  \x1b[32mgroup close [id]\x1b[0m     Close a group's DOMShell tabs (user tabs kept)",
    "  \x1b[32mgroup list\x1b[0m           List DOMShell-created groups",
    "",
    "In an isolated group every command is confined to that group's tabs,",
    "so you can keep browsing freely in other tabs. Shared mode is the",
    "default and behaves exactly as before.",
  ].join("\r\n"),

  groups: [
    "\x1b[1;36mgroups\x1b[0m — alias for 'group list' (list DOMShell-created groups).",
    "",
    "See 'group --help' for the full tab-group command.",
  ].join("\r\n"),

  read: [
    "\x1b[1;36mread\x1b[0m \u2014 Structured subtree extraction (tree + content in one call)",
    "",
    "\x1b[33mUsage:\x1b[0m read [name] [options]",
    "",
    "\x1b[33mOptions:\x1b[0m",
    "  \x1b[32m-d N\x1b[0m          Max depth to traverse (default: 5)",
    "  \x1b[32m-n N\x1b[0m          Max total elements to return",
    "  \x1b[32m--meta\x1b[0m        Include DOM properties (href, src, id) per element",
    "  \x1b[32m--text\x1b[0m        Include visible text preview per element",
    "  \x1b[32m--textlen N\x1b[0m   Max chars for text preview (default: 120)",
    "",
    "Accepts a name or relative path (e.g. read main/article).",
    "Returns the hierarchy of elements with roles, names, and values.",
    "Excellent for tables, lists, and nested sections — get structure",
    "AND content in one call instead of multiple text/cat calls.",
    "",
    "\x1b[33mExamples:\x1b[0m",
    "  read table_1234          Read entire table structure with values",
    "  read list_5678 --meta    Read list with href/src/id properties",
    "  read -d 3                Read current directory, 3 levels deep",
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
    "  open https://github.com/apireno/DOMShell",
  ].join("\r\n"),

  connect: [
    "\x1b[1;36mconnect\x1b[0m \u2014 Connect to a DOMShell MCP server via WebSocket",
    "",
    "\x1b[33mUsage:\x1b[0m connect <token>",
    "",
    "Establishes a WebSocket bridge to the MCP server, allowing",
    "AI assistants like Claude Desktop to control the browser.",
    "",
    "\x1b[33mSetup:\x1b[0m",
    "  1. Start the MCP server:  cd mcp-server && npx tsx index.ts",
    "  2. Copy the auth token from the server output",
    "  3. In DOMShell:  connect <token>",
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

  head: [
    "\x1b[1;36mhead\x1b[0m \u2014 Show first N lines (pipe consumer only)",
    "",
    "\x1b[33mUsage:\x1b[0m command | head -n N",
    "",
    "Only works as a pipe consumer. Shows the first N lines of piped output.",
    "Default: 10 lines.",
    "",
    "\x1b[33mExamples:\x1b[0m",
    "  find --type heading | head -n 5     First 5 headings",
    "  ls --text | head -n 3               First 3 children with text",
  ].join("\r\n"),

  history: [
    "\x1b[1;36mhistory\x1b[0m \u2014 Show command history",
    "",
    "\x1b[33mUsage:\x1b[0m history [-n N] | history clear",
    "",
    "Shows the last N commands executed (default: 20).",
    "Use !N to re-execute command number N from history.",
    "",
    "\x1b[33mExamples:\x1b[0m",
    "  history                Show last 20 commands",
    "  history -n 50          Show last 50 commands",
    "  history clear          Clear all history",
    "  !5                     Re-run command #5",
  ].join("\r\n"),

  diff: [
    "\x1b[1;36mdiff\x1b[0m \u2014 Compare AX tree against pre-action snapshot",
    "",
    "\x1b[33mUsage:\x1b[0m diff [--json]",
    "",
    "Shows what changed since the last write/navigate command (click, type, submit,",
    "select, navigate, open, back, forward, scroll). A snapshot is automatically",
    "saved before each of these commands.",
    "",
    "Reports added (+), removed (-), and changed (~) nodes.",
    "",
    "\x1b[33mFlags:\x1b[0m",
    "  --json    Output as JSON for machine parsing",
    "",
    "\x1b[33mExamples:\x1b[0m",
    "  click search_btn → diff    See what appeared after clicking",
    "  submit form value → diff   See form submission results",
  ].join("\r\n"),

  eval: [
    "\x1b[1;36meval\x1b[0m \u2014 Evaluate a JavaScript expression (read-only)",
    "",
    "\x1b[33mUsage:\x1b[0m eval <expression>",
    "",
    "Evaluates a JavaScript expression in the tab context and returns the result.",
    "Functionally identical to 'js' but classified as a read-tier command in MCP,",
    "so it works without --allow-write. Use for read-only queries.",
    "",
    "\x1b[33mExamples:\x1b[0m",
    "  eval document.title",
    "  eval window.location.href",
    "  eval document.querySelectorAll('a').length",
    "  eval [...document.querySelectorAll('h2')].map(h => h.textContent)",
  ].join("\r\n"),

  functions: [
    "\x1b[1;36mfunctions\x1b[0m \u2014 List callable global JavaScript functions on the page",
    "",
    "\x1b[33mUsage:\x1b[0m functions [pattern] [--json]",
    "",
    "Enumerates all own-property functions on `window` with name, arity, and params.",
    "",
    "\x1b[33mOptions:\x1b[0m",
    "  \x1b[32mpattern\x1b[0m    Filter by name substring",
    "  \x1b[32m--json\x1b[0m     Output as JSON array",
    "",
    "\x1b[33mExamples:\x1b[0m",
    "  functions                List all page functions",
    "  functions fetch          Filter to names containing 'fetch'",
    "  functions --json         Machine-readable output",
  ].join("\r\n"),

  call: [
    "\x1b[1;36mcall\x1b[0m \u2014 Call a global JavaScript function by name",
    "",
    "\x1b[33mUsage:\x1b[0m call <functionName> [arg1] [arg2] ...",
    "",
    "Calls window[functionName](args). Arguments are auto-parsed:",
    "  - Valid JSON literals (numbers, booleans, null, objects) stay as-is",
    "  - Everything else is passed as a string",
    "Supports async functions (awaits the result).",
    "",
    "\x1b[33mExamples:\x1b[0m",
    "  call alert hello              Call alert('hello')",
    "  call scrollTo 0 500           Call scrollTo(0, 500)",
    "  call fetch /api/status        Call fetch('/api/status')",
    "",
    "\x1b[33mSecurity:\x1b[0m Write-tier command (requires --allow-write in MCP).",
  ].join("\r\n"),

  watch: [
    "\x1b[1;36mwatch\x1b[0m \u2014 Periodically re-execute a command",
    "",
    "\x1b[33mUsage:\x1b[0m watch <command> [--interval N] [--times N] [--until-change]",
    "",
    "Re-runs the given command at regular intervals. Useful for monitoring changes.",
    "",
    "\x1b[33mOptions:\x1b[0m",
    "  \x1b[32m--interval N\x1b[0m      Seconds between runs (default: 2, min: 0.5)",
    "  \x1b[32m--times N\x1b[0m         Number of iterations (default: 5, max: 100)",
    "  \x1b[32m--until-change\x1b[0m    Stop when output differs from previous iteration",
    "",
    "With --until-change, default iterations increase to 20 (expects early exit).",
    "Total runtime capped at 120 seconds.",
    "",
    "\x1b[33mExamples:\x1b[0m",
    "  watch ls --times 3 --interval 1       List children 3 times, 1s apart",
    "  watch \"eval document.title\" --until-change --interval 1",
  ].join("\r\n"),

  for: [
    "\x1b[1;36mfor\x1b[0m \u2014 Iterate over command output lines",
    "",
    "\x1b[33mUsage:\x1b[0m for <source-cmd> : <action-template>",
    "",
    "Runs <source-cmd>, splits output into lines, and for each line replaces {} in",
    "<action-template> with the line text and executes it.",
    "",
    "Separator is ' : ' (space-colon-space) to avoid conflicts with URL colons.",
    "Source output is cleaned: ANSI codes, [d]/[x] prefixes, (role) suffixes, and",
    "trailing slashes are stripped to produce clean paths for substitution.",
    "Capped at 50 items and 120 seconds total.",
    "",
    "\x1b[33mExamples:\x1b[0m",
    "  for \"find --type heading -n 3\" : text {}    Read text of first 3 headings",
    "  for \"eval [URLs].join('\\\\n')\" : open {}      Open N URLs from JS array",
  ].join("\r\n"),

  script: [
    "\x1b[1;36mscript\x1b[0m \u2014 Save and run multi-command scripts",
    "",
    "\x1b[33mSubcommands:\x1b[0m",
    "  \x1b[32mscript list\x1b[0m                     List saved scripts",
    "  \x1b[32mscript save <name> <cmds>\x1b[0m        Save commands (separated by ' ; ')",
    "  \x1b[32mscript show <name>\x1b[0m               Show commands in a script",
    "  \x1b[32mscript run <name> [arg1] [arg2]\x1b[0m  Execute with variable substitution",
    "  \x1b[32mscript delete <name>\x1b[0m             Delete a script",
    "",
    "\x1b[33mVariable substitution:\x1b[0m",
    "  $1, $2, ... are replaced with positional args passed to 'script run'.",
    "  $0 = script name, $# = number of args.",
    "  If no args passed, $N remain as literal text.",
    "",
    "\x1b[33mIMPORTANT:\x1b[0m Multi-word arguments MUST be quoted with double quotes:",
    "  script run search \"Artificial intelligence\"     \x1b[32m← correct\x1b[0m ($1 = Artificial intelligence)",
    "  script run search Artificial intelligence        \x1b[31m← WRONG\x1b[0m ($1 = Artificial, $2 = intelligence)",
    "",
    "Scripts persist across service worker restarts.",
    "Total runtime for 'script run' capped at 120 seconds.",
    "",
    "\x1b[33mExamples:\x1b[0m",
    "  script save search open https://en.wikipedia.org ; submit search_input $1",
    "  script run search \"machine learning\"",
    "  script run search \"deep learning\"",
  ].join("\r\n"),

  each: [
    "\x1b[1;36meach\x1b[0m \u2014 Run a command across multiple tabs",
    "",
    "\x1b[33mUsage:\x1b[0m each [--pattern FILTER] [--limit N] <command>",
    "",
    "Iterates over all non-chrome tabs (optionally filtered by title/URL pattern),",
    "switches into each, runs the command, and collects results.",
    "Restores the original tab when done.",
    "",
    "\x1b[33mOptions:\x1b[0m",
    "  \x1b[32m--pattern FILTER\x1b[0m  Only tabs whose title or URL contains FILTER",
    "  \x1b[32m--limit N\x1b[0m         Process at most N matching tabs",
    "",
    "Total runtime capped at 120 seconds.",
    "",
    "\x1b[33mExamples:\x1b[0m",
    "  each text                              Get text of every tab",
    "  each --pattern wiki text                Get text from Wikipedia tabs",
    "  each --pattern wiki --limit 3 eval document.title    First 3 Wikipedia tabs",
  ].join("\r\n"),

  bookmark: [
    "\x1b[1;36mbookmark\x1b[0m \u2014 Save named paths for quick navigation",
    "",
    "\x1b[33mUsage:\x1b[0m bookmark [name] [path] | bookmark --delete <name>",
    "",
    "Save the current directory under a name, then jump back with cd @name.",
    "",
    "\x1b[33mExamples:\x1b[0m",
    "  bookmark                  List all bookmarks",
    "  bookmark inbox             Save current path as 'inbox'",
    "  bookmark inbox ~/tabs/123/main/list   Save explicit path as 'inbox'",
    "  bookmark --delete inbox    Remove the 'inbox' bookmark",
    "  cd @inbox                  Jump to the saved 'inbox' path",
    "",
    "\x1b[33mNotes:\x1b[0m",
    "  Bookmarks persist across service worker restarts via chrome.storage.local.",
    "  Use @name in any cd command, including compound paths: cd @inbox/item_1",
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
    } else if ((a === "-n" || a === "-d" || a === "--offset" || a === "--type" || a === "--textlen" || a === "--format" || a === "--submit" || a === "--after" || a === "--before" || a === "--timeout") && i + 1 < args.length) {
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

function splitOnPipe(input: string): string[] {
  const segments: string[] = [];
  let current = "";
  let inQuote: string | null = null;
  for (const char of input) {
    if (inQuote) {
      current += char;
      if (char === inQuote) inQuote = null;
    } else if (char === '"' || char === "'") {
      inQuote = char;
      current += char;
    } else if (char === "|") {
      if (current.trim()) segments.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

function grepLines(output: string, pattern: string, limit: number): string {
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const lines = output.split("\r\n").filter(Boolean);
  const matches: string[] = [];
  for (const line of lines) {
    if (stripAnsi(line).toLowerCase().includes(pattern.toLowerCase())) {
      matches.push(line);
      if (limit > 0 && matches.length >= limit) break;
    }
  }
  return matches.length > 0 ? matches.join("\r\n") : "\x1b[90m(no matches)\x1b[0m";
}

async function executeCommand(raw: string): Promise<string> {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  // !n history recall — resolve before anything else
  const bangMatch = trimmed.match(/^!(\d+)$/);
  if (bangMatch) {
    const idx = parseInt(bangMatch[1], 10) - 1;
    if (idx < 0 || idx >= commandHistory.length) {
      return `\x1b[31mhistory: !${bangMatch[1]}: event not found\x1b[0m`;
    }
    const recalled = commandHistory[idx];
    return await executeCommand(recalled);
  }

  // Record command in history (skip history/clear commands and duplicates)
  const spaceIdx = trimmed.indexOf(" ");
  const firstWord = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  if (firstWord !== "history" && firstWord !== "clear") {
    commandHistory.push(trimmed);
    if (commandHistory.length > 500) commandHistory = commandHistory.slice(-500);
    persistState();
  }

  // Special case: 'js' and 'eval' commands get the raw code string — skip pipe
  // splitting and argument parsing which would mangle JavaScript operators
  // (|, ||) and string literals ('quotes', "quotes").
  if (firstWord === "js" || firstWord === "eval") {
    const rawCode = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);
    if (rawCode.trim() === "--help") {
      return COMMAND_HELP[firstWord] ?? `No help available for '${firstWord}'.`;
    }
    return await handleJs(rawCode);
  }

  // Early-intercept: commands that need raw args before pipe splitting
  if (firstWord === "watch") {
    const rawArgs = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);
    if (rawArgs.trim() === "--help") return COMMAND_HELP["watch"] ?? "watch <cmd> [--interval N] [--times N]";
    return await handleWatch(rawArgs);
  }
  if (firstWord === "for") {
    const rawArgs = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);
    if (rawArgs.trim() === "--help") return COMMAND_HELP["for"] ?? "for <source-cmd> : <action-template>";
    return await handleFor(rawArgs);
  }
  if (firstWord === "each") {
    const rawArgs = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);
    if (rawArgs.trim() === "--help") return COMMAND_HELP["each"] ?? "each [--pattern FILTER] <cmd>";
    return await handleEach(rawArgs);
  }
  if (firstWord === "script") {
    const rawArgs = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);
    if (rawArgs.trim() === "--help") return COMMAND_HELP["script"] ?? "script list|save|show|run|delete";
    return await handleScript(rawArgs);
  }

  // Pipe support: split on | and chain outputs
  const pipeSegments = splitOnPipe(trimmed);
  if (pipeSegments.length > 1) {
    let currentOutput = await executeCommand(pipeSegments[0]);
    for (let i = 1; i < pipeSegments.length; i++) {
      const pipeCmd = parseCommandLine(pipeSegments[i]);
      const pipeName = pipeCmd[0]?.toLowerCase();
      const pipeArgs = pipeCmd.slice(1);
      if (pipeName === "grep") {
        const pa = parseArgs(pipeArgs);
        const pattern = pa.positional[0] || "";
        const limit = pa.named["-n"] ? parseInt(pa.named["-n"], 10) : 0;
        if (!pattern) return "\x1b[31mgrep: missing pattern\x1b[0m";
        currentOutput = grepLines(currentOutput, pattern, limit);
      } else if (pipeName === "head") {
        const pa = parseArgs(pipeArgs);
        const n = pa.named["-n"] ? parseInt(pa.named["-n"], 10) : 10;
        const lines = currentOutput.split("\r\n").filter(Boolean);
        currentOutput = lines.slice(0, n).join("\r\n");
      } else {
        return `\x1b[31mPipe: '${pipeName}' not supported as pipe consumer. Use grep or head.\x1b[0m`;
      }
    }
    return currentOutput;
  }

  const parts = parseCommandLine(trimmed);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  // Universal --help check
  if (args.includes("--help")) {
    return COMMAND_HELP[cmd] ?? `No help available for '${cmd}'.`;
  }

  // Auto-snapshot before write/navigate commands for diff
  if (WRITE_NAVIGATE_COMMANDS.has(cmd) && isInsideTab() && nodeMap.size > 0) {
    previousSnapshot = captureSnapshot();
  }

  try {
    switch (cmd) {
      case "help":
        return handleHelp();
      case "tabs":
        return await handleTabs();
      case "windows":
        return await handleWindows();
      case "group":
        return await handleGroup(args);
      case "groups":
        return await groupList();
      case "ls":
        return await handleLs(args);
      case "cd": {
        const cdResult = await handleCd(args);
        persistState();
        return cdResult;
      }
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
      case "scroll":
        return await handleScroll(args);
      case "back":
        return await handleBack();
      case "forward":
        return await handleForward();
      case "close":
        return await handleClose(args);
      case "screenshot":
        return await handleScreenshot();
      case "select":
        return await handleSelect(args);
      case "wait":
        return await handleWait(args);
      case "submit":
        return await handleSubmit(args);
      case "extract_links":
        return await handleExtractLinks(args);
      case "extract_table":
        return await handleExtractTable(args);
      case "grep":
        return await handleGrep(args);
      case "find":
        return await handleFind(args);
      case "whoami":
        return await handleWhoami();
      case "history":
        return handleHistory(args);
      case "bookmark":
        return handleBookmark(args);
      case "diff":
        return await handleDiff(args);
      case "functions":
        return await handleFunctions(args);
      case "call":
        return await handleCall(args);
      case "env":
        return handleEnv();
      case "export":
        return handleExport(args);
      case "tree":
        return await handleTree(args);
      case "read":
        return await handleRead(args);
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
        return `\x1b[31mdomshell: ${cmd}: command not found\x1b[0m\r\nType 'help' for available commands. Use '<command> --help' for details.`;
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
    "\x1b[1;36mDOMShell \u2014 The browser is your filesystem\x1b[0m",
    "",
    "Use \x1b[33m<command> --help\x1b[0m for detailed usage of any command.",
    "",
    "\x1b[1;33mBrowser:\x1b[0m",
    "  \x1b[32mtabs\x1b[0m               List all open browser tabs",
    "  \x1b[32mwindows\x1b[0m            List all browser windows with their tabs",
    "  \x1b[32mhere\x1b[0m               Jump to the active tab in the focused window",
    "  \x1b[32mcd tabs/<id>\x1b[0m       Enter a tab (by ID or name pattern)",
    "  \x1b[32mcd %here%\x1b[0m          Enter the focused tab (composable: %here%/.., %here%/main)",
    "  \x1b[32mcd ~\x1b[0m or \x1b[32mcd /\x1b[0m       Go to browser root",
    "  \x1b[32mgroup\x1b[0m              Tab-group session: new|attach|detach|close|list",
    "",
    "\x1b[1;33mNavigation:\x1b[0m",
    "  \x1b[32mnavigate <url>\x1b[0m     Navigate the current tab to a URL",
    "  \x1b[32mopen <url>\x1b[0m         Open a new tab and enter it",
    "  \x1b[32mback\x1b[0m               Go back in browser history",
    "  \x1b[32mforward\x1b[0m            Go forward in browser history",
    "  \x1b[32mclose [tab-id]\x1b[0m     Close the current tab or a specific tab",
    "  \x1b[32mrefresh\x1b[0m            Re-fetch the Accessibility Tree",
    "  \x1b[32mscroll down|up [N]\x1b[0m  Scroll page or \x1b[32mscroll <name>\x1b[0m to scroll element into view",
    "  \x1b[32mls\x1b[0m                 List children (\x1b[90m--meta --text --type --after\x1b[0m)",
    "  \x1b[32mcd <name>\x1b[0m          Enter a child node",
    "  \x1b[32mpwd\x1b[0m                Show current path",
    "  \x1b[32mtree [depth]\x1b[0m       Show tree view of current node",
    "",
    "\x1b[1;33mInspection:\x1b[0m",
    "  \x1b[32mcat <name>\x1b[0m         Read metadata and text content of a node",
    "  \x1b[32mtext [name]\x1b[0m        Bulk extract text (\x1b[90m--links\x1b[0m for inline URLs)",
    "  \x1b[32mread [name]\x1b[0m        Structured subtree extraction (\x1b[90m--meta --text\x1b[0m)",
    "  \x1b[32mgrep <pattern>\x1b[0m     Search children for matching names (\x1b[90m-r\x1b[0m for recursive)",
    "  \x1b[32mfind <pattern>\x1b[0m     Deep recursive search (\x1b[90m--type --meta --text\x1b[0m)",
    "  \x1b[32mextract_links\x1b[0m      Extract all links as [text](url) format",
    "  \x1b[32mextract_table\x1b[0m      Extract a table as markdown or CSV",
    "  \x1b[32mscreenshot\x1b[0m         Capture a screenshot of the current tab",
    "  \x1b[32mwait <pattern>\x1b[0m     Wait for an element to appear (\x1b[90m--timeout N\x1b[0m)",
    "  \x1b[32mdiff\x1b[0m               Compare tree against pre-action snapshot (\x1b[90m--json\x1b[0m)",
    "",
    "\x1b[1;33mInteraction:\x1b[0m",
    "  \x1b[32mclick <name>\x1b[0m       Click an element",
    "  \x1b[32mfocus <name>\x1b[0m       Focus an input element",
    "  \x1b[32mtype <text>\x1b[0m        Type text into the focused element",
    "  \x1b[32msubmit <input> <val>\x1b[0m  Atomic form fill + submit",
    "  \x1b[32mselect <name> <val>\x1b[0m   Select an option from a dropdown",
    "  \x1b[32mjs <code>\x1b[0m          Execute JavaScript in the tab context",
    "  \x1b[32meval <expr>\x1b[0m        Evaluate a JS expression (read-only, no --allow-write needed)",
    "",
    "\x1b[1;33mPipes:\x1b[0m",
    "  \x1b[32mfind --type link --meta | grep github\x1b[0m   Filter output with grep",
    "  \x1b[32mls --text | head -n 5\x1b[0m                  Limit output lines",
    "",
    "\x1b[1;33mAutomation:\x1b[0m",
    "  \x1b[32mwatch <cmd>\x1b[0m        Re-run a command periodically (\x1b[90m--interval N --times N --until-change\x1b[0m)",
    "  \x1b[32mfor <src> : <tpl>\x1b[0m  Iterate over output lines, {} = each line",
    "  \x1b[32mscript save|run\x1b[0m    Save and run multi-command scripts (\x1b[90mlist, show, delete\x1b[0m)",
    "  \x1b[32meach [--pattern] [--limit N] <cmd>\x1b[0m  Run a command across multiple tabs",
    "  \x1b[32mfunctions [pat]\x1b[0m    List callable page functions (\x1b[90m--json\x1b[0m)",
    "  \x1b[32mcall <fn> [args]\x1b[0m   Call a global JS function by name",
    "",
    "\x1b[1;33mSystem:\x1b[0m",
    "  \x1b[32mwhoami\x1b[0m             Check authentication cookies",
    "  \x1b[32menv\x1b[0m                Show environment variables",
    "  \x1b[32mexport K=V\x1b[0m         Set an environment variable",
    "  \x1b[32mhistory\x1b[0m            Show command history (\x1b[90m-n N\x1b[0m, \x1b[90mclear\x1b[0m, \x1b[90m!N\x1b[0m to recall)",
    "  \x1b[32mbookmark [name]\x1b[0m    Save/list named paths (\x1b[90mcd @name\x1b[0m to jump back)",
    "  \x1b[32mdebug\x1b[0m              Inspect raw AX tree data",
    "  \x1b[32mclear\x1b[0m              Clear the terminal",
    "",
    "\x1b[1;33mMCP Bridge:\x1b[0m",
    "  \x1b[32mconnect <token>\x1b[0m    Connect to an MCP server (WebSocket)",
    "  \x1b[32mdisconnect\x1b[0m         Disconnect from the MCP server",
    "",
    "\x1b[90mType prefixes: [d]=directory [x]=interactive [-]=static\x1b[0m",
    "",
    "\x1b[90mhttps://github.com/apireno/DOMShell\x1b[0m",
    "",
  ].join("\r\n");
}

// ---- refresh ----

async function handleRefresh(): Promise<string> {
  ensureInsideTab();

  const axNodes = await cdp.getAllFrameAXTrees();
  nodeMap = buildNodeMap(axNodes);
  textContentCache = new Map();

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
  textContentCache = new Map();

  // Check if current AX node still exists in the new tree
  const currentId = state.axNodeIds[state.axNodeIds.length - 1];
  if (!currentId || !nodeMap.has(currentId)) {
    // CWD is gone — page navigated or node IDs changed, reset to root
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
  "tree", "read", "debug", "clear", "navigate", "goto", "open", "connect", "disconnect", "text",
  "submit", "extract_links", "extract_table", "scroll", "js", "eval",
  "back", "forward", "close", "screenshot", "select", "wait", "history", "diff", "bookmark",
  "functions", "call", "watch", "for", "script", "each",
];

/** A completion carries a `value` (inserted into the line) and a `label` (shown in the list). */
interface Completion { value: string; label: string; }
const cmpl = (value: string, label?: string): Completion => ({ value, label: label ?? value });

/** Tab-id completions (value = id, label = "id  title") from a tab list, group-scoped. */
function tabCompletions(tabs: chrome.tabs.Tab[], partial: string): Completion[] {
  const out: Completion[] = [];
  for (const t of tabs) {
    if (!tabInScope(t)) continue;
    const idStr = String(t.id ?? "");
    if (idStr && idStr.startsWith(partial)) {
      out.push(cmpl(idStr, `${idStr}  ${(t.title ?? "untitled").slice(0, 50)}`));
    }
  }
  return out;
}

async function getCompletions(partial: string, command: string, line: string = ""): Promise<Completion[]> {
  // If no command yet (completing the command name itself)
  if (!command || command === partial) {
    const lower = partial.toLowerCase();
    return COMMANDS.filter((c) => c.startsWith(lower)).map((c) => cmpl(c));
  }

  // group: complete subcommands, and group targets for `attach` / `close`
  if (command === "group") {
    const parts = line.split(/\s+/);
    const sub = (parts[1] ?? "").toLowerCase();
    // "group <partial>" — complete the subcommand
    if (parts.length <= 2 && (parts[1] ?? "") === partial) {
      return ["new", "attach", "detach", "close", "list"]
        .filter((s) => s.startsWith(partial.toLowerCase()))
        .map((s) => cmpl(s));
    }
    // "group attach <partial>" / "group close <partial>" — complete a group
    if (sub === "attach" || sub === "close") {
      try {
        const groups = await chrome.tabGroups.query({});
        const lower = partial.toLowerCase();
        const out: Completion[] = [];
        for (const g of groups) {
          const idStr = String(g.id);
          const name = cleanGroupName(g.title);
          if (idStr.startsWith(partial) || name.toLowerCase().startsWith(lower)) {
            out.push(cmpl(idStr, `${idStr}  ${g.title ?? "(untitled)"}`));
          }
        }
        return out;
      } catch {
        return [];
      }
    }
    return [];
  }

  // Path variable completion for cd
  if (command === "cd" && partial.startsWith("%")) {
    return ["%here%"].filter((v) => v.startsWith(partial)).map((v) => cmpl(v));
  }

  // For cd at browser level
  if (command === "cd" && !isInsideTab()) {
    const lower = partial.toLowerCase();
    if (state.path.length === 0) {
      // At ~: complete "tabs" or "windows"
      return ["tabs/", "windows/"].filter((c) => c.toLowerCase().startsWith(lower)).map((c) => cmpl(c));
    }
    try {
      const wins = await chrome.windows.getAll({ populate: true });
      // At ~/tabs: complete tab IDs across all windows, scoped to the attached group.
      if (state.path[0] === "tabs") {
        const all: chrome.tabs.Tab[] = [];
        for (const w of wins) for (const t of w.tabs ?? []) all.push(t);
        return tabCompletions(all, partial);
      }
      // At ~/windows: complete window IDs (only windows with in-scope tabs).
      if (state.path[0] === "windows" && state.path.length === 1) {
        const out: Completion[] = [];
        for (const w of wins) {
          const scoped = (w.tabs ?? []).filter(tabInScope);
          if (scoped.length === 0) continue;
          const idStr = String(w.id ?? "");
          if (idStr && idStr.startsWith(partial)) {
            out.push(cmpl(idStr, `${idStr}  ${scoped.length} tab${scoped.length === 1 ? "" : "s"}${w.focused ? " (focused)" : ""}`));
          }
        }
        return out;
      }
      // At ~/windows/<id>: complete tab IDs in that window, scoped to the group.
      if (state.path[0] === "windows" && state.path.length === 2) {
        const win = wins.find((w) => w.id === parseInt(state.path[1], 10));
        return tabCompletions(win?.tabs ?? [], partial);
      }
    } catch {
      return [];
    }
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

    return matches.map((m) => cmpl(m.name + (m.isDirectory ? "/" : "")));
  } catch {
    return [];
  }
}

// ---- ls ----

async function handleLs(args: string[]): Promise<string> {
  const pa = parseArgs(args);
  const jsonMode = pa.flags.has("--json");

  // Check for explicit ~ path argument
  if (pa.positional.length > 0 && pa.positional[0].startsWith("~")) {
    const afterTilde = pa.positional[0].slice(1).replace(/^\//, "");
    const browserPath = afterTilde ? afterTilde.split("/").filter(Boolean) : [];
    if (jsonMode) return await listBrowserLevelJson(browserPath);
    return await listBrowserLevel(browserPath);
  }

  // If not inside a tab, route to browser-level listing
  if (!isInsideTab()) {
    // Resolve relative browser-level paths
    if (pa.positional.length > 0) {
      const relPath = pa.positional[0].split("/").filter(Boolean);
      const fullPath = [...state.path, ...relPath];
      if (jsonMode) return await listBrowserLevelJson(fullPath);
      return await listBrowserLevel(fullPath);
    }
    if (jsonMode) return await listBrowserLevelJson(state.path);
    return await listBrowserLevel(state.path);
  }

  // DOM-level listing
  ensureInsideTab();
  const refreshMsg = await ensureFreshTree();

  const longFormat = pa.flags.has("-l");
  const showMeta = pa.flags.has("--meta");
  const showText = pa.flags.has("--text");
  const textLen = pa.named["--textlen"] ? parseInt(pa.named["--textlen"], 10) : 80;
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

  // Sibling filter: --after and --before (applied before type filter so landmarks are findable)
  const afterName = pa.named["--after"];
  const beforeName = pa.named["--before"];
  if (afterName) {
    const idx = children.findIndex((c) => c.name === afterName);
    if (idx === -1) return `\x1b[31mls: --after ${afterName}: No such child element\x1b[0m`;
    children = children.slice(idx + 1);
  }
  if (beforeName) {
    const idx = children.findIndex((c) => c.name === beforeName);
    if (idx === -1) return `\x1b[31mls: --before ${beforeName}: No such child element\x1b[0m`;
    children = children.slice(0, idx);
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
    if (jsonMode) return JSON.stringify({ children: [] });
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

  // JSON output mode
  if (jsonMode) {
    const items: any[] = [];
    for (const child of children) {
      const item: any = {
        name: child.name,
        role: child.role,
        type: child.isDirectory ? "directory" : INTERACTIVE_ROLES.has(child.role) ? "interactive" : "static",
      };
      if (child.value) item.value = child.value;
      if (showMeta && child.backendDOMNodeId) {
        try {
          const props = await cdp.getElementProperties(child.backendDOMNodeId);
          if (props.href) item.href = props.href;
          if (props.src) item.src = props.src;
          if (props.id) item.id = props.id;
          if (props.tag) item.tag = props.tag;
        } catch { /* stale node */ }
      }
      if (showText && child.backendDOMNodeId) {
        try {
          item.text = await cdp.getInnerText(child.backendDOMNodeId);
        } catch { /* stale node */ }
      }
      items.push(item);
    }
    return JSON.stringify({ children: items, total, offset, limit: limit || undefined });
  }

  const lines: string[] = [];

  for (const child of children) {
    const tp = typePrefix(child);
    let meta = "";
    if (showMeta && child.backendDOMNodeId) {
      try {
        const props = await cdp.getElementProperties(child.backendDOMNodeId);
        const parts: string[] = [];
        if (props.href) parts.push(`href=${props.href}`);
        if (props.src) parts.push(`src=${props.src}`);
        if (props.id) parts.push(`id=${props.id}`);
        if (props.tag) parts.push(`<${props.tag}>`);
        if (parts.length > 0) meta = `  \x1b[90m${parts.join(" ")}\x1b[0m`;
      } catch { /* stale node */ }
    }
    let textPreview = "";
    if (showText && child.backendDOMNodeId) {
      try {
        const innerText = await cdp.getInnerText(child.backendDOMNodeId);
        textPreview = formatTextPreview(innerText, textLen);
      } catch { /* stale node */ }
    }
    if (longFormat || showMeta || showText) {
      const role = child.role.padEnd(14);
      const name = child.isDirectory
        ? `\x1b[1;34m${child.name}/\x1b[0m`
        : formatColoredName(child);
      lines.push(`${tp} ${role} ${name}${textPreview}${meta}`);
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
    const totalTabs = allWindows.reduce((sum, w) => sum + (w.tabs ?? []).filter(tabInScope).length, 0);
    // A group lives in one window \u2014 count only windows that hold in-scope tabs.
    const visibleWindows = allWindows.filter((w) => (w.tabs ?? []).some(tabInScope)).length;
    const lines = [
      `  \x1b[1;34mwindows/\x1b[0m       \x1b[90m(${visibleWindows} windows)\x1b[0m`,
      `  \x1b[1;34mtabs/\x1b[0m          \x1b[90m(${totalTabs} tabs)\x1b[0m`,
    ];
    if (state.activeTabId) {
      try {
        const tab = await chrome.tabs.get(state.activeTabId);
        if (tabInScope(tab)) {
          lines.push("");
          lines.push(`  \x1b[90mActive tab: ${tab.id} \u2014 ${tab.title ?? "unknown"} (${tab.url ?? ""})\x1b[0m`);
        }
      } catch { /* tab gone */ }
    }
    return lines.join("\r\n");
  }

  if (browserPath[0] === "tabs") {
    // Flat list of tabs — scoped to the attached group, if any.
    const lines: string[] = [];
    if (groupMode === "isolated" && sessionGroupId !== null) {
      lines.push(`\x1b[36mAttached to '${sessionGroupName ?? sessionGroupId}' — showing this group's tabs only.\x1b[0m`);
    }
    lines.push(`  \x1b[90mID     TITLE                                URL                                    WIN\x1b[0m`);
    for (const win of allWindows) {
      for (const tab of win.tabs ?? []) {
        if (!tabInScope(tab)) continue;
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
    // Tree view of windows with their tabs \u2014 scoped to the attached group, if any.
    const lines: string[] = [];
    if (groupMode === "isolated" && sessionGroupId !== null) {
      lines.push(`\x1b[36mAttached to '${sessionGroupName ?? sessionGroupId}' \u2014 showing this group's tabs only.\x1b[0m`);
      lines.push("");
    }
    for (const win of allWindows) {
      const tabs = (win.tabs ?? []).filter(tabInScope);
      if (tabs.length === 0) continue;
      const focused = win.focused ? " \x1b[33m(focused)\x1b[0m" : "";
      lines.push(`\x1b[1;34mWindow ${win.id ?? "?"}\x1b[0m${focused}`);

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
      lines.push("");
    }
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
      if (!tabInScope(tab)) continue;
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

async function listBrowserLevelJson(browserPath: string[]): Promise<string> {
  const allWindows = await chrome.windows.getAll({ populate: true });

  if (browserPath.length === 0 || browserPath[0] === "tabs") {
    const tabs: any[] = [];
    for (const win of allWindows) {
      for (const tab of win.tabs ?? []) {
        if (!tabInScope(tab)) continue;
        tabs.push({
          id: tab.id,
          title: tab.title ?? "untitled",
          url: tab.url ?? "",
          windowId: win.id,
          active: tab.active,
          current: tab.id === state.activeTabId,
        });
      }
    }
    return JSON.stringify({ tabs });
  }

  if (browserPath[0] === "windows") {
    const windows: any[] = [];
    for (const win of allWindows) {
      const tabs = (win.tabs ?? []).filter(tabInScope).map(tab => ({
        id: tab.id,
        title: tab.title ?? "untitled",
        url: tab.url ?? "",
        active: tab.active,
        current: tab.id === state.activeTabId,
      }));
      windows.push({ id: win.id, focused: win.focused, tabs });
    }
    return JSON.stringify({ windows });
  }

  return JSON.stringify({ error: "Invalid browser path" });
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
  let target = args.length > 0 ? args[0] : "";

  // Expand path variables (%here%, etc.)
  try {
    target = await expandPathVariable(target);
  } catch (err: any) {
    return `\x1b[31m${err.message}\x1b[0m`;
  }

  // cd / or cd ~ or cd (empty) — go to browser root
  if (target === "/" || target === "~" || target === "") {
    state.path = [];
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

    // Scope guard (ADR-001 D3): in an isolated group, only the group's tabs are reachable.
    if (groupMode === "isolated") {
      if (sessionGroupId === null) {
        return "\x1b[31mcd: isolated mode has no group bound. Run 'group detach' or 'group new'.\x1b[0m";
      }
      if (sessionGroupDisrupted) {
        return "\x1b[31mcd: the session group was closed or changed externally. Run 'group detach' or 'group new'.\x1b[0m";
      }
      if (tab.groupId !== sessionGroupId) {
        return `\x1b[31mcd: tab ${tab.id} is outside the session group (id ${sessionGroupId}). ` +
          `Commands are confined to the group — run 'group detach' to leave isolated mode.\x1b[0m`;
      }
    }

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

  const pa = parseArgs(args);
  const jsonMode = pa.flags.has("--json");
  const targetName = pa.positional[0];

  if (!targetName) {
    return "\x1b[31mUsage: cat <name> (see cat --help)\x1b[0m";
  }

  const currentId = getCurrentNodeId();
  const match = resolveByPath(currentId, targetName, nodeMap);

  if (!match) {
    return `\x1b[31mcat: ${targetName}: No such file or directory\x1b[0m`;
  }

  // JSON output mode
  if (jsonMode) {
    const obj: any = {
      name: match.name,
      role: match.role,
      type: match.isDirectory ? "directory" : INTERACTIVE_ROLES.has(match.role) ? "interactive" : "static",
      axNodeId: match.axNodeId,
    };
    if (match.value) obj.value = match.value;
    if (match.isDirectory) {
      obj.childCount = getChildVFSNodes(match.axNodeId, nodeMap).length;
    }
    if (match.backendDOMNodeId) {
      obj.backendDOMNodeId = match.backendDOMNodeId;
      try {
        const props = await cdp.getElementProperties(match.backendDOMNodeId);
        if (props.tag) obj.tag = props.tag;
        if (props.href) obj.href = props.href;
        if (props.src) obj.src = props.src;
        if (props.id) obj.id = props.id;
        if (props.class) obj.class = props.class;
        if (props.alt) obj.alt = props.alt;
        if (props.title) obj.title = props.title;
        if (props.placeholder) obj.placeholder = props.placeholder;
        if (props.name) obj.domName = props.name;
        if (props.action) obj.action = props.action;
        if (props.outerHTML) obj.html = props.outerHTML;
      } catch { /* stale */ }
      try {
        const text = await cdp.getTextContent(match.backendDOMNodeId);
        if (text.trim()) obj.text = text.trim();
      } catch { /* stale */ }
      try {
        const visible = await cdp.getInnerText(match.backendDOMNodeId);
        if (visible.trim() && visible.trim() !== (obj.text || "")) obj.visibleText = visible.trim();
      } catch { /* stale */ }
    }
    return JSON.stringify(obj);
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
    // Pull real DOM properties (href, src, tag, id, class, etc.)
    let props: Record<string, string> = {};
    try {
      props = await cdp.getElementProperties(match.backendDOMNodeId);
      if (props.tag) {
        lines.push(`  \x1b[33mTag:\x1b[0m   <${props.tag}>`);
      }
      if (props.href) {
        lines.push(`  \x1b[33mURL:\x1b[0m   \x1b[4m${props.href}\x1b[0m`);
      }
      if (props.src) {
        lines.push(`  \x1b[33mSrc:\x1b[0m   ${props.src}`);
      }
      if (props.action) {
        lines.push(`  \x1b[33mAction:\x1b[0m ${props.action}`);
      }
      if (props.id) {
        lines.push(`  \x1b[33mID:\x1b[0m    ${props.id}`);
      }
      if (props.class) {
        lines.push(`  \x1b[33mClass:\x1b[0m ${props.class.slice(0, 120)}`);
      }
      if (props.alt) {
        lines.push(`  \x1b[33mAlt:\x1b[0m   ${props.alt}`);
      }
      if (props.title) {
        lines.push(`  \x1b[33mTitle:\x1b[0m ${props.title}`);
      }
      if (props.placeholder) {
        lines.push(`  \x1b[33mPlaceholder:\x1b[0m ${props.placeholder}`);
      }
      if (props.target) {
        lines.push(`  \x1b[33mTarget:\x1b[0m ${props.target}`);
      }
      if (props.name) {
        lines.push(`  \x1b[33mName:\x1b[0m  ${props.name}`);
      }
    } catch {
      // Element may be stale
    }

    // Text content (textContent — includes hidden elements)
    let textContent = "";
    try {
      textContent = await cdp.getTextContent(match.backendDOMNodeId);
      if (textContent.trim()) {
        lines.push(`  \x1b[33mText:\x1b[0m`);
        const wrapped = textContent.trim().slice(0, 500);
        lines.push(`  ${wrapped}`);
        if (textContent.length > 500) {
          lines.push(`  \x1b[90m... (${textContent.length} chars total)\x1b[0m`);
        }
      }
    } catch {
      // Ignore
    }

    // Visible text (innerText — respects CSS display/visibility)
    try {
      const visibleText = await cdp.getInnerText(match.backendDOMNodeId);
      if (visibleText.trim() && visibleText.trim() !== textContent.trim()) {
        lines.push(`  \x1b[33mVisibleText:\x1b[0m`);
        const wrapped = visibleText.trim().slice(0, 500);
        lines.push(`  ${wrapped}`);
        if (visibleText.length > 500) {
          lines.push(`  \x1b[90m... (${visibleText.length} chars total)\x1b[0m`);
        }
      }
    } catch {
      // Ignore
    }

    // Outer HTML snippet
    if (props.outerHTML) {
      lines.push(`  \x1b[33mHTML:\x1b[0m`);
      lines.push(`  \x1b[90m${props.outerHTML}\x1b[0m`);
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
  const withLinks = pa.flags.has("--links");

  let backendId: number | undefined;
  let targetName = "current directory";

  if (pa.positional.length > 0) {
    const name = pa.positional[0];
    const currentId = getCurrentNodeId();
    const match = resolveByPath(currentId, name, nodeMap);
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
    let text = withLinks
      ? await cdp.getTextContentWithLinks(backendId)
      : await cdp.getTextContent(backendId);
    text = text.trim();

    if (!text) {
      return `\x1b[33m(no text content in ${targetName})\x1b[0m`;
    }

    const lines: string[] = [];
    const header = withLinks ? `Text (with links): ${targetName}` : `Text: ${targetName}`;
    lines.push(`\x1b[1;36m--- ${header} ---\x1b[0m`);

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
  const match = resolveByPath(currentId, targetName, nodeMap);

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
  const match = resolveByPath(currentId, targetName, nodeMap);

  if (!match) {
    return `\x1b[31mfocus: ${targetName}: No such element\x1b[0m`;
  }

  if (!match.backendDOMNodeId) {
    return `\x1b[31mfocus: ${targetName}: No DOM node backing\x1b[0m`;
  }

  await cdp.focusByBackendNodeId(match.backendDOMNodeId);
  return `\x1b[32m\u2713 Focused: ${match.name}\x1b[0m`;
}

// ---- scroll ----

async function handleScroll(args: string[]): Promise<string> {
  ensureInsideTab();
  await ensureFreshTree();
  const pa = parseArgs(args);

  // Mode 1: scroll <element_name> — scroll into view
  if (pa.positional.length > 0 && pa.positional[0] !== "up" && pa.positional[0] !== "down") {
    const name = pa.positional[0];
    const currentId = getCurrentNodeId();
    const match = resolveByPath(currentId, name, nodeMap);
    if (!match) return `\x1b[31mscroll: ${name}: No such element\x1b[0m`;
    if (!match.backendDOMNodeId) return `\x1b[31mscroll: ${name}: No DOM node backing\x1b[0m`;
    await cdp.scrollIntoView(match.backendDOMNodeId);
    treeStale = true;
    return `\x1b[32m\u2713 Scrolled into view: ${match.name}\x1b[0m`;
  }

  // Mode 2: scroll down [N] / scroll up [N]
  const direction = (pa.positional[0] || "down") as "up" | "down";
  const amount = pa.positional[1] ? parseFloat(pa.positional[1]) : 1;
  const info = await cdp.scrollPage(direction, amount);
  treeStale = true;
  const maxScroll = info.scrollHeight - info.viewportHeight;
  const pct = maxScroll > 0 ? Math.round((info.scrollY / maxScroll) * 100) : 0;
  return `\x1b[32m\u2713 Scrolled ${direction} ${amount} viewport(s)\x1b[0m\r\n\x1b[90mPosition: ${info.scrollY}/${info.scrollHeight}px (${pct}%)\x1b[0m`;
}

// ---- js ----

async function handleJs(rawCode: string): Promise<string> {
  ensureInsideTab();

  const code = rawCode.trim();
  if (!code) {
    return "\x1b[31mUsage: js <expression> (see js --help)\x1b[0m";
  }

  const { value, type } = await cdp.evaluateJs(code);

  if (type === "undefined" || value === undefined) {
    return "\x1b[90mundefined\x1b[0m";
  }

  let output: string;
  if (typeof value === "string") {
    output = value;
  } else {
    try {
      output = JSON.stringify(value, null, 2);
    } catch {
      output = String(value);
    }
  }

  // Truncate large results
  if (output.length > 10000) {
    output = output.slice(0, 10000) + `\n\x1b[33m... truncated (${output.length} chars total)\x1b[0m`;
  }

  return output;
}

// ---- functions / call ----

async function handleFunctions(args: string[]): Promise<string> {
  ensureInsideTab();

  const pa = parseArgs(args);
  const pattern = pa.positional[0] || "";
  const json = pa.flags.has("--json");

  const code = `
    (() => {
      const fns = [];
      for (const k of Object.keys(window)) {
        try {
          if (typeof window[k] === 'function' && window.hasOwnProperty(k)) {
            const f = window[k];
            fns.push({ name: k, arity: f.length, params: f.toString().match(/\\(([^)]*)\\)/)?.[1] || '' });
          }
        } catch {}
      }
      return fns.sort((a, b) => a.name.localeCompare(b.name));
    })()
  `;

  const { value } = await cdp.evaluateJs(code);
  if (!Array.isArray(value)) return "\x1b[90m(no functions found)\x1b[0m";

  let filtered = value as Array<{ name: string; arity: number; params: string }>;
  if (pattern) {
    const lp = pattern.toLowerCase();
    filtered = filtered.filter((f) => f.name.toLowerCase().includes(lp));
  }

  if (filtered.length === 0) {
    return pattern
      ? `\x1b[90m(no functions matching '${pattern}')\x1b[0m`
      : "\x1b[90m(no functions found)\x1b[0m";
  }

  if (json) {
    return JSON.stringify(filtered);
  }

  const lines: string[] = [`\x1b[1;36mFunctions (${filtered.length}):\x1b[0m`];
  for (const f of filtered) {
    const params = f.params ? `(${f.params})` : `()`;
    lines.push(`  \x1b[32m${f.name}\x1b[0m${params}`);
  }
  return lines.join("\r\n");
}

async function handleCall(args: string[]): Promise<string> {
  ensureInsideTab();

  if (args.length === 0) {
    return "\x1b[31mUsage: call <functionName> [arg1] [arg2] ...\x1b[0m";
  }

  const funcName = args[0];
  const callArgs = args.slice(1);

  // Build argument list: try JSON.parse each arg, fall back to string
  const jsArgs = callArgs.map((a) => {
    try {
      JSON.parse(a); // valid JSON literal — use as-is
      return a;
    } catch {
      return JSON.stringify(a); // wrap as string
    }
  });

  const code = `(async () => {
    const fn = window[${JSON.stringify(funcName)}];
    if (typeof fn !== 'function') throw new Error(${JSON.stringify(funcName)} + ' is not a function');
    return await fn(${jsArgs.join(", ")});
  })()`;

  const { value, type } = await cdp.evaluateJs(code);

  if (type === "undefined" || value === undefined) {
    return "\x1b[90mundefined\x1b[0m";
  }

  let output: string;
  if (typeof value === "string") {
    output = value;
  } else {
    try {
      output = JSON.stringify(value, null, 2);
    } catch {
      output = String(value);
    }
  }

  if (output.length > 10000) {
    output = output.slice(0, 10000) + `\n\x1b[33m... truncated (${output.length} chars total)\x1b[0m`;
  }

  return output;
}

// ---- watch ----

async function handleWatch(rawArgs: string): Promise<string> {
  const args = rawArgs.trim();
  if (!args) return "\x1b[31mUsage: watch <command> [--interval N] [--times N] [--until-change]\x1b[0m";

  // Extract --interval, --times, and --until-change from args
  let interval = 2;
  let times = 5;
  let untilChange = false;
  let innerCmd = args;

  const intervalMatch = args.match(/--interval\s+(\d+(?:\.\d+)?)/);
  if (intervalMatch) {
    interval = Math.max(0.5, parseFloat(intervalMatch[1]));
    innerCmd = innerCmd.replace(intervalMatch[0], "");
  }
  const timesMatch = args.match(/--times\s+(\d+)/);
  if (timesMatch) {
    times = Math.min(100, Math.max(1, parseInt(timesMatch[1], 10)));
    innerCmd = innerCmd.replace(timesMatch[0], "");
  }
  if (/--until-change/.test(innerCmd)) {
    untilChange = true;
    innerCmd = innerCmd.replace(/--until-change/, "");
    // When watching for changes, default to more iterations (agent expects early exit)
    if (!timesMatch) times = 20;
  }
  innerCmd = innerCmd.trim();
  if (!innerCmd) return "\x1b[31mwatch: no command specified\x1b[0m";

  const results: string[] = [];
  const start = Date.now();
  const maxMs = 120000;
  let prevOutput: string | null = null;

  for (let i = 0; i < times; i++) {
    if (Date.now() - start > maxMs) {
      results.push(`\x1b[33m--- watch: time limit reached (${i}/${times} iterations) ---\x1b[0m`);
      break;
    }
    const output = await executeCommand(innerCmd);

    if (untilChange) {
      if (prevOutput !== null && output !== prevOutput) {
        results.push(`\x1b[1;32m--- Change detected at iteration ${i + 1} ---\x1b[0m`);
        results.push(`\x1b[33mBefore:\x1b[0m ${prevOutput}`);
        results.push(`\x1b[33mAfter:\x1b[0m  ${output}`);
        return results.join("\r\n");
      }
      prevOutput = output;
    } else {
      results.push(`\x1b[1;36m--- Iteration ${i + 1}/${times} ---\x1b[0m`);
      results.push(output);
    }

    if (i < times - 1 && Date.now() - start + interval * 1000 < maxMs) {
      await new Promise((r) => setTimeout(r, interval * 1000));
    }
  }

  if (untilChange) {
    results.push(`\x1b[33m--- No change detected after ${times} iterations ---\x1b[0m`);
    if (prevOutput !== null) results.push(`\x1b[33mLast value:\x1b[0m ${prevOutput}`);
  }

  return results.join("\r\n");
}

// ---- for ----

async function handleFor(rawArgs: string): Promise<string> {
  const args = rawArgs.trim();
  if (!args) return "\x1b[31mUsage: for <source-cmd> : <action-template>\x1b[0m";

  // Split on LAST ' : ' (space-colon-space) — use lastIndexOf so complex source
  // expressions containing ' : ' (ternary operators, etc.) don't break parsing.
  // Templates are simple commands like 'open {}' that won't contain ' : '.
  const sepIdx = args.lastIndexOf(" : ");
  if (sepIdx === -1) {
    return "\x1b[31mfor: missing ' : ' separator. Usage: for <source-cmd> : <action-template>\x1b[0m";
  }

  const sourceCmd = args.slice(0, sepIdx).trim();
  const template = args.slice(sepIdx + 3).trim();
  if (!sourceCmd) return "\x1b[31mfor: empty source command\x1b[0m";
  if (!template) return "\x1b[31mfor: empty action template\x1b[0m";

  // Execute source command
  const sourceOutput = await executeCommand(sourceCmd);
  const items = sourceOutput
    .split(/\r?\n/)
    .map((line) => {
      let s = stripAnsi(line).trim();
      // Strip leading [d]/[x]/[-] type prefix from find output
      s = s.replace(/^\[.\]\s*/, "");
      // Strip trailing (role) suffix from find output
      s = s.replace(/\s*\([^)]+\)\s*$/, "");
      // Strip trailing / from directory paths
      s = s.replace(/\/$/, "");
      return s;
    })
    .filter(Boolean);

  if (items.length === 0) return "\x1b[90m(no items from source command)\x1b[0m";

  const maxItems = 50;
  const maxMs = 120000;
  const start = Date.now();
  const results: string[] = [];

  for (let i = 0; i < Math.min(items.length, maxItems); i++) {
    if (Date.now() - start > maxMs) {
      results.push(`\x1b[33m--- for: time limit reached (${i}/${items.length} items) ---\x1b[0m`);
      break;
    }
    const cmd = template.replace(/\{\}/g, items[i]);
    results.push(`\x1b[90m> ${cmd}\x1b[0m`);
    const output = await executeCommand(cmd);
    results.push(output);
  }

  if (items.length > maxItems) {
    results.push(`\x1b[33m--- for: capped at ${maxItems} items (${items.length} total) ---\x1b[0m`);
  }

  return results.join("\r\n");
}

// ---- script ----

async function handleScript(rawArgs: string): Promise<string> {
  const parts = parseCommandLine(rawArgs);
  const sub = parts[0]?.toLowerCase();

  if (!sub || sub === "list") {
    const names = Object.keys(scripts);
    if (names.length === 0) return "\x1b[90m(no saved scripts)\x1b[0m";
    const lines = ["\x1b[1;36mScripts:\x1b[0m"];
    for (const name of names) {
      lines.push(`  \x1b[32m${name}\x1b[0m  (${scripts[name].length} commands)`);
    }
    return lines.join("\r\n");
  }

  if (sub === "save") {
    const name = parts[1];
    if (!name) return "\x1b[31mscript save: specify a name\x1b[0m";
    // Everything after "save <name> " is the commands, separated by " ; "
    const rest = rawArgs.trim().slice(rawArgs.trim().indexOf(name) + name.length).trim();
    if (!rest) return "\x1b[31mscript save: specify commands separated by ' ; '\x1b[0m";
    const cmds = rest.split(/\s*;\s*/).filter(Boolean);
    if (cmds.length === 0) return "\x1b[31mscript save: no commands found\x1b[0m";
    scripts[name] = cmds;
    persistState();
    return `\x1b[32m\u2713 Script '${name}' saved (${cmds.length} commands).\x1b[0m`;
  }

  if (sub === "show") {
    const name = parts[1];
    if (!name) return "\x1b[31mscript show: specify a script name\x1b[0m";
    if (!scripts[name]) return `\x1b[31mscript: '${name}' not found\x1b[0m`;
    const lines = [`\x1b[1;36mScript '${name}':\x1b[0m`];
    for (let i = 0; i < scripts[name].length; i++) {
      lines.push(`  ${i + 1}. ${scripts[name][i]}`);
    }
    return lines.join("\r\n");
  }

  if (sub === "run") {
    const name = parts[1];
    if (!name) return "\x1b[31mscript run: specify a script name\x1b[0m";
    if (!scripts[name]) return `\x1b[31mscript: '${name}' not found\x1b[0m`;
    const scriptArgs = parts.slice(2); // positional args after script name
    const cmds = scripts[name];
    const results: string[] = [];
    const start = Date.now();
    const maxMs = 120000;

    for (let i = 0; i < cmds.length; i++) {
      if (Date.now() - start > maxMs) {
        results.push(`\x1b[33m--- script: time limit reached (${i}/${cmds.length} commands) ---\x1b[0m`);
        break;
      }
      // Variable substitution: $1, $2, ..., $0 = script name, $# = arg count
      let cmd = cmds[i];
      if (scriptArgs.length > 0) {
        cmd = cmd.replace(/\$#/g, String(scriptArgs.length));
        cmd = cmd.replace(/\$0/g, name);
        for (let a = scriptArgs.length; a >= 1; a--) {
          cmd = cmd.replace(new RegExp("\\$" + a, "g"), scriptArgs[a - 1]);
        }
      }
      results.push(`\x1b[90m$ ${cmd}\x1b[0m`);
      const output = await executeCommand(cmd);
      results.push(output);
    }
    return results.join("\r\n");
  }

  if (sub === "delete") {
    const name = parts[1];
    if (!name) return "\x1b[31mscript delete: specify a script name\x1b[0m";
    if (!scripts[name]) return `\x1b[31mscript: '${name}' not found\x1b[0m`;
    delete scripts[name];
    persistState();
    return `\x1b[32m\u2713 Script '${name}' deleted.\x1b[0m`;
  }

  return `\x1b[31mscript: unknown subcommand '${sub}'. Use: list, save, show, run, delete\x1b[0m`;
}

// ---- group helpers ----

/** Strip the 🐚 prefix from a group title for use as a prompt host name. */
function cleanGroupName(title: string | undefined): string {
  const t = (title ?? "").replace(/^\u{1F41A}\s*/u, "").trim();
  return t || "group";
}

/** A tab is in scope when not attached, or when it belongs to the attached group. */
function tabInScope(tab: { groupId?: number }): boolean {
  if (groupMode !== "isolated" || sessionGroupId === null) return true;
  return tab.groupId === sessionGroupId;
}

/** The shell prompt — the attached group becomes the host (dom@<group>). */
function currentPrompt(): string {
  const host = (groupMode === "isolated" && sessionGroupName) ? sessionGroupName : "shell";
  return `\x1b[1;32mdom\x1b[0m@\x1b[1;34m${host}\x1b[0m:\x1b[1;33m$\x1b[0m `;
}

/** On launch, if the focused tab is inside a Chrome tab group, attach to it. */
async function maybeAutoAttach(): Promise<void> {
  if (groupMode === "isolated") return;  // already attached (e.g. restored)
  try {
    const win = await chrome.windows.getLastFocused({ populate: true });
    const activeTab = win.tabs?.find((t) => t.active);
    if (!activeTab || activeTab.groupId === undefined || activeTab.groupId < 0) return;
    const g = await chrome.tabGroups.get(activeTab.groupId);
    groupMode = "isolated";
    sessionGroupId = activeTab.groupId;
    sessionGroupName = cleanGroupName(g.title);
    sessionGroupDisrupted = false;
    persistState();
  } catch { /* no auto-attach */ }
}

// ---- group (tab-group session isolation, PRD-001 / ADR-001) ----

async function handleGroup(args: string[]): Promise<string> {
  const sub = (args[0] || "").toLowerCase();
  if (!sub || sub === "status") return await groupStatus();
  if (sub === "new") return await groupNew(args.slice(1));
  if (sub === "attach") return await groupAttach(args.slice(1));
  if (sub === "detach") return await groupDetach();
  if (sub === "close") return await groupClose(args.slice(1));
  if (sub === "list") return await groupList();
  return `\x1b[31mgroup: unknown subcommand '${sub}'. Use: new, attach, detach, close, list\x1b[0m`;
}

async function groupStatus(): Promise<string> {
  if (groupMode === "shared") {
    return [
      "\x1b[1;36mGroup mode:\x1b[0m \x1b[37mshared\x1b[0m — operating on the general browser",
      "\x1b[90mRun 'group new [name]' to work in an isolated tab group.\x1b[0m",
    ].join("\r\n");
  }
  if (sessionGroupId === null) {
    return "\x1b[31mgroup: isolated mode with no group bound. Run 'group detach' to reset.\x1b[0m";
  }
  try {
    const g = await chrome.tabGroups.get(sessionGroupId);
    const tabs = await chrome.tabs.query({ groupId: sessionGroupId });
    return [
      "\x1b[1;36mGroup mode:\x1b[0m \x1b[32misolated\x1b[0m",
      `  \x1b[37mGroup: ${g.title ?? "(untitled)"}  [id ${sessionGroupId}]\x1b[0m`,
      `  \x1b[37mTabs:  ${tabs.length}\x1b[0m`,
      "  \x1b[90mEvery command is confined to this group.\x1b[0m",
    ].join("\r\n");
  } catch {
    sessionGroupDisrupted = true;
    return `\x1b[31mgroup: the session group (id ${sessionGroupId}) no longer exists. ` +
      `Run 'group detach' to return to shared mode, or 'group new'.\x1b[0m`;
  }
}

async function groupNew(rest: string[]): Promise<string> {
  // If already isolated, the previous group is left open — surface it, don't orphan it silently.
  const previousGroupId =
    (groupMode === "isolated" && sessionGroupId !== null && !sessionGroupDisrupted)
      ? sessionGroupId : null;
  const name = rest.join(" ").trim();
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  if (!tab.id) return "\x1b[31mgroup new: failed to create a working tab.\x1b[0m";
  createdTabIds.add(tab.id);
  let gid: number;
  try {
    gid = await chrome.tabs.group({ tabIds: [tab.id] });
  } catch (err: any) {
    return `\x1b[31mgroup new: failed to create group: ${err.message}\x1b[0m`;
  }
  const title = name ? `\u{1F41A} ${name}` : `\u{1F41A} DOMShell ${++groupSeq}`;
  try {
    await chrome.tabGroups.update(gid, { title, color: "cyan" });
  } catch { /* labeling is best-effort */ }
  createdGroupIds.add(gid);
  groupMode = "isolated";
  sessionGroupId = gid;
  sessionGroupName = cleanGroupName(title);
  sessionGroupDisrupted = false;
  // Land at the group's tab-listing level (not inside the blank working tab),
  // so `ls` shows the group's tabs right away.
  state.path = ["tabs"];
  state.axNodeIds = [];
  persistState();
  const lines = [
    `\x1b[32m✓ Created isolated group '${title}'  [id ${gid}]\x1b[0m`,
    `  \x1b[37mWorking tab: ${tab.id}\x1b[0m`,
  ];
  if (previousGroupId !== null) {
    lines.push(`  \x1b[33mPrevious group [id ${previousGroupId}] left open — 'group attach ${previousGroupId}' to return to it.\x1b[0m`);
  }
  lines.push("  \x1b[90mAttached — 'ls' lists this group's tabs, 'cd <id>' enters one, 'group detach' leaves.\x1b[0m");
  lines.push("");
  return lines.join("\r\n");
}

async function groupAttach(rest: string[]): Promise<string> {
  const target = rest.join(" ").trim();
  if (!target) return "\x1b[31mgroup attach: specify a group id or name.\x1b[0m";

  let allGroups: chrome.tabGroups.TabGroup[];
  try {
    allGroups = await chrome.tabGroups.query({});
  } catch (err: any) {
    return `\x1b[31mgroup attach: ${err.message}\x1b[0m`;
  }
  if (allGroups.length === 0) {
    return "\x1b[31mgroup attach: no tab groups exist. Run 'group new' to create one.\x1b[0m";
  }

  const asId = parseInt(target, 10);
  let match = !isNaN(asId) ? allGroups.find((g) => g.id === asId) : undefined;
  if (!match) {
    match = allGroups.find((g) => (g.title ?? "").toLowerCase().includes(target.toLowerCase()));
  }
  if (!match) {
    return `\x1b[31mgroup attach: no tab group matching '${target}'. Run 'group list'.\x1b[0m`;
  }

  const gid = match.id;
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({ groupId: gid });
  } catch {
    return `\x1b[31mgroup attach: group ${gid} no longer exists.\x1b[0m`;
  }
  if (tabs.length === 0) return `\x1b[31mgroup attach: group ${gid} has no tabs.\x1b[0m`;

  groupMode = "isolated";
  sessionGroupId = gid;
  sessionGroupName = cleanGroupName(match.title);
  sessionGroupDisrupted = false;
  // Land at the group's tab-listing level so `ls` shows the group's tabs.
  state.path = ["tabs"];
  state.axNodeIds = [];
  persistState();
  return `\x1b[32m✓ Attached to '${match.title ?? gid}'  [id ${gid}]  ` +
    `(${tabs.length} tab${tabs.length === 1 ? "" : "s"}). Prompt is now dom@${sessionGroupName} — 'ls' lists the group's tabs.\x1b[0m`;
}

async function groupDetach(): Promise<string> {
  if (groupMode === "shared") return "\x1b[90mNot attached — already at dom@shell.\x1b[0m";
  const prev = sessionGroupName ?? String(sessionGroupId ?? "");
  groupMode = "shared";
  sessionGroupId = null;
  sessionGroupName = null;
  sessionGroupDisrupted = false;
  persistState();
  return `\x1b[32m✓ Detached from '${prev}' — back to dom@shell (general browser). ` +
    `The group and its tabs are left intact.\x1b[0m`;
}

async function groupClose(rest: string[]): Promise<string> {
  const arg = rest.join(" ").trim();
  let gid: number;
  if (arg) {
    const asId = parseInt(arg, 10);
    if (!isNaN(asId)) {
      gid = asId;
    } else {
      let resolved: number | null = null;
      try {
        const groups = await chrome.tabGroups.query({});
        const m = groups.find((g) => (g.title ?? "").toLowerCase().includes(arg.toLowerCase()));
        if (m) resolved = m.id;
      } catch { /* ignore */ }
      if (resolved === null) return `\x1b[31mgroup close: no tab group matching '${arg}'. See 'group list'.\x1b[0m`;
      gid = resolved;
    }
  } else if (groupMode === "isolated" && sessionGroupId !== null) {
    gid = sessionGroupId;
  } else {
    return "\x1b[31mgroup close: specify a group id, or attach to one first. See 'group list'.\x1b[0m";
  }

  let tabs: chrome.tabs.Tab[] = [];
  try { tabs = await chrome.tabs.query({ groupId: gid }); } catch { /* group already gone */ }

  const toClose: number[] = [];
  let kept = 0;
  for (const t of tabs) {
    if (t.id !== undefined && createdTabIds.has(t.id)) toClose.push(t.id);
    else kept++;
  }
  if (toClose.length > 0) {
    try { await chrome.tabs.remove(toClose); } catch { /* ignore */ }
    for (const id of toClose) createdTabIds.delete(id);
  }
  createdGroupIds.delete(gid);

  // If we just closed the group we were attached to, drop back to dom@shell.
  if (gid === sessionGroupId) {
    groupMode = "shared";
    sessionGroupId = null;
    sessionGroupName = null;
    sessionGroupDisrupted = false;
    state.path = [];
    state.axNodeIds = [];
  }
  persistState();
  const keptMsg = kept > 0
    ? ` \x1b[33m${kept} non-DOMShell tab${kept === 1 ? "" : "s"} left open (group kept).\x1b[0m`
    : "";
  return `\x1b[32m✓ Closed group ${gid} — removed ${toClose.length} DOMShell tab${toClose.length === 1 ? "" : "s"}.\x1b[0m${keptMsg}`;
}

async function groupList(): Promise<string> {
  let groups: chrome.tabGroups.TabGroup[];
  try {
    groups = await chrome.tabGroups.query({});
  } catch (err: any) {
    return `\x1b[31mgroup list: ${err.message}\x1b[0m`;
  }
  if (groups.length === 0) return "\x1b[90m(no tab groups — run 'group new' to create one)\x1b[0m";
  const lines = ["\x1b[1;36mTab groups (group attach <id> to enter):\x1b[0m"];
  for (const g of groups) {
    const tabs = await chrome.tabs.query({ groupId: g.id });
    const marker = g.id === sessionGroupId ? "  \x1b[32m(attached)\x1b[0m" : "";
    const own = createdGroupIds.has(g.id) ? "" : "  \x1b[90m(your group)\x1b[0m";
    lines.push(`  \x1b[37m${g.title ?? "(untitled)"}\x1b[0m  [id ${g.id}]  ${tabs.length} tab${tabs.length === 1 ? "" : "s"}${marker}${own}`);
  }
  return lines.join("\r\n");
}

// ---- each (multi-tab) ----

async function handleEach(rawArgs: string): Promise<string> {
  const args = rawArgs.trim();
  if (!args) return "\x1b[31mUsage: each [--pattern FILTER] <command>\x1b[0m";

  // Extract --pattern and --limit
  let pattern = "";
  let limit = 0;
  let innerCmd = args;
  const patternMatch = args.match(/--pattern\s+(\S+)/);
  if (patternMatch) {
    pattern = patternMatch[1].toLowerCase();
    innerCmd = innerCmd.replace(patternMatch[0], "").trim();
  }
  const limitMatch = innerCmd.match(/--limit\s+(\d+)/);
  if (limitMatch) {
    limit = parseInt(limitMatch[1], 10);
    innerCmd = innerCmd.replace(limitMatch[0], "").trim();
  }
  if (!innerCmd) return "\x1b[31meach: no command specified\x1b[0m";

  // Get all tabs
  const windows = await chrome.windows.getAll({ populate: true });
  const allTabs: chrome.tabs.Tab[] = [];
  for (const w of windows) {
    if (w.tabs) {
      for (const t of w.tabs) {
        if (!tabInScope(t)) continue;
        if (t.id && t.url && !t.url.startsWith("chrome://") && !t.url.startsWith("chrome-extension://")) {
          if (!pattern || (t.title && t.title.toLowerCase().includes(pattern)) || t.url.toLowerCase().includes(pattern)) {
            allTabs.push(t);
          }
        }
      }
    }
  }

  if (allTabs.length === 0) {
    return pattern
      ? `\x1b[90m(no tabs matching '${pattern}')\x1b[0m`
      : "\x1b[90m(no eligible tabs)\x1b[0m";
  }

  // Apply --limit
  if (limit > 0 && allTabs.length > limit) {
    allTabs.length = limit;
  }

  // Save current state
  const savedPath = [...state.path];
  const savedAxNodeIds = [...state.axNodeIds];
  const savedTabId = state.activeTabId;
  const savedTreeStale = treeStale;

  const results: string[] = [];
  const start = Date.now();
  const maxMs = 120000;

  for (const tab of allTabs) {
    if (Date.now() - start > maxMs) {
      results.push(`\x1b[33m--- each: time limit reached ---\x1b[0m`);
      break;
    }
    const title = tab.title ? tab.title.slice(0, 60) : `Tab ${tab.id}`;
    results.push(`\x1b[1;36m--- ${title} (${tab.id}) ---\x1b[0m`);
    try {
      await cdpSwitchToTab(tab.id!);
      state.path = ["tabs", String(tab.id)];
      const output = await executeCommand(innerCmd);
      results.push(output);
    } catch (err: any) {
      results.push(`\x1b[31mError: ${err.message}\x1b[0m`);
    }
  }

  // Restore previous state
  state.path = savedPath;
  state.axNodeIds = savedAxNodeIds;
  if (savedTabId) {
    try {
      await cdpSwitchToTab(savedTabId);
    } catch { /* original tab may be gone */ }
  }
  treeStale = true;

  return results.join("\r\n");
}

// ---- back / forward ----

async function handleBack(): Promise<string> {
  ensureInsideTab();

  const url = await cdp.goBack();
  if (!url) {
    return "\x1b[33mNo previous page in history.\x1b[0m";
  }

  // Wait for page to load after history navigation
  const tabId = state.activeTabId!;
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
    }, 10000);
  });

  // Re-fetch the AX tree
  const { nodeCount } = await cdpSwitchToTab(tabId);

  // Reset DOM portion of path
  const domStart = getDomStartIndex(state.path);
  if (domStart >= 0) {
    state.path = state.path.slice(0, domStart);
  }

  const tab = await chrome.tabs.get(tabId);
  return [
    `\x1b[32m\u2713 Back\x1b[0m`,
    `  \x1b[37mURL:   ${tab.url ?? url}\x1b[0m`,
    `  \x1b[37mTitle: ${tab.title ?? "unknown"}\x1b[0m`,
    `  \x1b[90mAX Nodes: ${nodeCount}\x1b[0m`,
    "",
  ].join("\r\n");
}

async function handleForward(): Promise<string> {
  ensureInsideTab();

  const url = await cdp.goForward();
  if (!url) {
    return "\x1b[33mNo forward page in history.\x1b[0m";
  }

  const tabId = state.activeTabId!;
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
    }, 10000);
  });

  const { nodeCount } = await cdpSwitchToTab(tabId);

  const domStart = getDomStartIndex(state.path);
  if (domStart >= 0) {
    state.path = state.path.slice(0, domStart);
  }

  const tab = await chrome.tabs.get(tabId);
  return [
    `\x1b[32m\u2713 Forward\x1b[0m`,
    `  \x1b[37mURL:   ${tab.url ?? url}\x1b[0m`,
    `  \x1b[37mTitle: ${tab.title ?? "unknown"}\x1b[0m`,
    `  \x1b[90mAX Nodes: ${nodeCount}\x1b[0m`,
    "",
  ].join("\r\n");
}

// ---- close ----

async function handleClose(args: string[]): Promise<string> {
  const pa = parseArgs(args);

  let tabId: number;
  if (pa.positional.length > 0) {
    tabId = parseInt(pa.positional[0], 10);
    if (isNaN(tabId)) {
      return `\x1b[31mclose: invalid tab ID: ${pa.positional[0]}\x1b[0m`;
    }
  } else {
    if (state.activeTabId === null) {
      return "\x1b[31mclose: not in a tab. Use 'close <tab-id>' or cd into a tab first.\x1b[0m";
    }
    tabId = state.activeTabId;
  }

  // Detach CDP if closing the attached tab
  if (state.activeTabId === tabId) {
    await cdp.detach();
    state.activeTabId = null;
    state.path = [];
    state.axNodeIds = [];
    nodeMap = new Map();
  }

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const title = tab?.title ?? `tab ${tabId}`;

  await chrome.tabs.remove(tabId);

  return `\x1b[32m\u2713 Closed: ${title}\x1b[0m`;
}

// ---- screenshot ----

async function handleScreenshot(): Promise<string> {
  ensureInsideTab();

  const data = await cdp.captureScreenshot("png");
  // Return base64 data prefixed with marker for MCP to detect
  return `__SCREENSHOT_BASE64__${data}`;
}

// ---- select ----

async function handleSelect(args: string[]): Promise<string> {
  ensureInsideTab();
  await ensureFreshTree();

  if (args.length < 2) {
    return "\x1b[31mUsage: select <name> <value> (see select --help)\x1b[0m";
  }

  const targetName = args[0];
  const value = args.slice(1).join(" ");
  const currentId = getCurrentNodeId();
  const match = resolveByPath(currentId, targetName, nodeMap);

  if (!match) {
    return `\x1b[31mselect: ${targetName}: No such element\x1b[0m`;
  }

  if (!match.backendDOMNodeId) {
    return `\x1b[31mselect: ${targetName}: No DOM node backing\x1b[0m`;
  }

  const result = await cdp.selectOption(match.backendDOMNodeId, value);

  if (result.startsWith("Error:")) {
    return `\x1b[31mselect: ${result}\x1b[0m`;
  }

  return `\x1b[32m\u2713 ${result}\x1b[0m`;
}

// ---- wait ----

async function handleWait(args: string[]): Promise<string> {
  ensureInsideTab();

  const pa = parseArgs(args);
  const pattern = pa.positional[0];
  if (!pattern) {
    return "\x1b[31mUsage: wait <pattern> [--type role] [--timeout N] (see wait --help)\x1b[0m";
  }

  const typeFilter = pa.named["--type"]?.toLowerCase();
  const timeoutSec = pa.named["--timeout"] ? parseFloat(pa.named["--timeout"]) : 5;
  const maxMs = Math.min(timeoutSec * 1000, 30000);
  const interval = 500;
  const start = Date.now();
  const expandedTypes = typeFilter ? expandTypeFilter(typeFilter) : undefined;

  while (Date.now() - start < maxMs) {
    // Force refresh the AX tree each poll
    const axNodes = await cdp.getAllFrameAXTrees();
    nodeMap = buildNodeMap(axNodes);
    textContentCache = new Map();

    // Search for matching element
    const currentId = getCurrentNodeId();
    const results: Array<{ path: string; node: VFSNode }> = [];
    await findRecursive(currentId, "", pattern.toLowerCase(), expandedTypes, results, new Set(), 1, false);

    if (results.length > 0) {
      const found = results[0];
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const tp = typePrefix(found.node);
      const coloredName = found.node.isDirectory
        ? `\x1b[1;34m${found.node.name}/\x1b[0m`
        : formatColoredName(found.node);
      return [
        `\x1b[32m\u2713 Found after ${elapsed}s\x1b[0m`,
        `  ${tp} \x1b[90m${found.path}\x1b[0m${coloredName} \x1b[90m(${found.node.role})\x1b[0m`,
      ].join("\r\n");
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  return `\x1b[31mwait: timed out after ${timeoutSec}s — "${pattern}" not found\x1b[0m`;
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

// ---- submit (atomic form interaction) ----

async function handleSubmit(args: string[]): Promise<string> {
  ensureInsideTab();
  await ensureFreshTree();

  const pa = parseArgs(args);
  const submitBtnName = pa.named["--submit"];

  if (pa.positional.length < 2) {
    return "\x1b[31mUsage: submit <input_name> <value> [--submit button_name]\x1b[0m";
  }

  const inputName = pa.positional[0];
  const value = pa.positional.slice(1).join(" ");
  const currentId = getCurrentNodeId();

  // 1. Find and focus the input (exact match, then fuzzy fallback)
  let input = resolveByPath(currentId, inputName, nodeMap);
  if (!input) {
    // Fuzzy fallback: strip common suffixes and search recursively for input elements
    const baseName = inputName.replace(/_(input|search|btn|button|select|checkbox|radio)$/i, "").toLowerCase();
    const inputRoles = expandTypeFilter("input");
    const candidates: Array<{ path: string; node: VFSNode }> = [];
    await findRecursive(currentId, "", baseName, inputRoles, candidates, new Set(), 5);
    if (candidates.length > 0) {
      input = candidates[0].node;
    }
  }
  if (!input) {
    return `\x1b[31msubmit: ${inputName}: No such element\x1b[0m`;
  }
  if (!input.backendDOMNodeId) {
    return `\x1b[31msubmit: ${inputName}: No DOM node backing\x1b[0m`;
  }
  await cdp.focusByBackendNodeId(input.backendDOMNodeId);

  // 2. Clear existing value (select all + delete via JS)
  await cdp.send("Runtime.callFunctionOn", {
    objectId: (await cdp.send<{ object: { objectId: string } }>("DOM.resolveNode", { backendNodeId: input.backendDOMNodeId })).object.objectId,
    functionDeclaration: `function() { this.value = ''; this.dispatchEvent(new Event('input', { bubbles: true })); }`,
    returnByValue: true,
  });

  // 3. Type the value
  await cdp.typeText(value);

  // 4. Submit: click button or press Enter
  if (submitBtnName) {
    let btn = resolveByPath(currentId, submitBtnName, nodeMap);
    if (!btn) {
      // Fuzzy fallback for submit button
      const baseBtnName = submitBtnName.replace(/_(input|search|btn|button|select|checkbox|radio)$/i, "").toLowerCase();
      const btnRoles = expandTypeFilter("button");
      const btnCandidates: Array<{ path: string; node: VFSNode }> = [];
      await findRecursive(currentId, "", baseBtnName, btnRoles, btnCandidates, new Set(), 5);
      if (btnCandidates.length > 0) {
        btn = btnCandidates[0].node;
      }
    }
    if (btn && btn.backendDOMNodeId) {
      try {
        await cdp.clickByBackendNodeId(btn.backendDOMNodeId);
      } catch {
        try {
          await cdp.clickByCoordinates(btn.backendDOMNodeId);
        } catch {
          // Fallback to Enter
          await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r" });
          await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
        }
      }
    } else {
      // Button not found, press Enter
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r" });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
    }
  } else {
    // No submit button specified, press Enter
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r" });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
  }

  treeStale = true;
  const method = submitBtnName ? `clicked ${submitBtnName}` : "pressed Enter";
  return `\x1b[32m\u2713 Submitted: typed "${value}" into ${inputName}, then ${method}\x1b[0m\r\n\x1b[90m(tree will auto-refresh on next command)\x1b[0m`;
}

// ---- extract_links ----

async function handleExtractLinks(args: string[]): Promise<string> {
  ensureInsideTab();
  await ensureFreshTree();

  const pa = parseArgs(args);
  const limit = pa.named["-n"] ? parseInt(pa.named["-n"], 10) : 0;

  let targetId: string;
  if (pa.positional.length > 0) {
    const name = pa.positional[0];
    const currentId = getCurrentNodeId();
    const match = resolveByPath(currentId, name, nodeMap);
    if (!match) return `\x1b[31mextract_links: ${name}: No such element\x1b[0m`;
    targetId = match.axNodeId;
  } else {
    targetId = getCurrentNodeId();
  }

  // Collect all link nodes recursively
  const results: Array<{ path: string; node: VFSNode }> = [];
  await findRecursive(targetId, "", "", expandTypeFilter("link"), results, new Set(), limit || 200);

  if (results.length === 0) return "\x1b[33m(no links found)\x1b[0m";

  const lines: string[] = [];
  for (let i = 0; i < results.length; i++) {
    if (limit > 0 && i >= limit) break;
    const node = results[i].node;
    let displayText = node.value || node.name.replace(/_/g, " ");
    let href = "";

    if (node.backendDOMNodeId) {
      try {
        const props = await cdp.getElementProperties(node.backendDOMNodeId);
        if (props.href) href = props.href;
        // Use visible text for better display
        const text = await cdp.getInnerText(node.backendDOMNodeId);
        if (text.trim()) displayText = text.trim().replace(/\s+/g, " ");
      } catch { /* stale node */ }
    }

    if (href) {
      lines.push(`${i + 1}. [${displayText}](${href})`);
    } else {
      lines.push(`${i + 1}. ${displayText} (no href)`);
    }
  }

  return lines.join("\r\n");
}

// ---- extract_table ----

async function handleExtractTable(args: string[]): Promise<string> {
  ensureInsideTab();
  await ensureFreshTree();

  const pa = parseArgs(args);
  const format = pa.named["--format"] || "markdown";
  const limit = pa.named["-n"] ? parseInt(pa.named["-n"], 10) : 0;

  if (pa.positional.length === 0) {
    return "\x1b[31mUsage: extract_table <table_name> [--format markdown|csv] [-n limit]\x1b[0m";
  }

  const tableName = pa.positional[0];
  const currentId = getCurrentNodeId();
  const tableNode = resolveByPath(currentId, tableName, nodeMap);
  if (!tableNode) return `\x1b[31mextract_table: ${tableName}: No such element\x1b[0m`;

  // Walk table structure: table -> rowgroup/row -> row -> cell
  const rows: string[][] = [];
  const tableChildren = getChildVFSNodes(tableNode.axNodeId, nodeMap);

  for (const child of tableChildren) {
    let rowNodes: VFSNode[] = [];

    if (child.role === "row") {
      rowNodes = [child];
    } else if (child.role === "rowgroup") {
      // thead, tbody, tfoot -> contains rows
      rowNodes = getChildVFSNodes(child.axNodeId, nodeMap).filter(r => r.role === "row");
    }

    for (const row of rowNodes) {
      if (limit > 0 && rows.length >= limit) break;
      const cells = getChildVFSNodes(row.axNodeId, nodeMap);
      const cellTexts: string[] = [];

      for (const cell of cells) {
        if (cell.backendDOMNodeId) {
          try {
            const text = await cdp.getInnerText(cell.backendDOMNodeId);
            cellTexts.push(text.trim().replace(/\s+/g, " "));
          } catch {
            cellTexts.push(cell.value || cell.name);
          }
        } else {
          cellTexts.push(cell.value || cell.name);
        }
      }
      rows.push(cellTexts);
    }
  }

  if (rows.length === 0) return "\x1b[33m(no rows found in table)\x1b[0m";

  if (format === "csv") {
    return rows.map(r => r.map(c => `"${c.replace(/"/g, '""')}"`).join(",")).join("\r\n");
  }

  // Markdown format — first row as header
  const header = rows[0];
  const separator = header.map(() => "---");
  const lines = [
    "| " + header.join(" | ") + " |",
    "| " + separator.join(" | ") + " |",
    ...rows.slice(1).map(r => "| " + r.join(" | ") + " |"),
  ];
  return lines.join("\r\n");
}

// ---- grep ----

async function handleGrep(args: string[]): Promise<string> {
  ensureInsideTab();
  await ensureFreshTree();

  const pa = parseArgs(args);
  const recursive = pa.flags.has("-r");
  const contentMatch = pa.flags.has("--content");
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

  const matches: VFSNode[] = [];
  for (const c of candidates) {
    if (limit > 0 && matches.length >= limit) break;

    const axMatch =
      c.name.toLowerCase().includes(pattern) ||
      c.role.toLowerCase().includes(pattern) ||
      (c.value && c.value.toLowerCase().includes(pattern));

    if (axMatch) {
      matches.push(c);
      continue;
    }

    // Slow path: match against visible text content (only if --content flag)
    if (contentMatch && c.backendDOMNodeId) {
      try {
        const text = await getCachedInnerText(c.backendDOMNodeId);
        if (text.toLowerCase().includes(pattern)) {
          matches.push(c);
        }
      } catch { /* stale node */ }
    }
  }

  if (matches.length === 0) {
    return `\x1b[33mNo matches for '${pattern}'\x1b[0m`;
  }

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
  const jsonMode = pa.flags.has("--json");
  const typeFilter = pa.named["--type"]?.toLowerCase();
  const limit = pa.named["-n"] ? parseInt(pa.named["-n"], 10) : 0;
  const showMeta = pa.flags.has("--meta");
  const showText = pa.flags.has("--text");
  const textLen = pa.named["--textlen"] ? parseInt(pa.named["--textlen"], 10) : 80;
  const pattern = pa.positional[0]?.toLowerCase() ?? "";
  // --text with a pattern implicitly enables content matching
  const contentMatch = pa.flags.has("--content") || (showText && !!pattern);

  if (!pattern && !typeFilter) {
    return "\x1b[31mUsage: find [options] <pattern> (see find --help)\x1b[0m";
  }

  const currentId = getCurrentNodeId();
  const results: Array<{ path: string; node: VFSNode }> = [];
  const expandedTypes = typeFilter ? expandTypeFilter(typeFilter) : undefined;
  await findRecursive(currentId, "", pattern, expandedTypes, results, new Set(), limit, contentMatch);

  if (results.length === 0) {
    const desc = typeFilter ? `type '${typeFilter}'` : `'${pattern}'`;
    if (jsonMode) return JSON.stringify({ results: [] });
    return `\x1b[33mNo matches for ${desc}\x1b[0m`;
  }

  // JSON output mode
  if (jsonMode) {
    const items: any[] = [];
    for (const r of results) {
      const item: any = {
        path: r.path + r.node.name,
        name: r.node.name,
        role: r.node.role,
        type: r.node.isDirectory ? "directory" : INTERACTIVE_ROLES.has(r.node.role) ? "interactive" : "static",
      };
      if (r.node.value) item.value = r.node.value;
      if ((showMeta || jsonMode) && r.node.backendDOMNodeId) {
        try {
          const props = await cdp.getElementProperties(r.node.backendDOMNodeId);
          if (props.href) item.href = props.href;
          if (props.src) item.src = props.src;
          if (props.id) item.id = props.id;
          if (props.tag) item.tag = props.tag;
        } catch { /* stale node */ }
      }
      if (showText && r.node.backendDOMNodeId) {
        try {
          item.text = await cdp.getInnerText(r.node.backendDOMNodeId);
        } catch { /* stale node */ }
      }
      items.push(item);
    }
    return JSON.stringify({ results: items });
  }

  const lines: string[] = [];
  for (const r of results) {
    const tp = typePrefix(r.node);
    const coloredName = r.node.isDirectory
      ? `\x1b[1;34m${r.node.name}/\x1b[0m`
      : formatColoredName(r.node);
    let meta = "";
    if (showMeta && r.node.backendDOMNodeId) {
      try {
        const props = await cdp.getElementProperties(r.node.backendDOMNodeId);
        const parts: string[] = [];
        if (props.href) parts.push(`href=${props.href}`);
        if (props.src) parts.push(`src=${props.src}`);
        if (props.id) parts.push(`id=${props.id}`);
        if (props.tag) parts.push(`<${props.tag}>`);
        if (parts.length > 0) meta = `  \x1b[90m${parts.join(" ")}\x1b[0m`;
      } catch { /* stale node */ }
    }
    let textPreview = "";
    if (showText && r.node.backendDOMNodeId) {
      try {
        const innerText = await cdp.getInnerText(r.node.backendDOMNodeId);
        textPreview = formatTextPreview(innerText, textLen);
      } catch { /* stale node */ }
    }
    lines.push(`${tp} \x1b[90m${r.path}\x1b[0m${coloredName} \x1b[90m(${r.node.role})\x1b[0m${textPreview}${meta}`);
  }
  return lines.join("\r\n");
}

function expandTypeFilter(typeFilter: string): Set<string> {
  const roles = new Set<string>();
  roles.add(typeFilter);
  const aliases = ROLE_ALIASES[typeFilter];
  if (aliases) {
    for (const a of aliases) roles.add(a);
  }
  return roles;
}

async function findRecursive(
  parentId: string,
  pathPrefix: string,
  pattern: string,
  expandedTypes: Set<string> | undefined,
  results: Array<{ path: string; node: VFSNode }>,
  visited: Set<string>,
  limit: number,
  contentMatch: boolean = false
): Promise<void> {
  if (visited.has(parentId)) return;
  if (limit > 0 && results.length >= limit) return;
  visited.add(parentId);

  const children = getChildVFSNodes(parentId, nodeMap);

  for (const child of children) {
    if (limit > 0 && results.length >= limit) return;

    // Check type filter first (cheap) before expensive content match
    const matchesType = !expandedTypes || expandedTypes.has(child.role.toLowerCase());

    let matchesPattern = !pattern ||
      child.name.toLowerCase().includes(pattern) ||
      child.role.toLowerCase().includes(pattern) ||
      (child.value && child.value.toLowerCase().includes(pattern));

    // Slow path: match against visible text content — only for type-matched nodes
    if (!matchesPattern && contentMatch && pattern && matchesType && child.backendDOMNodeId) {
      try {
        const text = await getCachedInnerText(child.backendDOMNodeId);
        matchesPattern = text.toLowerCase().includes(pattern);
      } catch { /* stale node */ }
    }

    if (matchesPattern && matchesType) {
      results.push({ path: pathPrefix, node: child });
    }

    if (child.isDirectory) {
      await findRecursive(
        child.axNodeId,
        pathPrefix + child.name + "/",
        pattern,
        expandedTypes,
        results,
        visited,
        limit,
        contentMatch
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

// ---- read (structured subtree extraction) ----

async function handleRead(args: string[]): Promise<string> {
  ensureInsideTab();
  await ensureFreshTree();

  const pa = parseArgs(args);
  const maxDepth = pa.named["-d"] ? parseInt(pa.named["-d"], 10) : 5;
  const showMeta = pa.flags.has("--meta");
  const showText = pa.flags.has("--text");
  const textLen = pa.named["--textlen"] ? parseInt(pa.named["--textlen"], 10) : 120;
  const limit = pa.named["-n"] ? parseInt(pa.named["-n"], 10) : 0;

  let targetId: string;
  let targetName: string;

  if (pa.positional.length > 0) {
    const name = pa.positional[0];
    const currentId = getCurrentNodeId();
    const match = resolveByPath(currentId, name, nodeMap);
    if (!match) {
      return `\x1b[31mread: ${name}: No such file or directory\x1b[0m`;
    }
    targetId = match.axNodeId;
    targetName = match.name;
  } else {
    targetId = getCurrentNodeId();
    const node = nodeMap.get(targetId);
    targetName = node ? generateNodeName(node) : "/";
  }

  const lines: string[] = [];
  const counter = { count: 0 };

  // Root line
  const rootNode = nodeMap.get(targetId);
  const rootRole = rootNode?.role?.value ?? "group";
  lines.push(`${targetName} [${rootRole}]`);

  await buildReadLines(targetId, "  ", maxDepth, 0, lines, showMeta, showText, textLen, limit, counter);

  return lines.join("\r\n");
}

async function buildReadLines(
  parentId: string,
  indent: string,
  maxDepth: number,
  depth: number,
  lines: string[],
  showMeta: boolean,
  showText: boolean,
  textLen: number,
  limit: number,
  counter: { count: number }
): Promise<void> {
  if (depth >= maxDepth) return;
  if (limit > 0 && counter.count >= limit) return;

  const children = getChildVFSNodes(parentId, nodeMap);

  for (const child of children) {
    if (limit > 0 && counter.count >= limit) return;
    counter.count++;

    // Format: indent + name [role] "value"
    let line = `${indent}${child.name} [${child.role}]`;
    if (child.value) {
      const val = child.value.length > textLen ? child.value.slice(0, textLen) + "..." : child.value;
      line += ` "${val}"`;
    }

    // Optionally add meta (href, src, id)
    if (showMeta && child.backendDOMNodeId) {
      try {
        const props = await cdp.getElementProperties(child.backendDOMNodeId);
        const parts: string[] = [];
        if (props.href) parts.push(`href=${props.href}`);
        if (props.src) parts.push(`src=${props.src}`);
        if (props.id) parts.push(`id=${props.id}`);
        if (parts.length > 0) line += `  {${parts.join(", ")}}`;
      } catch { /* stale node */ }
    }

    // Optionally add text preview
    if (showText && child.backendDOMNodeId) {
      try {
        const text = await cdp.getInnerText(child.backendDOMNodeId);
        const cleaned = text.trim().replace(/\s+/g, " ");
        if (cleaned) {
          const preview = cleaned.length > textLen ? cleaned.slice(0, textLen) + "..." : cleaned;
          line += `  \x1b[90m"${preview}"\x1b[0m`;
        }
      } catch { /* stale node */ }
    }

    lines.push(line);

    if (child.isDirectory) {
      await buildReadLines(child.axNodeId, indent + "  ", maxDepth, depth + 1, lines, showMeta, showText, textLen, limit, counter);
    }
  }
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

function handleHistory(args: string[]): string {
  if (args.length > 0 && args[0] === "clear") {
    commandHistory = [];
    persistState();
    return "\x1b[32m✓ History cleared.\x1b[0m";
  }

  const pa = parseArgs(args);
  const limit = pa.named["-n"] ? parseInt(pa.named["-n"], 10) : 20;

  if (commandHistory.length === 0) {
    return "\x1b[90m(no history)\x1b[0m";
  }

  const start = Math.max(0, commandHistory.length - limit);
  const lines: string[] = [];
  for (let i = start; i < commandHistory.length; i++) {
    const num = String(i + 1).padStart(4, " ");
    lines.push(`\x1b[90m${num}\x1b[0m  ${commandHistory[i]}`);
  }
  return lines.join("\r\n");
}

function handleBookmark(args: string[]): string {
  const pa = parseArgs(args);

  // bookmark --delete <name>
  if (pa.flags.has("--delete") || pa.flags.has("-d")) {
    const name = pa.positional[0];
    if (!name) return "\x1b[31mbookmark: specify a name to delete\x1b[0m";
    if (!bookmarks[name]) return `\x1b[31mbookmark: '@${name}' not found\x1b[0m`;
    delete bookmarks[name];
    persistState();
    return `\x1b[32m✓ Bookmark '@${name}' deleted.\x1b[0m`;
  }

  // bookmark (no args) — list all
  if (pa.positional.length === 0) {
    const keys = Object.keys(bookmarks);
    if (keys.length === 0) return "\x1b[90m(no bookmarks)\x1b[0m";
    const lines: string[] = ["\x1b[1;36mBookmarks:\x1b[0m"];
    for (const k of keys) {
      lines.push(`  \x1b[32m@${k}\x1b[0m  →  ~/${bookmarks[k].join("/")}`);
    }
    return lines.join("\r\n");
  }

  const name = pa.positional[0];

  // bookmark <name> <path> — save explicit path
  if (pa.positional.length >= 2) {
    let rawPath = pa.positional.slice(1).join(" ");
    // Normalize: strip leading ~/ or /
    rawPath = rawPath.replace(/^~\//, "").replace(/^\//, "");
    const segments = rawPath.split("/").filter(Boolean);
    bookmarks[name] = segments;
    persistState();
    return `\x1b[32m✓ Bookmark '@${name}' → ~/${segments.join("/")}\x1b[0m`;
  }

  // bookmark <name> — save current path
  if (state.path.length === 0) {
    return "\x1b[31mbookmark: cannot bookmark browser root (~). Navigate into a path first.\x1b[0m";
  }
  bookmarks[name] = [...state.path];
  persistState();
  return `\x1b[32m✓ Bookmark '@${name}' → ~/${state.path.join("/")}\x1b[0m`;
}

async function handleDiff(args: string[]): Promise<string> {
  ensureInsideTab();
  await ensureFreshTree();

  const pa = parseArgs(args);
  const jsonMode = pa.flags.has("--json");

  if (!previousSnapshot) {
    return "\x1b[33mNo snapshot available. A snapshot is automatically saved before each write/navigate command (click, type, submit, select, navigate, open, back, forward, scroll).\x1b[0m";
  }

  // Build current snapshot for comparison
  const current = captureSnapshot();

  // Compare: find added, removed, and changed nodes
  const added: Array<{ id: string; entry: SnapshotEntry }> = [];
  const removed: Array<{ id: string; entry: SnapshotEntry }> = [];
  const changed: Array<{ id: string; prev: SnapshotEntry; curr: SnapshotEntry }> = [];

  for (const [id, curr] of current) {
    const prev = previousSnapshot.get(id);
    if (!prev) {
      added.push({ id, entry: curr });
    } else if (prev.value !== curr.value || prev.childCount !== curr.childCount) {
      changed.push({ id, prev, curr });
    }
  }
  for (const [id, prev] of previousSnapshot) {
    if (!current.has(id)) {
      removed.push({ id, entry: prev });
    }
  }

  const totalChanges = added.length + removed.length + changed.length;

  if (totalChanges === 0) {
    if (jsonMode) return JSON.stringify({ changes: 0, added: [], removed: [], changed: [] });
    return "\x1b[32m✓ No changes detected.\x1b[0m";
  }

  if (jsonMode) {
    return JSON.stringify({
      changes: totalChanges,
      added: added.slice(0, 50).map(a => ({ name: a.entry.name, role: a.entry.role, value: a.entry.value })),
      removed: removed.slice(0, 50).map(r => ({ name: r.entry.name, role: r.entry.role, value: r.entry.value })),
      changed: changed.slice(0, 50).map(c => ({ name: c.curr.name, role: c.curr.role, from: c.prev.value, to: c.curr.value })),
    });
  }

  const lines: string[] = [];
  lines.push(`\x1b[1;36mdiff: ${totalChanges} change${totalChanges !== 1 ? "s" : ""} detected\x1b[0m`);

  for (const a of added.slice(0, 30)) {
    lines.push(`  \x1b[32m+ ${a.entry.name}\x1b[0m \x1b[90m(${a.entry.role})\x1b[0m${a.entry.value ? ` "${a.entry.value.slice(0, 60)}"` : ""}`);
  }
  for (const r of removed.slice(0, 30)) {
    lines.push(`  \x1b[31m- ${r.entry.name}\x1b[0m \x1b[90m(${r.entry.role})\x1b[0m${r.entry.value ? ` "${r.entry.value.slice(0, 60)}"` : ""}`);
  }
  for (const c of changed.slice(0, 20)) {
    const fromVal = c.prev.value?.slice(0, 40) ?? "";
    const toVal = c.curr.value?.slice(0, 40) ?? "";
    lines.push(`  \x1b[33m~ ${c.curr.name}\x1b[0m \x1b[90m(${c.curr.role})\x1b[0m "${fromVal}" → "${toVal}"`);
  }

  if (added.length > 30 || removed.length > 30 || changed.length > 20) {
    lines.push(`  \x1b[90m... (truncated, use --json for full output)\x1b[0m`);
  }

  return lines.join("\r\n");
}

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
  persistState();

  return `\x1b[32m\u2713 ${key}=${value}\x1b[0m`;
}

// ---- navigate / open ----

async function handleNavigate(args: string[]): Promise<string> {
  if (args.length === 0) {
    return "\x1b[31mUsage: navigate <url> (see navigate --help)\x1b[0m";
  }

  ensureInsideTab();

  let url = args[0];
  if (!url.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//)) {
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
    }, 5000);
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
  if (!url.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//)) {
    url = "https://" + url;
  }

  // Create new tab. In an isolated group, open it inactive (no focus steal,
  // ADR-001 D8) and add it to the session group so scoping holds.
  const isolated = groupMode === "isolated" && sessionGroupId !== null;
  const tab = await chrome.tabs.create({ url, active: !isolated });
  if (!tab.id) return "\x1b[31mError: Failed to create tab.\x1b[0m";
  if (isolated) {
    createdTabIds.add(tab.id);
    try {
      await chrome.tabs.group({ tabIds: [tab.id], groupId: sessionGroupId! });
    } catch { /* group may be gone; the scope guard will surface it */ }
  }

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
    }, 5000);
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
