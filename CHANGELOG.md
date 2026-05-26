# Changelog

Notable changes to DOMShell — the Chrome extension and the `@apireno/domshell` MCP server.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The two artifacts version independently.

## MCP server `2.0.1` · Chrome extension `1.3.1` — 2026-05-26

Patch release sweeping up four bugs found while exercising 1.3.0/2.0.0 against real-world SPAs (LinkedIn, in particular). No new permissions on either artifact — Chrome Web Store re-review is code-only.

### Fixed — Chrome extension (`1.3.1`)

- `navigate` (and `back` / `forward`) no longer return the previous page's AX tree after a same-tab page change. `cdpSwitchToTab`'s fast path was content-preserving but nothing invalidated the cache, so the post-navigation `nodeMap` was the pre-navigation snapshot — node count frozen across pages, stale element IDs, and `wait` failing with a misleading "Not attached to any tab" because the fast path skipped re-attaching CDP. Fixed by an `invalidateTreeCache()` helper called from the three same-tab navigation handlers. (#36)
- `click` now produces **trusted** browser-level mouse events by default — React-driven SPAs (LinkedIn, Twitter/X, Notion, …) and other code that checks `event.isTrusted` no longer silently ignore the click. Swapped the fallback order in `handleClick`: `clickByCoordinates` (CDP `Input.dispatchMouseEvent`) is now primary; `Element.prototype.click()` via `Runtime.callFunctionOn` is the fallback for nodes without a usable bounding box. (#37)
- `js` / `eval` no longer hang indefinitely when the expression returns a non-resolving Promise or triggers a page-level deadlock. `cdp.evaluateJs()` now races against a configurable timeout (default 30s) and best-effort calls `Runtime.terminateExecution` on timeout to free the evaluator. (#38)
- `scroll down` / `scroll up` now walk up from the cursor to find the nearest scrollable ancestor and scroll IT — virtualized lists (LinkedIn conversation list, react-window, …) finally advance through off-screen rows. Falls back to `window` when no scrollable ancestor exists. Pass `--window` to force document scroll. Output marks `(inner container)` when an inner element was scrolled. (#35)

### Fixed — MCP server (`2.0.1`)

- `confirmAction` no longer deadlocks the Node event loop when the MCP server is spawned from a non-interactive parent (Claude Desktop, Cursor, any GUI MCP client). The synchronous `readSync` on `/dev/tty` would freeze the whole process — the 60-second `setTimeout` backstop could not fire while JS was parked in the syscall. Now detects `!process.stderr.isTTY` at module load and skips the TTY probe entirely; without `--no-confirm`, returns a clear deny with a message pointing at the right CLI flag. (#39)

## MCP server `2.0.0` · Chrome extension `1.3.0` — 2026-05-22

The first release since November 2025, bundling Sprints 02 – 04. Big interface change on the MCP server (the major bump) and a substantial kernel refactor on the extension.

### Added — MCP server (`@apireno/domshell`)

- **Single-tool default.** `domshell_execute` is the primary interface — pass any DOMShell command as a string, or several newline-separated for a whole workflow in one call. The 38 per-command tools (`domshell_ls`, `domshell_open`, …) remain available via the opt-in `--granular` flag.
- **Concurrent multi-agent.** Multiple MCP clients can connect simultaneously — each gets its own isolated `🐚 agent` tab group and its own shell state. No kicking, no collision. The previous single-session limit is gone.
- **Agent-declared sessions.** Optional `group_id` parameter on `domshell_execute`. Pass `"new"` to mint a fresh lane (its id is returned in the trailing `[lane: <id>]` line of every reply); pass an existing lane id to join it (agent-to-agent handoff). Lets two chats in one Claude Desktop each get their own lane despite sharing one MCP connection.

### Added — Chrome extension

- **Per-session kernel.** Each side-panel window and each MCP connection runs in its own session — its own current tab, DOM cursor, command history, and tab-group binding. Two side panels in two Chrome windows now hold independent positions.
- **Window-relative `%here%`.** `cd %here%` resolves to the active tab of the console's own Chrome window — not the globally-focused window.
- **Per-session persistence.** Each session's durable state (path, env, history) survives a service-worker restart, keyed per session.
- **Tab-group session isolation** (shipped in 1.2.0 / Sprint 01). A session can run inside an isolated Chrome tab group so the agent works in its own lane while you keep browsing freely in other tabs.

### Changed

- The MCP server's default tool surface changed from **38 per-command tools** to **one** (`domshell_execute`). Granular tools remain available with `--granular`.
- Single-session enforcement (a 2nd MCP client rejected with HTTP 409) is **removed** in favor of concurrent sessions.
- Every `domshell_execute` reply now ends with a `[lane: <id>]` line — the agent's current session lane (`[lane: shared]` in shared mode).
- `cd %here%` resolves window-relatively per session (was: a single global `getLastFocused`).

### Fixed

- A failed `cd` into a `chrome://` page no longer leaves the shell wedged on that tab.
- Targeting a tab Chrome forbids debugging (`chrome://`, `devtools://`, `view-source:`, …) returns a clear, actionable error instead of a raw CDP message.
- Two side panels can no longer corrupt each other's cursor (command serialization + per-session state).
- A human side-panel terminal is no longer conscripted into an MCP agent's tab-group binding.
- The MCP server's stale-session lock no longer permanently rejects reconnects — replaced by the clean concurrent-session model.

### Migration

- A caller that does nothing differently sees no behavioral change for typical use — the single-tool default exposes the full command vocabulary; the agent learns it from the `domshell_execute` description.
- To keep the legacy 38-tool surface: start the server with `--granular`.
- To opt into agent-declared lanes (e.g. two Claude Desktop chats coexisting): pass `group_id: "new"` on the first call and carry the returned id thereafter.

### Versions

- `@apireno/domshell` — npm `2.0.0`; the Official MCP Registry, mcpservers.org, Glama, and awesome-mcp-servers listings updated to match.
- Chrome extension — `1.3.0`; submitted to the Chrome Web Store for re-review (no new permissions vs. `1.2.0`).

## Earlier — `1.1.x` and before

The 1.1.x line shipped DOMShell's foundation — the AX-tree-to-filesystem mapping, the side-panel terminal, the MCP server, and the 38 granular tools. See the [GitHub releases](https://github.com/apireno/DOMShell/releases) for that history.
