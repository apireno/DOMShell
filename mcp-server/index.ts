import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express, { type Request, type Response, type NextFunction } from "express";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, openSync, readSync, writeSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

// Kept in sync with mcp-server/package.json and mcp-server/server.json.
// Surfaced by the domshell_about tool so integrators can pin-verify which
// server version answered a call, and echoed in the connection log for
// server-side triage.
const MCP_SERVER_VERSION = "2.0.10";

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
// Per-action terminal confirmation is OFF by default — the prompt lives in
// the MCP server's stdout/stderr, not in the agent or side panel, so it can
// only be answered by a user actively watching the server terminal. That's
// not the canonical setup (Claude Desktop / Cursor / CLI-Anything all spawn
// the server in the background). Tier flags (--allow-write, --allow-sensitive),
// the audit log, and domain allowlists remain the actual security boundaries.
// `--no-confirm` is preserved as an explicit no-op for any caller that still
// passes it (e.g. CLI-Anything's PR #135 config). `--confirm` re-enables the
// terminal-prompt path for users who run the server in their own terminal.
const NO_CONFIRM = !hasFlag("--confirm");
const EXPOSE_COOKIES = hasFlag("--expose-cookies");
const GRANULAR = hasFlag("--granular");  // expose the 38 per-command tools (ADR-002 D2)
// Singleton guard escape hatch (2.0.9 hardening). By default the server refuses
// to start a second WS bridge when it detects an existing DOMShell bridge on the
// same port across BOTH IPv4 and IPv6 loopback — the EADDRINUSE guard alone
// misses the native(127.0.0.1)+container(0.0.0.0-in-netns) collision that let a
// stale server squat for days (kgspin 2026-07). Pass --allow-duplicate to bypass
// (e.g. a deliberate multi-bridge test rig).
const ALLOW_DUPLICATE = hasFlag("--allow-duplicate");
// Port precedence: --port / --mcp-port flag wins, then our DOMSHELL_*
// env vars, then the generic MCP_PORT / PORT names ToolHive injects
// when it runs the container (target-port → random allocation passed
// as MCP_PORT env var; see toolhive runconfig spec), then default.
// This lets the container honour either docker compose (which sets
// DOMSHELL_MCP_PORT from the Dockerfile's ENV) or thv (which injects
// MCP_PORT directly) without per-deployment config drift.
const PORT = parseInt(
  getFlagValue("--port", "") ||
    process.env.DOMSHELL_WS_PORT ||
    "9876",
  10
);
const MCP_PORT = parseInt(
  getFlagValue("--mcp-port", "") ||
    process.env.DOMSHELL_MCP_PORT ||
    process.env.MCP_PORT ||
    "3001",
  10
);
// Bind address — defaults to loopback (127.0.0.1) so the server is reachable
// only from the same machine running it (the safe default for native installs).
// Precedence: --host flag (easiest to flip for one-off debugging) wins, then
// DOMSHELL_MCP_HOST env var (conventional way the Dockerfile injects
// 0.0.0.0 inside a container), then loopback default. Never set 0.0.0.0
// on a native install unless you explicitly want to expose DOMShell to
// your LAN (security risk: anyone on the network could drive the server
// with a valid token).
const HOST =
  getFlagValue("--host", "") ||
  process.env.DOMSHELL_MCP_HOST ||
  "127.0.0.1";
// Resolve to an ABSOLUTE path at startup (2.0.9). Previously this was a bare
// relative "audit.log", so if the process ever ran from (or was restarted into)
// a different cwd than expected, audit writes silently went to a different file
// than the one operators inspect at /app/audit.log — producing a coverage hole
// over exactly an incident window (kgspin 2026-07-26). Resolving once against
// the startup cwd pins the destination regardless of later cwd changes.
const LOG_FILE = resolvePath(getFlagValue("--log-file", "audit.log"));
const ALLOWED_DOMAINS = getFlagValue("--domains", "")
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

// ---- Auth Token ----

// Auth token — precedence: --token flag (easiest to flip for one-off
// debugging) wins, then DOMSHELL_TOKEN env var (conventional way the
// .env file injects it for Path 2 / Path 3 container installs), then
// fall back to a randomly-generated token printed at startup. The
// random fallback is for first-time `npx` users; persistent installs
// should always pin the token via flag or env so the Chrome extension
// can keep its saved `connect <token>` working across restarts.
const AUTH_TOKEN =
  getFlagValue("--token", "") ||
  process.env.DOMSHELL_TOKEN ||
  randomBytes(24).toString("hex");

// ---- Logging ----

function log(msg: string): void {
  process.stderr.write(`[DOMShell MCP] ${msg}\n`);
}

// Track whether audit writes are currently failing so a silent stop becomes a
// VISIBLE stderr warning (2.0.9). Previously write failures were swallowed
// entirely, so audit logging could stop and nobody would notice until an
// incident needed the log that wasn't there (kgspin 2026-07-26). We warn once
// on first failure and once on recovery — not per-line, to avoid log spam.
let auditWriteFailed = false;
function audit(entry: string): void {
  const line = `[${new Date().toISOString()}] ${entry}\n`;
  try {
    appendFileSync(LOG_FILE, line);
    if (auditWriteFailed) {
      auditWriteFailed = false;
      log(`Audit log writing recovered → ${LOG_FILE}`);
    }
  } catch (err: any) {
    if (!auditWriteFailed) {
      auditWriteFailed = true;
      log(`WARNING: audit log write failed for ${LOG_FILE}: ${err?.message ?? err}. Audit entries are being dropped until this recovers.`);
    }
  }
}

// ---- Command Tiers ----

const NAVIGATE_COMMANDS = new Set(["navigate", "goto", "open", "back", "forward"]);
// Note: `eval` moved into the write tier as of 2.0.8 (DOMSHELL-EVAL-READ-TIER-BYPASS-001).
// `eval` and `js` both dispatch to the same handleJs → CDP Runtime.evaluate path in the
// extension (src/background/index.ts:1849) with no side-effect-free evaluator, so any
// expression can mutate DOM/window state. Prior classification as read-tier contradicted
// the actual capability. See CHANGELOG 2.0.8 + the GHSA for details.
const WRITE_COMMANDS = new Set(["click", "focus", "type", "key", "scroll", "js", "eval", "select", "close", "call"]);
const SENSITIVE_COMMANDS = new Set(["whoami"]);

// ---- MCP Tool Annotations ----
//
// Per-tool hints surfaced to MCP hosts (Claude Desktop, Cursor, …) so they can
// render context-aware approval UIs rather than relying on the server to own
// the approval prompt. (#39 follow-up — m13v's framing.)
//
// All DOMShell tools talk to the browser, so openWorldHint: true is implicit.
// readOnlyHint / destructiveHint are the discriminating signals the host uses
// to decide how prominently to ask for human approval. Spec defaults are
// readOnlyHint=false, destructiveHint=true — we override only where they
// differ from the conservative default.
//
// These are hints, not policy. The server's own tier checks (--allow-write,
// --allow-sensitive) remain the actual security boundary.
const ANNO_READ      = { readOnlyHint: true,  openWorldHint: true } as const;
const ANNO_NAVIGATE  = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
const ANNO_WRITE     = { readOnlyHint: false, destructiveHint: true,  openWorldHint: true } as const;
const ANNO_SENSITIVE = { readOnlyHint: false, destructiveHint: true,  openWorldHint: true } as const;

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

// Whether the parent has an interactive terminal we can prompt on. Cached at
// module load — a GUI MCP client (Claude Desktop, Cursor, …) launches us with
// stdin/stdout wired to its MCP transport and stderr piped to its own log,
// none of them TTYs. Probing /dev/tty in that case can succeed only to deadlock
// later on the synchronous readSync, freezing the entire event loop. (#39)
const HAS_INTERACTIVE_TTY: boolean = !!(
  process.stderr && (process.stderr as any).isTTY
);

function confirmAction(description: string): Promise<boolean> {
  if (NO_CONFIRM) return Promise.resolve(true);

  if (!HAS_INTERACTIVE_TTY) {
    // No human at the keyboard. Don't pretend; don't try /dev/tty (it can hang
    // the whole process on a synchronous readSync). Deny clearly so the agent
    // gets an actionable error pointing at the right CLI flag. (#39)
    log(`WARNING: Cannot confirm '${description}' — no interactive terminal attached.`);
    log("Remove --confirm from the MCP server args to auto-approve in non-interactive (GUI-spawned) mode (--confirm is opt-in; the default is auto-approve).");
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const fd = openSync("/dev/tty", "r+");
      const prompt = `\n[DOMShell] Claude wants to: ${description}\nAllow? (y/n): `;
      writeSync(fd, prompt);

      // Note: readSync is synchronous and blocks the event loop until input is
      // received. The setTimeout below cannot fire while we're parked here. The
      // HAS_INTERACTIVE_TTY guard above is what actually prevents the hang in
      // non-interactive contexts. (#39)
      const buf = Buffer.alloc(10);
      const bytesRead = readSync(fd, buf, 0, 10, null);
      const answer = buf.slice(0, bytesRead).toString().trim().toLowerCase();

      if (timer !== undefined) clearTimeout(timer);
      resolve(answer === "y" || answer === "yes");
    } catch {
      // /dev/tty open failed even though isTTY was true — fall back to deny.
      if (timer !== undefined) clearTimeout(timer);
      log("WARNING: Cannot open /dev/tty for confirmation. Denying write action.");
      log("Remove --confirm from the MCP server args to auto-approve (per-action prompts are opt-in; off by default).");
      resolve(false);
    }

    // Best-effort backstop in case openSync/readSync gets into a weird state
    // we didn't anticipate. (See note above — this timeout cannot save us from
    // a blocking readSync; HAS_INTERACTIVE_TTY does that work.)
    timer = setTimeout(() => resolve(false), 60000);
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
let extensionGrouping = false;                 // connected extension supports tab grouping? (HELLO, ADR-001 D11)
// Populated from the HELLO handshake; surfaced by domshell_about so
// integrators can pin-verify which extension is actually bridged (vs.
// reading a stale log line). Reset to null on ws close.
let extensionVersion: string | null = null;
let extensionConnectedAt: string | null = null;
// Multi-session (PRD-002 Phase 2): no single-session limit — concurrent MCP
// clients each get their own session. This tracks SESSION_START messages not
// yet delivered (the extension was offline when the session initialized);
// they are delivered on the next HELLO, once.
const pendingSessionStarts = new Set<string>();
const pendingRequests = new Map<
  string,
  {
    resolve: (r: { result: string; laneId: string | null }) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

// ---- Singleton guard (2.0.9 hardening) ----
//
// The wss.on("error") EADDRINUSE check below only catches a same-scope collision.
// It misses the real-world case that let a stale server squat for days: a native
// server binds 127.0.0.1:9876 while a container binds 0.0.0.0:9876 INSIDE its own
// network namespace (Docker maps it to the host as IPv6 *:9876). Different host
// scopes -> no EADDRINUSE -> both run silently, the extension attaches to whichever
// owns the interface it dialed, and the other becomes an invisible squatter that
// proxies relay to (kgspin 2026-07). This pre-bind probe closes that gap: it opens a
// WS to BOTH 127.0.0.1 and ::1 on our port with a deliberately-invalid token. A
// DOMShell bridge answers by completing the upgrade then closing with code 4001
// (our invalid-token close code); any successful upgrade means a WS bridge already
// owns the port. If detected, refuse to start (unless --allow-duplicate) so a second
// bridge can't silently coexist. A refused/failed connection means the port is free.
async function detectExistingBridge(port: number): Promise<string | null> {
  for (const host of ["127.0.0.1", "::1"]) {
    const hostForUrl = host.includes(":") ? `[${host}]` : host;
    const found = await new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };
      let probe: WebSocket;
      try {
        probe = new WebSocket(`ws://${hostForUrl}:${port}?token=domshell-singleton-probe-invalid`);
      } catch { done(false); return; }
      const timer = setTimeout(() => { try { probe.close(); } catch {} done(false); }, 1500);
      // A completed upgrade (open) OR a 4001 close both mean a WS bridge is there.
      probe.on("open", () => { clearTimeout(timer); try { probe.close(); } catch {} done(true); });
      probe.on("close", (code: number) => { clearTimeout(timer); done(code === 4001); });
      probe.on("error", () => { clearTimeout(timer); done(false); }); // connection refused -> free
    });
    if (found) return host;
  }
  return null;
}

