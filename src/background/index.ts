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
  cwd: [],
  cwdNames: ["/"],
  attachedTabId: null,
  env: {
    SHELL: "/bin/agentshell",
    TERM: "xterm-256color",
    PS1: "agent@shell:$PWD$ ",
  },
};

let nodeMap: Map<string, AXNode> = new Map();
let treeStale = false;

// ---- CDP Event Listener for DOM / Navigation Changes ----

chrome.debugger.onEvent.addListener((source, method) => {
  if (source.tabId !== state.attachedTabId) return;

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
    "\x1b[36m╔══════════════════════════════════════╗\x1b[0m",
    "\x1b[36m║\x1b[0m   \x1b[1;33mAgentShell v1.0.0\x1b[0m               \x1b[36m║\x1b[0m",
    "\x1b[36m║\x1b[0m   \x1b[37mThe DOM is your filesystem.\x1b[0m      \x1b[36m║\x1b[0m",
    "\x1b[36m╚══════════════════════════════════════╝\x1b[0m",
    "",
    "\x1b[90mType 'help' to see available commands.\x1b[0m",
    "\x1b[90mType 'attach' to connect to the active tab.\x1b[0m",
    "",
  ].join("\r\n");
}

// ---- Type indicator prefixes for agent-friendly output ----
// These short prefixes communicate metadata without relying on color alone.

function typePrefix(node: VFSNode): string {
  if (node.isDirectory) {
    // Directory that also has interactive children
    return "[d]";
  }
  if (INTERACTIVE_ROLES.has(node.role)) {
    // Clickable / interactive file
    return "[x]";
  }
  // Static / read-only node
  return "[-]";
}

// ---- Help text for --help on each command ----

