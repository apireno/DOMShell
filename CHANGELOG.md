# Changelog

Notable changes to DOMShell — the Chrome extension and the `@apireno/domshell` MCP server.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The two artifacts version independently.

## MCP server `2.0.2` — 2026-05-31

Server-only patch. No Chrome extension changes; the extension stays at `1.3.1`.

### Deprecated — MCP server (`2.0.2`)

- **Omitting `group_id` on `domshell_execute` is now deprecated.** Calls without a `group_id` continue to work as before (mapped to the default per-connection lane) but the response now includes a one-line `[DEPRECATION]` warning. A future major release will require an explicit `group_id`. Migrate by passing one of:
  - `"new"` — create a fresh isolated lane (recommended for most agents)
  - `"shared"` — explicitly opt in to the default per-connection lane (silent; no warning)
  - `"<numeric-id>"` — join an existing lane (handoff)
  - Behavioral motivation: agents have been landing in the default lane by accident rather than declaration. Multi-chat-per-MCP-client scenarios (Claude Desktop multiplexes every chat over one MCP connection) cause silent collisions. The deprecation cycle gives integrators visible notice before the hard switch in `3.0.0`. The change is non-breaking — every existing caller continues to work, just with a warning attached when `group_id` is omitted.

### Added — MCP server (`2.0.2`)

- **`group_id="shared"` accepted as explicit opt-in** to the default per-connection lane (the one multiplexed clients share). Semantically identical to omitting `group_id` (server translates `"shared"` to undefined before passing to the kernel) but no deprecation warning is emitted, because the agent has declared intent. The lane label in the response is also now the keyword `shared` rather than the kernel's numeric tab-group id, giving the agent a stable handle that survives across calls.

### Fixed — MCP server (`2.0.2`)

- **`[lane: ...]` marker no longer appended on lane-resolution failure.** When `group_id` named a lane that didn't exist (or `"new"` creation failed), the response previously ended with `[lane: shared]`, which falsely implied the agent had landed in the shared lane when in fact the call hadn't run anywhere. The marker is now suppressed only in this specific case — detected by checking whether the agent named a specific lane (`group_id !== undefined`) and the kernel returned `laneId: null`. Command-level errors (`cd: No tab matching ...`, `focus: No such element`, domain allowlist rejections, etc.) keep the marker, because they ran inside a real lane and the agent needs to know which lane to continue in for the next call. Successful responses unchanged.

### Future work

Named lanes (e.g. `group_id="my-task-name"` with get-or-create semantics and human-readable Chrome tab group titles) require kernel-side changes — `swapToAgentLane()` currently rejects non-numeric strings, and `createAgentLane()` doesn't accept user-supplied names. Tracked separately; will bundle with a future Chrome extension update.

## MCP server `2.0.1` · Chrome extension `1.3.1` — 2026-05-26

Patch release sweeping up four bugs found while exercising 1.3.0/2.0.0 against real-world SPAs (LinkedIn, in particular). No new permissions on either artifact — Chrome Web Store re-review is code-only.

### Added — Chrome extension (`1.3.1`)