const existingBridgeHost = await detectExistingBridge(PORT);
if (existingBridgeHost && !ALLOW_DUPLICATE) {
  log(`ERROR: another DOMShell WS bridge is already listening on ${existingBridgeHost}:${PORT}.`);
  log("Refusing to start a second bridge — two DOMShell servers on one machine collide:");
  log("the browser extension attaches to only one, and the other becomes an invisible");
  log("squatter that MCP clients/proxies silently relay to (stale-version, wrong-lane bugs).");
  log("Fix: use ONE server per machine (the container/ToolHive OR a single native npx —");
  log("never both). Stop the other server, or pass --allow-duplicate if this is deliberate.");
  process.exit(1);
}
if (existingBridgeHost && ALLOW_DUPLICATE) {
  log(`WARNING: another DOMShell WS bridge is on ${existingBridgeHost}:${PORT}; starting anyway (--allow-duplicate).`);
}

const wss = new WebSocketServer({ port: PORT, host: HOST });

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
  log(`WebSocket bridge listening on ws://${HOST}:${PORT}`);
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
  extensionConnectedAt = new Date().toISOString();
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
          pending.resolve({ result: msg.result ?? "", laneId: msg.groupId ?? null });
        }
      } else if (msg.type === "HELLO") {
        // Capability handshake (ADR-001 D11). Version + grouping capability
        // are cached on this WS holder for the domshell_about tool.
        extensionGrouping = Array.isArray(msg.capabilities) && msg.capabilities.includes("grouping");
        extensionVersion = typeof msg.version === "string" && msg.version ? msg.version : null;
        log(`Extension v${msg.version ?? "?"} connected — grouping ${extensionGrouping ? "supported" : "NOT supported (legacy mode)"}`);
        audit(`HELLO: extension v${extensionVersion ?? "?"} grouping=${extensionGrouping}`);
        // Deliver SESSION_START once per session: if a session is active but
        // SESSION_START has not reached the extension yet (it connected after
        // the session began, or an earlier send dropped), send it now. NOT on
        // every reconnect — doing that spawned a duplicate agent group each time.
        if (extensionGrouping && pendingSessionStarts.size > 0) {
          for (const sid of [...pendingSessionStarts]) {
            log(`→ delivering deferred SESSION_START to extension (session ${sid})`);
            if (sendToExtension({ type: "SESSION_START", sessionId: sid, mode: "isolated" })) {
              pendingSessionStarts.delete(sid);
            }
          }
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
      extensionVersion = null;
      extensionGrouping = false;
      extensionConnectedAt = null;
      log("Extension disconnected");
      audit("DISCONNECTED: extension");
    }
  });

  ws.on("error", () => {
    if (extensionClient === ws) {
      extensionClient = null;
      extensionVersion = null;
      extensionGrouping = false;
      extensionConnectedAt = null;
    }
  });
});

// ---- Send Command to Extension ----

/** Fire-and-forget a control message to the extension (SESSION_START/END, etc.). */
function sendToExtension(obj: Record<string, unknown>): boolean {
  if (extensionClient && extensionClient.readyState === 1) {
    extensionClient.send(JSON.stringify(obj));
    return true;
  }
  log(`⚠ sendToExtension: dropped a '${obj.type ?? "?"}' message — extension socket not open`);
  return false;
}

function sendCommand(
  command: string,
  sessionId: string,
  groupId?: string,
  initialUrl?: string,
  groupName?: string,
  windowId?: number,
): Promise<{ result: string; laneId: string | null }> {
  return new Promise((resolve, reject) => {
    if (!extensionClient || extensionClient.readyState !== 1) {
      reject(new Error("Extension not connected. Open the DOMShell side panel and run: connect <token>"));
      return;
    }

    const id = randomBytes(8).toString("hex");
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error("Command timed out after 150 seconds"));
    }, 150000);

    pendingRequests.set(id, { resolve, reject, timer });

    // initialUrl + groupName are forwarded as optional fields on the
    // EXECUTE message. Extension 1.3.2+ honors them when groupId === "new":
    //   - initialUrl loads the URL into the lane's working tab at creation
    //     instead of about:blank
    //   - groupName titles the Chrome tab group as `🐚 <groupName>` instead
    //     of the hard-coded `🐚 agent`, letting integrators give lanes
    //     deterministic names for garbage-collection sweeps
    // Extension 1.3.1 silently ignores unknown JSON fields, so both are
    // forward-compatible: old extensions still create an about:blank tab
    // titled `🐚 agent` (existing behavior; no regression). Tracked
    // kernel-side as DOMShell #52.
    //   - windowId (2.0.10) pins the new lane's working tab to a specific
    //     (normal) Chrome window. Honored by extension 1.3.5+; silently
    //     ignored by older extensions (tab lands in the current window as
    //     before — no regression). See DOMShell window-targeting.
    extensionClient.send(
      JSON.stringify({
        type: "EXECUTE",
        id,
        sessionId,
        groupId,
        initialUrl,
        groupName,
        windowId,
        command,
        allowedDomains: ALLOWED_DOMAINS.length > 0 ? ALLOWED_DOMAINS : undefined,
      })
    );
  });
}