const COMMAND_HELP: Record<string, string> = {
  help: [
    "\x1b[1;36mhelp\x1b[0m — Show all available commands",
    "",
    "\x1b[33mUsage:\x1b[0m help",
  ].join("\r\n"),

  attach: [
    "\x1b[1;36mattach\x1b[0m — Connect to the active browser tab via CDP",
    "",
    "\x1b[33mUsage:\x1b[0m attach",
    "",
    "Attaches the Chrome DevTools Protocol debugger to the active tab,",
    "fetches its Accessibility Tree (including iframes), and sets CWD to root.",
  ].join("\r\n"),

  detach: [
    "\x1b[1;36mdetach\x1b[0m — Disconnect from the current tab",
    "",
    "\x1b[33mUsage:\x1b[0m detach",
  ].join("\r\n"),

  refresh: [
    "\x1b[1;36mrefresh\x1b[0m — Re-fetch the Accessibility Tree",
    "",
    "\x1b[33mUsage:\x1b[0m refresh",
    "",
    "Re-fetches the full AX tree (including iframes) and resets CWD to root.",
    "Use after page navigation or DOM mutations.",
  ].join("\r\n"),

  ls: [
    "\x1b[1;36mls\x1b[0m — List children of the current node",
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
    "  \x1b[1;34m■ Blue\x1b[0m     Directories   \x1b[1;32m■ Green\x1b[0m   Buttons",
    "  \x1b[1;35m■ Magenta\x1b[0m  Links         \x1b[1;33m■ Yellow\x1b[0m  Inputs/search",
    "  \x1b[1;36m■ Cyan\x1b[0m     Checkboxes    \x1b[37m■ White\x1b[0m   Other",
    "",
    "\x1b[33mExamples:\x1b[0m",
    "  ls                     List all children",
    "  ls -l                  Long format with roles + type prefixes",
    "  ls -n 10               First 10 items",
    "  ls -n 10 --offset 10   Items 11-20 (pagination)",
    "  ls --type link         Only show links",
    "  ls -l --type button    Buttons only, long format",
    "  ls --count             Just show the count",
  ].join("\r\n"),

  cd: [
    "\x1b[1;36mcd\x1b[0m — Change directory (navigate into a container node)",
    "",
    "\x1b[33mUsage:\x1b[0m cd [path]",
    "",
    "\x1b[33mExamples:\x1b[0m",
    "  cd navigation    Enter the 'navigation' container",
    "  cd ..            Go up one level",
    "  cd /             Go to root",
    "  cd main/form     Multi-level path",
    "  cd ../sidebar    Go up then into 'sidebar'",
  ].join("\r\n"),

  pwd: [
    "\x1b[1;36mpwd\x1b[0m — Print working directory (current path in the AX tree)",
    "",
    "\x1b[33mUsage:\x1b[0m pwd",
  ].join("\r\n"),

  cat: [
    "\x1b[1;36mcat\x1b[0m — Read metadata and text content of a node",
    "",
    "\x1b[33mUsage:\x1b[0m cat <name>",
    "",
    "Shows: role, type ([d]/[x]/[-]), AX ID, DOM backend ID,",
    "value, child count (dirs), and DOM text content.",
  ].join("\r\n"),

  click: [
    "\x1b[1;36mclick\x1b[0m — Click an element",
    "",
    "\x1b[33mUsage:\x1b[0m click <name>",
    "",
    "Resolves the node to a DOM element and triggers a click.",
    "Falls back to coordinate-based click if JS click fails.",
    "Use 'refresh' after clicking if the page changes.",
  ].join("\r\n"),

  focus: [
    "\x1b[1;36mfocus\x1b[0m — Focus an input element",
    "",
    "\x1b[33mUsage:\x1b[0m focus <name>",
    "",
    "Focuses the DOM element. Use before 'type' to direct keyboard input.",
  ].join("\r\n"),

  type: [
    "\x1b[1;36mtype\x1b[0m — Type text into the focused element",
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
    "\x1b[1;36mgrep\x1b[0m — Search children for matching names",
    "",
    "\x1b[33mUsage:\x1b[0m grep [options] <pattern>",
    "",
    "\x1b[33mOptions:\x1b[0m",
    "  \x1b[32m-r, --recursive\x1b[0m  Search all descendants recursively",
    "  \x1b[32m-n N\x1b[0m             Limit results to first N matches",
    "",
    "Matches against name, role, and value. Case-insensitive.",
    "",
    "\x1b[33mExamples:\x1b[0m",
    "  grep login         Current dir only",
    "  grep -r search     Recursive search",
    "  grep -r -n 5 btn   First 5 recursive matches",
  ].join("\r\n"),

  find: [
    "\x1b[1;36mfind\x1b[0m — Deep recursive search with full paths",
    "",
    "\x1b[33mUsage:\x1b[0m find [options] <pattern>",
    "",
    "\x1b[33mOptions:\x1b[0m",
    "  \x1b[32m--type ROLE\x1b[0m   Filter by AX role (e.g. --type combobox)",
    "  \x1b[32m-n N\x1b[0m          Limit to first N results",
    "",
    "Searches the entire tree from CWD down. Shows the full path.",
    "",
    "\x1b[33mExamples:\x1b[0m",
    "  find search           Anything with 'search' in the name",
    "  find --type combobox  All dropdowns / comboboxes",
    "  find --type textbox   All text input fields",
    "  find --type link -n 5 First 5 links",
  ].join("\r\n"),

  tree: [
    "\x1b[1;36mtree\x1b[0m — Show a tree view of the current node",
    "",
    "\x1b[33mUsage:\x1b[0m tree [depth]",
    "",
    "\x1b[33mArguments:\x1b[0m",
    "  depth    Max depth to display (default: 2)",
    "",
    "\x1b[33mExamples:\x1b[0m",
    "  tree       2-level deep tree",
    "  tree 5     5-level deep tree",
  ].join("\r\n"),

  whoami: [
    "\x1b[1;36mwhoami\x1b[0m — Check authentication status via cookies",
    "",
    "\x1b[33mUsage:\x1b[0m whoami",
    "",
    "Reads cookies for the current URL and looks for session/auth cookies.",
  ].join("\r\n"),

  env: [
    "\x1b[1;36menv\x1b[0m — Show environment variables",
    "",
    "\x1b[33mUsage:\x1b[0m env",
  ].join("\r\n"),

  export: [
    "\x1b[1;36mexport\x1b[0m — Set an environment variable",
    "",
    "\x1b[33mUsage:\x1b[0m export KEY=VALUE",
    "",
    "\x1b[33mExamples:\x1b[0m",
    "  export API_KEY=sk-abc123",
    "  export USER=agent",
  ].join("\r\n"),

  debug: [
    "\x1b[1;36mdebug\x1b[0m — Inspect raw AX tree data",
    "",
    "\x1b[33mSubcommands:\x1b[0m",
    "  \x1b[32mstats\x1b[0m          AX tree statistics",
    "  \x1b[32mraw\x1b[0m            Raw children of current node (incl. ignored)",
    "  \x1b[32mnode <id>\x1b[0m      Inspect a specific AX node by its ID",
  ].join("\r\n"),

  clear: [
    "\x1b[1;36mclear\x1b[0m — Clear the terminal screen",
    "",
    "\x1b[33mUsage:\x1b[0m clear",
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
      case "attach":
        return await handleAttach();
      case "detach":
        return await handleDetach();
      case "ls":
        return await handleLs(args);
      case "cd":
        return await handleCd(args);
      case "pwd":
        return handlePwd();
      case "cat":
        return await handleCat(args);
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
    "\x1b[1;36mAgentShell — DOM as a Filesystem\x1b[0m",
    "",
    "Use \x1b[33m<command> --help\x1b[0m for detailed usage of any command.",
    "",
    "\x1b[1;33mNavigation:\x1b[0m",
    "  \x1b[32mattach\x1b[0m          Connect to the active browser tab",
    "  \x1b[32mdetach\x1b[0m          Disconnect from the current tab",
    "  \x1b[32mrefresh\x1b[0m         Re-fetch the Accessibility Tree",
    "  \x1b[32mls\x1b[0m              List children of the current node",
    "  \x1b[32mcd <name>\x1b[0m       Enter a child node (directory)",
    "  \x1b[32mpwd\x1b[0m             Show current path",
    "  \x1b[32mtree [depth]\x1b[0m    Show tree view of current node",
    "",
    "\x1b[1;33mInspection:\x1b[0m",
    "  \x1b[32mcat <name>\x1b[0m      Read metadata and text content of a node",
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
    "\x1b[90mType prefixes: [d]=directory [x]=interactive [-]=static\x1b[0m",
    "",
  ].join("\r\n");
}

