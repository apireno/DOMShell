/**
 * proxy.ts — Stdio↔HTTP bridge for MCP clients that require command/args (e.g. Claude Desktop).
 *
 * Usage:
 *   npx tsx proxy.ts --port 3001 --token <token>
 *
 * This tiny proxy reads JSON-RPC from stdin, forwards to the running DOMShell MCP server
 * over HTTP, and writes responses back to stdout. It does NOT run any MCP logic itself.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const args = process.argv.slice(2);

function flag(name: string, fallback: string): string {
  const idx = args.indexOf(name);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : fallback;
}

const port = flag("--port", "3001");
const token = flag("--token", "");

const serverUrl = new URL(`http://127.0.0.1:${port}/mcp`);
if (token) serverUrl.searchParams.set("token", token);

// Startup identity check (2.0.9 hardening). Before relaying, probe the server with
// a one-shot `initialize` and log which DOMShell instance we actually reached —
// version + endpoint — to stderr. Previously the proxy relayed blindly to whatever
// squatted the port, so a stale/wrong server (e.g. a native 2.0.8 squatting :3001
// while the intended 2.0.9 container ran elsewhere) was silently relayed to. Now a
// version mismatch is visible in the proxy's own startup log. Best-effort: a probe
// failure never blocks the relay.
async function logServerIdentity(): Promise<void> {
  try {
    const resp = await fetch(serverUrl.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: "proxy-identity-probe", method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "domshell-proxy-probe", version: "0" } },
      }),
    });
    const text = await resp.text(); // may be JSON or SSE ("data: {...}")
    const m = text.match(/"serverInfo"\s*:\s*\{[^}]*"version"\s*:\s*"([^"]+)"/);
    const ver = m ? m[1] : "unknown";
    process.stderr.write(`[domshell-proxy] relaying to DOMShell v${ver} at ${serverUrl.origin} (token ${token ? "set" : "MISSING"})\n`);
  } catch (e: any) {
    process.stderr.write(`[domshell-proxy] WARNING: could not identify a DOMShell server at ${serverUrl.origin}: ${e?.message ?? e}\n`);
  }
}
await logServerIdentity();

const stdio = new StdioServerTransport();
const http = new StreamableHTTPClientTransport(serverUrl);

// Bridge: stdio → http, http → stdio
stdio.onmessage = (msg) => http.send(msg);
http.onmessage = (msg) => stdio.send(msg);
stdio.onclose = () => http.close();
http.onclose = () => stdio.close();

await stdio.start();
await http.start();
