// ---- Message passing between Side Panel <-> Background ----

export interface StdinMessage {
  type: "STDIN";
  input: string;
}

export interface StdoutMessage {
  type: "STDOUT";
  output: string;
}

export interface StderrMessage {
  type: "STDERR";
  error: string;
}

export interface ReadyMessage {
  type: "READY";
}

export interface CompleteMessage {
  type: "COMPLETE";
  partial: string;   // The partial name to complete
  command: string;   // The command context (e.g. "cd", "cat")
}

export interface CompleteResponseMessage {
  type: "COMPLETE_RESPONSE";
  matches: string[];
  partial: string;
}

export type ShellMessage = StdinMessage | StdoutMessage | StderrMessage | ReadyMessage | CompleteMessage | CompleteResponseMessage;

// ---- Shell State ----

export interface ShellState {
  // Unified path from browser root (~). Examples:
  //   []                              → ~ (browser root)
  //   ["tabs"]                        → ~/tabs
  //   ["tabs", "123"]                 → inside tab 123, at DOM root
  //   ["tabs", "123", "main", "form"] → inside tab 123, at /main/form
  //   ["windows"]                     → window listing
  //   ["windows", "1"]               → window 1's tabs
  //   ["windows", "1", "123", "nav"] → inside tab 123 via window 1, at /nav
  path: string[];

  // AX node IDs for the DOM portion of path (parallel to segments after tab entry).
  // If path = ["tabs", "123", "main", "form"], axNodeIds = [rootId, mainId, formId]
  axNodeIds: string[];

  // Which tab's AX tree is currently cached in nodeMap (null = none)
  activeTabId: number | null;

  env: Record<string, string>;
}

// ---- Virtual Filesystem Nodes ----

export interface VFSNode {
  axNodeId: string;
  backendDOMNodeId?: number;
  name: string;             // Generated human-readable filename
  role: string;             // Original AX role
  value?: string;           // Text content / value
  isDirectory: boolean;     // Container vs leaf
  children?: VFSNode[];
}

// ---- AX Tree types from CDP ----

export interface AXNode {
  nodeId: string;
  backendDOMNodeId?: number;
  role?: { type: string; value: string };
  name?: { type: string; value: string };
  description?: { type: string; value: string };
  value?: { type: string; value: string };
  childIds?: string[];
  properties?: AXProperty[];
  ignored?: boolean;
}

export interface AXProperty {
  name: string;
  value: { type: string; value: any };
}

// Container roles — these become "directories"
export const CONTAINER_ROLES = new Set([
  "group",
  "navigation",
  "form",
  "search",
  "section",
  "main",
  "complementary",
  "banner",
  "contentinfo",
  "region",
  "article",
  "list",
  "listitem",
  "tree",
  "treeitem",
  "tablist",
  "tabpanel",
  "dialog",
  "menu",
  "menubar",
  "toolbar",
  "table",
  "row",
  "rowgroup",
  "grid",
  "document",
  "application",
  "figure",
  "feed",
  "log",
  "status",
  "timer",
  "alertdialog",
  "generic",
  "WebArea",
  "RootWebArea",
  "Iframe",
  "IframePresentational",
]);

// Interactive roles — these become "files" you can click/interact with
export const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "switch",
  "tab",
  "slider",
  "spinbutton",
  "searchbox",
]);