async function handleAttach(): Promise<string> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return "\x1b[31mError: No active tab found.\x1b[0m";

  try {
    await cdp.attach(tab.id);
    state.attachedTabId = tab.id;

    // Fetch AX tree including iframes
    const axNodes = await cdp.getAllFrameAXTrees();
    nodeMap = buildNodeMap(axNodes);

    const root = findRootNode(nodeMap);
    if (root) {
      state.cwd = [root.nodeId];
      state.cwdNames = ["/"];
    }

    const title = tab.title ?? "unknown";
    const url = tab.url ?? "unknown";

    let iframeCount = 0;
    for (const node of nodeMap.values()) {
      const role = node.role?.value ?? "";
      if (role === "Iframe" || role === "IframePresentational") iframeCount++;
    }

    const lines = [
      `\x1b[32m✓ Attached to tab ${tab.id}\x1b[0m`,
      `  \x1b[37mTitle: ${title}\x1b[0m`,
      `  \x1b[37mURL:   ${url}\x1b[0m`,
      `  \x1b[90mAX Nodes: ${nodeMap.size}\x1b[0m`,
    ];
    if (iframeCount > 0) {
      lines.push(`  \x1b[90mIframes: ${iframeCount}\x1b[0m`);
    }
    lines.push("");
    return lines.join("\r\n");
  } catch (err: any) {
    return `\x1b[31mError attaching: ${err.message}\x1b[0m`;
  }
}

async function handleDetach(): Promise<string> {
  if (!state.attachedTabId) {
    return "\x1b[33mNot attached to any tab.\x1b[0m";
  }
  await cdp.detach();
  state.attachedTabId = null;
  state.cwd = [];
  state.cwdNames = ["/"];
  nodeMap.clear();
  return "\x1b[32m✓ Detached.\x1b[0m";
}

async function handleRefresh(): Promise<string> {
  if (!state.attachedTabId) {
    return "\x1b[31mNot attached. Run 'attach' first.\x1b[0m";
  }

  const axNodes = await cdp.getAllFrameAXTrees();
  nodeMap = buildNodeMap(axNodes);

  const root = findRootNode(nodeMap);
  if (root) {
    state.cwd = [root.nodeId];
    state.cwdNames = ["/"];
  }

  return `\x1b[32m✓ Refreshed. ${nodeMap.size} AX nodes loaded.\x1b[0m`;
}

function ensureAttached(): void {
  if (!state.attachedTabId || nodeMap.size === 0) {
    throw new Error("Not attached to a tab. Run 'attach' first.");
  }
}

function getCurrentNodeId(): string {
  if (state.cwd.length === 0) throw new Error("No CWD set. Run 'attach' first.");
  return state.cwd[state.cwd.length - 1];
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

  // Check if current CWD still exists in the new tree
  const currentId = state.cwd[state.cwd.length - 1];
  if (currentId && !nodeMap.has(currentId)) {
    // CWD is gone — page navigated, reset to root
    const root = findRootNode(nodeMap);
    if (root) {
      state.cwd = [root.nodeId];
      state.cwdNames = ["/"];
    }
    return `\x1b[33m(page changed — tree refreshed, ${nodeMap.size} nodes, CWD reset to /)\x1b[0m\r\n`;
  }

  return `\x1b[90m(tree auto-refreshed, ${nodeMap.size} nodes)\x1b[0m\r\n`;
}