async function execWithSecurity(
  command: string,
  sessionId: string,
  groupId?: string,
  initialUrl?: string,
  groupName?: string,
  windowId?: number,
): Promise<{ result: string; laneId: string | null }> {
  // Check tier
  const check = isCommandAllowed(command);
  if (!check.allowed) {
    audit(`DENIED: ${command} — ${check.reason}`);
    return { result: `Error: ${check.reason}`, laneId: null };
  }

  const tier = getCommandTier(command);

  // Confirm write actions
  if (tier === "write") {
    const approved = await confirmAction(command);
    if (!approved) {
      audit(`[WRITE] DENIED by user: ${command}`);
      return { result: "Action denied by user.", laneId: null };
    }
  }

  // Execute
  const tag = tier === "write" ? "[WRITE] " : tier === "navigate" ? "[NAV] " : tier === "sensitive" ? "[SENSITIVE] " : "";
  audit(`${tag}EXECUTE: ${command}`);

  try {
    const r = await sendCommand(command, sessionId, groupId, initialUrl, groupName, windowId);
    const result = redactSensitiveOutput(command, r.result);
    // Give error-ish results a generous cap so the actual cause survives in the
    // audit log (2.0.9). The prior flat 80-char truncation ate mint-failure
    // reasons down to "Groupi..." (kgspin 2026-07-26) — losing the one string
    // that would have identified the Chrome grouping error. Normal (non-error)
    // results keep the compact 80-char summary to keep the log readable.
    const isErrorish =
      /\x1b\[31m/.test(result) ||
      /^Error:/.test(result) ||
      result.includes("failed to create group");
    const cap = isErrorish ? 1000 : 80;
    const summary = result.length > cap ? result.slice(0, cap) + "..." : result;
    audit(`${tag}RESULT: ${summary}`);
    return { result, laneId: r.laneId };
  } catch (err: any) {
    audit(`${tag}ERROR: ${err.message}`);
    return { result: `Error: ${err.message}`, laneId: null };
  }
}

// ---- MCP Server Factory ----
// Each MCP client session gets its own McpServer instance.
// All instances share the same WebSocket bridge to the Chrome extension.

const MCP_INSTRUCTIONS = `DOMShell gives you full browser control through a filesystem metaphor. The DOM's Accessibility Tree (AXTree) is mapped to directories (containers like navigation/, main/, form/) and files (interactive elements like submit_btn, search_input, login_link). The browser itself (windows, tabs) is also part of the hierarchy.

INTERFACE — ONE TOOL
You drive DOMShell through a single tool: domshell_execute. Pass a command string ("ls", "cd tabs/123", "text main"). To run a whole workflow in ONE call, pass MULTIPLE commands separated by newlines — each line runs in order and the combined output is returned. Lines share session/lane state (cwd, env, history persist between lines), and an error on one line does NOT halt the rest — its message is included in the combined output and subsequent lines still run. That's the right shape for cleanup-line idioms like "cd path \\n grep pattern \\n cd back".
  domshell_execute("open https://example.com\\ncd main\\ntext")
Most commands accept relative paths, so you rarely need a separate cd: "text main/article", "click form/submit_btn".
NAMING NOTE: this guide sometimes writes a command as "domshell_<name>" (e.g. domshell_text) — that simply means the "<name>" command (e.g. "text"). Run any command via domshell_execute, e.g. domshell_execute("text main"). (If the server was started with --granular, each command is ALSO exposed as its own domshell_<name> tool — but domshell_execute is the primary, recommended interface.)

COMMAND REFERENCE
Browser & tabs: tabs · windows · here · cd <path> · open <url> · navigate <url> · back · forward · close [id] · group [new|attach|detach|close|list]
Reading: ls [--meta --text --json] · cat <name> · text [name] [--links] · tree [depth] · read [name] · grep [-r] <pattern> · find [--type ROLE --meta --text] <pattern> · extract_links · extract_table <name> · screenshot · diff
Interacting (write tier, needs --allow-write): click <name> · focus <name> · type <text> · key <KeyName> [--modifiers ctrl,shift,…] [--activate] · select <name> <value> · scroll down|up|<name> · submit <input> <value> · wait <pattern>
JavaScript: eval <expr> (write tier) · js <code> (write tier) · functions [pattern] · call <fn> <args>
Workflow: watch <cmd> [--until-change] · for "<cmd>" : <template> · script save|run|list|show|delete · each [--pattern F] <cmd> · bookmark <name> · env · export · history · pwd · refresh

LANES (your isolated workspace)
Every domshell_execute reply ends with a "[lane: <id>]" line — your current lane. A lane is an isolated workspace: its own current tab, DOM cursor, and Chrome tab group, scoped so commands cannot see or touch the user's tabs or any other client's tabs. Inside an isolated lane, tabs / windows / cd are ALL confined to its group.

Your MCP connection gets its OWN lane automatically. You typically need nothing more — just call domshell_execute and the default lane handles it.

When you need MULTIPLE lanes — parallel tasks, or you share one MCP connection with another agent (Claude Desktop multiplexes every chat over one connection, so two chats would land in one lane by default) — use the group_id parameter on domshell_execute:
  • group_id "new"        → create a fresh isolated lane. Its id comes back in the [lane:] line. Carry that id on every later call. **RECOMMENDED for any drive that interacts with the page.**
  • group_id "<id>"       → join the lane with that numeric id. HANDOFF: another agent can give you its lane id to continue its work in the same state.
  • group_id "shared"     → operate without isolation. **IMPORTANT SEMANTIC NOTE:** today this maps to a per-connection isolated lane, but in DOMShell 3.0.0 / extension 1.3.2 this will shift to mean "no isolation — your commands run against the user's actual browser tabs." If you want a private workspace, do NOT use "shared" — use group_id="new". Use "shared" only when you deliberately want to read/affect the user's existing tabs (e.g. a side-panel-style helper that operates on whatever the user is currently looking at).
  • group_id omitted      → DEPRECATED. Currently maps to "shared" and emits a [DEPRECATION] warning. Future major release will require an explicit group_id AND will inherit the "shared" semantic shift above.

If you only ever interact with the page, the rule is: pass group_id="new" on the first call, capture the returned [lane: <id>] marker, pass that id on every later call. Don't use "shared" unless you have a specific reason to operate on the user's real browser.

FRESH LANE WITH A KNOWN URL + NAME (recommended)
When you pass group_id="new", pass two optional fields on the same call for a cleaner setup:
  domshell_execute({
    command: "text main",
    group_id: "new",
    initial_url: "https://example.com/article",
    group_name: "qa-ux-shopkit-sprint12"
  })

- initial_url loads the URL into the lane's working tab at creation (no about:blank placeholder, no extra 'open <url>' round-trip, cursor lands inside the loaded tab).
- group_name titles the Chrome tab group so you and downstream sweeps can identify it later.

Honored by DOMShell extension 1.3.2+; silently ignored by extension 1.3.1 — older extensions still create an about:blank tab titled 'agent', so the worst case is the existing behavior. Safe to always pass both.

CHOOSING THE WINDOW FOR A NEW LANE (window_id)
A lane group can ONLY be created in a *normal* Chrome window. Without window_id, the lane's tab is created in Chrome's CURRENT window — and if that happens to be a popup, devtools, or an installed-PWA/app window, the mint fails. To be deterministic (and to place your lane away from the operator's real tabs), pick the window yourself:

1) Enumerate windows and find a normal one. From shared mode (a fresh connection, before you mint), run:
     domshell_execute({ command: "ls --json ~/windows" })     // or: command: "windows"
   Each window reports a 'type': "normal" | "popup" | "app" | "devtools". Only "normal" can host a lane.
2) Pass that window's id as window_id when you mint:
     domshell_execute({
       command: "text main",
       group_id: "new",
       group_name: "qa-ux-shopkit-sprint12",
       initial_url: "https://example.com/article",
       window_id: 386959650
     })
3) If there are NO normal windows open, do not mint blindly — tell the user to open a normal browser window, then retry. (A bad or non-normal window_id returns a clear error: "window <id> is a '<type>' window" / "window <id> not found".)

NOTE on enumeration: when you are already ATTACHED to a lane, 'windows' / 'ls ~/windows' list only that lane's tabs — so enumerate windows from shared mode BEFORE you mint, not from inside an existing lane.

window_id is honored by DOMShell extension 1.3.5+; silently ignored by older extensions (the tab lands in the current window as before — no regression). Ignored unless group_id="new".

LANE NAMING + GARBAGE COLLECTION (your responsibility)
Every lane you create with group_id="new" is a Chrome tab group that persists until something closes it. Leaving lanes open after your task is done leaks tabs and clutters the user's browser. Two patterns to apply, in order of preference:

1) Name your lane on creation. Pass group_name with a stable, deterministic identifier:
     <task-type>-<scope>-<run-id-or-sprint>
   Examples: "qa-ux-shopkit-sprint12", "research-articles-2026-06-18", "scrape-prices-acme-run42".
   Why: it makes BOTH inline cleanup AND batch sweeps reliable.

2) Capture the [lane: <id>] from the first reply and reuse it for the WHOLE drive. Never re-mint a lane mid-drive.

3) Close on the way out (every drive). Either inline (try/finally on the integrator side) or via an end-of-round sweep:
     # list lanes (run with any group_id, e.g. "shared")
     domshell_execute({ command: "group list", group_id: "shared" })
     # close one (uses the lane's numeric id from the list)
     domshell_execute({ command: "group close", group_id: "<numeric-id>" })

A batch sweep ("close everything matching qa-ux-*") is the integrator's responsibility — list the lanes, filter by your naming convention, close each id in turn.

CLEAN UP YOUR LANES WHEN YOU FINISH
If you CREATED a lane (you passed group_id "new"), CLOSE IT when your task is done — run command "group close" with that same group_id. Don't leave orphan tab groups for the user to clean up.
If you did NOT create the lane (the default connection lane, or one another agent handed you), don't close it without permission — ask the user first, then run "group close" only if they agree.

In-shell group commands (run via the command string): group (status) · group new [name] · group attach <id> · group detach · group close · group list. To carve multiple lanes from ONE MCP connection, prefer the group_id PARAMETER — the in-shell "group new" command changes your current lane's binding, while group_id "new" creates a separate, addressable lane.

WHEN TO USE DOMSHELL (prefer over native browser tools):
- Navigating to websites: use domshell_navigate or domshell_open
- Going back/forward: domshell_back / domshell_forward (faster than re-navigating, uses browser cache)
- Listing/switching tabs: use domshell_tabs, then domshell_cd with "~/tabs/<id>"
- Closing tabs: domshell_close to clean up after extraction
- Reading page content: domshell_text for bulk text, domshell_cat for element metadata, domshell_tree for structure
- Visual inspection: domshell_screenshot to see the page layout (great for unfamiliar sites)
- Finding elements: domshell_find (deep recursive) or domshell_grep (current directory)
- Getting URLs/hrefs: domshell_cat on a link shows its URL, or domshell_find with --meta --type link
- Scrolling to see more content: domshell_scroll down/up, or scroll a specific element into view
- Complex DOM queries: domshell_js for CSS selectors, batch extraction, or computed values
- JS expression evaluation: domshell_eval (write tier — see note below on the 2.0.8 tier change)
- Interacting: domshell_click, domshell_focus, domshell_type, domshell_select (dropdowns)
- Waiting for dynamic content: domshell_wait to poll for elements on SPA/AJAX pages
- Detecting changes: domshell_diff after clicks/submissions to see what was added, removed, or changed in the DOM
- Saving locations: bookmark paths with domshell_execute "bookmark name", jump back with domshell_cd "@name"
- Discovering page functions: domshell_functions to list callable window functions (optionally filter by pattern)
- Calling page functions: domshell_call to invoke a global function (write-tier)
- Monitoring changes: domshell_watch to re-run a command periodically. Use --until-change to stop when output changes.
- Batch operations on output: domshell_for to iterate over command output lines, replacing {} in a template
- Reusable workflows: domshell_script to save and run multi-command scripts with $1, $2 variable substitution
- Cross-tab operations: domshell_each to run a command in every matching tab

TYPICAL WORKFLOW:
1. Enter a tab: domshell_here (focused tab), domshell_cd with "%here%" (composable), or domshell_open (new tab)
2. Understand structure: domshell_screenshot (visual overview), domshell_tree (AX structure), domshell_ls (children)
3. Extract content: domshell_text (bulk text — much faster than multiple cat calls)
4. Find specific elements: domshell_find with pattern or --type (e.g. --type link, --type button)
5. Scroll to reach content: domshell_scroll down (page) or domshell_scroll with target (element into view)
6. Inspect element details: domshell_cat shows full metadata — AX role, DOM tag, href/src/id/class, text, outerHTML
7. Interact: domshell_click, domshell_focus + domshell_type, domshell_select (dropdowns)
8. Advanced extraction: domshell_js for batch DOM queries (e.g. extract all comments in one call via CSS selectors)
8b. Discover page APIs: domshell_functions to find callable JS functions. Use domshell_eval "mw.config.get(...)" to access discovered APIs.
9. Detect changes: domshell_diff after clicks/submissions to see exactly what changed (added/removed/modified elements)
10. Navigate back: domshell_back to return to previous page (faster than re-navigating, preserves browser history)
11. Clean up: domshell_close to close tabs when done extracting

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
- domshell_text with --links option inlines hyperlink URLs as markdown [text](url) within the text content. Use "text --links" to get article text with clickable links preserved.

IMPORTANT TIPS:
- Element names are human-readable (e.g. "Sign_in_btn", "Search_input") not CSS selectors.
- Use domshell_text for reading article content — it's one call vs. dozens of cat calls.
- Use domshell_find --type link --meta to extract all URLs from a page.
- find --type accepts natural aliases: input (textbox/searchbox/combobox), dropdown (combobox/listbox), nav (navigation), btn (button), toggle (switch/checkbox), modal (dialog), image (img), sidebar (complementary).
- Directories (navigation/, main/) are containers you cd into. Files (submit_btn, logo_link) are leaf elements you cat or click.
- Use domshell_scroll to reach below-the-fold content. Scroll returns position percentage so you know where you are on the page.
- Use domshell_scroll with a target element name to jump directly to a section (e.g. scroll see_also_heading).
- Use domshell_js to batch complex extractions into a single call — e.g. extract all comments, all table rows, or all links matching a CSS selector.
- Prefer domshell_text/domshell_find for simple extraction (more structured). Use domshell_js when you need CSS selectors or would otherwise need 3+ calls.
- Use domshell_back instead of domshell_navigate to return to a previous page — it's faster (browser cache) and doesn't require remembering the URL.
- Use domshell_screenshot on unfamiliar pages to see the layout before starting extraction — one visual can replace multiple exploration calls.
- Use domshell_wait after clicks/navigation that trigger async content loading (SPAs, AJAX) instead of retry loops with refresh + find.
- Use domshell_select for <select> dropdowns instead of js-based workarounds.
- For keyboard-activated SPA elements (LinkedIn's conversation rows, Notion blocks, Twitter compose, anywhere a div has tabindex="0" and React listens for Enter rather than click): focus + key. The dispatch auto-selects between synthetic and trusted based on whether the target tab is the active tab in its window. If you need a trusted event (event.isTrusted === true — required by React-driven SPAs that guard activation) and the tab is in the background, pass --activate to the key call (key Enter --activate). It briefly makes the tab active, dispatches the trusted event, then restores the previously-active tab. Brief visible flicker for the human — pay the cost only when isTrusted matters. The reply marks which path was used.
- Use domshell_eval for one-off JS expressions (document.title, element counts) and domshell_js for larger scripts. Both require --allow-write as of 2.0.8 — they share the same CDP Runtime.evaluate path and can mutate DOM/window state, so the prior "eval is read-only" classification was retired (GHSA / CHANGELOG 2.0.8).
- Use --json flag via domshell_execute for machine-parseable output (e.g. "ls --json", "cat --json name", "find --json --type link").
- Use domshell_diff after clicks/submissions to see what changed — replaces re-exploration with ls/find.
- Save frequently-visited paths with domshell_execute "bookmark name", then jump back with domshell_cd "@name".
- Shell state (path, env, bookmarks, scripts, history) persists across service worker restarts — no need to re-navigate after extension reloads.
- Use domshell_functions to discover callable JS functions on the page. Use domshell_call to invoke them (write-tier).
- Use domshell_watch to monitor changes by re-running a command periodically. Add --until-change to stop early when output differs.
- Use domshell_for to iterate over command output — {} in the template is replaced with each line.
- Use domshell_script to save reusable workflows. Run with "run name arg1 arg2" — $1, $2 are replaced with args.
- Use domshell_each to run a command across multiple tabs in one call (optionally --pattern filter).
- The AXTree auto-refreshes after clicks/navigation — no manual refresh needed.

EFFICIENT PATTERNS:
1. Scoped Extraction: open URL → cd main/article → find --type heading (locate section) → cd section → text (content) + find --type link --meta (links)
2. Table Reading: find --type table → text table_element (reads ALL rows at once). For structured data, read the whole table, don't read row-by-row.
3. Section Discovery: grep "section_name" (recursive: true) OR find "section_name". NOT ls --offset pagination (too many calls).
4. Link Extraction: cd into the container with links → find --type link --meta. Use --text with a pattern to filter by visible text: find --type link --text "keyword" --meta. For inline links within text: text --links (preserves [text](url) markdown in the output).
5. Form Interaction: find --type textbox → focus input → type "query" → click submit_button. If page doesn't navigate, use domshell_navigate as fallback.
6. Path Resolution: All commands accept relative paths — text main/article/paragraph, cat nav/logo_link, click form/submit_btn. Saves cd round-trips.
7. Sibling Navigation: find --type heading "section" → cd container → ls --after section_heading -n 5 --text (elements after a heading). Combines with --type: ls --after intro --type link --meta.
8. Below-the-fold Content: scroll down → ls --text (see what's visible). For known targets: find --type heading → scroll target_heading → text nearby_content. Returns position as percentage for orientation.
9. Batch Extraction with JS: js [...document.querySelectorAll('.item')].map(el => ({title: el.querySelector('a').textContent, url: el.querySelector('a').href})) — one call replaces multiple find + cat calls. Use for repetitive extraction patterns.
10. Multi-page Navigation: open page1 → extract → navigate page2 → extract → back (returns to page1 via browser history). Use back instead of re-navigating — it's faster and preserves scroll position.
11. Visual-first Exploration: screenshot (see layout) → js (targeted extraction based on what you see). Replaces tree → ls → find exploration on unfamiliar sites.
12. Dynamic Content: click button → wait results_list → text results_list. Use wait instead of refresh + find retry loops.
13. Change Detection: click button → diff → extract new content. Diff shows exactly what appeared/disappeared.
14. Bookmarked Paths: bookmark inbox → (work elsewhere) → cd @inbox to jump back. Saves re-navigation in multi-tab workflows.
15. Structured Output: ls --json, cat --json name, find --json --type link for machine-parseable JSON. Eliminates text parsing.
16. Iterating Over Results: for "find --type link -n 5" : cat {} — runs cat on each of the first 5 links. Replaces manual iteration with N separate calls.
17. Cross-tab Summary: each --pattern wiki eval document.title — gets the title of every Wikipedia tab in one call.
18. Reusable Scraping: script save scrape open URL ; cd main ; text ; close — then script run scrape to replay.
19. Watch for Changes: watch "eval document.querySelector('.counter').textContent" --until-change --interval 1 — stops as soon as the value changes instead of burning all iterations.
20. Parameterized Scripts: script save search open https://en.wikipedia.org ; submit search_input $1 — then script run search "machine learning" (replaces $1 with arg).

MULTI-STEP AUTOMATION PATTERNS (combine Sprint 3 features for maximum efficiency):
- Multi-tab extract: open URL1 → open URL2 → each --pattern filter eval <JS> (one call extracts from all matching tabs)
- Discover-and-visit: for "eval [...links].map(a=>a.href).join('\\n')" : open {} (opens N tabs from discovered URLs in one call)
- Bulk iteration: for "find --type heading -n 5" : cat {} (runs a command on each discovered element)
- Save & replay with args: script save name cmd1 ; cmd2 → script run name "arg1" ($1 replaced with arg1). IMPORTANT: quote multi-word args: script run search "Artificial intelligence" (NOT script run search Artificial intelligence)
- Monitor until change: watch "eval element.textContent" --until-change --interval 1 (returns when value changes, not after N iterations)
- Discover-visit-extract pipeline: open page → for "eval [URLs]" : open {} → each --pattern filter eval <JS> (3 calls replaces 2N+1)

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
- Do NOT repeatedly ls --offset to find content far down the page — use scroll down + ls --text, or find the target element and scroll it into view
- Do NOT use navigate to return to a previous page — use back instead (browser cache makes it instant, no URL tracking needed)
- Do NOT use multiple ls/find calls to understand an unfamiliar page layout — use screenshot first for instant visual orientation, then targeted extraction
- Do NOT poll with repeated find calls for dynamic content — use wait <pattern> to block until the element appears
- Do NOT use js to set dropdown values — use select <name> <value> for proper event dispatch
- Do NOT re-explore with ls/find after a click/submit — use diff to see exactly what changed
- Do NOT assume domshell_eval is side-effect-free — as of 2.0.8 it's write-tier alongside domshell_js (both dispatch to the same CDP Runtime.evaluate path). If you need read-only DOM inspection, use domshell_cat / domshell_text / domshell_find; if you need JS evaluation and have --allow-write, prefer domshell_eval for one-off expressions and domshell_js for multi-line scripts
- Do NOT manually iterate with separate calls when for can do it — for "find --type heading -n 5" : text {} replaces 5 separate text calls
- Do NOT switch tabs manually to repeat an operation — use each --pattern filter cmd to run across all matching tabs in one call
- Do NOT open tabs one-by-one to extract from each — use for "eval [URLs]" : open {} to open them, then each --pattern filter eval <JS> to extract (2 calls instead of 2N)
- Do NOT make N separate eval calls for N items — use for "eval [items]" : eval <per-item query> (1 call instead of N)
- Do NOT poll with separate tool calls to detect changes — use watch "cmd" --until-change to monitor within a single call

Note: per-action terminal confirmation is OFF by default. Add --confirm to the server args if you want a y/n prompt in the server's terminal before every write action. The audit log captures every command either way.`;

function createMcpServer(sidRef: { sid: string }): McpServer {
  const server = new McpServer(
    // version reflects the real server version (2.0.9 hardening) — was a stale
    // hardcoded "1.0.0", which made the MCP `initialize` serverInfo useless for
    // identifying which DOMShell instance a client/proxy actually reached.
    { name: "domshell", version: MCP_SERVER_VERSION },
    { instructions: MCP_INSTRUCTIONS }
  );

  // Every tool runs commands through this closure so each EXECUTE carries the
  // MCP session id — the extension routes it to that session's own lane
  // (PRD-002 Phase 2). sidRef.sid is filled by onsessioninitialized before any
  // tool can be invoked. (Shadows the module-level execWithSecurity by design.)
  const executeWithSecurity = (command: string) =>
    execWithSecurity(command, sidRef.sid).then((r) => r.result);

  // -- Read tier tools (always available) --

  // Granular per-command tools (ADR-002 D2) — registered only with --granular.
  // Default mode exposes domshell_execute alone (registered below). Block left
  // un-reindented to keep the diff reviewable; see ADR-002.
  if (GRANULAR) {
  server.tool(
    "domshell_tabs",
    "List all open browser tabs with their IDs, titles, URLs, and window info. Use this to find the right tab before switching. Equivalent to 'ls ~/tabs/'.",
    {},
    ANNO_READ,
    async () => ({
      content: [{ type: "text", text: await executeWithSecurity("tabs") }],
    })
  );

  server.tool(
    "domshell_here",
    "Jump to the active tab in the last focused Chrome window. Use this to quickly enter whichever tab the user is currently looking at, without needing to know the tab ID.",
    {},
    ANNO_READ,
    async () => ({
      content: [{ type: "text", text: await executeWithSecurity("here") }],
    })
  );

  server.tool(
    "domshell_ls",
    "List children of the current directory. In the DOM tree: shows elements as files and directories. At the browser level (~): shows tabs/windows.\n\nFlags:\n  -l              Long format (more detail per element)\n  --meta          Show DOM properties (href, src, id) inline — great for extracting links\n  --text          Show visible text preview per element\n  -r              Recursive listing\n  -n N            Limit to N results\n  --offset N      Skip first N children (pagination)\n  --type ROLE     Filter by AX role (link, heading, button, etc.)\n  --count         Just count children\n  --textlen N     Max chars for text preview (default 80)\n  --after NAME    Show only children after the named element (sibling navigation)\n  --before NAME   Show only children before the named element (sibling navigation)\n\nSibling navigation: Use --after/--before to find content relative to a landmark. Example: ls --after See_also_heading -n 3 --text shows the 3 elements after a heading. Combines with --type: ls --after intro --type link --meta.\n\nPipe support: ls output can be piped into grep for filtering: ls --text | grep keyword.\n\nBest for: viewing immediate children of the current element.\nNOT recommended for: searching deep in the tree — use domshell_find or domshell_grep instead.",
    { options: z.string().optional().describe("Flags and options, e.g. '-l', '-n 10', '--type button', '--text', '--meta --text', '--after heading_name', or '~/tabs/' for tab listing") },
    ANNO_READ,
    async ({ options }) => ({
      content: [{ type: "text", text: await executeWithSecurity(`ls ${options ?? ""}`.trim()) }],
    })
  );

  server.tool(
    "domshell_cd",
    "Change directory — sets your scope for all subsequent commands (ls, find, grep, text all operate relative to current directory).\n\nPaths: 'main/form', '..', '~' (browser root), '~/tabs/<id>', '~/tabs/<pattern>', '%here%' (focused tab).\n\nWhen to cd:\n  - cd into a SECTION (article, main, sidebar) to scope find/grep/ls to that area\n  - cd into ~/tabs/<id> to switch between tabs\n  - cd .. to go up when done with a section\n\nWhen NOT to cd:\n  - To read a child's text: use 'domshell_text' with the name parameter instead (saves a cd + cd .. round trip)\n  - To inspect a child: use 'domshell_cat' with the name parameter instead\n  - To extract links: domshell_find --type link --meta works from the current directory",
    { path: z.string().describe("Path: DOM path, '~', '~/tabs/<id>', '~/windows/<id>', '%here%', '..', '/'") },
    ANNO_READ,
    async ({ path }) => ({
      content: [{ type: "text", text: await executeWithSecurity(`cd ${path}`) }],
    })
  );

  server.tool(
    "domshell_pwd",
    "Print the current working directory path in the DOM tree.",
    {},
    ANNO_READ,
    async () => ({
      content: [{ type: "text", text: await executeWithSecurity("pwd") }],
    })
  );

  server.tool(
    "domshell_cat",
    "Read detailed metadata about a DOM element: role, type, AX ID, DOM backend ID, value, child count, text content (textContent), visible text (innerText — only rendered text, respects CSS visibility), and outerHTML snippet.",
    { name: z.string().describe("Name or path of the element (e.g. 'link_name' or 'main/link_name')") },
    ANNO_READ,
    async ({ name }) => ({
      content: [{ type: "text", text: await executeWithSecurity(`cat ${name}`) }],
    })
  );

  server.tool(
    "domshell_find",
    "Deep recursive search from the CURRENT DIRECTORY downward. Scope matters: cd into a section first, then find, to get only that section's elements (fewer, more relevant results). Returns full paths to matching elements.\n\nKey flags:\n  --type ROLE   Filter by AX role. Accepts exact roles (link, button, heading, textbox, table, list)\n                AND natural aliases: input→textbox/searchbox/combobox, dropdown→combobox/listbox,\n                nav→navigation, sidebar→complementary, toggle→switch/checkbox, modal→dialog,\n                image→img, searchbar→searchbox/search, btn→button, anchor→link, header→banner,\n                footer→contentinfo, field→textbox/searchbox/combobox, select→combobox/listbox\n  --meta        Include DOM properties (href, src, id) inline — essential for extracting URLs\n  --text        Show visible text preview per result\n\nCommon patterns:\n  find --type link --meta              All links with URLs under current directory\n  find --type heading                  All section headings (to locate 'See Also', 'References', etc.)\n  find --type input                    All text inputs (matches textbox, searchbox, combobox, spinbutton)\n  find --type table                    Find tables for data extraction\n  find 'paragraph'                     Find paragraph elements by name pattern\n\nEfficiency tip: cd into the container you care about FIRST, then find within it. This avoids sidebar/nav/footer noise in results. Use 'text element_name' on find results to read their content without cd'ing.\n\nWhen --text is used with a search pattern, elements are also matched against their visible text content (not just name/role). Example: find --type link --text 'login' --meta finds links whose displayed text contains 'login' and shows their hrefs — even when the text is in nested spans.\n\nPipe support: find output can be piped into grep for filtering: find --type link --meta | grep 'github'. Think like bash: find is your 'find + grep' combined.",
    {
      pattern: z.string().optional().describe("Search pattern (matches name, role, value)"),
      type: z.string().optional().describe("Filter by AX role or natural alias (e.g. 'button', 'link', 'input', 'dropdown', 'nav', 'modal', 'toggle', 'image')"),
      limit: z.number().optional().describe("Maximum number of results"),
      meta: z.boolean().optional().describe("Include DOM properties (href, src, id, tag) per result"),
      text: z.boolean().optional().describe("Show visible text preview per result (uses innerText, respects CSS visibility)"),
      textlen: z.number().optional().describe("Maximum characters for text preview (default: 80)"),
      content: z.boolean().optional().describe("Also match against visible text content of elements (slower but finds elements by their displayed text, e.g. find a heading whose text says 'See also')"),
    },
    ANNO_READ,
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
    ANNO_READ,
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
    ANNO_READ,
    async ({ depth }) => ({
      content: [{ type: "text", text: await executeWithSecurity(`tree ${depth ?? 2}`) }],
    })
  );

  server.tool(
    "domshell_text",
    "Extract ALL text content from the current directory or a named child, including every descendant. Returns full textContent in a single call.\n\nThe name parameter lets you read any child without cd'ing into it first:\n  text paragraph_2994      Read a paragraph's text without cd'ing into it\n  text table_1234          Read an ENTIRE table (all rows, all cells) in one call\n  text list_5678           Read all list items at once\n  text                     Read everything under current directory\n\nEfficiency tip: call text on the HIGHEST container that has the content you need.\n  - Need a table? text on the table element, not individual rows.\n  - Need a section? text on the section container, not each paragraph.\n  - Need article body? cd into article/main, then text with no args.\n\nOne text call on a parent replaces N calls on its children.\n\nUse links=true to include hyperlink URLs inline as markdown [text](url). This lets you extract both text content and link destinations in a single call.",
    {
      name: z.string().optional().describe("Name or path of element to extract text from (e.g. 'paragraph' or 'article/paragraph'). Default: current directory"),
      limit: z.number().optional().describe("Maximum characters to return"),
      links: z.boolean().optional().describe("Include link URLs inline as [text](url) markdown"),
    },
    ANNO_READ,
    async ({ name, limit, links }) => {
      let cmd = "text";
      if (name) cmd += ` ${name}`;
      if (limit) cmd += ` -n ${limit}`;
      if (links) cmd += ` --links`;
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
    ANNO_READ,
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
    ANNO_READ,
    async () => ({
      content: [{ type: "text", text: await executeWithSecurity("refresh") }],
    })
  );

  server.tool(
    "domshell_diff",
    "Compare the current AX tree against the snapshot taken before the last write/navigate action (click, type, submit, select, navigate, open, back, forward, scroll). Shows added, removed, and changed elements. Use after a click or form submission to see exactly what changed on the page instead of re-exploring with ls/find.",
    {},
    ANNO_READ,
    async () => ({
      content: [{ type: "text", text: await executeWithSecurity("diff --json") }],
    })
  );

  server.tool(
    "domshell_eval",
    "Evaluate a JavaScript expression in the tab context. Returns the result. WRITE TIER as of 2.0.8 — the expression runs via CDP Runtime.evaluate with no side-effect gate, so any JavaScript can mutate DOM/window/global state. Requires --allow-write, same as domshell_js. Use for one-off expressions (property reads, single-value extractions); prefer domshell_js for multi-statement scripts.\n\nExamples:\n  eval document.title\n  eval window.location.href\n  eval document.querySelectorAll('a').length\n  eval [...document.querySelectorAll('h2')].map(h => h.textContent)\n\nFor read-only DOM inspection without --allow-write, use domshell_cat, domshell_text, or domshell_find instead.",
    { expression: z.string().describe("JavaScript expression to evaluate") },
    ANNO_WRITE,
    async ({ expression }) => ({
      content: [{ type: "text", text: await executeWithSecurity(`eval ${expression}`) }],
    })
  );

  server.tool(
    "domshell_functions",
    "List callable global JavaScript functions on the current page. Shows function name, arity (parameter count), and parameter names. Useful for discovering page APIs (e.g. MediaWiki's mw.config.get on Wikipedia).\n\nExamples:\n  functions             All non-standard window functions\n  functions mw          Functions matching 'mw'\n  functions --json      Machine-parseable output",
    {
      pattern: z.string().optional().describe("Filter functions by name pattern (case-insensitive substring match)"),
      json: z.boolean().optional().describe("Return JSON output instead of formatted text"),
    },
    ANNO_READ,
    async ({ pattern, json }) => {
      let cmd = "functions";
      if (pattern) cmd += ` ${pattern}`;
      if (json) cmd += " --json";
      return { content: [{ type: "text", text: await executeWithSecurity(cmd) }] };
    }
  );

  server.tool(
    "domshell_watch",
    "Re-run a command periodically and collect results. Useful for monitoring dynamic content changes within a single tool call instead of making N separate calls.\n\nOptions:\n  --interval N      Seconds between runs (default: 2, min: 0.5)\n  --times N         Number of iterations (default: 5, max: 100)\n  --until-change    Stop early when output differs from previous iteration\n\nTotal runtime capped at 120 seconds.\n\nExamples:\n  watch ls --times 3 --interval 1\n  watch \"eval document.title\" --until-change --interval 1",
    { command: z.string().describe("The command to re-run periodically (e.g. 'ls', 'eval document.title')") },
    ANNO_WRITE,
    async ({ command }) => ({
      content: [{ type: "text", text: await executeWithSecurity(`watch ${command}`) }],
    })
  );

  server.tool(
    "domshell_for",
    "Iterate over command output lines. Runs a source command, splits output into lines, and for each line replaces {} in the action template and executes it. Capped at 50 items and 120 seconds.\n\nSeparator is ' : ' (space-colon-space) to avoid conflicts with URL colons.\n\nExamples:\n  for \"find --type heading -n 3\" : text {}\n  for \"eval [...urls].join('\\\\n')\" : open {}",
    {
      source: z.string().describe("Source command whose output lines become iteration items"),
      template: z.string().describe("Action template with {} placeholder replaced by each line"),
    },
    ANNO_WRITE,
    async ({ source, template }) => ({
      content: [{ type: "text", text: await executeWithSecurity(`for ${source} : ${template}`) }],
    })
  );

  server.tool(
    "domshell_script",
    "Save and run multi-command scripts. Scripts persist across service worker restarts.\n\nSubcommands:\n  script list                    List saved scripts\n  script save <name> cmd1 ; cmd2 Save commands (separated by ' ; ')\n  script show <name>             Show commands in a script\n  script run <name> [args...]    Execute with $1, $2 variable substitution\n  script delete <name>           Delete a script\n\nIMPORTANT: Multi-word arguments for 'script run' MUST be quoted with double quotes:\n  script run search \"Artificial intelligence\"     (correct: $1 = Artificial intelligence)\n  script run search Artificial intelligence        (WRONG: $1 = Artificial, $2 = intelligence)\n\nExamples:\n  script save search open https://en.wikipedia.org ; submit search_input $1\n  script run search \"machine learning\"\n  script run search \"deep learning\"",
    { command: z.string().describe("Script subcommand and arguments. IMPORTANT: quote multi-word args with double quotes (e.g. 'run myscraper \"Artificial intelligence\"', 'save extract open url ; text', 'list')") },
    ANNO_WRITE,
    async ({ command }) => ({
      content: [{ type: "text", text: await executeWithSecurity(`script ${command}`) }],
    })
  );

  server.tool(
    "domshell_each",
    "Run a command across multiple open tabs. Iterates over all non-chrome tabs (optionally filtered by title/URL pattern), switches into each, runs the command, and collects results. Restores the original tab when done.\n\nOptions:\n  --pattern FILTER  Only tabs whose title or URL contains FILTER\n  --limit N         Process at most N matching tabs\n\nExamples:\n  each eval document.title                         Title from every tab\n  each --pattern wiki eval document.title           Only Wikipedia tabs\n  each --pattern wiki --limit 3 eval document.title First 3 Wikipedia tabs",
    {
      command: z.string().describe("The command to run in each tab, optionally prefixed with --pattern FILTER and/or --limit N"),
    },
    ANNO_WRITE,
    async ({ command }) => ({
      content: [{ type: "text", text: await executeWithSecurity(`each ${command}`) }],
    })
  );

  server.tool(
    "domshell_extract_links",
    "Extract all links under the current directory or a named child as a clean numbered list in [text](url) format. Purpose-built for link extraction — returns display text and URLs in one call.\n\nExamples:\n  extract_links              All links under current directory\n  extract_links main -n 20   First 20 links in 'main' section",
    {
      name: z.string().optional().describe("Name or path of element to extract links from (e.g. 'nav' or 'main/nav'). Default: current directory"),
      limit: z.number().optional().describe("Maximum number of links to return"),
    },
    ANNO_READ,
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
    ANNO_READ,
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
      ANNO_WRITE,
      async ({ name }) => ({
        content: [{ type: "text", text: await executeWithSecurity(`click ${name}`) }],
      })
    );

    server.tool(
      "domshell_focus",
      "Focus an input element. Use before 'domshell_type' to direct keyboard input to the right field.",
      { name: z.string().describe("Name or path of the input to focus (e.g. 'search_input' or 'form/search_input')") },
      ANNO_WRITE,
      async ({ name }) => ({
        content: [{ type: "text", text: await executeWithSecurity(`focus ${name}`) }],
      })
    );

    server.tool(
      "domshell_scroll",
      "Scroll the page or scroll a specific element into view. Use this when content is below the fold or when you need to reach elements not currently visible.\n\nModes:\n  scroll down [N]      Scroll page down by N viewport heights (default: 1)\n  scroll up [N]        Scroll page up by N viewport heights (default: 1)\n  scroll element_name  Scroll a specific element into the center of the viewport\n\nReturns current scroll position as percentage. Use after scrolling to verify position.\n\nCommon patterns:\n  scroll down → ls --text (see what's now visible)\n  scroll heading_name (jump to a section)\n  find --type heading → scroll target_heading (locate then scroll)",
      {
        direction: z.enum(["up", "down"]).optional().describe("Scroll direction. Omit when scrolling an element into view."),
        amount: z.number().optional().describe("Number of viewport heights to scroll (default: 1)"),
        target: z.string().optional().describe("Element name or path to scroll into view (e.g. 'see_also_heading', 'main/article/table_123')"),
      },
      ANNO_WRITE,
      async ({ direction, amount, target }) => {
        let cmd = "scroll";
        if (target) {
          cmd += ` ${target}`;
        } else {
          cmd += ` ${direction || "down"}`;
          if (amount && amount !== 1) cmd += ` ${amount}`;
        }
        return { content: [{ type: "text", text: await executeWithSecurity(cmd) }] };
      }
    );

    server.tool(
      "domshell_js",
      "Execute arbitrary JavaScript in the current tab and return the result. Use this for complex DOM queries, CSS selector extraction, or any operation that would take multiple DOMShell commands.\n\nThe code runs in the page context with full DOM access. Promises are automatically awaited. Results are JSON-serialized (truncated at 10000 chars).\n\nCommon patterns:\n  js document.title\n  js document.querySelectorAll('a').length\n  js [...document.querySelectorAll('.comment')].map(c => ({user: c.querySelector('.user').textContent, text: c.querySelector('.comment-text').textContent}))\n  js document.querySelector('table').outerHTML\n\nWhen to use js vs other tools:\n  - Use js when you need to batch multiple extractions into one call\n  - Use js for CSS selector queries that don't map cleanly to AX tree roles\n  - Use js for computed values (e.g. counting elements, filtering by attribute)\n  - Prefer domshell_text/domshell_find for simple content extraction (more structured output)",
      {
        code: z.string().describe("JavaScript code to evaluate in the tab context. Can be an expression or statement block. Async/await and Promises are supported."),
      },
      ANNO_WRITE,
      async ({ code }) => ({
        content: [{ type: "text", text: await executeWithSecurity(`js ${code}`) }],
      })
    );

    server.tool(
      "domshell_type",
      "Type text into the currently focused element. Use domshell_focus first to target an input field.\n\nFor search forms: after typing, you may need to either:\n  1. click the submit/search button, OR\n  2. type '\\n' to simulate pressing Enter\n\nIf the page doesn't navigate after form submission, use domshell_navigate as a fallback to go to the expected URL directly.",
      { text: z.string().describe("Text to type into the focused element") },
      ANNO_WRITE,
      async ({ text }) => ({
        content: [{ type: "text", text: await executeWithSecurity(`type ${text}`) }],
      })
    );

    server.tool(
      "domshell_navigate",
      "Navigate the current tab to a URL. Automatically rebuilds the accessibility tree after navigation completes. Requires a tab context (cd into a tab first). Use this to go to a specific website without opening a new tab.",
      { url: z.string().describe("URL to navigate to (e.g. 'https://example.com' or 'example.com')") },
      ANNO_NAVIGATE,
      async ({ url }) => ({
        content: [{ type: "text", text: await executeWithSecurity(`navigate ${url}`) }],
      })
    );

    server.tool(
      "domshell_open",
      "Open a URL in a new tab and enter it (path becomes ~/tabs/<id>). Automatically builds the accessibility tree after page loads. Works from any location.\n\nAfter opening a page, a typical extraction workflow is:\n  1. open URL\n  2. find the section you need (find --type heading, or grep section_name with recursive: true)\n  3. cd into the container\n  4. text (for content) or find --type link --meta (for links)",
      { url: z.string().describe("URL to open in a new tab (e.g. 'https://example.com' or 'example.com')") },
      ANNO_NAVIGATE,
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
      ANNO_WRITE,
      async ({ input, value, submit_button }) => {
        let cmd = `submit ${input} ${value}`;
        if (submit_button) cmd += ` --submit ${submit_button}`;
        return { content: [{ type: "text", text: await executeWithSecurity(cmd) }] };
      }
    );

    server.tool(
      "domshell_back",
      "Navigate back in browser history. Equivalent to the browser back button. Automatically refreshes the AX tree after navigation. Use this instead of domshell_navigate when returning to a previously visited page — it's faster (uses browser cache) and doesn't require remembering the URL.",
      {},
      ANNO_NAVIGATE,
      async () => ({
        content: [{ type: "text", text: await executeWithSecurity("back") }],
      })
    );

    server.tool(
      "domshell_forward",
      "Navigate forward in browser history. Only works after a 'back' command. Automatically refreshes the AX tree after navigation.",
      {},
      ANNO_NAVIGATE,
      async () => ({
        content: [{ type: "text", text: await executeWithSecurity("forward") }],
      })
    );

    server.tool(
      "domshell_close",
      "Close a tab. With no arguments, closes the current tab and returns to browser root. With a tab ID, closes that specific tab. Use after extracting data from a page to keep the tab count manageable.",
      {
        tabId: z.string().optional().describe("Tab ID to close (default: current tab)"),
      },
      ANNO_WRITE,
      async ({ tabId }) => ({
        content: [{ type: "text", text: await executeWithSecurity(`close ${tabId ?? ""}`.trim()) }],
      })
    );

    server.tool(
      "domshell_select",
      "Select an option from a <select> dropdown element. Matches by option value first, then by visible text (case-insensitive). Dispatches change and input events to trigger form updates.\n\nExamples:\n  select language_dropdown en\n  select country_select United States",
      {
        name: z.string().describe("Name or path of the <select> element"),
        value: z.string().describe("Option value or visible text to select"),
      },
      ANNO_WRITE,
      async ({ name, value }) => ({
        content: [{ type: "text", text: await executeWithSecurity(`select ${name} ${value}`) }],
      })
    );

    server.tool(
      "domshell_screenshot",
      "Capture a PNG screenshot of the current tab. Returns the image for visual inspection. Useful for understanding page layout on unfamiliar sites — one screenshot can replace multiple exploration calls (tree, ls, find) by showing you exactly what the page looks like.",
      {},
      ANNO_READ,
      async () => {
        const result = await executeWithSecurity("screenshot");
        if (result.startsWith("__SCREENSHOT_BASE64__")) {
          const base64 = result.slice("__SCREENSHOT_BASE64__".length);
          return {
            content: [{ type: "image", data: base64, mimeType: "image/png" }],
          };
        }
        return { content: [{ type: "text", text: result }] };
      }
    );

    server.tool(
      "domshell_wait",
      "Wait for an element to appear in the AX tree. Polls the tree every 500ms until the element is found or timeout is reached. Use after clicks or navigation that trigger async content loading (SPAs, AJAX).\n\nExamples:\n  wait results_list                    Wait for search results\n  wait submit_btn --type button         Wait for a button to appear\n  wait loading_spinner --timeout 10     Wait up to 10 seconds",
      {
        pattern: z.string().describe("Pattern to match against element names (case-insensitive)"),
        type: z.string().optional().describe("Filter by AX role (e.g. 'button', 'link', 'heading')"),
        timeout: z.number().optional().describe("Timeout in seconds (default: 5, max: 30)"),
      },
      ANNO_READ,
      async ({ pattern, type, timeout }) => {
        let cmd = `wait ${pattern}`;
        if (type) cmd += ` --type ${type}`;
        if (timeout) cmd += ` --timeout ${timeout}`;
        return { content: [{ type: "text", text: await executeWithSecurity(cmd) }] };
      }
    );

    server.tool(
      "domshell_call",
      "Call a global JavaScript function by name. Arguments are auto-parsed as JSON if valid, otherwise passed as strings. Write-tier — requires --allow-write.\n\nExamples:\n  call getCount\n  call getMessage Agent\n  call resetCount\n  call setConfig {\"key\": \"value\"}",
      {
        functionName: z.string().describe("Name of the global function to call (e.g. 'getCount', 'getMessage')"),
        args: z.string().optional().describe("Space-separated arguments to pass to the function"),
      },
      ANNO_WRITE,
      async ({ functionName, args }) => {
        let cmd = `call ${functionName}`;
        if (args) cmd += ` ${args}`;
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
      ANNO_SENSITIVE,
      async () => ({
        content: [{ type: "text", text: await executeWithSecurity("whoami") }],
      })
    );
  }
  }  // end granular per-command tools (ADR-002)

  // -- Diagnostic tool: domshell_about (always registered) --
  //
  // Reports the runtime identity of both server halves so integrators can
  // pin-verify who they are actually talking to on a per-request basis,
  // rather than trusting a log file that may be stale. Cheap read call
  // (no browser round-trip); safe to call unconditionally at drive startup
  // and again on any surprising failure to disambiguate version issues.
  // Added in 2.0.7 in response to the 2026-06-30 kgspin bug report where a
  // stale "v1.3.1 connected" log line was mistaken for the live version.
  server.tool(
    "domshell_about",
    "Report DOMShell runtime identity: MCP server version, bridged extension version (from HELLO handshake), whether an extension is currently connected, and connection timestamp. Use this at drive startup to pin-verify what you're actually talking to, and again on any surprising failure (silent shared-fallback, unexpected DOM, missing lane marker) to disambiguate stale-log/wrong-extension issues from real bugs. Returns JSON — always safe to call, no side effects.",
    {},
    ANNO_READ,
    async () => {
      const info = {
        mcp_server_version: MCP_SERVER_VERSION,
        extension_bridged: extensionClient !== null && extensionClient.readyState === 1,
        extension_version: extensionVersion,
        extension_grouping: extensionGrouping,
        extension_connected_at: extensionConnectedAt,
        ws_bridge_port: PORT,
        ws_bridge_host: HOST,
        mcp_port: MCP_PORT,
      };
      return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
    }
  );

  // -- Primary interface: domshell_execute (always registered) --

  server.tool(
    "domshell_execute",
    `Run DOMShell commands to browse and read web pages — the primary DOMShell interface. DOMShell maps a page's accessibility tree to a filesystem: containers are directories, interactive elements are files; browser windows and tabs are part of the same hierarchy.

Send ONE command, or MULTIPLE commands separated by newlines to run a whole workflow in a single call:
  open https://example.com
  cd main
  text
Multi-line runs each command in order in the same session/lane (cwd, env, history all persist between lines). An error on one line does NOT halt execution — its error is included in the combined output and subsequent lines still run. Useful for cleanup-line idioms like "cd path \\n grep pattern \\n cd back" where the trailing restore must run even if the middle step errors.
The pipe operator works within a command: find --type link --meta | grep github
Most commands accept relative paths, so a separate cd is rarely needed: text main/article, click form/submit_btn.

COMMAND REFERENCE
Browser & tabs: tabs · windows · here · cd <path> · open <url> · navigate <url> · back · forward · close [id] · group [new|attach|detach|close|list]
Reading: ls [--meta --text --json] · cat <name> · text [name] [--links] · tree [depth] · read [name] · grep [-r] <pattern> · find [--type ROLE --meta --text] <pattern> · extract_links · extract_table <name> · screenshot · diff
Interacting (write tier): click <name> · focus <name> · type <text> · key <KeyName> [--modifiers ctrl,shift,…] [--activate] · select <name> <value> · scroll down|up|<name> · submit <input> <value> · wait <pattern>
JavaScript: eval <expr> (write) · js <code> (write) · functions [pattern] · call <fn> <args>
Workflow: watch <cmd> [--until-change] · for "<cmd>" : <template> · script save|run|list · each [--pattern F] <cmd> · bookmark <name> · env · history · pwd · help

NOTES
- Enter a tab with "cd tabs/<id>" from the browser root; "open <url>" already opens AND enters a new tab (no flags).
- "cd .." moves up one level; from a tab's root it exits to the browser level.
- Run "help" for the full command list, or "<command> --help" for one command's usage.
- LANES: every reply ends with "[lane: <id>]" — your current lane. Declare your intent explicitly via group_id: "new" creates a fresh lane (the id comes back; carry it forward), "shared" opts into the default per-connection lane (shared across multiplexed clients on the same MCP connection but still isolated from the user's tabs), "<numeric-id>" joins that lane (handoff). Omitting group_id is DEPRECATED — currently maps to the shared lane and emits a [DEPRECATION] warning; future major release will require it.
- CLEAN UP: if you CREATED a lane (group_id "new"), close it when your task ends — run "group close" with the SAME group_id. Don't leave orphan tab groups behind. For the default lane (you did not create it), ask the user first; only close on their say-so.
- Write and sensitive commands obey the server's security tiers.`,
    {
      command: z.string().describe("A DOMShell command, or multiple commands separated by newlines (e.g. 'ls -l' or 'open example.com\\ncd main\\ntext')"),
      group_id: z.string().optional().describe("Which session lane to run in. Pass \"new\" to create a fresh isolated lane, \"shared\" to explicitly opt into the default per-connection lane (shared across any multiplexed clients on this MCP connection, still isolated from the user's tabs), or a numeric lane id to join an existing lane (handoff). Every response ends with a '[lane: <id>]' line — pass that id back as group_id to stay in the same lane. NOTE: omitting group_id is DEPRECATED — currently maps to the shared lane but will be required in a future major release."),
      initial_url: z.string().optional().describe("OPTIONAL, only meaningful when group_id=\"new\". When set, the new lane's working tab is created with this URL loaded instead of `about:blank` — the lane is ready to use by the time `command` runs (no extra `open <url>` round-trip, no dangling about:blank tab, cursor lands inside the loaded tab). Saves one round-trip when you already know the page you want to start on, e.g. `domshell_execute({command: \"text main\", group_id: \"new\", initial_url: \"https://example.com/article\"})`. Honored by DOMShell extension 1.3.2+; silently ignored by 1.3.1 (the lane is still created with an about:blank placeholder — same behavior as today, no regression). Ignored if group_id is anything other than \"new\"."),
      group_name: z.string().optional().describe("OPTIONAL, only meaningful when group_id=\"new\". Names the new lane's Chrome tab group (shows as `🐚 <group_name>` in Chrome's tab strip) so you and downstream garbage-collection sweeps can identify it later. Recommended convention: `<task-type>-<scope>-<run-id-or-sprint>`, e.g. `qa-ux-shopkit-sprint12` or `research-articles-2026-06-18`. Lanes without a name fall back to a generic `agent` title — fine for one-off use but makes garbage-collection by name pattern impossible. Honored by DOMShell extension 1.3.2+; silently ignored by 1.3.1 (lane still created with title `agent` — existing behavior, no regression). Ignored if group_id is anything other than \"new\"."),
      window_id: z.number().optional().describe("OPTIONAL, only meaningful when group_id=\"new\". Pins the new lane's working tab to a specific Chrome window (its numeric id). Without it, the tab is created in Chrome's CURRENT window — which, if that window happens to be a non-normal window (a popup, devtools, or an installed-PWA/app window), makes the tab group fail to create. BEST PRACTICE: before minting, run `windows` (or `ls --json ~/windows`) and pick a window whose `type` is `\"normal\"`; pass that id here. Only normal windows can host a lane group — the extension validates this and returns an error like `window <id> is a '<type>' window` if you pass a non-normal id, or `window <id> not found` for a bad id. If there are NO normal windows open, do not mint blindly — surface that to the user (they need to open a normal browser window). Also useful for deliberate placement: put your lane in a dedicated window away from the operator's real tabs. Honored by DOMShell extension 1.3.5+; silently ignored by older extensions (tab lands in the current window as before — no regression). Ignored if group_id is anything other than \"new\"."),
    },
    ANNO_WRITE,
    async ({ command, group_id, initial_url, group_name, window_id }) => {
      // Diagnostic audit (2.0.7, #kgspin-2026-06-30): log the received wire
      // values verbatim on every EXECUTE. The server-side [DEPRECATION]
      // "group_id omitted" footer fires only when group_id === undefined
      // reaches this handler, so if a drive claims to pass "new" but the
      // deprecation fires, the wire truth is captured here. Truncate the
      // command to keep the audit line bounded; keep the head so multi-line
      // execs are still recognizable.
      const cmdPreview = command.length > 120 ? command.slice(0, 120) + "…" : command;
      audit(
        `EXECUTE received: group_id=${JSON.stringify(group_id)} ` +
        `initial_url=${JSON.stringify(initial_url)} ` +
        `group_name=${JSON.stringify(group_name)} ` +
        `window_id=${JSON.stringify(window_id)} ` +
        `command=${JSON.stringify(cmdPreview)}`
      );

      // group_id resolution:
      //   undefined        → shared lane + DEPRECATION warning (agent hasn't declared intent)
      //   "shared"         → shared lane, no warning (explicit opt-in; map to undefined for kernel)
      //   "new"            → create new auto-id lane (unchanged)
      //   numeric "<id>"   → join existing lane by Chrome group id (unchanged)
      //
      // Future 3.0.0 will require an explicit group_id and reject undefined.
      const wasImplicitShared = group_id === undefined;
      const resolvedGroupId = group_id === "shared" ? undefined : group_id;

      // Multi-command: each non-blank line runs in sequence (ADR-002 D3).
      const lines = command.split("\n").map((l) => l.trim()).filter(Boolean);
      let lane = resolvedGroupId;
      let laneId: string | null = null;
      const out: string[] = [];
      // initial_url and group_name are only meaningful on the FIRST line
      // of a multi-line execute AND only when group_id="new" (lane creation
      // is happening right now). After the first line, the lane exists;
      // passing them to subsequent commands would be meaningless and is
      // silently dropped. Outside group_id="new", they are also ignored.
      let pendingInitialUrl = (resolvedGroupId === "new") ? initial_url : undefined;
      let pendingGroupName  = (resolvedGroupId === "new") ? group_name  : undefined;
      let pendingWindowId   = (resolvedGroupId === "new") ? window_id   : undefined;
      // Response-validation gate (2.0.7, #kgspin-2026-06-30): if the drive
      // asks for group_id="new" and the extension's reply doesn't carry a
      // numeric lane id, the mint didn't produce an isolated lane — the
      // command ran against whatever session state the extension had, which
      // for a bridged extension without a fresh lane can mean the operator's
      // real active tab (Gmail / banking / etc. — the DOMShell #53 hazard).
      // Refuse to return the extension's payload; surface an explicit error
      // instead so the drive fail-closes rather than silently touching the
      // operator's real browser. Only enforced on the FIRST line of a
      // new-mint call — after the first line succeeds, `lane` is rewritten
      // to the real numeric id at line 1288.
      let mintFailedError: string | null = null;
      for (const line of lines) {
        if (lines.length > 1) out.push(`$ ${line}`);
        const mintingNow = lane === "new";
        const r = await execWithSecurity(line, sidRef.sid, lane, pendingInitialUrl, pendingGroupName, pendingWindowId);
        if (mintingNow && (r.laneId === null || !/^\d+$/.test(r.laneId))) {
          // FORWARD the extension's reason (2.0.9). Since extension 1.3.4,
          // createAgentLane surfaces the real Chrome error (e.g. "group new:
          // failed to create group: Grouping is only supported for normal
          // browser windows") into r.result. The prior gate discarded r.result
          // and returned only a generic "got laneId=null" — the actionable
          // cause was thrown away one layer above the fix that produced it
          // (kgspin 2026-07-26 defect assertion (a)). Now we include it.
          const extReason = (r.result && r.result.trim())
            ? r.result.trim()
            : "(extension returned no reason string — likely an older extension < 1.3.4)";
          audit(
            `MINT-FAIL: group_id="new" replied laneId=${JSON.stringify(r.laneId)} ` +
            `reason=${JSON.stringify(r.result)} — refusing payload`
          );
          mintFailedError =
            'Error: lane mint failed — group_id="new" was requested but the extension ' +
            `returned no numeric lane id (got laneId=${JSON.stringify(r.laneId)}). ` +
            `Extension reason: ${extReason} — ` +
            'the command was NOT run in a fresh isolated lane. Refusing to return the ' +
            "extension's payload because it may reflect the operator's real browser " +
            'state (active tab), not an isolated tab group. Next steps: (1) call ' +
            'domshell_about to verify which extension is bridged, (2) check the ' +
            'DOMShell side panel for errors, (3) retry group_id="new". If this ' +
            'keeps happening the extension may need a reload.';
          break;
        }
        out.push(r.result);
        laneId = r.laneId;
        // After the first command "new" has materialized — reuse the real id so
        // the remaining commands run in the same lane, not a new one each time.
        if (lane === "new" && r.laneId) lane = r.laneId;
        // initial_url + group_name + window_id have been consumed by the first line — clear them.
        pendingInitialUrl = undefined;
        pendingGroupName = undefined;
        pendingWindowId = undefined;
      }
      if (mintFailedError !== null) {
        return { content: [{ type: "text", text: mintFailedError }] };
      }

      // Deprecation warning when the agent omitted group_id entirely — they
      // landed in the shared lane by accident, not declaration. Will become
      // a hard error in 3.0.0. Bracketed keyword matches DOMShell's existing
      // [lane: ...] marker style for parser-friendliness. Warning still fires
      // on lane-resolution failure too — the agent's group_id choice is
      // independent of whether the call landed.
      if (wasImplicitShared) {
        out.push("");
        out.push(
          '[DEPRECATION] group_id omitted — running in the shared per-connection lane. ' +
          'Pass group_id="new" to create a private isolated lane (recommended), ' +
          'or group_id="<numeric-id>" to join an existing one. ' +
          'TWO changes coming in DOMShell 3.0.0 / extension 1.3.2: ' +
          '(1) omitting group_id will be a hard error, and ' +
          '(2) the "shared" / omitted-group_id semantic will shift to mean ' +
          '"no isolation — operates on the user\'s actual browser, not a private tab group." ' +
          'Migrate now by passing group_id="new" on every call that needs an isolated lane.'
        );
      }

      // [lane: ...] marker — omitted ONLY when lane resolution itself
      // failed. The kernel returns laneId=null when an unknown group_id
      // is passed (or "new" creation failed) — see src/background/index.ts:589.
      // Command-level errors (cd: No tab matching, focus: No such element,
      // etc.) still ran inside a real lane and keep the marker — the agent
      // needs to know which lane to continue in for the next call.
      //
      // Label: when the agent asked for the shared/default lane (omitted
      // group_id or "shared"), emit the keyword `shared` rather than the
      // kernel's numeric id. The kernel assigns every MCP connection its
      // own isolated tab group at SESSION_START (ADR-001 D3), so the
      // "default lane" does have a real numeric id — but the agent's handle
      // for it is `shared`, not the id. For agent-named lanes ("new" /
      // numeric handoff), echo the kernel's id so the agent can carry it.
      const laneResolutionFailed =
        resolvedGroupId !== undefined && laneId === null;
      if (!laneResolutionFailed) {
        const label = resolvedGroupId === undefined ? "shared" : (laneId ?? "shared");
        out.push(`\n[lane: ${label}]`);
      }
      // The lane id rides in the text content, NOT structuredContent — Claude
      // Desktop renders only structuredContent when present and suppresses the
      // text entirely. The text is the one channel every client surfaces.
      return { content: [{ type: "text", text: out.join("\n") }] };
    }
  );

  console.error(`[DOMShell] MCP server created (${GRANULAR ? "granular" : "single-tool"} mode)`);
  return server;
}

// ---- MCP Session Management ----

const transports: Record<string, StreamableHTTPServerTransport> = {};

// ---- MCP Auth Middleware ----

// Read-only MCP protocol methods that bypass the bearer-token gate. These
// expose only what's already publicly published in the MCP registry
// (server capabilities + tool definitions); they never invoke a tool or
// touch the browser. Allowing them through unauthenticated enables
// introspection clients — `thv tui` Tools tab, MCP Inspector, future MCP
// browser UIs — to display server metadata without each one needing the
// bearer token. Action methods (tools/call) keep the existing gate, so
// the audit-log + write/sensitive tier flags + token remain the security
// boundary for anything that actually invokes a command.
const PUBLIC_MCP_METHODS = new Set([
  "initialize",
  "tools/list",
  "ping",
  "notifications/initialized",
  "notifications/cancelled",
]);

function mcpAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Read-only protocol methods: pass through unauthenticated.
  if (typeof req.body?.method === "string" && PUBLIC_MCP_METHODS.has(req.body.method)) {
    next();
    return;
  }
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
        // Multi-session (PRD-002 Phase 2): every MCP client gets its own
        // session — its own tab group and its own shell state. No
        // single-session limit; concurrent agents coexist without collision.
        const sidRef = { sid: "" };

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            log(`MCP session initialized: ${sid}`);
            transports[sid] = transport;
            sidRef.sid = sid;
            // Give this session its own isolated tab group (ADR-001 D3).
            if (extensionGrouping &&
                sendToExtension({ type: "SESSION_START", sessionId: sid, mode: "isolated" })) {
              log(`→ sending SESSION_START to extension (session ${sid})`);
            } else {
              log(`→ SESSION_START deferred — extension not connected yet (session ${sid})`);
              pendingSessionStarts.add(sid);
            }
          },
        });

        transport.onclose = () => {
          const sid = Object.entries(transports).find(([, t]) => t === transport)?.[0];
          if (sid) {
            log(`MCP session closed: ${sid}`);
            delete transports[sid];
            pendingSessionStarts.delete(sid);
            sendToExtension({ type: "SESSION_END", sessionId: sid });
          }
        };

        const server = createMcpServer(sidRef);
        await server.connect(transport);
        console.error(`[DOMShell] New MCP session connected (sid: ${sessionId})`);
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
  const httpServer = app.listen(MCP_PORT, HOST, () => {
    log("");
    log(`MCP HTTP endpoint: http://${HOST}:${MCP_PORT}/mcp`);
    log(`WebSocket bridge:  ws://${HOST}:${PORT}`);
    log(`Auth token: ${AUTH_TOKEN}`);
    log("");
    log("In the DOMShell terminal, run:");
    log(`  connect ${AUTH_TOKEN}`);
    log("");
    log(`Security: write=${ALLOW_WRITE ? "ON" : "OFF"}, sensitive=${ALLOW_SENSITIVE ? "ON" : "OFF"}, per-action confirm=${!NO_CONFIRM ? "ON" : "OFF (default; add --confirm to enable)"}`);
    log(`Tools: ${GRANULAR ? "granular (38 per-command tools)" : "single-tool (domshell_execute) — pass --granular for the per-command tools"}`);
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