- **`key` command** — dispatch a keyDown+keyUp pair to the element with DOM focus. Built-in names: `Enter`, `Escape`, `Tab`, `Backspace`, `Delete`, `Space`, `ArrowUp/Down/Left/Right`, `Home`, `End`, `PageUp`, `PageDown`, `F1`–`F12`, plus single characters with `--modifiers ctrl,shift,alt,meta`. Write tier. Two non-obvious things had to be right for the keystroke to fire at all: (1) special keys (Escape, arrows, F-keys) go through CDP's `rawKeyDown` path — `keyDown` without a `text` field is silently dropped — while text-producing keys (Enter='\r', Tab='\t', Space=' ') and printable chars use `keyDown` with `text` set; (2) `chrome.debugger`-routed `Input.dispatchKeyEvent` is silently no-op'd by Chrome when the target tab isn't the active tab in its window (mouse events are exempt because they carry coordinates and Chrome hit-tests by position). To avoid disrupting the agent's window focus, `key` auto-selects per call: **if the target tab is already active**, the trusted CDP path runs (`event.isTrusted === true`); **otherwise** it falls back to a JS-synthesized dispatch on `document.activeElement` (untrusted, no focus shift, fires handlers that don't check `isTrusted` — the majority). For SPAs that gate activation on `isTrusted` (LinkedIn, etc.) when the tab is in the background, pass `--activate` — DOMShell briefly makes the target the active tab, dispatches a trusted key, then restores the previously-active tab. One visible flicker per call. Each reply marks which path ran. Motivated by LinkedIn's conversation list, whose `<div tabindex="0">` rows activate on Enter — see #37. (#40)

### Fixed — Chrome extension (`1.3.1`)

- `navigate` (and `back` / `forward`) no longer return the previous page's AX tree after a same-tab page change. `cdpSwitchToTab`'s fast path was content-preserving but nothing invalidated the cache, so the post-navigation `nodeMap` was the pre-navigation snapshot — node count frozen across pages, stale element IDs, and `wait` failing with a misleading "Not attached to any tab" because the fast path skipped re-attaching CDP. Fixed by an `invalidateTreeCache()` helper called from the three same-tab navigation handlers. (#36)
- `click` now produces **trusted** browser-level mouse events by default — React-driven SPAs (LinkedIn, Twitter/X, Notion, …) and other code that checks `event.isTrusted` no longer silently ignore the click. Swapped the fallback order in `handleClick`: `clickByCoordinates` (CDP `Input.dispatchMouseEvent`) is now primary; `Element.prototype.click()` via `Runtime.callFunctionOn` is the fallback for nodes without a usable bounding box. (#37)
- `js` / `eval` no longer hang indefinitely when the expression returns a non-resolving Promise or triggers a page-level deadlock. `cdp.evaluateJs()` now races against a configurable timeout (default 30s) and best-effort calls `Runtime.terminateExecution` on timeout to free the evaluator. (#38)
- `scroll down` / `scroll up` now walk up from the cursor to find the nearest scrollable ancestor and scroll IT — virtualized lists (LinkedIn conversation list, react-window, …) finally advance through off-screen rows. Falls back to `window` when no scrollable ancestor exists. Pass `--window` to force document scroll. Output marks `(inner container)` when an inner element was scrolled. (#35)
- `ls <path>` now actually respects the path argument — previously it silently ignored the positional path and returned the cursor's listing. Single-name and slash-separated paths both work (`ls main_443/conversation_list`). Same flag set as bare `ls`. (#41)
- `cd <name>` failure messages now list available subdirectories at the current level and point at `tree` for deeper paths — was previously a bare "No such directory" with no diagnostic. The underlying parity question between `cd` / `ls` / `tree` (#42) remains open pending a clean repro; this is the actionable interim improvement.

### Changed — MCP server (`2.0.1`)

- **Per-action terminal confirmation is now OFF by default.** The prompt lived in the MCP server's stdout, detached from the agent and the side panel where the user actually watches — it could only be answered in a setup almost no one runs (server in a terminal). The canonical GUI-spawned configurations (Claude Desktop, Cursor, CLI-Anything's harness) all worked around it with `--no-confirm`. The audit log, tier flags (`--allow-write`, `--allow-sensitive`), and `--domains` remain the security boundary. `--no-confirm` is preserved as a no-op for backward compatibility; the new `--confirm` flag re-enables per-action prompts for users who genuinely want them. README + `init` wizard updated accordingly.
- **MCP tool annotations published per tool** (`readOnlyHint`, `destructiveHint`, `openWorldHint`). All 38 tools now carry per-call hints so MCP hosts (Claude Desktop, Cursor, …) can render context-aware approval UIs with the surrounding conversation context — the right layer for human-in-the-loop approval — rather than relying on the server to own the prompt. Mapping: read-tier tools (`ls`, `find`, `grep`, `cat`, `text`, `tree`, `extract_links`, `extract_table`, `screenshot`, `wait`, `eval`, `functions`, `diff`, `refresh`, `tabs`, `here`, `cd`, `pwd`) → `readOnlyHint: true`; navigation tools (`navigate`, `open`, `back`, `forward`) → `destructiveHint: false`; write-tier (`click`, `focus`, `type`, `key`, `scroll`, `select`, `js`, `close`, `submit`, `call`, `watch`, `for`, `each`, `script`) and sensitive (`whoami`) and the default `domshell_execute` (worst-case) → `destructiveHint: true`. These are hints, not policy — the server's tier checks remain the actual security boundary. (#39 follow-up; thanks @m13v for the architectural framing.)

### Fixed — MCP server (`2.0.1`)

- `confirmAction` no longer deadlocks the Node event loop when `--confirm` is enabled but the MCP server is spawned from a non-interactive parent. The synchronous `readSync` on `/dev/tty` would freeze the whole process — the 60-second `setTimeout` backstop could not fire while JS was parked in the syscall. Now detects `!process.stderr.isTTY` at module load and skips the TTY probe entirely. Mostly latent given the default flip above, but still meaningful for users running the server in a terminal that later loses its TTY. (#39)

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