// ---- Tab Completion ----

const COMMANDS = [
  "help", "attach", "detach", "refresh", "ls", "cd", "pwd", "cat",
  "click", "focus", "type", "grep", "find", "whoami", "env", "export",
  "tree", "debug", "clear",
];

function getCompletions(partial: string, command: string): string[] {
  // If no command yet (completing the command name itself)
  if (!command || command === partial) {
    const lower = partial.toLowerCase();
    return COMMANDS.filter((c) => c.startsWith(lower));
  }

  // For commands that take node names, complete against current directory children
  const nodeCommands = new Set(["cd", "cat", "click", "focus", "ls", "grep", "find"]);
  if (!nodeCommands.has(command)) return [];

  try {
    if (!state.attachedTabId || nodeMap.size === 0) return [];
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
  ensureAttached();
  const refreshMsg = await ensureFreshTree();

  const pa = parseArgs(args);
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

// ---- cd ----

async function handleCd(args: string[]): Promise<string> {
  ensureAttached();
  await ensureFreshTree();

  if (args.length === 0 || args[0] === "/") {
    const root = findRootNode(nodeMap);
    if (root) {
      state.cwd = [root.nodeId];
      state.cwdNames = ["/"];
    }
    return "";
  }

  const target = args[0];

  if (target === "..") {
    if (state.cwd.length > 1) {
      state.cwd.pop();
      state.cwdNames.pop();
    }
    return "";
  }

  const pathParts = target.split("/").filter(Boolean);

  for (const part of pathParts) {
    if (part === "..") {
      if (state.cwd.length > 1) {
        state.cwd.pop();
        state.cwdNames.pop();
      }
      continue;
    }

    const currentId = getCurrentNodeId();
    const match = findChildByName(currentId, part, nodeMap);

    if (!match) {
      return `\x1b[31mcd: ${part}: No such directory\x1b[0m`;
    }
    if (!match.isDirectory) {
      return `\x1b[31mcd: ${part}: Not a directory (type: [x] ${match.role})\x1b[0m`;
    }

    state.cwd.push(match.axNodeId);
    state.cwdNames.push(match.name);
  }

  return "";
}

// ---- pwd ----

function handlePwd(): string {
  if (state.cwdNames.length <= 1) return "/";
  return "/" + state.cwdNames.slice(1).join("/");
}

// ---- cat ----

async function handleCat(args: string[]): Promise<string> {
  ensureAttached();
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

// ---- click ----

async function handleClick(args: string[]): Promise<string> {
  ensureAttached();
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
    // Mark tree stale — click may trigger navigation or DOM changes
    treeStale = true;
    return `\x1b[32m✓ Clicked: ${match.name} (${match.role})\x1b[0m\r\n\x1b[90m(tree will auto-refresh on next command)\x1b[0m`;
  } catch {
    try {
      await cdp.clickByCoordinates(match.backendDOMNodeId);
      treeStale = true;
      return `\x1b[32m✓ Clicked (coords): ${match.name} (${match.role})\x1b[0m\r\n\x1b[90m(tree will auto-refresh on next command)\x1b[0m`;
    } catch (err: any) {
      return `\x1b[31mclick failed: ${err.message}\x1b[0m`;
    }
  }
}

// ---- focus ----

async function handleFocus(args: string[]): Promise<string> {
  ensureAttached();
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
  return `\x1b[32m✓ Focused: ${match.name}\x1b[0m`;
}

// ---- type ----

async function handleType(args: string[]): Promise<string> {
  ensureAttached();

  if (args.length === 0) {
    return "\x1b[31mUsage: type <text> (see type --help)\x1b[0m";
  }

  const text = args.join(" ");
  await cdp.typeText(text);
  return `\x1b[32m✓ Typed ${text.length} characters\x1b[0m`;
}

// ---- grep ----

async function handleGrep(args: string[]): Promise<string> {
  ensureAttached();
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
  ensureAttached();
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
  ensureAttached();
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
    const connector = isLast ? "└── " : "├── ";
    const childPrefix = isLast ? "    " : "│   ";
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
  if (!state.attachedTabId) {
    return "\x1b[31mNot attached. Run 'attach' first.\x1b[0m";
  }

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

  return `\x1b[32m✓ ${key}=${value}\x1b[0m`;
}

// ---- debug ----

async function handleDebug(args: string[]): Promise<string> {
  ensureAttached();
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
